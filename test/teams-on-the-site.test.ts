// Every team where it belongs on the web app (docs/plans/teams-on-the-site.md): taking a team off the app and putting
// it back, which only the app reads, and a new team's tasks in MongoDB on a Mac connected to it.
import { a6g, gitRepo, machine, tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nameTaken } from "../lib/commands/init.ts";
import { putBackOnApp, takeOffApp } from "../lib/commands/team.ts";
import { applyControls } from "../lib/holds.ts";
import { type Control, restoreControl, resumeControl, retireControl, retiredOf, startControl, startingControl } from "../lib/tasks/controls.ts";
import { newTask } from "../lib/tasks/model.ts";
import { storeOver } from "../lib/tasks/mongo.ts";
import { fakeMongo } from "./fake-mongo.ts";

const numbered = (controls: Omit<Control, "id" | "version">[]): Control[] => controls.map((c, i) => ({ ...c, id: `k${i + 1}`, version: 1 }));

describe("taking a team off the web app", () => {
  test("it's off while the newest of its retires and restores is a retire; other controls don't count", () => {
    const off = retireControl("shop", "web:s1", "  a trial  ");
    assert.equal(off.note, "a trial");
    assert.equal(retiredOf([]), null);
    assert.equal(retiredOf(numbered([off]))?.id, "k1");
    assert.equal(retiredOf(numbered([off, resumeControl("shop", "operator")]))?.id, "k1", "a resume doesn't put it back");
    assert.equal(retiredOf(numbered([off, restoreControl("shop", "operator")])), null);
    assert.equal(retiredOf(numbered([off, restoreControl("shop", "operator"), retireControl("shop", "operator", "again")]))?.note, "again");
  });

  test("unregister and register take it off and put it back once, as the operator", async () => {
    const store = storeOver(fakeMongo(), { name: "shop", tasks: { store: "mongo", database: "a6g", lead: null } });
    assert.equal(await putBackOnApp(store, "shop"), false, "on the app already");
    assert.equal(await takeOffApp(store, "shop", "unregistered on studio"), true);
    assert.equal(await takeOffApp(store, "shop", "unregistered on studio"), false, "off already: no second record");
    const [off] = await store.controls.all();
    assert.equal(off?.kind, "retire");
    assert.equal(off?.by, "operator");
    assert.equal(off?.note, "unregistered on studio");
    assert.equal(await putBackOnApp(store, "shop"), true);
    assert.equal(await putBackOnApp(store, "shop"), false);
    assert.deepEqual(
      (await store.controls.all()).map((c) => c.kind),
      ["retire", "restore"]
    );
    assert.equal(retiredOf(await store.controls.all()), null);
  });

  test("the watchdog marks both applied and changes nothing in the run folder", () => {
    const run = tmp("a6g-run-");
    const controls = numbered([retireControl("shop", "web:s1"), restoreControl("shop", "operator")]);
    assert.deepEqual(applyControls(run, controls), { log: [], tell: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(run, "controls-applied"), "utf8")), ["k1", "k2"]);
    assert.ok(!existsSync(join(run, "paused")) && !existsSync(join(run, "budget.json")));
    assert.deepEqual(applyControls(run, controls), { log: [], tell: [] }, "once each");
  });
});

describe("a new team's tasks", () => {
  test("in MongoDB, under a name no team has used there: an ask to start it from the web app doesn't count", async () => {
    const client = fakeMongo();
    const store = (name: string) => storeOver(client, { name, tasks: { store: "mongo", database: "a6g", lead: null } });
    assert.equal(await nameTaken(store("fresh")), null);
    const asked = store("asked");
    await asked.controls.create(startControl("asked", "web:s1", null));
    await asked.controls.create(startingControl("asked", "studio", { of: "k1", step: "draft", problem: null }));
    assert.equal(await nameTaken(asked), null, "the web app's ask and its Mac's word come before the team");
    const published = store("published");
    await published.publish({
      name: "published",
      title: "P",
      mode: "finish",
      approval: { mode: "operator", maxSize: "M", findings: "planner" },
      roles: ["planner"],
      branch: "main",
      factory: "0.8.1",
      publishedAt: "",
    });
    assert.match((await nameTaken(published)) ?? "", /published its settings/);
    const tasked = store("tasked");
    await tasked.tasks.createAs("1", newTask({ team: "tasked", title: "t", kind: "chore", status: "approved", by: "planner" }));
    assert.match((await nameTaken(tasked)) ?? "", /tasks are filed under it/);
    const off = store("off");
    await off.controls.create(retireControl("off", "operator", "unregistered"));
    assert.match((await nameTaken(off)) ?? "", /controls are recorded under it/);
  });

  // A Mac whose Keychain holds the MongoDB connection (a6g connect mongo), or doesn't.
  const mac = (connected: boolean) => {
    const m = machine();
    rmSync(join(m.bin, "security"));
    writeFileSync(
      join(m.bin, "security"),
      `#!/bin/sh\ncase "$1" in find-generic-password) ${connected ? 'case "$*" in *a6g-mongo*) echo bW9uZ29kYg ;; *) exit 44 ;; esac' : "exit 44"} ;; *) exit 44 ;; esac\n`
    );
    chmodSync(join(m.bin, "security"), 0o755);
    return m;
  };
  const project = () =>
    gitRepo(join(tmp("a6g-init-"), "shop"), { "package.json": { name: "shop", scripts: { test: "node --test" } }, "package-lock.json": "{}\n" });
  const tasksOf = (repo: string): unknown => (JSON.parse(readFileSync(join(`${repo}-a6g`, ".a6g", "team.json"), "utf8")) as { tasks?: unknown }).tasks;

  test("go in MongoDB on a Mac connected to it, unless --store files says otherwise", async () => {
    const m = mac(true);
    const repo = project();
    const made = await a6g(["init", repo, "--no-interview"], { cwd: repo, env: m.env });
    assert.equal(made.code, 0, made.out);
    assert.match(made.out, /its tasks go in MongoDB \(this Mac is connected: a6g connect mongo\), so the web app shows the team/);
    assert.deepEqual(tasksOf(repo), { store: "mongo" });

    const other = project();
    const kept = await a6g(["init", other, "--no-interview", "--store", "files"], { cwd: other, env: m.env });
    assert.equal(kept.code, 0, kept.out);
    assert.doesNotMatch(kept.out, /its tasks (go|stay)/, "chosen, so not said");
    assert.equal(tasksOf(other), undefined);
  });

  test("stay in files on a Mac that isn't connected, and init says how the web app would show it", async () => {
    const m = mac(false);
    const repo = project();
    const made = await a6g(["init", repo, "--no-interview"], { cwd: repo, env: m.env });
    assert.equal(made.code, 0, made.out);
    assert.match(made.out, /its tasks stay in files on this Mac, so the web app won't show the team; a6g connect mongo, then --store mongo/);
    assert.equal(tasksOf(repo), undefined);
  });
});
