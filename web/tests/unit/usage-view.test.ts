// What the Subscriptions page works out from the machines' reports: one subscription per login, the window's periods,
// totals by subscription and model, the pooled limit cards, and how figures are written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type MachineSubscription, USAGE_FIELDS } from "../../../lib/fleet.ts";
import { formatPercent, formatTokens, formatUsd, resetsIn } from "../../components/usage/format.ts";
import { monotonePath, niceScale } from "../../components/usage/chart-math.ts";
import {
  costSegments,
  paceOf,
  periodsOf,
  poolsOf,
  processed,
  sortedBy,
  speedSegments,
  subscriptionAs,
  subscriptionsOf,
  usageOf,
} from "../../server/usage-view.ts";

const NOW = new Date("2026-11-15T12:30:00Z");
const row = (at: string, model: string, fields: Partial<Record<(typeof USAGE_FIELDS)[number], number>>): [string, string, ...number[]] => [
  at,
  model,
  ...USAGE_FIELDS.map((f) => fields[f] ?? 0),
];
const sub = (fields: Partial<MachineSubscription> = {}): MachineSubscription => ({
  name: "default",
  login: "aaaaaaaaaaaaaaaa",
  plan: "Ultra",
  at: "2026-11-15T12:00:00.000Z",
  weekly: { percent: 60, resetsAt: "2026-11-16T12:30:00.000Z" },
  session: null,
  models: [],
  extra: null,
  week: 1500,
  limits: { weekly: null, session: null },
  closed: null,
  teams: [],
  today: "2026-11-15",
  days: [],
  hours: [],
  sessions: [1, 2, 3, 4],
  counted: "2026-11-15T12:05:00.000Z",
  ...fields,
});

test("the same login on two machines is one subscription: its newest limits, its usage added up", () => {
  const subs = subscriptionsOf([
    {
      machine: { id: "m1", name: "studio" },
      subscriptions: [
        sub({
          days: [row("2026-11-15", "claude-opus-5-5", { requests: 2, cost: 1 })],
          weekly: { percent: 50, resetsAt: "2026-11-16T12:30:00.000Z" },
          at: "2026-11-15T11:00:00.000Z",
        }),
        sub({ name: "other", login: "bbbbbbbbbbbbbbbb" }),
      ],
    },
    {
      machine: { id: "m2", name: "laptop" },
      subscriptions: [
        sub({ name: "work", days: [row("2026-11-15", "claude-opus-5-5", { requests: 3, cost: 2 })] }),
        sub({ name: "default", login: null }),
      ],
    },
  ]);
  assert.deepEqual(
    subs.map((s) => [s.name, s.machines, s.colour]),
    [
      ["default", ["laptop"], 0],
      ["default / work", ["studio", "laptop"], 1],
      ["other", ["studio"], 2],
    ]
  );
  const pooled = subs[1];
  assert.equal(pooled?.latest.weekly?.percent, 60, "the newest reading");
  assert.equal(pooled?.days.get("2026-11-15")?.get("claude-opus-5-5")?.requests, 5);
  assert.deepEqual(pooled?.sessions, [2, 4, 6, 8]);
});

test("a login is named by its address, with its names in a6g; one name narrows it to what that name used, its teams and its limits", () => {
  const reports = [
    {
      machine: { id: "m1", name: "studio" },
      subscriptions: [
        sub({
          name: "refdocs",
          email: "op@example.com",
          days: [row("2026-11-15", "claude-opus-5-5", { requests: 2, cost: 1 })],
          limits: { weekly: 80, session: null },
          teams: [{ team: "edit-learning", roles: ["builder"] }],
        }),
        sub({
          name: "default",
          email: "op@example.com",
          days: [row("2026-11-15", "claude-opus-5-5", { requests: 3, cost: 2 })],
          teams: [{ team: "support", roles: ["planner"] }],
        }),
        sub({ name: "spare", login: "bbbbbbbbbbbbbbbb", email: null }),
      ],
    },
    // An older factory sends no address.
    { machine: { id: "m2", name: "laptop" }, subscriptions: [sub({ name: "work", login: "cccccccccccccccc" })] },
  ];
  const subs = subscriptionsOf(reports);
  assert.deepEqual(
    subs.map((s) => [s.name, s.email, s.names]),
    [
      ["op@example.com", "op@example.com", ["default", "refdocs"]],
      ["spare", null, ["spare"]],
      ["work", null, ["work"]],
    ]
  );
  const account = subs[0];
  assert.ok(account);
  assert.equal(account.days.get("2026-11-15")?.get("claude-opus-5-5")?.requests, 5);
  const refdocs = subscriptionAs(reports, account, "refdocs");
  assert.deepEqual([refdocs.key, refdocs.name, refdocs.names, refdocs.colour], [account.key, "op@example.com", ["refdocs"], account.colour]);
  assert.equal(refdocs.days.get("2026-11-15")?.get("claude-opus-5-5")?.requests, 2);
  assert.deepEqual(
    refdocs.teams.map((t) => t.team),
    ["edit-learning"]
  );
  assert.equal(refdocs.latest.limits.weekly, 80);
  assert.equal(subscriptionAs(reports, account, "nobody"), account, "a name it doesn't go by changes nothing");
});

