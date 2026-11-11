// The decision log: what a team decided in its operator's place. Each record is a question the planner would otherwise
// have brought to the operator, what it weighed, what it chose and why, and why it wasn't asked: the route the working
// agreement gave (agreement.ts), the rule that gave it, and which agreement was in force. Records are only ever added
// to; the operator reviews one by agreeing with it or overturning it, and the planner notes what it did about that.
//
// A review is a control (controls.ts), like a pause: the web app adds it with the access it already has, the watchdog
// writes it onto the record and passes an overturn to the planner within a minute. Free of the CLI, so the web app
// reads and reviews with the same code.
import {
  type Agreement,
  type Grade,
  type Judged,
  type Level,
  isGrade,
  isReserved,
  isTopic,
  route,
  type Topic,
  type TopicRule,
  TOPICS,
  GRADES,
} from "./agreement.ts";
import { agreementOf, type Control, REVIEW_VERDICTS, reviewControl, type ReviewVerdict } from "./controls.ts";
import { type Actor, type Doc, type Event, type Note, nowIso, OPERATOR, Refused, type Task, withEvent } from "./model.ts";
import { type Store, update } from "./store.ts";

export interface Review {
  verdict: ReviewVerdict;
  // What the operator said: for an overturn, what to do instead.
  note: string;
  by: string;
  at: string;
  // The control that asked for it.
  control: string;
  // When the team's machine wrote it onto the record (`at` is when the operator gave it): what the planner noted
  // before then wasn't about it.
  appliedAt?: string;
}

export interface DecisionRecord extends Doc {
  team: string;
  question: string;
  // What was weighed, the one chosen among them or not.
  options: string[];
  decision: string;
  // The direction, recorded decision or evidence it follows.
  because: string;
  topic: Topic;
  stakes: Grade;
  confidence: Grade;
  // Why it wasn't asked: decided and flagged for the operator ("tell"), or decided; the rule in words; and the
  // agreement in force, by its control (null: the default, which nobody had changed).
  route: "tell" | "decide";
  rule: string;
  agreement: string | null;
  // How it's undone if the operator disagrees.
  undo: string;
  tasks: string[];
  by: string;
  at: string;
  review: Review | null;
  notes: Note[];
  updatedAt: string;
  history: Event[];
}

export const DECISION_LIMITS = { question: 300, decision: 1000, because: 1000, undo: 500, option: 300, options: 6, note: 2000 } as const;

const oneLine = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// The planner's three judgments of a question, from a command's options, or what's missing: both commands that take
// them (a6g task status … question, a6g decision record) say the same.
export function judgedFrom(given: {
  topic?: string | undefined;
  stakes?: string | undefined;
  confidence?: string | undefined;
}): Judged | { problem: string } {
  const { topic, stakes, confidence } = given;
  if (!isTopic(topic)) return { problem: `say what the question is about: --topic ${TOPICS.join("|")}` };
  if (!isGrade(stakes)) return { problem: `say what a wrong call would cost: --stakes ${GRADES.join("|")}` };
  if (!isGrade(confidence)) return { problem: `say how sure you are of what the operator would choose: --confidence ${GRADES.join("|")}` };
  return { topic, stakes, confidence };
}

export interface DecisionInput {
  question: string;
  decision: string;
  because: string;
  options?: string[];
  undo?: string;
  tasks?: string[];
}

