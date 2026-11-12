// What waits on the operator (server/inbox.ts): the options and recommendation read out of a question, what it holds
// up, answered and settled ones, and the answer as the planner reads it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { newTask, OPERATOR, type Status, type Task, withEvent } from "../../../lib/tasks/model.ts";
import {
  answerText,
  asRecommended,
  choicesIn,
  inbox,
  mentions,
  recommendationIn,
  recommendedKey,
  shownAs,
  waitingCount,
  waitingOf,
  withoutChoices,
} from "../../server/inbox.ts";

let next = 1;
const task = (status: Status, fields: Partial<Task> = {}): Task => ({
  ...newTask({ team: "shop", title: `task ${next}`, kind: "feature", status, by: "planner", ...fields }),
  id: String(next++),
  version: 1,
});
const moved = (t: Task, to: Status, by: string, why: string, at: string): Task => {
  const done = withEvent({ ...t, status: to }, by, `${t.status} → ${to}: ${why}`, { from: t.status, to });
  return { ...done, history: done.history.map((e, i, all) => (i === all.length - 1 ? { ...e, at } : e)) };
};

const ASKED = [
  "These pages are hidden in production. Options: (a) keep them hidden until the operator opens each one;",
  "(b) open them behind the same role checks they use locally; (c) open the customer-facing ones and keep /admin hidden.",
  "Recommendation: (a) for now, decided page by page at release; the team adds nothing that depends on them. This changes who sees data.",
].join(" ");

test("choicesIn reads (a), (b), (c) from Options: up to the recommendation", () => {
  assert.deepEqual(choicesIn(ASKED), [
    { key: "a", text: "keep them hidden until the operator opens each one" },
    { key: "b", text: "open them behind the same role checks they use locally" },
    { key: "c", text: "open the customer-facing ones and keep /admin hidden" },
  ]);
  // A lone mention of an option, or letters out of order, isn't a list of them.
  assert.deepEqual(choicesIn("It hangs on #39: option (c), which records a different fact from (a)/(b)."), []);
  assert.deepEqual(choicesIn("Either (b) this or (c) that."), []);
  assert.deepEqual(choicesIn("No options here."), []);
  // A parenthesis inside an option stays in it.
  assert.equal(
    choicesIn("Options: (a) the draft (shown in the branch: what we keep); (b) yours.")[0]?.text,
    "the draft (shown in the branch: what we keep)"
  );
});

test("recommendationIn takes the first sentence, and recommendedKey the option it names", () => {
  const rec = recommendationIn(ASKED);
  assert.equal(rec, "(a) for now, decided page by page at release; the team adds nothing that depends on them.");
  assert.equal(recommendedKey(rec), "a");
  assert.equal(
    recommendationIn("Whether a screen is wanted; recommendation if yes: own staff only, until it opens (#40)."),
    "own staff only, until it opens (#40)."
  );
  assert.equal(recommendedKey("own staff only"), null);
  assert.equal(recommendationIn("Nothing recommended here"), null);
});

test("withoutChoices keeps what comes before the options and after the recommendation's sentence", () => {
  assert.equal(withoutChoices(ASKED), "These pages are hidden in production. This changes who sees data.");
  assert.equal(
    withoutChoices("Whether a screen is wanted and for whom; recommendation if yes: own staff only (#40)."),
    "Whether a screen is wanted and for whom."
  );
  assert.equal(withoutChoices("Options: (a) yes; (b) no."), "");
  assert.equal(withoutChoices("No options here."), "No options here.");
});

test("a question is read from the newest note by the team that puts it, else the description", () => {
  const finding = task("question", {
    kind: "ux",
    body: "The first name shows to donors, with no warning.",
    notes: [
      { at: "2026-11-01T23:38:00.000Z", by: "ux-specialist", text: "Screens attached." },
      { at: "2026-11-01T23:40:00.000Z", by: "planner", text: `For the operator: who sees a name is yours. ${ASKED}` },
      { at: "2026-11-01T23:50:00.000Z", by: OPERATOR, text: "Recommendation: whatever you think (c)" },
    ],
  });
  const w = waitingOf(finding, [finding]);
  assert.equal(w.question.by, "planner");
  assert.deepEqual(
    w.choices.map((c) => [c.key, c.recommended]),
    [
      ["a", true],
      ["b", false],
      ["c", false],
    ]
  );
  const plain = waitingOf(task("question", { body: "Which words?" }), []);
  assert.deepEqual([plain.question.text, plain.question.by, plain.choices, plain.recommendation], ["Which words?", null, [], null]);
});

