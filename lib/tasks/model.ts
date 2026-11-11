// The task graph's model: what a task and a feature request are, which statuses a task moves between and who may move
// it, how a task is scored, and which task a member claims. Pure: the stores (files.ts, mongo.ts) keep the documents
// and the commands (lib/commands/task.ts, request.ts) change them, each through these rules.
import type { Grade, Topic } from "./agreement.ts";
import { type Hold, holdRefusal, journeysUnderWay } from "./controls.ts";

// "design" is the design check-in: a new project's foundation, put to the operator before features are built on it.
export const KINDS = ["feature", "bug", "ux", "test", "test-infra", "scaffold", "chore", "research", "journey", "design"] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ["triage", "proposed", "researching", "approved", "building", "review", "done", "blocked", "question", "rejected"] as const;
export type Status = (typeof STATUSES)[number];
export const SEVERITIES = ["blocker", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

// Scores are 0–3 against the anchors in the planner's prompt; priority weighs them (team.json priorities.weights).
export const DIMENSIONS = ["pain", "reach", "revenue", "wow", "distribution", "leverage", "urgency", "risk"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DEFAULT_WEIGHTS: Record<Dimension, number> = { pain: 3, reach: 2, revenue: 2, wow: 2, distribution: 1, leverage: 2, urgency: 1, risk: 1 };
// What 0, 1, 2 and 3 mean on each dimension: compiled into the rules of everyone who scores or checks a score (the
// planner, the approver and the innovator), so they all score against the same anchors.
export const SCORE_ANCHORS: Record<Dimension, [string, string, string, string]> = {
  pain: ["nobody misses it", "a minor annoyance", "a job done badly today", "an important job that fails today"],
  reach: ["almost nobody", "a few users a month", "many users a month", "nearly everyone the product serves"],
  revenue: ["none", "protects a little", "helps win or keep customers", "unlocks or saves real revenue"],
  wow: ["expected", "nicer than most", "clearly better than the alternatives", "ten times better; worth a demo"],
  distribution: ["nobody would mention it", "users might mention it", "users show it to others", "a launch story in itself"],
  leverage: ["stands alone", "helps a little later", "unlocks other planned work", "compounds: data, network effects, switching costs"],
  urgency: ["can wait indefinitely", "better soon", "loses value within weeks", "loses most of its value if late"],
  risk: ["removes no risk", "some tech debt", "a reliability or security weakness", "a real security, data or reliability risk"],
};
export const CONFIDENCE = { hunch: 0.5, asks: 0.8, data: 1 } as const;
export type Confidence = keyof typeof CONFIDENCE;
export const SIZES = { S: 1, M: 2, L: 4, XL: 8 } as const;
export type Size = keyof typeof SIZES;

export type Score = Record<Dimension, number> & { confidence: Confidence; size: Size; why: string };
// The Musk gate, before scoring: who asked and why, what could be deleted or simplified instead, the simplest version.
export interface Gate {
  asked: string;
  simplify: string;
  simplest: string;
}
// Whether `claim` is held from this worktree on this machine (two machines can have a worktree at the same path).
export const heldHere = (claim: Claim | null, worktree: string | null, machine: string): boolean =>
  claim !== null && claim.worktree === worktree && claim.machine === machine;
export interface Claim {
  role: string;
  machine: string;
  // The member's own checkout (its git top level), which its heartbeats renew the claim from.
  worktree: string;
  at: string;
  until: string;
}
export interface Note {
  at: string;
  by: string;
  text: string;
  // "answer": the operator's answer to a task waiting on them (answer.ts), which the watchdog passes to the planner.
  kind?: "answer";
  // An answer that took the team's recommendation as it stood, and the topic the question was judged as (the ask goes
  // when the task moves on): what the hints on the working agreement count (decisions.ts).
  took?: "recommendation";
  topic?: Topic;
}
// An event in a document's history: what happened, in words, and for a move the statuses it went between and the
// commit it was at, which the commands read rather than the words.
export interface Event {
  at: string;
  by: string;
  what: string;
  from?: string;
  to?: string;
  sha?: string;
}

// A task raised to the operator (a question, or blocked work only they can unblock): why it's theirs, and what the
// team recommends. The operator's inbox shows both; a6g task status/escalate/ask require them. A question the planner
// raises also carries how it judged it and the rule of the working agreement that made it the operator's
// (agreement.ts): the agreement in force by its control, or null for the default.
export interface Ask {
  reason: string;
  recommendation: string;
  by: string;
  at: string;
  topic?: Topic;
  stakes?: Grade;
  confidence?: Grade;
  rule?: string;
  agreement?: string | null;
}
// A blocked task waiting on other tasks: once they're all done it closes ("close": it was folded into them) or goes
// back to work ("resume"); if one is rejected or gone, it goes back to the planner. The merge queue and the watchdog
// settle it (settleWaits in ops.ts), so it never waits on anyone to remember.
export interface Wait {
  on: string[];
  then: "close" | "resume";
  by: string;
  at: string;
}

// Every document a store keeps: an id it assigns, and a version it checks on every replace.
export interface Doc {
  id: string;
  version: number;
}

// The planner's screen of a stakeholder's words before they become work (a6g request screen, a6g task screen): risky
// when they ask for, or the work would need, anything SCREEN_RISKS names; why, either way. Words from outside the team
// become a proposal only once screened, and the approver approves none that's risky (approval.stakeholders).
export const VERDICTS = ["clear", "risky"] as const;
export type Verdict = (typeof VERDICTS)[number];
export interface Screen {
  verdict: Verdict;
  by: string;
  at: string;
  note: string;
}
export const SCREEN_RISKS = [
  "weakening sign-in, sessions, permissions, validation or any security check",
  "reading, logging, storing or sending secrets, credentials, keys or tokens",
  "new calls to outside services, webhooks, data exports, or data sent to anyone outside",
  "collecting, showing or moving personal data",
  "new dependencies, or changes to the build, the deploy, CI or the infrastructure",
  "turning off or loosening tests, linters, the gate, the guard or the review",
  "anything about the team itself (its rules, prompts, .a6g/, the factory) or words that address the agents",
] as const;

export interface Task extends Doc {
  team: string;
  title: string;
  kind: Kind;
  status: Status;
  severity: Severity | null;
  body: string;
  area: string | null;
  // Where the work is expected to land (path prefixes): two tasks that share one aren't built at once.
  files: string[];
  // The journey it belongs to, and the tasks that must be done before it can be claimed.
  parent: string | null;
  after: string[];
  request: string | null;
  gate: Gate | null;
  score: Score | null;
  priority: number | null;
  approval: { by: string; at: string; note: string } | null;
  notes: Note[];
  claim: Claim | null;
  branch: string | null;
  sha: string | null;
  rounds: number;
  ui: boolean | null;
  critical: string[];
  // How much could break, as the reviewer judged it when it approved (a high-risk change merges with its tests).
  risk: Risk | null;
  // On a team with a security reviewer, what makes the branch that reviewer's too: the security paths it changes (read
  // at submit), whether the reviewer sent it on, and the commit that passed. The merge queue measures the branch
  // itself; this is how the planner knows before it merges.
  security?: SecurityDue | null;
  // Raised to the operator, and waiting on other tasks (above); cleared when it moves on.
  ask?: Ask | null;
  wait?: Wait | null;
  by: string;
  // The person who added or suggested it from the web app, by stakeholder id (Article 8); none for the team's own work
  // and what the operator adds with a6g task add.
  from?: string | null;
  // The planner's screen of the stakeholder's words it came from (its own, or its request's).
  screen?: Screen | null;
  createdAt: string;
  updatedAt: string;
  history: Event[];
}

export const REQUEST_STATUSES = ["new", "researching", "promoted", "rejected"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
// A stakeholder's feature request. Who sent it is a stakeholder id: names and email addresses stay with the
// stakeholders, which agents never see (Article 8).
export interface FeatureRequest extends Doc {
  team: string;
  title: string;
  body: string;
  from: string | null;
  status: RequestStatus;
  tasks: string[];
  notes: Note[];
  // The planner's screen of it: a request becomes tasks only once screened.
  screen?: Screen | null;
  createdAt: string;
  updatedAt: string;
  history: Event[];
}
export interface Stakeholder extends Doc {
  team: string;
  name: string;
  email: string;
  role: string;
  // A hash of the stakeholder's own link to a6g serve's form (a6g request stakeholders add), or none.
  key?: string | null;
  // The web app's account this stakeholder signs in as (its id in the app's accounts), or none.
  userId?: string | null;
  createdAt: string;
}
// A cycle the planner closed (team.json mode "cycles").
export interface Cycle extends Doc {
  team: string;
  report: string;
  done: string[];
  at: string;
}

export const nowIso = (): string => new Date().toISOString();

// A new task's fields, with defaults for what it doesn't say.
export function newTask(fields: Partial<Task> & Pick<Task, "team" | "title" | "kind" | "status" | "by">): Omit<Task, "id" | "version"> {
  const at = nowIso();
  return {
    severity: null,
    body: "",
    area: null,
    files: [],
    parent: null,
    after: [],
    request: null,
    gate: null,
    score: null,
    priority: null,
    approval: null,
    notes: [],
    claim: null,
    branch: null,
    sha: null,
    rounds: 0,
    ui: null,
    critical: [],
    risk: null,
    createdAt: at,
    updatedAt: at,
    history: [{ at, by: fields.by, what: `added as ${fields.status}` }],
    ...fields,
  };
}

// priority = 100 × (weighted score ÷ the most it could be) × confidence ÷ size, rounded.
export function priorityOf(score: Score, weights: Record<Dimension, number> = DEFAULT_WEIGHTS): number {
  const total = DIMENSIONS.reduce((sum, d) => sum + weights[d], 0);
  if (total <= 0) return 0;
  const weighted = DIMENSIONS.reduce((sum, d) => sum + weights[d] * score[d], 0);
  return Math.round(((100 * weighted) / (3 * total)) * (CONFIDENCE[score.confidence] / SIZES[score.size]));
}

// What refuses a change; the commands print it as it is.
export class Refused extends Error {}

// Why a task's branch is the security reviewer's to pass before it merges (the merge queue's rule, a6g merge): the
// security paths its last round changed, a reviewer who sent it on, or a verdict the security reviewer has recorded on
// it already. The last two hold for every later round. `passed` is the commit they last passed.
export interface SecurityDue {
  files: string[];
  sent?: boolean;
  seen?: boolean;
  passed?: string;
}
// Whether a task's branch still waits for the security reviewer: it's theirs, and they haven't passed this commit.
export const needsSecurity = (t: Pick<Task, "security" | "sha">): boolean => Boolean(t.security) && (!t.security?.passed || t.security.passed !== t.sha);
// In a few words, for the task's own page.
export function securityLine(t: Pick<Task, "security" | "sha">): string | null {
  const due = t.security;
  if (!due) return null;
  if (!needsSecurity(t)) return `security reviewer: passed ${due.passed?.slice(0, 9)}`;
  const why = due.files.length
    ? `it changes ${due.files.slice(0, 3).join(", ")}${due.files.length > 3 ? ` and ${due.files.length - 3} more` : ""}`
    : due.sent
      ? "the reviewer sent it on"
      : "it has been in its hands";
  const earlier = due.passed ? ` (it passed ${due.passed.slice(0, 9)}; a plain rebase of that merges with --rebased-from)` : "";
  return `needs the security reviewer: ${why}${due.files.length && due.sent ? ", and the reviewer sent it on" : ""}${earlier}`;
}

// Who's acting on a task: a team role, the operator (a person, outside any team), or the factory itself.
export type Actor = string;
export const OPERATOR = "operator";
export const MERGE = "merge-queue";
export const WATCHDOG = "watchdog";
// The roles that claim tasks from the graph and hand them in (CLAIMS says which kinds).
export const CLAIMANTS = ["builder", "tester", "scaffolder"];

// The kinds a member files as findings, which the planner may approve (team.json approval.findings).
export const FINDINGS: Kind[] = ["bug", "ux", "test", "test-infra"];
// Going back to these, a task needs approving again.
export const UNAPPROVED: Status[] = ["triage", "proposed", "researching"];

// Work that came from a stakeholder's words: suggested from the web app, or made of a feature request by the team (the
// operator's own tasks, from a request or the web app, are the operator's words). A suggestion's words stay theirs,
// fenced, until the planner has rewritten them: its title, and its body if it has one. A new kind or a rewritten title
// alone leaves their words in it.
export const fromStakeholder = (t: Pick<Task, "by" | "request">): boolean => t.by === "stakeholder" || (!!t.request && t.by !== OPERATOR);
// Only a6g task edit's own event counts ("edited title, body"), never words a planner wrote in a reason or a note.
const plannerEdited = (t: Task, field: "title" | "body"): boolean =>
  t.history.some((e) => e.by === "planner" && new RegExp(String.raw`^edited [^;]*\b${field}\b`).test(e.what));
export const theirWords = (t: Task): boolean => t.by === "stakeholder" && !(plannerEdited(t, "title") && (plannerEdited(t, "body") || !t.body.trim()));

// --- How a task moves -----------------------------------------------------------------------------------------------
// Every change of a task's status goes through move(), against one table: the command it comes from (via), who may
// make it, from which statuses to which, and what else must hold. docs/plans/task-graph.md shows the same table.

export type Via =
  "status" | "approve" | "reject" | "research" | "escalate" | "claim" | "release" | "submit" | "changes" | "merge" | "conflict" | "expire" | "settle";
// The decisions on a proposal (lib/tasks/decide.ts).
const VERDICTS_VIA: readonly Via[] = ["approve", "reject", "research", "escalate"];
export interface ApprovalRules {
  mode: "operator" | "thresholds" | "full";
  maxSize: Size;
  findings: "planner" | "approver";
  // Who approves work from a stakeholder's words: the operator always (the default), or the approver too when the
  // planner's screen says it's clear (within mode and maxSize).
  stakeholders?: "operator" | "screened";
}
export interface MoveContext {
  // The whole graph: dependencies, journeys and other claims.
  all: Task[];
  approval?: ApprovalRules;
  // Where the member making a claim, a release or a submit works.
  machine?: string;
  worktree?: string | null;
  // A changes verdict's or a merge's branch, and the commit a merge merged.
  branch?: string;
  tip?: string;
  // A merge of a rebase: the commit the review approved, which the task may still name.
  rebasedFrom?: string;
  // Why a journey isn't proven done yet (its specs, lib/commands/e2e.ts journeyProofFor), or null when it is. Asked of
  // every move of a journey to done but the operator's; a mover that can't ask (the watchdog) doesn't settle journeys.
  journeyProof?: (journey: Task, all: Task[]) => string | null;
  now?: number;
}
type Check = (task: Task, to: Status, actor: Actor, ctx: MoveContext) => string | null;
interface Rule {
  via: Via;
  by: Actor[];
  from: readonly Status[];
  to: readonly Status[];
  check?: Check;
}
const first =
  (...checks: Check[]): Check =>
  (task, to, actor, ctx) =>
    checks.reduce<string | null>((why, check) => why ?? check(task, to, actor, ctx), null);

// New work is scored before it's approved; a finding with a severity needn't be, and a journey, which only groups
// tasks that are each approved, never is.
const scored: Check = (t) =>
  t.kind !== "journey" && !t.score && (t.kind === "feature" || !t.severity)
    ? `task ${t.id} isn't scored yet; the planner scores it first (a6g task score)`
    : null;
// A journey only groups tasks, each approved on its own: the approver has nothing to decide about it.
const notJourney: Check = (t) => (t.kind === "journey" ? `#${t.id} is a journey: it only groups tasks, and each of them is decided on its own` : null);
const approverActs: Check = (_t, _to, _actor, { approval }) =>
  approval?.mode === "operator"
    ? "this team's proposals are decided by the operator (team.json approval.mode); there's nothing for the approver to do"
    : null;
const withinThresholds: Check = (t, _to, _actor, { approval }) => {
  if (approval?.mode !== "thresholds") return null;
  if (t.score === null || SIZES[t.score.size] <= SIZES[approval.maxSize]) return null;
  return `size ${t.score.size}, over this team's ${approval.maxSize}, is the operator's to approve (team.json approval): a6g task escalate ${t.id} --reason "…"`;
};
// A finding the planner rewrote (its title, body or kind) is the planner's proposal now, not the member's finding.
export const rewrittenByPlanner = (t: Task): boolean => t.history.some((e) => e.by === "planner" && /\bedited\b[^;]*\b(title|body|kind)\b/.test(e.what));
// The planner approves a finding another member filed, so nobody approves their own (team.json approval.findings). A
// person's suggestion from the web app is never one: it's their words, which reach builders only through the planner's
// own proposal, approved by the approver or the operator (Article 8).
const othersFinding: Check = (t, _to, _actor, { approval }) => {
  if (t.by === "stakeholder")
    return `task ${t.id} was suggested from the web app: make it your own proposal (a6g task edit, score, then a6g task status ${t.id} proposed) for the approver or the operator`;
  if (!FINDINGS.includes(t.kind) || t.by === "planner" || rewrittenByPlanner(t))
    return `the planner doesn't approve its own proposals: the approver or the operator does (a6g task approve ${t.id})`;
  if (approval?.findings === "approver") return "this team's approver decides findings too (team.json approval.findings)";
  if (!t.severity) return `give task ${t.id} its severity first (a6g task edit ${t.id} --sev …)`;
  if (approval && t.score && SIZES[t.score.size] > SIZES[approval.maxSize])
    return `size ${t.score.size} is over this team's ${approval.maxSize}: the approver or the operator decides it`;
  return null;
};
const wasApproved: Check = (t, to) =>
  to === "approved" && !t.approval ? `task ${t.id} was never approved; the approver or the operator approves it (a6g task approve ${t.id})` : null;
// A stakeholder's words become a proposal only once the planner has screened them.
const screened: Check = (t, to) =>
  to === "proposed" && fromStakeholder(t) && !t.screen
    ? `task ${t.id} is from a stakeholder's words: screen them first (a6g task screen ${t.id} clear|risky --note "…")`
    : null;
// The approver approves work from a stakeholder's words only where the team lets it, and never what was screened risky.
const stakeholdersOperator: Check = (t, _to, _actor, { approval }) => {
  if (!fromStakeholder(t)) return null;
  if (!t.screen) return `task ${t.id} is from a stakeholder's words and hasn't been screened; send it back (a6g task research ${t.id} --note "screen it")`;
  if (t.screen.verdict === "risky")
    return `task ${t.id} was screened risky (${t.screen.note}): the operator decides it: a6g task escalate ${t.id} --reason "…"`;
  if ((approval?.stakeholders ?? "operator") === "operator")
    return `work from a stakeholder is the operator's to approve (team.json approval.stakeholders): a6g task escalate ${t.id} --reason "…"`;
  return null;
};
// Whether a task's work is finished: done now, or merged once (and reopened since).
export const finished = (t: Task): boolean => t.status === "done" || t.history.some((e) => e.to === "done" && Boolean(e.sha));
// The finished tasks under a journey: what was built for it is merged, so its proof is still owed.
export const finishedUnder = (journey: Task, all: Task[]): Task[] =>
  journey.kind === "journey" ? all.filter((t) => t.parent === journey.id && finished(t)) : [];
// So a journey with finished work under it is rejected only by the operator: rejected, its tests stop being asked for.
const journeyKept: Check = (t, to, _actor, { all }) => {
  const finished = to === "rejected" ? finishedUnder(t, all) : [];
  return finished.length
    ? `journey ${t.id} has finished work under it (${finished
        .slice(0, 5)
        .map((c) => `#${c.id}`)
        .join(
          ", "
        )}), so its tests are still owed, and rejecting it is the operator's call: raise it, as a matter of checking less (a6g task status ${t.id} question --topic rules --stakes … --confidence … --reason "…" --recommend "…")`
    : null;
};
const codeDone = (t: Task): string => `code is done when the merge queue merges it (a6g merge … --closes ${t.id}); reject it instead if it won't be built`;
// When `t` last came into the status it's in, or its creation.
export const waitingSince = (t: Task): string => t.history.findLast((e) => e.to === t.status)?.at ?? t.createdAt;
// The operator's answers on `t` since it last came to wait on them, oldest first.
export const answersOn = (t: Task): Note[] => {
  const since = waitingSince(t);
  return t.notes.filter((n) => n.kind === "answer" && n.at >= since);
};
// The design check-in still open, if any: while there is one, the foundation is all that's built (claimRefusal).
export const designOpen = (all: Task[]): Task | null => all.find((t) => t.kind === "design" && t.status !== "done" && t.status !== "rejected") ?? null;
// The design check-in goes between the planner and the operator only: raised as a question once the foundation is
// built, back to the planner (triage) while what the operator asked for is changed, and never proposed, approved or
// rejected by the team.
const designAsked: Check = (t, to) =>
  t.kind === "design" && to !== "question"
    ? `#${t.id} is the design check-in, which only the operator settles: raise it once the foundation is built and its record written (a6g task status ${t.id} question --reason "…" --recommend "…")`
    : null;
// What counts as the operator's answer on the check-in, for the planner that was refused: a note it writes itself
// from a message it read doesn't.
const ANSWERED_HOW =
  "An answer is one they gave in the web app or with a6g task answer, or their reply to its message that the watchdog passed on as recorded; one you noted yourself isn't, so ask them to answer one of those ways";
const designBack: Check = (t) =>
  t.kind !== "design"
    ? `task ${t.id} isn't the design check-in; a question goes on to proposed, approved, rejected or blocked`
    : answersOn(t).length
      ? null
      : `the operator hasn't answered #${t.id} on the task yet: it waits with them until they do. ${ANSWERED_HOW}`;
// Code isn't done by anyone's say-so. Research is, when the planner says so; a journey, once its tasks are and the planner
// has verified it; the design check-in, once the operator has answered it (agreed: the planner reads the answer).
const plannerDone: Check = (t, _to, _actor, { all }) => {
  if (t.kind === "research") return null;
  if (t.kind === "design")
    return t.status === "question" && answersOn(t).length
      ? null
      : t.status === "question"
        ? `the design check-in is done on the operator's word, and they haven't answered #${t.id} on the task yet. ${ANSWERED_HOW}`
        : `the design check-in is done on the operator's word: raise it (a6g task status ${t.id} question …), and close it when their answer agrees`;
  if (t.kind !== "journey") return codeDone(t);
  return journeyDue(t, all) ? null : `journey ${t.id} is done once it's verified: its tasks done, then its audit, end-to-end spec and polish`;
};
// A blocked task settles only the way its wait says, once the tasks it waits on allow it.
const settles: Check = (t, to, _actor, { all }) => {
  const outcome = waitOutcome(t, all);
  if (!outcome) return t.wait ? `task ${t.id} still waits on ${t.wait.on.map((id) => `#${id}`).join(", ")}` : `task ${t.id} waits on no other task`;
  return outcome.to === to ? null : `task ${t.id} settles to ${outcome.to}, not ${to}`;
};
const holder: Check = (t, _to, _actor, { machine = "", worktree = null }) =>
  heldHere(t.claim, worktree, machine)
    ? null
    : `task ${t.id} isn't claimed from this worktree (${t.claim ? `the ${t.claim.role} on ${t.claim.machine} holds it` : "nobody holds it"})`;
// The claimant hands it back; the planner (or the operator) may free one whose member is gone.
const holderOrPlanner: Check = (t, to, actor, ctx) => (actor === "planner" || actor === OPERATOR ? null : holder(t, to, actor, ctx));
const sameBranch: Check = (t, _to, _actor, { branch }) =>
  t.branch && branch && t.branch !== branch ? `task ${t.id} was submitted on ${t.branch}, not ${branch}` : null;
// The merge queue closes the branch's task once what it submitted is what merged; never a journey.
const merged: Check = (t, _to, _actor, { branch, tip, rebasedFrom }) =>
  t.kind === "journey"
    ? `#${t.id} is a journey, done once the planner has verified it`
    : t.kind === "design"
      ? `#${t.id} is the design check-in, done on the operator's word`
      : tip && t.branch === branch && t.sha && t.sha !== tip && t.sha !== rebasedFrom
        ? `#${t.id} was submitted at ${t.sha.slice(0, 9)}, and ${tip.slice(0, 9)} merged`
        : null;
const leaseOut: Check = (t, _to, _actor, { now = Date.now() }) =>
  t.claim && Date.parse(t.claim.until) <= now ? null : `task ${t.id}'s claim hasn't run out`;

// The planner's own moves (a6g task status): it never claims, approves its own proposals or marks code done.
const PLANNER_TO: [Status[], Status[]][] = [
  [["triage"], ["proposed", "rejected", "question", "blocked"]],
  [["proposed"], ["triage", "rejected", "question", "blocked"]],
  [
    ["researching", "approved"],
    ["proposed", "rejected", "question", "blocked"],
  ],
  [
    ["building", "review"],
    ["blocked", "question", "rejected"],
  ],
  // Back to approved only when it was approved before.
  [["blocked"], ["proposed", "approved", "rejected", "question"]],
  [["question"], ["proposed", "approved", "rejected", "blocked"]],
  [["done", "rejected"], ["proposed"]],
];
const EVERY: readonly Status[] = STATUSES;
const OPERATOR_FROM: Status[] = ["proposed", "researching", "question", "triage"];

const RULES: Rule[] = [
  ...PLANNER_TO.map(([from, to]): Rule => ({ via: "status", by: ["planner"], from, to, check: first(designAsked, wasApproved, screened, journeyKept) })),
  { via: "status", by: ["planner"], from: ["question"], to: ["triage"], check: designBack },
  { via: "status", by: ["planner"], from: ["triage", "approved", "researching", "proposed", "question", "blocked"], to: ["done"], check: plannerDone },
  // The operator makes any move but one: a task is building only when a member claims it, so it has a claim to expire.
  { via: "status", by: [OPERATOR], from: EVERY, to: EVERY.filter((s) => s !== "building") },

  {
    via: "approve",
    by: ["approver"],
    from: ["proposed"],
    to: ["approved"],
    check: first(notJourney, approverActs, scored, stakeholdersOperator, withinThresholds),
  },
  { via: "approve", by: ["planner"], from: ["triage", "proposed"], to: ["approved"], check: othersFinding },
  { via: "approve", by: [OPERATOR], from: [...OPERATOR_FROM, "blocked"], to: ["approved"], check: scored },
  { via: "reject", by: ["approver"], from: ["proposed"], to: ["rejected"], check: first(notJourney, approverActs) },
  { via: "reject", by: [OPERATOR], from: OPERATOR_FROM, to: ["rejected"] },
  { via: "research", by: ["approver"], from: ["proposed"], to: ["researching"], check: first(notJourney, approverActs) },
  { via: "research", by: [OPERATOR], from: OPERATOR_FROM, to: ["researching"] },
  { via: "escalate", by: ["approver"], from: ["proposed"], to: ["question"], check: first(notJourney, approverActs) },
  { via: "escalate", by: [OPERATOR], from: OPERATOR_FROM, to: ["question"] },

  { via: "claim", by: CLAIMANTS, from: ["approved"], to: ["building"], check: (t, _to, actor, { all }) => claimRefusal(t, actor, all) },
  {
    via: "release",
    by: [...CLAIMANTS, "planner", OPERATOR],
    from: ["building"],
    to: ["approved", "blocked"],
    check: holderOrPlanner,
  },
  { via: "submit", by: CLAIMANTS, from: ["building"], to: ["review"], check: holder },
  { via: "changes", by: ["reviewer", "security-reviewer", OPERATOR], from: ["review"], to: ["approved", "blocked"], check: sameBranch },
  { via: "merge", by: [MERGE], from: ["approved", "blocked", "question", "review"], to: ["done"], check: merged },
  // A branch that conflicts goes back to be claimed again and rebased.
  { via: "conflict", by: [MERGE], from: ["review"], to: ["approved"], check: sameBranch },
  { via: "expire", by: [WATCHDOG], from: ["building"], to: ["approved"], check: leaseOut },
  // A task waiting on others closes, goes back to work or back to the planner once they're settled (settleWaits).
  { via: "settle", by: [WATCHDOG, MERGE], from: ["blocked"], to: ["done", "approved", "proposed"], check: settles },
];

const DOES: Record<Via, string> = {
  status: "set a task's status",
  approve: "approve proposals",
  reject: "reject proposals",
  research: "send proposals back for research",
  escalate: "escalate proposals",
  claim: "claim tasks; builders, testers and the scaffolder do",
  release: "release tasks",
  submit: "submit tasks; builders, testers and the scaffolder submit what they built",
  changes: "ask for changes",
  merge: "merge",
  conflict: "send a conflicting branch back",
  expire: "expire claims",
  settle: "settle tasks that wait on others",
};
const DONE_TO: Partial<Record<Via, string>> = { approve: "approved", reject: "rejected", research: "sent back for research", escalate: "escalated" };

// Why `task` can't go from where it is to `to` through `via`, but would from somewhere else.
function notFrom(t: Task, to: Status, via: Via): string {
  const proposal = DONE_TO[via];
  if (proposal) return `task ${t.id} is ${t.status}; only a proposal is ${proposal}`;
  if (via === "claim") return `task ${t.id} is ${t.status}, not approved`;
  if (via === "release") return `task ${t.id} isn't claimed (${t.status})`;
  if (via === "submit") return `task ${t.id} isn't claimed from this worktree (${t.status})`;
  if (via === "changes" || via === "conflict") return `task ${t.id} is ${t.status}, not in review`;
  if (via === "merge" && t.kind === "journey") return `#${t.id} is a journey, done once the planner has verified it`;
  if (to === "done" && t.kind === "journey") return `journey ${t.id} is ${t.status}; reopen it first (a6g task status ${t.id} proposed)`;
  if (via === "merge")
    return t.status === "building"
      ? `#${t.id} is being built by the ${t.claim?.role ?? "a member"}${t.claim ? ` on ${t.claim.machine}` : ""}`
      : t.status === "rejected"
        ? `#${t.id} was rejected`
        : `#${t.id} is ${t.status}, never approved`;
  if (via === "expire") return `task ${t.id} isn't building`;
  if (via === "settle") return `task ${t.id} is ${t.status}, not waiting on other tasks`;
  if (to === "approved") return `the planner doesn't approve its own proposals: the approver or the operator does (a6g task approve ${t.id})`;
  if (to === "done") return codeDone(t);
  if (to === "review") return "a task goes to review when its claimant submits it (a6g task submit)";
  return `a ${t.status} task doesn't go to ${to}`;
}

// Why `actor` can't move `task` to `to` through `via`, or null when it can.
export function moveRefusal(task: Task, to: Status, via: Via, actor: Actor, ctx: MoveContext): string | null {
  if (task.status === to) return `task ${task.id} is already ${to}`;
  if (to === "building" && via !== "claim") return "a task is building only when a member claims it (a6g task claim)";
  // The design check-in takes no verdict from anyone. The operator answers it in words: a Reject beside it would read
  // as "not this design", and a rejected check-in is one the operator wants none of, so features would start.
  if (task.kind === "design" && VERDICTS_VIA.includes(via)) {
    if (actor !== OPERATOR) return `#${task.id} is the design check-in: the operator settles it, once the planner has raised it`;
    if (task.status === "done" || task.status === "rejected") return `#${task.id} is the design check-in, and it's ${task.status} already`;
    const how =
      task.status === "question"
        ? `a6g task answer ${task.id} "…" (agreed, or what to change)`
        : `the planner raises it once the foundation is built (it's ${task.status} now)`;
    return `#${task.id} is the design check-in, which you answer rather than approve or reject: ${how}. To end it yourself: a6g task status ${task.id} done (or rejected, to hold none)`;
  }
  const theirs = RULES.filter((rule) => rule.via === via && rule.by.includes(actor));
  if (!theirs.length)
    return via === "status"
      ? `only the planner (or the operator) sets a task's status; the ${actor} uses its own task commands`
      : `the ${actor} doesn't ${DOES[via]}`;
  const fits = theirs.filter((rule) => rule.to.includes(to) && rule.from.includes(task.status));
  if (!fits.length) return notFrom(task, to, via);
  let why: string | null = null;
  for (const rule of fits) {
    const refusal = rule.check?.(task, to, actor, ctx) ?? null;
    if (refusal === null) return to === "done" && task.kind === "journey" && actor !== OPERATOR ? (ctx.journeyProof?.(task, ctx.all) ?? null) : null;
    why ??= refusal;
  }
  return why;
}

// The planner's and the operator's a6g task status.
export const statusRefusal = (task: Task, to: Status, actor: Actor, all: Task[] = []): string | null => moveRefusal(task, to, "status", actor, { all });

// `task` moved to `to`, or a Refused saying why it can't be. A move takes the approval with it back among the
// proposals, and the claim with it anywhere but building; `fields` are the rest of what it changes.
export function move(
  task: Task,
  to: Status,
  via: Via,
  actor: Actor,
  ctx: MoveContext,
  { fields = {}, why, by = actor, sha }: { fields?: Partial<Task>; why?: string | undefined; by?: string; sha?: string } = {}
): Task {
  const refusal = moveRefusal(task, to, via, actor, ctx);
  if (refusal) throw new Refused(refusal);
  const moved: Task = {
    ...task,
    ...(UNAPPROVED.includes(to) ? { approval: null } : {}),
    ...(to === "building" ? {} : { claim: null }),
    ...(to === "question" || to === "blocked" ? {} : { ask: null, wait: null }),
    ...fields,
    status: to,
  };
  const asked = to === "question" ? askRefusal(moved.ask ?? null, actor) : null;
  if (asked) throw new Refused(asked);
  return withEvent(moved, by, `${task.status} → ${to}${why ? `: ${why}` : ""}`, { from: task.status, to, ...(sha ? { sha } : {}) });
}

// What a question must carry: why it's the operator's and the team's recommendation. The operator raising one to
// themselves gives the reason only.
export function askRefusal(ask: Pick<Ask, "reason" | "recommendation"> | null, actor: Actor): string | null {
  if (!ask?.reason.trim()) return "say why it's the operator's to decide: --reason \"…\"";
  if (actor !== OPERATOR && !ask.recommendation.trim())
    return 'give the team\'s recommendation: --recommend "…" (what you would do, and why; name the option when there are some)';
  return null;
}

// What a move into blocked must say: what it waits on (other tasks), or why it's blocked.
export function blockRefusal({ reason, waitsOn }: { reason: string; waitsOn: string[] }): string | null {
  return waitsOn.length || reason.trim() ? null : 'say what it\'s blocked on: --reason "…", or --waits-on <ids> when it waits for other tasks';
}

// Where a waiting task goes now: closed or back to work once everything it waits on is done, back to the planner
// (proposed) once one is rejected or gone; null while any is still moving.
export function waitOutcome(t: Task, all: Task[]): { to: Status; why: string } | null {
  if (t.status !== "blocked" || !t.wait?.on.length) return null;
  const byId = new Map(all.map((x) => [x.id, x]));
  const ids = t.wait.on.map((id) => `#${id}`).join(", ");
  const failed = t.wait.on.filter((id) => !byId.has(id) || byId.get(id)?.status === "rejected");
  if (failed.length)
    return {
      to: "proposed",
      why: `${failed.map((id) => `#${id}`).join(", ")} ${failed.length === 1 ? "was" : "were"} rejected or removed: the planner decides it again`,
    };
  if (!t.wait.on.every((id) => byId.get(id)?.status === "done")) return null;
  if (t.wait.then === "close") return { to: "done", why: `done with ${ids}, which it was folded into` };
  return t.approval ? { to: "approved", why: `${ids} done: back to work` } : { to: "proposed", why: `${ids} done: back to the planner, never approved` };
}

// Which kinds each role builds, its own first: a plain claim takes the first of those before the rest. The scaffolder
// owns the harness (test-infra) and the repository's structure (scaffold), and writes specs where the team has no
// tester; a tester keeps test-infra where the team has no scaffolder. Builders claim neither, so nobody writes the
// only spec of a journey they built.
export const CLAIMS: Record<string, Kind[]> = {
  builder: ["feature", "bug", "ux", "chore"],
  tester: ["test", "test-infra"],
  scaffolder: ["scaffold", "test-infra", "test"],
};
const OWN: Record<string, Kind[]> = { tester: ["test"], scaffolder: ["scaffold", "test-infra"] };
// What's built while the design check-in is open: the foundation itself (the skeleton, the harness, and what the
// operator asks to have changed in them).
export const FOUNDATION: Kind[] = ["scaffold", "test-infra"];

const SEVERITY_ORDER: Record<string, number> = { blocker: 0, major: 1, minor: 3 };
const tierOf = (t: Task): number => SEVERITY_ORDER[t.severity ?? ""] ?? 2;
const oldestFirst = (a: Task, b: Task): number => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);
// A list's order on its own, without the graph: blockers, then majors, then the rest by priority (unscored work after
// scored) with minor findings last (polish is bounded, Article 9), then the oldest. Claims follow claimRank.
export function claimOrder(a: Task, b: Task): number {
  if (tierOf(a) !== tierOf(b)) return tierOf(a) - tierOf(b);
  const pa = a.priority ?? -1;
  const pb = b.priority ?? -1;
  if (pa !== pb) return pb - pa;
  return oldestFirst(a, b);
}

