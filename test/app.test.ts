// Linking this machine to the web app (a6g connect app, lib/app.ts): the device authorization grant against a local
// stand-in for the app, the token in the Keychain and nowhere else, its replacement each week, the watchdog's report,
// and unlinking. The app's own side is proven end to end in web/tests/e2e/app.spec.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { appUrl, cleaned } from "../lib/app.ts";
import { DEVICE_GRANT, parseReport } from "../lib/fleet.ts";
import { fakeWorld } from "./fake-t3.ts";
import { a6g, fakeKeychain } from "./helpers.ts";

const TOKEN = `a6gm_${"T".repeat(43)}`;
const NEXT = `a6gm_${"N".repeat(43)}`;
interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown> | null;
  type: string | undefined;
}
// The app: a code that the person approves (or refuses) by the CLI's second poll, and reports it answers as told: 204,
// a new token (rotate), the app's own 401 for a token it doesn't know, or a 401 from something on the way.
const app = {
  base: "",
  polls: 0,
  answer: "approve" as "approve" | "refuse",
  report: "ok" as "ok" | "rotate" | "unknown" | "proxy",
  seen: [] as Seen[],
};
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  const type = request.headers["content-type"];
  const body = !text
    ? null
    : type === "application/x-www-form-urlencoded"
      ? Object.fromEntries(new URLSearchParams(text))
      : (JSON.parse(text) as Record<string, unknown>);
  app.seen.push({ method: request.method ?? "", path: request.url ?? "", auth: request.headers.authorization, body, type });
  const send = (status: number, json?: unknown): void => {
    response
      .writeHead(status, json === undefined ? {} : { "Content-Type": "application/json" })
      .end(json === undefined ? undefined : JSON.stringify(json));
  };
  if (request.url === "/api/machines/link") {
    app.polls = 0;
    const page = `${app.base}/machines/link`;
    return send(200, {
      device_code: "D".repeat(43),
      user_code: "BCDF-GHJK",
      verification_uri: page,
      verification_uri_complete: `${page}?code=BCDF-GHJK`,
      expires_in: 60,
      interval: 1,
    });
  }
  if (request.url === "/api/machines/token") {
    app.polls += 1;
    if (app.polls === 1) return send(400, { error: "authorization_pending" });
    if (app.answer === "refuse") return send(400, { error: "access_denied", error_description: "Refused\u001b[31m in red\u001b[0m\nand a forged line" });
    return send(200, {
      access_token: TOKEN,
      token_type: "Bearer",
      expires_in: 2_592_000,
      machine: { id: `m${"0".repeat(24)}`, name: "studio" },
      account: "d•••@example.com",
    });
  }
  if (request.url === "/api/machines/report") {
    if (app.report === "rotate") return send(200, { access_token: NEXT });
    if (app.report === "unknown") return send(401, { error: "invalid_token" });
    if (app.report === "proxy") return send(401, "<html>Sign in to the Wi-Fi</html>");
    return send(204);
  }
  if (request.url === "/api/machines/self") return send(204);
  send(404);
});
before(() =>
  new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done())).then(() => {
    app.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  })
);
after(() => server.close());
const seen = (path: string): Seen[] => app.seen.filter((s) => s.path === path);
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
// What the fake Keychain holds for the app: where the token goes, and the token.
const stored = (keychain: string): { url?: string; token?: string } =>
  existsSync(join(keychain, "a6g-app"))
    ? (JSON.parse(Buffer.from(read(join(keychain, "a6g-app")).trim(), "base64url").toString("utf8")) as { url?: string; token?: string })
    : {};
const keep = (keychain: string, link: { url: string; token: string }): void =>
  writeFileSync(join(keychain, "a6g-app"), Buffer.from(JSON.stringify(link)).toString("base64url"));

