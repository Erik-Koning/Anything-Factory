import { write } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { budgetCheck, pausedUntil, resumesWhen } from "../lib/budget.ts";
import { readHold, readLimits } from "../lib/holds.ts";
import { budgetControl, type Control, holdOf, type Limits, pauseControl, resumeControl } from "../lib/tasks/controls.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask, type Task } from "../lib/tasks/model.ts";
import type { Spend } from "../lib/tasks/spend.ts";
import { encodePath } from "../lib/usage.ts";

const limits = (fields: Partial<Limits> = {}): Limits => ({
  daily: 10,
  weekly: null,
  total: 100,
  since: "2026-10-01T00:00:00.000Z",
  autoResume: false,
  ...fields,
});
const spend = (fields: Partial<Spend> = {}): Spend => ({
  day: "2026-11-04",
  today: 0,
  week: 0,
  total: 0,
  since: "2026-10-01",
  unpriced: 0,
  at: "",
  ...fields,
});
let n = 0;
const control = (fields: Omit<Control, "id" | "version">, at = new Date(Date.now() + n * 1000).toISOString()): Control => ({
  ...fields,
  at,
  id: `k${++n}`,
  version: 1,
});
const graph: Task[] = [{ ...newTask({ team: "app", title: "a", kind: "feature", status: "building", by: "planner" }), id: "7", version: 1 }];

