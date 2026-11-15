import { tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ACTION_EXPIRES_MIN, applyActions, restartAsked } from "../lib/actions.ts";
import { steeringNote, waitRefusal } from "../lib/steer.ts";
import { applied, applyControls } from "../lib/holds.ts";
import type { RegistryEntry } from "../lib/paths.ts";
import { actedControl, actionControl, actionsOf, type Control, restoreControl, retireControl, retiredOf } from "../lib/tasks/controls.ts";
import { fileStore } from "../lib/tasks/files.ts";

const entryAt = (run: string): RegistryEntry => ({ name: "fixture", title: "Fixture team", home: run, run }) as unknown as RegistryEntry;
const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();
const asControl = (fields: Omit<Control, "id" | "version">, id: string): Control => ({ ...fields, id, version: 1 });

describe("the operator's actions on a team's lead", () => {
  test("an action starts once, as a job of its own, and says so; the pauses' pass leaves it alone", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const asked = await store.controls.create(actionControl("fixture", "web:s1", "env"));
    applyControls(run, await store.controls.all());
    assert.equal(applied(run)(asked.id), false, "the pauses' pass doesn't take it as applied");

    const started: string[] = [];
    const start = (_entry: RegistryEntry, control: Control) => void started.push(control.id);
    const log = await applyActions(entryAt(run), store, await store.controls.all(), "mac", { start });
    assert.deepEqual(started, [asked.id]);
    assert.match(log[0] ?? "", /the operator \(web app\) asked to restart the environment \(k1\): started/);
    assert.equal(applied(run)(asked.id), true);
    const [state] = actionsOf(await store.controls.all());
    assert.deepEqual([state?.action, state?.outcome], ["env", "started"]);
    assert.match(state?.said ?? "", /Restarting the environment/);

    // The next pass starts nothing again, and the lead's word is the app's alone.
    await applyActions(entryAt(run), store, await store.controls.all(), "mac", { start });
    assert.deepEqual(started, [asked.id]);
    const { log: pauses } = applyControls(run, await store.controls.all());
    assert.deepEqual(pauses, []);
  });

  test(`one asked more than ${ACTION_EXPIRES_MIN} minutes before the lead picked it up is passed over, but a delete still holds`, async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const old = await store.controls.create(actionControl("fixture", "web:s1", "rotate", "", minutesAgo(ACTION_EXPIRES_MIN + 5)));
    const remove = await store.controls.create(actionControl("fixture", "web:s1", "unregister", "", minutesAgo(ACTION_EXPIRES_MIN + 5)));
    const started: string[] = [];
    await applyActions(entryAt(run), store, await store.controls.all(), "mac", { start: (_e, c) => void started.push(c.id) });
    assert.deepEqual(started, [remove.id]);
    const states = actionsOf(await store.controls.all());
    const rotate = states.find((s) => s.control.id === old.id);
    assert.equal(rotate?.outcome, "failed");
    assert.match(rotate?.said ?? "", /too long ago to act on now\. Ask again/);
    assert.equal(applied(run)(old.id), true, "and it isn't tried again");
  });

  test("a planner restart that waits starts no new member, goes on waiting past the hour, and starts once the planner is free", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const asked = await store.controls.create(actionControl("fixture", "web:s1", "rotate", "", minutesAgo(5)));
    const started: string[] = [];
    const start = (_e: RegistryEntry, c: Control) => void started.push(c.id);
    const members = () => "the planner has 2 members running; they report to it, so it restarts once they've finished";
    const log = await applyActions(entryAt(run), store, await store.controls.all(), "mac", { start, busy: members });
    assert.match(log[0] ?? "", /waiting, as the planner has 2 members running; .*no new member starts until it's done/);
    assert.equal(restartAsked(run), asked.id);
    assert.match(waitRefusal(run, "builder") ?? "", /no builder can start now: the operator asked to restart the planner \(k1\)/);
    assert.equal(waitRefusal(run, "planner"), null, "the planner itself isn't held");
    assert.match(steeringNote(run), /The operator asked to restart your thread \(k1\): start no members/);

    // Seventy minutes on, still waiting, with more members at work: it was seen in time, so it isn't too old, and the
    // same reason isn't said again.
    const later = Date.now() + 70 * 60_000;
    const more = () => "the planner has 5 members running; they report to it, so it restarts once they've finished";
    await applyActions(entryAt(run), store, await store.controls.all(), "mac", { start, busy: more, now: later });
    assert.equal((await store.controls.all()).filter((c) => c.kind === "acted").length, 1);
    assert.deepEqual(started, []);
    assert.deepEqual(
      actionsOf(await store.controls.all()).map((s) => s.outcome),
      ["waiting"]
    );

    // Free: retired in this very pass (no job, which could find it woken again), a fresh planner started, and members
    // may start again.
    const retired: string[] = [];
    const woken: string[] = [];
    await applyActions(entryAt(run), store, await store.controls.all(), "mac", {
      start,
      busy: () => null,
      now: later,
      retire: (r) => (retired.push(r), "mcp:old"),
      wake: (e) => void woken.push(e.name),
    });
    assert.deepEqual([started, retired, woken], [[], [run], ["fixture"]]);
    assert.deepEqual(
      actionsOf(await store.controls.all()).map((s) => [s.outcome, s.said]),
      [["done", "The planner's thread (mcp:old) was retired; a fresh one starts now and carries on from the log."]]
    );
    assert.equal(restartAsked(run), null);
    assert.equal(waitRefusal(run, "builder"), null);
  });

  test("a job that won't start says why", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    await store.controls.create(actionControl("fixture", "web:s1", "upgrade"));
    const log = await applyActions(entryAt(run), store, await store.controls.all(), "mac", {
      start: () => {
        throw new Error("spawn ENOENT");
      },
    });
    assert.match(log[0] ?? "", /the job didn't start: spawn ENOENT/);
    assert.deepEqual(
      actionsOf(await store.controls.all()).map((s) => [s.outcome, s.said]),
      [["failed", "The job didn't start: spawn ENOENT"]]
    );
  });

  test("deleting a team takes it off the web app until it's put back; actionsOf says where each action stands", () => {
    const remove = asControl(actionControl("fixture", "web:s1", "unregister"), "k2");
    assert.equal(retiredOf([asControl(retireControl("fixture", "operator"), "k1"), remove]), remove);
    assert.equal(retiredOf([remove, asControl(restoreControl("fixture", "operator"), "k3")]), null, "a6g register puts it back");
    assert.equal(retiredOf([asControl(actionControl("fixture", "web:s1", "rotate"), "k1")]), null, "no other action takes it off");

    const states = actionsOf([
      asControl(actionControl("fixture", "web:s1", "rotate"), "k1"),
      asControl(actedControl("fixture", "mac", { of: "k1", outcome: "waiting", said: "The planner is mid-turn." }), "k2"),
      asControl(actionControl("fixture", "web:s1", "wake"), "k3"),
      asControl(actedControl("fixture", "mac", { of: "k1", outcome: "done", said: "The planner restarted." }), "k4"),
    ]);
    assert.deepEqual(
      states.map((s) => [s.control.id, s.action, s.outcome, s.said]),
      [
        ["k3", "wake", "asked", ""],
        ["k1", "rotate", "done", "The planner restarted."],
      ]
    );
  });
});