// Work sent back to its own branch (a rebase, or changes a review asked for): begun, so finishing it comes first.
export const sentBack = (t: Task): boolean => t.status === "approved" && t.branch !== null;

// The order claims follow, over the whole graph, so work goes in order: blockers, then majors; within each, work sent
// back to its own branch, since finishing comes before starting; then work in a journey already under way, before work
// that starts another; then priority; then the oldest. A task other open tasks wait on (their `after`) takes the most
// urgent severity, the journey under way and the highest priority of all that waits on it, so a prerequisite goes
// before the work it unblocks, and at the same priority what others wait on goes first.
export function claimRank(all: Task[]): (a: Task, b: Task) => number {
  const open = (t: Task): boolean => t.status !== "done" && t.status !== "rejected";
  const waiters = new Map<string, Task[]>();
  for (const t of all.filter(open)) for (const id of t.after) waiters.set(id, [...(waiters.get(id) ?? []), t]);
  const underWay = new Set(journeysUnderWay(all).map((j) => j.id));
  type Rank = { tier: number; continues: number; priority: number };
  // Over everything that waits on `t`, however far down; a cycle (which nothing claims) stops where it closes.
  const inherited = new Map<string, Rank>();
  const inherit = (t: Task, seen: Set<string>): Rank => {
    const known = inherited.get(t.id);
    if (known) return known;
    const own = { tier: tierOf(t), continues: t.parent !== null && underWay.has(t.parent) ? 0 : 1, priority: t.priority ?? -1 };
    if (seen.has(t.id)) return own;
    seen.add(t.id);
    const result = (waiters.get(t.id) ?? []).reduce((best, w) => {
      const theirs = inherit(w, seen);
      return {
        tier: Math.min(best.tier, theirs.tier),
        continues: Math.min(best.continues, theirs.continues),
        priority: Math.max(best.priority, theirs.priority),
      };
    }, own);
    inherited.set(t.id, result);
    return result;
  };
  const of = (t: Task) => inherit(t, new Set());
  const resumes = (t: Task): number => (sentBack(t) ? 0 : 1);
  const waitedOn = (t: Task): number => (waiters.get(t.id)?.length ? 0 : 1);
  return (a, b) =>
    of(a).tier - of(b).tier ||
    resumes(a) - resumes(b) ||
    of(a).continues - of(b).continues ||
    of(b).priority - of(a).priority ||
    waitedOn(a) - waitedOn(b) ||
    oldestFirst(a, b);
}

