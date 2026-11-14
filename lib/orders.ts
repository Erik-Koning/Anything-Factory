// This machine's side of an ask to start a team from the web app (lib/tasks/start.ts, docs/plans/run-from-the-site.md).
//
// A machine takes asks only once its operator said so at its terminal: `a6g connect app --projects <dir>` keeps the
// folder in ~/.a6g/app.json, and from then on its report names the repositories in that folder (lib/fleet.ts). The
// asks are controls of kind `start` in the task graphs' database, where the app writes its other controls; the
// watchdog reads those addressed to this machine at each full run and starts one at a time, in a process of its own
// (a6g projects start <team>, lib/commands/projects.ts), which says each step as a control of kind `starting`. The
// machine's link to the app stays one way: nothing the app answers a report with is acted on.
//
// Per ask, in ~/.a6g/orders: <team>.log (everything its steps printed), <team>.pid (the process carrying it out) and
// <team>.json (what it made, so a second try doesn't refuse its own repository).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appSettings } from "./app.ts";
import { type MachineProjects, REPORT_LIMITS } from "./fleet.ts";
import { machineName } from "./machine.ts";
import { A6G_HOME, FACTORY_ROOT, readRegistry } from "./paths.ts";
import { accounts, subscriptionState } from "./subscriptions.ts";
import { startingControl, startOf, type StartState } from "./tasks/controls.ts";
import { type MongoClientLike, storeOver } from "./tasks/mongo.ts";
import {
  GITHUB_LOGIN,
  githubRepoOf,
  REPO_NAME,
  repoOf,
  START_TEAM,
  type StartAsk,
  startEnded,
  startFrom,
  type StartStep,
  STEP_WORDS,
} from "./tasks/start.ts";
import type { Store } from "./tasks/store.ts";
import { readJson, writeJson } from "./util.ts";

export const ORDERS = join(A6G_HOME, "orders");
export const orderLog = (team: string): string => join(ORDERS, `${team}.log`);
const orderPid = (team: string): string => join(ORDERS, `${team}.pid`);
const orderFile = (team: string): string => join(ORDERS, `${team}.json`);
// The database a project from the web app keeps its tasks in: team.json's default (lib/config.ts).
export const ORDERS_DATABASE = "a6g";

// A path under the home folder as ~/…: the home folder's own path names its user.
export const underHome = (path: string): string => (path.startsWith(`${homedir()}/`) ? `~/${path.slice(homedir().length + 1)}` : path);

// Folders macOS asks before letting a background job read: the watchdog is one, so a project in them can't be started.
const GUARDED = ["Documents", "Desktop", "Downloads"];
export function guardedFolder(dir: string): string | null {
  let home = homedir();
  try {
    home = realpathSync(home);
  } catch {}
  return GUARDED.find((name) => `${dir}/`.startsWith(`${join(home, name)}/`)) ?? null;
}

export interface ProjectsSetting {
  // The folder, by its real path.
  dir: string;
  // This machine as the app knows it.
  machine: { id: string; name: string };
}

