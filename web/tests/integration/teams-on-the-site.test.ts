// Every team where it belongs on the app (docs/plans/teams-on-the-site.md), over the real code and a throwaway MongoDB
// replica set of one on this machine, as starts.test.ts runs: an admin takes a team no Mac runs off the site and puts
// it back; the lists leave it out meanwhile, and its name stays taken.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { retireControl } from "../../../lib/tasks/controls.ts";
import { closeMongo } from "../../server/db.ts";
import { allTeams, Refused, restoreFromWeb, retirements, retireFromWeb, storeFor, teamDoc } from "../../server/factory.ts";

let database: MongoMemoryReplSet;
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
  mock.method(console, "info", () => {});
});

after(async () => {
  mock.restoreAll();
  await closeMongo();
  await database.stop();
});

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();
async function publish(name: string, { reported }: { reported: string | null }): Promise<void> {
  const store = storeFor(name);
  await store.publish({
    name,
    title: name[0]?.toUpperCase() + name.slice(1),
    mode: "finish",
    approval: { mode: "operator", maxSize: "M", findings: "planner" },
    roles: ["planner", "builder"],
    branch: "main",
    factory: "0.8.1",
    publishedAt: minutesAgo(600),
  });
  if (reported) await store.report({ state: "paused", planner: null, members: {}, at: reported });
}

test("a team no Mac runs comes off the site with a note, and goes back on; the lists leave it out meanwhile", async () => {
  await publish("trial", { reported: minutesAgo(180) });
  await publish("shop", { reported: minutesAgo(3) });
  assert.deepEqual(
    (await allTeams()).map((t) => t.name),
    ["shop", "trial"]
  );

  const off = await retireFromWeb("trial", { note: "a trial", from: "s1" });
  assert.deepEqual([off.kind, off.by, off.note], ["retire", "web:s1", "a trial"]);
  assert.deepEqual(
    (await allTeams()).map((t) => t.name),
    ["shop"]
  );
  assert.deepEqual(
    (await allTeams({ retired: true })).map((t) => t.name),
    ["shop", "trial"],
    "its name stays taken"
  );
  assert.deepEqual([...(await retirements()).keys()], ["trial"]);
  assert.ok(await teamDoc("trial"), "its settings stay, for its pages");
  await assert.rejects(retireFromWeb("trial", { note: "", from: "s1" }), (e) => e instanceof Refused && /off the site already/.test(e.message));

  const back = await restoreFromWeb("trial", { from: "s1" });
  assert.equal(back.kind, "restore");
  assert.deepEqual(
    (await allTeams()).map((t) => t.name),
    ["shop", "trial"]
  );
  await assert.rejects(restoreFromWeb("trial", { from: "s1" }), (e) => e instanceof Refused && /on the site already/.test(e.message));
});

test("a team a Mac runs, or one just published, isn't taken off from the site: its Mac unregisters it", async () => {
  await publish("busy", { reported: minutesAgo(2) });
  await assert.rejects(
    retireFromWeb("busy", { note: "", from: "s1" }),
    (e) => e instanceof Refused && /A Mac runs Busy: it reported 2 min ago\. Unregister it on that Mac \(a6g unregister busy\)/.test(e.message)
  );
  const store = storeFor("fresh");
  await store.publish({
    name: "fresh",
    title: "Fresh",
    mode: "finish",
    approval: { mode: "operator", maxSize: "M", findings: "planner" },
    roles: ["planner"],
    branch: "main",
    factory: "0.8.1",
    publishedAt: minutesAgo(1),
  });
  await assert.rejects(
    retireFromWeb("fresh", { note: "", from: "s1" }),
    (e) => e instanceof Refused && /published less than 15 minutes ago/.test(e.message)
  );
  await assert.rejects(retireFromWeb("ghost", { note: "", from: "s1" }), (e) => e instanceof Refused && /No such team/.test(e.message));
  assert.equal((await retirements()).has("busy"), false);
});

test("the newest of a team's retires and restores decides, whoever recorded it (a6g unregister and register too)", async () => {
  await publish("moved", { reported: minutesAgo(90) });
  const store = storeFor("moved");
  await store.controls.create(retireControl("moved", "operator", "unregistered on studio"));
  assert.equal((await retirements()).get("moved")?.note, "unregistered on studio");
  await restoreFromWeb("moved", { from: "s1" });
  assert.equal((await retirements()).has("moved"), false);
  await store.controls.create(retireControl("moved", "operator", "unregistered again"));
  assert.equal((await retirements()).get("moved")?.note, "unregistered again");
});

test("a team taken off comes back once its lead reports after that: a Mac woke, or the lead moved", async () => {
  await publish("sleepy", { reported: minutesAgo(120) });
  await retireFromWeb("sleepy", { note: "", from: "s1" });
  assert.equal(
    (await allTeams()).some((t) => t.name === "sleepy"),
    false
  );
  await storeFor("sleepy").report({ state: "active", planner: "running", members: {}, at: new Date().toISOString() });
  assert.equal(
    (await allTeams()).some((t) => t.name === "sleepy"),
    true,
    "on Teams again"
  );
  await assert.rejects(restoreFromWeb("sleepy", { from: "s1" }), (e) => e instanceof Refused && /on the site already/.test(e.message));
});

test("past ten controls, the newest still decides (k10 comes after k9)", async () => {
  await publish("long", { reported: minutesAgo(120) });
  const store = storeFor("long");
  for (let i = 0; i < 8; i++) await store.controls.create(retireControl("long", "operator", `k${i + 1}`));
  await store.controls.create(retireControl("long", "operator", "k9"));
  await restoreFromWeb("long", { from: "s1" });
  assert.deepEqual((await store.controls.all()).map((c) => c.id).slice(-2), ["k9", "k10"]);
  assert.equal((await retirements()).has("long"), false);
});