// Ideas waiting to be built: features from triage to approved, or waiting on the operator's decision, that no builder
// has begun (no branch). The planner keeps the innovator at work while fewer than the team's roles.innovator.minQueue
// wait. An idea the approver escalated (a change of scope, say) is still queued: another pass would only add to them.
const QUEUED: Status[] = ["triage", "proposed", "researching", "question", "approved"];
export const ideasQueued = (all: Task[]): Task[] => all.filter((t) => t.kind === "feature" && QUEUED.includes(t.status) && t.branch === null);

// Two path prefixes overlap when either contains the other ("src/a/" and "src/a/b.ts").
const overlaps = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
export function conflictOf(task: Task, building: Task[]): Task | null {
  return (
    building.find(
      (other) =>
        other.id !== task.id &&
        ((task.area !== null && task.area !== "" && other.area === task.area) || task.files.some((f) => other.files.some((g) => overlaps(f, g))))
    ) ?? null
  );
}

// Why `task` can't be claimed by `role` now, or null when it can; `hold` is the operator's pause in force, if any
// (controls.ts), which lets only the work it finishes be claimed.
export function claimRefusal(task: Task, role: string, all: Task[], hold: Hold | null = null): string | null {
  const kinds = CLAIMS[role];
  if (!kinds) return `the ${role} doesn't claim tasks; builders, testers and the scaffolder do`;
  if (task.status !== "approved") return `task ${task.id} is ${task.status}, not approved`;
  if (!kinds.includes(task.kind)) return `task ${task.id} is ${task.kind} work, which the ${role} doesn't take (it takes ${kinds.join(", ")})`;
  const byId = new Map(all.map((t) => [t.id, t]));
  const waiting = task.after.filter((id) => byId.get(id)?.status !== "done");
  if (waiting.length) return `task ${task.id} waits for ${waiting.map((id) => `${id} (${byId.get(id)?.status ?? "missing"})`).join(", ")}`;
  const design = FOUNDATION.includes(task.kind) ? null : designOpen(all);
  if (design)
    return `task ${task.id} waits for the operator to agree the design (#${design.id}, ${design.status}): until then only ${FOUNDATION.join(" and ")} work is claimed`;
  const conflict = conflictOf(
    task,
    all.filter((t) => t.status === "building")
  );
  if (conflict) return `task ${conflict.id} is being built on the same ${conflict.area === task.area && task.area ? `area (${task.area})` : "files"}`;
  return holdRefusal(task, hold);
}

