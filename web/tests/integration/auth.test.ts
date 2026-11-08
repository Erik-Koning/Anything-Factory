// The app's real Better Auth (server/auth.ts: its plugins, hooks, guard and emails) over its real Mongo adapter, called
// the way the route handler and the server actions call it: requests go straight to auth().handler, with no server and
// no browser. The database is a throwaway MongoDB replica set of one on this machine (mongodb-memory-server, from the
// mongod binary already cached, as the end-to-end tests use), so nothing downloads and no real database is touched.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import type { BetterAuthOptions } from "better-auth";
import { getSessionCookie } from "better-auth/cookies";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { auth, isAdminRole } from "../../server/auth.ts";
import { createAdmin, type NewAdmin } from "../../server/bootstrap.ts";
import { authDb, closeMongo } from "../../server/db.ts";
import { answerChallenge } from "../../server/known-ips.ts";
import { totpCode } from "../../server/totp.ts";
import { SoftwarePasskey } from "./authenticator.ts";

const BASE = "http://localhost:3100";
const SOMEWHERE_ELSE = "http://evil.localhost:3100";

let database: MongoMemoryReplSet;
const outward: string[] = [];
const mails: { to: string; subject: string; link: string }[] = [];
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
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_TELEMETRY: "0",
    MAIL_LOG: "1",
  });
  delete process.env.RESEND_API_KEY;
  delete process.env.VERCEL_ENV;
  // No network: anything that tries to reach out is recorded, refused and fails the last test.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    outward.push(String(input));
    throw new Error("no network in these tests");
  }) as typeof fetch;
  // Emails go to the console without Resend (MAIL_LOG), one line each, where the tests read the links.
  mock.method(console, "info", (line: unknown) => {
    const match = /^\[mail\] to=(\S+) subject="(.*)" link=(\S+)$/.exec(String(line));
    if (match) mails.push({ to: match[1] ?? "", subject: match[2] ?? "", link: match[3] ?? "" });
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
  await closeMongo();
  await database.stop();
});

interface SessionView {
  session: { id: string; token: string; secondFactor?: boolean; createdAt: string };
  user: { id: string; email: string; role?: string };
}

let browsers = 0;
// A browser, as far as Better Auth can tell: its cookies, its address, and requests from the app's own origin.
class Browser {
  readonly cookies = new Map<string, string>();
  readonly address = `198.51.100.${(browsers += 1)}`;

