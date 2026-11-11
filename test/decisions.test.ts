// The decision log (lib/tasks/decisions.ts): what the team decides for its operator, routed by the working agreement in
// force, and the operator's reviews of it.
import { tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_AGREEMENT } from "../lib/tasks/agreement.ts";
import { agreementControl } from "../lib/tasks/controls.ts";
import {
  applyReview,
  checkIns,
  decisionLine,
  type DecisionRecord,
  judgedFrom,
  noteDecision,
  overturnedMessage,
  overturnedOpen,
  recordDecision,
  requestReview,
  reviewOf,
  toReview,
} from "../lib/tasks/decisions.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask, OPERATOR, Refused, type Status, type Task } from "../lib/tasks/model.ts";

async function graph() {
  const run = tmp("a6g-run-");
  const store = fileStore(run, "fixture");
  const add = (title: string, status: Status, fields: Partial<Task> = {}) =>
    store.tasks.create(newTask({ team: "fixture", title, kind: "feature", status, by: "planner", ...fields }));
  const record = (fields: Partial<Parameters<typeof recordDecision>[2]> = {}, call: Partial<Parameters<typeof recordDecision>[3]> = {}) =>
    recordDecision(
      store,
      "fixture",
      {
        question: "Which empty state for the orders list?",
        decision: "A line that says what will appear, and a button to add one",
        because: "the direction puts first-time owners first",
        ...fields,
      },
      { topic: "design", stakes: "low", confidence: "medium", ...call },
      "planner"
    );
  return { run, store, add, record };
}

