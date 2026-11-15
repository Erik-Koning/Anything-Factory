// a6g act <team> <control>: one action the operator asked for on the web app (lib/tasks/controls.ts TEAM_ACTIONS),
// run on the team's lead, and what came of it written to the team's store for the app to show. The lead's watchdog
// starts it as a job of its own (lib/actions.ts); a person can run it again by hand with the control's id.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { machineName } from "../machine.ts";
import { entryOf, FACTORY_ROOT, PACKAGE, type RegistryEntry, teamFile } from "../paths.ts";
import { operatorOnly } from "../session.ts";
import { actedControl, type ActedOutcome, isTeamAction, type TeamAction } from "../tasks/controls.ts";
import { openStore } from "../tasks/store.ts";
import { die } from "../util.ts";
import { entryFor, rotateTeam, unregister } from "./team.ts";
import { watchOnce } from "./watchdog.ts";

const USAGE = "usage: a6g act <team> <control id>";
// How long a job may take: a restart waits up to half an hour for the app (a6g env), an upgrade's commit up to an hour
// for the merge lock.
const JOB_TIMEOUT_MS = 90 * 60_000;

// The last few lines a command printed, for the app: enough to say why, never a whole log.
const tail = (text: string, lines = 4): string =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join("\n")
    .slice(-600);

// An a6g command of this version, run in the team's checkout as the operator would.
function a6g(entry: RegistryEntry, args: string[]): { status: number; out: string } {
  const result = spawnSync(process.execPath, [entryOf(FACTORY_ROOT), ...args], {
    cwd: entry.home,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: JOB_TIMEOUT_MS,
    env: { ...process.env, A6G_HANDED_OVER: "1" },
  });
  return { status: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}` };
}

const pinOf = (entry: RegistryEntry): string | null => {
  try {
    return (JSON.parse(readFileSync(teamFile(entry.home), "utf8")) as { factory?: string }).factory ?? null;
  } catch {
    return null;
  }
};
const changed = (entry: RegistryEntry, path: string): boolean =>
  (spawnSync("git", ["status", "--porcelain", "--", path], { cwd: entry.home, encoding: "utf8" }).stdout ?? "").trim() !== "";

// Runs one action. Resolves to what came of it, in the words the app shows.
export async function runAction(entry: RegistryEntry, action: TeamAction): Promise<{ outcome: Exclude<ActedOutcome, "started" | "waiting">; said: string }> {
  if (action === "rotate") {
    const { refused, now } = await rotateTeam(entry);
    return refused
      ? { outcome: "failed", said: `The planner wasn't restarted: ${refused}.` }
      : { outcome: "done", said: `The planner restarted on a fresh thread (${now}).` };
  }
  if (action === "wake") {
    const why = await watchOnce(entry.name);
    if (why) return { outcome: "failed", said: `The watchdog didn't run: ${why}.` };
    const paused = existsSync(join(entry.run, "paused"));
    return { outcome: "done", said: paused ? "The watchdog ran for the team. It's paused, and stays paused until it's resumed." : "The watchdog ran for the team." };
  }
  if (action === "env") {
    const { status, out } = a6g(entry, ["env", "restart"]);
    return status === 0
      ? { outcome: "done", said: `The environment restarted.${tail(out, 1) ? ` ${tail(out, 1)}` : ""}` }
      : { outcome: "failed", said: `The environment didn't restart:\n${tail(out) || `exit ${status}`}` };
  }
  if (action === "upgrade") {
    const from = pinOf(entry);
    if (from === PACKAGE.version) return { outcome: "done", said: `It's on ${PACKAGE.version} already, the newest version on its Mac.` };
    const upgraded = a6g(entry, ["upgrade", entry.name, PACKAGE.version]);
    if (upgraded.status !== 0) return { outcome: "failed", said: `It wasn't upgraded:\n${tail(upgraded.out) || `exit ${upgraded.status}`}` };
    // The pin, committed as a merge would be: under the merge lock, so the queue never sees it uncommitted.
    const file = ".a6g/team.json";
    if (changed(entry, file)) {
      const message = `Team: factory ${PACKAGE.version}${from ? ` (was ${from})` : ""}, upgraded from the web app`;
      const commit = a6g(entry, ["lock", "merge", "--wait-min", "60", "--", "git", "commit", "-q", "-m", message, "--", file]);
      if (commit.status !== 0)
        return {
          outcome: "failed",
          said: `It's on ${PACKAGE.version} now, but its pin isn't committed, which holds up the merge queue: commit .a6g/team.json on the integration branch.\n${tail(commit.out)}`,
        };
    }
    return { outcome: "done", said: `Upgraded from ${from ?? "its old version"} to ${PACKAGE.version}, its pin committed.` };
  }
  // unregister
  const status = await unregister([entry.name]);
  return status === 0
    ? { outcome: "done", said: "Taken off its Mac. Its checkout, run folder and history are kept; a6g register on its Mac brings it back." }
    : { outcome: "failed", said: `It wasn't taken off its Mac (exit ${status}).` };
}

export async function act(argv: string[]): Promise<number> {
  operatorOnly("act");
  const [name, id] = argv;
  if (!name || !id) die(USAGE);
  const entry = entryFor(name);
  const tasks = entry.tasks ?? die(`${name} keeps its tickets on a GitHub board, which has no actions`);
  const read = await openStore({ name, tasks }, entry.run);
  let action: TeamAction;
  try {
    const control = (await read.controls.all()).find((c) => c.id === id);
    if (control?.kind !== "action" || !isTeamAction(control.action)) die(`act: ${id} isn't an action on ${name}`);
    action = control.action;
  } finally {
    await read.close();
  }
  const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
  console.info(`${stamp()} ${name}: ${action} (${id})`);
  let result: Awaited<ReturnType<typeof runAction>>;
  try {
    result = await runAction(entry, action);
  } catch (error) {
    result = { outcome: "failed", said: `It stopped: ${(error as Error).message.split("\n")[0]}` };
  }
  console.info(`${stamp()} ${name}: ${action} (${id}) ${result.outcome}: ${result.said}`);
  // The team's watchdog log has it too (the run folder stays, even once the team is off this Mac).
  appendFileSync(join(entry.run, "watchdog.log"), `${stamp()} the operator's ${action} (${id}): ${result.outcome}: ${result.said.split("\n")[0]}\n`);
  const store = await openStore({ name, tasks }, entry.run);
  try {
    await store.controls.create(actedControl(name, machineName(), { of: id, ...result }));
  } finally {
    await store.close();
  }
  return result.outcome === "done" ? 0 : 1;
}