test("waitingOf takes the reason and the recommendation from the team's ask, else from the task's own words", () => {
  const asked = {
    ...moved(
      task("proposed", { body: "Options: (a) keep it; (b) drop it. Recommendation: (a), for now." }),
      "question",
      "planner",
      "yours",
      "2026-11-01T10:00:00.000Z"
    ),
    ask: { reason: "it changes what donors see", recommendation: "(b): nobody uses it", by: "approver", at: "2026-11-01T10:00:00.000Z" },
  };
  const w = waitingOf(asked, [asked]);
  assert.deepEqual(
    [w.why, w.whyFrom, w.recommendation, w.recommendationFrom, w.askedBy],
    ["it changes what donors see", "asked", "(b): nobody uses it", "asked", "approver"]
  );
  assert.deepEqual(
    w.choices.map((c) => [c.key, c.recommended]),
    [
      ["a", false],
      ["b", true],
    ]
  );
  const before = waitingOf(moved(task("proposed"), "question", "planner", "it's yours", "2026-11-01T10:00:00.000Z"), []);
  assert.deepEqual([before.why, before.whyFrom, before.recommendation, before.recommendationFrom], ["it's yours", "inferred", null, null]);
});

test("waitingOf says who asked, why, since when, and what it holds up", () => {
  const journey = task("approved", { kind: "journey", title: "Register a person" });
  const q = moved(
    task("proposed", { parent: journey.id, body: "Ask together with #99 and #1000." }),
    "question",
    "approver",
    "privacy is the operator's",
    "2026-11-01T23:14:00.000Z"
  );
  const after = task("approved", { after: [q.id] });
  const doneAfter = task("done", { after: [q.id] });
  const other = task("question", { id: "99" } as Partial<Task>);
  const w = waitingOf(q, [journey, q, after, doneAfter, { ...other, id: "99" }]);
  assert.equal(w.askedBy, "approver");
  assert.equal(w.why, "privacy is the operator's");
  assert.equal(w.since, "2026-11-01T23:14:00.000Z");
  assert.equal(w.journey?.id, journey.id);
  assert.deepEqual(
    w.holds.map((t) => t.id),
    [after.id]
  );
  assert.deepEqual(
    w.related.map((t) => t.id),
    ["99"]
  );
  assert.deepEqual(mentions("#21 and #39, #21 again, not #0"), ["21", "39"]);
});

test("inbox: questions and blocked work longest waiting first, answered ones apart, settled ones newest first", () => {
  const old = moved(task("proposed"), "question", "planner", "yours", "2026-11-01T10:00:00.000Z");
  const recent = moved(task("proposed"), "question", "planner", "yours", "2026-11-01T12:00:00.000Z");
  // Blocked work raised to the operator waits on them; a block the team sorts out (or that waits on other tasks) doesn't.
  const stuck = {
    ...moved(task("building"), "blocked", "planner", "needs a key", "2026-11-01T11:00:00.000Z"),
    ask: { reason: "only you hold the carrier's key", recommendation: "add it to the vault", by: "planner", at: "2026-11-01T11:00:00.000Z" },
  };
  const folded = {
    ...moved(task("triage"), "blocked", "planner", "folded into #3", "2026-11-01T11:30:00.000Z"),
    wait: { on: ["3"], then: "close" as const, by: "planner", at: "2026-11-01T11:30:00.000Z" },
  };
  const answered = {
    ...moved(task("proposed"), "question", "planner", "yours", "2026-11-01T09:00:00.000Z"),
    notes: [{ at: "2026-11-01T13:00:00.000Z", by: OPERATOR, text: "(b)", kind: "answer" as const }],
  };
  const journey = task("blocked", { kind: "journey" });
  const settledQ = {
    ...moved(
      moved(task("proposed"), "question", "planner", "yours", "2026-11-01T08:00:00.000Z"),
      "approved",
      "planner",
      "the operator chose (a)",
      "2026-11-01T14:00:00.000Z"
    ),
    notes: [{ at: "2026-11-01T13:30:00.000Z", by: OPERATOR, text: "(a)", kind: "answer" as const }],
  };
  const longAgo = moved(
    moved(task("proposed"), "question", "planner", "yours", "2026-09-01T08:00:00.000Z"),
    "rejected",
    "operator",
    "no",
    "2026-09-02T08:00:00.000Z"
  );
  const all = [recent, old, stuck, folded, answered, journey, settledQ, longAgo];
  const box = inbox(all, { now: Date.parse("2026-11-02T00:00:00.000Z") });
  assert.deepEqual(
    box.questions.map((w) => w.task.id),
    [old.id, recent.id]
  );
  assert.deepEqual(
    box.blocked.map((w) => w.task.id),
    [stuck.id]
  );
  assert.deepEqual(
    box.answered.map((w) => w.task.id),
    [answered.id]
  );
  assert.deepEqual(
    box.settled.map((s) => [s.task.id, s.to, s.answer?.text]),
    [[settledQ.id, "approved", "(a)"]]
  );
  assert.equal(waitingCount(all), 3);
});

