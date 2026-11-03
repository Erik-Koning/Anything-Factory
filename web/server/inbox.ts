// What waits on the operator, worked out from a team's graph (never stored): the questions the planner or the approver
// asked them, the work that's blocked, what they answered that the planner hasn't acted on yet, and what was settled
// lately. Pure: the inbox pages, the header's count and the notifier read it, and the unit tests prove it.
import { answersOn, waitingSince, waitsOnOperator } from "../../lib/tasks/answer.ts";
import { type Note, OPERATOR, type Status, type Task } from "../../lib/tasks/model.ts";

// One of the options a question offers ("(a) keep them hidden …"), as the answer form shows it.
export interface Choice {
  key: string;
  text: string;
  recommended: boolean;
}

export interface Waiting {
  task: Task;
  // When it came to wait on the operator, who put it there and why (the move's reason).
  since: string;
  askedBy: string;
  why: string | null;
  // The text that puts the question: the newest note by the team with options or a recommendation in it, otherwise
  // the task's description; what it found there; and the text without them, to show above the answer form's choices.
  question: { text: string; by: string | null; at: string | null; shown: string };
  choices: Choice[];
  recommendation: string | null;
  // The operator's answers since it came to wait (an answered one waits on the planner now).
  answers: Note[];
  // Work that can't go on until it's settled: tasks that come after it, and its journey.
  holds: Task[];
  journey: Task | null;
  // Other tasks waiting on the operator that it mentions (#21 asks together with #39).
  related: Task[];
}

export interface Settled {
  task: Task;
  // What happened to it, by whom and when; and the operator's answer before, if they gave one.
  to: Status;
  by: string;
  at: string;
  answer: Note | null;
}

export interface Inbox {
  questions: Waiting[];
  blocked: Waiting[];
  // Answered, waiting for the planner to act.
  answered: Waiting[];
  settled: Settled[];
}

const MARK = /(?:^|[\s:;,—-])\(([a-e])\)\s+/g;

// The options in `text`, "(a) … (b) …", from "Options:" when it says so, up to the recommendation: at least two, from
// (a) on in order, or none.
export function choicesIn(text: string): { key: string; text: string }[] {
  const start = text.search(/\boptions\b[^:\n]{0,20}:/i);
  const from = start >= 0 ? start : 0;
  const rest = text.slice(from);
  const stop = rest.search(/\brecommend(?:ation|ed)?\b/i);
  const segment = stop > 0 ? rest.slice(0, stop) : rest;
  const marks = [...segment.matchAll(MARK)].map((m) => ({ key: m[1] ?? "", at: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const run: typeof marks = [];
  for (const m of marks) if (m.key === String.fromCharCode(97 + run.length)) run.push(m);
  if (run.length < 2) return [];
  return run.map((m, i) => ({
    key: m.key,
    text: tidy(segment.slice(m.end, run[i + 1]?.at ?? segment.length)),
  }));
}

const tidy = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s;,]+(or|and)$/i, "")
    .replace(/[\s;,.]+$/, "");

// Where the team's recommendation is in `text`: from "Recommendation:" (or "recommendation if yes:") to the end of
// the sentence after it, and that sentence.
function recommendationAt(text: string): { text: string; start: number; end: number } | null {
  const found = /\brecommend(?:ation|ed)?\b[^:\n]{0,24}:\s*/i.exec(text);
  if (!found) return null;
  const from = found.index + found[0].length;
  const rest = text.slice(from);
  const stop = rest.search(/(?<=[.!?])\s+(?=[A-Z])|\n\n/);
  const sentence = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
  return sentence ? { text: sentence.replace(/\s+/g, " "), start: found.index, end: stop >= 0 ? from + stop : text.length } : null;
}
export const recommendationIn = (text: string): string | null => recommendationAt(text)?.text ?? null;

// `text` without the options and the recommendation, which the answer form offers instead: what comes before them,
// and what follows the recommendation's sentence.
export function withoutChoices(text: string): string {
  const options = choicesIn(text).length ? text.search(/\boptions\b[^:\n]{0,20}:/i) : -1;
  const recommendation = recommendationAt(text);
  const starts = [options, recommendation?.start ?? -1].filter((i) => i >= 0);
  if (!starts.length) return text;
  const before = text
    .slice(0, Math.min(...starts))
    .trim()
    .replace(/[\s;,:]+$/, "");
  const after = recommendation ? text.slice(recommendation.end).trim() : "";
  return [before && !/[.!?)]$/.test(before) ? `${before}.` : before, after].filter(Boolean).join(" ");
}

// Which option a recommendation names first: "(b) with any edits …" → b.
export const recommendedKey = (recommendation: string | null): string | null => /^\(?([a-e])\)/.exec(recommendation ?? "")?.[1] ?? null;