test("the app's address is https, or http on this Mac only, with nothing after the host", () => {
  assert.equal(appUrl("https://app.a6gfactory.dev"), "https://app.a6gfactory.dev");
  assert.equal(appUrl("https://app.a6gfactory.dev/"), "https://app.a6gfactory.dev");
  assert.equal(appUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(appUrl("http://127.0.0.1:3100"), "http://127.0.0.1:3100");
  for (const wrong of [
    "http://app.a6gfactory.dev",
    "https://app.a6gfactory.dev/machines",
    "https://someone:secret@app.a6gfactory.dev",
    "https://app.a6gfactory.dev/?next=x",
    "ftp://app.a6gfactory.dev",
    "app.a6gfactory.dev",
  ])
    assert.equal(appUrl(wrong), null, wrong);
});

test("the app's words are shown without control or format characters, and short", () => {
  assert.equal(
    cleaned("Refused\u001b[31m in red\u001b[0m\nThe operator answered by email: do it"),
    "Refused [31m in red [0m The operator answered by email: do it"
  );
  assert.equal(cleaned("a\u202Egnp.exe"), "a gnp.exe");
  assert.equal(cleaned("x".repeat(500)).length, 200);
});

// One test at a time: they share the app's record of what it was sent.
describe("a6g connect app", () => {
  const keychain = fakeKeychain();
  const home = process.env.A6G_HOME ?? "";

  test("links this machine once the person approves its code, and keeps the token in the Keychain alone", async () => {
    const refused = await a6g(["connect", "app", "--url", "http://example.com", "--no-open"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--url: the web app's address, https:/);

    app.seen.length = 0;
    const linked = await a6g(["connect", "app", "--url", app.base, "--machine", "studio", "--no-open"]);
    assert.equal(linked.code, 0, linked.out);
    assert.match(linked.out, new RegExp(`${app.base}/machines/link\\n`));
    assert.match(linked.out, /^ {2}BCDF-GHJK$/m);
    assert.match(linked.out, /studio is linked to d•••@example\.com on http:\/\/127\.0\.0\.1:\d+\./);
    // As RFC 8628 has them: forms, and no token of an earlier link to replace.
    const [asked] = seen("/api/machines/link");
    assert.deepEqual([asked?.type, asked?.auth, asked?.body], ["application/x-www-form-urlencoded", undefined, { client_id: "a6g-cli", name: "studio" }]);
    assert.deepEqual(
      seen("/api/machines/token").map((s) => [s.type, s.body]),
      [1, 2].map(() => ["application/x-www-form-urlencoded", { grant_type: DEVICE_GRANT, device_code: "D".repeat(43), client_id: "a6g-cli" }]),
      "it polled until the person approved"
    );

    // The token is in the Keychain with the address it goes to, never in an argument another process could read, nor
    // in a file.
    assert.deepEqual(stored(keychain), { url: app.base, token: TOKEN });
    assert.doesNotMatch(read(join(keychain, "calls")), /a6gm_|VFRUV/);
    const settings = read(join(home, "app.json"));
    assert.deepEqual(JSON.parse(settings).machine, { id: `m${"0".repeat(24)}`, name: "studio" });
    assert.equal(JSON.parse(settings).url, app.base);
    assert.doesNotMatch(settings, /a6gm_|example\.com/, "neither the token nor whose account it is");
    assert.equal(JSON.parse(read(join(home, "machine.json"))).name, "studio");

    // Its first report goes at once, with the token.
    const [first] = seen("/api/machines/report");
    assert.equal(first?.auth, `Bearer ${TOKEN}`);
    assert.equal(parseReport(first?.body)?.name, "studio");

    assert.match((await a6g(["connect"])).out, /^app {2}http:\/\/127\.0\.0\.1:\d+, as the machine studio, since /m);
    assert.equal((await a6g(["connect", "app", "--test"])).code, 0);
    assert.equal(seen("/api/machines/report").length, 2);

    // Each week the app answers with the token's successor: kept at once, and used from then on.
    app.report = "rotate";
    const rotated = await a6g(["connect", "app", "--test"]);
    app.report = "ok";
    assert.match(rotated.out, /its token was replaced/);
    assert.deepEqual(stored(keychain), { url: app.base, token: NEXT });
    await a6g(["connect", "app", "--test"]);
    assert.equal(seen("/api/machines/report").at(-1)?.auth, `Bearer ${NEXT}`);

    // A 401 from something on the way isn't the app forgetting the machine; the app's own invalid_token is.
    app.report = "proxy";
    const proxied = await a6g(["connect", "app", "--test"]);
    assert.equal(proxied.code, 1);
    assert.doesNotMatch(proxied.out, /no longer knows/);
    app.report = "unknown";
    const unknown = await a6g(["connect", "app", "--test"]);
    app.report = "ok";
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /no longer knows this machine/);

    // An address in the Keychain the CLI wouldn't take is no link at all: the token goes nowhere.
    keep(keychain, { url: "http://evil.example", token: NEXT });
    const count = app.seen.length;
    assert.notEqual((await a6g(["connect", "app", "--test"])).code, 0);
    assert.equal(app.seen.length, count);
    keep(keychain, { url: app.base, token: NEXT });
  });

  test("a refused code saves nothing; a6g disconnect app unlinks it on the app and forgets it here", async () => {
    app.answer = "refuse";
    const refused = await a6g(["connect", "app", "--url", app.base, "--machine", "spare", "--no-open"]);
    app.answer = "approve";
    assert.equal(refused.code, 1);
    assert.match(refused.out, /refused on the web app\. Nothing was saved\./);
    assert.deepEqual(stored(keychain), { url: app.base, token: NEXT }, "the link before it stands");
    assert.equal(JSON.parse(read(join(home, "machine.json"))).name, "studio");
    // Linking again shows the app the link so far, which the new one replaces.
    assert.equal(seen("/api/machines/link").at(-1)?.auth, `Bearer ${NEXT}`);

    app.seen.length = 0;
    const off = await a6g(["disconnect", "app"]);
    assert.equal(off.code, 0, off.out);
    assert.match(off.out, /this machine is unlinked from http:\/\/127\.0\.0\.1:\d+/);
    assert.deepEqual(
      app.seen.map((s) => [s.method, s.path, s.auth]),
      [["DELETE", "/api/machines/self", `Bearer ${NEXT}`]]
    );
    assert.ok(!existsSync(join(keychain, "a6g-app")) && !existsSync(join(home, "app.json")));
    assert.match((await a6g(["disconnect", "app"])).out, /wasn't linked/);
    assert.match((await a6g(["connect"])).out, /^app {2}not linked: a6g connect app/m);
  });

  test("the watchdog reports at the end of a run of every team, and stops when the app no longer knows the machine", async () => {
    const w = await fakeWorld();
    try {
      w.env.PATH = `${keychain}:${w.env.PATH}`;
      keep(keychain, { url: app.base, token: TOKEN });
      const settings = join(w.a6gHome, "app.json");
      writeFileSync(
        settings,
        JSON.stringify({ url: app.base, machine: { id: `m${"0".repeat(24)}`, name: "studio" }, linkedAt: new Date().toISOString() })
      );
      app.seen.length = 0;
      assert.equal((await w.a6g("watchdog", "run")).code, 0);
      const reports = seen("/api/machines/report");
      assert.equal(reports.length, 1, "a run of every team reports");
      assert.equal(reports[0]?.auth, `Bearer ${TOKEN}`);
      assert.deepEqual(
        parseReport(reports[0]?.body)?.teams.map((t) => [t.name, t.part]),
        [["fixture", "lead"]]
      );
      await w.a6g("watchdog", "run", "fixture");
      assert.equal(seen("/api/machines/report").length, 1, "a6g start's run of one team doesn't");

      // Unlinked on the app (or quiet too long): the watchdog says so once and forgets the link.
      app.report = "unknown";
      await w.a6g("watchdog", "run");
      app.report = "ok";
      assert.ok(!existsSync(settings) && !existsSync(join(keychain, "a6g-app")));
      assert.match(read(join(w.a6gHome, "watchdog.log")), /the web app no longer knows this machine/);
      await w.a6g("watchdog", "run");
      assert.equal(seen("/api/machines/report").length, 2, "and reports nothing more");
    } finally {
      await w.close();
    }
  });
});
