"use server";
// A team's writes. Each checks the session and the person's role for the team (an admin's second factor too) before
// it reads or writes anything, then calls the factory's own code.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clip, withNotice } from "../../../components/ui.tsx";
import { agreementFrom, isReserved, sameAgreement, TOPICS } from "../../../../lib/tasks/agreement.ts";
import {
  can,
  DECISION_ID,
  decisionProblem,
  isDecision,
  isKind,
  isSeverity,
  LIMITS,
  requestProblem,
  TASK_ID,
  taskIds,
  taskProblem,
  TEAM_PARAM,
} from "../../../server/access.ts";
import { contactOfForm, readsAgreement } from "../../../server/decided.ts";
import {
  addTaskFromWeb,
  agreementFromWeb,
  agreementOf,
  answerAsOperator,
  budgetFromWeb,
  controlsOf,
  decideAsOperator,
  decisionsOf,
  describeHold,
  isHoldScope,
  pauseFromWeb,
  Refused,
  resumeFromWeb,
  reviewFromWeb,
  sendRequest,
  stakeholderOf,
  storeFor,
  subscriptionsFromWeb,
  teamDoc,
} from "../../../server/factory.ts";
import { answerText, asRecommended, shownAs, waitingOf } from "../../../server/inbox.ts";
import { memberships, takeRequestAllowance } from "../../../server/people.ts";
import { checkCode } from "../../../server/step-up.ts";
import { allowed, authHeaders, getViewer, NotAllowed, record } from "../../../server/viewer.ts";

const text = (form: FormData, key: string): string => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

// A refusal in words; anything else is logged and said plainly.
function reasonOf(error: unknown): string {
  if (error instanceof NotAllowed || error instanceof Refused) return error.message;
  console.error(error);
  return "Something went wrong; try again.";
}

export interface RequestFormState {
  error: string | null;
  title: string;
  body: string;
}

// A request from the form, from the person's own stakeholder record on the team.
export async function sendRequestAction(_previous: RequestFormState, form: FormData): Promise<RequestFormState> {
  const team = text(form, "team");
  const title = text(form, "title");
  const body = text(form, "body");
  const again = (error: string): RequestFormState => ({ error, title, body });
  let id: string;
  try {
    if (!TEAM_PARAM.test(team)) return again("No such team.");
    const viewer = await allowed("requests:send", team);
    const problem = requestProblem(title, body);
    if (problem) return again(problem);
    if (!(await teamDoc(team))) return again("No such team.");
    if (!(await takeRequestAllowance(viewer.userId, LIMITS.requestsPerDay)))
      return again(`You've sent ${LIMITS.requestsPerDay} requests and suggestions today, the most a day; send this one tomorrow.`);
    const label = viewer.admin ? "operator" : ((await memberships({ userId: viewer.userId, team }))[0]?.label ?? "stakeholder");
    const from = await stakeholderOf(team, viewer, label);
    id = (await sendRequest(team, { title, body, from: from.id, admin: viewer.admin })).id;
    await record(viewer, { action: "request.sent", outcome: "ok", team, target: `${id} ${title.trim()}` });
  } catch (error) {
    return again(reasonOf(error));
  }
  redirect(withNotice(`/t/${team}/requests/${id}`, { ok: "Request sent. The planner reads it and answers here." }));
}

export interface TaskFormState {
  error: string | null;
  title: string;
  body: string;
  kind: string;
  severity: string;
  parent: string;
  after: string;
  approved: boolean;
}

