// The operator's controls (lib/tasks/controls.ts), applied in a team's run folder, where the guard and the watchdog
// read them: `paused` (nothing starts or merges, as e9g pause always did), hold.json (a pause and how far it has got),
// budget.json (the limits in force) and controls-applied (the newest control applied, so each applies once). The
// watchdog applies new ones on every run, and e9g pause, resume and budget at once.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Control, describeHold, type HoldState, holdOf, holdReport, type Limits, settling } from "./tasks/controls.ts";
import { nowIso, type Task } from "./tasks/model.ts";
import { readJson, writeJson } from "./util.ts";

const holdFile = (run: string): string => join(run, "hold.json");
const budgetFile = (run: string): string => join(run, "budget.json");
const pausedFile = (run: string): string => join(run, "paused");

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

const whoAsked = (by: string): string => (by === "budget" ? "the budget" : by.startsWith("web:") ? "the operator (web app)" : "the operator");
const money = (n: number | null): string => (n === null ? "none" : `$${n}`);

// Applies the controls newer than the last applied, in order. Resolves to lines for the team's log, and messages for
// the planner, which the caller sends when there's a planner: those that `wake` it start a turn; the rest only matter
// to a planner in the middle of one.
export function applyControls(run: string, controls: Control[]): { log: string[]; tell: { text: string; wake: boolean }[] } {
  const appliedFile = join(run, "controls-applied");
  const last = existsSync(appliedFile) ? Number(readFileSync(appliedFile, "utf8")) || 0 : 0;
  const log: string[] = [];
  const tell: { text: string; wake: boolean }[] = [];
  for (const control of controls) {
    const n = Number(/^k(\d+)$/.exec(control.id)?.[1] ?? 0);
    if (n <= last) continue;
    const hold = control.kind === "pause" ? holdOf([control]) : null;
    if (hold && hold.scope !== "now" && existsSync(pausedFile(run))) {
      log.push(`${whoAsked(control.by)} asked to pause after ${describeHold(hold)}, but the team is paused already`);
    } else if (hold) {
      const state: HoldState = { ...hold, settledAt: hold.scope === "now" ? control.at : null, left: [], stuck: [], report: null };
      writeJson(holdFile(run), state);
      if (hold.scope === "now") writeFileSync(pausedFile(run), control.at);
      log.push(`${whoAsked(control.by)} paused the team ${hold.scope === "now" ? "now" : `after ${describeHold(hold)}`}`);
      tell.push(
        hold.scope === "now"
          ? { text: "The operator paused the team: merge nothing and start no members until they resume it. Finish your turn.", wake: false }
          : {
              text:
                `The operator is pausing the team after ${describeHold(hold)}${hold.note ? `, and wrote: "${hold.note}"` : ""}. ` +
                "Finish that work and merge it, its verification and polish included; claim, start and plan nothing outside it. " +
                "Once nothing in it can move, the team pauses until they resume it.",
              wake: true,
            }
      );
    } else if (control.kind === "resume") {
      rmSync(pausedFile(run), { force: true });
      rmSync(holdFile(run), { force: true });
      log.push(`${whoAsked(control.by)} resumed the team`);
      tell.push({
        text:
          `The operator resumed the team${control.note ? `, and wrote:\n\n${control.note}\n\n` : ". "}` +
          "Record what they said where it belongs (the tasks it concerns, decisions.md), then carry on.",
        wake: true,
      });
    } else if (control.kind === "budget") {
      if (control.limits) writeJson(budgetFile(run), control.limits);
      else rmSync(budgetFile(run), { force: true });
      const l = control.limits;
      log.push(l ? `the budget is now ${money(l.daily)} a day, ${money(l.weekly)} a week, ${money(l.total)} in all` : "the budget was cleared");
    }
    writeFileSync(appliedFile, String(n));
  }
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
