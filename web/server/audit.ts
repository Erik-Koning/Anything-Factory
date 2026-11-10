// The audit log: who did what, when, from which IP address and device, and whether it worked. One document per event
// in the accounts database, written once: the app inserts and reads events, never changes or deletes one, and MongoDB
// expires each after AUDIT_RETENTION_DAYS. It keeps names and addresses as the accounts do, so only admins read it
// (and each person their own); the team's agents never see this database (Article 8).
//
// Sign-ups, sign-ins, sign-outs, second factors, new IP addresses, passkeys and authenticators are recorded from Better
// Auth's hooks (auth.ts); people, tasks, decisions, requests, pauses, resumes, budgets, linked machines and a person's
// own choices (the IP check, the authenticator put off) from the server actions and endpoints that make them.
import type { Db } from "mongodb";
import { config } from "./config.ts";
import { authDb } from "./db.ts";

export const AUDIT_ACTIONS = [
  "sign-up",
  "sign-in",
  "sign-in-link",
  "sign-out",
  "session.ended",
  "second-factor",
  "ip.challenged",
  "ip.confirmed",
  "ip.denied",
  "ip.forgotten",
  "ip-check.on",
  "ip-check.off",
  "passkey.added",
  "passkey.removed",
  "authenticator.on",
  "authenticator.off",
  "authenticator.later",
  "backup-codes.new",
  "person.invited",
  "person.role",
  "person.removed",
  "person.banned",
  "person.unbanned",
  "task.added",
  "task.suggested",
  "task.decided",
  "task.answered",
  "request.sent",
  "team.paused",
  "team.resumed",
  "team.budget",
  "notifications.changed",
  "notifications.test",
  "machine.linked",
  "machine.refused",
  "machine.token",
  "machine.refused-token",
  "machine.unlinked",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const isAuditAction = (value: unknown): value is AuditAction => typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);

export const OUTCOMES = ["ok", "failed", "refused"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface AuditEntry {
  action: AuditAction;
  outcome: Outcome;
  // Who did it, when known: a failed sign-in for an address nobody has has no user, only the address typed.
  userId: string | null;
  email: string | null;
  ip: string | null;
  userAgent: string | null;
  sessionId?: string | null;
  team?: string | null;
  // What it was done to: a task's number, a person's address, a passkey's name.
  target?: string | null;
  // How, or why not: "passkey", "email link", the reason a sign-in was refused.
  detail?: string | null;
}
export interface AuditEvent extends AuditEntry {
  id: string;
  at: Date;
}
interface AuditDoc extends AuditEntry {
  at: Date;
  expiresAt: Date;
}

const LIMITS = { email: 254, ip: 64, userAgent: 300, team: 64, target: 200, detail: 500 } as const;
const cut = (text: string | null | undefined, max: number): string | null => (text ? text.slice(0, max) : null);

let indexed: Promise<unknown> | null = null;
const events = (db: Db = authDb()) => db.collection<AuditDoc>("audit");
export function ensureIndexes(): Promise<unknown> {
  indexed ??= Promise.all([
    events().createIndex({ at: -1 }),
    events().createIndex({ userId: 1, at: -1 }),
    events().createIndex({ email: 1, at: -1 }),
    events().createIndex({ action: 1, at: -1 }),
    events().createIndex({ ip: 1, at: -1 }),
    events().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]).catch((error: unknown) => {
    // The app's database user may lack createIndex; the log still works, only slower and without expiry.
    console.warn("audit: indexes not made:", (error as Error).message);
  });
  return indexed;
}

// Records an event. A failure to record is logged, not thrown: the action it describes has already happened.
export async function audit(entry: AuditEntry, now = new Date()): Promise<void> {
  void ensureIndexes();
  const doc: AuditDoc = {
    action: entry.action,
    outcome: entry.outcome,
    userId: entry.userId,
    email: cut(entry.email?.toLowerCase(), LIMITS.email),
    ip: cut(entry.ip, LIMITS.ip),
    userAgent: cut(entry.userAgent, LIMITS.userAgent),
    sessionId: entry.sessionId ?? null,
    team: cut(entry.team, LIMITS.team),
    target: cut(entry.target, LIMITS.target),
    detail: cut(entry.detail, LIMITS.detail),
    at: now,
    expiresAt: new Date(now.getTime() + config().auditDays * 86_400_000),
  };
  try {
    await events().insertOne(doc);
  } catch (error) {
    console.error("audit: event not recorded:", entry.action, (error as Error).message);
  }
}

export interface AuditQuery {
  action?: AuditAction | null;
  outcome?: Outcome | null;
  userId?: string | null;
  email?: string | null;
  ip?: string | null;
  // Events before this one (by its id), for the next page.
  before?: string | null;
  limit?: number;
}

const OBJECT_ID = /^[0-9a-f]{24}$/;

// Events, newest first.
export async function listAudit(query: AuditQuery = {}): Promise<AuditEvent[]> {
  const { ObjectId } = await import("mongodb");
  const filter: Record<string, unknown> = {};
  if (query.action) filter["action"] = query.action;
  if (query.outcome) filter["outcome"] = query.outcome;
  if (query.userId) filter["userId"] = query.userId;
  if (query.email) filter["email"] = query.email.trim().toLowerCase();
  if (query.ip) filter["ip"] = query.ip.trim();
  if (query.before && OBJECT_ID.test(query.before)) filter["_id"] = { $lt: new ObjectId(query.before) };
  const rows = await events()
    .find(filter)
    .sort({ _id: -1 })
    .limit(Math.min(Math.max(query.limit ?? 50, 1), 200))
    .toArray();
  return rows.map(({ _id, expiresAt: _expires, ...doc }) => ({ ...doc, id: String(_id) }));
}

// How an event reads in a list: "Signed in", "Confirmed a new IP address"…
export const ACTION_LABEL: Record<AuditAction, string> = {
  "sign-up": "Sign-up",
  "sign-in": "Sign-in",
  "sign-in-link": "Sign-in link asked for",
  "sign-out": "Signed out",
  "session.ended": "Session ended",
  "second-factor": "Second factor",
  "ip.challenged": "New IP address: confirmation emailed",
  "ip.confirmed": "New IP address confirmed",
  "ip.denied": "New IP address reported: “it wasn't me”",
  "ip.forgotten": "IP address forgotten",
  "ip-check.on": "Check of new IP addresses turned on",
  "ip-check.off": "Check of new IP addresses turned off",
  "passkey.added": "Passkey added",
  "passkey.removed": "Passkey removed",
  "authenticator.on": "Authenticator turned on",
  "authenticator.off": "Authenticator turned off",
  "authenticator.later": "Authenticator put off at sign-up",
  "backup-codes.new": "New backup codes",
  "person.invited": "Person invited",
  "person.role": "Role changed",
  "person.removed": "Removed from a team",
  "person.banned": "Person banned",
  "person.unbanned": "Person unbanned",
  "task.added": "Task added",
  "task.suggested": "Task suggested",
  "task.decided": "Decision",
  "task.answered": "Answer to the team",
  "request.sent": "Request sent",
  "team.paused": "Team paused",
  "team.resumed": "Team resumed",
  "team.budget": "Budget set",
  "notifications.changed": "Notification settings changed",
  "notifications.test": "Test email sent",
  "machine.linked": "Machine linked",
  "machine.refused": "Machine refused",
  "machine.token": "Machine's token issued",
  "machine.refused-token": "A machine's token refused",
  "machine.unlinked": "Machine unlinked",
};
