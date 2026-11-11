// What the Decided for you and Agreement pages show, worked out from a team's decision log and the operator's controls
// (never stored): the decisions to review, the rest of the record, what was overturned, each topic as the agreement
// has it, and the agreement's earlier versions. Pure: the pages and the team's tab count read it, and the unit tests
// prove it.
import {
  type Agreement,
  type AgreementContact,
  agreementChanges,
  CONTACT_EVERY,
  DEFAULT_AGREEMENT,
  isLevel,
  isReserved,
  normalised,
  type Topic,
  TOPIC_MEANS,
  type TopicRule,
  TOPICS,
} from "../../lib/tasks/agreement.ts";
import type { Control } from "../../lib/tasks/controls.ts";
import { type DecisionRecord, flagged, type Hint, overturnedSince, type Review, reviewOf } from "../../lib/tasks/decisions.ts";
import type { TeamSettings, TeamState } from "../../lib/tasks/teams.ts";

export interface Decided {
  record: DecisionRecord;
  // The team thought the operator would want to see it.
  flagged: boolean;
  // The review in force: written on the record, or asked for and waiting for the team's machine to write it (pending).
  review: (Review & { pending: boolean }) | null;
  // Overturned, written on the record, and the planner hasn't noted what it did since.
  withPlanner: boolean;
}

export interface DecidedLog {
  // Flagged and not reviewed yet, longest waiting first.
  toReview: Decided[];
  // Everything else that stands (agreed, or never flagged), newest first.
  standing: Decided[];
  // What the operator overturned, newest first.
  overturned: Decided[];
}

export function decided(record: DecisionRecord, controls: Control[]): Decided {
  const review = reviewOf(record, controls);
  // From when the team's machine wrote the overturn onto the record: what the planner noted before wasn't about it.
  const since = overturnedSince(record);
  return {
    record,
    flagged: flagged(record),
    review,
    withPlanner: since !== null && !record.notes.some((n) => n.by === "planner" && n.at >= since),
  };
}

export function decidedLog(decisions: DecisionRecord[], controls: Control[]): DecidedLog {
  const all = decisions.map((d) => decided(d, controls));
  const newest = (a: Decided, b: Decided): number =>
    b.record.at.localeCompare(a.record.at) || b.record.id.localeCompare(a.record.id, "en", { numeric: true });
  return {
    toReview: all.filter((d) => d.flagged && !d.review).sort((a, b) => newest(b, a)),
    standing: all.filter((d) => d.review?.verdict !== "overturned" && !(d.flagged && !d.review)).sort(newest),
    overturned: all
      .filter((d) => d.review?.verdict === "overturned")
      .sort((a, b) => (b.review?.at ?? "").localeCompare(a.review?.at ?? "") || newest(a, b)),
  };
}