describe("recording a decision", () => {
  test("it keeps the question, the choice, why, and why the operator wasn't asked", async () => {
    const { store, add, record } = await graph();
    const task = await add("Orders list", "approved");
    const d = await record({ options: [" Nothing ", "A line and a button", ""], undo: "revert the merge of #1", tasks: [`#${task.id}`, task.id] });
    assert.equal(d.id, "d1");
    assert.deepEqual(
      { route: d.route, rule: d.rule, agreement: d.agreement, review: d.review, tasks: d.tasks, options: d.options, by: d.by },
      {
        route: "decide",
        rule: "balanced: low stakes with medium confidence is decided",
        agreement: null,
        review: null,
        tasks: ["1"],
        options: ["Nothing", "A line and a button"],
        by: "planner",
      }
    );
    assert.equal(d.history[0]?.what, "decided");
    assert.deepEqual(await store.decisions.all(), [d]);
    assert.equal(
      decisionLine(d),
      "- Which empty state for the orders list → A line that says what will appear, and a button to add one. Because the direction puts first-time owners first. (planner, d1, task 1)"
    );
  });

  test("a call the agreement flags is recorded as flagged, under the agreement that was in force", async () => {
    const { store, record } = await graph();
    const set = await store.controls.create(agreementControl("fixture", OPERATOR, { level: "hands-on", topics: {}, notes: "" }));
    const d = await record({}, { stakes: "medium", confidence: "medium" });
    assert.deepEqual({ route: d.route, agreement: d.agreement }, { route: "tell", agreement: set.id });
    assert.equal(d.history[0]?.what, "decided, and flagged for the operator");
    assert.deepEqual(
      toReview(await store.decisions.all(), await store.controls.all()).map((x) => x.id),
      [d.id]
    );
  });

  test("a question the agreement makes the operator's is refused, with the command that raises it", async () => {
    const { store, record } = await graph();
    await assert.rejects(
      record({}, { topic: "product", stakes: "high", confidence: "low" }),
      (e: Error) =>
        e instanceof Refused &&
        /this one is the operator's to decide \(balanced: high stakes with low confidence is asked\): raise it instead: a6g task status <id> question --topic product --stakes high --confidence low/.test(
          e.message
        )
    );
    await assert.rejects(record({}, { topic: "privacy", stakes: "low", confidence: "high" }), /privacy is always the operator's/);
    // The operator stops being asked about design: the same call is the team's now, and flagged.
    await store.controls.create(agreementControl("fixture", OPERATOR, { level: "balanced", topics: { design: "decide" }, notes: "" }));
    assert.equal((await record({}, { topic: "design", stakes: "high", confidence: "low" })).route, "tell");
    assert.equal((await store.decisions.all()).length, 1);
  });

  test("a team whose operator isn't technical decides the stack and records it", async () => {
    const { store } = await graph();
    const call = { topic: "technical", stakes: "high", confidence: "low" } as const;
    const input = { question: "Postgres or SQLite?", decision: "Postgres, managed", because: "the safer choice: mainstream, backed up, little to run" };
    await assert.rejects(recordDecision(store, "fixture", input, call, "planner", { technical: true }), /the operator's to decide/);
    const d = await recordDecision(store, "fixture", input, call, "planner", { technical: false });
    assert.equal(d.route, "tell");
    assert.match(d.rule, /isn't technical/);
  });

  test("only the planner records, and a record says everything it needs to", async () => {
    const { store, record } = await graph();
    const call = { topic: "design", stakes: "low", confidence: "high" } as const;
    const input = { question: "q", decision: "d", because: "b" };
    await assert.rejects(
      recordDecision(store, "fixture", input, call, "builder"),
      /the planner records what it decides for the operator; you're the builder/
    );
    await assert.rejects(recordDecision(store, "fixture", input, call, OPERATOR), /the planner records/);
    await assert.rejects(record({ question: "  " }), /say what was in question/);
    await assert.rejects(record({ decision: "" }), /say what you decided/);
    await assert.rejects(record({ because: "" }), /say what it follows from/);
    await assert.rejects(record({ question: "x".repeat(301) }), /keep the question to 300 characters/);
    await assert.rejects(record({ tasks: ["99"] }), /--task: there's no task #99/);
    await assert.rejects(record({ options: Array.from({ length: 7 }, (_, i) => `option ${i}`) }), /--options: at most 6/);
    assert.equal((await store.decisions.all()).length, 0);
  });

  test("the three judgments are all asked for, by name", () => {
    assert.deepEqual(judgedFrom({ topic: "scope", stakes: "high", confidence: "low" }), { topic: "scope", stakes: "high", confidence: "low" });
    const problem = (given: Parameters<typeof judgedFrom>[0]): string => {
      const result = judgedFrom(given);
      return "problem" in result ? result.problem : "";
    };
    assert.match(problem({}), /--topic product\|scope\|design\|technical\|cost\|security\|privacy\|rules/);
    assert.match(problem({ topic: "scope" }), /what a wrong call would cost: --stakes low\|medium\|high/);
    assert.match(problem({ topic: "scope", stakes: "high", confidence: "certain" }), /how sure you are.*--confidence low\|medium\|high/);
  });
});

describe("the operator's review", () => {
  test("a review is a control; applied, it's on the record, once", async () => {
    const { store, record } = await graph();
    const d = await record({}, { stakes: "high", confidence: "medium" });
    const asked = await requestReview(store, "fixture", { id: `#${d.id}`, verdict: "agreed", by: "web:s3" });
    assert.deepEqual(
      { kind: asked.kind, review: asked.review, by: asked.by },
      { kind: "review", review: { decision: "d1", verdict: "agreed", note: "" }, by: "web:s3" }
    );
    // Until the team's machine applies it, it's pending: reviewed as far as the operator's page goes.
    const before = (await store.decisions.get(d.id)) as DecisionRecord;
    assert.equal(before.review, null);
    assert.deepEqual(reviewOf(before, await store.controls.all()), {
      verdict: "agreed",
      note: "",
      by: "web:s3",
      at: asked.at,
      control: asked.id,
      pending: true,
    });
    assert.deepEqual(toReview([before], await store.controls.all()), []);
    const applied = await applyReview(store, asked);
    assert.equal(applied?.applied, true);
    const { appliedAt, ...written } = applied?.record.review ?? { appliedAt: "" };
    assert.deepEqual(written, { verdict: "agreed", note: "", by: "web:s3", at: asked.at, control: asked.id });
    assert.ok(appliedAt && appliedAt >= asked.at, "and when the machine wrote it");
    assert.equal(applied?.record.history.at(-1)?.what, "agreed");
    assert.equal(reviewOf(applied?.record as DecisionRecord, await store.controls.all())?.pending, false);
    assert.equal((await applyReview(store, asked))?.applied, false, "the same control twice changes nothing");
  });

  test("an overturn says what to do instead, reaches the planner in one message, and stays open until it notes what it did", async () => {
    const { store, add, record } = await graph();
    const task = await add("Orders list", "approved");
    const d = await record({ tasks: [task.id], undo: "revert #1" }, { stakes: "high", confidence: "medium" });
    await assert.rejects(requestReview(store, "fixture", { id: d.id, verdict: "overturned", by: OPERATOR }), /say what to do instead/);
    const asked = await requestReview(store, "fixture", { id: d.id, verdict: "overturned", note: " Show the sample orders instead. ", by: OPERATOR });
    const applied = await applyReview(store, asked);
    assert.equal(applied?.record.review?.note, "Show the sample orders instead.");
    assert.match(applied?.record.history.at(-1)?.what ?? "", /^overturned: Show the sample orders instead\.$/);
    const message = overturnedMessage([applied?.record as DecisionRecord]);
    assert.match(message, /^The operator overturned a decision the team made for them:/);
    assert.match(message, /1\. d1 \(design\) "Which empty state for the orders list\?": you decided "A line that says/);
    assert.match(message, /They wrote: Show the sample orders instead\./);
    assert.match(message, /Tasks: #1\. To undo, the record says: revert #1/);
    assert.match(message, /a6g decision note <id>/);
    assert.deepEqual(
      overturnedOpen(await store.decisions.all()).map((x) => x.id),
      [d.id]
    );
    await assert.rejects(noteDecision(store, d.id, { who: "builder", text: "done" }), /the planner notes/);
    await assert.rejects(noteDecision(store, d.id, { who: "planner", text: " " }), /say what/);
    const noted = await noteDecision(store, d.id, { who: "planner", text: "Reverted #1; #4 shows the samples." });
    assert.equal(noted.notes.at(-1)?.text, "Reverted #1; #4 shows the samples.");
    assert.deepEqual(overturnedOpen(await store.decisions.all()), []);
  });

  test("an agreement may become an overturn, never the other way; nobody but the operator reviews", async () => {
    const { store, record } = await graph();
    const d = await record();
    await assert.rejects(requestReview(store, "fixture", { id: d.id, verdict: "agreed", by: "planner" }), /only the operator reviews/);
    await assert.rejects(requestReview(store, "fixture", { id: d.id, verdict: "maybe", by: OPERATOR }), /agree with it, or overturn it/);
    await assert.rejects(requestReview(store, "fixture", { id: "d9", verdict: "agreed", by: OPERATOR }), /no decision d9/);
    await applyReview(store, await requestReview(store, "fixture", { id: d.id, verdict: "agreed", by: OPERATOR }));
    await assert.rejects(requestReview(store, "fixture", { id: d.id, verdict: "agreed", by: OPERATOR }), /you agreed with d1 already/);
    // Changed their mind, before the machine applied it or after.
    const overturn = await requestReview(store, "fixture", { id: d.id, verdict: "overturned", note: "No: keep it empty.", by: OPERATOR });
    await assert.rejects(requestReview(store, "fixture", { id: d.id, verdict: "agreed", by: OPERATOR }), /overturned already/);
    assert.equal((await applyReview(store, overturn))?.record.review?.verdict, "overturned");
    await assert.rejects(requestReview(store, "fixture", { id: d.id, verdict: "overturned", note: "again", by: OPERATOR }), /overturned already/);
    // An agreement that arrives late doesn't undo an overturn.
    const late = { ...overturn, id: "k99", review: { decision: d.id, verdict: "agreed" as const, note: "" } };
    assert.equal((await applyReview(store, late))?.applied, false);
    assert.equal((await store.decisions.get(d.id))?.review?.verdict, "overturned");
  });

  test("how the check-ins went: asked, decided, flagged, overturned, and what waits for a review", async () => {
    const { store, add, record } = await graph();
    const since = "2026-01-01T00:00:00.000Z";
    await add("Q", "question", {
      history: [{ at: "2026-02-01T00:00:00.000Z", by: "planner", what: "proposed → question", from: "proposed", to: "question" }],
    });
    await add("Old Q", "question", {
      history: [{ at: "2025-02-01T00:00:00.000Z", by: "planner", what: "proposed → question", from: "proposed", to: "question" }],
    });
    await add("Mine", "question", {
      history: [{ at: "2026-02-01T00:00:00.000Z", by: OPERATOR, what: "proposed → question", from: "proposed", to: "question" }],
    });
    await record();
    const flaggedOne = await record({}, { stakes: "high", confidence: "medium" });
    const overturned = await record({}, { stakes: "high", confidence: "high" });
    await requestReview(store, "fixture", { id: overturned.id, verdict: "overturned", note: "No.", by: OPERATOR });
    const stats = checkIns(await store.decisions.all(), await store.tasks.all(), await store.controls.all(), since);
    assert.deepEqual(stats, { asked: 1, decided: 3, flagged: 2, overturned: 1, toReview: 1 });
    assert.deepEqual(
      toReview(await store.decisions.all(), await store.controls.all()).map((d) => d.id),
      [flaggedOne.id]
    );
    assert.deepEqual(checkIns([], [], [], since), { asked: 0, decided: 0, flagged: 0, overturned: 0, toReview: 0 });
    assert.equal(DEFAULT_AGREEMENT.level, "balanced");
  });
});
