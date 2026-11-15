// The operator's actions from the web app (lib/tasks/controls.ts TEAM_ACTIONS), on the team's lead. The watchdog's
// minute starts each new one as a job of its own (a6g act, lib/commands/act.ts), so it never waits on a restart or an
// upgrade, and marks it applied so it starts once; the job writes what came of it to the store (acted), which the web
// app shows. A planner restart waits until the planner is idle with no member running, saying why once per reason. One
// asked longer ago than ACTION_EXPIRES_MIN (this Mac asleep, or the team run nowhere meanwhile) isn't acted on, and
// says so: a restart then would surprise whoever is at work now. Deleting the team is the exception: it still holds.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { applied, markApplied, whoAsked } from "./holds.ts";
import { entryOf, FACTORY_ROOT, type RegistryEntry } from "./paths.ts";
import { plannerBusy } from "./steer.ts";
import { type Acted, actedControl, ACTION_WORDS, type ActedOutcome, type Control, type TeamAction } from "./tasks/controls.ts";
import type { Store } from "./tasks/store.ts";

export const ACTION_EXPIRES_MIN = 60;

// What the lead says when it starts a job for each.
const STARTED: Record<TeamAction, string> = {
  rotate: "Restarting the planner: its thread is retired and a fresh one starts.",
  env: "Restarting the environment, once nothing else holds the team's app.",
  upgrade: "Upgrading the team to the newest factory version on its Mac.",
  wake: "Running the watchdog for the team now.",
  unregister: "Taking the team off its Mac.",
};

// The job's log, beside the watchdog's: what each job printed.
export const actionsLog = (run: string): string => join(run, "actions.log");

// Starts `a6g act <team> <control>` as a job of its own, on this version of the factory, its output in actions.log.
export function startJob(entry: RegistryEntry, control: Control): void {
  mkdirSync(entry.run, { recursive: true });
  const out = openSync(actionsLog(entry.run), "a");
  try {
    spawn(process.execPath, [entryOf(FACTORY_ROOT), "act", entry.name, control.id], {
      cwd: entry.home,
      detached: true,
      stdio: ["ignore", out, out],
      // It runs on this version, whatever the team pins: the version the watchdog runs has the command.
      env: { ...process.env, A6G_HANDED_OVER: "1" },
    }).unref();
  } finally {
    closeSync(out);
  }
}

const sentence = (text: string): string => {
  const said = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(said) ? said : `${said}.`;
};

// Starts the actions not applied yet, oldest first. Resolves to lines for the team's log. `start` and `now` are for
// tests.
export async function applyActions(
  entry: RegistryEntry,
  store: Store,
  controls: Control[],
  machine: string,
  { start = startJob, now = Date.now() }: { start?: (entry: RegistryEntry, control: Control) => void; now?: number } = {}
): Promise<string[]> {
  const done = applied(entry.run);
  const words = new Map<string, Acted>();
  for (const c of controls) if (c.kind === "acted" && c.acted) words.set(c.acted.of, c.acted);
  const say = (control: Control, outcome: ActedOutcome, said: string) =>
    store.controls.create(actedControl(entry.name, machine, { of: control.id, outcome, said }));
  const log: string[] = [];
  for (const control of controls) {
    if (control.kind !== "action" || !control.action || done(control.id)) continue;
    const action = control.action;
    const what = ACTION_WORDS[action].asked.replace(/^Asked/, "asked");
    const minutes = Math.round((now - Date.parse(control.at)) / 60_000);
    if (action !== "unregister" && minutes > ACTION_EXPIRES_MIN) {
      markApplied(entry.run, [control.id]);
      await say(control, "failed", `It was asked ${minutes} minutes before this Mac picked it up, too long ago to act on now. Ask again if it's still wanted.`);
      log.push(`${whoAsked(control.by)} ${what} (${control.id}), ${minutes} minutes ago: too old to act on now, passed over`);
      continue;
    }
    if (action === "rotate") {
      const busy = plannerBusy(entry.run, "it restarts");
      if (busy) {
        const said = sentence(busy);
        if (words.get(control.id)?.said !== said) {
          await say(control, "waiting", said);
          log.push(`${whoAsked(control.by)} ${what} (${control.id}): waiting, as ${busy}`);
        }
        continue;
      }
    }
    // Said before the job starts, so its own word (done, failed) is always the newer.
    await say(control, "started", STARTED[action]);
    markApplied(entry.run, [control.id]);
    try {
      start(entry, control);
      log.push(`${whoAsked(control.by)} ${what} (${control.id}): started`);
    } catch (error) {
      const why = (error as Error).message.split("\n")[0] ?? "";
      await say(control, "failed", `The job didn't start: ${why}`);
      log.push(`${whoAsked(control.by)} ${what} (${control.id}): the job didn't start: ${why}`);
    }
  }
  return log;
}
