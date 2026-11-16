import { guard, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { accountClosures, budgetCheck } from "../lib/budget.ts";
import {
  type Account,
  choose,
  chooseFor,
  describeFallback,
  fallbackFor,
  gate,
  listFor,
  loginDirs,
  nearLimit,
  parseUsageReport,
  type Reading,
  type SubscriptionState,
  weekFor,
  withReading,
} from "../lib/subscriptions.ts";
import { readLimits } from "../lib/holds.ts";
import { PACKAGE } from "../lib/paths.ts";
import { budgetControl } from "../lib/tasks/controls.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { instance, teamInstances, type T3Settings, withHomes } from "../lib/t3.ts";
import type { Control, Limits } from "../lib/tasks/controls.ts";
import { blendedWeek, describeSpend, type Spend, spendOf, type UsageDay } from "../lib/tasks/spend.ts";
import { collectUsage, encodePath, transcriptDirsByAccount } from "../lib/usage.ts";

const NOW = new Date("2026-11-04T12:00:00Z");
const later = (hours: number): string => new Date(NOW.getTime() + hours * 3_600_000).toISOString();
const reading = (account: string, percent: number, fields: Partial<Reading> = {}): Reading => ({
  account,
  at: NOW.toISOString(),
  percent,
  resetsAt: later(48),
  scoped: [],
  spent: 0,
  ...fields,
});
const state = (...readings: Reading[]): SubscriptionState => ({
  readings: Object.fromEntries(readings.map((r) => [r.account, r])),
  estimates: [],
  week: null,
});
const two: Account[] = [
  { name: "one", configDir: null },
  { name: "two", configDir: "/logins/two" },
];

describe("what a subscription allows", () => {
  test("open with no reading; closed at the operator's limit, and always once used up, until it resets", () => {
    const names = ["one", "two"];
    assert.equal(gate("one", state(), {}, names, NOW).open, true);
    assert.deepEqual(gate("one", state(reading("one", 81)), { one: { weekly: 80 } }, names, NOW), {
      open: false,
      exhausted: false,
      room: false,
      why: "one is at 81% of its week, its limit is 80%",
      until: later(48),
      kind: "limit",
    });
    const used = gate("one", state(reading("one", 100)), {}, names, NOW);
    assert.deepEqual([used.open, used.exhausted, used.why], [false, true, "one has used its week"]);
    // A week that has since reset says nothing about now.
    assert.equal(gate("one", state(reading("one", 100, { resetsAt: later(-1) })), {}, names, NOW).open, true);
  });

  test("the five-hour window, when the report has one", () => {
    const busy = reading("one", 20, { session: { percent: 100, resetsAt: later(2) } });
    assert.deepEqual(gate("one", state(busy), {}, ["one"], NOW).why, "one has used its five hours");
    assert.equal(gate("one", state({ ...busy, session: { percent: 60, resetsAt: later(2) } }), { one: { session: 50 } }, ["one"], NOW).open, false);
    assert.equal(gate("one", state({ ...busy, session: { percent: 100, resetsAt: later(-1) } }), {}, ["one"], NOW).open, true);
    const report = [
      JSON.stringify({
        usage_report: {
          rate_limits: {
            limits: [
              { kind: "session", group: "session", percent: 40, resets_at: "2026-11-04T15:00:00+00:00" },
              { kind: "weekly_all", group: "weekly", percent: 10, resets_at: "2026-11-08T16:00:00+00:00" },
            ],
          },
        },
      }),
    ].join("\n");
    assert.deepEqual(parseUsageReport(report)?.session, { percent: 40, resetsAt: "2026-11-04T15:00:00.000Z" });
  });

  test("the limit across all of them counts every subscription's week", () => {
    const both = state(reading("one", 70), reading("two", 65));
    const limits = { all: { weekly: 130 } };
    const shut = gate("two", both, limits, ["one", "two"], NOW);
    assert.deepEqual([shut.open, shut.why], [false, "the subscriptions together are at 135% of a week, their limit is 130%"]);
    assert.equal(gate("two", both, { all: { weekly: 150 } }, ["one", "two"], NOW).open, true);
  });

  test("room: five points or more under every limit", () => {
    assert.equal(gate("one", state(reading("one", 75)), { one: { weekly: 80 } }, ["one"], NOW).room, true);
    assert.equal(gate("one", state(reading("one", 77)), { one: { weekly: 80 } }, ["one"], NOW).room, false);
  });

  test("near a limit (or closed), the watchdog reads every five minutes", () => {
    assert.equal(nearLimit(state(reading("one", 50)), {}, ["one"], NOW), false);
    assert.equal(nearLimit(state(reading("one", 91)), {}, ["one"], NOW), true);
    assert.equal(nearLimit(state(reading("one", 71)), { one: { weekly: 80 } }, ["one"], NOW), true);
    assert.equal(nearLimit(state(reading("one", 60), reading("two", 61)), { all: { weekly: 130 } }, ["one", "two"], NOW), true);
  });
});

describe("a role on Fable while its subscription has used up Fable's own limit", () => {
  const FABLE = "claude-fable-5-2";
  const OPUS = "claude-opus-5-5";
  const fable = (percent: number, resetsAt: string | null = later(30)) => ({ model: "Fable", percent, ...(resetsAt ? { resetsAt } : {}) });

  test("it runs on Opus until that limit resets; the subscription stays open for the rest", () => {
    const used = state(reading("refdocs", 71, { scoped: [fable(100)] }));
    const fallback = fallbackFor(FABLE, "refdocs", used, NOW);
    assert.deepEqual(fallback, { from: FABLE, model: OPUS, subscription: "refdocs", until: later(30), why: "refdocs' Fable limit is used up" });
    assert.equal(describeFallback(fallback!), `on Opus until ${later(30).slice(0, 16).replace("T", " ")} UTC: refdocs' Fable limit is used up`);
    assert.equal(fallbackFor("claude-fable-5-2[1m]", "refdocs", used, NOW)?.model, OPUS);
    assert.equal(gate("refdocs", used, {}, ["refdocs"], NOW).open, true);
    assert.equal(fallbackFor(FABLE, "default", state(reading("default", 76, { scoped: [fable(100)] })), NOW)?.why, "default's Fable limit is used up");
  });

  test("a role on another model, a limit not used up, one since reset, or no reading: its own model", () => {
    const used = state(reading("one", 40, { scoped: [fable(100)] }));
    assert.equal(fallbackFor(OPUS, "one", used, NOW), null);
    assert.equal(fallbackFor("claude-sonnet-5-5", "one", used, NOW), null);
    assert.equal(fallbackFor(FABLE, "one", state(reading("one", 40, { scoped: [fable(99)] })), NOW), null);
    assert.equal(fallbackFor(FABLE, "one", state(reading("one", 40, { scoped: [fable(100, later(-1))] })), NOW), null);
    assert.equal(fallbackFor(FABLE, "one", state(reading("one", 40, { scoped: [{ model: "Opus", percent: 100 }] })), NOW), null);
    assert.equal(fallbackFor(FABLE, "two", used, NOW), null);
    assert.equal(fallbackFor(FABLE, null, used, NOW), null);
    // A report that didn't say when it resets: until a reading says otherwise, within the week it was read in.
    const unsaid = state(reading("one", 40, { scoped: [fable(100, null)] }));
    assert.deepEqual(
      [fallbackFor(FABLE, "one", unsaid, NOW)?.until, describeFallback(fallbackFor(FABLE, "one", unsaid, NOW)!)],
      [null, "on Opus for now: one's Fable limit is used up"]
    );
    assert.equal(fallbackFor(FABLE, "one", state(reading("one", 40, { resetsAt: later(-1), scoped: [fable(100, null)] })), NOW), null);
  });

  test("near a model's own limit, the watchdog reads every five minutes", () => {
    assert.equal(nearLimit(state(reading("one", 20, { scoped: [fable(80)] })), {}, ["one"], NOW), false);
    assert.equal(nearLimit(state(reading("one", 20, { scoped: [fable(91)] })), {}, ["one"], NOW), true);
    assert.equal(nearLimit(state(reading("one", 20, { scoped: [fable(100, later(-1))] })), {}, ["one"], NOW), false);
  });
});

describe("choosing a role's subscription", () => {
  const gates = (shut: Record<string, { room?: boolean; open?: boolean }>) => (name: string) => ({
    open: shut[name]?.open ?? true,
    exhausted: false,
    room: shut[name]?.room ?? true,
    why: shut[name]?.open === false ? `${name} is shut` : null,
    until: null,
  });

  test("it stays while that's open, moves on when it closes, and moves back only with room", () => {
    assert.equal(choose(["one", "two"], "two", gates({})), "one");
    assert.equal(choose(["one", "two"], "two", gates({ one: { room: false } })), "two");
    assert.equal(choose(["one", "two"], "one", gates({ one: { open: false } })), "two");
    assert.equal(choose(["one", "two"], null, gates({ one: { open: false } })), "two");
    assert.equal(choose(["one", "two"], "one", gates({ one: { open: false }, two: { open: false } })), null);
  });

  test("a role's own list, else the team's, else this Mac's own login; empty when that isn't listed", () => {
    assert.deepEqual(listFor({ "*": ["two", "one"], builder: ["two"] }, "builder", two), ["two"]);
    assert.deepEqual(listFor({ "*": ["two", "one"] }, "reviewer", two), ["two", "one"]);
    assert.deepEqual(listFor(undefined, "planner", two), ["one"]);
    assert.deepEqual(listFor(undefined, "planner", [{ name: "two", configDir: "/logins/two" }]), []);
  });

  test("each role on its first open one; a role none is open to waits where it is, with why and until when", () => {
    const ctx = {
      use: { "*": ["one", "two"], builder: ["one"] },
      accounts: two,
      state: state(reading("one", 85), reading("two", 20)),
      limits: { one: { weekly: 80 } },
      now: NOW,
    };
    const choice = chooseFor(["planner", "builder"], { planner: "one", builder: "one" }, ctx);
    assert.deepEqual(choice.roles, { planner: "two", builder: "one" });
    assert.deepEqual(choice.waiting, { builder: { why: "one is at 85% of its week, its limit is 80%", until: later(48), key: "one:limit" } });
    // The team's own budget on a subscription closes it to the team alone.
    const budgeted = chooseFor(
      ["planner"],
      { planner: "two" },
      { ...ctx, state: state(), closedFor: { two: "the team has spent $50 of the $40 a week budget on two" } }
    );
    assert.deepEqual(budgeted.roles, { planner: "one" });
    // A name that isn't a subscription here is closed.
    const unknown = chooseFor(["planner"], {}, { ...ctx, use: { "*": ["three"] } });
    assert.match(unknown.waiting["planner"]?.why ?? "", /three isn't a subscription on this Mac/);
  });
});

describe("what a subscription's week comes to", () => {
  test("each one's own estimate, else its plan's, else all of them; a changed login starts its estimates again", () => {
    const hours = { "2026-11-02T10": 400 };
    const week = { percent: 40, resetsAt: "2026-11-08T16:00:00.000Z", scoped: [] };
    let s: SubscriptionState = { readings: {}, estimates: [], week: null };
    s = withReading(s, "one", { ...week, login: "acct-1", plan: "Max 20x" }, hours, NOW);
    s = withReading(s, "two", { ...week, percent: 10, login: "acct-2", plan: "Max 5x" }, { "2026-11-02T10": 25 }, NOW);
    assert.deepEqual([weekFor(s, "one"), weekFor(s, "two")], [1000, 250]);
    s = withReading(s, "three", { ...week, percent: 1, login: "acct-3", plan: "Max 5x" }, {}, NOW);
    assert.equal(weekFor(s, "three"), 250, "the same plan's");
    // Signed in to another account: its old estimates were someone else's.
    s = withReading(s, "two", { ...week, percent: 2, login: "acct-9", plan: "Max 5x" }, {}, NOW);
    assert.equal(s.estimates.filter((e) => e.account === "two").length, 0);
  });

  test("a team on several: its week is what it spent over the shares of each one's week", () => {
    const accounts = { one: { today: 0, week: 100, total: 100 }, two: { today: 0, week: 50, total: 50 } };
    // 100 of a 1,000 week (10%) and 50 of a 250 week (20%): 30% of "a week" for 150 dollars.
    assert.equal(blendedWeek(accounts, { one: 1000, two: 250 }), 500);
    assert.equal(blendedWeek(accounts, { one: 1000, two: null }), null);
    assert.equal(blendedWeek({ one: { today: 0, week: 0, total: 0 } }, { one: 1000 }), null);
  });
});

describe("a team's budget on one subscription", () => {
  const limits = (accounts: Limits["accounts"], unit: Limits["unit"] = "usd"): Limits => ({
    daily: null,
    weekly: null,
    total: null,
    since: "2026-10-01T00:00:00.000Z",
    autoResume: false,
    unit,
    ...(accounts ? { accounts } : {}),
  });
  const spend = (fields: Partial<Spend> = {}): Spend => ({ day: "2026-11-04", today: 0, week: 0, total: 0, since: null, unpriced: 0, at: "", ...fields });

  test("it closes that subscription to the team at its limit, warning at four fifths, and never pauses it", () => {
    const set = limits({ two: { daily: null, weekly: 40, total: null } });
    const at = (week: number) => spend({ week, accounts: { two: { today: 0, week, total: week } } });
    assert.deepEqual(accountClosures(set, at(30)), {});
    assert.deepEqual(accountClosures(set, at(41)), { two: "the team has spent $41 of the $40 a week budget on two" });
    const warned = budgetCheck("app", set, at(33), [], [], false);
    assert.deepEqual(
      [warned.control, warned.warn.map((w) => w.text)],
      [null, ["The team has spent $33 of the $40 a week budget on two (API-equivalent)."]]
    );
    const spent = budgetCheck("app", set, at(41), [], [], false);
    assert.equal(spent.control, null);
    assert.match(spent.warn[0]?.text ?? "", /on two: it moves to its next subscription/);
  });

  test("a change to its limits on one subscription alone doesn't undo the operator's carrying on past a pause", () => {
    const team = { ...limits(undefined), weekly: 50 };
    const base = { team: "app", by: "operator", at: "", note: "", scope: null, tasks: [], journeys: [], limits: null, version: 1 };
    const controls: Control[] = [
      { ...base, id: "k1", kind: "budget", limits: team },
      { ...base, id: "k2", kind: "pause", by: "budget", scope: "tasks", trigger: "weekly:2026-11-02" },
      { ...base, id: "k3", kind: "resume" },
    ];
    const over = spend({ week: 60 });
    assert.equal(budgetCheck("app", team, over, controls, [], false).control, null);
    const accountOnly = { ...team, accounts: { two: { daily: null, weekly: 30, total: null } } };
    const more = [...controls, { ...base, id: "k4", kind: "budget" as const, limits: accountOnly }];
    assert.equal(budgetCheck("app", accountOnly, over, more, [], false).control, null);
    // A change to its own limits is a new decision.
    const raised = { ...team, weekly: 55 };
    assert.notEqual(
      budgetCheck("app", raised, over, [...controls, { ...base, id: "k4", kind: "budget" as const, limits: raised }], [], false).control,
      null
    );
  });

  test("in shares, each against that subscription's own week", () => {
    const set = limits({ two: { daily: null, weekly: 20, total: null } }, "subscription");
    const week = spend({ week: 60, accounts: { two: { today: 0, week: 60, total: 60, subscriptionWeek: 250 } } });
    assert.deepEqual(accountClosures(set, week), { two: "the team has spent 24% of the 20% a week budget (shares of a subscription's week) on two" });
    assert.equal(accountClosures(set, spend({ week: 60, accounts: { two: { today: 0, week: 60, total: 60 } } }))["two"], undefined, "unmeasured");
    assert.match(describeSpend({ ...week, subscriptionWeek: 250 }, set), /this week by subscription: two \$60 \(24% of its week\) of 20%/);
  });
});

describe("every login a team's spend is read from", () => {
  test("each subscription's, and this Mac's own whether or not it's listed", () => {
    const own = join(process.env["HOME"] ?? "", ".claude");
    assert.deepEqual(loginDirs(two), { one: own, two: "/logins/two" });
    assert.deepEqual(loginDirs([{ name: "two", configDir: "/logins/two" }]), { two: "/logins/two", default: own });
    assert.deepEqual(loginDirs([{ name: "default", configDir: "/logins/x" }]), { default: "/logins/x", "this-mac": own });
  });
});

describe("what a team spent on each subscription", () => {
  test("each request counts for the login whose transcripts it's in; rows from before are this Mac's own", () => {
    const root = tmp("a6g-by-login-");
    const home = join(root, "app");
    const worktrees = join(root, "worktrees", "app");
    const line = (id: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: NOW.toISOString(),
        cwd: home,
        message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1_000_000 } },
      });
    const session = (login: string, name: string, ids: string[]) => {
      const dir = join(root, login, "projects", encodePath(home));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), [JSON.stringify({ type: "agent-setting", agentSetting: "a6g:builder" }), ...ids.map(line), ""].join("\n"));
    };
    session("claude-one", "a.jsonl", ["a", "b"]);
    session("claude-two", "b.jsonl", ["c"]);
    const dirs = transcriptDirsByAccount(home, worktrees, { one: join(root, "claude-one"), two: join(root, "claude-two") });
    const days = collectUsage({ run: join(root, "run"), team: "app", machine: "studio", dirs, home, worktrees, now: NOW });
    const rows = days[0]?.rows ?? [];
    assert.deepEqual(
      rows.map((r) => [r.account, r.requests, r.cost]),
      [
        ["one", 2, 8],
        ["two", 1, 4],
      ]
    );
    const { account: _counted, ...old } = rows[0] ?? rows[1]!;
    const before: UsageDay = { team: "app", day: days[0]?.day ?? "", machine: "old", rows: [old], updatedAt: NOW.toISOString() };
    assert.deepEqual(spendOf([...days, before], NOW).accounts, {
      one: { today: 8, week: 8, total: 8 },
      two: { today: 4, week: 4, total: 4 },
      default: { today: 8, week: 8, total: 8 },
    });
  });
});