  async fetch(path: string, { body, origin = BASE, method }: { body?: unknown; origin?: string; method?: string } = {}): Promise<Response> {
    const headers = new Headers({ origin, "x-forwarded-for": this.address });
    if (this.cookies.size) headers.set("cookie", this.cookie());
    if (body !== undefined) headers.set("content-type", "application/json");
    const url = path.startsWith("http") ? path : `${BASE}/api/auth${path}`;
    const response = await auth().handler(
      new Request(url, { method: method ?? (body === undefined ? "GET" : "POST"), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const at = pair.indexOf("=");
      const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
      if (!value || attributes.some((a) => /^\s*max-age=0$/i.test(a))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  cookie(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  // What the app's server actions pass Better Auth: this browser's request headers.
  headers(): Headers {
    return new Headers({ cookie: this.cookie() });
  }

  async session(): Promise<SessionView | null> {
    return (await (await this.fetch("/get-session")).json()) as SessionView | null;
  }

  // Signs out on the server, and goes on sending the old cookies, as a tab open elsewhere or a stolen cookie would.
  async endSessionButKeepItsCookies(): Promise<void> {
    const held = [...this.cookies];
    assert.equal((await this.fetch("/sign-out", { body: {} })).status, 200);
    for (const [name, value] of held) this.cookies.set(name, value);
  }
}

const statusOf = async (response: Promise<Response>): Promise<number> => (await response).status;

let addresses = 0;
const anAddress = (who: string): string => `${who}.${(addresses += 1)}@example.com`;

const accountsNamed = async (email: string): Promise<number> => authDb().collection("user").countDocuments({ email });

// A person as the app's invite makes them: an account with no password, and no email until the app sends one.
async function aPerson(who = "person"): Promise<string> {
  const email = anAddress(who);
  await auth().api.createUser({ body: { email, name: "Pat Person", role: "user" } });
  return email;
}

async function signInByLink(browser: Browser, email: string): Promise<void> {
  const seen = mails.length;
  const answer = await browser.fetch("/sign-in/magic-link", { body: { email, callbackURL: "/", errorCallbackURL: "/sign-in" } });
  assert.equal(answer.status, 200);
  const mail = mails.slice(seen).find((m) => m.to === email);
  assert.ok(mail, `a link for ${email}`);
  assert.equal((await browser.fetch(mail.link)).status, 302);
}

async function aSignedInPerson(who?: string): Promise<{ browser: Browser; email: string; me: SessionView }> {
  const browser = new Browser();
  const email = await aPerson(who);
  await signInByLink(browser, email);
  const me = await browser.session();
  assert.ok(me, "signed in by the link");
  return { browser, email, me };
}

// An admin's way in: the password, then the authenticator's code, then (from an address they haven't confirmed) "yes,
// it was me" from the email, as the confirm page answers it (known-ips.ts).
async function signInAsAdmin(browser: Browser, admin: NewAdmin): Promise<void> {
  const first = await browser.fetch("/sign-in/email", { body: { email: admin.email, password: admin.password } });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { twoFactorRedirect: true, twoFactorMethods: ["totp"] });
  assert.equal(await browser.session(), null, "no session on the password alone");
  const seen = mails.length;
  assert.equal((await browser.fetch("/two-factor/verify-totp", { body: { code: totpCode(admin.totpURI) } })).status, 200);
  await confirmFromEmail(browser, admin.email, seen);
}

// "Yes, it was me" for a new session at an address its person hasn't confirmed, from the email it sent (if it sent
// one since `seen`), as the confirm page answers it: until then the session can do nothing but look at itself.
async function confirmFromEmail(browser: Browser, email: string, seen: number): Promise<void> {
  const confirm = mails.slice(seen).find((m) => m.to === email && m.subject === "Confirm it's you signing in to Anything Factory");
  if (!confirm) return;
  assert.equal(await statusOf(browser.fetch("/list-sessions")), 403, "nothing but the session itself until the address is confirmed");
  const token = new URL(confirm.link).searchParams.get("token") ?? "";
  assert.ok(await answerChallenge(token, "confirmed", { ip: browser.address, userAgent: null }), "the confirmation answers once");
}

async function anAdminSignedIn(): Promise<{ browser: Browser; admin: NewAdmin }> {
  const admin = await createAdmin({ email: anAddress("admin"), name: "Ada Admin" });
  const browser = new Browser();
  await signInAsAdmin(browser, admin);
  return { browser, admin };
}

interface PasskeyOptions {
  challenge: string;
  rp: { id: string; name: string };
}

async function addPasskey(browser: Browser, key: SoftwarePasskey, { origin = BASE, verified = true } = {}): Promise<Response> {
  const options = (await (await browser.fetch("/passkey/generate-register-options?name=Test")).json()) as PasskeyOptions;
  assert.deepEqual(options.rp, { id: "localhost", name: "Anything Factory" }, "the relying party is BETTER_AUTH_URL's host");
  const response = key.attestation({ challenge: options.challenge, rpId: options.rp.id, origin, verified });
  return browser.fetch("/passkey/verify-registration", { body: { response, name: "Test" } });
}

async function signInByPasskey(browser: Browser, key: SoftwarePasskey, { origin = BASE, verified = true } = {}): Promise<Response> {
  const options = (await (await browser.fetch("/passkey/generate-authenticate-options")).json()) as {
    challenge: string;
    rpId: string;
    userVerification: string;
  };
  assert.equal(options.rpId, "localhost");
  // "preferred": the app grades the answer itself (the UV flag), so a person whose passkey can't verify them still signs in.
  assert.equal(options.userVerification, "preferred");
  const response = key.assertion({ challenge: options.challenge, rpId: options.rpId, origin, verified });
  return browser.fetch("/passkey/verify-authentication", { body: { response } });
}

// An admin's session without its second factor: their passkey, its authenticator not having verified them.
async function anAdminWithoutSecondFactor(): Promise<{ held: Browser; admin: NewAdmin; key: SoftwarePasskey }> {
  const { browser, admin } = await anAdminSignedIn();
  const key = new SoftwarePasskey();
  assert.equal((await addPasskey(browser, key)).status, 200);
  const held = new Browser();
  assert.equal((await signInByPasskey(held, key, { verified: false })).status, 200);
  return { held, admin, key };
}

test("what the app runs is what its judgement of Better Auth's advisories rests on", () => {
  const options: BetterAuthOptions = auth().options;
  assert.deepEqual(
    options.plugins?.map((plugin) => plugin.id),
    ["admin", "two-factor", "passkey", "magic-link", "next-cookies"]
  );
  // No secondary storage or cookie cache (revoked sessions), email change, social sign-in or trusted origins with wildcards.
  assert.equal(options.secondaryStorage, undefined);
  assert.equal(options.session?.cookieCache, undefined);
  assert.equal(options.user?.changeEmail, undefined);
  assert.equal(options.socialProviders, undefined);
  assert.equal(options.trustedOrigins, undefined);
});

test("nobody signs up: not by password, and a link for a stranger makes no account and no email", async () => {
  const stranger = anAddress("stranger");
  const browser = new Browser();
  const signUp = await browser.fetch("/sign-up/email", { body: { email: stranger, password: "a-long-enough-password", name: "Stranger" } });
  assert.ok(signUp.status >= 400 && signUp.status < 500, `sign-up answered ${signUp.status}`);
  const seen = mails.length;
  assert.equal(await statusOf(browser.fetch("/sign-in/magic-link", { body: { email: stranger, callbackURL: "/" } })), 200);
  assert.equal(mails.length, seen);
  assert.equal(await accountsNamed(stranger), 0);
  assert.equal(await browser.session(), null);
});

test("a person signs in by a link, reads their session and signs out", async () => {
  const browser = new Browser();
  const email = await aPerson();
  const seen = mails.length;
  await signInByLink(browser, email);
  assert.equal(mails[seen]?.subject, "Your Anything Factory sign-in link");

  const me = await browser.session();
  assert.equal(me?.user.email, email);
  assert.equal(me?.user.role, "user");
  assert.equal(me?.session.secondFactor, false);
  // What proxy.ts looks for, and what viewer.ts reads.
  assert.ok(getSessionCookie(new Headers({ cookie: browser.cookie() })));
  assert.equal((await auth().api.getSession({ headers: browser.headers() }))?.user.email, email);

  assert.equal(await statusOf(browser.fetch("/sign-out", { body: {} })), 200);
  assert.equal(await browser.session(), null);
  assert.equal(getSessionCookie(new Headers({ cookie: browser.cookie() })), null);
  assert.equal(getSessionCookie(new Headers()), null);
});

test("a link works once, and only its digest is stored", async () => {
  const email = await aPerson();
  const first = new Browser();
  await signInByLink(first, email);
  const link = mails.findLast((m) => m.to === email)?.link ?? "";
  const token = new URL(link).searchParams.get("token") ?? "";
  assert.ok(token);
  assert.equal(await authDb().collection("verification").countDocuments({ identifier: token }), 0);

  const second = new Browser();
  await second.fetch(link);
  assert.equal(await second.session(), null);
});

// The guard reads the session before /magic-link/verify runs. Since 1.7.15 the cookies that read sets reach the response
// too (clearing an ended session's), and they mustn't undo the sign-in the link then makes.
test("a link opened in a browser still holding an ended session signs the person in", async () => {
  const { browser, email } = await aSignedInPerson();
  await browser.endSessionButKeepItsCookies();
  await authDb().collection("magic_link_sends").deleteMany({});
  await signInByLink(browser, email);
  assert.equal((await browser.session())?.user.email, email);
});

test("no link for an admin, and a link from before someone became an admin gives no session", async () => {
  const { admin } = await anAdminSignedIn();
  const browser = new Browser();
  const seen = mails.length;
  assert.equal(await statusOf(browser.fetch("/sign-in/magic-link", { body: { email: admin.email, callbackURL: "/" } })), 200);
  assert.equal(mails.length, seen, "nothing sent to an admin");

  const email = await aPerson("promoted");
  assert.equal(await statusOf(browser.fetch("/sign-in/magic-link", { body: { email, callbackURL: "/" } })), 200);
  const link = mails.findLast((m) => m.to === email)?.link ?? "";
  assert.ok(link);
  const context = await auth().$context;
  const found = await context.internalAdapter.findUserByEmail(email);
  await context.internalAdapter.updateUser(found?.user.id ?? "", { role: "admin" });
  await browser.fetch(link);
  assert.equal(await browser.session(), null);
  assert.equal(
    await authDb()
      .collection("session")
      .countDocuments({ userId: { $in: [found?.user.id] } }),
    0
  );
});

test("only the app's own call makes an invitation; the same words over HTTP are an ordinary link", async () => {
  const { browser: admin } = await anAdminSignedIn();
  const invited = anAddress("invited");
  const { user } = await auth().api.createUser({ body: { email: invited, name: "Ivy Invited", role: "user" }, headers: admin.headers() });
  assert.equal(user.email, invited);
  await auth().api.signInMagicLink({ body: { email: invited, callbackURL: "/t/shop", metadata: { team: "shop" } }, headers: admin.headers() });
  assert.equal(mails.findLast((m) => m.to === invited)?.subject, "You're invited to follow shop on Anything Factory");
  const browser = new Browser();
  await browser.fetch(mails.findLast((m) => m.to === invited)?.link ?? "");
  assert.equal((await browser.session())?.user.email, invited);

  const other = await aPerson();
  const asked = await new Browser().fetch("/sign-in/magic-link", { body: { email: other, callbackURL: "/", metadata: { team: "evil-corp" } } });
  assert.equal(asked.status, 200);
  assert.equal(mails.findLast((m) => m.to === other)?.subject, "Your Anything Factory sign-in link");
});

test("an admin signs in with the password and the authenticator's code, and the session records the second factor", async () => {
  const admin = await createAdmin({ email: anAddress("admin"), name: "Ada Admin" });
  assert.equal(admin.created, true);
  assert.equal(admin.backupCodes.length, 10);
  assert.match(admin.totpURI, /^otpauth:\/\/totp\/Anything%20Factory:/);

  const browser = new Browser();
  const wrong = await browser.fetch("/sign-in/email", { body: { email: admin.email, password: "not-the-password" } });
  assert.equal(wrong.status, 401);
  assert.equal(await browser.session(), null);

  const first = await browser.fetch("/sign-in/email", { body: { email: admin.email, password: admin.password } });
  assert.deepEqual(await first.json(), { twoFactorRedirect: true, twoFactorMethods: ["totp"] });
  const code = totpCode(admin.totpURI);
  const notTheCode = String((Number(code) + 500_000) % 1_000_000).padStart(6, "0");
  assert.equal(await statusOf(browser.fetch("/two-factor/verify-totp", { body: { code: notTheCode } })), 401);
  assert.equal(await browser.session(), null);
  assert.equal(await statusOf(browser.fetch("/two-factor/verify-totp", { body: { code } })), 200);

  const me = await browser.session();
  assert.equal(me?.session.secondFactor, true);
  assert.equal(isAdminRole(me?.user.role), true);
});

test("a backup code signs an admin in once, and new codes replace the old", async () => {
  const admin = await createAdmin({ email: anAddress("admin"), name: "Ada Admin" });
  const [code = "", other = ""] = admin.backupCodes;
  const browser = new Browser();
  await browser.fetch("/sign-in/email", { body: { email: admin.email, password: admin.password } });
  assert.equal(await statusOf(browser.fetch("/two-factor/verify-backup-code", { body: { code } })), 200);
  assert.equal((await browser.session())?.session.secondFactor, true);

  const again = new Browser();
  await again.fetch("/sign-in/email", { body: { email: admin.email, password: admin.password } });
  assert.equal(await statusOf(again.fetch("/two-factor/verify-backup-code", { body: { code } })), 401);
  assert.equal(await again.session(), null);

  // Not over HTTP (a stolen session can't replace the second factor): the account page makes them, with a current code.
  assert.equal(await statusOf(browser.fetch("/two-factor/generate-backup-codes", { body: { password: admin.password } })), 403);
  const { backupCodes } = await auth().api.generateBackupCodes({ body: { password: admin.password }, headers: browser.headers() });
  assert.equal(backupCodes.length, 10);
  const later = new Browser();
  await later.fetch("/sign-in/email", { body: { email: admin.email, password: admin.password } });
  assert.equal(await statusOf(later.fetch("/two-factor/verify-backup-code", { body: { code: other } })), 401);
  assert.equal(await statusOf(later.fetch("/two-factor/verify-backup-code", { body: { code: backupCodes[0] } })), 200);
});

test("the admin plugin's endpoints and enrolment aren't served over HTTP, even to an admin; the app's own calls still work", async () => {
  const { browser, admin } = await anAdminSignedIn();
  for (const [path, body] of [
    ["/admin/list-users", undefined],
    ["/admin/set-role", { userId: "x", role: "admin" }],
    ["/admin/create-user", { email: anAddress("made"), name: "Made", password: "a-long-enough-password" }],
    ["/two-factor/enable", { password: admin.password }],
    ["/two-factor/disable", { password: admin.password }],
  ] as const)
    assert.equal(await statusOf(browser.fetch(path, { body })), 403, path);

  const listed = await auth().api.listUsers({ query: { limit: 500, sortBy: "email", sortDirection: "asc" }, headers: browser.headers() });
  assert.ok(listed.users.some((u) => u.email === admin.email));
});

test("a verified passkey is an admin's second factor; an unverified one isn't, and that session can only sign out or in again", async () => {
  const { held, admin, key } = await anAdminWithoutSecondFactor();
  const me = await held.session();
  assert.equal(me?.user.email, admin.email);
  assert.equal(me?.session.secondFactor, false);
  for (const [path, body] of [
    ["/passkey/generate-register-options", undefined],
    ["/passkey/verify-registration", { response: {} }],
    ["/passkey/list-user-passkeys", undefined],
    ["/two-factor/generate-backup-codes", { password: admin.password }],
    ["/two-factor/get-totp-uri", { password: admin.password }],
    ["/list-sessions", undefined],
    ["/update-session", { secondFactor: true }],
    ["/update-user", { name: "Raised" }],
    ["/change-password", { currentPassword: admin.password, newPassword: "another-long-password" }],
  ] as const)
    assert.equal(await statusOf(held.fetch(path, { body })), 403, path);
  assert.equal((await held.session())?.session.secondFactor, false);
  assert.equal(await statusOf(held.fetch("/sign-out", { body: {} })), 200);
  assert.equal(await held.session(), null);

  const verified = new Browser();
  const seen = mails.length;
  assert.equal((await signInByPasskey(verified, key, { verified: true })).status, 200);
  assert.equal((await verified.session())?.session.secondFactor, true);
  await confirmFromEmail(verified, admin.email, seen);
  assert.equal(await statusOf(verified.fetch("/list-sessions")), 200);
});

// server/auth.ts grades a session by the flag in the request's bytes, relying on the plugin to have checked their signature.
test("setting the user-verified flag on a signed answer breaks its signature: no session, no second factor", async () => {
  const { browser } = await anAdminSignedIn();
  const key = new SoftwarePasskey();
  assert.equal((await addPasskey(browser, key)).status, 200);

  const thief = new Browser();
  const { challenge, rpId } = (await (await thief.fetch("/passkey/generate-authenticate-options")).json()) as { challenge: string; rpId: string };
  const answer = key.assertion({ challenge, rpId, origin: BASE, verified: false });
  const signed = answer["response"] as { authenticatorData: string };
  const bytes = Buffer.from(signed.authenticatorData, "base64url");
  bytes[32] = (bytes[32] ?? 0) | 0x04;
  signed.authenticatorData = bytes.toString("base64url");
  const refused = await thief.fetch("/passkey/verify-authentication", { body: { response: answer } });
  assert.ok(refused.status >= 400 && refused.status < 500, `answered ${refused.status}`);
  assert.equal(await thief.session(), null);
});

test("a passkey made or used on another origin under the same relying party is refused", async () => {
  const { browser, email } = await aSignedInPerson();
  const elsewhere = new SoftwarePasskey();
  assert.equal((await addPasskey(browser, elsewhere, { origin: SOMEWHERE_ELSE })).status, 400);
  assert.deepEqual(await auth().api.listPasskeys({ headers: browser.headers() }), []);

  const key = new SoftwarePasskey();
  assert.equal((await addPasskey(browser, key)).status, 200);
  const other = new Browser();
  const refused = await signInByPasskey(other, key, { origin: SOMEWHERE_ELSE });
  assert.ok(refused.status >= 400 && refused.status < 500, `answered ${refused.status}`);
  assert.equal(await other.session(), null);

  // And a request from that origin doesn't get as far as the ceremony.
  assert.equal(await statusOf(other.fetch("/passkey/verify-authentication", { origin: SOMEWHERE_ELSE, body: { response: {} } })), 403);
  assert.equal(await other.session(), null);

  // The app's own origin (BETTER_AUTH_URL, the passkey plugin's `origin`) still works.
  const here = new Browser();
  assert.equal((await signInByPasskey(here, key)).status, 200);
  assert.equal((await here.session())?.user.email, email);
});

test("anyone else's passkey signs them in with or without verification; they list and remove it", async () => {
  const { browser, email } = await aSignedInPerson();
  const key = new SoftwarePasskey();
  assert.equal((await addPasskey(browser, key, { verified: false })).status, 200);

  const [listed] = await auth().api.listPasskeys({ headers: browser.headers() });
  assert.equal(listed?.name, "Test");
  assert.equal(((await (await browser.fetch("/passkey/list-user-passkeys")).json()) as unknown[]).length, 1);

  const unverified = new Browser();
  assert.equal((await signInByPasskey(unverified, key, { verified: false })).status, 200);
  assert.equal((await unverified.session())?.user.email, email);
  assert.equal((await unverified.session())?.session.secondFactor, false);

  assert.equal(await statusOf(browser.fetch("/passkey/delete-passkey", { body: { id: listed?.id } })), 200);
  assert.deepEqual(await auth().api.listPasskeys({ headers: browser.headers() }), []);
  const after = new Browser();
  const refused = await signInByPasskey(after, key);
  assert.ok(refused.status >= 400 && refused.status < 500, `answered ${refused.status}`);
  assert.equal(await after.session(), null);
});

test("a session that has ended can't add a passkey", async () => {
  const { browser } = await aSignedInPerson();
  const options = (await (await browser.fetch("/passkey/generate-register-options?name=Test")).json()) as PasskeyOptions;
  const key = new SoftwarePasskey();
  const response = key.attestation({ challenge: options.challenge, rpId: options.rp.id, origin: BASE, verified: true });

  // The session ends between the options and the answer (a revoked or stolen session can't leave a credential behind).
  await browser.endSessionButKeepItsCookies();
  assert.equal(await statusOf(browser.fetch("/passkey/verify-registration", { body: { response, name: "Test" } })), 401);
  assert.equal(await statusOf(browser.fetch("/passkey/generate-register-options")), 401);
  assert.equal(await authDb().collection("passkey").countDocuments({ credentialID: key.id }), 0);
});

test("a new passkey for an admin needs a sign-in from the last ten minutes", async () => {
  const { browser } = await anAdminSignedIn();
  const me = await browser.session();
  assert.ok(me);
  const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000);
  assert.equal(
    (
      await authDb()
        .collection("session")
        .updateOne({ token: me.session.token }, { $set: { createdAt: elevenMinutesAgo } })
    ).modifiedCount,
    1
  );
  const answer = await browser.fetch("/passkey/generate-register-options");
  assert.equal(answer.status, 403);
  assert.match(((await answer.json()) as { message: string }).message, /within ten minutes/);
});

test("the client can't give a session its second factor", async () => {
  const { browser } = await aSignedInPerson();
  const answer = await browser.fetch("/update-session", { body: { secondFactor: true } });
  assert.ok(answer.status >= 400 && answer.status < 500, `answered ${answer.status}`);
  assert.equal((await browser.session())?.session.secondFactor, false);
});

test("a person sees their sessions and ends them, one or all the others, at once", async () => {
  const email = await aPerson();
  const [here, phone, tablet] = [new Browser(), new Browser(), new Browser()];
  for (const browser of [here, phone, tablet]) {
    await authDb().collection("magic_link_sends").deleteMany({});
    await signInByLink(browser, email);
  }
  const sessions = await auth().api.listSessions({ headers: here.headers() });
  assert.equal(sessions.length, 3);

  const phoneSession = await phone.session();
  const target = sessions.find((s) => s.id === phoneSession?.session.id);
  assert.ok(target);
  assert.deepEqual(await auth().api.revokeSession({ body: { token: target.token }, headers: here.headers() }), { status: true });
  assert.equal(await phone.session(), null);
  assert.ok(await tablet.session());

  assert.deepEqual(await auth().api.revokeOtherSessions({ headers: here.headers() }), { status: true });
  assert.equal(await tablet.session(), null);
  assert.equal((await here.session())?.user.email, email);
});

test("a ban ends a person's sessions and keeps them out, and an unban lets them back", async () => {
  const { browser: admin } = await anAdminSignedIn();
  const { browser, email, me } = await aSignedInPerson();
  await auth().api.banUser({ body: { userId: me.user.id, banReason: "removed by an admin" }, headers: admin.headers() });
  assert.equal(await browser.session(), null);

  await authDb().collection("magic_link_sends").deleteMany({});
  const seen = mails.length;
  assert.equal(await statusOf(browser.fetch("/sign-in/magic-link", { body: { email, callbackURL: "/" } })), 200);
  assert.equal(mails.length, seen, "no link for a banned person");

  await auth().api.unbanUser({ body: { userId: me.user.id }, headers: admin.headers() });
  await signInByLink(browser, email);
  assert.equal((await browser.session())?.user.email, email);
});

test("create-admin run again starts the admin afresh, and makes an existing person an admin", async () => {
  const { browser, admin } = await anAdminSignedIn();
  const key = new SoftwarePasskey();
  assert.equal((await addPasskey(browser, key)).status, 200);

  const fresh = await createAdmin({ email: admin.email });
  assert.equal(fresh.created, false);
  assert.notEqual(fresh.password, admin.password);
  assert.equal(await browser.session(), null, "every earlier session ended");
  assert.equal(await statusOf(new Browser().fetch("/sign-in/email", { body: { email: admin.email, password: admin.password } })), 401);
  const noPasskey = new Browser();
  const refused = await signInByPasskey(noPasskey, key);
  assert.ok(refused.status >= 400 && refused.status < 500, `answered ${refused.status}`);
  assert.equal(await noPasskey.session(), null);
  const noOldCode = new Browser();
  await noOldCode.fetch("/sign-in/email", { body: { email: fresh.email, password: fresh.password } });
  assert.equal(await statusOf(noOldCode.fetch("/two-factor/verify-backup-code", { body: { code: admin.backupCodes[0] } })), 401);
  const back = new Browser();
  await signInAsAdmin(back, fresh);
  assert.equal((await back.session())?.session.secondFactor, true);

  const { browser: wasPerson, email } = await aSignedInPerson();
  const promoted = await createAdmin({ email });
  assert.equal(promoted.created, false);
  assert.equal(await wasPerson.session(), null);
  const nowAdmin = new Browser();
  await signInAsAdmin(nowAdmin, promoted);
  assert.equal(isAdminRole((await nowAdmin.session())?.user.role), true);
});

test("nothing in these tests reached for the network", () => {
  assert.deepEqual(outward, []);
});
