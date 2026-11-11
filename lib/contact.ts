// How often the planner's messages reach the operator (team.json "contact", or the working agreement when the operator
// set it there: contactInForce). In digest mode, everything waits for
// the next window and goes together; a message marked "Urgent:" goes at once, one per window; "Done" always goes.
// In priority mode, each goes as soon as the planner sends it. The guard holds the planner's own Gmail to it, the
// watchdog its outbox, and both read one record in the team's run folder of when each kind last went.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./util.ts";

export interface Contact {
  mode: "digest" | "priority";
  everyMin: number;
}
export const DEFAULT_CONTACT: Contact = { mode: "digest", everyMin: 240 };

// The rule in force: the working agreement's, when the operator set one there (a6g agreement --messages, or the web
// app), otherwise the team's own (`base`: team.json contact). Read from the run folder's copy of the agreement, which
// the watchdog keeps (lib/holds.ts keepAgreement): the guard, the planner's context and the outbox all ask here.
export function contactInForce(run: string | null, base: Contact): Contact {
  if (!run) return base;
  try {
    const kept = JSON.parse(readFileSync(join(run, "agreement.json"), "utf8")) as { agreement?: { contact?: Partial<Contact> } };
    const contact = kept.agreement?.contact;
    if (contact?.mode === "priority") return { mode: "priority", everyMin: 0 };
    if (contact?.mode === "digest" && typeof contact.everyMin === "number" && contact.everyMin > 0) return { mode: "digest", everyMin: contact.everyMin };
  } catch {}
  return base;
}

// What a registry entry asks of the watchdog, which runs from the current version for every team. An entry
// registered before the setting existed belongs to a version whose planner writes whenever it needs to, so its
// messages go as they come until the team is upgraded.
export const registeredContact = (contact: Contact | undefined): Contact => contact ?? { ...DEFAULT_CONTACT, mode: "priority" };

export type MessageKind = "done" | "urgent" | "normal";

// From a subject, with or without the labels in front ("[A6G-Planner] [My app] Urgent: …").
export function messageKind(subject: string): MessageKind {
  const bare = subject.replace(/^(\s*\[[^\]]*\])*\s*/, "");
  if (/^done\b/i.test(bare)) return "done";
  if (/^urgent\b/i.test(bare)) return "urgent";
  return "normal";
}

// When a digest (or a single message in its place) and an urgent message last reached the operator.
type Sent = { normalAt?: string; urgentAt?: string };
const recordFile = (run: string): string => join(run, "contact.json");
function readRecord(run: string): Sent {
  try {
    return existsSync(recordFile(run)) ? (JSON.parse(readFileSync(recordFile(run), "utf8")) as Sent) : {};
  } catch {
    return {};
  }
}

export function recordSent(run: string, kind: MessageKind, at = new Date()): void {
  if (kind === "done") return;
  writeFileAtomic(recordFile(run), `${JSON.stringify({ ...readRecord(run), [`${kind}At`]: at.toISOString() })}\n`);
}

// When a message of this kind may next go (epoch ms; at or before now means now).
export function nextAllowed(contact: Contact, run: string | null, kind: MessageKind, now = Date.now()): number {
  if (contact.mode === "priority" || !contact.everyMin || kind === "done" || !run) return now;
  const last = Date.parse(readRecord(run)[`${kind}At`] ?? "");
  return Number.isNaN(last) ? now : Math.max(now, last + contact.everyMin * 60_000);
}

const hours = (minutes: number): string => `${Number((minutes / 60).toFixed(1))} h`;
// The time today; with the day, when it isn't today (a window may be days long).
const clock = (ms: number, now = Date.now()): string => {
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString()
    ? time
    : `${time} on ${at.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
};

// The rule in one line, for the planner's prompt and a6g check.
export function contactRule(contact: Contact): string {
  if (contact.mode === "priority" || !contact.everyMin)
    return "priority: each message goes as soon as you send it. Still put every question open at the time in one message.";
  return `digest: at most one message every ${hours(contact.everyMin)}, with everything open in it. A subject starting "Urgent:" goes at once, one per ${hours(contact.everyMin)}, and only for a question that blocks most of the team's work; "Done" always goes.`;
}

// For the planner's context each wake: when it may next write to the operator. Null in priority mode.
export function contactStatus(contact: Contact, run: string | null, now = Date.now()): string | null {
  if (contact.mode === "priority" || !contact.everyMin) return null;
  const next = nextAllowed(contact, run, "normal", now);
  return `Messages to the operator (digest, every ${hours(contact.everyMin)}): ${
    next <= now
      ? "the next can go now, with every question open."
      : `the next can go from ${clock(next, now)}; keep questions as question tickets until then.`
  }`;
}

// Why a message can't go yet, for the guard's refusal.
export function waitReason(contact: Contact, kind: MessageKind, run: string | null, now = Date.now()): string | null {
  const from = nextAllowed(contact, run, kind, now);
  if (from <= now) return null;
  const every = hours(contact.everyMin);
  if (kind === "urgent") {
    const normal = nextAllowed(contact, run, "normal", now);
    return `one urgent message per ${every} (the contact rule in force), and one has gone. ${
      normal <= now
        ? 'Send this without "Urgent:", with every other open question in it: that can go now.'
        : `It goes in the next message, from ${clock(normal, now)}; keep it as a question ticket until then.`
    }`;
  }
  return `the operator gets one message every ${every} (the contact rule in force, a digest), and the next can go from ${clock(from, now)}. Keep this as a question ticket and send everything open together then. Only a question that blocks most of the team's work can go now, as "Urgent: …" (one per ${every}).`;
}
