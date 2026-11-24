import { tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type MachineSubscription, parseReport, USAGE_FIELDS } from "../lib/fleet.ts";
import { costOf, costParts } from "../lib/prices.ts";
import {
  type Account,
  keptLogins,
  loginOf,
  onOwn,
  parseUsageReport,
  sessionCounts,
  setAccounts,
  subscriptionsReport,
  usageBuckets,
} from "../lib/subscriptions.ts";
import { collectAccountUsage, emptyTally, encodePath, type Tally } from "../lib/usage.ts";

const close = (a: number | null | undefined, b: number) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const none = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

describe("a request's cost, part by part", () => {
  test("the parts add up to its cost; fast mode's half of them is its premium; cache reads save the input rate less theirs", () => {
    const tokens = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
    const parts = costParts("claude-opus-5-5", tokens);
    assert.ok(parts);
    close(parts.input, 4);
    close(parts.output, 20);
    close(parts.cacheRead, 0.2);
    close(parts.cacheWrite, 5 + 8);
    close(parts.fast, 0);
    close(parts.saved, 4 - 0.2);
    close(parts.input + parts.output + parts.cacheRead + parts.cacheWrite, costOf("claude-opus-5-5", tokens) ?? NaN);
    const fast = costParts("claude-opus-5-5", { ...none, output: 1e6, fast: true });
    close(fast?.output, 40);
    close(fast?.fast, 20);
    assert.equal(costParts("claude-unknown-9", { ...none, input: 1 }), null);
  });
});

describe("what a subscription used, for the Subscriptions page", () => {
  const line = (id: string, at: string, model: string, usage: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", timestamp: at, message: { id, model, usage } });

  test("by UTC hour and model: requests, tokens by kind, dollars by part; unpriced ones counted apart; each session's last hour", () => {
    const root = tmp("a6g-tallies-");
    const dir = join(root, "projects", encodePath("/Users/x/anything"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "one.jsonl"),
      [
        line("a", "2026-11-02T11:10:00Z", "claude-opus-5-5", { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }),
        line("b", "2026-11-02T11:50:00Z", "claude-opus-5-5-20261101", { output_tokens: 1_000_000, speed: "fast" }),
        line("c", "2026-11-02T12:05:00Z", "claude-new-9", { input_tokens: 10 }),
        JSON.stringify({ type: "user", timestamp: "2026-11-02T12:06:00Z", message: { content: "an assistant said" } }),
        "",
      ].join("\n")
    );
    writeFileSync(join(dir, "two.jsonl"), [line("d", "2026-11-01T09:00:00Z", "claude-opus-5-5", { input_tokens: 5 }), ""].join("\n"));
    const file = join(root, "usage.json");
    const usage = collectAccountUsage(file, [dir], new Date("2026-11-02T12:30:00Z"));
    const opus = usage.tallies["2026-11-02T11"]?.["claude-opus-5-5"];
    assert.ok(opus);
    assert.deepEqual([opus.requests, opus.input, opus.output, opus.cacheRead, opus.cacheWrite], [2, 1_000_000, 1_000_000, 1_000_000, 0]);
    close(opus.cost, 4 + 0.2 + 40);
    close(opus.costOutput, 40);
    close(opus.fast, 20);
    close(opus.saved, 3.8);
    const unknown = usage.tallies["2026-11-02T12"]?.["claude-new-9"];
    assert.deepEqual([unknown?.requests, unknown?.input, unknown?.cost, unknown?.unpriced], [1, 10, 0, 1]);
    assert.deepEqual(usage.sessions, { one: "2026-11-02T12", two: "2026-11-01T09" });
    assert.deepEqual(usage.hours, { "2026-11-02T11": 44.2, "2026-11-01T09": 0.00002 });
  });

  test("a file from before the tallies is read again from the start, so they cover what its dollars did", () => {
    const root = tmp("a6g-tallies-");
    const dir = join(root, "projects", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), [line("a", "2026-11-02T11:10:00Z", "claude-opus-5-5", { input_tokens: 1_000_000 }), ""].join("\n"));
    const file = join(root, "usage.json");
    const size = readFileSync(join(dir, "s.jsonl")).length;
    writeFileSync(file, JSON.stringify({ cursors: { [join(dir, "s.jsonl")]: { at: size, role: null, seen: ["a"] } }, hours: { "2026-11-02T11": 4 } }));
    const usage = collectAccountUsage(file, [dir], new Date("2026-11-02T12:30:00Z"));
    assert.equal(usage.tallies["2026-11-02T11"]?.["claude-opus-5-5"]?.requests, 1);
    assert.deepEqual(usage.hours, { "2026-11-02T11": 4 }, "the dollars aren't counted twice");
    // Read once more, nothing new: the same.
    assert.equal(collectAccountUsage(file, [dir], new Date("2026-11-02T12:40:00Z")).tallies["2026-11-02T11"]?.["claude-opus-5-5"]?.requests, 1);
  });

  const tally = (fields: Partial<Tally>): Tally => ({ ...emptyTally(), ...fields });

  test("by the machine's day for 90 days and by hour for 25, per model, newest first; the oldest days go first when there's no room", () => {
    const now = new Date("2026-11-15T12:30:00Z");
    const tallies = {
      "2026-11-15T12": { "claude-opus-5-5": tally({ requests: 1, cost: 0.123456 }), "bad model!": tally({ requests: 2 }) },
      "2026-11-15T11": { "claude-opus-5-5": tally({ requests: 3, input: 7 }) },
      "2026-11-14T10": { "claude-opus-5-5": tally({ requests: 4 }) },
      "2026-08-01T10": { "claude-opus-5-5": tally({ requests: 9 }) },
    };
    const { days, hours } = usageBuckets(tallies, now, 100);
    const requests = USAGE_FIELDS.indexOf("requests") + 2;
    assert.deepEqual(
      hours.map((b) => [b[0], b[1], b[requests]]),
      [
        ["2026-11-15T12", "other", 2],
        ["2026-11-15T12", "claude-opus-5-5", 1],
        ["2026-11-15T11", "claude-opus-5-5", 3],
      ]
    );
    assert.equal(hours[1]?.[USAGE_FIELDS.indexOf("cost") + 2], 0.1235, "dollars to a hundredth of a cent");
    assert.deepEqual(
      days.map((b) => [b[1], b[requests]]),
      [
        ["other", 2],
        ["claude-opus-5-5", 4],
        ["claude-opus-5-5", 4],
      ],
      "two days, whichever the machine's zone puts the hours in; 1 August is past 90 days"
    );
    const tight = usageBuckets(tallies, now, 4);
    assert.deepEqual([tight.hours.length, tight.days.length], [3, 1]);
    assert.deepEqual(usageBuckets(tallies, now, 0), { days: [], hours: [] });
  });

  test("sessions that ran in the last day, 7, 30 and 90", () => {
    const now = new Date("2026-11-15T12:30:00Z");
    assert.deepEqual(sessionCounts({ a: "2026-11-15T12", b: "2026-11-10T00", c: "2026-10-20T00", d: "2026-08-20T00" }, now), [1, 2, 3, 4]);
  });

  test("extra usage, as Claude Code's report says it", () => {
    const out = JSON.stringify({
      usage_report: {
        rate_limits: {
          limits: [{ kind: "weekly_all", percent: 10, resets_at: "2026-11-20T00:00:00Z" }],
          extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25, currency: "USD" },
        },
      },
    });
    assert.deepEqual(parseUsageReport(out)?.extra, { enabled: true, limit: 50, used: 12.5, currency: "USD" });
  });
});