describe("a role's instance on a login of its own", () => {
  test("T3 Code's homePath: set on an instance, read back by role, changed for the roles named only", () => {
    const made = instance({ displayName: "x", launchArgs: "", environment: { A6G_TEAM: "app", A6G_ROLE: "builder" }, homePath: "/logins/two" });
    assert.equal(made.config?.homePath, "/logins/two");
    assert.equal(instance({ displayName: "x", launchArgs: "", environment: {} }).config?.homePath, undefined);
    const settings: T3Settings = {
      providerInstances: {
        "a6g-app-planner": instance({ displayName: "p", launchArgs: "", environment: { A6G_TEAM: "app", A6G_ROLE: "planner" } }),
        "a6g-app-builder": made,
        mine: { driver: "claudeAgent", config: { homePath: "/mine" } },
      },
    };
    assert.deepEqual(teamInstances("app", settings), {
      planner: { id: "a6g-app-planner", homePath: null },
      builder: { id: "a6g-app-builder", homePath: "/logins/two" },
    });
    const moved = withHomes(settings, "app", { planner: "/logins/two", builder: null });
    assert.deepEqual(teamInstances("app", moved), {
      planner: { id: "a6g-app-planner", homePath: "/logins/two" },
      builder: { id: "a6g-app-builder", homePath: null },
    });
    assert.deepEqual(moved.providerInstances?.["mine"], settings.providerInstances?.["mine"], "the person's own instance is left alone");
  });
});

