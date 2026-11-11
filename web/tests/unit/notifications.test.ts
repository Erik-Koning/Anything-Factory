// What's news on a team (server/events.ts), and how it's emailed (server/notifications.ts): who hears of what by
// default, the digest's hour in a person's time zone, and the emails' words and links.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionRecord } from "../../../lib/tasks/decisions.ts";
import { type FeatureRequest, MERGE, newTask, OPERATOR, type Status, type Task, withEvent } from "../../../lib/tasks/model.ts";
import { AUDIENCE, EVENT_KINDS, eventsOf, stateEvent, type TeamEvent } from "../../server/events.ts";
import {
  digestMail,
  digestMoment,
  KIND_TEXT,
  modeFor,
  nextDigest,
  nowMail,
  type Prefs,
  prefsOr,
  summaryOf,
  testMail,
  widestRole,
} from "../../server/notifications.ts";

let next = 1;
const task = (status: Status, fields: Partial<Task> = {}): Task => ({
  ...newTask({ team: "shop", title: `task ${next}`, kind: "feature", status, by: "planner", ...fields }),
  id: String(next++),
  version: 1,
});
const move = (t: Task, to: Status, by: string, why = ""): Task =>
  withEvent({ ...t, status: to }, by, `${t.status} → ${to}${why ? `: ${why}` : ""}`, { from: t.status, to });