describe("the login in a subscription's folder", () => {
  test("its account id, plan and address, from Claude Code's config there; none when it's signed out or says no address", () => {
    const dir = tmp("a6g-login-");
    const account = { name: "work", configDir: dir };
    const config = (oauthAccount: unknown) => writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount }));
    config({ accountUuid: "u-1", planDisplayName: "Ultra", emailAddress: "operator@example.com" });
    assert.deepEqual(loginOf(account), { login: "u-1", plan: "Ultra", email: "operator@example.com" });
    config({ accountUuid: "u-1", emailAddress: "not an address" });
    assert.deepEqual(loginOf(account), { login: "u-1", plan: null, email: null });
    config({ emailAddress: "operator@example.com" });
    assert.equal(loginOf(account), null);
  });

  test("the report sends the address beside the login's hash; none once the folder is signed in to another account than the one read", () => {
    const dir = tmp("a6g-login-");
    const state = join(process.env.A6G_HOME ?? "", "subscriptions", "state.json");
    setAccounts([{ name: "work", configDir: dir }]);
    try {
      writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-1", emailAddress: "operator@example.com" } }));
      const [sent] = subscriptionsReport({});
      assert.equal(sent?.email, "operator@example.com");
      assert.match(sent?.login ?? "", /^[a-f0-9]{16}$/);
      mkdirSync(join(state, ".."), { recursive: true });
      const reading = { account: "work", at: "2026-11-15T12:00:00.000Z", percent: 10, resetsAt: "2026-11-20T00:00:00.000Z", scoped: [], spent: 0 };
      writeFileSync(state, JSON.stringify({ readings: { work: { ...reading, login: "u-0" } }, estimates: [], week: null }));
      assert.equal(subscriptionsReport({})[0]?.email, null);
      writeFileSync(state, JSON.stringify({ readings: { work: { ...reading, login: "u-1" } }, estimates: [], week: null }));
      assert.equal(subscriptionsReport({})[0]?.email, "operator@example.com", "a reading from before the addresses: the folder's");
    } finally {
      setAccounts([]);
      rmSync(state, { force: true });
    }
  });

  test("a subscription keeps its own account: the first it's signed in to, then that account's address as it changes", () => {
    const logins: Record<string, { login: string; plan: null; email: string | null } | null> = {
      new: { login: "u-1", plan: null, email: "one@example.com" },
      own: { login: "u-2", plan: null, email: "two@example.com" },
      moved: { login: "u-9", plan: null, email: "nine@example.com" },
      out: null,
    };
    const list = [
      { name: "new", configDir: "/a" },
      { name: "own", configDir: "/b", login: "u-2", email: "old@example.com" },
      { name: "moved", configDir: "/c", login: "u-3", email: "three@example.com" },
      { name: "out", configDir: "/d", login: "u-4", email: "four@example.com" },
    ];
    assert.deepEqual(
      keptLogins(list, (a) => logins[a.name] ?? null),
      [
        { name: "new", configDir: "/a", login: "u-1", email: "one@example.com" },
        { name: "own", configDir: "/b", login: "u-2", email: "two@example.com" },
        list[2],
        list[3],
      ]
    );
    assert.equal(
      keptLogins([list[2] as Account], (a) => logins[a.name] ?? null),
      null,
      "nothing changed"
    );
    assert.deepEqual(
      list.map((a) => onOwn(a, logins[a.name] ?? null)),
      [true, true, false, false]
    );
  });

  test("the report names a subscription by its own account while its folder is signed in to another", () => {
    const dir = tmp("a6g-login-");
    setAccounts([{ name: "work", configDir: dir, login: "u-1", email: "operator@example.com" }]);
    try {
      writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-2", emailAddress: "someone@example.com" } }));
      const [sent] = subscriptionsReport({});
      assert.equal(sent?.email, "operator@example.com");
      assert.equal(sent?.login, createHash("sha256").update("a6g-login:u-1").digest("hex").slice(0, 16));
    } finally {
      setAccounts([]);
    }
  });
});

