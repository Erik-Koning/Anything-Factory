// a6g projects [start <team>]
//
// The projects the web app asked this machine to start (lib/orders.ts, docs/plans/run-from-the-site.md).
//
//   a6g projects                whether this machine starts them (a6g connect app --projects <dir>), and each ask
//                               addressed to it with where it stands
//   a6g projects start <team>   carries one out: the watchdog starts it in a process of its own when it picks an ask
//                               up; the operator runs it to carry on one that stopped
//
// Carrying one out: the repository (made, when it's new, and on GitHub too when asked; cloned from GitHub, or forked to
// this machine's GitHub account first when that account can't push to it), a draft with a6g init --no-interview and
// the rules the ask chose, the setup agent with nobody there, a6g check --run, a6g register, the budget, the
// subscriptions and the working agreement the ask named, a pause when it asked to wait, and a6g start. Each step
// is said to the web app as a control of kind `starting` under the team's name; a step that fails says why, and what to
// run here when only that will do. Everything the steps print goes to ~/.a6g/orders/<team>.log.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appSettings } from "../app.ts";
import { channels } from "../channels.ts";
import { machineName } from "../machine.ts";
import {
  type Ask,
  asksFor,
  githubAccount,
  keepOrderMade,
  keepOrderPid,
  orderMade,
  offeredRepos,
  orderLog,
  orderPaths,
  orderProcess,
  orderRunning,
  ORDERS,
  ORDERS_DATABASE,
  type ProjectsSetting,
  projectsSetting,
  refusalOf,
  underHome,
} from "../orders.ts";
import { FACTORY_ROOT } from "../paths.ts";
import { operatorOnly } from "../session.ts";
import { setTeamUses, teamUses } from "../subscriptions.ts";
import { DEFAULT_AGREEMENT } from "../tasks/agreement.ts";
import { agreementControl, budgetControl, holdOf, pauseControl, resumeControl, startingControl, type StartState } from "../tasks/controls.ts";
import { driver, type MongoClientLike } from "../tasks/mongo.ts";
import { readUri } from "../tasks/mongoUri.ts";
import { githubRepoOf, repoOf, type StartAsk, type StartStep, startFrom, STEP_WORDS } from "../tasks/start.ts";
import type { Store } from "../tasks/store.ts";
import { plain } from "../untrusted.ts";
import { die } from "../util.ts";
import { setupUnattended } from "./init.ts";
import { githubRepo, remoteUrl } from "./pr.ts";

const USAGE = "usage: a6g projects [start <team>]";

// One command of a step: its exit status and everything it printed.
export type Sh = (command: string, args: string[], options: { cwd: string; timeoutMin?: number }) => { code: number; out: string };

// Runs it, and prints the command and what it said, which is the ask's log when the watchdog started this.
const run: Sh = (command, args, { cwd, timeoutMin = 15 }) => {
  const done = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMin * 60_000, maxBuffer: 32 * 1024 * 1024, env: process.env });
  const out = `${done.stdout ?? ""}${done.stderr ?? ""}${done.error ? `\n${done.error.message}` : ""}`;
  process.stdout.write(`$ ${[command.split("/").at(-1), ...args].join(" ")}\n${out}${out.endsWith("\n") ? "" : "\n"}`);
  return { code: done.error ? 1 : (done.status ?? 1), out };
};

// The end of what a command said, as one plain line for the web app: its last lines that say anything.
export function tail(out: string, max = 300): string {
  const lines = out
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    // A remote's address can hold a user and a token (https://x-access-token:…@github.com/…): never shown.
    .replace(/([a-z+]+:\/\/)[^\s@/]+@/gi, "$1")
    .split(/\r?\n/)
    .map((line) => plain(line).trim())
    .filter(Boolean);
  const text = lines.slice(-3).join(" · ");
  return text.length > max ? `…${text.slice(-(max - 1))}` : text || "it said nothing";
}