// The planner records a decision it made for the operator. Throws a Refused saying why when it can't: something's
// missing, or the agreement in force makes this question the operator's, which is raised instead.
export async function recordDecision(
  store: Store,
  team: string,
  input: DecisionInput,
  call: Judged,
  who: Actor,
  operator: { technical: boolean } = { technical: true }
): Promise<DecisionRecord> {
  if (who !== "planner") throw new Refused(`the planner records what it decides for the operator; you're the ${who}`);
  const question = oneLine(input.question);
  const decision = oneLine(input.decision);
  const because = oneLine(input.because);
  const undo = oneLine(input.undo);
  const options = (input.options ?? []).map(oneLine).filter(Boolean);
  if (!question) throw new Refused('say what was in question: a6g decision record "<the question>" --decided "…" --because "…"');
  if (!decision) throw new Refused('say what you decided: --decided "…"');
  if (!because) throw new Refused('say what it follows from (the direction, an earlier decision, the evidence): --because "…"');
  const over = (
    [
      ["the question", question, DECISION_LIMITS.question],
      ["--decided", decision, DECISION_LIMITS.decision],
      ["--because", because, DECISION_LIMITS.because],
      ["--undo", undo, DECISION_LIMITS.undo],
    ] as const
  ).find(([, text, max]) => text.length > max);
  if (over) throw new Refused(`keep ${over[0]} to ${over[2]} characters; the rest belongs on the task (a6g task note)`);
  if (options.length > DECISION_LIMITS.options || options.some((o) => o.length > DECISION_LIMITS.option))
    throw new Refused(`--options: at most ${DECISION_LIMITS.options}, each up to ${DECISION_LIMITS.option} characters, separated by " | "`);
  const tasks = [...new Set((input.tasks ?? []).map((id) => id.trim().replace(/^#/, "")).filter(Boolean))];
  for (const id of tasks) if (!(await store.tasks.get(id))) throw new Refused(`--task: there's no task #${id}`);
  const { agreement, control } = agreementOf(await store.controls.all());
  const routed = route(agreement, call, operator);
  if (routed.route === "ask")
    throw new Refused(
      `this one is the operator's to decide (${routed.rule}): raise it instead: a6g task status <id> question --topic ${call.topic} --stakes ${call.stakes} --confidence ${call.confidence} --reason "…" --recommend "…"`
    );
  const at = nowIso();
  return store.decisions.create({
    team,
    question,
    options,
    decision,
    because,
    ...call,
    route: routed.route,
    rule: routed.rule,
    agreement: control?.id ?? null,
    undo,
    tasks,
    by: who,
    at,
    review: null,
    notes: [],
    updatedAt: at,
    history: [{ at, by: who, what: routed.route === "tell" ? "decided, and flagged for the operator" : "decided" }],
  });
}

// The record's line in .a6g/decisions.md, the team's working memory of rulings, as the planner's rules lay it out.
export function decisionLine(d: Pick<DecisionRecord, "id" | "question" | "decision" | "because" | "tasks" | "by">): string {
  const end = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
  const where = [d.id, ...(d.tasks.length ? [`task ${d.tasks.join(", ")}`] : [])].join(", ");
  return `- ${d.question.replace(/[.?!]+$/, "")} → ${end(d.decision)} Because ${end(d.because)} (${d.by}, ${where})`;
}

// Flagged for the operator: the team decided, and thought they'd want to see it.
export const flagged = (d: Pick<DecisionRecord, "route">): boolean => d.route === "tell";

// A review may follow none, and an overturn may follow an agreement (the cautious way); never the other way round.
const follows = (current: Pick<Review, "verdict"> | null, verdict: ReviewVerdict): boolean =>
  current === null || (current.verdict === "agreed" && verdict === "overturned");

// The review in force on a record: the one written on it, or a newer one asked for that the team's machine hasn't
// applied yet (`pending`). Controls come oldest first, as the store lists them.
export function reviewOf(d: DecisionRecord, controls: Control[]): (Review & { pending: boolean }) | null {
  const written = d.review ? { ...d.review, pending: false } : null;
  const asked = controls.findLast(
    (c) => c.kind === "review" && c.review?.decision === d.id && c.id !== d.review?.control && follows(d.review, c.review.verdict)
  );
  if (!asked?.review) return written;
  return { verdict: asked.review.verdict, note: asked.review.note, by: asked.by, at: asked.at, control: asked.id, pending: true };
}

// The operator reviews decision `id`: a control, which the watchdog writes onto the record. Throws a Refused saying
// why when it can't.
export async function requestReview(
  store: Store,
  team: string,
  { id, verdict, note = "", by }: { id: string; verdict: string; note?: string; by: string }
): Promise<Control> {
  if (by !== OPERATOR && !by.startsWith("web:")) throw new Refused("only the operator reviews what was decided for them");
  if (!(REVIEW_VERDICTS as readonly string[]).includes(verdict)) throw new Refused("agree with it, or overturn it");
  const record = await store.decisions.get(id.trim().replace(/^#/, ""));
  if (!record) throw new Refused(`no decision ${id}`);
  const said = note.trim();
  if (verdict === "overturned" && !said) throw new Refused("say what to do instead: the planner acts on your words");
  if (said.length > DECISION_LIMITS.note) throw new Refused(`keep it to ${DECISION_LIMITS.note.toLocaleString("en")} characters`);
  const current = reviewOf(record, await store.controls.all());
  if (current?.verdict === "overturned") throw new Refused(`${record.id} is overturned already: say what you want now on its task, or add one`);
  if (current && !follows(current, verdict as ReviewVerdict)) throw new Refused(`you agreed with ${record.id} already`);
  return store.controls.create(reviewControl(team, by, { decision: record.id, verdict: verdict as ReviewVerdict, note: said }));
}

// Writes a review control onto its record. Resolves to the record and whether this changed it (false: applied
// already, or it no longer follows what's there), or null when it names no record.
export async function applyReview(store: Store, control: Control): Promise<{ record: DecisionRecord; applied: boolean } | null> {
  const ask = control.kind === "review" ? control.review : null;
  if (!ask) return null;
  const found = await store.decisions.get(ask.decision);
  if (!found) return null;
  if (found.review?.control === control.id || !follows(found.review, ask.verdict)) return { record: found, applied: false };
  let applied = false;
  const record = await update(store.decisions, found.id, (d) => {
    applied = d.review?.control !== control.id && follows(d.review, ask.verdict);
    if (!applied) return d;
    const review: Review = { verdict: ask.verdict, note: ask.note, by: control.by, at: control.at, control: control.id, appliedAt: nowIso() };
    return withEvent({ ...d, review }, OPERATOR, ask.verdict === "agreed" ? "agreed" : `overturned: ${clip(oneLine(ask.note), 120)}`);
  });
  return { record, applied };
}

// The planner notes what it did about a decision (an overturned one, above all).
export async function noteDecision(store: Store, id: string, { who, text }: { who: Actor; text: string }): Promise<DecisionRecord> {
  if (who !== "planner" && who !== OPERATOR) throw new Refused(`the planner notes what it did about a decision; you're the ${who}`);
  const said = text.trim();
  if (!said) throw new Refused('say what: a6g decision note <id> "<what you did>"');
  if (said.length > DECISION_LIMITS.note) throw new Refused(`keep it to ${DECISION_LIMITS.note.toLocaleString("en")} characters`);
  const record = await store.decisions.get(id.trim().replace(/^#/, ""));
  if (!record) throw new Refused(`no decision ${id}`);
  return update(store.decisions, record.id, (d) => withEvent({ ...d, notes: [...d.notes, { at: nowIso(), by: who, text: said }] }, who, "added a note"));
}

// Overturned, and the planner hasn't noted what it did since: for its context each wake, so none is lost with a message.
export const overturnedOpen = (decisions: DecisionRecord[]): DecisionRecord[] => decisions.filter((d) => overturnedSince(d) !== null && !notedSince(d));
// When an overturn reached the record (null: it isn't overturned there), and whether the planner has noted anything since.
export const overturnedSince = (d: DecisionRecord): string | null => (d.review?.verdict === "overturned" ? (d.review.appliedAt ?? d.review.at) : null);
const notedSince = (d: DecisionRecord): boolean => d.notes.some((n) => n.by === "planner" && n.at >= (overturnedSince(d) ?? ""));

// One message to the planner for the decisions the operator overturned.
export function overturnedMessage(records: DecisionRecord[]): string {
  const lines = records.flatMap((d, i) => [
    `${i + 1}. ${d.id} (${d.topic}) "${d.question}": you decided "${d.decision}". They wrote: ${d.review?.note ?? ""}`,
    ...(d.tasks.length || d.undo
      ? [
          `   ${[d.tasks.length ? `Tasks: ${d.tasks.map((id) => `#${id}`).join(", ")}.` : "", d.undo ? `To undo, the record says: ${d.undo}` : ""].filter(Boolean).join(" ")}`,
        ]
      : []),
  ]);
  return [
    `The operator overturned ${records.length === 1 ? "a decision" : "decisions"} the team made for them:`,
    "",
    ...lines,
    "",
    `Do as they say: undo what was built on ${records.length === 1 ? "it" : "each"} (as tasks, where it's work), put their ruling in .a6g/decisions.md as theirs in place of yours, and note what you did (a6g decision note <id> "…"). Then re-check the open questions and the other decisions like ${records.length === 1 ? "it" : "them"}.`,
  ].join("\n");
}

// The decisions still to review: flagged, with no review yet (one asked for and not applied counts as given).
export const toReview = (decisions: DecisionRecord[], controls: Control[]): DecisionRecord[] =>
  decisions.filter((d) => flagged(d) && !reviewOf(d, controls));

// How the check-ins went since `since` (ISO): the questions raised to the operator, what the team decided itself, how
// many of those it flagged and how many the operator overturned; and what waits for a review now, whenever decided.
export interface CheckIns {
  asked: number;
  decided: number;
  flagged: number;
  overturned: number;
  toReview: number;
}
export function checkIns(decisions: DecisionRecord[], tasks: Task[], controls: Control[], since: string): CheckIns {
  const recent = decisions.filter((d) => d.at >= since);
  return {
    asked: tasks.reduce((n, t) => n + t.history.filter((e) => e.to === "question" && e.by !== OPERATOR && e.at >= since).length, 0),
    decided: recent.length,
    flagged: recent.filter(flagged).length,
    overturned: recent.filter((d) => reviewOf(d, controls)?.verdict === "overturned").length,
    toReview: toReview(decisions, controls).length,
  };
}

// --- Hints ---------------------------------------------------------------------------------------------------------
// What the operator's own reviews and answers suggest about the agreement, since `since` or since the agreement in
// force was set, whichever is later: a topic they keep overturning is one to be asked about; one where they take the
// team's recommendation every time is one the team could decide. Suggestions only: the operator changes the agreement,
// or doesn't. Each says what was seen, with its numbers.

export interface Hint {
  // What to set: a topic's rule ("follow": back to the level), or, with no topic, the level.
  topic: Topic | null;
  set: TopicRule | "follow" | Level;
  why: string;
  // The option of a6g agreement that makes the change.
  flag: string;
}
// How much is enough to say so: overturns of a topic's decisions (and their share), answers that all took the
// recommendation, and the same across every topic for the level.
export const HINT_AT = { overturned: 2, share: 1 / 3, recommended: 3, levelOverturned: 3, levelRecommended: 5 } as const;

export function calibrationHints(
  decisions: DecisionRecord[],
  tasks: Task[],
  controls: Control[],
  agreement: Agreement,
  since: string,
  operator: { technical: boolean } = { technical: true }
): Hint[] {
  // Only what happened under the agreement in force counts: what came before is what it was changed for, and
  // suggesting the same change again, or the next one along, would walk the agreement on with no new evidence.
  const set = agreementOf(controls).control?.at;
  const from = set && set > since ? set : since;
  const recent = decisions.filter((d) => d.at >= from);
  const overturned = (d: DecisionRecord): boolean => reviewOf(d, controls)?.verdict === "overturned";
  // One answer a question: the last the operator gave it.
  const answers = tasks.flatMap((t) => t.notes.filter((n) => n.kind === "answer" && n.at >= from).slice(-1));
  const tighter: Hint[] = [];
  const looser: Hint[] = [];
  for (const topic of TOPICS) {
    // Not the agreement's to set: always the operator's, or never asked of an operator who isn't technical.
    if (isReserved(topic) || (topic === "technical" && !operator.technical)) continue;
    const now = agreement.topics[topic] ?? "follow";
    const made = recent.filter((d) => d.topic === topic);
    const undone = made.filter(overturned).length;
    const asked = answers.filter((n) => n.topic === topic);
    if (undone >= HINT_AT.overturned && undone / made.length >= HINT_AT.share && now !== "ask") {
      const set = now === "decide" ? "follow" : "ask";
      tighter.push({
        topic,
        set,
        why: `You overturned ${undone} of the ${made.length} ${topic} decisions the team made${now === "decide" ? ", and it never asks about them" : ""}.`,
        flag: `--${set} ${topic}`,
      });
    } else if (!undone && asked.length >= HINT_AT.recommended && asked.every((n) => n.took === "recommendation") && now !== "decide") {
      const set = now === "ask" ? "follow" : "decide";
      looser.push({
        topic,
        set,
        why: `You took the team's recommendation, as it stood, on all ${asked.length} ${topic} questions it asked${now === "ask" ? ", and it always asks about them" : ""}.`,
        flag: `--${set === "decide" ? "never" : "follow"} ${topic}`,
      });
    }
  }
  // Across topics, when no one topic explains it: a level closer, or (from hands-on only) one wider.
  const undone = recent.filter(overturned).length;
  const closer: Record<Level, Level | null> = { "hands-off": "balanced", balanced: "hands-on", "hands-on": null };
  if (!tighter.length && undone >= HINT_AT.levelOverturned && undone / recent.length >= HINT_AT.share && closer[agreement.level])
    tighter.push({
      topic: null,
      set: closer[agreement.level] as Level,
      why: `You overturned ${undone} of the ${recent.length} decisions the team made, across topics.`,
      flag: `--level ${closer[agreement.level]}`,
    });
  if (
    !looser.length &&
    !tighter.length &&
    !undone &&
    agreement.level === "hands-on" &&
    answers.length >= HINT_AT.levelRecommended &&
    answers.every((n) => n.took === "recommendation")
  )
    looser.push({
      topic: null,
      set: "balanced",
      why: `You took the team's recommendation, as it stood, on all ${answers.length} questions it asked.`,
      flag: "--level balanced",
    });
  return [...tighter, ...looser];
}