describe("a machine's subscriptions in its report", () => {
  const sub = (fields: Partial<MachineSubscription> = {}): MachineSubscription => ({
    name: "default",
    login: "0123456789abcdef",
    email: "operator@example.com",
    plan: "Ultra",
    at: "2026-11-15T12:00:00.000Z",
    weekly: { percent: 67, resetsAt: "2026-11-16T16:00:00.000Z" },
    session: null,
    models: [{ model: "Fable", percent: 40, resetsAt: null }],
    extra: { enabled: false, limit: null, used: null, currency: null },
    week: 1476.59,
    limits: { weekly: 80, session: null },
    closed: null,
    teams: [{ team: "my-app", roles: ["planner", "builder"] }],
    today: "2026-11-15",
    days: [["2026-11-15", "claude-opus-5-5", 3, 10, 20, 30, 40, 1.5, 0.1, 0.4, 0.5, 0.5, 0, 2, 0]],
    hours: [["2026-11-15T12", "claude-opus-5-5", 3, 10, 20, 30, 40, 1.5, 0.1, 0.4, 0.5, 0.5, 0, 2, 0]],
    sessions: [1, 2, 3, 4],
    counted: "2026-11-15T12:05:00.000Z",
    ...fields,
  });
  const report = (subscriptions: unknown) => parseReport({ name: "studio", factory: "0.8.5", teams: [], subscriptions });

  test("kept as sent when it's right; absent from an older version", () => {
    assert.deepEqual(report([sub()])?.subscriptions, [sub()]);
    assert.equal(parseReport({ name: "studio", factory: "0.8.2", teams: [] })?.subscriptions, undefined);
    // A version that sends no address, or one signed out: no address.
    const { email: _, ...older } = sub();
    assert.equal(report([older])?.subscriptions?.[0]?.email, null);
    assert.equal(report([sub({ login: null, email: null })])?.subscriptions?.[0]?.email, null);
  });

  test("wrong subscriptions are dropped, and the rest of the report still counts", () => {
    for (const wrong of [
      [sub({ name: "Not A Name" })],
      [sub({ login: "the-account-id@example.com" })],
      [sub({ email: "not an address" })],
      [sub({ email: "two@at@example.com" })],
      [sub({ email: "a\u202eb@example.com" })],
      [sub({ email: `${"a".repeat(250)}@example.com` })],
      [sub({ days: [["2026-11-15", "claude-opus-5-5", 3]] })],
      [sub({ hours: [["2026-11-15", "claude-opus-5-5", 3, 10, 20, 30, 40, 1.5, 0.1, 0.4, 0.5, 0.5, 0, 2, 0]] })],
      [sub({ days: [["2026-11-15", "claude-opus-5-5", -1, 10, 20, 30, 40, 1.5, 0.1, 0.4, 0.5, 0.5, 0, 2, 0]] })],
      [sub({ teams: [{ team: "My App", roles: [] }] })],
      [sub({ closed: { why: "a‮b", until: null, exhausted: false } })],
      "not a list",
    ]) {
      const parsed = report(wrong);
      assert.equal(parsed?.name, "studio", JSON.stringify(wrong).slice(0, 80));
      assert.equal(parsed?.subscriptions, undefined, JSON.stringify(wrong).slice(0, 80));
    }
  });

  test("at most so many buckets across them all", () => {
    const many = Array.from({ length: 2100 }, (_, i): [string, string, ...number[]] => [
      `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
      `m${i}`,
      ...USAGE_FIELDS.map(() => 1),
    ]);
    assert.equal(report([sub({ days: many }), sub({ name: "other", days: many })])?.subscriptions, undefined);
    assert.equal(report([sub({ days: many })])?.subscriptions?.length, 1);
  });
});