// Where the question is put: the newest note by the team (not the operator) with options or a recommendation,
// otherwise the description.
function questionOf(task: Task): Waiting["question"] & { choices: Choice[]; recommendation: string | null } {
  const sources: Omit<Waiting["question"], "shown">[] = [
    ...task.notes
      .filter((n) => n.by !== OPERATOR)
      .reverse()
      .map((n) => ({ text: n.text, by: n.by, at: n.at })),
    { text: task.body, by: null, at: null },
  ];
  const found = sources.find((s) => choicesIn(s.text).length || recommendationIn(s.text)) ?? { text: task.body, by: null, at: null };
  const recommendation = recommendationIn(found.text);
  const key = recommendedKey(recommendation);
  const choices = choicesIn(found.text).map((c) => ({ ...c, recommended: c.key === key }));
  return { ...found, shown: choices.length || recommendation ? withoutChoices(found.text) : found.text, recommendation, choices };
}

// The task ids `text` mentions ("#21", "tasks 56, 59").
export const mentions = (text: string): string[] => [...new Set([...text.matchAll(/#([1-9]\d{0,8})\b/g)].map((m) => m[1] ?? ""))];

export function waitingOf(task: Task, all: Task[]): Waiting {
  const byId = new Map(all.map((t) => [t.id, t]));
  const since = waitingSince(task);
  const moved = task.history.findLast((e) => e.to === task.status);
  const why = moved ? (/^\S+ → \S+: (.+)$/s.exec(moved.what)?.[1] ?? null) : null;
  const { choices, recommendation, ...question } = questionOf(task);
  const text = [task.body, ...task.notes.map((n) => n.text)].join("\n");
  return {
    task,
    since,
    askedBy: moved?.by ?? task.by,
    why,
    question,
    choices,
    recommendation,
    answers: answersOn(task),
    holds: all.filter((t) => t.after.includes(task.id) && t.status !== "done" && t.status !== "rejected"),
    journey: task.parent ? (byId.get(task.parent) ?? null) : null,
    related: mentions(text)
      .filter((id) => id !== task.id)
      .flatMap((id) => {
        const t = byId.get(id);
        return t && waitsOnOperator(t) ? [t] : [];
      }),
  };
}

// The team's inbox: unanswered questions and blocked work (longest waiting first), what's answered, and what left the
// inbox in the last `settledDays` days, newest first.
export function inbox(tasks: Task[], { now = Date.now(), settledDays = 7 } = {}): Inbox {
  const waiting = tasks.filter(waitsOnOperator).map((t) => waitingOf(t, tasks));
  const oldestFirst = (a: Waiting, b: Waiting) => a.since.localeCompare(b.since) || Number(a.task.id) - Number(b.task.id);
  const after = new Date(now - settledDays * 86_400_000).toISOString();
  const settled = tasks
    .filter((t) => t.kind !== "journey" && !waitsOnOperator(t))
    .flatMap((t): Settled[] => {
      const left = t.history.findLast((e) => (e.from === "question" || e.from === "blocked") && e.at >= after);
      if (!left?.to) return [];
      const answer = t.notes.findLast((n) => n.kind === "answer" && n.at <= left.at) ?? null;
      return [{ task: t, to: left.to as Status, by: left.by, at: left.at, answer }];
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  return {
    questions: waiting.filter((w) => w.task.status === "question" && !w.answers.length).sort(oldestFirst),
    blocked: waiting.filter((w) => w.task.status === "blocked" && !w.answers.length).sort(oldestFirst),
    answered: waiting.filter((w) => w.answers.length).sort((a, b) => (a.answers.at(-1)?.at ?? "").localeCompare(b.answers.at(-1)?.at ?? "")),
    settled,
  };
}

// How many things wait on the operator now (answered ones are the planner's).
export const waitingCount = (tasks: Task[]): number => tasks.filter((t) => waitsOnOperator(t) && !answersOn(t).length).length;

// The answer as the planner reads it, from the form: the option chosen (or the recommendation) and what was added.
export function answerText(
  pick: string,
  extra: string,
  { choices, recommendation }: { choices: { key: string; text: string }[]; recommendation: string | null }
): { text: string } | { problem: string } {
  const added = extra.trim();
  const choice = choices.find((c) => c.key === pick);
  let lead: string;
  if (pick === "recommended" && recommendation) lead = `Go with your recommendation: ${recommendation}`;
  else if (choice) lead = `(${choice.key}) ${choice.text}.`;
  else if (pick === "" || pick === "other") lead = "";
  else return { problem: "Choose one of the options, or write your own answer." };
  if (!lead && !added) return { problem: choices.length || recommendation ? "Choose an option, or write your answer." : "Write your answer." };
  return { text: [lead, added].filter(Boolean).join("\n\n") };
}
