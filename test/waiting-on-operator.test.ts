// A team with nothing to do but wait for the operator: their decisions on proposals reach the planner within a minute
// (lib/answers.ts), as their answers do, so the watchdog's tick slows to an hour while everything open waits on them.
import { baseTeam, tmp, write } from "./helpers.ts";
import { fakeWorld } from "./fake-t3.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { relayAnswers } from "../lib/answers.ts";
import type { RegistryEntry } from "../lib/paths.ts";
import { decide } from "../lib/tasks/decide.ts";
import { decisionsSince } from "../lib/tasks/answer.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { summary } from "../lib/tasks/ops.ts";
import { newTask, OPERATOR, type Task, waitsOnlyOnOperator } from "../lib/tasks/model.ts";

const task = (fields: Partial<Task> & { id: string }): Task => ({
  ...newTask({ team: "fixture", title: `task ${fields.id}`, kind: "feature", status: "proposed", by: "planner", ...fields }),
  version: 1,
  ...fields,
});
const OPERATOR_APPROVES = { mode: "operator" as const };

describe("what waits only on the operator", () => {
  test("questions always; proposals only where the operator decides them; anything else is the team's to move", () => {
    const proposed = task({ id: "1" });
    const question = task({ id: "2", status: "question" });
    const done = task({ id: "3", status: "done" });
    assert.equal(waitsOnlyOnOperator([proposed, question, done], true), true);
    assert.equal(waitsOnlyOnOperator([proposed, question], false), false, "the approver's proposals");
    assert.equal(waitsOnlyOnOperator([question], false), true);
    for (const status of ["triage", "researching", "approved", "building", "review", "blocked"] as const)
      assert.equal(waitsOnlyOnOperator([proposed, task({ id: "4", status })], true), false, status);
    assert.equal(waitsOnlyOnOperator([done], true), false, "nothing open is nothing to wait for");
  });

  test("the operator's decisions on proposals go to the planner once, in one message", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    for (const t of [task({ id: "1", score: SCORE }), task({ id: "2", score: SCORE }), task({ id: "3", score: SCORE })]) {
      const { id, version: _v, ...fields } = t;
      await store.tasks.createAs(id, fields);
    }
    await decide(store, "1", "approve", { who: OPERATOR, approval: APPROVAL });
    await decide(store, "2", "reject", { who: OPERATOR, approval: APPROVAL, text: "Not now" });
    assert.deepEqual(
      decisionsSince(await store.tasks.all(), "").map((d) => [d.task.id, d.what.split(":")[0]]),
      [
        ["1", "proposed → approved"],
        ["2", "proposed → rejected"],
      ]
    );
    const told: string[] = [];
    const entry = { name: "fixture", run, worker: false, tasks: { store: "files" } } as unknown as RegistryEntry;
    const relay = () =>
      relayAnswers(
        entry,
        (text) => (told.push(text), true),
        () => {},
        () => {}
      );
    await relay();
    assert.equal(told.length, 1);
    assert.match(
      told[0] ?? "",
      /The operator decided on what waited for them:\n\n1\. #1 "task 1": proposed → approved\n2\. #2 "task 2": proposed → rejected: Not now/
    );
    await relay();
    assert.equal(told.length, 1, "each goes once");
    assert.equal(readdirSync(join(run, "replies")).length, 2);
  });
});

const SCORE = {
  pain: 3,
  reach: 2,
  revenue: 1,
  wow: 2,
  distribution: 1,
  leverage: 2,
  urgency: 1,
  risk: 0,
  size: "S",
  confidence: "data",
  rationale: "x",
  basis: "x",
} as unknown as Task["score"];
const APPROVAL = { mode: "operator", maxSize: "M", findings: "planner", stakeholders: "operator" } as const;

describe("the planner's context while proposals pile up for the operator", () => {
  test("past fifteen waiting for the operator, it's asked to propose only what outranks them; never for the approver's", () => {
    const waiting = (n: number) => Array.from({ length: n }, (_, i) => task({ id: String(i + 1), score: SCORE }));
    const PLENTY = /That's plenty for them to decide: propose nothing new unless it outranks what waits or unblocks work/;
    assert.doesNotMatch(summary(waiting(14), { approval: "operator" }), PLENTY);
    assert.match(summary(waiting(15), { approval: "operator" }), PLENTY);
    assert.doesNotMatch(summary(waiting(30), { approval: "thresholds" }), PLENTY);
  });
});

describe("the watchdog while everything waits on the operator", () => {
  const ticks = (w: { calls: () => string[] }) => w.calls().filter((c) => /thread send mcp:planner tick/.test(c));
  async function world(tasks: Task[], approval: { mode: "operator" | "thresholds" } = OPERATOR_APPROVES) {
    const w = await fakeWorld(baseTeam({ roles: { planner: {}, builder: {}, approver: {} }, approval }));
    const file = join(w.a6gHome, "teams", "fixture.json");
    write(join(w.a6gHome, "teams"), {
      "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "files", database: "a6g", lead: null } },
    });
    write(w.run, { "planner-thread": "mcp:planner\n" });
    const store = fileStore(w.run, "fixture");
    for (const { id, version: _v, ...fields } of tasks) await store.tasks.createAs(id, fields);
    const ticked = (min: number) => {
      const stamp = join(w.run, ".stamp-tick");
      writeFileSync(stamp, "");
      utimesSync(stamp, new Date(Date.now() - min * 60_000), new Date(Date.now() - min * 60_000));
    };
    return { w, ticked };
  }

  test("the tick slows to an hour where the operator decides every proposal and nothing else is open", async () => {
    const { w, ticked } = await world([task({ id: "1" }), task({ id: "2", status: "question" }), task({ id: "3", status: "done" })]);
    try {
      ticked(15);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.deepEqual(ticks(w), [], "a quarter of an hour after the last tick, none is sent");
      ticked(61);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(ticks(w).length, 1);
      assert.match(ticks(w)[0] ?? "", /hourly: everything open waits for the operator's answers or decisions/);
    } finally {
      await w.close();
    }
  });

  test("it keeps its pace with work the team can move, or where the approver decides the proposals", async () => {
    for (const [tasks, approval] of [
      [[task({ id: "1" }), task({ id: "2", status: "approved" })], OPERATOR_APPROVES],
      [[task({ id: "1" })], { mode: "thresholds" as const }],
    ] as const) {
      const { w, ticked } = await world([...tasks], approval);
      try {
        ticked(15);
        assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
        assert.equal(ticks(w).length, 1, `${tasks.map((t) => t.status).join(", ")} under ${approval.mode}`);
        assert.doesNotMatch(ticks(w)[0] ?? "", /hourly/);
      } finally {
        await w.close();
      }
    }
  });
});