test("answerText: an option, the recommendation, or the operator's own words, with anything added", () => {
  const offered = { choices: [{ key: "a", text: "keep them hidden" }], recommendation: "(a) for now." };
  assert.deepEqual(answerText("a", "", offered), { text: "(a) keep them hidden." });
  assert.deepEqual(answerText("recommended", "  But tell me first.  ", offered), {
    text: "Go with your recommendation: (a) for now.\n\nBut tell me first.",
  });
  assert.deepEqual(answerText("other", "Open /orders only.", offered), { text: "Open /orders only." });
  assert.deepEqual(answerText("other", " ", offered), { problem: "Choose an option, or write your answer." });
  assert.deepEqual(answerText("", "", { choices: [], recommendation: null }), { problem: "Write your answer." });
  assert.deepEqual(answerText("z", "x", offered), { problem: "Choose one of the options, or write your own answer." });
  assert.deepEqual(answerText("recommended", "", { choices: [], recommendation: null }), {
    problem: "Choose one of the options, or write your own answer.",
  });
});

test("asRecommended: the recommendation as it stood, or the option it names, with nothing added", () => {
  const offered = {
    choices: [
      { key: "a", text: "keep them hidden" },
      { key: "b", text: "open them" },
    ],
    recommendation: "(b) behind the same sign-in.",
  };
  assert.equal(asRecommended("recommended", "", offered), true);
  assert.equal(asRecommended("b", "  ", offered), true);
  // Another option, their own words, or the recommendation with a condition, is the operator's own answer.
  assert.equal(asRecommended("a", "", offered), false);
  assert.equal(asRecommended("other", "Open /orders only.", offered), false);
  assert.equal(asRecommended("b", "But tell me first.", offered), false);
  assert.equal(asRecommended("recommended", "But tell me first.", offered), false);
  // A recommendation that names no option is taken only as itself; with none, nothing is.
  assert.equal(asRecommended("a", "", { choices: offered.choices, recommendation: "wait a week" }), false);
  assert.equal(asRecommended("recommended", "", { choices: [], recommendation: "wait a week" }), true);
  assert.equal(asRecommended("recommended", "", { choices: [], recommendation: null }), false);
  assert.equal(asRecommended("z", "", offered), false);
});

test("shownAs: the answer form's token changes with what the form offers, and with nothing else", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const asked = moved(
    task("approved", {
      body: "Guests can't see orders. Options: (a) keep them hidden; (b) open them to signed-in customers.",
      ask: { reason: "who sees orders is the operator's", recommendation: "(b) open them to signed-in customers", by: "planner", at },
    }),
    "question",
    "planner",
    "who sees orders is the operator's",
    at
  );
  const token = (t: Task): string => shownAs(waitingOf(t, [t]));
  const before = token(asked);
  assert.match(before, /^[0-9a-f]{16}$/);
  assert.equal(token({ ...asked, version: 7, updatedAt: "2026-11-02T00:00:00.000Z" }), before, "the same question, written again");
  // A member's note with no options in it, and the operator's own answer, leave the form as it was.
  const noted = { ...asked, notes: [...asked.notes, { at, by: "builder", text: "The orders table has 40 rows today." }] };
  assert.equal(token(noted), before);
  assert.equal(token({ ...asked, notes: [...asked.notes, { at, by: OPERATOR, text: "(a) keep them hidden.", kind: "answer" as const }] }), before);
  // Another recommendation, another reason, or a note that puts the options another way: not the form that was read.
  const other = (ask: Partial<NonNullable<Task["ask"]>>): Task => ({ ...asked, ask: asked.ask ? { ...asked.ask, ...ask } : undefined }) as Task;
  assert.notEqual(token(other({ recommendation: "(a) keep them hidden" })), before);
  assert.notEqual(token(other({ reason: "a customer complained" })), before);
  const reput = { ...asked, notes: [...asked.notes, { at, by: "planner", text: "Options: (a) open them to everyone; (b) keep them hidden." }] };
  assert.notEqual(token(reput), before);
  // The same key is another option now: what an answer by key would be read against.
  assert.equal(waitingOf(reput, [reput]).choices[0]?.text, "open them to everyone");
});
