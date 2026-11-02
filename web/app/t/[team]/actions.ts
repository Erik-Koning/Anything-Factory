"use server";
// A team's writes. Each checks the session and the person's role for the team (an admin's second factor too) before
// it reads or writes anything, then calls the factory's own code.
import { redirect } from "next/navigation";
import { withNotice } from "../../../components/ui.tsx";
import {
  can,
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
import {
  addTaskFromWeb,
  budgetFromWeb,
  decideAsOperator,
  describeHold,
  isHoldScope,
  pauseFromWeb,
  Refused,
  resumeFromWeb,
  sendRequest,
  stakeholderOf,
  storeFor,
  teamDoc,
} from "../../../server/factory.ts";
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

// An admin decides on a proposal, as the operator, by the factory's move table and the team's approval rules.
export async function decideAction(form: FormData): Promise<void> {
  const team = text(form, "team");
  const id = text(form, "id");
  const decision = text(form, "decision");
  const note = text(form, "text");
  if (!TEAM_PARAM.test(team)) redirect("/");
  const back = `/t/${team}/proposals`;
  let notice: { ok?: string; error?: string };
  let viewer = null;
  try {
    viewer = await allowed("proposals:decide", team);
    if (!TASK_ID.test(id) || !isDecision(decision)) throw new Refused("That isn't a decision on a task.");
    const problem = decisionProblem(decision, note);
    if (problem) throw new Refused(problem);
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
  redirect(withNotice(back, notice));
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
  redirect(withNotice(`/t/${team}`, notice));
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
    const amount = (key: keyof typeof amounts): number | null => {
      const value = amounts[key].replace(/^\$/, "");
      if (!value) return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new Refused(`The ${key} budget is dollars, from 0 to 1,000,000.`);
      return n === 0 ? null : Math.round(n * 100) / 100;
    };
    const limits = { daily: amount("daily"), weekly: amount("weekly"), total: amount("total") };
    if (!(await teamDoc(team))) throw new Refused("No such team.");
    const wrong = await checkCode(viewer.userId, text(form, "code").replace(/\s+/g, ""), await authHeaders());
    if (wrong) throw new Refused(wrong);
    const from = (await stakeholderOf(team, viewer, "operator")).id;
    const control = await budgetFromWeb(team, {
      ...limits,
      autoResume: text(form, "autoResume") === "yes",
      restart: text(form, "restart") === "yes",
      from,
    });
    const money = (n: number | null) => (n === null ? "none" : `$${n}`);
    const said = control.limits ? `${money(limits.daily)} a day, ${money(limits.weekly)} a week, ${money(limits.total)} in all` : "no budget";
    notice = { ok: `The budget is ${said}. The team's Mac holds it to that from its next run.` };
    await record(viewer, { action: "team.budget", outcome: "ok", team, target: control.id, detail: said });
  } catch (error) {
    notice = { error: reasonOf(error) };
    await record(viewer ?? (await getViewer()), { action: "team.budget", outcome: "refused", team, target: null, detail: notice.error });
  }
  redirect(withNotice(`/t/${team}`, notice));
}