describe("the budget's rules", () => {
  test("under four fifths, nothing; from four fifths, a warning per limit and period", () => {
    assert.deepEqual(budgetCheck("app", limits(), spend({ today: 7.9 }), [], graph, false), { warn: [], control: null, why: null });
    assert.deepEqual(budgetCheck("app", null, spend({ today: 99 }), [], graph, false), { warn: [], control: null, why: null });
    const near = budgetCheck("app", limits(), spend({ today: 8, total: 85 }), [], graph, false);
    assert.deepEqual(
      near.warn.map((w) => w.key),
      ["budget-daily:2026-11-04-10", "budget-total:2026-10-01-100"]
    );
    assert.match(near.warn[0]?.text ?? "", /spent \$8\.00 of the \$10 a day budget/);
    assert.equal(near.control, null);
  });

  test("at a limit the team pauses after the work under way; a tenth past it, now", () => {
    const at = budgetCheck("app", limits(), spend({ today: 10 }), [], graph, false);
    assert.equal(at.control?.kind, "pause");
    assert.equal(at.control?.scope, "tasks");
    assert.deepEqual(at.control?.tasks, ["7"]);
    assert.equal(at.control?.by, "budget");
    assert.equal(at.control?.trigger, "daily:2026-11-04");
    assert.match(at.why ?? "", /pauses once the work under way is merged/);
    const past = budgetCheck("app", limits(), spend({ today: 11 }), [], graph, false);
    assert.equal(past.control?.scope, "now");
    assert.equal(past.control?.trigger, "daily:2026-11-04:hard");
    // A weekly limit counts the week from Monday.
    assert.equal(budgetCheck("app", limits({ daily: null, weekly: 50 }), spend({ week: 50 }), [], graph, false).control?.trigger, "weekly:2026-11-02");
  });

  test("a hold in force isn't asked for again, but going a tenth past still stops the team now; a paused team is left alone", () => {
    const draining = [control(pauseControl(graph, "app", { scope: "tasks", by: "budget" }))];
    assert.equal(budgetCheck("app", limits(), spend({ today: 10.5 }), draining, graph, false).control, null);
    assert.equal(budgetCheck("app", limits(), spend({ today: 11 }), draining, graph, false).control?.scope, "now");
    assert.equal(budgetCheck("app", limits(), spend({ today: 50 }), draining, graph, true).control, null);
  });

  test("once the operator resumes a team the budget paused, that limit lets it be for the period; the next period counts again", () => {
    const paused = control({ ...pauseControl(graph, "app", { scope: "tasks", by: "budget" }), trigger: "daily:2026-11-04" });
    const resumed = control(resumeControl("app", "web:s1", "worth it today"));
    assert.equal(budgetCheck("app", limits(), spend({ today: 15 }), [paused, resumed], graph, false).control, null);
    assert.equal(
      budgetCheck("app", limits(), spend({ day: "2026-11-05", today: 10 }), [paused, resumed], graph, false).control?.trigger,
      "daily:2026-11-05"
    );
    // The total, though, isn't the day's: it still pauses the team.
    assert.equal(budgetCheck("app", limits(), spend({ today: 15, total: 100 }), [paused, resumed], graph, false).control?.trigger, "total:2026-10-01");
  });

  test("changing the budget after a resume makes its limits count again, and warn again", () => {
    const paused = control({ ...pauseControl(graph, "app", { scope: "tasks", by: "budget" }), trigger: "total:2026-10-01" });
    const resumed = control(resumeControl("app", "operator"));
    assert.equal(budgetCheck("app", limits({ daily: null }), spend({ total: 250 }), [paused, resumed], graph, false).control, null);
    const raised = control({ ...paused, kind: "budget", by: "operator", trigger: null, limits: limits({ daily: null, total: 200 }) });
    const after = budgetCheck("app", limits({ daily: null, total: 200 }), spend({ total: 250 }), [paused, resumed, raised], graph, false);
    assert.equal(after.control?.scope, "now");
    assert.deepEqual(
      after.warn.map((w) => w.key),
      ["budget-total:2026-10-01-200"]
    );
  });

  test("auto-resume never ends a pause of the operator's, even one the budget went on to tighten", () => {
    const auto = limits({ autoResume: true });
    const mine = control(pauseControl(graph, "app", { scope: "tasks", by: "operator" }));
    const hard = control({ ...pauseControl(graph, "app", { scope: "now", by: "budget" }), trigger: "daily:2026-11-04:hard" });
    assert.equal(budgetCheck("app", auto, spend({ day: "2026-11-05" }), [mine, hard], graph, true).control, null);
    // A daily pause and then a weekly one: a new day isn't a new week.
    const daily = control({ ...pauseControl(graph, "app", { scope: "tasks", by: "budget" }), trigger: "daily:2026-11-04" });
    const weekly = control({ ...pauseControl(graph, "app", { scope: "now", by: "budget" }), trigger: "weekly:2026-11-02" });
    assert.equal(budgetCheck("app", { ...auto, weekly: 1000 }, spend({ day: "2026-11-05" }), [daily, weekly], graph, true).control, null);
    // The watchdog's record of the settled hold doesn't count against it.
    const settled = control({ ...pauseControl(graph, "app", { scope: "now", by: "watchdog" }) });
    assert.equal(budgetCheck("app", auto, spend({ day: "2026-11-05" }), [daily, settled], graph, true).control?.kind, "resume");
  });

  test("with autoResume, a new day starts a team the daily budget paused; not while another limit is over, nor one the operator paused", () => {
    const paused = control({ ...pauseControl(graph, "app", { scope: "tasks", by: "budget" }), trigger: "daily:2026-11-04" });
    const auto = limits({ autoResume: true });
    assert.equal(budgetCheck("app", auto, spend({ today: 12 }), [paused], graph, true).control, null, "the same day");
    const next = budgetCheck("app", auto, spend({ day: "2026-11-05", today: 0, total: 40 }), [paused], graph, true);
    assert.equal(next.control?.kind, "resume");
    assert.equal(next.control?.by, "budget");
    assert.match(next.control?.note ?? "", /a new day: the daily budget starts again/);
    assert.equal(budgetCheck("app", limits(), spend({ day: "2026-11-05" }), [paused], graph, true).control, null, "autoResume off");
    assert.equal(
      budgetCheck("app", auto, spend({ day: "2026-11-05", total: 100 }), [paused], graph, true).control?.kind ?? null,
      null,
      "the total is over"
    );
    const operator = control(pauseControl(graph, "app", { scope: "now", by: "operator" }));
    assert.equal(budgetCheck("app", auto, spend({ day: "2026-11-05" }), [paused, operator], graph, true).control, null);
  });

  test("a new week ends a daily and a weekly pause together, and says so", () => {
    const auto = limits({ autoResume: true, weekly: 50 });
    const daily = control({ ...pauseControl(graph, "app", { scope: "tasks", by: "budget" }), trigger: "daily:2026-11-08" });
    const weekly = control({ ...pauseControl(graph, "app", { scope: "now", by: "budget" }), trigger: "weekly:2026-11-02" });
    for (const order of [
      [daily, weekly],
      [weekly, daily],
    ]) {
      const monday = budgetCheck("app", auto, spend({ day: "2026-11-09" }), order, graph, true);
      assert.equal(monday.control?.kind, "resume");
      assert.equal(monday.control?.trigger, "weekly:2026-11-09");
      assert.match(monday.control?.note ?? "", /a new week: the weekly budget starts again/);
    }
  });

  test("with autoResume, a change to the budget that leaves nothing over starts a team only the budget paused", () => {
    const paused = control({ ...pauseControl(graph, "app", { scope: "tasks", by: "budget" }), trigger: "daily:2026-11-04" });
    const settled = control(pauseControl(graph, "app", { scope: "now", by: "watchdog" }));
    const raise = (fields: Partial<Limits>) => control({ ...budgetControl("app", "operator", limits(fields)), trigger: null });
    const raised = limits({ daily: 20, autoResume: true });
    const resumed = budgetCheck("app", raised, spend({ today: 12 }), [paused, settled, raise({ daily: 20, autoResume: true })], graph, true);
    assert.equal(resumed.control?.kind, "resume");
    assert.equal(resumed.control?.by, "budget");
    assert.match(resumed.why ?? "", /The budget changed, and the team is under every limit now/);
    assert.equal(
      budgetCheck("app", limits({ daily: 20 }), spend({ today: 12 }), [paused, raise({ daily: 20 })], graph, true).control,
      null,
      "without autoResume it stays paused"
    );
    assert.equal(
      budgetCheck("app", limits({ daily: 11, autoResume: true }), spend({ today: 12 }), [paused, raise({ daily: 11, autoResume: true })], graph, true)
        .control,
      null,
      "still over the new limit"
    );
    assert.equal(
      budgetCheck("app", raised, spend({ today: 12 }), [raise({ daily: 20, autoResume: true }), paused], graph, true).control,
      null,
      "a change before the pause isn't one after it"
    );
    // The total waits for the operator, and raising it is the operator's decision.
    const total = control({ ...pauseControl(graph, "app", { scope: "now", by: "budget" }), trigger: "total:2026-10-01" });
    const more = limits({ total: 200, autoResume: true });
    assert.equal(budgetCheck("app", more, spend({ total: 120 }), [total], graph, true).control, null);
    assert.equal(budgetCheck("app", more, spend({ total: 120 }), [total, raise({ total: 200, autoResume: true })], graph, true).control?.kind, "resume");
  });

  test("the operator hears when auto-resume starts the team again", () => {
    const auto = limits({ autoResume: true, weekly: 50 });
    assert.match(
      budgetCheck("app", auto, spend({ today: 10 }), [], graph, false).why ?? "",
      /it pauses once the work under way is merged\. With auto-resume, it starts again tomorrow\./
    );
    assert.match(budgetCheck("app", auto, spend({ today: 10, week: 50 }), [], graph, false).why ?? "", /With auto-resume, it starts again on Monday\./);
    assert.doesNotMatch(budgetCheck("app", auto, spend({ today: 10, total: 100 }), [], graph, false).why ?? "", /auto-resume/, "the total is over too");
    assert.doesNotMatch(budgetCheck("app", limits(), spend({ today: 10 }), [], graph, false).why ?? "", /auto-resume/);
    assert.equal(resumesWhen(["daily"], { autoResume: true }), "tomorrow");
    const paused = control({ ...pauseControl(graph, "app", { scope: "tasks", by: "budget" }), trigger: "daily:2026-11-04" });
    assert.equal(pausedUntil([paused], auto), "tomorrow");
    assert.equal(pausedUntil([paused], limits()), null);
    assert.equal(pausedUntil([paused, control(pauseControl(graph, "app", { scope: "now", by: "operator" }))], auto), null);
  });
});

