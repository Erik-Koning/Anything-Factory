// The operator's answers to what waits on them: a question the planner or the approver asked (status question), or
// blocked work raised to them. An answer is a note by the operator, marked as one, that leaves the task where it is: the
// planner reads it, records it in decisions.md and moves the task on (approving or rejecting it outright is
// decide.ts). The web app and a6g task answer both answer through here. The lead's watchdog passes each new answer to
// the planner (lib/answers.ts), so it acts on it within a minute instead of at its next wake.
import { type Actor, type Note, nowIso, OPERATOR, Refused, type Status, type Task } from "./model.ts";
import { type Store, update } from "./store.ts";

// What waits on the operator: every question, and blocked work raised to them (with an ask: a block that waits on
// other tasks, or that the planner sorts, isn't theirs); never a journey (journeys only group tasks).
export const WAITING: readonly Status[] = ["question", "blocked"];
export const waitsOnOperator = (t: Task): boolean => t.kind !== "journey" && (t.status === "question" || (t.status === "blocked" && Boolean(t.ask)));

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// The operator answers task `id`. Throws a Refused saying why when it can't: nothing said, someone other than the
// operator, or a task that no longer waits on an answer (the planner moved it on meanwhile).
// `recommended`: the answer is the team's recommendation as it stood (the web app's choice, a6g task answer
// --recommended), in the recommendation's words; it takes none of the operator's own. `seen` is that recommendation
// as the operator read it: one the planner changed since is refused, never taken unread. `read`: the task as the
// caller read it just now (the web app's action reads it first), so it isn't read again.
export async function answer(
  store: Store,
  id: string,
  { who, text, recommended = false, seen, read }: { who: Actor; text: string; recommended?: boolean; seen?: string | undefined; read?: Task | undefined }
): Promise<Task> {
  const own = text.trim();
  if (who !== OPERATOR) throw new Refused("only the operator answers what waits on them");
  if (!own && !recommended) throw new Refused("say what your answer is");
  // In the operator's own words it's their answer, whatever it agrees with: only the recommendation as it stands is
  // counted as taken (the hints on the working agreement).
  if (own && recommended) throw new Refused("the team's recommendation is taken as it stands; to change it, say your answer in words instead");
  const wanted = id.replace(/^#/, "");
  const task = read?.id === wanted ? read : await store.tasks.get(wanted);
  if (!task) throw new Refused(`no task ${id}`);
  return update(
    store.tasks,
    task.id,
    (t) => {
      if (!waitsOnOperator(t))
        throw new Refused(
          t.kind === "design" && t.status !== "done" && t.status !== "rejected"
            ? `#${t.id}, the design check-in, isn't with you now (it's ${t.status}): the planner raises it once the foundation is built, and again once any changes you asked for are made. To end it yourself: a6g task status ${t.id} done`
            : `#${t.id} is ${t.status} now and doesn't wait on an answer: the planner moved it on`
        );
      // The words are made on every try: when the write is tried again after someone else's, the task is read again.
      let said = own;
      if (recommended) {
        const recommendation = t.ask?.recommendation.trim();
        if (!recommendation) throw new Refused(`#${t.id} carries no recommendation to go with: say what your answer is`);
        if (seen !== undefined && seen.trim() !== recommendation)
          throw new Refused(`the team changed its recommendation on #${t.id} since you read it: read it again, then answer`);
        said = `Go with your recommendation: ${recommendation}`;
      }
      const at = nowIso();
      const note: Note = {
        at,
        by: who,
        text: said,
        kind: "answer",
        ...(recommended ? { took: "recommendation" } : {}),
        ...(t.ask?.topic ? { topic: t.ask.topic } : {}),
      };
      return {
        ...t,
        notes: [...t.notes, note],
        updatedAt: at,
        history: [...t.history, { at, by: who, what: `answered: ${clip(said.replace(/\s+/g, " "), 120)}` }].slice(-200),
      };
    },
    task
  );
}

// When `t` last came to wait on the operator, and their answers since (model.ts, which the move rules read too).
export { answersOn, waitingSince } from "./model.ts";

export interface PendingAnswer {
  task: Task;
  note: Note;
  // Unique per answer: the watchdog's marker that it went to the planner.
  key: string;
}

// An answer's key: the name of the watchdog's marker that it went to the planner.
export const answerKey = (task: Pick<Task, "id">, note: Pick<Note, "at">): string => `answer-${task.id}-${Date.parse(note.at)}`;

// The answers to pass to the planner: on tasks still waiting on the operator, given at or after `since` (ISO), oldest
// first. The watchdog leaves out those it passed on already, by key.
export function answersSince(tasks: Task[], since: string): PendingAnswer[] {
  return tasks
    .filter(waitsOnOperator)
    .flatMap((task) => task.notes.filter((n) => n.kind === "answer" && n.at >= since).map((note) => ({ task, note, key: answerKey(task, note) })))
    .sort((a, b) => a.note.at.localeCompare(b.note.at));
}

// The operator's decisions on what waited for them to decide (a proposal, or one escalated to them): approved,
// rejected or sent back for research, from the web app or a6g task approve|reject|research. Passed on like answers, so
// approved work is started within a minute rather than at the planner's next tick, which is slow while the team has
// nothing but their decisions to wait for (the watchdog).
export interface PendingDecision {
  task: Task;
  at: string;
  what: string;
  key: string;
}
const DECIDED = /^(proposed|question) → (approved|rejected|researching)\b/;
export function decisionsSince(tasks: Task[], since: string): PendingDecision[] {
  return tasks
    .flatMap((task) =>
      task.history
        .filter((h) => h.by === OPERATOR && h.at >= since && DECIDED.test(h.what))
        .map((h) => ({ task, at: h.at, what: h.what, key: `decided-${task.id}-${Date.parse(h.at)}` }))
    )
    .sort((a, b) => a.at.localeCompare(b.at));
}

// One message to the planner for every answer that came since it last heard.
export function answersMessage(answers: PendingAnswer[]): string {
  const lines = answers.map(({ task, note }, i) => `${i + 1}. #${task.id} "${task.title}" (${task.status}): ${note.text}`);
  return [
    `The operator answered what waits on them:`,
    "",
    ...lines,
    "",
    `Each answer is a note on its task already (a6g task show <id>), so don't note it again. Act on it as your rules say: add it to .a6g/decisions.md, re-check the other open questions against it, and move each task on.`,
  ].join("\n");
}

// One message to the planner for the operator's decisions since it last heard.
export function decisionsMessage(decisions: PendingDecision[]): string {
  const lines = decisions.map(({ task, what }, i) => `${i + 1}. #${task.id} "${task.title}": ${what}`);
  return [
    `The operator decided on what waited for them:`,
    "",
    ...lines,
    "",
    `Each is on its task already (a6g task show <id>). Start what's approved as your rules say, and take a rejection's or a research request's reasons into what you propose next.`,
  ].join("\n");
}
