import { tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { budgetCheck } from "../lib/budget.ts";
import { readLimits } from "../lib/holds.ts";
import { parseUsageReport, type SubscriptionState, withReading } from "../lib/subscriptions.ts";
import { type Limits, holdOf } from "../lib/tasks/controls.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask, type Task } from "../lib/tasks/model.ts";
import { describeSpend, type Spend } from "../lib/tasks/spend.ts";
import { collectHours, encodePath } from "../lib/usage.ts";

// What `claude -p /usage --output-format stream-json --verbose` prints, as Claude Code 2.1.309 does.
const report = (percent: number | null) =>
  [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({
      type: "assistant",
      usage_report: {
        session: { total_cost_usd: 0 },
        rate_limits:
          percent === null
            ? null
            : {
                limits: [
                  {
                    kind: "weekly_all",
                    group: "weekly",
                    percent,
                    resets_at: "2026-11-08T16:00:00.684783+00:00",
                    scope: null,
                    severity: "normal",
                    is_active: true,
                  },
                  {
                    kind: "weekly_scoped",
                    group: "weekly",
                    percent: 3,
                    resets_at: "2026-11-08T16:00:00+00:00",
                    scope: { model: { display_name: "Fable" }, surface: null },
                  },
                ],
              },
      },
    }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ].join("\n");

describe("reading a subscription's usage", () => {
  test("the weekly limit across all models, when it resets, and a model's own limit; nothing without a report", () => {
    assert.deepEqual(parseUsageReport(report(52)), {
      percent: 52,
      resetsAt: "2026-11-08T16:00:00.684Z",
      session: null,
      scoped: [{ model: "Fable", percent: 3 }],
    });
    assert.equal(parseUsageReport(report(null)), null, "an API key, or a token without the scope");
    assert.equal(parseUsageReport("not json\n{}"), null);
  });

  test("one subscription's week in dollars: what this machine spent since the week began over the share used; the median of the newest", () => {
    const empty: SubscriptionState = { readings: {}, estimates: [], week: null };
    // The week began on 1 November at 16:00 UTC (it resets on the 8th).
    const hours = { "2026-11-01T15": 100, "2026-11-01T16": 300, "2026-11-02T10": 200 };
    const at = { percent: 50, resetsAt: "2026-11-08T16:00:00.000Z", scoped: [] };
    let state = withReading(empty, "default", at, hours, new Date("2026-11-02T12:00:00Z"));
    assert.equal(state.readings["default"]?.spent, 500);
    assert.equal(state.week, 1000);
    state = withReading(state, "default", { ...at, percent: 25 }, hours, new Date("2026-11-02T13:00:00Z"));
    state = withReading(state, "default", { ...at, percent: 40 }, hours, new Date("2026-11-02T14:00:00Z"));
    assert.deepEqual(
      state.estimates.map((e) => e.dollars),
      [1000, 2000, 1250]
    );
    assert.equal(state.week, 1250);
    // Too little of the week used to say: the reading is kept, the estimate isn't.
    const early = withReading(empty, "default", { ...at, percent: 4 }, hours);
    assert.deepEqual([early.estimates, early.week, early.readings["default"]?.percent], [[], null, 4]);
  });

  test("every session on the machine counts, the operator's own too, by UTC hour; long-untouched transcripts are passed over", () => {
    const root = tmp("a6g-hours-");
    const dir = join(root, "projects", encodePath("/Users/x/anything"));
    mkdirSync(dir, { recursive: true });
    const now = new Date("2026-11-02T12:30:00Z");
    const line = (id: string, at: string) =>
      JSON.stringify({ type: "assistant", timestamp: at, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1_000_000 } } });
    writeFileSync(
      join(dir, "mine.jsonl"),
      [line("a", "2026-11-02T11:10:00Z"), line("b", "2026-11-02T11:50:00Z"), line("c", "2026-11-02T12:05:00Z"), ""].join("\n")
    );
    writeFileSync(join(dir, "old.jsonl"), [line("d", "2026-10-01T10:00:00Z"), ""].join("\n"));
    const old = new Date("2026-10-01T10:00:00Z");
    utimesSync(join(dir, "old.jsonl"), old, old);
    assert.deepEqual(collectHours(join(root, "hours.json"), [dir], now), { "2026-11-02T11": 8, "2026-11-02T12": 4 });
  });
});

const limits = (fields: Partial<Limits> = {}): Limits => ({
  daily: null,
  weekly: 50,
  total: null,
  since: "2026-10-01T00:00:00.000Z",
  autoResume: false,
  unit: "subscription",
  ...fields,
});
const spend = (fields: Partial<Spend> = {}): Spend => ({
  day: "2026-11-04",
  today: 0,
  week: 0,
  total: 0,
  since: null,
  unpriced: 0,
  at: "",
  subscriptionWeek: 1000,
  ...fields,
});
const graph: Task[] = [{ ...newTask({ team: "app", title: "a", kind: "feature", status: "building", by: "planner" }), id: "7", version: 1 }];