// A Claude Code transcript with one request of the planner's, today: $4 in, $20 out per million on Claude Opus 5.5.
function transcript(root: string, home: string, dollars: number) {
  const dir = join(root, "home", ".claude", "projects", encodePath(home));
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "agent-setting", agentSetting: "a6g:planner" }),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      gitBranch: "a6g/next",
      message: { id: `m${dollars}`, model: "claude-opus-5-5", usage: { input_tokens: (dollars / 4) * 1e6, output_tokens: 0 } },
    }),
  ];
  writeFileSync(join(dir, `t${dollars}.jsonl`), `${lines.join("\n")}\n`);
}

describe("a6g budget and the watchdog", () => {
  async function world() {
    const { fakeWorld } = await import("./fake-t3.ts");
    const w = await fakeWorld();
    const file = join(w.a6gHome, "teams", "fixture.json");
    write(join(w.a6gHome, "teams"), {
      "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "files", database: "a6g", lead: null } },
    });
    write(w.run, { "planner-thread": "mcp:planner\n" });
    const store = fileStore(w.run, "fixture");
    await store.tasks.createAs("7", newTask({ team: "fixture", title: "being built", kind: "feature", status: "building", by: "planner" }));
    return { w, store };
  }

  test("set, shown, changed one limit at a time, removed; the operator's alone", async () => {
    const { w, store } = await world();
    try {
      const set = await w.a6g("budget", "fixture", "--daily", "40", "--total", "$500");
      assert.equal(set.code, 0, set.out);
      assert.match(set.out, /\$40 a day, none a week, \$500 in all/);
      assert.deepEqual({ ...readLimits(w.run), since: "" }, { daily: 40, weekly: null, total: 500, since: "", autoResume: false, unit: "usd" });
      const since = readLimits(w.run)?.since;
      assert.equal((await w.a6g("budget", "fixture", "--daily", "0", "--auto-resume")).code, 0);
      assert.deepEqual(
        readLimits(w.run),
        { daily: null, weekly: null, total: 500, since, autoResume: true, unit: "usd" },
        "the rest kept, the total still counted from when it began"
      );
      assert.match((await w.a6g("budget", "fixture")).out, /none a day, none a week, \$500 in all since .*; a new day or week resumes/);
      assert.notEqual((await w.a6g("budget", "fixture", "--daily", "lots")).code, 0);
      assert.equal((await w.a6g("budget", "fixture", "--clear")).code, 0);
      assert.equal(readLimits(w.run), null);
      assert.deepEqual(
        (await store.controls.all()).map((c) => [c.kind, c.by]),
        [
          ["budget", "operator"],
          ["budget", "operator"],
          ["budget", "operator"],
        ]
      );
    } finally {
      await w.close();
    }
  });

  test("past the daily budget the watchdog pauses the team after the work under way; the report says what was spent", async () => {
    const { w, store } = await world();
    try {
      assert.equal((await w.a6g("budget", "fixture", "--daily", "5")).code, 0);
      transcript(w.root, w.home, 5.25);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      const pause = (await store.controls.all()).at(-1);
      assert.deepEqual([pause?.kind, pause?.by, pause?.scope, pause?.tasks], ["pause", "budget", "tasks", ["7"]]);
      assert.equal(readHold(w.run)?.scope, "tasks");
      assert.ok(!existsSync(join(w.run, "paused")), "graceful: the work under way finishes first");
      const log = readFileSync(join(w.run, "watchdog.log"), "utf8");
      assert.match(log, /the budget paused the team after the work under way \(#7\) \(\$5\.25 of the \$5\.00 a day budget is spent\)/);
      assert.ok(w.calls().some((c) => /The team's budget \(\$5\.25 of the \$5\.00 a day budget is spent\) is pausing the team/.test(c)));
      // A second run asks for nothing more.
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal((await store.controls.all()).length, 2);
      // #7 merges: the team pauses, and the report has the spend.
      const t = await store.tasks.get("7");
      if (t) await store.tasks.replace({ ...t, status: "done" });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.ok(existsSync(join(w.run, "paused")));
      assert.match(readHold(w.run)?.report ?? "", /Spent \(API-equivalent\): \$5\.25 today of \$5\.00/);
    } finally {
      await w.close();
    }
  });

  test("a tenth past the budget, it pauses now", async () => {
    const { w, store } = await world();
    try {
      assert.equal((await w.a6g("budget", "fixture", "--daily", "5")).code, 0);
      transcript(w.root, w.home, 8);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(holdOf(await store.controls.all())?.scope, "now");
      assert.ok(existsSync(join(w.run, "paused")));
    } finally {
      await w.close();
    }
  });

  test("with auto-resume, a paused team is told when it starts again, and raising the budget starts it", async () => {
    const { w, store } = await world();
    try {
      assert.equal((await w.a6g("budget", "fixture", "--daily", "5", "--auto-resume")).code, 0);
      transcript(w.root, w.home, 8);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.ok(existsSync(join(w.run, "paused")));
      assert.match(
        (await w.a6g("start", "fixture")).out,
        /paused \(by its budget, .*\): auto-resume starts it again tomorrow at the earliest, or a6g resume fixture now/
      );
      // Still over the new limit, and auto-resume turned off: it stays paused, and the operator is told how to start it.
      const lower = await w.a6g("budget", "fixture", "--daily", "6", "--no-auto-resume");
      assert.match(lower.out, /the budget paused fixture, and it stays paused: a6g resume fixture starts it/);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.ok(existsSync(join(w.run, "paused")));
      // Raised, with auto-resume: nothing is over, so the next run starts it again.
      const raised = await w.a6g("budget", "fixture", "--daily", "20", "--auto-resume");
      assert.match(raised.out, /with auto-resume, the watchdog starts it again at its next run if nothing is over now/);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      const resumed = (await store.controls.all()).at(-1);
      assert.deepEqual([resumed?.kind, resumed?.by], ["resume", "budget"]);
      assert.ok(!existsSync(join(w.run, "paused")));
      assert.ok(w.calls().some((c) => /The team starts again: the budget changed, and nothing is over it now\. Carry on\./.test(c)));
    } finally {
      await w.close();
    }
  });
});
