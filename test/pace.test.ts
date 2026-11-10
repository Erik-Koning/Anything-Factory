import { baseTeam, makeRepo, ROOT, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileStore } from "../lib/tasks/files.ts";
import {
  clearPace,
  DEFAULT_UNIT_COST,
  pace,
  paceAllowance,
  PACE_FRESH_MIN,
  type PaceInput,
  roomOf,
  spendAsOf,
  unitCostOf,
  writePace,
} from "../lib/pace.ts";
import type { Limits } from "../lib/tasks/controls.ts";
import { newTask, type Score, type Size, type Task } from "../lib/tasks/model.ts";
import { dayOf, type Spend, type UsageDay } from "../lib/tasks/spend.ts";

const scored = (size: Size): Score => ({
  pain: 1,
  reach: 1,
  revenue: 1,
  wow: 1,
  distribution: 1,
  leverage: 1,
  urgency: 1,
  risk: 1,
  confidence: "asks",
  size,
  why: "",
});
const task = (fields: Partial<Task> & { id: string }): Task => ({
  ...newTask({ team: "app", title: `task ${fields.id}`, kind: "feature", status: "approved", by: "planner", ...fields }),
  version: 1,
  ...fields,
});
// A task merged on `day`, as the merge queue records it.
const done = (id: string, size: Size, day = "2026-11-03"): Task =>
  task({
    id,
    status: "done",
    score: scored(size),
    sha: "abc1234",
    history: [{ at: `${day}T12:00:00.000Z`, by: "merge-queue", what: "review → done", from: "review", to: "done", sha: "abc1234" }],
  });
const usage = (day: string, rows: { task?: string; cost: number; role?: string }[]): UsageDay => ({
  team: "app",
  day,
  machine: "studio",
  updatedAt: "",
  rows: rows.map(({ task = null, cost, role = "builder" }) => ({
    role,
    model: "claude",
    task,
    requests: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
    unpriced: 0,
  })),
});
const limits = (fields: Partial<Limits> = {}): Limits => ({
  daily: null,
  weekly: null,
  total: null,
  since: "2026-11-01T00:00:00.000Z",
  autoResume: false,
  ...fields,
});
const spend = (fields: Partial<Spend> = {}): Spend => ({ day: "2026-11-09", today: 0, week: 0, total: 0, since: null, unpriced: 0, at: "", ...fields });
// The day spend() counted, at three in the afternoon: the pace's clock in these tests.
const NOW = new Date("2026-11-09T15:00:00");
const input = (fields: Partial<PaceInput>): PaceInput => ({
  now: NOW,
  all: [],
  days: [],
  spend: null,
  limits: null,
  running: { builder: 0, tester: 0 },
  slots: { builder: 2, tester: 1 },
  ...fields,
});