// A task from the form: an admin adds it as the operator (proposed, or approved as it's added); a member suggests it
// for the planner to triage. Either way the task records who it came from, by their stakeholder record. Suggestions
// count towards the person's daily limit.
export async function addTaskAction(_previous: TaskFormState, form: FormData): Promise<TaskFormState> {
  const team = text(form, "team");
  const fields = {
    title: text(form, "title"),
    body: text(form, "body"),
    kind: text(form, "kind"),
    severity: text(form, "severity"),
    parent: text(form, "parent"),
    after: text(form, "after"),
    approved: text(form, "approved") === "yes",
  };
  const again = (error: string): TaskFormState => ({ error, ...fields });
  let task: { id: string; status: string };
  try {
    if (!TEAM_PARAM.test(team)) return again("No such team.");
    // An admin adds; anyone else may only suggest, whatever the form says.
    const admin = can(await getViewer(), "tasks:add", team);
    const viewer = await allowed(admin ? "tasks:add" : "tasks:suggest", team);
    const problem = taskProblem(fields, !admin);
    if (problem) return again(problem);
    if (fields.parent && !TASK_ID.test(fields.parent.replace(/^#/, ""))) return again("Choose a journey from the list.");
    if (!(await teamDoc(team))) return again("No such team.");
    const after = admin ? (taskIds(fields.after) ?? []) : [];
    if (after.length) {
      const known = new Set((await storeFor(team).tasks.all()).map((t) => t.id));
      const missing = after.filter((id) => !known.has(id));
      if (missing.length) return again(`There's no task ${missing.map((id) => `#${id}`).join(", ")} on this team.`);
    }
    // Approved as it's added, it goes straight to the builders: like a pause, it takes a code from the authenticator.
    if (admin && fields.approved) {
      const wrong = await checkCode(viewer.userId, text(form, "code").replace(/\s+/g, ""), await authHeaders());
      if (wrong) return again(wrong);
    }
    if (!admin && !(await takeRequestAllowance(viewer.userId, LIMITS.requestsPerDay)))
      return again(`You've sent ${LIMITS.requestsPerDay} requests and suggestions today, the most a day; send this one tomorrow.`);
    // Whoever adds it, admin or member, is on the task as their stakeholder record, as a request's sender is.
    const label = admin ? "operator" : ((await memberships({ userId: viewer.userId, team }))[0]?.label ?? "stakeholder");
    const from = (await stakeholderOf(team, viewer, label)).id;
    task = await addTaskFromWeb(
      team,
      {
        title: fields.title,
        body: fields.body,
        kind: isKind(fields.kind, !admin) ? fields.kind : "feature",
        severity: isSeverity(fields.severity) && (admin || fields.kind === "bug" || fields.kind === "ux") ? fields.severity : null,
        parent: admin ? fields.parent || null : null,
        after,
        approved: admin && fields.approved,
      },
      { admin, from }
    );
    await record(viewer, {
      action: admin ? "task.added" : "task.suggested",
      outcome: "ok",
      team,
      target: `#${task.id} ${fields.title.trim()}`,
      detail: task.status,
    });
  } catch (error) {
    return again(reasonOf(error));
  }
  const said =
    task.status === "triage"
      ? `Suggested as #${task.id}. The planner triages it.`
      : `#${task.id} added, ${task.status === "approved" ? "approved" : "proposed"}.`;
  redirect(withNotice(`/t/${team}/tasks/${task.id}`, { ok: said }));
}

const DONE: Record<string, string> = { approve: "approved", reject: "rejected", research: "sent back for research", escalate: "escalated" };

// Where a decision or an answer goes back to: the page it was made on, of those that make them.
function backTo(form: FormData, team: string): string {
  const pages = [`/t/${team}/proposals`, `/t/${team}/inbox`, "/inbox"];
  const asked = text(form, "back");
  return pages.includes(asked) ? asked : (pages[0] ?? "/");
}

// An admin decides on a proposal, as the operator, by the factory's move table and the team's approval rules.
export async function decideAction(form: FormData): Promise<void> {
  const team = text(form, "team");
  const id = text(form, "id");
  const decision = text(form, "decision");
  const note = text(form, "text");
  if (!TEAM_PARAM.test(team)) redirect("/");
  const back = backTo(form, team);
  let notice: { ok?: string; error?: string };
  let viewer = null;
  try {
    viewer = await allowed("proposals:decide", team);
    if (!TASK_ID.test(id) || !isDecision(decision)) throw new Refused("That isn't a decision on a task.");
    const problem = decisionProblem(decision, note);
    if (problem) throw new Refused(problem);
    // The page's own copy of the task (its version, in the form): the planner can edit a proposal while the page is
    // open, and a decision is on what was read. The page comes back with the task as it stands.
    const seen = text(form, "seen");
    if (seen && String((await storeFor(team).tasks.get(id))?.version) !== seen)
      throw new Refused(`#${id} changed after this page was loaded. It's shown as it stands now: read it again, then decide.`);
    const task = await decideAsOperator(team, id, decision, note);
    notice = { ok: `#${task.id} ${DONE[decision]}.` };
    await record(viewer, {
      action: "task.decided",
      outcome: "ok",
      team,
      target: `#${task.id} ${task.title}`,
      detail: `${decision}${note.trim() ? `: ${note.trim()}` : ""}`,
    });
  } catch (error) {
    notice = { error: reasonOf(error) };
    // A refusal to someone allowed to decide is worth keeping (the move table said no); one to anyone else, too.
    await record(viewer ?? (await getViewer()), {
      action: "task.decided",
      outcome: "refused",
      team,
      target: TASK_ID.test(id) ? `#${id}` : null,
      detail: `${decision}: ${notice.error}`,
    });
  }
  // What waits on the operator changed: the header's and the tab's counts with it.
  revalidatePath("/", "layout");
  redirect(withNotice(back, notice));
}

export interface AnswerFormState {
  error: string | null;
  pick: string;
  extra: string;
}

// An admin answers what waits on them (a question, or blocked work), as the operator: the option they chose and what
// they added, read against the task as it is now. The task stays where it is; the planner acts on the answer.
export async function answerAction(_previous: AnswerFormState, form: FormData): Promise<AnswerFormState> {
  const team = text(form, "team");
  const id = text(form, "id");
  const pick = text(form, "pick");
  const extra = text(form, "extra");
  const again = (error: string): AnswerFormState => ({ error, pick, extra });
  if (!TEAM_PARAM.test(team)) return again("No such team.");
  const back = backTo(form, team);
  let viewer = null;
  try {
    viewer = await allowed("proposals:decide", team);
    if (!TASK_ID.test(id)) return again("That isn't a task.");
    if (extra.length > LIMITS.note) return again(`Keep it to ${LIMITS.note.toLocaleString("en")} characters.`);
    const task = await storeFor(team).tasks.get(id);
    if (!task) return again(`There's no task #${id} on this team.`);
    const waiting = waitingOf(task, [task]);
    // The form answers the question it was drawn with (its token; the form for adding to an answer offers nothing
    // and sends none). One the team changed since comes back as it stands, with nothing chosen: the options an answer
    // is read against here would otherwise be ones the operator never saw.
    const shown = text(form, "shown");
    if ((pick || shown) && shown !== shownAs(waiting)) {
      await record(viewer, {
        action: "task.answered",
        outcome: "refused",
        team,
        target: `#${id} ${task.title}`,
        detail: "the question changed after the page was loaded",
      });
      revalidatePath("/", "layout");
      return { error: `The team changed #${id} after this page was loaded. It's shown as it stands now: read it again, then answer.`, pick: "", extra };
    }
    const said = answerText(pick, extra, waiting);
    if ("problem" in said) return again(said.problem);
    // The team's recommendation as it stood (the one it gave when it raised the task, not one read out of the task's
    // words; the recommendation, or the option it names, with nothing added) is answered as that: the factory writes
    // its words and marks the answer so. Anything else is the operator's own answer, in the form's words.
    const recommended = waiting.recommendationFrom === "asked" && asRecommended(pick, extra, waiting);
    const answered = await answerAsOperator(team, id, recommended ? "" : said.text, recommended, waiting.recommendation ?? undefined);
    await record(viewer, {
      action: "task.answered",
      outcome: "ok",
      team,
      target: `#${id} ${task.title}`,
      detail: clip(answered.notes.at(-1)?.text ?? said.text, 300),
    });
  } catch (error) {
    const reason = reasonOf(error);
    await record(viewer ?? (await getViewer()), {
      action: "task.answered",
      outcome: "refused",
      team,
      target: TASK_ID.test(id) ? `#${id}` : null,
      detail: reason,
    });
    return again(reason);
  }
  revalidatePath("/", "layout");
  redirect(withNotice(back, { ok: `Answer sent on #${id}. The planner gets it within a minute and moves #${id} on.` }));
}

// An admin pauses or resumes the team, as the operator, with a code from their authenticator: how a team runs changes
// only for someone holding their second factor at that moment. The lead's watchdog applies it within a minute.
export async function controlAction(form: FormData): Promise<void> {
  const team = text(form, "team");
  const kind = text(form, "kind");
  const scope = text(form, "scope");
  const note = text(form, "note").trim();
  const journeys = form.getAll("journey").filter((value): value is string => typeof value === "string" && TASK_ID.test(value));
  if (!TEAM_PARAM.test(team)) redirect("/");
  const action = kind === "resume" ? "team.resumed" : "team.paused";
  let notice: { ok?: string; error?: string };
  let viewer = null;
  try {
    viewer = await allowed("team:control", team);
    if (kind !== "pause" && kind !== "resume") throw new Refused("That isn't a pause or a resume.");
    if (kind === "pause" && !isHoldScope(scope)) throw new Refused("Choose when the team pauses.");
    if (note.length > LIMITS.note) throw new Refused(`Keep the note to ${LIMITS.note} characters.`);
    if (!(await teamDoc(team))) throw new Refused("No such team.");
    const wrong = await checkCode(viewer.userId, text(form, "code").replace(/\s+/g, ""), await authHeaders());
    if (wrong) throw new Refused(wrong);
    const from = (await stakeholderOf(team, viewer, "operator")).id;
    const control =
      kind === "pause" && isHoldScope(scope) ? await pauseFromWeb(team, { scope, journeys, note, from }) : await resumeFromWeb(team, { note, from });
    const what =
      control.kind === "resume"
        ? "resume"
        : control.scope === "now"
          ? "pause now"
          : `pause after ${describeHold({ scope: control.scope ?? "now", tasks: control.tasks, journeys: control.journeys })}`;
    notice = { ok: `Asked to ${what}. The team's Mac applies it within a minute; this page shows when it has.` };
    await record(viewer, { action, outcome: "ok", team, target: control.id, detail: `${what}${note ? `: ${note}` : ""}` });
  } catch (error) {
    notice = { error: reasonOf(error) };
    await record(viewer ?? (await getViewer()), { action, outcome: "refused", team, target: null, detail: `${kind} ${scope}: ${notice.error}`.trim() });
  }
  // A refused pause opens its form again (open=…, beside the signed notice), so it's there to correct.
  redirect(`${withNotice(`/t/${team}`, notice)}${notice.error && kind !== "resume" ? "&open=pause" : ""}`);
}

// An admin sets the team's budget, as the operator, with a code from their authenticator. Each limit is dollars
// (API-equivalent), blank for none; the lead's watchdog holds the team to it from its next run.
export async function budgetAction(form: FormData): Promise<void> {
  const team = text(form, "team");
  if (!TEAM_PARAM.test(team)) redirect("/");
  let notice: { ok?: string; error?: string };
  let viewer = null;
  const amounts = { daily: text(form, "daily").trim(), weekly: text(form, "weekly").trim(), total: text(form, "total").trim() };
  try {
    viewer = await allowed("team:control", team);
    // Dollars, or percent of a subscription's week (over 100 for more than one subscription's worth).
    const unit = text(form, "unit") === "subscription" ? "subscription" : "usd";
    const amount = (key: keyof typeof amounts): number | null => {
      const value = amounts[key].replace(/^\$/, "").replace(/%$/, "");
      if (!value) return null;
      const n = Number(value);
      const max = unit === "subscription" ? 10_000 : 1_000_000;
      if (!Number.isFinite(n) || n < 0 || n > max)
        throw new Refused(
          unit === "subscription" ? `The ${key} budget is a percentage, from 0 to 10,000.` : `The ${key} budget is dollars, from 0 to 1,000,000.`
        );
      return n === 0 ? null : Math.round(n * 100) / 100;
    };
    const limits = { daily: amount("daily"), weekly: amount("weekly"), total: amount("total") };
    if (!(await teamDoc(team))) throw new Refused("No such team.");
    const wrong = await checkCode(viewer.userId, text(form, "code").replace(/\s+/g, ""), await authHeaders());
    if (wrong) throw new Refused(wrong);
    const from = (await stakeholderOf(team, viewer, "operator")).id;
    const control = await budgetFromWeb(team, {
      ...limits,
      unit,
      autoResume: text(form, "autoResume") === "yes",
      restart: text(form, "restart") === "yes",
      from,
    });
    const money = (n: number | null) => (n === null ? "none" : unit === "subscription" ? `${n}%` : `$${n}`);
    const said = control.limits
      ? `${money(limits.daily)} a day, ${money(limits.weekly)} a week, ${money(limits.total)} in all${unit === "subscription" ? " of a subscription's week" : ""}`
      : "no budget";
    notice = { ok: `The budget is ${said}. The team's Mac holds it to that from its next run.` };
    await record(viewer, { action: "team.budget", outcome: "ok", team, target: control.id, detail: said });
  } catch (error) {
    notice = { error: reasonOf(error) };
    await record(viewer ?? (await getViewer()), { action: "team.budget", outcome: "refused", team, target: null, detail: notice.error });
  }
  redirect(`${withNotice(`/t/${team}`, notice)}${notice.error ? "&open=budget" : ""}`);
}

// An admin chooses the Claude subscriptions the team runs on, as the operator, with a code from their authenticator:
// every role's list, or one role's own, in order (none clears it). Which login a team's agents use, and so whose limits
// they spend, changes only for someone holding their second factor at that moment. The lead's watchdog writes the list
// and moves the roles within a minute (lib/steer.ts).
export async function subscriptionsAction(form: FormData): Promise<void> {
  const team = text(form, "team");
  if (!TEAM_PARAM.test(team)) redirect("/");
  const role = text(form, "role").trim() || null;
  const use = form.getAll("use").filter((value): value is string => typeof value === "string");
  let notice: { ok?: string; error?: string };
  let viewer = null;
  try {
    viewer = await allowed("team:control", team);
    if (use.length > 8 || use.some((name) => !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)))
      throw new Refused("Choose the subscriptions from the team's Mac's own.");
    if (role !== null && !/^[a-z][a-z0-9-]{0,40}$/.test(role)) throw new Refused("Choose a role from the list.");
    if (!(await teamDoc(team))) throw new Refused("No such team.");
    const wrong = await checkCode(viewer.userId, text(form, "code").replace(/\s+/g, ""), await authHeaders());
    if (wrong) throw new Refused(wrong);
    const from = (await stakeholderOf(team, viewer, "operator")).id;
    const control = await subscriptionsFromWeb(team, { role, use, from });
    const whose = role ? `The ${role === "planner" ? "planner" : `${role}s`}` : "The team";
    const said = use.length
      ? `${whose} ${role && role !== "planner" ? "run" : "runs"} on ${use.join(", then ")}`
      : role
        ? `${whose} ${role === "planner" ? "follows" : "follow"} the team's list`
        : "The team runs on its Mac's own login";
    notice = { ok: `${said}. The team's Mac applies it within a minute, and moves each role once nothing of it is at work.` };
    await record(viewer, { action: "team.subscriptions", outcome: "ok", team, target: control.id, detail: said });
  } catch (error) {
    notice = { error: reasonOf(error) };
    await record(viewer ?? (await getViewer()), { action: "team.subscriptions", outcome: "refused", team, target: null, detail: notice.error });
  }
  redirect(`${withNotice(`/t/${team}`, notice)}${notice.error ? "&open=subscriptions" : ""}#subscriptions`);
}

// An admin reviews what the team decided in the operator's place: agrees with it, or overturns it and says what to do
// instead. A control, like a pause: the lead's watchdog writes it onto the record and passes an overturn to the planner
// within a minute. It decides nothing new about how the team runs, so it takes no code, as an answer doesn't.
export async function reviewAction(form: FormData): Promise<void> {
  const team = text(form, "team");
  const id = text(form, "id");
  const verdict = text(form, "verdict");
  const note = text(form, "note").trim();
  if (!TEAM_PARAM.test(team)) redirect("/");
  let notice: { ok?: string; error?: string };
  let viewer = null;
  try {
    viewer = await allowed("proposals:decide", team);
    if (!DECISION_ID.test(id) || (verdict !== "agreed" && verdict !== "overturned")) throw new Refused("That isn't a review of a decision.");
    if (verdict === "overturned" && !note) throw new Refused("Say what to do instead: the planner acts on your words.");
    if (note.length > LIMITS.note) throw new Refused(`Keep it to ${LIMITS.note.toLocaleString("en")} characters.`);
    if (!(await teamDoc(team))) throw new Refused("No such team.");
    const decision = (await decisionsOf(team)).find((d) => d.id === id);
    if (!decision) throw new Refused(`There's no decision ${id} on this team.`);
    const from = (await stakeholderOf(team, viewer, "operator")).id;
    await reviewFromWeb(team, { id, verdict, note, from });
    notice = {
      ok: verdict === "agreed" ? `Agreed with ${id}.` : `Overturned ${id}. The planner gets what you wrote within a minute, and undoes it.`,
    };
    await record(viewer, {
      action: "decision.reviewed",
      outcome: "ok",
      team,
      target: `${id} ${clip(decision.question, 160)}`,
      detail: `${verdict}${note ? `: ${clip(note, 300)}` : ""}`,
    });
  } catch (error) {
    notice = { error: reasonOf(error) };
    await record(viewer ?? (await getViewer()), {
      action: "decision.reviewed",
      outcome: "refused",
      team,
      target: DECISION_ID.test(id) ? id : null,
      detail: `${verdict}: ${notice.error}`,
    });
  }
  // What's left to review changed: the tab's count with it.
  revalidatePath("/", "layout");
  redirect(withNotice(`/t/${team}/decided`, notice));
}

export interface AgreementFormState {
  error: string | null;
  level: string;
  // Each topic the agreement may set: "follow", "ask" or "decide".
  topics: Record<string, string>;
  notes: string;
  // How often a message may reach the operator: "team" (the team's own settings), "digest" or "priority"; and a
  // digest's window, in hours.
  messages: string;
  every: string;
}

// An admin changes the team's working agreement, as the operator, with a code from their authenticator: how readily
// the team asks them changes only for someone holding their second factor at that moment. The commands that ask the
// operator or decide for them read the newest agreement, and the lead's watchdog tells the planner within a minute.
// What was chosen and typed comes back with a refusal, so a wrong code doesn't lose the instructions.
export async function agreementAction(_previous: AgreementFormState, form: FormData): Promise<AgreementFormState> {
  const team = text(form, "team");
  const level = text(form, "level");
  const topics = Object.fromEntries(TOPICS.filter((topic) => !isReserved(topic)).map((topic) => [topic, text(form, `topic-${topic}`) || "follow"]));
  const notes = text(form, "notes");
  const messages = text(form, "messages") || "team";
  const every = text(form, "every");
  const again = (error: string): AgreementFormState => ({ error, level, topics, notes, messages, every });
  if (!TEAM_PARAM.test(team)) return again("No such team.");
  let viewer = null;
  let said: string;
  try {
    viewer = await allowed("team:control", team);
    const doc = await teamDoc(team);
    if (!doc) throw new Refused("No such team.");
    if (!readsAgreement(doc)) throw new Refused("This team's factory version doesn't read the agreement yet: upgrade it first (a6g upgrade).");
    // Everything that could be wrong with it is said before the code is asked of the authenticator: a code works once.
    const often = contactOfForm(messages, every);
    if ("problem" in often) throw new Refused(often.problem);
    const made = agreementFrom({ level, topics, notes, contact: often.contact });
    if ("problem" in made) throw new Refused(made.problem);
    if (sameAgreement(agreementOf(await controlsOf(team)).agreement, made)) throw new Refused("Nothing changed: the agreement says that already.");
    const wrong = await checkCode(viewer.userId, text(form, "code").replace(/\s+/g, ""), await authHeaders());
    if (wrong) throw new Refused(wrong);
    const from = (await stakeholderOf(team, viewer, "operator")).id;
    const { control, changes } = await agreementFromWeb(team, { level, topics, notes, contact: often.contact, from });
    said = changes.join("; ");
    await record(viewer, { action: "team.agreement", outcome: "ok", team, target: control.id, detail: said });
  } catch (error) {
    const reason = reasonOf(error);
    await record(viewer ?? (await getViewer()), { action: "team.agreement", outcome: "refused", team, target: null, detail: reason });
    return again(reason);
  }
  revalidatePath("/", "layout");
  redirect(withNotice(`/t/${team}/agreement`, { ok: `The agreement changed: ${clip(said, 200)}. The team follows it from now on.` }));
}