describe("a6g act, and the watchdog that starts it", () => {
  async function world() {
    const { fakeWorld } = await import("./fake-t3.ts");
    const w = await fakeWorld();
    const file = join(w.a6gHome, "teams", "fixture.json");
    write(join(w.a6gHome, "teams"), {
      "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "files", database: "a6g", lead: null } },
    });
    return { w, store: fileStore(w.run, "fixture") };
  }

  test("wakes the team and deletes it, writing what came of each", async () => {
    const { w, store } = await world();
    try {
      const wake = await store.controls.create(actionControl("fixture", "web:s1", "wake"));
      const woke = await w.a6g("act", "fixture", wake.id);
      assert.equal(woke.code, 0, woke.out);
      assert.deepEqual(
        actionsOf(await store.controls.all()).map((s) => [s.action, s.outcome, s.said]),
        [["wake", "done", "The watchdog ran for the team."]]
      );

      const remove = await store.controls.create(actionControl("fixture", "web:s1", "unregister"));
      const removed = await w.a6g("act", "fixture", remove.id);
      assert.equal(removed.code, 0, removed.out);
      assert.ok(!existsSync(join(w.a6gHome, "teams", "fixture.json")), "off its Mac");
      assert.ok(existsSync(w.run), "its run folder is kept");
      const controls = await store.controls.all();
      assert.equal(retiredOf(controls)?.id, remove.id, "and off the web app, by the ask itself");
      assert.equal(controls.filter((c) => c.kind === "retire").length, 0, "with no retire of its own beside it");
      assert.match(actionsOf(controls)[0]?.said ?? "", /Taken off its Mac\. Its checkout, run folder and history are kept/);
      assert.match(readFileSync(join(w.run, "watchdog.log"), "utf8"), /the operator's unregister \(k\d+\): done/);
      assert.notEqual((await w.a6g("act", "fixture", "k99")).code, 0, "nothing to act on for a team no longer here");
    } finally {
      await w.close();
    }
  });

  test("the watchdog's pass starts an action as a job, which says when it's done", async () => {
    const { w, store } = await world();
    try {
      const wake = await store.controls.create(actionControl("fixture", "web:s1", "wake"));
      const ran = await w.a6g("watchdog", "run", "fixture");
      assert.equal(ran.code, 0, ran.out);
      let state = actionsOf(await store.controls.all())[0];
      for (let i = 0; i < 200 && state?.outcome !== "done"; i++) {
        await new Promise((next) => setTimeout(next, 100));
        state = actionsOf(await store.controls.all())[0];
      }
      assert.equal(state?.control.id, wake.id);
      assert.equal(state?.outcome, "done", readFileSync(join(w.run, "actions.log"), "utf8"));
      assert.match(readFileSync(join(w.run, "watchdog.log"), "utf8"), /asked to wake the team now \(k1\): started/);
    } finally {
      await w.close();
    }
  });
});