describe("pacing to the budget", () => {
  test("a unit of finished work costs what the team spent over what it finished since it counted, or the default", () => {
    assert.deepEqual(unitCostOf([], []), { unitCost: DEFAULT_UNIT_COST, basis: "default" });
    const days = [usage("2026-11-02", [{ cost: 20 }]), usage("2026-11-04", [{ task: "9", cost: 10, role: "reviewer" }])];
    const two = [done("1", "S"), done("2", "M")];
    assert.equal(unitCostOf(two, days).basis, "default", "until three are done");
    const three = [...two, done("3", "M"), done("4", "XL", "2026-10-20"), task({ id: "5", status: "building", score: scored("L") })];
    // $30 over S + M + M = 5 units; the XL finished before use was counted, and the L isn't finished.
    assert.deepEqual(unitCostOf(three, days), { unitCost: 6, basis: "history" });
    // Closed because it was folded into another: done, but nothing was merged, so no units.
    const folded = { ...done("6", "L"), sha: null, history: [{ at: "2026-11-05T12:00:00.000Z", by: "merge-queue", what: "blocked → done", to: "done" }] };
    assert.deepEqual(unitCostOf([...three, folded], days), { unitCost: 6, basis: "history" });
  });

  test("the room is the tightest limit's, a subscription's share converted, none until it's measured", () => {
    assert.equal(roomOf(spend(), null, NOW), null);
    assert.deepEqual(roomOf(spend({ today: 4, week: 30, total: 50 }), limits({ daily: 10, total: 100 }), NOW), {
      left: 6,
      name: "daily",
      limit: "the daily $10",
      ceiling: { dollars: 10, limit: "the daily $10" },
    });
    assert.deepEqual(roomOf(spend({ today: 4, week: 30, total: 50 }), limits({ daily: 40, weekly: 45 }), NOW), {
      left: 15,
      name: "weekly",
      limit: "the weekly $45",
      ceiling: { dollars: 40, limit: "the daily $40" },
    });
    assert.equal(roomOf(spend({ week: 10 }), limits({ weekly: 50, unit: "subscription" }), NOW), null, "no reading of the subscription yet");
    assert.equal(roomOf(spend({ week: 10, subscriptionWeek: 100 }), limits({ weekly: 50, unit: "subscription" }), NOW)?.left, 40);
    assert.equal(roomOf(spend({ today: 12 }), limits({ daily: 10 }), NOW)?.left, 0, "never below nothing");
    assert.deepEqual(roomOf(spend({ today: 4, week: 30 }), limits({ daily: 10, weekly: 45, total: 100 }), NOW)?.ceiling, {
      dollars: 10,
      limit: "the daily $10",
    });
  });

  test("spend.json from yesterday or last week counts as nothing spent today or this week", () => {
    const now = new Date("2026-11-10T00:03:00");
    const late = spend({ day: "2026-11-09", today: 9, week: 30, total: 50 });
    assert.deepEqual(spendAsOf(late, now), { ...late, day: "2026-11-10", today: 0 }, "Tuesday: the week goes on");
    assert.deepEqual(spendAsOf({ ...late, day: "2026-11-08" }, new Date("2026-11-09T00:03:00")), {
      ...late,
      day: "2026-11-09",
      today: 0,
      week: 0,
    });
    assert.equal(spendAsOf(late, new Date("2026-11-09T23:59:00")), late, "the same day");
    assert.equal(roomOf(late, limits({ daily: 10 }), now)?.left, 10, "the new day's budget, before the watchdog has counted it");
  });

  test("without a budget, the slots and the claims set the pace", () => {
    const all = [
      task({ id: "1", files: ["src/a/"] }),
      task({ id: "2", files: ["src/a/b.ts"] }),
      task({ id: "3", files: ["src/c/"] }),
      task({ id: "4", kind: "test" }),
    ];
    const p = pace(input({ all, running: { builder: 1, tester: 0 } }));
    assert.deepEqual(
      p.starts.map((s) => `${s.role} #${s.id}`),
      ["builder #1", "tester #4"],
      "one builder slot is free; #2 shares #1's files"
    );
    assert.equal(p.allow, null);
    assert.equal(p.left, null);
    assert.match(
      p.text,
      /^Pace: at work builder 1\/2, tester 0\/1\. No budget is measured, so only the role limits hold\. Start 2 now, in order: builder for #1 \(M, about \$6\.00\); tester for #4/
    );
    assert.match(p.text, /\$3\.00 a size unit \(S 1, M 2, L 4, XL 8\), a default until 3 tasks are done\./);
    const full = pace(input({ all, running: { builder: 2, tester: 1 } }));
    assert.deepEqual(full.starts, []);
    assert.match(full.text, /Every slot is taken\./);
    assert.match(pace(input({ all: [task({ id: "1", status: "proposed" })] })).text, /Nothing approved can be claimed now\./);
  });

  test("starts fit what the budget leaves after the work under way, in order, and cap the roles when it binds", () => {
    const all = [
      task({ id: "1", status: "building", score: scored("M") }),
      task({ id: "2", priority: 50, score: scored("M"), files: ["src/b/"] }),
      task({ id: "3", priority: 40, score: scored("S"), files: ["src/c/"] }),
      task({ id: "4", priority: 30, score: scored("L"), files: ["src/d/"] }),
    ];
    const days = [usage("2026-11-09", [{ task: "1", cost: 5 }])];
    const budget = { limits: limits({ daily: 20 }), running: { builder: 1, tester: 0 }, slots: { builder: 4, tester: 1 } };
    // #1 is estimated at $6 and has used $5, but isn't merged: it still needs a quarter of its estimate.
    const roomy = pace(input({ ...budget, all, days, spend: spend({ today: 5 }) }));
    assert.equal(roomy.underWay, 1.5);
    assert.deepEqual(
      roomy.starts.map((s) => s.id),
      ["2", "3"],
      "$15 left: $1.50 under way, then $6 and $3 fit, and the L's $12 doesn't"
    );
    assert.deepEqual(roomy.waiting, { id: "4", role: "builder", size: "L", cost: 12 });
    assert.deepEqual(roomy.allow, { builder: 2, tester: 0 });
    assert.match(roomy.text, /Budget: \$15 left under the daily \$20; the work under way needs about \$1\.50\./);
    assert.match(
      roomy.text,
      /#4 \(L, about \$12\) is next and doesn't fit: let the work under way finish and merge, split it smaller, or wait for tomorrow's budget\./
    );
    assert.match(
      roomy.why ?? "",
      /\$15 is left under the daily \$20, the work under way needs about \$1\.50, #2, #3 about \$9\.00 more, and #4 \(L, about \$12\) doesn't fit/
    );

    const tight = pace(input({ ...budget, all, days, spend: spend({ today: 14 }) }));
    assert.deepEqual(tight.starts, [], "$6 left: the next in order doesn't fit, and nothing behind it jumps the queue");
    assert.equal(tight.waiting?.id, "2");
    assert.deepEqual(tight.allow, { builder: 0, tester: 0 });
    assert.match(tight.text, /Start nothing new now\./);
    const total = pace(input({ ...budget, all, days, limits: limits({ total: 20 }), spend: spend({ total: 14 }) }));
    assert.match(total.text, /or raise it with the operator\./);

    // Sent back for changes: approved again, on its branch, and counted once, in the work under way. It goes back
    // whatever is left, even behind a new task that doesn't fit and ranks above it.
    const sentBack = [task({ id: "5", priority: 10, branch: "a6g/b5-x", score: scored("M"), files: ["src/e/"] }), ...all];
    const back = pace(input({ ...budget, all: sentBack, days, spend: spend({ today: 14 }) }));
    assert.equal(back.underWay, 7.5);
    assert.deepEqual(back.starts, [{ id: "5", role: "builder", size: "M", cost: 0 }], "finishing work under way goes on, whatever is left");
    assert.equal(back.waiting?.id, "2");
    assert.deepEqual(back.allow, { builder: 1, tester: 0 });
    assert.match(back.text, /builder for #5 \(M, back to its branch: name it in the brief\)/);
    const behind = [task({ id: "6", severity: "blocker", score: scored("L"), files: ["src/f/"] }), ...sentBack];
    const blocked = pace(input({ ...budget, all: behind, days, spend: spend({ today: 14 }) }));
    assert.equal(blocked.waiting?.id, "6", "a blocker ranks first, and doesn't fit");
    assert.deepEqual(
      blocked.starts.map((s) => s.id),
      ["5"],
      "the rework behind it still goes back"
    );
  });

  test("a task more than a day's limit could ever pay for says to split it, not to wait", () => {
    const all = [
      task({ id: "1", priority: 90, score: scored("XL"), files: ["src/a/"] }),
      task({ id: "2", priority: 10, score: scored("S"), files: ["src/b/"] }),
    ];
    const big = pace(input({ all, limits: limits({ daily: 20, weekly: 100 }), spend: spend() }));
    assert.equal(big.left, 20);
    assert.equal(big.waiting?.id, "1");
    assert.equal(big.tooBig, true);
    assert.deepEqual(big.starts, [], "it still holds the queue: claims follow the order");
    assert.match(big.text, /#1 \(XL, about \$24\) is next, and it's more than the daily \$20 could ever pay for at once: split it now/);
    assert.doesNotMatch(big.text, /tomorrow/);
    assert.match(big.why ?? "", /is more than the daily \$20 at once/);
    const fits = pace(input({ all, limits: limits({ daily: 30 }), spend: spend({ today: 10 }) }));
    assert.equal(fits.tooBig, false, "$24 fits under the daily $30 on a new day");
    assert.match(fits.text, /wait for tomorrow's budget/);
  });

  test("the guard reads what the pace allows while it's fresh", () => {
    const run = tmp("a6g-pace-");
    assert.equal(paceAllowance(run, "builder"), null, "none worked out yet");
    writePace(run, { allow: { builder: 1, tester: 0 }, why: "the budget is spent" }, { builder: 7, tester: 2 });
    assert.deepEqual(paceAllowance(run, "builder"), { allow: 1, started: 7, why: "the budget is spent" });
    assert.equal(paceAllowance(run, "reviewer"), null, "only the roles that claim are paced");
    assert.equal(paceAllowance(run, "builder", Date.now() + (PACE_FRESH_MIN + 1) * 60_000), null, "an old pace is ignored");
    writePace(run, { allow: { builder: 0 }, why: "spent" }, null);
    assert.equal(paceAllowance(run, "builder"), null, "without T3 Code's count of starts, the limits alone");
    writePace(run, { allow: { builder: 0 }, why: "spent" }, { builder: 0 });
    clearPace(run);
    assert.equal(paceAllowance(run, "builder"), null, "a pace that couldn't be worked out leaves the limits");
  });

  test("every wake, the planner's context gives the pace and the ideas queue, and saves the caps for the guard", async () => {
    const home = makeRepo(baseTeam({ roles: { planner: {}, builder: { limit: 2 }, reviewer: {}, innovator: { minQueue: 3 } } }));
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    for (const fields of [
      { title: "Resume a recording", status: "building" as const },
      { title: "Share a recording", files: ["src/share/"] },
      { title: "Export recordings", files: ["src/export/"], score: scored("L") },
    ])
      await store.tasks.create(newTask({ team: "fixture", kind: "feature", status: "approved", by: "planner", ...fields }));
    write(run, { "budget.json": limits({ daily: 12 }), "spend.json": spend({ day: dayOf(new Date()), today: 2 }) });
    // A T3 Code database with nobody at work, so the hook can count.
    const t3 = tmp("a6g-t3-");
    mkdirSync(join(t3, "userdata"));
    execFileSync("sqlite3", [join(t3, "userdata", "statev2.sqlite")], { input: readFileSync(join(ROOT, "test", "fake-t3", "schema.sql"), "utf8") });
    const result = spawnSync(process.execPath, [join(ROOT, "plugin", "hooks", "context.ts")], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", agent_type: "a6g:planner", cwd: home, session_id: "test" }),
      env: { ...process.env, A6G_TEAM: "fixture", A6G_HOME_DIR: home, A6G_RUN: run, A6G_ROLE: "planner", CLAUDE_PROJECT_DIR: home, T3CODE_HOME: t3 },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const context = (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.match(context, /Ideas queued \(features not yet started\): 2 \(#2, #3\), under the 3 the team keeps, but the budget has room only/);
    // $10 left; #1 (M, $6) under way, so #2 ($6) doesn't fit.
    assert.match(
      context,
      /Pace: at work builder 0\/2\. Budget: \$10 left under the daily \$12; the work under way needs about \$6\.00\. Start nothing new now\./
    );
    assert.deepEqual(paceAllowance(run, "builder"), {
      allow: 0,
      started: 0,
      why: "$10 is left under the daily $12, the work under way needs about $6.00, and #2 (M, about $6.00) doesn't fit (a6g task pace).",
    });
  });
});