// Where this machine starts projects for the web app, or null: not linked, not said, or the folder is gone.
export function projectsSetting(): ProjectsSetting | null {
  let settings: ReturnType<typeof appSettings> = null;
  try {
    settings = appSettings();
  } catch {}
  const dir = settings?.projects?.dir;
  if (!settings || typeof dir !== "string" || !dir.startsWith("/")) return null;
  try {
    const real = realpathSync(dir);
    return statSync(real).isDirectory() ? { dir: real, machine: settings.machine } : null;
  } catch {
    return null;
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
// Whether a folder already holds a team, or is one's checkout: its rules are in it, or its checkout is beside it.
const hasTeam = (dir: string, name: string): boolean => existsSync(join(dir, name, ".a6g", "team.json")) || existsSync(join(dir, `${name}-a6g`));

// The repositories directly inside `dir` a team could be started on: each a repository of its own (a worktree's .git is
// a file), with a name an ask may carry, and no team yet.
export function offeredRepos(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => REPO_NAME.test(name) && !name.endsWith("-a6g") && isDir(join(dir, name, ".git")) && !hasTeam(dir, name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, REPORT_LIMITS.repos);
}

// The GitHub account this machine's gh is signed in as, which clones, forks and makes repositories for an ask; null
// when there's none. The watchdog reports it every five minutes, so GitHub is asked at most hourly while there's one,
// and every five minutes while there isn't (an answer kept in ~/.a6g/orders/github.json); a failed asking keeps the
// account it had for a day, and is tried again in ten minutes.
const GITHUB_FILE = join(ORDERS, "github.json");
const askGithub = (): string | null | undefined => {
  const done = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", timeout: 15_000 });
  if (done.error) return null;
  const login = (done.stdout ?? "").trim();
  if (done.status === 0) return GITHUB_LOGIN.test(login) ? login : null;
  // Signed out says so; anything else (no network, GitHub down) is a failed asking.
  return /not logged|gh auth login|authenticat/i.test(done.stderr ?? "") ? null : undefined;
};
export function githubAccount(now = Date.now(), ask: () => string | null | undefined = askGithub): string | null {
  type Kept = { login: string | null; at: string; tried?: string };
  let kept: Kept | null = null;
  try {
    kept = readJson<Kept | null>(GITHUB_FILE, null);
  } catch {}
  const age = (at: string | undefined) => (at ? now - Date.parse(at) : Infinity);
  // An account is kept an hour; none, five minutes, so signing in shows soon.
  if (kept && age(kept.at) < (kept.login ? 3_600_000 : 300_000)) return kept.login;
  if (kept && age(kept.tried) < 600_000) return age(kept.at) < 86_400_000 ? kept.login : null;
  const login = ask();
  const at = new Date(now).toISOString();
  try {
    mkdirSync(ORDERS, { recursive: true });
    writeJson(GITHUB_FILE, login === undefined ? { login: kept?.login ?? null, at: kept?.at ?? at, tried: at } : { login, at });
  } catch {}
  if (login !== undefined) return login;
  return kept && age(kept.at) < 86_400_000 ? kept.login : null;
}

// What this machine offers the web app (lib/fleet.ts), or null when it starts no projects for it. `github` also says
// this version reads an ask's newer settings (lib/tasks/start.ts NEWER_ASK).
export function machineProjects(now = new Date(), github: () => string | null = () => githubAccount(now.getTime())): MachineProjects | null {
  const setting = projectsSetting();
  if (!setting) return null;
  const { readings } = subscriptionState();
  return {
    dir: underHome(setting.dir),
    repos: offeredRepos(setting.dir),
    subscriptions: accounts()
      .slice(0, REPORT_LIMITS.subscriptions)
      .map(({ name }) => {
        const reading = readings[name];
        return { name, percent: reading && Date.parse(reading.resetsAt) > now.getTime() ? reading.percent : null };
      }),
    github: github(),
  };
}

// What a try at an ask made, so the next try knows its own: the repository it created, and the checkout.
export interface OrderMade {
  control: string;
  repo?: string;
  checkout?: string;
}
export const orderMade = (team: string): OrderMade | null => {
  try {
    return readJson<OrderMade | null>(orderFile(team), null);
  } catch {
    return null;
  }
};
export function keepOrderMade(team: string, made: OrderMade): void {
  mkdirSync(ORDERS, { recursive: true });
  writeJson(orderFile(team), made);
}

// Where an ask's repository and the team's checkout are, in this machine's projects folder.
export const orderPaths = (ask: Pick<StartAsk, "repo">, dir: string): { repo: string; checkout: string } => {
  const { name } = repoOf(ask);
  return { repo: join(dir, name), checkout: join(dir, `${name}-a6g`) };
};

// Why this machine won't start `team` as asked, in words for the operator, or null when it will. What an earlier ask
// under the same name made (its repository, its checkout) is that name's own, not someone else's: an ask made again
// after one stopped carries on with it.
export function refusalOf(ask: StartAsk, team: string, setting: ProjectsSetting, github: () => string | null = () => githubAccount()): string | null {
  const here = machineName();
  if (!START_TEAM.test(team)) return `${team} isn't a team's name: lowercase letters, digits and dashes, starting with a letter.`;
  if (readRegistry(team)) return `${here} already runs a team named ${team}. Give this one another short name.`;
  const { name, create } = repoOf(ask);
  if (!REPO_NAME.test(name)) return `${name} isn't a folder's name ${here} takes.`;
  const { repo, checkout } = orderPaths(ask, setting.dir);
  const mine = orderMade(team);
  if (create) {
    if (existsSync(repo) && mine?.repo !== repo)
      return `${underHome(repo)} is there already on ${here}. Choose it as the repository, or give the new one another name.`;
  } else {
    let real: string;
    try {
      real = realpathSync(repo);
    } catch {
      return `${underHome(repo)} isn't on ${here} any more.`;
    }
    // A link in the folder that leads out of it is outside it.
    if (real !== repo || !isDir(join(repo, ".git"))) return `${underHome(repo)} isn't a repository of its own in ${here}'s projects folder.`;
    if (existsSync(join(repo, ".a6g", "team.json"))) return `${underHome(repo)} has a team's rules in it already (.a6g/team.json).`;
  }
  if (existsSync(checkout) && mine?.checkout !== checkout)
    return `${underHome(checkout)} is there already on ${here}: a team's checkout is made beside its repository, under that name.`;
  const known = accounts().map((a) => a.name);
  const unknown = ask.use.filter((sub) => !known.includes(sub));
  if (unknown.length) return `${here} has no subscription named ${unknown.join(", ")} (it has ${known.join(", ")}).`;
  // GitHub, as this machine's own account: one to clone or fork, or a new one to make there.
  const fromGithub = "github" in ask.repo ? githubRepoOf(ask.repo.github) : null;
  if ("github" in ask.repo && !fromGithub) return `${ask.repo.github} isn't a GitHub repository's name (owner/name).`;
  if (fromGithub || ("create" in ask.repo && ask.repo.publish)) {
    const login = github();
    if (!login) return `${here} isn't signed in to GitHub: run gh auth login there, then ask again.`;
    // Someone else's code runs here as the team sets it up: only when the operator said they trust it.
    if (fromGithub && fromGithub.owner.toLowerCase() !== login.toLowerCase() && ask.trusted !== true)
      return `${fromGithub.full} isn't ${login}'s: ask again, ticking that you trust its code to run on ${here}.`;
  }
  return null;
}

// The process recorded as carrying out an ask, or null.
export function orderProcess(team: string): number | null {
  try {
    const pid = Number(readFileSync(orderPid(team), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
// Whether that process is still there.
export function orderRunning(team: string): boolean {
  const pid = orderProcess(team);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function keepOrderPid(team: string, pid: number): void {
  mkdirSync(ORDERS, { recursive: true });
  writeFileSync(orderPid(team), `${pid}\n`);
}

// Starts `a6g projects start <team>` in a process of its own, which outlives this one; everything it prints goes to
// the ask's log.
export function launchOrder(team: string): void {
  mkdirSync(ORDERS, { recursive: true });
  const out = openSync(orderLog(team), "a");
  try {
    const child = spawn(process.execPath, [join(FACTORY_ROOT, "bin", "a6g.ts"), "projects", "start", team], {
      detached: true,
      stdio: ["ignore", out, out],
      cwd: A6G_HOME,
      env: process.env,
    });
    if (child.pid) keepOrderPid(team, child.pid);
    child.unref();
  } finally {
    closeSync(out);
  }
}

export interface Ask {
  team: string;
  store: Store;
  state: StartState;
}

// An ask this old says nothing any more: its team is long started, or it was dropped. Their stores aren't opened.
const ASKS_KEPT_DAYS = 30;

// The asks addressed to `machine` (the app's id for it), each with where it stands, by team name.
export async function asksFor(client: MongoClientLike, database: string, machine: string, now = Date.now()): Promise<Ask[]> {
  const rows = await client.db(database).collection("controls").find({ kind: "start" }).toArray();
  // Each team's newest ask, read from the rows alone, says whether its controls are worth reading.
  const newest = new Map<string, Record<string, unknown>>();
  const numbered = (row: Record<string, unknown>): number => Number(/^k(\d+)$/.exec(String(row["id"] ?? ""))?.[1] ?? 0);
  for (const row of rows) {
    const team = String(row["team"] ?? "");
    const before = newest.get(team);
    if (START_TEAM.test(team) && (!before || numbered(row) > numbered(before))) newest.set(team, row);
  }
  const teams = [...newest]
    .filter(([, row]) => {
      const start = row["start"] as { machine?: unknown } | null | undefined;
      return start?.machine === machine && now - Date.parse(String(row["at"] ?? "")) < ASKS_KEPT_DAYS * 86_400_000;
    })
    .map(([team]) => team)
    .sort();
  const asks: Ask[] = [];
  for (const team of teams) {
    const store = storeOver(client, { name: team, tasks: { store: "mongo", database, lead: null } });
    const state = startOf(await store.controls.all(), now);
    if (state && state.ask.machine === machine) asks.push({ team, store, state });
  }
  return asks;
}

// The watchdog's part, at each full run: an ask nobody has picked up is refused in words, or picked up and started
// (one at a time: the rest wait for the next run); one whose process is gone without a last word is said to have
// stopped. `launch` starts an ask's process, and `tell` lets the operator know through this machine's own channels.
export async function takeOrders(deps: {
  client: MongoClientLike;
  database?: string;
  log: (text: string) => void;
  launch?: (team: string) => void;
  tell?: (team: string, ask: StartAsk, repo: string) => Promise<void> | void;
  now?: number;
}): Promise<void> {
  const setting = projectsSetting();
  if (!setting) return;
  const here = machineName();
  const asks = await asksFor(deps.client, deps.database ?? ORDERS_DATABASE, setting.machine.id, deps.now);
  // Under way: picked up, and not yet started, failed or refused.
  const under = (state: StartState): boolean => state.step !== "waiting" && state.step !== "expired" && !startEnded(state.step);
  let busy = asks.some(({ team, state }) => under(state) && orderRunning(team));
  for (const { team, store, state } of asks) {
    const say = (progress: Parameters<typeof startingControl>[2]) => store.controls.create(startingControl(team, here, progress));
    const of = state.control.id;
    if (state.step === "waiting") {
      const checked = startFrom(state.ask);
      const refusal = "problem" in checked ? checked.problem : refusalOf(checked, team, setting);
      if (refusal || "problem" in checked) {
        await say({ of, step: "refused", problem: refusal });
        deps.log(`refused the web app's ask to start ${team}: ${refusal}`);
        continue;
      }
      if (busy) continue;
      await say({ of, step: "picked-up", problem: null });
      busy = true;
      const { repo } = orderPaths(checked, setting.dir);
      deps.log(`picked up the web app's ask to start ${team} (${checked.title}) on ${underHome(repo)}: a6g projects shows how it goes`);
      (deps.launch ?? launchOrder)(team);
      await deps.tell?.(team, checked, repo);
    } else if (under(state) && !orderRunning(team)) {
      const at = state.step as StartStep;
      await say({
        of,
        step: "failed",
        stoppedAt: at,
        problem: `It stopped while ${STEP_WORDS[at].toLowerCase()}, without saying why.`,
        fix: `Its log is ${underHome(orderLog(team))} on ${here}. To carry on from where it stopped, there:`,
        command: `a6g projects start ${team}`,
      });
      deps.log(`the start of ${team} stopped at "${state.step}" without a last word: said so to the web app`);
    }
  }
}