test("eventsOf: questions, blocks, merges and journeys done, since a time, not the operator's own moves", () => {
  const asked = move(
    task("proposed", { title: "Open the staff pages?", body: "Options: (a) no; (b) yes." }),
    "question",
    "planner",
    "it's the operator's"
  );
  const escalated = move(task("proposed"), "question", OPERATOR, "mine to think about");
  const stuck = move(task("building", { title: "Pay by card" }), "blocked", "planner", "needs the payment key");
  const merged = move(task("review", { title: "Export CSV" }), "done", MERGE, "merged a6g/b3");
  const journey = move(task("approved", { kind: "journey", title: "Checkout" }), "done", "planner", "verified");
  const events = eventsOf("shop", [asked, escalated, stuck, merged, journey], [], "2000-01-01T00:00:00.000Z");
  // Oldest first (by id within the same moment): compare them by kind.
  assert.deepEqual(
    events.map((e) => [e.kind, e.title]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    [
      ["blocked", `#${stuck.id} Pay by card`],
      ["journey", "Journey done: Checkout"],
      ["merged", `#${merged.id} Export CSV`],
      ["question", `#${asked.id} Open the staff pages?`],
    ]
  );
  assert.deepEqual(
    events.map((e) => e.at),
    events.map((e) => e.at).sort()
  );
  const question = events.find((e) => e.kind === "question");
  assert.equal(question?.path, `/t/shop/inbox#task-${asked.id}`);
  assert.match(question?.detail ?? "", /^Why it's yours: it's the operator's Options: \(a\) no; \(b\) yes\.$/);
  assert.equal(events.find((e) => e.kind === "blocked")?.detail, "needs the payment key");
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  assert.deepEqual(eventsOf("shop", [asked], [], "2999-01-01T00:00:00.000Z"), []);
  // Read again, the same events have the same ids: the queue keeps each once.
  assert.deepEqual(
    eventsOf("shop", [asked, stuck], [], "2000-01-01T00:00:00.000Z").map((e) => e.id),
    events.filter((e) => e.kind === "question" || e.kind === "blocked").map((e) => e.id)
  );
});

test("eventsOf: a block raised to the operator, or an ask added later, is a question for them, with the recommendation", () => {
  const raised = {
    ...move(task("approved", { title: "Ship to Canada" }), "blocked", "planner", "needs the carrier's key"),
    ask: { reason: "only you hold the carrier's key", recommendation: "add it to the vault", by: "planner", at: "2026-11-01T00:00:00.000Z" },
  };
  const later = {
    ...withEvent(move(task("proposed", { title: "Open the log" }), "question", "planner", "yours"), "planner", "raised to the operator: who reads it"),
    ask: { reason: "who reads it", recommendation: "own staff only", by: "planner", at: "2026-11-01T00:00:00.000Z" },
  };
  const events = eventsOf("shop", [raised, later], [], "2000-01-01T00:00:00.000Z");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["question", "question", "question"]
  );
  assert.match(
    events.find((e) => e.title.includes("Ship"))?.detail ?? "",
    /^Why it's yours: only you hold the carrier's key The team recommends: add it to the vault/
  );
});

test("eventsOf: a request taken up or turned down goes to its sender", () => {
  const request: FeatureRequest = {
    id: "r1",
    version: 1,
    team: "shop",
    title: "A fax integration",
    body: "",
    from: "s1",
    status: "rejected",
    tasks: [],
    notes: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    history: [{ at: "2026-10-02T00:00:00.000Z", by: "planner", what: "new → rejected: fax is going away", from: "new", to: "rejected" }],
  };
  const [event] = eventsOf("shop", [], [request], "2026-10-01T00:00:00.000Z");
  assert.deepEqual(
    [event?.kind, event?.to, event?.title, event?.detail, event?.path],
    ["request", "s1", 'Your request "A fax integration" was turned down', "fax is going away", "/t/shop/requests/r1"]
  );
});

test("stateEvent: news only when the team pauses or finishes, never the first time it's seen", () => {
  const paused = { state: "paused" as const, planner: null, members: {}, at: "2026-11-01T20:00:00.000Z" };
  assert.equal(stateEvent("shop", "Shop", paused, null), null);
  assert.equal(stateEvent("shop", "Shop", paused, "paused"), null);
  assert.equal(stateEvent("shop", "Shop", { ...paused, state: "active" }, "paused"), null);
  assert.equal(stateEvent("shop", "Shop", paused, "active")?.title, "Shop paused");
  assert.equal(stateEvent("shop", "Shop", { ...paused, state: "complete" }, "active")?.title, "Shop reached its finish line");
});

test("defaults by role, until the person saves their own", () => {
  assert.equal(modeFor(null, "question", "admin"), "now");
  assert.equal(modeFor(null, "blocked", "member"), "digest");
  assert.equal(modeFor(null, "merged", "contributor"), "off");
  const mine = { ...prefsOr(null, "u1", "admin", "UTC"), modes: { ...prefsOr(null, "u1", "admin", "UTC").modes, question: "digest" as const } };
  assert.equal(modeFor(mine, "question", "admin"), "digest");
  assert.equal(prefsOr(null, "u1", "admin", "America/Toronto").reminder, true);
  assert.equal(prefsOr(null, "u1", "contributor", "UTC").reminder, false);
  assert.equal(widestRole({ admin: false, teams: { a: "contributor", b: "member" } }), "member");
  assert.equal(widestRole({ admin: true, teams: {} }), "admin");
});

test("the digest's hour is the person's own, in their time zone", () => {
  // 13:30 UTC on 2 November is 08:30 in Toronto (EST): today's 08:00 there was 13:00 UTC.
  const now = new Date("2026-11-02T13:30:00.000Z");
  assert.equal(digestMoment(now, "America/Toronto", 8).toISOString(), "2026-11-02T13:00:00.000Z");
  assert.equal(digestMoment(now, "UTC", 8).toISOString(), "2026-11-02T08:00:00.000Z");
  // In Tokyo it's 22:30 on 2 November: its 08:00 that day was 23:00 UTC the day before.
  assert.equal(digestMoment(now, "Asia/Tokyo", 8).toISOString(), "2026-11-01T23:00:00.000Z");
  assert.equal(nextDigest(now, "America/Toronto", 8).toISOString(), "2026-11-03T13:00:00.000Z");
  assert.equal(nextDigest(now, "America/Toronto", 9).toISOString(), "2026-11-02T14:00:00.000Z");
});

const event = (fields: Partial<TeamEvent>): TeamEvent => ({
  id: "question:39:1",
  kind: "question",
  team: "shop",
  at: "2026-11-01T23:12:00.000Z",
  title: "#39 Q: the consent words",
  detail: "consent wording is the operator's",
  path: "/t/shop/inbox#task-39",
  ...fields,
});
const titles = new Map([
  ["shop", "Shop"],
  ["blog", "Blog"],
]);
const BASE = "https://a6g.example.com";

test("nowMail: one event as its own email, with the link to answer it; several together", () => {
  const one = nowMail([event({})], titles, BASE);
  assert.equal(one.subject, "[Shop] Question for you: #39 Q: the consent words");
  assert.equal(one.link, `${BASE}/t/shop/inbox#task-39`);
  assert.match(one.text, /Answer it: https:\/\/a6g\.example\.com\/t\/shop\/inbox#task-39/);
  assert.match(one.text, /notification settings: https:\/\/a6g\.example\.com\/account\/notifications$/);
  const two = nowMail([event({}), event({ id: "question:40:1", title: "#40 Q: open the staff pages?", path: "/t/shop/inbox#task-40" })], titles, BASE);
  assert.equal(two.subject, "[Shop] 2 questions for you");
  assert.equal(two.link, `${BASE}/inbox`);
  assert.match(two.text, /- Question for you: #40 Q: open the staff pages\?\n {2}https:\/\/a6g\.example\.com\/t\/shop\/inbox#task-40/);
  const mixed = nowMail([event({}), event({ id: "blocked:7:1", kind: "blocked", team: "blog", title: "#7 Post", path: "/t/blog/tasks/7" })], titles, BASE);
  assert.equal(mixed.subject, "[Shop, Blog] 2 updates");
  assert.match(mixed.text, /Shop:\n- Question for you/);
  assert.match(mixed.text, /Blog:\n- Blocked: #7 Post/);
});

test("digestMail: what still waits, then what happened; summaryOf and testMail say the settings in words", () => {
  const mail = digestMail(
    [event({ id: "merged:3:1", kind: "merged", title: "#3 Export", path: "/t/shop/tasks/3" })],
    [{ team: "shop", items: [{ id: "39", title: "Q: the consent words", status: "question", since: "2026-11-01T23:12:00.000Z" }] }],
    titles,
    BASE,
    "Monday, November 2"
  );
  assert.equal(mail.subject, "[Anything Factory] 1 waiting on you, 1 update");
  assert.match(mail.text, /^Your Anything Factory digest for Monday, November 2\./);
  assert.match(mail.text, /Waiting on you:\n- #39 Q: the consent words \(a question, since 2026-11-01\)\nAnswer them: https:\/\/a6g\.example\.com\/inbox/);
  assert.match(mail.text, /Since your last digest:\n- Merged: #3 Export/);
  const prefs = prefsOr(null, "u1", "admin", "America/Toronto");
  const lines = summaryOf(prefs, ["question", "blocked", "merged"], "08:00");
  assert.deepEqual(lines, ["- At once: questions for you.", "- Daily at 08:00 (America/Toronto): blocked work, work merged, what still waits on you."]);
  assert.match(testMail("Olive", lines, BASE).text, /^Hello Olive, this is the test email you asked for\./);
});

const decision = (fields: Partial<DecisionRecord>): DecisionRecord => ({
  id: "d1",
  version: 1,
  team: "shop",
  question: "Do guests check out without an account?",
  options: [],
  decision: "Yes, and they're offered an account after they pay",
  because: "the direction puts a first order ahead of a sign-up",
  topic: "product",
  stakes: "high",
  confidence: "medium",
  route: "tell",
  rule: "balanced: high stakes with medium confidence is decided and flagged",
  agreement: null,
  undo: "revert the guest checkout's merge",
  tasks: [],
  by: "planner",
  at: "2026-11-01T10:00:00.000Z",
  review: null,
  notes: [],
  updatedAt: "2026-11-01T10:00:00.000Z",
  history: [],
  ...fields,
});

test("eventsOf: a call the team made for the operator and flagged is news once, for those who review; one it only recorded isn't", () => {
  const flagged = decision({});
  const recorded = decision({ id: "d2", route: "decide", question: "What does the empty cart say?" });
  const old = decision({ id: "d3", at: "2026-10-01T10:00:00.000Z" });
  const events = eventsOf("shop", [], [], "2026-10-15T00:00:00.000Z", [flagged, recorded, old]);
  assert.deepEqual(events, [
    {
      id: `decided:d1:${Date.parse(flagged.at)}`,
      kind: "decided",
      team: "shop",
      at: flagged.at,
      title: "Do guests check out without an account?",
      detail:
        "The team decided: Yes, and they're offered an account after they pay\n\nBecause: the direction puts a first order ahead of a sign-up\n\nTo undo it: revert the guest checkout's merge",
      path: "/t/shop/decided#d1",
    },
  ]);
  // Without a way back said, the email says what it has; with no decisions given, there are none.
  assert.doesNotMatch(eventsOf("shop", [], [], "2000-01-01T00:00:00.000Z", [decision({ undo: "" })])[0]?.detail ?? "", /To undo it/);
  assert.deepEqual(eventsOf("shop", [], [], "2000-01-01T00:00:00.000Z"), []);
  assert.equal(AUDIENCE.decided, "proposals:decide");
  assert.deepEqual([...EVENT_KINDS], ["question", "decided", "blocked", "journey", "team", "merged", "request"]);
});

test("a flagged call goes in an admin's digest by default and to nobody else; choices saved before the kind existed fall back to the role's", () => {
  assert.equal(modeFor(null, "decided", "admin"), "digest");
  assert.equal(modeFor(null, "decided", "member"), "off");
  assert.equal(modeFor(null, "decided", "contributor"), "off");
  assert.equal(KIND_TEXT.decided.label, "Decided for you");
  // Saved when there were six kinds: the seventh has the role's default, on the settings page and in the notifier.
  const { decided: _decided, ...six } = prefsOr(null, "u1", "admin", "UTC").modes;
  const saved = { ...prefsOr(null, "u1", "admin", "UTC"), modes: { ...six, question: "digest" } as Prefs["modes"], updatedAt: new Date() };
  assert.equal(saved.modes.decided, undefined);
  assert.equal(modeFor(saved, "decided", "admin"), "digest");
  assert.equal(modeFor(saved, "decided", "member"), "off");
  const shown = prefsOr(saved, "u1", "admin", "UTC");
  assert.deepEqual([shown.modes.decided, shown.modes.question, shown.digestHour], ["digest", "digest", 8]);
  // Once they choose, it's theirs.
  assert.equal(modeFor({ ...saved, modes: { ...saved.modes, decided: "now" } }, "decided", "admin"), "now");
});

test("nowMail and digestMail: a flagged call says how to settle it, and the digest counts what's still to review", () => {
  const call = event({
    id: "decided:d1:1",
    kind: "decided",
    title: "Do guests check out without an account?",
    detail: "The team decided: Yes\n\nBecause: the direction",
    path: "/t/shop/decided#d1",
  });
  const one = nowMail([call], titles, BASE);
  assert.equal(one.subject, "[Shop] Decided for you: Do guests check out without an account?");
  assert.equal(one.link, `${BASE}/t/shop/decided#d1`);
  assert.match(
    one.text,
    /The team decided: Yes\n\nBecause: the direction\n\nAgree with it, or overturn it: https:\/\/a6g\.example\.com\/t\/shop\/decided#d1/
  );
  // With a question, the email is still about what to answer.
  assert.equal(nowMail([event({}), call], titles, BASE).subject, "[Shop] 2 updates");
  const digest = digestMail([call], [], titles, BASE, "Monday, November 2", [
    { team: "shop", count: 2 },
    { team: "blog", count: 1 },
  ]);
  assert.equal(digest.subject, "[Anything Factory] 3 to review, 1 update");
  assert.match(
    digest.text,
    /Decided for you, and not reviewed yet:\n- Shop: 2 calls the team flagged\n {2}https:\/\/a6g\.example\.com\/t\/shop\/decided\n- Blog: 1 call the team flagged\n {2}https:\/\/a6g\.example\.com\/t\/blog\/decided/
  );
  assert.match(digest.text, /Since your last digest:\n- Decided for you: Do guests check out without an account\?/);
  assert.equal(digest.link, `${BASE}/t/shop/decided`);
  // What waits on them comes first, and is where the email leads; with nothing to review, it reads as it did.
  const both = digestMail(
    [],
    [{ team: "shop", items: [{ id: "39", title: "Q", status: "question", since: "2026-11-01T23:12:00.000Z" }] }],
    titles,
    BASE,
    "Monday, November 2",
    [{ team: "shop", count: 1 }]
  );
  assert.equal(both.subject, "[Anything Factory] 1 waiting on you, 1 to review");
  assert.equal(both.link, `${BASE}/inbox`);
  assert.ok(both.text.indexOf("Waiting on you:") < both.text.indexOf("Decided for you, and not reviewed yet:"));
  assert.doesNotMatch(digestMail([call], [], titles, BASE, "Monday, November 2").text, /not reviewed yet/);
});