// The order `role` claims in: the kinds that are its own first (OWN), then claim order (claimRank).
export function claimRankFor(role: string, all: Task[]): (a: Task, b: Task) => number {
  const own = OWN[role] ?? CLAIMS[role] ?? [];
  const rank = claimRank(all);
  const first = (t: Task): number => (own.includes(t.kind) ? 0 : 1);
  return (a, b) => first(a) - first(b) || rank(a, b);
}

// The task `role` should claim next, of those it may: the first in its claim order (claimRankFor).
export function nextClaim(all: Task[], role: string, kind?: Kind, hold: Hold | null = null): Task | null {
  return all.filter((t) => (kind === undefined || t.kind === kind) && claimRefusal(t, role, all, hold) === null).sort(claimRankFor(role, all))[0] ?? null;
}

// The branch name a claimant uses, matching its role's pattern (a6g/b142-resume-a-recording, a6g/t-142-…, a6g/s142-…).
export function branchFor(task: Task, role: string, prefix: string): string {
  const slug =
    task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task";
  return role === "tester" ? `${prefix}/t-${task.id}-${slug}` : `${prefix}/${role === "scaffolder" ? "s" : "b"}${task.id}-${slug}`;
}

// The ticket a branch's name gives: the number in the first part after the prefix (a6g/b12-x/v2-y closes 12, and a
// tester's a6g/t-12-x closes 12).
export function ticketOf(branch: string, prefix: string): string | undefined {
  const rest = branch.startsWith(`${prefix}/`) ? branch.slice(prefix.length + 1) : branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch;
  return /^(?:[a-z]*|t-)(\d+)-/.exec(rest.split("/")[0] ?? "")?.[1];
}

// A journey groups tasks, which are approved one by one; it needs no approval of its own. It's due its verification
// once its children are all done (or rejected), at least one done: worked out wherever it's shown, never stored.
export function journeyDue(journey: Task, all: Task[]): boolean {
  if (journey.kind !== "journey" || journey.status === "done" || journey.status === "rejected") return false;
  const children = all.filter((t) => t.parent === journey.id);
  return children.some((t) => t.status === "done") && children.every((t) => t.status === "done" || t.status === "rejected");
}

// An event in a document's history, and the document with it.
export function withEvent<T extends { history: Event[]; updatedAt: string }>(
  doc: T,
  by: Actor,
  what: string,
  moved: Pick<Event, "from" | "to" | "sha"> = {}
): T {
  const at = nowIso();
  return { ...doc, updatedAt: at, history: [...doc.history, { at, by, what, ...moved }].slice(-200) };
}
