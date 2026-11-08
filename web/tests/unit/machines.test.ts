// Linking a machine (server/machines.ts, lib/fleet.ts): what the CLI's poll is answered, the codes a person types,
// and what a machine's report may hold. The endpoints and the page are proven end to end (tests/e2e/app.spec.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MACHINE_TOKEN, normalUserCode, parseReport, REPORT_LIMITS, shownUserCode } from "../../../lib/fleet.ts";
import { maskEmail, pollAnswer } from "../../server/machines.ts";

const now = new Date("2026-11-01T12:00:00Z");
const later = (seconds: number): Date => new Date(now.getTime() + seconds * 1000);
const waiting = { status: "pending" as const, expiresAt: later(600), polledAt: null, interval: 5 };

test("a poll waits for the person, slows a CLI that asks too often, and gets the token once approved", () => {
  assert.equal(pollAnswer(waiting, now), "authorization_pending");
  assert.equal(pollAnswer({ ...waiting, polledAt: later(-2) }, now), "slow_down");
  assert.equal(pollAnswer({ ...waiting, polledAt: later(-5) }, now), "authorization_pending");
  // After a slow_down the CLI waits five seconds more, and so must it.
  assert.equal(pollAnswer({ ...waiting, polledAt: later(-6), interval: 10 }, now), "slow_down");
  assert.equal(pollAnswer({ ...waiting, status: "approved", polledAt: later(-5) }, now), "approved");
  assert.equal(pollAnswer({ ...waiting, status: "approved", polledAt: later(-1) }, now), "slow_down");
});

test("a refused code is refused, an expired one expired whatever else it says, and an unknown one never was", () => {
  assert.equal(pollAnswer({ ...waiting, status: "refused" }, now), "access_denied");
  assert.equal(pollAnswer({ ...waiting, status: "approved", expiresAt: now }, now), "expired_token");
  assert.equal(pollAnswer({ ...waiting, status: "refused", expiresAt: later(-1) }, now), "expired_token");
  assert.equal(pollAnswer(null, now), "invalid_grant");
});

test("the terminal is told which account a machine was linked to, masked", () => {
  assert.equal(maskEmail("member@example.com"), "m•••@example.com");
  assert.equal(maskEmail("a@b.co"), "a•••@b.co");
});

test("a code is typed in either case, with or without its dash, from eight letters without vowels", () => {
  assert.equal(normalUserCode("bcdf-ghjk"), "BCDFGHJK");
  assert.equal(normalUserCode(" BCDF GHJK "), "BCDFGHJK");
  assert.equal(shownUserCode("BCDFGHJK"), "BCDF-GHJK");
  for (const wrong of ["BCDF-GHJ", "BCDF-GHJKL", "ABCD-EFGH", "BCDF-GHJ1", "", "BCDF-GHJK\u0000"]) assert.equal(normalUserCode(wrong), null, wrong);
});

test("a machine's token is the prefixed 32 random bytes the app makes, and nothing else", () => {
  assert.match(`a6gm_${"A".repeat(43)}`, MACHINE_TOKEN);
  assert.doesNotMatch(`a6gm_${"A".repeat(42)}`, MACHINE_TOKEN);
  assert.doesNotMatch(`a6gm_${"A".repeat(42)}=`, MACHINE_TOKEN);
  assert.doesNotMatch("A".repeat(48), MACHINE_TOKEN);
});

const team = {
  name: "shop",
  title: "Shop",
  part: "lead",
  store: "mongo",
  home: "/Users/morgan/code/shop-a6g",
  factory: "0.4.0",
  state: "active",
  planner: "running",
  members: { builder: 1 },
};

test("a report is rebuilt from the fields it may have, and anything else is dropped", () => {
  const report = parseReport({ name: "studio", factory: "0.4.0", teams: [{ ...team, secret: "x" }], owner: "someone@example.com", at: "then" });
  assert.deepEqual(report, { name: "studio", factory: "0.4.0", teams: [team] });
  assert.deepEqual(parseReport({ name: "studio", factory: "dev", teams: [] }), { name: "studio", factory: "dev", teams: [] });
  // A checkout in the home folder comes as ~/…, which doesn't name the machine's user.
  assert.equal(parseReport({ name: "studio", factory: "0.4.0", teams: [{ ...team, home: "~/code/shop-a6g" }] })?.teams[0]?.home, "~/code/shop-a6g");
});

test("a report with any field wrong is refused whole", () => {
  const with_ = (changes: Record<string, unknown>) => parseReport({ name: "studio", factory: "0.4.0", teams: [{ ...team, ...changes }] });
  for (const [why, changes] of Object.entries({
    "a name that isn't a team's": { name: "../shop" },
    "a title with a control character": { title: "Shop\nInjected: line" },
    "a title that turns the text around": { title: "Shop\u202Egnp.exe" },
    "a checkout with a zero-width character": { home: "/Users/morgan/sh\u200Bop" },
    "a checkout that's relative to someone else's home": { home: "~morgan/shop" },
    "a title too long": { title: "x".repeat(REPORT_LIMITS.text + 1) },
    "a part that isn't lead or worker": { part: "owner" },
    "a store that isn't one": { store: "s3" },
    "a checkout that isn't an absolute path": { home: "shop-a6g" },
    "a state that isn't one": { state: "hacked" },
    "a planner that isn't a status": { planner: "<script>" },
    "a member count that isn't a count": { members: { builder: -1 } },
    "a member count that's a fraction": { members: { builder: 1.5 } },
    "a role that isn't one": { members: { "Builder!": 1 } },
    "members that aren't an object": { members: [1] },
  }))
    assert.equal(with_(changes), null, why);
  assert.equal(parseReport({ name: "Studio", factory: "0.4.0", teams: [] }), null, "a machine name with capitals");
  assert.equal(parseReport({ name: "studio", factory: "0.4.0", teams: Array(REPORT_LIMITS.teams + 1).fill(team) }), null, "too many teams");
  assert.equal(parseReport({ name: "studio", factory: "0.4.0" }), null, "no teams");
  assert.equal(parseReport([]), null);
  assert.equal(parseReport(null), null);
});
