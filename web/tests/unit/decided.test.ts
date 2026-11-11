// What the Decided for you and Agreement pages show (server/decided.ts), and how each kind of control reads in a list
// (server/views.ts): worked out from the factory's own documents, never stored.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Agreement, CONFIDENCE_MEANS, DEFAULT_AGREEMENT, STAKES_MEAN } from "../../../lib/tasks/agreement.ts";
import { agreementControl, budgetControl, type Control, pauseControl, resumeControl, reviewControl } from "../../../lib/tasks/controls.ts";
import { type DecisionRecord, toReview } from "../../../lib/tasks/decisions.ts";
import type { TeamState } from "../../../lib/tasks/teams.ts";
import {
  agreementHistory,
  agreementPending,
  contactOfForm,
  decided,
  decidedLog,
  hintSays,
  messagesFields,
  readsAgreement,
  topicRows,
  toYou,
  underAgreement,
} from "../../server/decided.ts";
import { controlSaid, controlsView } from "../../server/views.ts";

let k = 0;
const control = (fields: Omit<Control, "id" | "version">, at: string): Control => ({ ...fields, at, id: `k${++k}`, version: 1 });
let n = 0;
const record = (fields: Partial<DecisionRecord> = {}): DecisionRecord => {
  const id = `d${++n}`;
  const at = fields.at ?? `2026-11-0${n}T09:00:00.000Z`;
  return {
    id,
    version: 1,
    team: "shop",
    question: `question ${id}`,
    options: [],
    decision: "the plain one",
    because: "the direction says plain words",
    topic: "design",
    stakes: "low",
    confidence: "high",
    route: "decide",
    rule: "balanced: low stakes with high confidence is decided",
    agreement: null,
    undo: "",
    tasks: [],
    by: "planner",
    at,
    review: null,
    notes: [],
    updatedAt: at,
    history: [],
    ...fields,
  };
};
const agreement = (fields: Partial<Agreement>): Agreement => ({ ...DEFAULT_AGREEMENT, ...fields });

test("the log: what's flagged and unreviewed first, longest waiting first; what stands; what was overturned", () => {
  const plain = record();
  const flaggedOld = record({ route: "tell" });
  const flaggedNew = record({ route: "tell" });
  const agreed = record({
    route: "tell",
    review: { verdict: "agreed", note: "", by: "web:s1", at: "2026-11-05T10:00:00.000Z", control: "k90" },
  });
  const overturned = record({
    route: "tell",
    review: { verdict: "overturned", note: "Keep it empty.", by: "operator", at: "2026-11-06T10:00:00.000Z", control: "k91" },
  });
  // Asked for a moment ago, and the team's machine hasn't written it onto the record yet.
  const pendingOverturn = record();
  const asked = control(reviewControl("shop", "web:s1", { decision: pendingOverturn.id, verdict: "overturned", note: "No." }), "2026-11-07T10:00:00.000Z");
  const all = [plain, flaggedOld, flaggedNew, agreed, overturned, pendingOverturn];
  const log = decidedLog(all, [asked]);
  assert.deepEqual(
    log.toReview.map((d) => d.record.id),
    [flaggedOld.id, flaggedNew.id]
  );
  assert.deepEqual(
    log.standing.map((d) => d.record.id),
    [agreed.id, plain.id]
  );
  assert.deepEqual(
    log.overturned.map((d) => [d.record.id, d.review?.pending, d.withPlanner]),
    [
      [pendingOverturn.id, true, false],
      [overturned.id, false, true],
    ]
  );
  // The tab's count is the same reading.
  assert.equal(toReview(all, [asked]).length, log.toReview.length);
  // Every record is in exactly one part.
  assert.equal(log.toReview.length + log.standing.length + log.overturned.length, all.length);
});

