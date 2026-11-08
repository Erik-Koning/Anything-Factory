"use server";
// People, the admins': invite, set a role per team, remove from a team, ban and unban. Each checks the admin and
// their second factor first (allowed), then Better Auth's admin plugin, called on the server with the admin's own
// session, does the account's part.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withNotice } from "../../../components/ui.tsx";
import { invitationProblem, isTeamRole, LIMITS, TEAM_PARAM } from "../../../server/access.ts";
import { auth, isAdminRole } from "../../../server/auth.ts";
import { Refused, teamDoc } from "../../../server/factory.ts";
import { unlinkAllOf, unlinkIfNotAllowed } from "../../../server/machines.ts";
import { changeRole, removeMembership, setMembership } from "../../../server/people.ts";
import type { AuditAction } from "../../../server/audit.ts";
import { allowed, getViewer, NotAllowed, type Person, record } from "../../../server/viewer.ts";

const BACK = "/admin/people";
const text = (form: FormData, key: string): string => {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
};
function reasonOf(error: unknown): string {
  if (error instanceof NotAllowed || error instanceof Refused) return error.message;
  const message = (error as { body?: { message?: string }; message?: string })?.body?.message;
  if (message) return message;
  console.error(error);
  return "Something went wrong; try again.";
}
// What a change did, for the notice and the audit log.
interface Done {
  ok: string;
  target: string;
  team?: string;
  detail?: string;
}
// Each change: the admin and their second factor checked, the work done, and both kinds of outcome recorded.
async function run(action: AuditAction, form: FormData, work: (admin: Person) => Promise<Done>): Promise<never> {
  let notice: { ok?: string; error?: string };
  let admin: Person | null = null;
  try {
    admin = await allowed("people:manage");
    const done = await work(admin);
    notice = { ok: done.ok };
    await record(admin, { action, outcome: "ok", target: done.target, team: done.team ?? null, detail: done.detail ?? null });
  } catch (error) {
    notice = { error: reasonOf(error) };
    await record(admin ?? (await getViewer()), {
      action,
      outcome: "refused",
      target: text(form, "email") || text(form, "userId") || null,
      team: text(form, "team") || null,
      detail: notice.error,
    });
  }
  redirect(withNotice(BACK, notice));
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
async function userById(id: string): Promise<{ id: string; name: string; email: string; role?: string | null; banned?: boolean | null }> {
  if (!USER_ID.test(id)) throw new Refused("No such person.");
  const found = await (await auth().$context).internalAdapter.findUserById(id);
  if (!found) throw new Refused("No such person.");
  return found as { id: string; name: string; email: string; role?: string | null; banned?: boolean | null };
}

// Invites someone to a team: their account when new (no password: they sign in by email or a passkey), their role
// and stakeholder record on the team, and for a new account an invitation with a sign-in link.
export async function inviteAction(form: FormData): Promise<void> {
  await run("person.invited", form, async () => {
    const email = text(form, "email").toLowerCase();
    const name = text(form, "name");
    const team = text(form, "team");
    const role = text(form, "role");
    const label = text(form, "label") || "stakeholder";
    const problem = invitationProblem({ email, name, team, role, label });
    if (problem || !isTeamRole(role)) throw new Refused(problem ?? "Choose member or contributor.");
    const settings = await teamDoc(team);
    if (!settings) throw new Refused("No such team.");
    const context = await auth().$context;
    const known = (await context.internalAdapter.findUserByEmail(email))?.user as { id: string; name: string; email: string; role?: string } | undefined;
    const user = known ?? (await auth().api.createUser({ body: { email, name, role: "user" }, headers: await headers() })).user;
    await setMembership({ userId: user.id, name: user.name, email: user.email }, team, role, label);
    if (known) return { ok: `${known.email} is now a ${role} of ${team}.`, target: known.email, team, detail: `${role}, already had an account` };
    await auth().api.signInMagicLink({ body: { email, callbackURL: `/t/${team}`, metadata: { team: settings.title || team } }, headers: await headers() });
    return { ok: `Invited ${email} to ${team} as a ${role}; they have a sign-in link by email.`, target: email, team, detail: role };
  });
}

export async function changeRoleAction(form: FormData): Promise<void> {
  await run("person.role", form, async () => {
    const user = await userById(text(form, "userId"));
    const team = text(form, "team");
    const role = text(form, "role");
    if (!TEAM_PARAM.test(team) || !isTeamRole(role)) throw new Refused("Choose member or contributor.");
    if (!(await changeRole(user.id, team, role))) throw new Refused(`${user.email} isn't on ${team}.`);
    const unlinked = await unlinkIfNotAllowed(user.id);
    return {
      ok: `${user.email} is now a ${role} of ${team}${machinesEnded(unlinked)}.`,
      target: user.email,
      team,
      detail: `${role}${machinesEnded(unlinked)}`,
    };
  });
}

export async function removeAction(form: FormData): Promise<void> {
  await run("person.removed", form, async () => {
    const user = await userById(text(form, "userId"));
    const team = text(form, "team");
    if (!TEAM_PARAM.test(team)) throw new Refused("No such team.");
    await removeMembership(user.id, team);
    const unlinked = await unlinkIfNotAllowed(user.id);
    return {
      ok: `${user.email} is no longer on ${team}${machinesEnded(unlinked)}.`,
      target: user.email,
      team,
      ...(unlinked ? { detail: machinesEnded(unlinked).slice(2) } : {}),
    };
  });
}

// "; their 2 machines are unlinked", when a change leaves someone who may no longer link machines (access.ts) with some.
const machinesEnded = (n: number): string => (n ? `; ${n === 1 ? "their machine is" : `their ${n} machines are`} unlinked` : "");

// A ban ends every session the person has, unlinks their machines, and keeps them from signing in; admins are managed
// by create-admin.
export async function banAction(form: FormData): Promise<void> {
  await run("person.banned", form, async () => {
    const user = await userById(text(form, "userId"));
    if (isAdminRole(user.role)) throw new Refused("Admins aren't banned from here; remove one with create-admin on the operator's machine.");
    const reason = text(form, "reason").slice(0, LIMITS.label) || "removed by an admin";
    await auth().api.banUser({ body: { userId: user.id, banReason: reason }, headers: await headers() });
    const unlinked = await unlinkAllOf(user.id);
    return {
      ok: `${user.email} is banned and signed out everywhere${machinesEnded(unlinked)}.`,
      target: user.email,
      detail: `${reason}${machinesEnded(unlinked)}`,
    };
  });
}

export async function unbanAction(form: FormData): Promise<void> {
  await run("person.unbanned", form, async () => {
    const user = await userById(text(form, "userId"));
    await auth().api.unbanUser({ body: { userId: user.id }, headers: await headers() });
    return { ok: `${user.email} can sign in again.`, target: user.email };
  });
}