// What a grade means (lib/tasks/agreement.ts), which the planner's rules say of "the operator", said to them.
export const toYou = (means: string): string =>
  means
    .replace(/\bthe operator has\b/g, "you have")
    .replace(/\bthe operator's\b/g, "your")
    .replace(/\bthe operator\b/g, "you");

// Which agreement a decision was made under, in words: its control, or the default nobody had changed.
export const underAgreement = (agreement: string | null | undefined): string => (agreement ? `agreement ${agreement}` : "the default agreement");

// A team whose settings say who it works for was published by a factory version that reads the agreement and keeps the
// log (a6g register publishes `operator` with them); one without neither reads nor writes either yet.
export const readsAgreement = (team: Pick<TeamSettings, "operator">): boolean => team.operator !== undefined;

// A topic as the agreement has it: follows the level, always asked or never asked; and where that isn't the
// agreement's to set, why (always the operator's, or never asked of an operator who isn't technical).
export type TopicSetting = "follow" | TopicRule;
export interface TopicRow {
  topic: Topic;
  means: string;
  setting: TopicSetting;
  locked: "always" | "never" | null;
}
export function topicRows(agreement: Agreement, operator: { technical: boolean } = { technical: true }): TopicRow[] {
  return TOPICS.map((topic) => ({
    topic,
    means: TOPIC_MEANS[topic],
    setting: agreement.topics[topic] ?? "follow",
    locked: isReserved(topic) ? "always" : topic === "technical" && !operator.technical ? "never" : null,
  }));
}

// The agreement's versions, newest first: each with what it changed from the one before (the first, from the default).
export interface AgreementVersion {
  control: Control;
  agreement: Agreement;
  changes: string[];
  current: boolean;
}
export function agreementHistory(controls: Control[]): AgreementVersion[] {
  let before = DEFAULT_AGREEMENT;
  const versions = controls
    .filter((c) => c.kind === "agreement" && c.agreement)
    .map((control): AgreementVersion => {
      const agreement = normalised(control.agreement);
      const changes = agreementChanges(before, agreement);
      before = agreement;
      return { control, agreement, changes, current: false };
    });
  const last = versions.at(-1);
  if (last) last.current = true;
  return versions.reverse();
}

// Whether the agreement in force was set since the team's machine last reported: the commands follow it already (they
// read the newest), but the planner may not have been told yet.
export const agreementPending = (status: TeamState | null, control: Control | null): boolean => control !== null && (!status || control.at > status.at);

// A topic as a page names it.
export const topicName = (topic: Topic): string => `${topic.charAt(0).toUpperCase()}${topic.slice(1)}`;

// What a hint suggests (lib/tasks/decisions.ts calibrationHints), in the words of the form that would make the change:
// a topic always asked, never asked or given back to the level, or the level moved.
export function hintSays(hint: Pick<Hint, "topic" | "set">): string {
  if (hint.topic === null) return isLevel(hint.set) ? `Move the level to ${hint.set}` : "Change the level";
  const name = topicName(hint.topic);
  if (hint.set === "ask") return `Set ${name} to Always ask me`;
  if (hint.set === "decide") return `Never ask about ${name}`;
  return `Give ${name} back to the level`;
}

// How often a message may reach the operator, as the agreement's form has it: the team's own settings, a digest with
// its window in hours, or each as soon as it's needed.
export const MESSAGES = ["team", "digest", "priority"] as const;
export type Messages = (typeof MESSAGES)[number];
export const DIGEST_HOURS = { min: CONTACT_EVERY.min / 60, max: CONTACT_EVERY.max / 60, usual: 4 } as const;

// The form's fields for the agreement's contact: what's chosen, and the digest's window in hours (the usual one until
// a digest is set, so choosing it starts from something).
export function messagesFields(contact: AgreementContact | undefined): { messages: Messages; every: string } {
  if (!contact) return { messages: "team", every: String(DIGEST_HOURS.usual) };
  if (contact.mode === "priority") return { messages: "priority", every: String(DIGEST_HOURS.usual) };
  return { messages: "digest", every: String(Number((contact.everyMin / 60).toFixed(2))) };
}

// The agreement's contact from the form's fields: none (the team's own settings hold), or what's wrong with them. The
// window is hours on the page and minutes in the agreement, which checks its range again.
export function contactOfForm(messages: string, every: string): { contact: AgreementContact | undefined } | { problem: string } {
  if (messages === "" || messages === "team") return { contact: undefined };
  if (messages === "priority") return { contact: { mode: "priority", everyMin: 0 } };
  if (messages !== "digest") return { problem: "Choose how often a message may reach you." };
  const hours = Number(every.trim().replace(",", "."));
  if (!every.trim() || !Number.isFinite(hours) || hours < DIGEST_HOURS.min || hours > DIGEST_HOURS.max)
    return {
      problem: `A digest goes at most once every so many hours, from ${DIGEST_HOURS.min} (a quarter of an hour) to ${DIGEST_HOURS.max} (a week): say how many.`,
    };
  return { contact: { mode: "digest", everyMin: Math.round(hours * 60) } };
}
