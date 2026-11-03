// Who's asking: the session's person, their roles per team, whether the session has its second factor, and whether
// the request comes from an IP address they've confirmed. Every page and server action starts here; access.ts says
// what they may do.
import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { type Ability, can, isTeamRole, pendingStep, type TeamRole, type Viewer } from "./access.ts";
import { audit, type AuditEntry } from "./audit.ts";
import { auth, clientIp, isAdminRole } from "./auth.ts";
import { config } from "./config.ts";
import { isKnownIp } from "./known-ips.ts";
import { originAllowed } from "./origin-check.ts";
import { memberships } from "./people.ts";

export interface Person extends Viewer {
  name: string;
  email: string;
  sessionId: string;
  // The request's IP address, as the session and the audit log read it.
  ip: string | null;
}

// The request's headers for Better Auth, with the cookies as they are now: a server action that swapped the session
// (turning on an authenticator does) re-renders its page in the same round trip, with the new cookie in Next's cookie
// store but the old one still in the raw headers.
export async function authHeaders(): Promise<Headers> {
  const merged = new Headers(await headers());
  const jar = (await cookies()).toString();
  if (jar) merged.set("cookie", jar);
  else merged.delete("cookie");
  return merged;
}

export const getViewer = cache(async (): Promise<Person | null> => {
  const requestHeaders = await authHeaders();
  // Not through the CDN, nobody: the proxy refuses such a request already; this holds if it ever doesn't run.
  if (!originAllowed(requestHeaders, config().originSecret)) return null;
  const current = await auth().api.getSession({ headers: requestHeaders });
  if (!current) return null;
  const ip = clientIp(requestHeaders);
  const [rows, ipConfirmed] = await Promise.all([memberships({ userId: current.user.id }), isKnownIp(current.user.id, ip)]);
  const teams: Record<string, TeamRole> = {};
  for (const m of rows) if (isTeamRole(m.role)) teams[m.team] = m.role;
  return {
    userId: current.user.id,
    name: current.user.name,
    email: current.user.email,
    admin: isAdminRole(current.user.role),
    secondFactor: current.session.secondFactor === true,
    twoFactor: current.user.twoFactorEnabled === true,
    ipConfirmed,
    sessionId: current.session.id,
    ip,
    teams,
  };
});

// Where a session that still owes a step is sent.
export const STEP_PAGE = { "second-factor": "/second-factor", "confirm-ip": "/confirm-sign-in" } as const;

// For pages: the signed-in person, or off to sign in, or to the step their session still owes.
export async function requireViewer(): Promise<Person> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step) redirect(STEP_PAGE[step]);
  return viewer;
}

// What a server action refuses with: the browser is sent back to `back` with the reason.
export class NotAllowed extends Error {}

const STEP_REFUSAL = {
  "second-factor": "Enter your authenticator's code first.",
  "confirm-ip": "Confirm this sign-in from the email we sent first.",
} as const;

// For server actions: the person, when they may do `ability` (on `team`); otherwise NotAllowed, before anything is read
// or written.
export async function allowed(ability: Ability, team?: string): Promise<Person> {
  const viewer = await getViewer();
  if (!viewer) throw new NotAllowed("Sign in first.");
  const step = pendingStep(viewer);
  if (step) throw new NotAllowed(STEP_REFUSAL[step]);
  if (!can(viewer, ability, team)) throw new NotAllowed("You can't do that here.");
  return viewer;
}

// Records what `viewer` did in the audit log, with the request's IP address and device.
export async function record(viewer: Person | null, entry: Omit<AuditEntry, "userId" | "email" | "ip" | "userAgent" | "sessionId">): Promise<void> {
  const requestHeaders = await headers();
  await audit({
    ...entry,
    userId: viewer?.userId ?? null,
    email: viewer?.email ?? null,
    ip: viewer?.ip ?? clientIp(requestHeaders),
    userAgent: requestHeaders.get("user-agent"),
    sessionId: viewer?.sessionId ?? null,
  });
}