test("an overturned decision is with the planner until it notes what it did, after the review", () => {
  const review = { verdict: "overturned" as const, note: "Show the samples.", by: "web:s1", at: "2026-11-06T10:00:00.000Z", control: "k9" };
  const before = { at: "2026-11-06T09:00:00.000Z", by: "planner", text: "weighing it" };
  const after = { at: "2026-11-06T11:00:00.000Z", by: "planner", text: "Reverted #4." };
  assert.equal(decided(record({ review }), []).withPlanner, true);
  assert.equal(decided(record({ review, notes: [before] }), []).withPlanner, true);
  assert.equal(decided(record({ review, notes: [before, after] }), []).withPlanner, false);
  assert.equal(decided(record({ review: { ...review, verdict: "agreed" } }), []).withPlanner, false);
  assert.equal(decided(record(), []).flagged, false);
  assert.equal(decided(record({ route: "tell" }), []).flagged, true);
});

test("which agreement a decision was made under, and whether the team reads one at all", () => {
  assert.equal(underAgreement("k7"), "agreement k7");
  assert.equal(underAgreement(null), "the default agreement");
  assert.equal(readsAgreement({ operator: { technical: true, designCheckIn: false } }), true);
  // Published by a factory version from before the agreement.
  assert.equal(readsAgreement({}), false);
});

test("each topic as the agreement has it; what isn't the agreement's to set says why", () => {
  const rows = topicRows(agreement({ topics: { scope: "ask", design: "decide" } }));
  assert.deepEqual(
    rows.map((r) => [r.topic, r.setting, r.locked]),
    [
      ["product", "follow", null],
      ["scope", "ask", null],
      ["design", "decide", null],
      ["technical", "follow", null],
      ["cost", "follow", null],
      ["security", "follow", null],
      ["privacy", "follow", "always"],
      ["rules", "follow", "always"],
    ]
  );
  assert.match(rows[1]?.means ?? "", /what's in or out/);
  // An operator who isn't technical is never asked about the platform or the stack, whatever the agreement says.
  const locked = topicRows(agreement({ topics: { technical: "ask" } }), { technical: false });
  assert.deepEqual(locked.find((r) => r.topic === "technical")?.locked, "never");
});

test("the agreement's versions, newest first, each with what it changed from the one before", () => {
  assert.deepEqual(agreementHistory([]), []);
  const first = control(agreementControl("shop", "operator", agreement({ level: "hands-on" })), "2026-11-01T10:00:00.000Z");
  const pause = control(pauseControl([], "shop", { scope: "now", by: "operator" }), "2026-11-01T11:00:00.000Z");
  const second = control(
    agreementControl("shop", "web:s1", agreement({ level: "hands-on", topics: { scope: "ask", design: "decide" }, notes: "Away until Monday." })),
    "2026-11-02T10:00:00.000Z"
  );
  const history = agreementHistory([first, pause, second]);
  assert.deepEqual(
    history.map((v) => [v.control.id, v.current, v.changes]),
    [
      [second.id, true, ["design: never asked", "standing instructions added"]],
      [first.id, false, ["level balanced → hands-on"]],
    ]
  );
  // Set since the team's machine last reported: the planner may not have heard yet.
  const status = (at: string): TeamState => ({ state: "active", planner: "running", members: {}, at });
  assert.equal(agreementPending(status("2026-11-02T09:59:00.000Z"), second), true);
  assert.equal(agreementPending(status("2026-11-02T10:01:00.000Z"), second), false);
  assert.equal(agreementPending(null, second), true);
  assert.equal(agreementPending(null, null), false);
});

test("every kind of control reads in its own words, and the pause panel lists only pauses, resumes and budgets", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const pause = control(pauseControl([], "shop", { scope: "now", by: "web:s1" }), at);
  const resume = control(resumeControl("shop", "operator", "go on"), at);
  const budget = control(budgetControl("shop", "web:s1", null), at);
  const changed = control(agreementControl("shop", "web:s1", agreement({ level: "hands-off" })), at);
  const agreed = control(reviewControl("shop", "web:s1", { decision: "d3", verdict: "agreed", note: "" }), at);
  const overturned = control(reviewControl("shop", "operator", { decision: "d4", verdict: "overturned", note: "No." }), at);
  assert.deepEqual([pause, resume, budget, changed, agreed, overturned].map(controlSaid), [
    "Asked to pause now",
    "Asked to resume",
    "Asked to set the budget",
    "Changed the working agreement",
    "Agreed with d3",
    "Overturned d4",
  ]);
  const view = controlsView(null, [pause, resume, changed, agreed, budget, overturned]);
  assert.deepEqual(
    view.recent.map((c) => c.kind),
    ["budget", "resume", "pause"]
  );
  // An agreement or a review asked for last doesn't read as a pause waiting to apply.
  assert.equal(view.pending?.id, resume.id);
});