test("in order of name, or most used first: of its week on the Limits view, of the cost or tokens over the window on the others", () => {
  const live = "2026-11-16T12:30:00.000Z";
  const subs = subscriptionsOf([
    {
      machine: { id: "m1", name: "studio" },
      subscriptions: [
        sub({
          name: "alpha",
          login: "aaaaaaaaaaaaaaaa",
          weekly: { percent: 20, resetsAt: live },
          days: [row("2026-11-15", "claude-opus-5-5", { requests: 1, cost: 9 })],
        }),
        sub({
          name: "beta",
          login: "bbbbbbbbbbbbbbbb",
          weekly: { percent: 70, resetsAt: live },
          days: [row("2026-11-15", "claude-opus-5-5", { requests: 1, cost: 1 })],
        }),
        sub({ name: "gamma", login: "cccccccccccccccc", weekly: { percent: 90, resetsAt: "2026-11-01T00:00:00.000Z" } }),
      ],
    },
  ]);
  const order = (sort: "used" | "name", metric: "limits" | "cost") => sortedBy(subs, sort, metric, 30, NOW).map((s) => s.name);
  assert.deepEqual(order("name", "limits"), ["alpha", "beta", "gamma"]);
  assert.deepEqual(order("used", "limits"), ["beta", "alpha", "gamma"], "gamma's week has reset since: none of it is used");
  assert.deepEqual(order("used", "cost"), ["alpha", "beta", "gamma"]);
  assert.deepEqual(
    sortedBy(subs, "used", "limits", 30, NOW).map((s) => s.colour),
    [1, 0, 2],
    "each keeps its colour"
  );
});

test("a window's periods: the last 24 hours to this one, or days to the newest machine's today", () => {
  const { hourly, periods } = periodsOf(1, [], NOW);
  assert.equal(hourly, true);
  assert.deepEqual([periods.length, periods[0], periods.at(-1)], [24, "2026-11-14T13", "2026-11-15T12"]);
  const subs = subscriptionsOf([{ machine: { id: "m1", name: "studio" }, subscriptions: [sub({ today: "2026-11-16" })] }]);
  const week = periodsOf(7, subs, NOW);
  assert.deepEqual([week.periods[0], week.periods.at(-1), week.periods.length], ["2026-11-10", "2026-11-16", 7]);
});

test("totals by subscription and by model, each model's part per subscription; sessions for the window", () => {
  const subs = subscriptionsOf([
    {
      machine: { id: "m1", name: "studio" },
      subscriptions: [
        sub({
          days: [
            row("2026-11-15", "claude-opus-5-5", { requests: 2, input: 10, output: 5, cacheRead: 100, cost: 3 }),
            row("2026-11-14", "claude-fable-5-1", { requests: 1, output: 50, cost: 7 }),
            row("2026-10-01", "claude-fable-5-1", { requests: 1, cost: 100 }),
          ],
        }),
        sub({ name: "other", login: "bbbbbbbbbbbbbbbb", days: [row("2026-11-15", "claude-opus-5-5", { requests: 1, input: 1, cost: 1 })] }),
      ],
    },
  ]);
  const usage = usageOf(subs, 7, NOW);
  assert.deepEqual([usage.totals.cost, usage.totals.requests, processed(usage.totals)], [11, 4, 166]);
  assert.equal(usage.sessions, 4, "7 days: 2 sessions on each");
  const opus = usage.models.find((m) => m.model === "claude-opus-5-5");
  assert.deepEqual(
    opus?.bySub.map((p) => [p.sub.name, p.totals.cost, p.byPeriod.at(-1)?.cost]),
    [
      ["default", 3, 3],
      ["other", 1, 1],
    ]
  );
  assert.equal(usageOf(subs, 90, NOW).totals.cost, 111, "1 October is in 90 days");
});

