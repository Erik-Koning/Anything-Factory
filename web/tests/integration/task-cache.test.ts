// The tasks this server keeps of each team (server/task-cache.ts), over the real code and a throwaway MongoDB replica set
// of one on this machine, as starts.test.ts runs: read whole once, then only what changed, in the store's order; a
// change written by a machine whose clock runs behind still shows, and a task removed goes; and the factory's code
// reads through it.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { newTask, withEvent } from "../../../lib/tasks/model.ts";
import { update } from "../../../lib/tasks/store.ts";
import { closeMongo, graphDb } from "../../server/db.ts";
import { storeFor } from "../../server/factory.ts";
import { teamTasks } from "../../server/task-cache.ts";

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

test("a team's tasks are read whole once, then only what changed, and the factory's code reads through them", async () => {
  const store = storeFor("shop");
  for (const title of [
    "Checkout",
    "Pay by card",
    "Save the card",
    "Gift cards",
    "Dark mode",
    "Refunds",
    "Receipts",
    "Search",
    "Wish list",
    "Reviews",
    "Shipping",
  ])
    await store.tasks.create(newTask({ team: "shop", title, kind: "feature", status: "proposed", by: "planner" }));
  const first = await teamTasks("shop");
  assert.deepEqual(
    first.map((t) => t.id),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    "in the store's order, by number"
  );

  // A change made through the store shows on the next read.
  await update(store.tasks, "2", (t) => withEvent({ ...t, status: "approved" }, "approver", "proposed → approved", { from: "proposed", to: "approved" }));
  assert.equal((await teamTasks("shop")).find((t) => t.id === "2")?.status, "approved");

  // One a Mac wrote with its clock five minutes behind ours, after the last read, shows too.
  const graph = graphDb().collection("tasks");
  const late = new Date(Date.now() - 5 * 60_000).toISOString();
  await graph.updateOne({ _id: "shop:3" as never }, { $set: { title: "Save the card for next time", updatedAt: late } });
  assert.equal((await teamTasks("shop")).find((t) => t.id === "3")?.title, "Save the card for next time");

  // A new task, and the store's own list (what deciding or adding a task reads) is the same list.
  await store.tasks.create(newTask({ team: "shop", title: "Coupons", kind: "feature", status: "proposed", by: "planner" }));
  const both = await Promise.all([teamTasks("shop"), store.tasks.all()]);
  assert.equal(both[0].length, 12);
  assert.deepEqual(both[1], both[0]);
  // One removed from the database is gone from the next read.
  await graph.deleteOne({ _id: "shop:5" as never });
  assert.deepEqual(
    (await teamTasks("shop")).map((t) => t.id),
    ["1", "2", "3", "4", "6", "7", "8", "9", "10", "11", "12"]
  );
  // Another team's are its own.
  assert.deepEqual(await teamTasks("blog"), []);
});