test("what a grade means is said to the operator as you, on their own page", () => {
  assert.equal(toYou(STAKES_MEAN.high), "it reaches users, real data or money before you could see it, changes the scope a lot, or is costly to undo");
  assert.equal(toYou(CONFIDENCE_MEANS.medium), "it follows from what you have said about the product, its users or the company");
  for (const means of [...Object.values(STAKES_MEAN), ...Object.values(CONFIDENCE_MEANS)]) assert.doesNotMatch(toYou(means), /the operator/);
});

test("an overturn is with the planner from when the team's machine wrote it, whatever was noted before", () => {
  const at = "2026-11-02T10:00:00.000Z";
  const overturned = (notes: DecisionRecord["notes"]): DecisionRecord => ({
    ...record({ id: "d9" }),
    review: { verdict: "overturned", note: "No.", by: "operator", at, control: "k9", appliedAt: "2026-11-02T10:01:00.000Z" },
    notes,
  });
  // Noted between the operator's click and the machine's write: not about the overturn.
  assert.equal(decided(overturned([{ at: "2026-11-02T10:00:30.000Z", by: "planner", text: "A config key." }]), []).withPlanner, true);
  assert.equal(decided(overturned([{ at: "2026-11-02T10:02:00.000Z", by: "planner", text: "Undone in #7." }]), []).withPlanner, false);
});

test("a hint says what it suggests in the words of the form that would make the change", () => {
  assert.equal(hintSays({ topic: "design", set: "ask" }), "Set Design to Always ask me");
  assert.equal(hintSays({ topic: "scope", set: "follow" }), "Give Scope back to the level");
  assert.equal(hintSays({ topic: "cost", set: "decide" }), "Never ask about Cost");
  assert.equal(hintSays({ topic: null, set: "hands-on" }), "Move the level to hands-on");
  assert.equal(hintSays({ topic: null, set: "balanced" }), "Move the level to balanced");
});

test("how often a message may reach the operator: the form's fields to the agreement's contact, and back", () => {
  // Nothing set: the team's own settings hold, and a digest would start from the usual window.
  assert.deepEqual(messagesFields(undefined), { messages: "team", every: "4" });
  assert.deepEqual(messagesFields({ mode: "digest", everyMin: 90 }), { messages: "digest", every: "1.5" });
  assert.deepEqual(messagesFields({ mode: "digest", everyMin: 1440 }), { messages: "digest", every: "24" });
  assert.deepEqual(messagesFields({ mode: "priority", everyMin: 0 }), { messages: "priority", every: "4" });
  assert.deepEqual(contactOfForm("team", "4"), { contact: undefined });
  assert.deepEqual(contactOfForm("", ""), { contact: undefined });
  assert.deepEqual(contactOfForm("priority", "nonsense"), { contact: { mode: "priority", everyMin: 0 } });
  assert.deepEqual(contactOfForm("digest", "2"), { contact: { mode: "digest", everyMin: 120 } });
  assert.deepEqual(contactOfForm("digest", " 0,5 "), { contact: { mode: "digest", everyMin: 30 } });
  assert.deepEqual(contactOfForm("digest", "168"), { contact: { mode: "digest", everyMin: 10_080 } });
  // A window that isn't one says so, and what it may be.
  for (const every of ["", "soon", "0", "0.1", "169", "-2"]) {
    const result = contactOfForm("digest", every);
    assert.match("problem" in result ? result.problem : "", /from 0\.25 \(a quarter of an hour\) to 168 \(a week\)/, every);
  }
  assert.deepEqual(contactOfForm("hourly", "1"), { problem: "Choose how often a message may reach you." });
});