test("cost by type keeps what isn't split as other; fast mode costs twice, its premium half", () => {
  const t = { ...usageOf([], 7, NOW).totals, cost: 10, costInput: 2, costOutput: 5, costCacheRead: 1, costCacheWrite: 1, fast: 3 };
  assert.deepEqual(
    costSegments(t).map((s) => [s.key, s.value]),
    [
      ["input", 2],
      ["cacheRead", 1],
      ["cacheWrite", 1],
      ["output", 5],
      ["other", 1],
    ]
  );
  assert.deepEqual(
    speedSegments(t).map((s) => s.value),
    [4, 6]
  );
});

test("limit cards: session, weekly, a model's week, extra usage; weighted by plan for the session; the next refill", () => {
  const subs = subscriptionsOf([
    {
      machine: { id: "m1", name: "studio" },
      subscriptions: [
        sub({
          session: { percent: 40, resetsAt: "2026-11-15T14:00:00.000Z" },
          models: [{ model: "Fable", percent: 70, resetsAt: null }],
          limits: { weekly: 80, session: null },
        }),
        sub({
          name: "pro",
          login: "bbbbbbbbbbbbbbbb",
          plan: "Pro",
          weekly: { percent: 100, resetsAt: "2026-11-17T00:00:00.000Z" },
          session: { percent: 10, resetsAt: "2026-11-15T13:00:00.000Z" },
          extra: { enabled: true, limit: 50, used: 10, currency: "USD" },
        }),
      ],
    },
  ]);
  const pools = poolsOf(subs, NOW);
  assert.deepEqual(
    pools.map((p) => p.label),
    ["Session", "Weekly", "Weekly · Fable", "Monthly extra usage"]
  );
  const session = pools[0];
  // Pro's week is used up, so its session is too: (100 × 1 + 40 × 20) / 21.
  assert.ok(session && Math.abs(session.used - 900 / 21) < 1e-9);
  assert.equal(session?.parts[0]?.sub.name, "pro", "soonest reset first");
  assert.equal(session?.next?.part.sub.name, "pro");
  const weekly = pools[1];
  assert.equal(weekly?.used, 80);
  assert.equal(weekly?.parts.find((p) => p.sub.name === "default")?.limit, 80);
  assert.equal(weekly?.parts.find((p) => p.sub.name === "pro")?.exhausted, true);
  assert.equal(pools[2]?.parts[0]?.resetsAt, "2026-11-16T12:30:00.000Z", "a model's week resets with the subscription's");
  assert.equal(pools[3]?.parts[0]?.used, 20);
  assert.equal(
    poolsOf(
      subscriptionsOf([{ machine: { id: "m", name: "m" }, subscriptions: [sub({ weekly: { percent: 9, resetsAt: "2026-11-01T00:00:00Z" } })] }]),
      NOW
    ).length,
    0,
    "a week since reset says nothing"
  );
});

test("pace: more used than the window has run is ahead of it, by over five points", () => {
  assert.deepEqual([paceOf(60, 0.5), paceOf(52, 0.5), paceOf(40, 0.5), paceOf(10, null)], ["ahead", "on", "under", null]);
});

test("figures as the page writes them", () => {
  assert.deepEqual([999, 1000, 12_500, 250_000, 999_999, 1_250_000, 3.2e9].map(formatTokens), ["999", "1K", "12.5K", "250K", "1M", "1.25M", "3.2B"]);
  assert.deepEqual([formatUsd(1234.5), formatPercent(0.1234), formatPercent(0.0004), formatPercent(0)], ["$1,234.50", "12.3%", "<0.1%", "0%"]);
  const at = Date.parse("2026-11-15T12:00:00Z");
  assert.deepEqual(
    ["2026-11-17T16:00:00Z", "2026-11-15T15:12:00Z", "2026-11-15T12:40:00Z", "2026-11-15T12:00:30Z", "2026-11-15T11:00:00Z"].map((r) => resetsIn(r, at)),
    ["resets in 2d 4h", "resets in 3h 12m", "resets in 40m", "resets momentarily", "resets now"]
  );
});

test("the chart's scale has four clean steps past the peak; its line never overshoots the figures", () => {
  assert.deepEqual(niceScale(7), { top: 8, ticks: [0, 2, 4, 6, 8] });
  assert.deepEqual(niceScale(130).top, 200);
  assert.deepEqual(niceScale(0).top, 1);
  const path = monotonePath([
    [0, 10],
    [1, 10],
    [2, 0],
  ]);
  assert.match(path, /^M0,10 C/);
  assert.ok(!path.includes("NaN"));
});
