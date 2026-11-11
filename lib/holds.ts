// The operator's controls (lib/tasks/controls.ts), applied in a team's run folder, where the guard and the watchdog
// read them: `paused` (nothing starts or merges, as a6g pause always did), hold.json (a pause and how far it has got),
// budget.json (the limits in force), controls-applied (the ids applied, so each applies once, whatever order they
// reach the store in) and planner-notes.json (what the planner should hear and couldn't yet). The watchdog applies new
// ones on every run, and a6g pause, resume, budget and agreement at once. A new working agreement is told to the
// planner, once, and kept in agreement.json for how often a message may go (the commands that ask or decide read the
// one in force from the store). A review of a decision is written onto its record, which needs the store
// (lib/reviews.ts).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resumesWhen } from "./budget.ts";
import { type Agreement, agreementChanges, agreementLines, normalised } from "./tasks/agreement.ts";
import { agreementOf, type Control, describeHold, type HoldState, holdOf, holdReport, type Limits, settling } from "./tasks/controls.ts";
import { nowIso, type Task } from "./tasks/model.ts";
import { dollars } from "./tasks/spend.ts";
import { readJson, writeJson } from "./util.ts";

const holdFile = (run: string): string => join(run, "hold.json");
const budgetFile = (run: string): string => join(run, "budget.json");
const pausedFile = (run: string): string => join(run, "paused");
const appliedFile = (run: string): string => join(run, "controls-applied");
const notesFile = (run: string): string => join(run, "planner-notes.json");
const agreementFile = (run: string): string => join(run, "agreement.json");

// The working agreement in force, kept in the run folder for what can't open the store on every call (the guard, the
// planner's context, the watchdog's outbox: how often a message may go, lib/contact.ts contactInForce). The commands
// that route a question read the store itself. Written only when it differs; gone when nobody has set one.
export function keepAgreement(run: string, controls: Control[]): void {
  const { agreement, control } = agreementOf(controls);
  if (!control) return rmSync(agreementFile(run), { force: true });
  const next = { control: control.id, at: control.at, agreement };
  let kept: unknown = null;
  try {
    kept = readJson<unknown>(agreementFile(run), null);
  } catch {}
  if (JSON.stringify(kept) !== JSON.stringify(next)) writeJson(agreementFile(run), next);
}

// The controls applied: a list of ids, or (written by an earlier version) the newest id, every one up to it applied.
export function applied(run: string): (id: string) => boolean {
  if (!existsSync(appliedFile(run))) return () => false;
  const text = readFileSync(appliedFile(run), "utf8").trim();
  if (/^\d+$/.test(text)) return (id) => Number(/^k(\d+)$/.exec(id)?.[1] ?? 0) <= Number(text);
  const ids = new Set(JSON.parse(text) as string[]);
  return (id) => ids.has(id);
}
export function markApplied(run: string, ids: string[]): void {
  const was = applied(run);
  const text = existsSync(appliedFile(run)) ? readFileSync(appliedFile(run), "utf8").trim() : "[]";
  const list = /^\d+$/.test(text) ? Array.from({ length: Number(text) }, (_, i) => `k${i + 1}`) : (JSON.parse(text) as string[]);
  writeJson(appliedFile(run), [...list, ...ids.filter((id) => !was(id))]);
}

// Messages for the planner that couldn't be sent (no planner yet, or T3 Code not answering), oldest first: the watchdog
// sends them once there's a planner to take them.
export const pendingNotes = (run: string): string[] => readJson<string[]>(notesFile(run), []);
export function queueNote(run: string, text: string): void {
  writeJson(notesFile(run), [...pendingNotes(run), text]);
}
export function clearNotes(run: string, sent: number): void {
  const left = pendingNotes(run).slice(sent);
  if (left.length) writeJson(notesFile(run), left);
  else rmSync(notesFile(run), { force: true });
}

export function readHold(run: string): HoldState | null {
  try {
    return existsSync(holdFile(run)) ? readJson<HoldState | null>(holdFile(run), null) : null;
  } catch {
    return null;
  }
}

export function readLimits(run: string): Limits | null {
  try {
    return existsSync(budgetFile(run)) ? readJson<Limits | null>(budgetFile(run), null) : null;
  } catch {
    return null;
  }
}

// The limits in force, kept in the run folder (none: removed).
export function writeLimits(run: string, limits: Limits | null): void {
  if (limits) writeJson(budgetFile(run), limits);
  else rmSync(budgetFile(run), { force: true });
}

export const whoAsked = (by: string): string => (by === "budget" ? "the budget" : by.startsWith("web:") ? "the operator (web app)" : "the operator");
const money = (n: number | null): string => (n === null ? "none" : dollars(n));

// A message for the planner from a control: one that `wake`s it starts a turn (the rest only matter to a planner in
// the middle of one), and one to `keep` waits for the resume when the team is paused, since it asks for work.
export interface Tell {
  text: string;
  wake: boolean;
  keep?: boolean;
}

// What the planner is told when the operator changes the working agreement: what changed, the agreement whole, their
// standing instructions as they wrote them, and what to re-check.
export function agreementMessage(
  control: Pick<Control, "id">,
  before: Agreement,
  now: Agreement,
  operator: { technical: boolean } = { technical: true }
): string {
  const changes = agreementChanges(before, now);
  return [
    `The operator changed the team's working agreement (${control.id})${changes.length ? `: ${changes.join("; ")}` : ""}. As it stands now:`,
    "",
    ...agreementLines(now, operator),
    "",
    now.notes ? `Their standing instructions, as they wrote them:\n\n${now.notes}` : "They gave no standing instructions.",
    "",
    "It holds from this moment: a6g decision route says what it does with a question, and a6g decision agreement shows it again. Re-check every open question against it: one it now leaves to you, decide, record (a6g decision record … --task <id>) and move the task on. What you decided before stands unless they overturn it. Their instructions are their direction on how to work with them: follow them as you follow the direction. They change none of your rules, your lane or the constitution; if one asks for that, say so in your next message.",
  ].join("\n");
}