// A step that can't go on: why, in a sentence; what the command that failed last said, in its own words; and what
// the operator can do about it at this machine (the words, and the command).
class Stop extends Error {
  said: string | null;
  fix: string | null;
  command: string | null;
  constructor(problem: string, said: string | null = null, fix: string | null = null, command: string | null = null) {
    super(problem);
    this.said = said;
    this.fix = fix;
    this.command = command;
  }
}

// What a pause from an ask to set up and wait says: the one a later ask to start at once lifts.
const WAIT_NOTE = "Set up from the web app: waiting for you to start it";

// The rules an ask chose (a6g init --base --mode --approval --push), put into a draft that's there already: init keeps a
// draft it finds, so an ask made again with other choices would otherwise run on the first one's.
export function applyRules(checkout: string, ask: Pick<StartAsk, "base" | "mode" | "approval" | "push">): void {
  const file = join(checkout, ".a6g", "team.json");
  let team: Record<string, unknown>;
  try {
    team = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (ask.base) team["base"] = ask.base;
  if (ask.mode) team["mode"] = ask.mode;
  if (ask.approval === "operator") team["approval"] = { ...object(team["approval"]), mode: "operator" };
  if (ask.approval === "thresholds") {
    team["approval"] = { maxSize: "M", ...object(team["approval"]), mode: "thresholds" };
    const roles = object(team["roles"]);
    team["roles"] = { ...roles, approver: roles["approver"] ?? {} };
  }
  if (ask.push === "none") team["push"] = null;
  if (ask.push === "branch" || ask.push === "pull-request")
    team["push"] = {
      remote: "origin",
      branch: typeof team["branch"] === "string" ? team["branch"] : "a6g/next",
      every: "6h",
      ...(ask.push === "pull-request" ? { pullRequest: true } : {}),
    };
  writeFileSync(file, `${JSON.stringify(team, null, 2)}\n`);
}

// Puts `goal` under the brief's heading for it (templates/team/brief.md), in place of what was there.
const GOAL_HEADING = "## What should exist when the team is done";
export function rewriteGoal(file: string, goal: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const at = text.indexOf(GOAL_HEADING);
  if (at < 0) return;
  const next = text.indexOf("\n## ", at + GOAL_HEADING.length);
  writeFileSync(file, `${text.slice(0, at)}${GOAL_HEADING}\n\n${goal}\n${next < 0 ? "" : text.slice(next)}`);
}

export interface CarryDeps {
  store: Store;
  setting: ProjectsSetting;
  // Stand-ins for the tests: the commands a step runs, the setup agent, this machine's GitHub account, and the wait
  // between tries at cloning a fork GitHub is still making.
  sh?: Sh;
  setup?: (repo: string, checkout: string) => { code: number; out: string };
  github?: () => string | null;
  wait?: (ms: number) => void;
}

const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The JSON object gh printed (gh api), or null.
function jsonOf<T>(out: string): T | null {
  try {
    return JSON.parse(out.slice(out.indexOf("{"))) as T;
  } catch {
    return null;
  }
}

// Carries out the ask to start `team`, saying each step as it begins. Resolves to whether the team was started.
export async function carryOut(team: string, state: StartState, deps: CarryDeps): Promise<boolean> {
  const here = machineName();
  const of = state.control.id;
  const sh = deps.sh ?? run;
  const say = (
    step: StartStep,
    problem: string | null = null,
    stopped?: { at: StartStep; said: string | null; fix: string | null; command: string | null },
    note: string | null = null
  ) =>
    deps.store.controls.create(
      startingControl(team, here, {
        of,
        step,
        problem,
        ...(stopped ? { stoppedAt: stopped.at, said: stopped.said, fix: stopped.fix, command: stopped.command } : {}),
        ...(note ? { note } : {}),
      })
    );
  const github = deps.github ?? (() => githubAccount());
  const checked = startFrom(state.ask);
  const refusal = "problem" in checked ? checked.problem : refusalOf(checked, team, deps.setting, github);
  if ("problem" in checked || refusal) {
    await say("refused", refusal);
    console.info(`a6g: refused to start ${team}: ${refusal}`);
    return false;
  }
  const ask = checked;
  const { repo, checkout } = orderPaths(ask, deps.setting.dir);
  const { name, create } = repoOf(ask);
  const a6g = (args: string[], cwd: string, timeoutMin?: number) =>
    sh(process.execPath, [join(FACTORY_ROOT, "bin", "a6g.ts"), ...args], { cwd, ...(timeoutMin === undefined ? {} : { timeoutMin }) });
  // What finishes a setup by hand: the interview, in the checkout this made.
  const byHand = [`To finish the setup yourself, on ${here}:`, `a6g init ${underHome(repo)} --name ${team}`] as const;
  const carryOn = [`Once that's put right, on ${here}:`, `a6g projects start ${team}`] as const;
  const before = orderMade(team);
  let step: StartStep = "repository";
  // What a step did that the operator should know, said with the next step (the repository cloned or forked).
  const begin = async (next: StartStep, note: string | null = null): Promise<void> => {
    step = next;
    await say(next, null, undefined, note);
    console.info(`a6g: ${team}: ${STEP_WORDS[next].toLowerCase()}${note ? ` (${note})` : ""}`);
  };
  const gh = (cwd: string, args: string[], timeoutMin?: number) => sh("gh", args, { cwd, ...(timeoutMin === undefined ? {} : { timeoutMin }) });
  const fromGithub = "github" in ask.repo ? githubRepoOf(ask.repo.github) : null;
  let note: string | null = null;
  try {
    await begin("repository");
    // A clone an earlier try under this name made is used again only when it's the repository asked for (or its fork).
    if (fromGithub && existsSync(join(repo, ".git"))) {
      const remotes = ["origin", "upstream"].map((remote) => {
        const url = remoteUrl(repo, remote);
        return url ? (githubRepo(url)?.toLowerCase() ?? null) : null;
      });
      if (!remotes.includes(fromGithub.full.toLowerCase()))
        throw new Stop(
          `${underHome(repo)} holds another repository than ${fromGithub.full}.`,
          null,
          `Move it out of the way, or ask again under another short name. Then, on ${here}:`,
          carryOn[1]
        );
    }
    if (fromGithub && !existsSync(join(repo, ".git"))) {
      // As this machine's GitHub account: cloned when it can push to it, its fork otherwise.
      const who = github() ?? "this Mac's GitHub account";
      const seen = gh(deps.setting.dir, ["api", `repos/${fromGithub.full}`]);
      const info = seen.code === 0 ? jsonOf<{ full_name?: string; archived?: boolean; permissions?: Record<string, boolean> }>(seen.out) : null;
      if (!info)
        throw new Stop(
          `GitHub says ${who} can't see ${fromGithub.full}.`,
          tail(seen.out),
          `Check its name, or ask its owner to give ${who} access. Then, on ${here}:`,
          carryOn[1]
        );
      const full = typeof info.full_name === "string" && githubRepoOf(info.full_name) ? info.full_name : fromGithub.full;
      if (info.archived)
        throw new Stop(`${full} is archived on GitHub, so nothing can be pushed to it.`, null, `Unarchive it on GitHub, then, on ${here}:`, carryOn[1]);
      // GitHub may answer for another owner than the one asked (a repository moved): the tick is for whose code it is.
      const owner = full.split("/")[0] ?? "";
      const login = github();
      if (login && owner.toLowerCase() !== login.toLowerCase() && ask.trusted !== true)
        throw new Stop(
          `GitHub says that's ${full} now, which isn't ${login}'s.`,
          null,
          `Ask again, ticking that you trust its code to run on ${here}.`,
          null
        );
      const canPush = Boolean(info.permissions?.["push"] || info.permissions?.["maintain"] || info.permissions?.["admin"]);
      let source = full;
      if (!canPush) {
        // GitHub hands back the fork that's there already, when there is one.
        // Every branch when the ask names a base, which the fork must have for its pull requests to go into.
        const forked = gh(deps.setting.dir, ["api", "-X", "POST", `repos/${full}/forks`, ...(ask.base ? [] : ["-F", "default_branch_only=true"])]);
        const fork = forked.code === 0 ? jsonOf<{ full_name?: string }>(forked.out)?.full_name : undefined;
        if (typeof fork !== "string" || !githubRepoOf(fork))
          throw new Stop(
            `GitHub didn't fork ${full} to ${who}.`,
            tail(forked.out),
            `If its owner lets it be forked, fork it on GitHub yourself, then, on ${here}:`,
            carryOn[1]
          );
        source = fork;
        note = `Forked ${full} to ${fork}: ${who} can't push to the original. Its pull requests go to the fork.`;
      } else note = `Cloned ${full}: ${who} can push to it.`;
      keepOrderMade(team, { control: of, repo });
      // A fork is made in the background: a clone right after may not find it yet.
      let cloned = gh(deps.setting.dir, ["repo", "clone", source, repo, "--", "--quiet"], 30);
      for (let tries = 0; cloned.code !== 0 && !canPush && tries < 6; tries++) {
        (deps.wait ?? pause)(5_000);
        cloned = gh(deps.setting.dir, ["repo", "clone", source, repo, "--", "--quiet"], 30);
      }
      if (cloned.code !== 0) throw new Stop(`gh couldn't clone ${source} into ${underHome(repo)}.`, tail(cloned.out), ...carryOn);
      // gh's commands there go to the fork, never the original (a6g pr names its repository from origin anyway).
      if (!canPush) gh(repo, ["repo", "set-default", source]);
    }
    if (create && !fromGithub && !existsSync(join(repo, ".git"))) {
      mkdirSync(repo, { recursive: true });
      keepOrderMade(team, { control: of, repo });
      const made = sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
      if (made.code !== 0) throw new Stop(`git couldn't make a repository at ${underHome(repo)}.`, tail(made.out), ...carryOn);
    }
    if (sh("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo }).code !== 0) {
      if (!create) throw new Stop(`${underHome(repo)} has no commit yet.`, null, `Commit something there, then, on ${here}:`, carryOn[1]);
      // A new repository, or an empty one from GitHub: a README that holds the title and the goal.
      if (!existsSync(join(repo, "README.md"))) writeFileSync(join(repo, "README.md"), `# ${ask.title}\n\n${ask.goal}\n`);
      sh("git", ["add", "README.md"], { cwd: repo });
      const first = sh("git", ["commit", "-q", "-m", `Start ${ask.title}`], { cwd: repo });
      if (first.code !== 0)
        throw new Stop(
          `git couldn't make the first commit in ${underHome(repo)}.`,
          tail(first.out),
          `If ${here} has never committed, set your name and email for git there. Then, on ${here}:`,
          carryOn[1]
        );
    }
    const origin = () => sh("git", ["remote", "get-url", "origin"], { cwd: repo });
    // On GitHub too, under this machine's account, when asked: made from what's here, and pushed.
    if ("create" in ask.repo && ask.repo.publish && origin().code !== 0) {
      const who = github() ?? "this Mac's GitHub account";
      const made = gh(repo, ["repo", "create", name, `--${ask.repo.publish}`, "--source", repo, "--remote", "origin", "--push"], 10);
      if (made.code !== 0)
        throw new Stop(
          `GitHub didn't make ${who}/${name}.`,
          tail(made.out),
          `If ${who} has a repository named ${name} already, start from it instead, or name the folder differently. Otherwise, on ${here}:`,
          carryOn[1]
        );
      note = `Made ${who}/${name} on GitHub (${ask.repo.publish}), and pushed it.`;
    }
    // The base the ask named: a branch here, or one of origin's, which is given a branch here to start from; for a fork
    // GitHub had made before without it, the original's, put on the fork too, where the pull requests go into it.
    if (ask.base) {
      const has = (ref: string) => sh("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo }).code === 0;
      if (!has(`refs/heads/${ask.base}`)) {
        if (has(`refs/remotes/origin/${ask.base}`)) sh("git", ["branch", "--track", ask.base, `origin/${ask.base}`], { cwd: repo });
        else if (remoteUrl(repo, "upstream") && sh("git", ["fetch", "--quiet", "upstream", ask.base], { cwd: repo }).code === 0) {
          sh("git", ["branch", ask.base, "FETCH_HEAD"], { cwd: repo });
          const put = sh("git", ["push", "--quiet", "origin", `refs/heads/${ask.base}:refs/heads/${ask.base}`], { cwd: repo });
          if (put.code !== 0)
            throw new Stop(
              `The fork has no branch ${ask.base}, and it couldn't be pushed there.`,
              tail(put.out),
              `Push ${ask.base} to the fork yourself, then, on ${here}:`,
              carryOn[1]
            );
        } else
          throw new Stop(
            `${underHome(repo)} has no branch ${ask.base}.`,
            null,
            `Make ${ask.base} there, or ask again with a base it has. To carry on, on ${here}:`,
            carryOn[1]
          );
      }
    }
    // What the team may push needs somewhere to push to; a pull request, GitHub. (The address isn't shown: it may hold a
    // token.)
    if (ask.push && ask.push !== "none") {
      const remote = origin();
      if (remote.code !== 0)
        throw new Stop(
          `${underHome(repo)} has no origin remote for the team to push to.`,
          null,
          `Add one, or ask again with nothing on GitHub. Then, on ${here}:`,
          carryOn[1]
        );
      if (ask.push === "pull-request" && !githubRepo(remote.out.trim()))
        throw new Stop(
          `${underHome(repo)}'s origin isn't on GitHub, where the team opens its pull requests.`,
          null,
          `Ask again with "push its branch" only, or point origin at GitHub. Then, on ${here}:`,
          carryOn[1]
        );
    }

    await begin("draft", note);
    mkdirSync(ORDERS, { recursive: true });
    const goalFile = join(ORDERS, `${team}.goal.md`);
    writeFileSync(goalFile, `${ask.goal}\n`);
    // An ask made again after one stopped: its checkout holds the first one's draft, with the goal as it was then.
    const again = before !== null && before.control !== of && before.checkout === checkout && existsSync(join(checkout, ".a6g", "brief.md"));
    keepOrderMade(team, { control: of, ...(create ? { repo } : {}), checkout });
    const drafted = a6g(
      [
        "init",
        repo,
        "--name",
        team,
        "--title",
        ask.title,
        "--store",
        "mongo",
        "--goal-file",
        goalFile,
        "--no-interview",
        ...(ask.technical ? [] : ["--non-technical"]),
        ...(ask.base ? ["--base", ask.base] : []),
        ...(ask.mode ? ["--mode", ask.mode] : []),
        ...(ask.approval ? ["--approval", ask.approval] : []),
        ...(ask.push ? ["--push", ask.push] : []),
      ],
      repo
    );
    if (drafted.code !== 0) throw new Stop("a6g init couldn't draft the team.", tail(drafted.out), ...carryOn);
    // a6g init keeps a draft that's there: the goal in it is put as the operator has it now.
    if (again) {
      rewriteGoal(join(checkout, ".a6g", "brief.md"), ask.goal);
      applyRules(checkout, ask);
    }

    await begin("setup");
    const setup = (deps.setup ?? setupUnattended)(repo, checkout);
    process.stdout.write(setup.out.endsWith("\n") ? setup.out : `${setup.out}\n`);
    // Its last word when it can't go on without the operator (plugin/agents/setup.md): that's what they're shown.
    const needs = /^Needs the operator:\s*(.+)$/m.exec(setup.out)?.[1];
    if (setup.code !== 0 || needs)
      throw new Stop(
        needs ? "The setup agent can't finish without you." : "The setup agent stopped before the team was ready.",
        needs ? plain(needs).trim().slice(0, 300) : tail(setup.out),
        ...byHand
      );

    await begin("check");
    const proved = a6g(["check", checkout, "--run"], checkout, 40);
    if (proved.code !== 0) throw new Stop("The setup didn't pass its check.", tail(proved.out), ...byHand);

    await begin("register");
    // The subscriptions first, so registering puts each role on one of them; the budget before the first run applies it.
    if (ask.use.length) setTeamUses({ ...teamUses(), [team]: { "*": ask.use } });
    // Set up, then wait for the operator: the pause, by whoever asked, is there before the team is, so no run of the
    // watchdog starts it first; a6g start then leaves it paused.
    // An earlier try's pause to wait goes when this ask says to start at once.
    const held = holdOf(await deps.store.controls.all());
    if (ask.hold && !held) await deps.store.controls.create(pauseControl([], team, { scope: "now", by: state.control.by, note: WAIT_NOTE }));
    if (!ask.hold && held?.note === WAIT_NOTE)
      await deps.store.controls.create(resumeControl(team, state.control.by, "Asked again, to start as soon as it's set up"));
    const registered = a6g(["register", checkout], checkout);
    if (registered.code !== 0)
      throw new Stop(
        "a6g register didn't take it.",
        tail(registered.out),
        `To register it yourself, on ${here}:`,
        `a6g register ${underHome(checkout)} && a6g start ${team}`
      );
    if (ask.limits) await deps.store.controls.create(budgetControl(team, state.control.by, { ...ask.limits, since: new Date().toISOString() }));
    // How readily it asks the operator, as they chose: the working agreement, by them.
    if (ask.level) await deps.store.controls.create(agreementControl(team, state.control.by, { ...DEFAULT_AGREEMENT, level: ask.level }));
    const started = a6g(["start", team], checkout);
    if (started.code !== 0)
      throw new Stop("The team is registered, but didn't start.", tail(started.out), `To start it yourself, on ${here}:`, `a6g start ${team}`);

    await say("started", null, undefined, ask.hold ? "Set up, and waiting for you: resume it from its overview when you're ready." : null);
    console.info(`a6g: ${team} is ${ask.hold ? "set up and paused, as asked" : "started"}: a6g status ${team}`);
    return true;
  } catch (error) {
    const problem = error instanceof Stop ? error.message : `Something went wrong on ${here}.`;
    const said = error instanceof Stop ? error.said : tail((error as Error).message);
    const fix = error instanceof Stop ? error.fix : carryOn[0];
    const command = error instanceof Stop ? error.command : carryOn[1];
    console.error(`a6g: ${team} stopped while ${STEP_WORDS[step].toLowerCase()}: ${problem}${said ? ` (${said})` : ""}`);
    try {
      await say("failed", problem, { at: step, said, fix, command });
    } catch (saying) {
      console.error(`a6g: and couldn't say so to the web app: ${tail((saying as Error).message)}`);
    }
    return false;
  }
}

// This machine's connection to the task graphs, where the asks are (a6g connect mongo).
async function graph(): Promise<MongoClientLike> {
  const uri = readUri();
  if (!uri) die("the asks are in MongoDB, and this machine isn't connected to it: a6g connect mongo");
  const { MongoClient } = await driver();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: "a6g" });
  await client.connect();
  return client;
}

// Where an ask stands, in a line.
function standing({ team, state }: Ask, dir: string): string {
  const { repo } = orderPaths(state.ask, dir);
  const words =
    state.step === "expired"
      ? "never picked up: it was dropped after a day"
      : state.step === "failed"
        ? `stopped while ${STEP_WORDS[state.stoppedAt ?? "failed"].toLowerCase()}: ${[state.problem, state.said ? `(${state.said})` : null, state.fix, state.command].filter(Boolean).join(" ")}`
        : state.step === "refused"
          ? `refused: ${state.problem ?? ""}`
          : STEP_WORDS[state.step].toLowerCase();
  return `  ${team}  ${state.ask.title}, on ${underHome(repo)}: ${words}${orderRunning(team) ? " (under way now)" : ""}`;
}

async function show(): Promise<number> {
  const linked = appSettings();
  if (!linked) {
    console.info("a6g: this machine isn't linked to the web app (a6g connect app), so it starts no projects for it.");
    return 0;
  }
  const setting = projectsSetting();
  if (!setting) {
    console.info(`a6g: this machine starts no projects for ${linked.url}. a6g connect app --projects <dir> lets it, in that folder only.`);
    return 0;
  }
  const repos = offeredRepos(setting.dir);
  console.info(
    `a6g: this machine starts the projects ${linked.url} asks for, in ${underHome(setting.dir)} (a6g connect app --no-projects stops it).\n  It offers ${repos.length ? `${repos.length} repositor${repos.length === 1 ? "y" : "ies"} there: ${repos.slice(0, 12).join(", ")}${repos.length > 12 ? ", …" : ""}` : "no repository there yet; a new one can be made from the app"}.`
  );
  const client = await graph();
  try {
    const asks = await asksFor(client, ORDERS_DATABASE, setting.machine.id);
    if (!asks.length) console.info("  Nothing has been asked of it.");
    for (const ask of asks) console.info(standing(ask, setting.dir));
    if (asks.length) console.info(`  Each one's log is in ${underHome(ORDERS)}; a6g projects start <team> carries on one that stopped.`);
  } finally {
    await client.close();
  }
  return 0;
}

async function start(team: string): Promise<number> {
  const setting = projectsSetting() ?? die("this machine starts no projects for the web app: a6g connect app --projects <dir> lets it");
  const client = await graph();
  try {
    const ask = (await asksFor(client, ORDERS_DATABASE, setting.machine.id)).find((a) => a.team === team);
    if (!ask) die(`the web app hasn't asked this machine to start a team named ${team} (a6g projects lists what it asked)`);
    if (ask.state.step === "started") {
      console.info(`a6g: ${team} is started already: a6g status ${team}`);
      return 0;
    }
    if (ask.state.step === "expired") die(`that ask was never picked up, and was dropped after a day: ask again from the web app`);
    // The watchdog wrote this process's own id before starting it; anyone else's is another try, still at it.
    if (orderRunning(team) && orderProcess(team) !== process.pid) die(`${team} is being set up right now (its log: ${underHome(orderLog(team))})`);
    keepOrderPid(team, process.pid);
    const ok = await carryOut(team, ask.state, { store: ask.store, setting });
    if (!ok) await tellStopped(team, ask.state);
    return ok ? 0 : 1;
  } finally {
    await client.close();
  }
}

// A start that stopped, through this machine's own channels: the web app shows it too, to whoever looks.
async function tellStopped(team: string, state: StartState): Promise<void> {
  for (const channel of channels()) {
    try {
      await channel.send(
        `[Anything Factory] ${state.ask.title} wasn't started`,
        `The web app asked ${machineName()} to start a project, ${state.ask.title} (${team}), and it stopped before the team was running.\n\nWhy, and what to do, is on the web app's Teams page, and in ${underHome(orderLog(team))} on that machine.\n`
      );
    } catch {}
  }
}

export async function projects(argv: string[]): Promise<number> {
  operatorOnly("projects");
  const [sub, team, ...rest] = argv;
  if (!sub) return show();
  if (sub === "start" && team && !rest.length) return start(team);
  die(USAGE);
}