describe("budgets in shares of a subscription", () => {
  test("a share is that much of a subscription's week in dollars; over 100% is more than one subscription's worth", () => {
    assert.equal(budgetCheck("app", limits(), spend({ week: 399 }), [], graph, false).control, null);
    const near = budgetCheck("app", limits(), spend({ week: 400 }), [], graph, false);
    assert.match(near.warn[0]?.text ?? "", /spent 40% of the 50% a week budget \(shares of a subscription's week\)/);
    assert.equal(budgetCheck("app", limits(), spend({ week: 500 }), [], graph, false).control?.scope, "tasks");
    // One and a half subscriptions' week.
    assert.equal(budgetCheck("app", limits({ weekly: 150 }), spend({ week: 1400 }), [], graph, false).control, null);
    assert.equal(budgetCheck("app", limits({ weekly: 150 }), spend({ week: 1500 }), [], graph, false).control?.scope, "tasks");
  });

  test("before the subscription is measured, a budget in shares isn't checked, and says so once", () => {
    const move = budgetCheck("app", limits({ daily: 10 }), spend({ week: 5000, today: 5000, subscriptionWeek: null }), [], graph, false);
    assert.equal(move.control, null);
    assert.deepEqual(
      move.warn.map((w) => w.key),
      ["budget-unmeasured"]
    );
  });

  test("the spend line speaks in shares when the budget does", () => {
    assert.equal(
      describeSpend(spend({ today: 20, week: 450, total: 900 }), limits()),
      "Spent: 2% today, 45% this week of 50%, 90% in all (shares of one subscription's week, about $1,000 API-equivalent)."
    );
    assert.match(describeSpend(spend({ week: 450 }), { ...limits(), unit: "usd" }), /\(this week is 45% of a subscription's week\)/);
  });
});

describe("a6g budget in percent, a6g subscriptions, and the watchdog", () => {
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

  test("limits as percentages, over 100% too; one unit for the whole budget", async () => {
    const { w } = await world();
    try {
      const set = await w.a6g("budget", "fixture", "--weekly", "60%", "--total", "250%");
      assert.equal(set.code, 0, set.out);
      assert.match(set.out, /none a day, 60% a week, 250% in all since .* \(each a share of one subscription's weekly limit\)/);
      assert.match(set.out, /the subscription hasn't been measured yet/);
      assert.equal(readLimits(w.run)?.unit, "subscription");
      assert.notEqual((await w.a6g("budget", "fixture", "--daily", "10", "--weekly", "5%")).code, 0);
      const dollars = await w.a6g("budget", "fixture", "--daily", "40");
      assert.match(dollars.out, /\$40 a day, none a week, none in all .*the limits that were in percent and weren't given again are dropped/);
      assert.equal(readLimits(w.run)?.unit, "usd");
      assert.notEqual((await w.a6g("budget", "fixture", "--weekly", "20000%")).code, 0);
    } finally {
      await w.close();
    }
  });

  test("the watchdog measures spend in shares of the subscription it last read, and holds the team to them", async () => {
    const { w, store } = await world();
    try {
      write(join(w.a6gHome, "subscriptions"), {
        "state.json": {
          readings: {
            default: {
              account: "default",
              at: new Date().toISOString(),
              percent: 30,
              resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
              scoped: [],
              spent: 150,
            },
          },
          estimates: [{ at: new Date().toISOString(), account: "default", dollars: 500 }],
          week: 500,
        },
      });
      assert.match((await w.a6g("subscriptions")).out, /default \(this Mac's own login\): 30% of this week used.*\n.*about \$500 API-equivalent/);
      // 1% of a $500 week is $5; the team spends $5.25 of it.
      assert.equal((await w.a6g("budget", "fixture", "--daily", "1%")).code, 0);
      const transcripts = join(w.root, "home", ".claude", "projects", encodePath(w.home));
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(
        join(transcripts, "p.jsonl"),
        `${JSON.stringify({ type: "agent-setting", agentSetting: "a6g:planner" })}\n${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), gitBranch: "a6g/next", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 1_312_500 } } })}\n`
      );
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      const spent = JSON.parse(readFileSync(join(w.run, "spend.json"), "utf8"));
      assert.deepEqual(
        [spent.subscriptionWeek, spent.subscriptions],
        [500, [{ account: "default", percent: 30, resetsAt: spent.subscriptions[0].resetsAt }]]
      );
      assert.equal(holdOf(await store.controls.all())?.scope, "tasks");
      assert.match(readFileSync(join(w.run, "watchdog.log"), "utf8"), /1\.1% of the 1% a day budget \(shares of a subscription's week\) is spent/);
      assert.match(
        (await w.a6g("status", "fixture")).out,
        /Spent: 1\.1% today of 1%, 1\.1% this week, 1\.1% since \d{4}-\d{2}-\d{2} \(shares of one subscription's week, about \$500 API-equivalent\)/
      );
    } finally {
      await w.close();
    }
  });

  test("subscriptions: another account is its own Claude Code config folder, and the last one stays", async () => {
    const { w } = await world();
    try {
      assert.notEqual((await w.a6g("subscriptions", "add", "second", "--config-dir", join(w.root, "nowhere"))).code, 0);
      const dir = join(w.root, "claude-two");
      mkdirSync(dir);
      assert.equal((await w.a6g("subscriptions", "add", "second", "--config-dir", dir)).code, 0);
      assert.match(
        (await w.a6g("subscriptions")).out,
        /default \(this Mac's own login\): not read yet\n.*not signed in.*\n {2}second \(.*claude-two\): not read yet/
      );
      assert.equal((await w.a6g("subscriptions", "remove", "second")).code, 0);
      assert.notEqual((await w.a6g("subscriptions", "remove", "default")).code, 0);
    } finally {
      await w.close();
    }
  });
});
