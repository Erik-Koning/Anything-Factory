// A machine's token through its weekly replacements (server/machines.ts), over the real code and a throwaway MongoDB
// replica set of one on this machine, as auth.test.ts runs: a link made the way a6g connect app makes one, then each
// report as the endpoint makes it. A token that turns up after another has taken its place ends the link, whichever
// way round: the old one after the new one was used, or a new one after the old one came back and was given another.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import type { MachineReport } from "../../../lib/fleet.ts";
import { auth } from "../../server/auth.ts";
import { createAdmin } from "../../server/bootstrap.ts";
import { authDb, closeMongo } from "../../server/db.ts";
import { decideLink, lookUpLink, machineByToken, recordReport, redeemLink, startLink } from "../../server/machines.ts";

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
const report: MachineReport = { name: "studio", factory: "0.5.0", teams: [] };
const machines = () => authDb().collection("machines");

// A machine linked to a new admin's account, as a6g connect app links one: its token.
async function linked(name: string): Promise<string> {
  const { email } = await createAdmin({ email: `${name}@example.com` });
  const userId = (await (await auth().$context).internalAdapter.findUserByEmail(email))?.user.id;
  assert.ok(userId);
  const started = await startLink({ name, ip: IP, userAgent: "a6g", replacing: null });
  assert.ok(started);
  assert.ok(await lookUpLink(userId, IP, started.userCode));
  assert.ok(await decideLink({ userId, ip: IP }, started.userCode, true, null));
  const redeemed = await redeemLink(started.deviceCode, { ip: IP, userAgent: "a6g" });
  assert.ok("token" in redeemed, JSON.stringify(redeemed));
  return redeemed.token;
}

// A report with `token`, as /api/machines/report makes it, a minute after the one before (with `due`, its token a week
// old): the new token it's answered with, null without one, or "refused".
async function reportWith(name: string, token: string, { due = false } = {}): Promise<string | null | "refused"> {
  await machines().updateOne(
    { name },
    { $set: { at: new Date(Date.now() - 60_000), ...(due ? { issuedAt: new Date(Date.now() - 8 * 86_400_000) } : {}) } }
  );
  const bearing = await machineByToken(token, IP);
  if (!bearing) return "refused";
  const kept = await recordReport(bearing, report, IP);
  assert.ok(kept, "the report is kept");
  return kept.token;
}

const unlinkedBecause = async (name: string): Promise<string> =>
  String((await authDb().collection("audit").findOne({ action: "machine.unlinked", target: name }))?.["detail"] ?? "");

test("a CLI that missed its new token gets another with the old one; the one it missed, turning up later, ends the link", async () => {
  const first = await linked("studio");
  const missed = await reportWith("studio", first, { due: true });
  assert.match(String(missed), /^a6gm_/);
  // The answer never reached the CLI: it reports with the old token again, within its grace, and gets another.
  const another = await reportWith("studio", first);
  assert.match(String(another), /^a6gm_/);
  assert.notEqual(another, missed);
  assert.equal(await reportWith("studio", String(another)), null, "the new one works");
  // The missed one was never the CLI's: someone else holds it, so the link ends.
  assert.equal(await reportWith("studio", String(missed)), "refused");
  assert.equal(await machines().countDocuments({ name: "studio" }), 0);
  assert.match(await unlinkedBecause("studio"), /two machines held this link/);
});

test("someone with a copied token who reports first takes the new one, and the real machine's turning up ends the link", async () => {
  const copied = await linked("desk");
  const real = await reportWith("desk", copied, { due: true });
  // The copy reports with the old token while the real machine hasn't used its new one yet.
  const theirs = await reportWith("desk", copied);
  assert.match(String(theirs), /^a6gm_/);
  assert.equal(await reportWith("desk", String(real)), "refused");
  assert.equal(await reportWith("desk", String(theirs)), "refused", "the copy's token ended with the link");
  assert.match(await unlinkedBecause("desk"), /two machines held this link/);
});

test("the old token used after the new one ends the link", async () => {
  const old = await linked("laptop");
  const next = await reportWith("laptop", old, { due: true });
  assert.equal(await reportWith("laptop", String(next)), null);
  assert.equal(await reportWith("laptop", old), "refused");
  assert.equal(await machines().countDocuments({ name: "laptop" }), 0);
  assert.match(await unlinkedBecause("laptop"), /a replaced token was used after its successor/);
});

test("an old token that keeps coming back while its successors go unused ends the link, and drops none of them", async () => {
  const copied = await linked("tablet");
  const real = await reportWith("tablet", copied, { due: true });
  // A copy reporting every 20 seconds with the old token can't push the real machine's new one out of the list.
  let theirs: string | null | "refused" = null;
  for (let n = 0; n < 10; n++) theirs = await reportWith("tablet", copied);
  assert.match(String(theirs), /^a6gm_/);
  assert.equal(await reportWith("tablet", copied), "refused", "the eleventh time ends it");
  assert.equal(await machines().countDocuments({ name: "tablet" }), 0);
  assert.match(await unlinkedBecause("tablet"), /came back once more/);
  assert.equal(await reportWith("tablet", String(real)), "refused");
});