describe("a6g subscriptions use and limit, the guard and the watchdog", () => {
  const roles = ["planner", "builder", "reviewer"];
  async function world() {
    const { fakeWorld } = await import("./fake-t3.ts");
    const w = await fakeWorld();
    const file = join(w.a6gHome, "teams", "fixture.json");
    write(join(w.a6gHome, "teams"), {
      "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "files", database: "a6g", lead: null } },
    });
    // The team's instances as register writes them, on this Mac's own login; and a second login beside it.
    write(join(w.t3Home, "userdata"), {
      "settings.json": {
        providerInstances: Object.fromEntries(
          roles.map((role) => [
            `a6g-fixture-${role}`,
            instance({ displayName: role, launchArgs: "", environment: { A6G_TEAM: "fixture", A6G_ROLE: role } }),
          ])
        ),
      },
    });
    write(join(w.root, "home"), { ".claude.json": { oauthAccount: { accountUuid: "acct-one", planDisplayName: "Max 20x" } } });
    mkdirSync(join(w.root, "home", ".claude"), { recursive: true });
    const second = join(w.root, "claude-two");
    write(second, { ".claude.json": { oauthAccount: { accountUuid: "acct-two", planDisplayName: "Max 5x" } } });
    assert.equal((await w.a6g("subscriptions", "add", "two", "--config-dir", second)).code, 0);
    write(w.run, { "planner-thread": "mcp:planner\n" });
    const homes = (): Record<string, string | null> =>
      Object.fromEntries(
        Object.entries(teamInstances("fixture", JSON.parse(readFileSync(join(w.t3Home, "userdata", "settings.json"), "utf8"))) ?? {}).map(([r, i]) => [
          r,
          i.homePath,
        ])
      );
    const readings = (percents: Record<string, number>) =>
      write(join(w.a6gHome, "subscriptions"), {
        "state.json": {
          readings: Object.fromEntries(
            Object.entries(percents).map(([name, percent]) => [
              name,
              { account: name, at: new Date().toISOString(), percent, resetsAt: new Date(Date.now() + 86_400_000).toISOString(), scoped: [], spent: 0 },
            ])
          ),
          estimates: [],
          week: null,
        },
      });
    const steering = () => JSON.parse(readFileSync(join(w.run, "subscription.json"), "utf8"));
    // The team's builders spend $12 on this Mac's own login (3M tokens of input at $4 a million).
    const spendTwelve = () => {
      const transcripts = join(w.root, "home", ".claude", "projects", encodePath(w.home));
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(
        join(transcripts, "b.jsonl"),
        `${JSON.stringify({ type: "agent-setting", agentSetting: "a6g:builder" })}\n${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), gitBranch: "a6g/next", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 3_000_000 } } })}\n`
      );
    };
    return { w, second, homes, readings, steering, spendTwelve };
  }

  test("use: a role moves once nothing of it is at work; status and the list say where each runs", async () => {
    const { w, second, homes, steering } = await world();
    try {
      // A builder at work: the builders and the planner it reports to stay until it's done; the reviewers move now.
      w.child({ parent: "mcp:planner", id: "b1", instance: "a6g-fixture-builder", status: "running" });
      const used = await w.a6g("subscriptions", "use", "fixture", "two,default");
      assert.equal(used.code, 0, used.out);
      assert.deepEqual(homes(), { planner: null, builder: null, reviewer: second });
      assert.match(
        used.out,
        /the planner moves from default to two once it's free \(two comes before default in its list, and has room\): .*1 members running/
      );
      assert.match(used.out, /the builders move from default to two once they're free \(two comes before default in its list, and has room\): 1 at work/);
      assert.match(used.out, /moved the reviewers from default to two \(two comes before default in its list, and has room\)/);
      assert.deepEqual(steering().moving, { planner: "two", builder: "two" });
      assert.equal(existsSync(join(w.run, "planner-thread")), true);
      // Meanwhile no builder starts on the subscription it's leaving.
      const env = { A6G_HOME: w.a6gHome, T3CODE_HOME: w.t3Home, HOME: w.env["HOME"] ?? "" };
      const start = guard(
        w.home,
        "planner",
        "mcp__t3-code__delegate_task",
        { target: { providerInstanceId: "a6g-fixture-builder", model: "claude-opus-5-5" }, isolation: "worktree" },
        { run: w.run, env }
      );
      assert.deepEqual([start.outcome, /the builders move from default to two once those at work have finished/.test(start.said)], ["refuse", true]);
      // Its member done, the watchdog moves both: the old planner thread is retired, and the next run starts one on two.
      w.sql("update orchestration_v2_projection_subagents set status = 'completed'");
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.deepEqual(homes(), { planner: second, builder: second, reviewer: second });
      assert.equal(
        w.calls().some((call) => call.startsWith("t3 thread start")),
        false
      );
      assert.match(readFileSync(join(w.run, "planner-thread.retired"), "utf8"), /mcp:planner/);
      assert.match(readFileSync(join(w.run, "watchdog.log"), "utf8"), /the planner starts on its new subscription at the next run/);
      assert.match((await w.a6g("status", "fixture")).out, /subscriptions: planner on two; builder on two; reviewer on two/);
      assert.match(
        (await w.a6g("subscriptions")).out,
        /two \(.*claude-two\): not read yet\n.*signed in to Max 5x.*\n {6}runs: fixture \(planner, builder, reviewer\)/
      );
      // One role on a list of its own; --clear goes back to the team's.
      assert.equal((await w.a6g("subscriptions", "use", "fixture", "default", "--role", "reviewer")).code, 0);
      assert.equal(homes()["reviewer"], null);
      assert.notEqual((await w.a6g("subscriptions", "use", "fixture", "nowhere")).code, 0);
      assert.notEqual((await w.a6g("subscriptions", "use", "fixture", "two", "--role", "tester")).code, 0);
      // A subscription a team runs on can't be removed, nor a login added twice.
      assert.notEqual((await w.a6g("subscriptions", "remove", "two")).code, 0);
      const again = join(w.root, "claude-again");
      write(again, { ".claude.json": { oauthAccount: { accountUuid: "acct-two" } } });
      const twice = await w.a6g("subscriptions", "add", "again", "--config-dir", again);
      assert.notEqual(twice.code, 0);
      assert.match(twice.out, /same Claude account as two/);
    } finally {
      await w.close();
    }
  });

  test("limits: at one the team moves to its next subscription, and back once there's room", async () => {
    const { w, second, homes, readings } = await world();
    try {
      write(w.run, { "planner-thread": "" });
      assert.equal((await w.a6g("subscriptions", "use", "fixture", "default,two")).code, 0);
      assert.deepEqual(homes(), { planner: null, builder: null, reviewer: null });
      readings({ default: 85, two: 10 });
      const limited = await w.a6g("subscriptions", "limit", "default", "--weekly", "80%");
      assert.equal(limited.code, 0, limited.out);
      assert.deepEqual(homes(), { planner: second, builder: second, reviewer: second });
      assert.match(limited.out, /moved the builders from default to two \(default is at 85% of its week, its limit is 80%\)/);
      // Under the limit, but not by five points: it stays.
      readings({ default: 78, two: 10 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(homes()["builder"], second);
      readings({ default: 70, two: 10 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.deepEqual(homes(), { planner: null, builder: null, reviewer: null });
      assert.match(
        readFileSync(join(w.run, "watchdog.log"), "utf8"),
        /moved the builders from two to default \(default comes before two in its list, and has room\)/
      );
      const all = await w.a6g("subscriptions", "limit", "all", "--weekly", "150%");
      assert.match(all.out, /limit 150% of a week/);
      assert.notEqual((await w.a6g("subscriptions", "limit", "all", "--session", "50")).code, 0);
      assert.notEqual((await w.a6g("subscriptions", "limit", "two", "--weekly", "120")).code, 0);
    } finally {
      await w.close();
    }
  });

  test("none open: the roles wait, the guard starts none of their members, and they start again when one opens", async () => {
    const { w, readings, steering } = await world();
    try {
      write(w.run, { "planner-thread": "" });
      readings({ default: 100, two: 100 });
      assert.equal((await w.a6g("subscriptions", "use", "fixture", "default,two")).code, 0);
      assert.deepEqual(Object.keys(steering().waiting).sort(), roles.slice().sort());
      assert.match(steering().waiting.builder.why, /default has used its week; two has used its week/);
      const env = { A6G_HOME: w.a6gHome, T3CODE_HOME: w.t3Home, HOME: w.env["HOME"] ?? "" };
      const delegate = "mcp__t3-code__delegate_task";
      const started = guard(
        w.home,
        "planner",
        delegate,
        { target: { providerInstanceId: "a6g-fixture-builder", model: "claude-opus-5-5" }, isolation: "worktree" },
        { run: w.run, env }
      );
      assert.equal(started.outcome, "refuse");
      assert.match(started.said, /no builder can start now: no subscription it runs on is open \(default has used its week/);
      // A member can't reach into another subscription's login either.
      const into = guard(w.home, "builder", "Write", { file_path: join(w.root, "claude-two", "settings.json"), content: "{}" }, { run: w.run, env });
      assert.equal(into.outcome, "refuse");
      // The watchdog starts no planner for a waiting one.
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.match(
        readFileSync(join(w.run, "watchdog.log"), "utf8"),
        /no planner started \(none recorded\): it waits for a subscription, default has used its week/
      );
      assert.equal(
        w.calls().some((call) => call.startsWith("thread start")),
        false
      );
      assert.match((await w.a6g("doctor")).out, /fixture: the builders wait for a subscription/);
      // A new week on two: it opens, and they start again.
      write(join(w.a6gHome, "subscriptions"), {
        "state.json": { ...JSON.parse(readFileSync(join(w.a6gHome, "subscriptions", "state.json"), "utf8")), readings: {} },
      });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.deepEqual(steering().waiting, {});
      assert.match(readFileSync(join(w.run, "watchdog.log"), "utf8"), /the builders can start again, on default/);
      assert.equal(
        guard(
          w.home,
          "planner",
          delegate,
          { target: { providerInstanceId: "a6g-fixture-builder", model: "claude-opus-5-5" }, isolation: "worktree" },
          { run: w.run, env }
        ).outcome,
        "allow"
      );
    } finally {
      await w.close();
    }
  });

  test("register starts new roles on their first open subscription, and moves none it couldn't move itself", async () => {
    const { w, second, homes } = await world();
    try {
      write(join(w.t3Home, "userdata"), { "settings.json": {} });
      mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
      assert.equal((await w.a6g("subscriptions", "use", "fixture", "two")).code, 0);
      const first = await w.a6g("register", w.home);
      assert.equal(first.code, 0, first.out);
      assert.deepEqual(new Set(Object.values(homes())), new Set([second]));
      assert.match(first.out, /subscriptions: planner on two; builder on two/);
      // Listed on default now, with a reviewer at work: register keeps it and the planner where they are; builders move.
      w.child({ parent: "mcp:planner", id: "r1", instance: "a6g-fixture-reviewer", status: "running" });
      write(join(w.a6gHome, "subscriptions"), { "use.json": { fixture: { "*": ["default"] } } });
      const again = await w.a6g("register", w.home);
      assert.equal(again.code, 0, again.out);
      assert.deepEqual([homes()["planner"], homes()["reviewer"], homes()["builder"]], [second, second, null]);
      assert.match(again.out, /the planner moves from two to default once it's free/);
    } finally {
      await w.close();
    }
  });

  test("a6g budget --account: the team's limits on one subscription, which move it to the next", async () => {
    const { w, second, homes, spendTwelve } = await world();
    try {
      write(w.run, { "planner-thread": "" });
      assert.equal((await w.a6g("subscriptions", "use", "fixture", "default,two")).code, 0);
      const set = await w.a6g("budget", "fixture", "--account", "default", "--weekly", "10");
      assert.equal(set.code, 0, set.out);
      assert.match(set.out, /none a day, none a week, none in all since .*; on default: none a day, \$10 a week, none in all/);
      assert.match(set.out, /once the team reaches a limit on default, it moves to its next subscription/);
      assert.notEqual((await w.a6g("budget", "fixture", "--account", "default", "--weekly", "10%")).code, 0, "one unit for the budget");
      assert.notEqual((await w.a6g("budget", "fixture", "--account")).code, 0);
      spendTwelve();
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.deepEqual(JSON.parse(readFileSync(join(w.run, "spend.json"), "utf8")).accounts.default.week, 12);
      assert.equal(homes()["builder"], second);
      assert.match(
        readFileSync(join(w.run, "watchdog.log"), "utf8"),
        /moved the builders from default to two \(the team has spent \$12 of the \$10 a week budget on default\)/
      );
      // The team's own limits stay with the subscription's, and --clear with --account removes only that one's.
      assert.equal((await w.a6g("budget", "fixture", "--weekly", "300")).code, 0);
      const cleared = await w.a6g("budget", "fixture", "--account", "default", "--clear");
      assert.match(cleared.out, /none a day, \$300 a week, none in all since [\d-]+; the watchdog/);
    } finally {
      await w.close();
    }
  });
  test("a wait is news once: readings that only change its figures send nothing more", async () => {
    const { w, readings, steering } = await world();
    try {
      write(w.run, { "planner-thread": "" });
      write(join(w.a6gHome, "subscriptions"), { "limits.json": { default: { weekly: 80 }, two: { weekly: 80 } } });
      readings({ default: 85, two: 90 });
      assert.equal((await w.a6g("subscriptions", "use", "fixture", "default,two")).code, 0);
      assert.match(steering().waiting.builder.why, /default is at 85% of its week/);
      for (const [one, other] of [
        [86, 91],
        [87, 93],
      ] as const) {
        readings({ default: one, two: other });
        assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      }
      assert.doesNotMatch(readFileSync(join(w.run, "watchdog.log"), "utf8"), /wait for a subscription:/);
      // Used up rather than at the limit: that's news.
      readings({ default: 100, two: 93 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.match(readFileSync(join(w.run, "watchdog.log"), "utf8"), /the builders wait for a subscription: default has used its week; two is at 93%/);
    } finally {
      await w.close();
    }
  });

  test("a planner that waits gets no message until it can work; one moved without a thread starts at the next run", async () => {
    const { w, second, homes, readings } = await world();
    try {
      readings({ default: 100, two: 100 });
      assert.equal((await w.a6g("subscriptions", "use", "fixture", "default,two")).code, 0);
      write(w.run, { "planner-notes.json": ["the operator resumed the team"] });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(
        w.calls().some((call) => call.startsWith("t3 thread send")),
        false
      );
      assert.deepEqual(JSON.parse(readFileSync(join(w.run, "planner-notes.json"), "utf8")), ["the operator resumed the team"]);
      // two opens; default stays used up. The planner moves, with no thread to retire: the next run starts one.
      write(w.run, { "planner-thread": "" });
      readings({ default: 100 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(homes()["planner"], second);
      assert.equal(
        w.calls().some((call) => call.startsWith("t3 thread start")),
        false
      );
      assert.match(readFileSync(join(w.run, "watchdog.log"), "utf8"), /the planner starts on its new subscription at the next run/);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(
        w.calls().some((call) => call.startsWith("t3 thread start")),
        true
      );
    } finally {
      await w.close();
    }
  });

  test("a worker keeps the team's budget on each subscription, and moves its builders off one the team has spent", async () => {
    const { w, second, homes, spendTwelve } = await world();
    try {
      const file = join(w.a6gHome, "teams", "fixture.json");
      write(join(w.a6gHome, "teams"), {
        "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), worker: true, limits: { builder: 1 }, branch: "a6g/next" },
      });
      write(join(w.t3Home, "userdata"), {
        "settings.json": {
          providerInstances: {
            "a6g-fixture-builder": instance({ displayName: "builder", launchArgs: "", environment: { A6G_TEAM: "fixture", A6G_ROLE: "builder" } }),
          },
        },
      });
      assert.equal((await w.a6g("subscriptions", "use", "fixture", "default,two")).code, 0);
      // The lead (or the web app) set the team's budget on default; the worker never applies controls itself.
      await fileStore(w.run, "fixture").controls.create(
        budgetControl("fixture", "operator", {
          daily: null,
          weekly: null,
          total: null,
          since: new Date().toISOString(),
          autoResume: false,
          unit: "usd",
          accounts: { default: { daily: null, weekly: 10, total: null } },
        })
      );
      spendTwelve();
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(readLimits(w.run)?.accounts?.["default"]?.weekly, 10);
      assert.deepEqual(homes(), { builder: second });
    } finally {
      await w.close();
    }
  });
});

describe("the watchdog, status and the guard while a subscription has used up Fable's own limit", () => {
  const FABLE = "claude-fable-5-2";
  const OPUS = "claude-opus-5-5";
  const roles = ["planner", "builder", "scaffolder"];

  test("Fable roles start on Opus, a Fable planner restarts on Opus once it's free, and both go back once it resets", async () => {
    const { fakeWorld } = await import("./fake-t3.ts");
    const { baseTeam } = await import("./helpers.ts");
    const w = await fakeWorld(baseTeam({ roles: { planner: {}, builder: { limit: 2 }, scaffolder: {} } }));
    try {
      const file = join(w.a6gHome, "teams", "fixture.json");
      write(join(w.a6gHome, "teams"), {
        "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), model: FABLE, models: { planner: FABLE, builder: OPUS, scaffolder: FABLE } },
      });
      write(join(w.t3Home, "userdata"), {
        "settings.json": {
          providerInstances: Object.fromEntries(
            roles.map((role) => [
              `a6g-fixture-${role}`,
              instance({ displayName: role, launchArgs: "", environment: { A6G_TEAM: "fixture", A6G_ROLE: role } }),
            ])
          ),
        },
      });
      const resets = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const fable = (percent: number) =>
        write(join(w.a6gHome, "subscriptions"), {
          "state.json": {
            readings: {
              default: {
                account: "default",
                at: new Date().toISOString(),
                percent: 76,
                resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
                scoped: [{ model: "Fable", percent, resetsAt: resets }],
                spent: 0,
              },
            },
            estimates: [],
            week: null,
          },
        });
      // A planner thread as T3 Code's database has it, with the model it started on.
      const planner = (id: string, model: string) => {
        w.thread({ id, instance: "a6g-fixture-planner" });
        w.sql(
          `update orchestration_v2_projection_threads set payload_json = '${JSON.stringify({ modelSelection: { model } })}' where thread_id = '${id}'`
        );
      };
      const log = () => readFileSync(join(w.run, "watchdog.log"), "utf8");
      const starts = () => w.calls().filter((call) => call.startsWith("t3 thread start"));
      const until = `until ${resets.slice(0, 16).replace("T", " ")} UTC`;
      fable(100);
      write(w.run, { "planner-thread": "mcp:planner\n" });
      planner("mcp:planner", FABLE);
      // In the middle of a turn: it keeps it, and restarts once it's free.
      w.show({ status: "running", model: FABLE, updatedAt: new Date().toISOString(), pendingRequestCount: 0 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.match(log(), new RegExp(`the planner runs on Opus ${until}: default's Fable limit is used up`));
      assert.match(log(), new RegExp(`the scaffolders run on Opus ${until}: default's Fable limit is used up`));
      assert.doesNotMatch(log(), /the builders run on/);
      assert.match(log(), /the planner restarts on Opus once it's free: the planner is in the middle of a turn \(running\)/);
      assert.deepEqual(starts(), []);
      // Failed on its limit, as a planner on a used-up Fable does: retired, and the next one starts on Opus at once.
      w.show({ status: "failed", model: FABLE, updatedAt: new Date().toISOString(), pendingRequestCount: 0 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.match(log(), /retired planner mcp:planner, on claude-fable-5-2: the next one starts on Opus/);
      assert.match(readFileSync(join(w.run, "planner-thread.retired"), "utf8"), /mcp:planner/);
      assert.equal(starts().length, 1, starts().join("\n"));
      assert.match(starts()[0] ?? "", /--provider a6g-fixture-planner --model claude-opus-5-5 /);
      // What a person sees.
      planner("mcp:new-planner", OPUS);
      w.show({ status: "idle", model: OPUS, updatedAt: new Date().toISOString(), pendingRequestCount: 0 });
      const status = (await w.a6g("status", "fixture")).out;
      assert.match(status, /planner mcp:new-planner \(idle, on claude-opus-5-5\)/);
      assert.match(
        status,
        new RegExp(
          `subscriptions: planner on default, on Opus ${until}: default's Fable limit is used up; builder on default; scaffolder on default, on Opus ${until}: default's Fable limit is used up`
        )
      );
      assert.match(
        (await w.a6g("subscriptions")).out,
        /\n {6}default's Fable limit is used up: its roles on Fable run on Opus until .+; now fixture \(planner, scaffolder\)\n/
      );
      // The planner's next tick says which members start on Opus, and the guard holds it to that.
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.match(
        w.calls().find((call) => call.startsWith("t3 thread send mcp:new-planner tick")) ?? "",
        new RegExp(`start scaffolders with target\\.model "claude-opus-5-5" ${until} \\(default's Fable limit is used up\\)`)
      );
      const env = { A6G_HOME: w.a6gHome, T3CODE_HOME: w.t3Home, HOME: w.env["HOME"] ?? "" };
      const scaffolder = (model: string) =>
        guard(
          w.home,
          "planner",
          "mcp__t3-code__delegate_task",
          { target: { providerInstanceId: "a6g-fixture-scaffolder", model }, isolation: "worktree" },
          { run: w.run, env }
        );
      assert.equal(scaffolder(FABLE).outcome, "refuse");
      assert.equal(scaffolder(OPUS).outcome, "allow");
      // A new reading under 100%: Fable again, the planner once it's free.
      fable(30);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.match(log(), /the planner runs on Fable again: default's Fable limit has room again/);
      assert.match(log(), /the scaffolders run on Fable again: default's Fable limit has room again/);
      assert.match(log(), /retired planner mcp:new-planner, on claude-opus-5-5: the next one starts on Fable/);
      assert.match(starts().at(-1) ?? "", /--provider a6g-fixture-planner --model claude-fable-5-2 /);
      assert.deepEqual(JSON.parse(readFileSync(join(w.run, "subscription.json"), "utf8")).models, {});
      assert.equal(scaffolder(FABLE).outcome, "allow");
      assert.doesNotMatch((await w.a6g("status", "fixture")).out, /on Opus/);
    } finally {
      await w.close();
    }
  });
});
