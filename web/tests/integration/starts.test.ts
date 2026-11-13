// Running the factory from the app (docs/plans/run-from-the-site.md), over the real code and a throwaway MongoDB
// replica set of one on this machine, as machines.test.ts runs: what a machine offers to start goes with its report,
// an ask to start a team stands where its machine last said, and a team's subscriptions are chosen only from what its
// lead reports.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import type { MachineReport } from "../../../lib/fleet.ts";
import { startingControl } from "../../../lib/tasks/controls.ts";
import type { StartAsk } from "../../../lib/tasks/start.ts";
import { auth } from "../../server/auth.ts";
import { createAdmin } from "../../server/bootstrap.ts";
import { closeMongo } from "../../server/db.ts";
import { controlsOf, Refused, startFromWeb, storeFor, subscriptionsFromWeb } from "../../server/factory.ts";
import { decideLink, linkedMachines, machineByToken, recordReport, redeemLink, startLink } from "../../server/machines.ts";
import { startFor, startingMachines, startOpen, starts } from "../../server/starts.ts";

let database: MongoMemoryReplSet;
const realFetch = globalThis.fetch;
before(async () => {
  const binary = process.env.MONGOMS_SYSTEM_BINARY ?? join(homedir(), ".cache/mongodb-binaries/mongod-arm64-darwin-8.2.6");
  if (!existsSync(binary)) throw new Error(`no mongod at ${binary}: set MONGOMS_SYSTEM_BINARY to a cached mongod binary`);
  database = await MongoMemoryReplSet.create({ binary: { systemBinary: binary, version: "8.2.6" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  const uri = database.getUri();
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//, "these tests only ever run against the throwaway MongoDB on this machine");
  Object.assign(process.env, {
    MONGODB_URI: uri,
    A6G_DATABASE: "a6g",
    AUTH_DATABASE: "a6g_web",
    BETTER_AUTH_SECRET: "a-secret-for-these-tests-alone-0123456789",
    BETTER_AUTH_URL: "http://localhost:3100",
    BETTER_AUTH_TELEMETRY: "0",
    MAIL_LOG: "1",
  });
  delete process.env.RESEND_API_KEY;
  delete process.env.VERCEL_ENV;
  globalThis.fetch = (async () => {
    throw new Error("no network in these tests");
  }) as typeof fetch;
  mock.method(console, "info", () => {});
});

after(async () => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
  await closeMongo();
  await database.stop();
});

const IP = "198.51.100.20";
const projects = { dir: "~/code", repos: ["blog", "shop"], subscriptions: [{ name: "default", percent: 41 }] };

// A machine linked to a new admin's account, as a6g connect app links one: the person, its token and its id.
async function linked(name: string): Promise<{ userId: string; token: string; id: string }> {
  const { email } = await createAdmin({ email: `${name}@example.com` });
  const userId = (await (await auth().$context).internalAdapter.findUserByEmail(email))?.user.id;
  assert.ok(userId);
  const started = await startLink({ name, ip: IP, userAgent: "a6g", replacing: null });
  assert.ok(started);
  assert.equal(typeof (await decideLink({ userId, ip: IP }, started.userCode, true, null)), "object");
  const redeemed = await redeemLink(started.deviceCode, { ip: IP, userAgent: "a6g" });
  assert.ok("token" in redeemed);
  return { userId, token: redeemed.token, id: redeemed.machine.id };
}
const report = async (token: string, body: MachineReport, at = new Date()): Promise<void> => {
  const bearing = await machineByToken(token, IP, at);
  assert.ok(bearing);
  assert.ok(await recordReport(bearing, body, IP, at));
};
const ask = (machine: string, fields: Partial<StartAsk> = {}): StartAsk => ({
  machine,
  machineName: "studio",
  title: "Shop two",
  repo: { create: "shop-two" },
  goal: "A shop that takes orders.",
  technical: true,
  limits: null,
  use: ["default"],
  ...fields,
});

test("what a machine offers to start goes with each report: only its own person's, and only while it says so", async () => {
  const mine = await linked("studio");
  const theirs = await linked("attic");
  const now = new Date();
  await report(mine.token, { name: "studio", factory: "0.8.0", teams: [], projects }, now);
  await report(theirs.token, { name: "attic", factory: "0.8.0", teams: [], projects }, now);
  const machines = await linkedMachines();
  assert.deepEqual(machines.find((m) => m.id === mine.id)?.projects, projects);
  assert.deepEqual(
    startingMachines(machines, mine.userId).map((m) => m.name),
    ["studio"]
  );
  // Its operator took it back at the terminal: the next report says nothing of it, and the form has no machine.
  await report(mine.token, { name: "studio", factory: "0.8.0", teams: [] }, new Date(now.getTime() + 30_000));
  const after = await linkedMachines();
  assert.equal(after.find((m) => m.id === mine.id)?.projects, null);
  assert.deepEqual(startingMachines(after, mine.userId), []);
});

test("an ask to start a team stands where its machine last said, until the team has its own row", async () => {
  const machine = "m0123456789abcdef01234567";
  const none = new Set<string>();
  assert.deepEqual(await starts(none), []);
  const asked = await startFromWeb("shop-two", ask(machine), "s1");
  assert.deepEqual([asked.id, asked.kind, asked.by], ["k1", "start", "web:s1"]);
  await startFromWeb("site", ask(machine, { title: "Site", repo: { existing: "site" } }), "s1");

  const waiting = await starts(none);
  assert.deepEqual(waiting.map((s) => [s.team, s.step, startOpen(s)]).sort(), [
    ["shop-two", "waiting", true],
    ["site", "waiting", true],
  ]);
  const say = (team: string, progress: Parameters<typeof startingControl>[2]) => storeFor(team).controls.create(startingControl(team, "studio", progress));
  await say("shop-two", { of: "k1", step: "setup", problem: null });
  await say("site", { of: "k1", step: "failed", stoppedAt: "check", problem: "the gate failed" });
  const one = await startFor("shop-two");
  assert.deepEqual([one?.step, one?.ask.title], ["setup", "Shop two"]);
  const stopped = await startFor("site");
  assert.deepEqual([stopped?.step, stopped?.stoppedAt, stopped?.problem, stopped && startOpen(stopped)], ["failed", "check", "the gate failed", false]);

  // Started, and published: its own row takes over. Started, and not yet published: still said here.
  await say("shop-two", { of: "k1", step: "started", problem: null });
  assert.deepEqual((await starts(none)).map((s) => [s.team, s.step]).sort(), [
    ["shop-two", "started"],
    ["site", "failed"],
  ]);
  assert.deepEqual(
    (await starts(new Set(["shop-two"]))).map((s) => s.team),
    ["site"]
  );
  // Cleared from the page: a start control with nothing in it.
  await startFromWeb("site", null, "s1");
  assert.equal(await startFor("site"), null);
  assert.deepEqual(await starts(new Set(["shop-two"])), []);
  // One that ended a fortnight ago is no longer shown; one nobody picked up in a day is said to have been dropped.
  const later = Date.now() + 15 * 86_400_000;
  assert.deepEqual(await starts(none, later), []);
  await startFromWeb("late", ask(machine, { title: "Late", repo: { create: "late" } }), "s1");
  assert.equal((await startFor("late", Date.now() + 25 * 3_600_000))?.step, "expired");
  assert.equal(await startFor("Not A Team"), null);
});

test("a team's subscriptions are chosen from what its lead reports, by a team whose lead reads the choice", async () => {
  const store = storeFor("shop");
  await store.publish({
    name: "shop",
    title: "Shop",
    mode: "finish",
    approval: { mode: "operator", maxSize: "M", findings: "planner" },
    roles: ["planner", "builder"],
    branch: "main",
    factory: "0.7.0",
    publishedAt: new Date().toISOString(),
  });
  await store.report({ state: "active", planner: "running", members: {}, at: new Date().toISOString() });
  await assert.rejects(
    subscriptionsFromWeb("shop", { role: null, use: ["default"], from: "s1" }),
    (error) => error instanceof Refused && /newer factory version/.test(error.message)
  );
  await store.report({
    state: "active",
    planner: "running",
    members: {},
    at: new Date().toISOString(),
    subscriptions: {
      available: [
        { name: "default", percent: 41, resetsAt: null, closed: null },
        { name: "work", percent: 12, resetsAt: null, closed: null },
      ],
      use: { "*": ["default"] },
      roles: { planner: "default", builder: "default" },
      moving: {},
      waiting: {},
    },
  });
  const refused = (ask: { role: string | null; use: string[] }, why: RegExp) =>
    assert.rejects(subscriptionsFromWeb("shop", { ...ask, from: "s1" }), (error) => error instanceof Refused && why.test(error.message));
  await refused({ role: null, use: ["elsewhere"] }, /no subscription named elsewhere/);
  await refused({ role: "tester", use: ["work"] }, /no tester/);
  await refused({ role: null, use: ["default"] }, /Nothing changed/);
  await refused({ role: "builder", use: [] }, /no list to clear/);
  assert.deepEqual(await controlsOf("shop"), []);

  const set = await subscriptionsFromWeb("shop", { role: null, use: ["work", "work", "default"], from: "s1" });
  assert.deepEqual([set.kind, set.by, set.subscriptions], ["subscriptions", "web:s1", { role: null, use: ["work", "default"] }]);
  const own = await subscriptionsFromWeb("shop", { role: "builder", use: ["work"], from: "s1" });
  assert.deepEqual(own.subscriptions, { role: "builder", use: ["work"] });
  const cleared = await subscriptionsFromWeb("shop", { role: null, use: [], from: "s1" });
  assert.deepEqual(cleared.subscriptions, { role: null, use: [] });
  assert.equal((await controlsOf("shop")).length, 3);
});