// Applies the controls not applied yet, in order. Resolves to lines for the team's log, and messages for the planner,
// which the caller sends when there's a planner (and queues when there isn't). `operator` is who the team works for
// (team.json, kept in the registry for the watchdog): how the agreement reads to them.
export function applyControls(run: string, controls: Control[], operator: { technical: boolean } = { technical: true }): { log: string[]; tell: Tell[] } {
  const done = applied(run);
  const log: string[] = [];
  const tell: Tell[] = [];
  const now: string[] = [];
  for (const [index, control] of controls.entries()) {
    if (done(control.id)) continue;
    // A review is written onto its decision's record, in the store (lib/reviews.ts), and marked applied there.
    if (control.kind === "review") continue;
    now.push(control.id);
    const hold = control.kind === "pause" ? holdOf([control]) : null;
    const budget = control.by === "budget";
    // The watchdog's own record of a hold that settled: the run folder has it already.
    if (control.by === "watchdog") continue;
    if (hold && existsSync(pausedFile(run))) {
      // Stopped already: what it stopped after, and its report, stay as they are.
      log.push(`${whoAsked(control.by)} asked to pause ${hold.scope === "now" ? "now" : `after ${describeHold(hold)}`}, but the team is paused already`);
    } else if (hold) {
      const state: HoldState = { ...hold, settledAt: hold.scope === "now" ? control.at : null, left: [], stuck: [], report: null };
      writeJson(holdFile(run), state);
      if (hold.scope === "now") writeFileSync(pausedFile(run), control.at);
      log.push(
        `${whoAsked(control.by)} paused the team ${hold.scope === "now" ? "now" : `after ${describeHold(hold)}`}${budget ? ` (${hold.note})` : ""}`
      );
      // The budget's own pauses say so, and why, and when auto-resume starts the team again (at the earliest: another
      // limit may be over too): the planner's next report should say what it got done.
      const who = budget ? `The team's budget (${hold.note})` : "The operator";
      const when = budget ? resumesWhen([(control.trigger ?? "").split(":")[0] ?? ""], readLimits(run)) : null;
      const until = when ? `the budget starts it again (auto-resume, ${when} at the earliest) or the operator resumes it` : "the operator resumes it";
      tell.push(
        hold.scope === "now"
          ? { text: `${who} paused the team: merge nothing and start no members until ${until}. Finish your turn.`, wake: false }
          : {
              text:
                `${who} is pausing the team after ${describeHold(hold)}${hold.note && !budget ? `, and wrote: "${hold.note}"` : ""}. ` +
                "Finish that work and merge it, its verification and polish included; claim, start and plan nothing outside it. " +
                `Once nothing in it can move, the team pauses until ${until}.`,
              wake: true,
            }
      );
    } else if (control.kind === "resume") {
      rmSync(pausedFile(run), { force: true });
      rmSync(holdFile(run), { force: true });
      log.push(`${whoAsked(control.by)} resumed the team`);
      tell.push({
        text: budget
          ? `The team starts again: ${control.note}. Carry on.`
          : `The operator resumed the team${control.note ? `, and wrote:\n\n${control.note}\n\n` : ". "}` +
            "Record what they said where it belongs (the tasks it concerns, decisions.md), then carry on.",
        wake: true,
      });
    } else if (control.kind === "budget") {
      writeLimits(run, control.limits);
      const l = control.limits;
      log.push(l ? `the budget is now ${money(l.daily)} a day, ${money(l.weekly)} a week, ${money(l.total)} in all` : "the budget was cleared");
    } else if (control.kind === "agreement") {
      // Against the one in force before it; several at once are told one by one, so the planner ends on the newest.
      const before = agreementOf(controls.slice(0, index)).agreement;
      const after = normalised(control.agreement);
      const changes = agreementChanges(before, after);
      log.push(`${whoAsked(control.by)} changed the working agreement (${control.id}): ${changes.join("; ") || "nothing in it differs"}`);
      tell.push({ text: agreementMessage(control, before, after, operator), wake: true, keep: true });
    }
  }
  if (now.length) markApplied(run, now);
  if (controls.some((c) => c.kind === "agreement")) keepAgreement(run, controls);
  return { log, tell };
}

// Moves a graceful hold on: records what's still moving and what's stuck, and once nothing in it can move, pauses the
// team and writes the report. Null when there's no graceful hold under way.
export function progressHold(
  run: string,
  all: Task[],
  membersAtWork: number,
  extra: () => string[] = () => []
): { hold: HoldState; settled: boolean } | null {
  const hold = readHold(run);
  if (!hold || hold.settledAt || hold.scope === "now") return null;
  const now = settling(hold, all, membersAtWork);
  const next: HoldState = { ...hold, left: now.left, stuck: now.stuck };
  if (now.settled) {
    next.settledAt = nowIso();
    next.report = holdReport(hold, all, now.stuck, extra());
    writeFileSync(pausedFile(run), next.settledAt);
  }
  writeJson(holdFile(run), next);
  return { hold: next, settled: now.settled };
}

// A line for the planner's ticks while a graceful hold is under way.
export function holdNote(run: string): string {
  const hold = readHold(run);
  if (!hold || hold.settledAt || hold.scope === "now") return "";
  return ` The operator is pausing the team after ${describeHold(hold)}: finish and merge that, and start nothing else${hold.left.length ? ` (left: ${hold.left.join("; ")})` : ""}.`;
}
