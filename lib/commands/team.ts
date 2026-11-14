// The operator's commands for a team's life: register (alias sync), unregister, start, pause, resume, rotate,
// status, teams, prompt and upgrade.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { instanceId, loadTeam, modelsOf, type RawTeam, type Team } from "../config.ts";
import * as docker from "../docker.ts";
import { defaultModel } from "../models.ts";
import {
  defaultRunDir,
  A6G_HOME,
  entryOf,
  FACTORY_ROOT,
  findHome,
  PACKAGE,
  pluginDir,
  readRegistry,
  type RegistryEntry,
  registryFile,
  teamFile,
  teamsDir,
  versionDir,
} from "../paths.ts";
import { pausedUntil } from "../budget.ts";
import { readHold, readLimits } from "../holds.ts";
import {
  accounts,
  chooseFor,
  describeWait,
  SUBSCRIPTION_NAME,
  subscriptionLimits,
  subscriptionState,
  subscriptionWeek,
  teamUses,
} from "../subscriptions.ts";
import { plannerBusy, readSteering, retirePlanner, steer } from "../steer.ts";
import { describeSpend, type Spend } from "../tasks/spend.ts";
import { compile, promptFile, writePrompt } from "../prompts.ts";
import { dittoServer, hasToken, writeMcpConfig } from "../ditto.ts";
import { operatorOnly } from "../session.ts";
import * as t3 from "../t3.ts";
import { die, type Options, parseArgs, readJson, writeJson } from "../util.ts";
import { acquireSlot } from "../lock.ts";
import { answers, applyTeamControls, ensureWatchdog, keptWorktrees, reportTeamState, watchOnce } from "./watchdog.ts";
import { machineName } from "../machine.ts";
import { isLead, multiMachine } from "../tasks/machines.ts";
import {
  budgetControl,
  type Control,
  describeHold,
  type HoldScope,
  holdOf,
  type Limits,
  limitsOf,
  pauseControl,
  restoreControl,
  resumeControl,
  retireControl,
  retiredOf,
} from "../tasks/controls.ts";
import { fileDesignCheckIn } from "../tasks/design.ts";
import { designOpen, nowIso, OPERATOR, Refused } from "../tasks/model.ts";
import { openStore, type Store } from "../tasks/store.ts";
import { settingsOf } from "../tasks/teams.ts";
import { openTeamStore } from "../tasks/ops.ts";
import { checkDue, fileGaps, readVerifyLog } from "../verify.ts";

const quote = (text: string): string => (/[\s"']/.test(text) ? `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : text);

// --docker <name>: the Docker engine the team's containers run on, by its context's name or its address.
function engineOption(value: Options[string]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) die("--docker takes a Docker context's name (docker context ls lists them) or an engine's address");
  return value.trim();
}

function homeFrom(arg: string | undefined): string {
  const home = arg ? realpathSync(resolve(arg)) : findHome();
  if (!home) die("run this in a team's checkout, or name it: a6g register <checkout>");
  return home;
}

// The factory version a team runs: its team.json pin ("dev" is the linked source checkout), else this one.
export function versionFor(team: Team): string {
  const version = team.factory ?? PACKAGE.version;
  if (!existsSync(versionDir(version)))
    die(
      `the team pins Anything Factory ${version}, which isn't installed (${versionDir(version)}); run a6g self-install${version === "dev" ? " --link" : ""} from that version's checkout`
    );
  return version;
}

// A member's environment: team.json's vars, then the factory's own, so a var never decides who a member is, where
// its team lives or which Docker engine its containers run on.
export function memberEnvironment(
  team: Team,
  role: string,
  { home, run, version, engine }: { home: string; run: string; version: string; engine?: docker.Pin | null }
): Record<string, string> {
  const vars = Object.fromEntries(
    Object.entries(team.vars).map(([key, value]) => [key, String(value).replaceAll("${home}", home).replaceAll("${run}", run)])
  );
  // A6G_HOME too: a member's hooks guard the factory's folder wherever the operator keeps it.
  return {
    ...vars,
    ...(engine ? { DOCKER_HOST: engine.host } : {}),
    A6G_TEAM: team.name,
    A6G_ROLE: role,
    A6G_HOME: A6G_HOME,
    A6G_HOME_DIR: home,
    A6G_RUN: run,
    A6G_VERSION: version,
  };
}

export async function register(argv: string[]): Promise<number> {
  operatorOnly("register");
  const { positional, options } = parseArgs(argv, { booleans: ["force", "worker"] });
  const home = homeFrom(positional[0]);
  const code = registerTeam(home, { force: Boolean(options["force"]), worker: Boolean(options["worker"]), engine: engineOption(options["docker"]) });
  if (code === 0 && !options["worker"]) await fileAtRegister(home);
  if (code === 0) await publishTeam(home);
  return code;
}

// Registers the team in `home` to run `version` (else the one its team.json pins). Dies before changing anything
// when it can't.
// A team whose task graph is in Mongo shows in the web app: the lead publishes its settings there (the app reads no
// team.json), and puts it back on the app when it was taken off (unregistered, or from the app). A failure is said, and
// changes nothing else: register again once Mongo answers.
async function publishTeam(home: string): Promise<void> {
  const team = loadTeam(home);
  if (team.board.type !== "tasks" || team.tasks.store !== "mongo" || !isLead(team)) return;
  try {
    const store = await openStore(team, readRegistry(team.name)?.run ?? defaultRunDir(team.name));
    try {
      await store.publish(settingsOf(team, PACKAGE.version));
      console.info(`  published ${team.name}'s settings for the web app`);
      if (await putBackOnApp(store, team.name)) console.info(`  ${team.name} was off the web app; it's back on it`);
    } finally {
      await store.close();
    }
  } catch (error) {
    console.warn(`  couldn't publish ${team.name}'s settings for the web app: ${(error as Error).message.split("\n")[0]}`);
  }
}

// What register files on the team's board without running anything, for the planner: the design check-in, where the
// operator asked to agree the foundation (lib/tasks/design.ts), and the harness's gaps the factory can see: a team with
// a scaffolder and no manifest yet (lib/verify.ts fileGaps; the merge queue files the rest after merges).
async function fileAtRegister(home: string): Promise<void> {
  const team = loadTeam(home);
  const run = readRegistry(team.name)?.run;
  const gaps = Boolean(team.roles["scaffolder"]);
  if (team.board.type !== "tasks" || !run || (!gaps && !team.operator.designCheckIn)) return;
  try {
    const store = await openTeamStore(team, run, home);
    try {
      const design = await fileDesignCheckIn(store, team);
      if (design) console.info(`  the design check-in is #${design}: the team builds the foundation, then asks you; features wait until you've agreed it`);
      // The setting turned off doesn't end a check-in already filed: the task holds the features, not the setting.
      const open = team.operator.designCheckIn ? null : designOpen(await store.tasks.all());
      if (open)
        console.warn(
          `  note: the design check-in #${open.id} is still open (${open.status}) and holds features, though operator.designCheckIn is off now: a6g task status ${open.id} done ends it`
        );
      const filed = gaps ? await fileGaps(store, team, home, null) : [];
      if (filed.length) console.info(`  the harness's gaps, for the planner to triage: ${filed.map((id) => `#${id}`).join(", ")}`);
    } finally {
      await store.close();
    }
  } catch (error) {
    console.warn(`  note: couldn't file the design check-in or the harness's gaps (${(error as Error).message.split("\n")[0]})`);
  }
}

function registerTeam(
  home: string,
  { force, version: target, worker = false, engine: requested }: { force: boolean; version?: string; worker?: boolean; engine?: string | undefined }
): number {
  const team = loadTeam(home);
  for (const warning of team.warnings) console.warn(`  note: ${warning}`);
  // Register doesn't write team.json (a change there would hold up every merge until it's committed).
  if (!team.factory && !target)
    console.warn(`  note: team.json pins no factory version, so the team runs whichever version registers it (a6g upgrade ${team.name} pins one)`);
  const problems = t3.contract();
  if (problems.length && !force) die(`T3 Code isn't ready:\n  - ${problems.join("\n  - ")}\n(a6g doctor explains; --force registers anyway)`);
  if (!existsSync(join(home, ".a6g", ".gitignore")))
    console.warn("  note: .a6g/.gitignore is missing; add one with run/ so the team's runtime stays out of git");

  // A worker machine of a team on several machines runs builders only: the lead runs the rest, the team's environment
  // with it, which testers test against.
  if (worker && !(multiMachine(team) && !isLead(team)))
    die(
      `--worker is for a machine other than the lead of a team whose tasks are in Mongo (team.json tasks.lead${team.tasks.lead ? ` is ${team.tasks.lead}, and this is ${machineName()}` : " isn't set"})`
    );
  if (!worker && !isLead(team))
    die(`this team's lead is ${team.tasks.lead} and this is ${machineName()}: register it here with --worker, or make this machine the lead`);

  const version = target ?? versionFor(team);
  const previous = readRegistry(team.name);
  if (previous && previous.home !== home)
    die(`a team named ${team.name} is already registered at ${previous.home}; pick another name or a6g unregister ${team.name}`);
  // One team per checkout: a renamed team would otherwise run beside the old one on the same files.
  const other = teamNames().find((name) => name !== team.name && readRegistry(name)?.home === home);
  if (other) die(`${home} is already registered as the team ${other}; a6g unregister ${other} first, or keep the name ${other}`);
  // The Docker engine its containers run on (lib/docker.ts), for a team that needs one or whose operator names one.
  // It stays the one it has until --docker names another.
  let engine: docker.Pin | null = previous?.docker ?? null;
  let why = "as it was registered";
  if (requested || (team.environment.needsDocker && !engine)) {
    const engines = docker.contexts();
    const chosen = docker.choose({ requested, engines, up: requested ? [] : docker.running(engines), host: process.env.DOCKER_HOST });
    if ("problem" in chosen) die(chosen.problem);
    ({ pin: engine, why } = chosen);
  }
  const run = previous?.run ?? defaultRunDir(team.name);
  mkdirSync(run, { recursive: true });
  const project = previous?.project ?? team.raw.t3ProjectId ?? t3.projectAdd(team.title, home);
  if (!project) die(`couldn't add ${home} as a T3 Code project; add it in T3 Code and put its id in team.json t3ProjectId`);

  const instances: Record<string, t3.ProviderInstance> = {};
  const roles = Object.keys(team.roles).filter((role) => !worker || role === "builder");
  // Each role stays on the subscription its instance runs on (the watchdog moves it, lib/steer.ts); a new role starts
  // on the first open one the operator listed for it (a6g subscriptions use), else this Mac's own login.
  const logins = accounts();
  const before = t3.teamInstances(team.name) ?? {};
  const fresh = chooseFor(
    roles.filter((role) => !before[role]),
    {},
    { use: teamUses()[team.name], accounts: logins, state: subscriptionState(), limits: subscriptionLimits() }
  );
  const homeOf = (role: string): string | null => {
    const had = before[role];
    if (had) return had.homePath;
    const chosen = fresh.roles[role];
    return chosen ? (logins.find((a) => a.name === chosen)?.configDir ?? null) : null;
  };
  // The roles that read the operator's taste start with Ditto's server beside T3 Code's tools (lib/ditto.ts). The
  // file names the factory's launcher and holds no secret; the launcher reads the team's token when it starts.
  const withDitto = roles.filter((role) => team.ditto?.roles.includes(role));
  const dittoConfig = withDitto.length ? writeMcpConfig(run, team.name, version) : null;
  if (dittoConfig && !(dittoServer() && hasToken(team.name)))
    console.warn(
      `  note: team.json gives the ${withDitto.join(" and the ")} Ditto, which isn't connected here yet: a6g ditto ${team.name} --grant --server <ditto-mcp.js>`
    );
  for (const role of roles) {
    const prompt = writePrompt(team, role, run);
    const flags = [
      `--agent a6g:${role}`,
      `--plugin-dir ${quote(pluginDir(version))}`,
      `--append-system-prompt-file ${quote(prompt)}`,
      `--setting-sources ${team.isolation === "strict" ? "project" : "user,project"}`,
      // The planner keeps the account's connectors for its email; everyone else gets only T3 Code's tools, and
      // Ditto's where the team's rules give the role them.
      team.isolation === "strict" && role !== "planner" ? "--strict-mcp-config" : null,
      dittoConfig && withDitto.includes(role) ? `--mcp-config ${quote(dittoConfig)}` : null,
    ].filter((flag) => flag !== null);
    instances[instanceId(team, role)] = t3.instance({
      displayName: `${team.title} · ${role}`,
      launchArgs: flags.join(" "),
      environment: memberEnvironment(team, role, { home, run, version, engine }),
      compactAt: role === "planner" ? team.plannerCompactAt : null,
      homePath: homeOf(role),
    });
  }
  t3.writeTeam({ team: team.name, instances, project, setup: team.worktreeSetup, branchPrefix: team.branchPrefix });

  mkdirSync(teamsDir, { recursive: true });
  // The roles this machine runs, each with its model; `model` is the one its watchdog starts first.
  const models = Object.fromEntries(Object.entries(modelsOf(team)).filter(([role]) => roles.includes(role)));
  const first = worker ? "builder" : "planner";
  const entry: RegistryEntry = {
    name: team.name,
    title: team.title,
    home,
    run,
    project,
    version,
    plannerInstance: instanceId(team, "planner"),
    model: models[first] ?? defaultModel(first),
    models,
    health: team.environment.health,
    needsDocker: team.environment.needsDocker,
    ...(engine ? { docker: engine } : {}),
    worktreesDir: t3.worktreesDir(home),
    watchdog: team.watchdog,
    contact: team.contact,
    operator: team.operator,
    ...(team.board.type === "tasks" ? { tasks: team.tasks } : {}),
    mode: team.mode,
    ...(worker ? { worker: true, branch: team.branch, limits: Object.fromEntries(roles.map((role) => [role, team.roles[role]?.limit ?? 0])) } : {}),
    startPrompt:
      team.startPrompt ??
      'Start the team, or pick it up where your log leaves off: read the documents your rules list, then work through "Each time you wake".',
    registeredAt: new Date().toISOString(),
  };
  writeJson(registryFile(team.name), entry);
  console.info(`a6g: registered ${team.name} (Anything Factory ${version}; T3 project ${project}; run folder ${run})`);
  console.info(
    `  roles${worker ? " (a worker: builders only; testers test on the lead, where the environment runs)" : ""}: ${roles.map((role) => `${role} (${instanceId(team, role)})`).join(", ")}`
  );
  console.info(`  models: ${describeModels(models)}`);
  if (engine)
    console.info(
      `  Docker engine: ${docker.label(engine)}${engine.context ? ` (${engine.host})` : ""}, ${why}: its members and the factory's commands for it use that one (--docker <name> names another)`
    );
  // The subscriptions each role runs on, chosen now rather than at the watchdog's next run (else at that run).
  let steered: ReturnType<typeof steer> = null;
  try {
    steered = steer({ name: team.name, run, worker });
  } catch (error) {
    console.warn(`  note: couldn't choose the subscriptions now (${(error as Error).message.split("\n")[0]}); the watchdog does at its next run`);
  }
  for (const line of steered?.said ?? []) console.info(`  ${line}`);
  const on = steered?.steering.roles ?? {};
  if (Object.values(on).some((name) => name !== null) || Object.keys(steered?.steering.waiting ?? {}).length)
    console.info(`  subscriptions: ${describeSteering(steered?.steering ?? null)}`);
  if (existsSync(join(run, "planner-thread")))
    console.info(`  a planner is running; it keeps the flags it started with until a6g rotate ${team.name} (members started from now get the new ones)`);
  else console.info(`  start it: a6g start ${team.name}`);
  return 0;
}

// Each model and the roles on it, in a line: "claude-fable-5-1 for the planner and scaffolder; claude-opus-5-5 for …".
export function describeModels(models: Record<string, string>): string {
  const on = new Map<string, string[]>();
  for (const [role, model] of Object.entries(models)) on.set(model, [...(on.get(model) ?? []), role]);
  return [...on].map(([model, roles]) => `${model} for the ${roles.join(", ")}`).join("; ");
}

// Each role's subscription on this machine, and those that wait, in a line (lib/steer.ts).
export function describeSteering(steering: ReturnType<typeof readSteering>): string {
  if (!steering) return "not chosen yet";
  const on = Object.entries(steering.roles).map(([role, name]) => {
    const moving = Object.hasOwn(steering.moving, role) ? `, moving to ${steering.moving[role] ?? "this Mac's own login"} once it's free` : "";
    return `${role} on ${name ?? "this Mac's own login"}${moving}`;
  });
  const waiting = Object.entries(steering.waiting).map(([role, wait]) => `${role} waits: ${describeWait(wait)}`);
  return [...on, ...waiting].join("; ");
}

// The team off the web app, as the operator, unless it's off already; and back on it, unless it's on. Each resolves to
// whether it changed anything.
export async function takeOffApp(store: Store, team: string, why: string): Promise<boolean> {
  if (retiredOf(await store.controls.all())) return false;
  await store.controls.create(retireControl(team, OPERATOR, why));
  return true;
}
export async function putBackOnApp(store: Store, team: string): Promise<boolean> {
  if (!retiredOf(await store.controls.all())) return false;
  await store.controls.create(restoreControl(team, OPERATOR));
  return true;
}

export async function unregister(argv: string[]): Promise<number> {
  operatorOnly("unregister");
  const name = argv[0] ?? die("usage: a6g unregister <team>");
  const entry = readRegistry(name) ?? die(`no team named ${name}`);
  const removed = t3.removeInstances(name);
  rmSync(registryFile(name), { force: true });
  console.info(`a6g: unregistered ${name} (${removed} T3 instances removed; its run folder ${entry.run} and checkout are kept)`);
  // Its lead takes it off the web app too: its tasks and history stay there, and a6g register puts it back.
  if (entry.tasks?.store === "mongo" && !entry.worker)
    try {
      const store = await openStore({ name, tasks: entry.tasks }, entry.run);
      try {
        await takeOffApp(store, name, `unregistered on ${machineName()}`);
        console.info(`  ${name} is off the web app (a6g register puts it back)`);
      } finally {
        await store.close();
      }
    } catch (error) {
      console.warn(`  couldn't take ${name} off the web app: ${(error as Error).message.split("\n")[0]}. An admin can, from its overview there.`);
    }
  return 0;
}

export const entryFor = (name: string): RegistryEntry =>
  readRegistry(name) ?? die(`no team named ${name} (registered: ${teamNames().join(", ") || "none"})`);
export const teamNames = (): string[] =>
  existsSync(teamsDir)
    ? readdirSync(teamsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
    : [];

export async function start(argv: string[]): Promise<number> {
  operatorOnly("start");
  const entry = entryFor(argv[0] ?? die("usage: a6g start <team>"));
  // A pause the operator or the budget recorded stays until a6g resume, which is the operator's alone: start only starts
  // the watch (the setup agent runs it too). A paused file with no pause recorded (an earlier version's) it lifts.
  if (entry.tasks && !entry.worker) {
    let hold: ReturnType<typeof holdOf> = null;
    let when: string | null = null;
    try {
      const store = await openStore({ name: entry.name, tasks: entry.tasks }, entry.run);
      try {
        const controls = await store.controls.all();
        hold = holdOf(controls);
        when = pausedUntil(controls, limitsOf(controls));
      } finally {
        await store.close();
      }
    } catch (error) {
      console.error(`a6g: couldn't read the team's controls (${(error as Error).message.split("\n")[0]}); a pause recorded there still holds`);
    }
    if (hold) {
      console.info(
        `a6g: ${entry.name} is paused (${hold.by === "budget" ? "by its budget" : "by the operator"}, ${describeHold(hold)}): ${when ? `auto-resume starts it again ${when} at the earliest, or a6g resume ${entry.name} now` : `a6g resume ${entry.name} starts it again`}`
      );
      return status([entry.name]);
    }
  }
  rmSync(join(entry.run, "paused"), { force: true });
  ensureWatchdog();
  const why = await watchOnce(entry.name);
  if (why) {
    console.error(`a6g: ${entry.name} wasn't started: ${why}. When T3 Code doesn't answer, \`t3 service restart\`, then a6g start ${entry.name} again.`);
    await status([entry.name]);
    return 1;
  }
  return status([entry.name]);
}

const PAUSE_USAGE = 'usage: a6g pause <team> [--after tasks | --after journeys [--journeys 3,7]] [--note "…"]';

// The operator's control, recorded in the team's store and applied in its run folder at once (the web app's wait for
// the watchdog's next minute). On a worker machine it's recorded only: the lead applies it.
export async function recordControl(entry: RegistryEntry, make: (store: Store) => Promise<Omit<Control, "id" | "version">>): Promise<Control> {
  const tasks = entry.tasks ?? die(`${entry.name} keeps its tickets on a GitHub board, which has no controls`);
  const store = await openStore({ name: entry.name, tasks }, entry.run);
  let control: Control;
  try {
    control = await store.controls.create(await make(store));
  } catch (error) {
    if (error instanceof Refused) die(error.message);
    throw error;
  } finally {
    await store.close();
  }
  mkdirSync(entry.run, { recursive: true });
  // Under the watchdog's lock, so a run applying the same control at the same moment doesn't tell the planner twice;
  // then the web app's view of the team, at once. Busy for a minute, it's left to the watchdog's next minute.
  const release = await acquireSlot([join(entry.run, ".watch.lock")], { waitMin: 1, holder: "a6g" });
  if (!release) {
    console.info("a6g: the watchdog is busy with the team; it applies this within a minute");
    return control;
  }
  try {
    await applyTeamControls(
      entry,
      (text) => appendFileSync(join(entry.run, "watchdog.log"), `${new Date().toISOString().replace(/\.\d+Z$/, "Z")} ${text}\n`),
      (text) => console.error(`a6g: ${text}`)
    );
    await reportTeamState(entry);
  } finally {
    release();
  }
  return control;
}

// This machine alone: a worker's own pause (its builders), or the operator's when the task graph can't be reached.
function pauseHere(entry: RegistryEntry, paused: boolean): void {
  mkdirSync(entry.run, { recursive: true });
  if (paused) writeFileSync(join(entry.run, "paused"), new Date().toISOString());
  else rmSync(join(entry.run, "paused"), { force: true });
}

// a6g pause <team>: nothing starts or merges from now; running members finish their turn. --after tasks: the work under
// way finishes, reviewed and merged, then the team pauses; --after journeys: the journeys under way (or --journeys)
// finish, verification and polish included, then it pauses. Either way the operator gets a report when it does, and
// work stays stopped until a6g resume. A team whose tickets are on a GitHub board can only pause now.
export async function pause(argv: string[]): Promise<number> {
  operatorOnly("pause");
  const { positional, options } = parseArgs(argv);
  const entry = entryFor(positional[0] ?? die(PAUSE_USAGE));
  const after = typeof options["after"] === "string" ? options["after"].replace(/s$/, "") : undefined;
  if (after !== undefined && after !== "task" && after !== "journey") die(PAUSE_USAGE);
  const scope: HoldScope = after === "task" ? "tasks" : after === "journey" ? "journeys" : "now";
  const journeys =
    typeof options["journeys"] === "string"
      ? options["journeys"]
          .split(",")
          .map((id) => id.trim().replace(/^#/, ""))
          .filter(Boolean)
      : undefined;
  if (journeys && scope !== "journeys") die("--journeys goes with --after journeys");
  const note = typeof options["note"] === "string" ? options["note"] : "";
  if (!entry.tasks || entry.worker) {
    if (scope !== "now")
      die(
        entry.worker
          ? `pause the team after its work from its lead; here, a6g pause ${entry.name} stops this machine's members`
          : `${entry.name} keeps its tickets on a GitHub board, so it can only pause now (a6g pause ${entry.name})`
      );
    pauseHere(entry, true);
    if (entry.worker) {
      console.info(`a6g: this machine's members of ${entry.name} are paused; the rest of the team isn't (a6g pause on its lead pauses it all)`);
      return 0;
    }
  } else
    try {
      await recordControl(entry, async (store) => pauseControl(await store.tasks.all(), entry.name, { scope, journeys, by: OPERATOR, note }));
    } catch (error) {
      // Stopping must work whatever else doesn't: now is a file on this machine, recorded once the graph is reachable.
      if (scope !== "now") throw error;
      pauseHere(entry, true);
      console.error(
        `a6g: couldn't record the pause in the task graph (${(error as Error).message.split("\n")[0]}): paused on this machine; run a6g pause ${entry.name} again once it's reachable, so the web app and other machines know`
      );
    }
  const hold = readHold(entry.run);
  console.info(
    scope === "now"
      ? `a6g: ${entry.name} paused: the watchdog sends no ticks and starts nothing, and the planner can't start members or merge. Running members finish what they're doing.`
      : `a6g: ${entry.name} is pausing after ${hold ? describeHold(hold) : scope}: that work finishes and merges, nothing else is claimed, and once nothing in it can move the team pauses and you get a report. a6g status ${entry.name} shows what's left.`
  );
  return 0;
}

const BUDGET_USAGE =
  "usage: a6g budget <team> [--account <subscription>] [--daily <$|%>] [--weekly <$|%>] [--total <$|%>] [--auto-resume | --no-auto-resume] [--restart] [--clear]";

// a6g budget <team>: the team's spending limits, in API-equivalent dollars (lib/budget.ts enforces them: a warning at
// four fifths, a pause after the work under way at the limit, a pause now a tenth past it). With no limit given, what
// they are and what's spent. A limit left out keeps its value and 0 removes it; --restart counts the total from now;
// --auto-resume starts a team the budget paused for a day or week again when the next one starts; --clear removes all.
// With --account, the limits are on what the team spends on that subscription: reaching one moves the team to its next
// subscription (lib/steer.ts) rather than pausing it, and --clear removes only those.
export async function budget(argv: string[]): Promise<number> {
  operatorOnly("budget");
  const { positional, options } = parseArgs(argv, { booleans: ["auto-resume", "no-auto-resume", "restart", "clear"] });
  const entry = entryFor(positional[0] ?? die(BUDGET_USAGE));
  if (!entry.tasks) die(`${entry.name} keeps its tickets on a GitHub board, which has no budget`);
  const account = options["account"] === undefined ? null : typeof options["account"] === "string" ? options["account"].trim() : "";
  if (account !== null && !SUBSCRIPTION_NAME.test(account)) die(`${BUDGET_USAGE}\n(--account: a subscription's name, as a6g subscriptions lists it)`);
  if (account && !accounts().some((a) => a.name === account))
    console.warn(`a6g: note: ${account} isn't a subscription on this Mac (a6g subscriptions add); the limits apply wherever it's one`);
  // The limits in force are the store's (the web app may have changed them a moment ago, and a worker never applies
  // them); the run folder's copy only when the store can't be reached.
  let current = readLimits(entry.run);
  let held = false;
  try {
    const store = await openStore({ name: entry.name, tasks: entry.tasks }, entry.run);
    try {
      const controls = await store.controls.all();
      current = limitsOf(controls);
      held = holdOf(controls)?.by === "budget";
    } finally {
      await store.close();
    }
  } catch (error) {
    console.error(`a6g: couldn't read the budget from the task graph (${(error as Error).message.split("\n")[0]}); showing this machine's copy`);
  }
  // Each limit in dollars ("40") or as a share of one subscription's week ("60%", over 100% for more than one
  // subscription's worth). One unit for the whole budget: limits given in the other one drop those not given, and a
  // subscription's own are in the budget's unit.
  const keys = ["daily", "weekly", "total"] as const;
  const units = new Set(
    keys.flatMap((key) => (typeof options[key] === "string" ? [String(options[key]).trim().endsWith("%") ? "subscription" : "usd"] : []))
  );
  if (units.size > 1) die("give every limit in dollars, or every limit as a percentage of a subscription, not some of each");
  const unit: "usd" | "subscription" = units.size ? ([...units][0] as "usd" | "subscription") : (current?.unit ?? "usd");
  const switched = unit !== (current?.unit ?? "usd");
  const inForce = current !== null && (keys.some((key) => current?.[key] !== null) || Object.keys(current.accounts ?? {}).length > 0);
  if (account && switched && inForce)
    die(
      `${entry.name}'s budget is in ${current?.unit === "subscription" ? "percent of a subscription's week" : "dollars"}: give the limits on ${account} the same way (or change the budget's own first)`
    );
  const base: Partial<Record<(typeof keys)[number], number | null>> | null = account ? (current?.accounts?.[account] ?? null) : current;
  const amount = (key: (typeof keys)[number]): number | null => {
    const given = options[key];
    if (typeof given !== "string") return switched ? null : (base?.[key] ?? null);
    const n = Number(given.trim().replace(/^\$/, "").replace(/%$/, ""));
    const max = unit === "subscription" ? 10_000 : 1_000_000;
    if (!Number.isFinite(n) || n < 0 || n > max)
      die(
        `--${key}: ${unit === "subscription" ? "a percentage of a subscription's week, from 0 (none) to 10,000" : "dollars, from 0 (none) to 1,000,000"}`
      );
    return n === 0 ? null : Math.round(n * 100) / 100;
  };
  const words = (limits: Limits): string => {
    const one = (n: number | null) => (n === null ? "none" : limits.unit === "subscription" ? `${n}%` : `$${n}`);
    const shares = limits.unit === "subscription" ? " (each a share of one subscription's weekly limit)" : "";
    const each = Object.entries(limits.accounts ?? {}).map(
      ([name, own]) => `; on ${name}: ${one(own.daily)} a day, ${one(own.weekly)} a week, ${one(own.total)} in all`
    );
    return `${one(limits.daily)} a day, ${one(limits.weekly)} a week, ${one(limits.total)} in all since ${limits.since.slice(0, 10)}${shares}${each.join("")}`;
  };
  const asked = ["daily", "weekly", "total", "auto-resume", "no-auto-resume", "restart", "clear"].some((key) => options[key] !== undefined);
  if (!asked) {
    const spend = readJson<Spend | null>(join(entry.run, "spend.json"), null);
    console.info(
      current
        ? `${entry.name}'s budget: ${words(current)}${current.autoResume ? "; a new day or week resumes a team it paused" : ""}`
        : `${entry.name} has no budget (${BUDGET_USAGE.replace("usage: ", "")})`
    );
    if (spend) console.info(describeSpend(spend, current));
    return 0;
  }
  const own = (limits: { daily: number | null; weekly: number | null; total: number | null }): boolean =>
    limits.daily !== null || limits.weekly !== null || limits.total !== null;
  let limits: Limits | null = null;
  if (account || !options["clear"]) {
    // The subscriptions' own limits: kept in the same unit, dropped with a switch of the budget's, this one's as asked.
    const each = { ...(switched ? {} : (current?.accounts ?? {})) };
    if (account) {
      const mine = { daily: amount("daily"), weekly: amount("weekly"), total: amount("total") };
      if (options["clear"] || !own(mine)) delete each[account];
      else each[account] = mine;
    }
    limits = {
      daily: account ? (current?.daily ?? null) : amount("daily"),
      weekly: account ? (current?.weekly ?? null) : amount("weekly"),
      total: account ? (current?.total ?? null) : amount("total"),
      since: options["restart"] || !current ? nowIso() : current.since,
      autoResume: options["auto-resume"] ? true : options["no-auto-resume"] ? false : (current?.autoResume ?? false),
      unit,
      ...(Object.keys(each).length ? { accounts: each } : {}),
    };
    if (!own(limits) && !limits.accounts) limits = null;
  }
  await recordControl(entry, async () => budgetControl(entry.name, OPERATOR, limits));
  const week = subscriptionWeek();
  console.info(
    limits
      ? `a6g: ${entry.name}'s budget is ${words(limits)}; the watchdog holds the team to it from its next run${switched && current ? ` (the limits that were in ${current.unit === "subscription" ? "percent" : "dollars"} and weren't given again are dropped)` : ""}`
      : `a6g: ${entry.name} has no budget now`
  );
  if (account && limits?.accounts?.[account])
    console.info(
      `a6g: once the team reaches a limit on ${account}, it moves to its next subscription (a6g subscriptions use), and roles with none left wait`
    );
  // A change doesn't lift a pause the budget made, but with auto-resume the watchdog does once nothing is over.
  if (held)
    console.info(
      limits?.autoResume
        ? `a6g: the budget paused ${entry.name}; with auto-resume, the watchdog starts it again at its next run if nothing is over now, else when the next day or week does`
        : `a6g: the budget paused ${entry.name}, and it stays paused: a6g resume ${entry.name} starts it`
    );
  if (limits?.unit === "subscription")
    console.info(
      week
        ? `a6g: one subscription's week is about $${Math.round(week).toLocaleString("en-US")} API-equivalent, as last measured (a6g subscriptions)`
        : "a6g: the subscription hasn't been measured yet, so the budget isn't checked until it is (the watchdog reads it every quarter hour; a6g subscriptions check reads it now)"
    );
  return 0;
}

// a6g resume <team> [--note "…"]: work starts again; the note goes to the planner, as the operator's feedback.
export async function resume(argv: string[]): Promise<number> {
  operatorOnly("resume");
  const { positional, options } = parseArgs(argv);
  const entry = entryFor(positional[0] ?? die('usage: a6g resume <team> [--note "…"]'));
  const note = typeof options["note"] === "string" ? options["note"] : "";
  if (!entry.tasks || entry.worker) pauseHere(entry, false);
  else
    try {
      await recordControl(entry, async () => resumeControl(entry.name, OPERATOR, note));
    } catch (error) {
      pauseHere(entry, false);
      rmSync(join(entry.run, "hold.json"), { force: true });
      console.error(
        `a6g: couldn't record the resume in the task graph (${(error as Error).message.split("\n")[0]}): this machine carries on, but claims still see the pause there until a6g resume ${entry.name} reaches it`
      );
      return 1;
    }
  console.info(`a6g: ${entry.name} resumed${note && entry.tasks ? "; the planner has your note" : ""}`);
  return 0;
}

// A fresh planner thread: after register changed the instances (a running thread keeps its old flags), or to
// clear a long context. Refused while the planner has members running (they report to it), while it's in the
// middle of a turn, and whenever T3 Code can't say which. The old one is retired inside the watchdog's lock for the
// team, so a watchdog run can't start or adopt a planner halfway through.
export async function rotate(argv: string[]): Promise<number> {
  operatorOnly("rotate");
  const entry = entryFor(argv[0] ?? die("usage: a6g rotate <team>"));
  const file = join(entry.run, "planner-thread");
  let old = "";
  const refused = await watchOnce(entry.name, () => {
    old = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (!old) return null;
    const busy = plannerBusy(entry.run, "rotate");
    if (busy) return busy;
    retirePlanner(entry.run);
    return null;
  });
  if (refused) die(`rotate: ${refused}`);
  const now = existsSync(file) ? readFileSync(file, "utf8").trim() : "not started (see the watchdog log)";
  console.info(`a6g: ${entry.name}'s planner was ${old || "none"}, now ${now}`);
  return 0;
}

// Where each team stands: paused or active, its planner and the members running, whether its environment answers
// (team.json's health URLs) and what's drained, the worktrees kept for their work, and the watchdog's last lines.
export async function status(argv: string[]): Promise<number> {
  const names = argv.length ? argv : teamNames();
  if (!names.length) console.info("no teams registered yet: a6g init sets one up");
  for (const name of names) {
    const entry = entryFor(name);
    const planner = existsSync(join(entry.run, "planner-thread")) ? readFileSync(join(entry.run, "planner-thread"), "utf8").trim() : null;
    const thread = planner ? t3.threadShow(planner) : null;
    const hold = readHold(entry.run);
    const pausing = hold !== null && !hold.settledAt && hold.scope !== "now";
    const flags = [
      existsSync(join(entry.run, "paused")) ? "paused" : pausing ? "pausing" : null,
      existsSync(join(entry.run, "complete")) ? "complete" : null,
    ].filter((flag) => flag !== null);
    console.info(`== ${name} (${entry.title}) ${flags.length ? flags.join(", ") : "active"} · factory ${entry.version} · ${entry.home}`);
    console.info(`   planner ${planner ?? "none"}${thread ? ` (${thread.status})` : ""}`);
    const counts = planner ? t3.childCounts(planner) : [];
    console.info(
      `   members running: ${counts.length ? counts.map((row) => `${row.instance.replace(`a6g-${name}-`, "")} ${row.n}`).join(", ") : planner ? "none" : "-"}`
    );
    const steering = readSteering(entry.run);
    if (steering && (Object.values(steering.roles).some((on) => on !== null) || Object.keys(steering.waiting).length))
      console.info(`   subscriptions: ${describeSteering(steering)}`);
    const health = entry.health ?? [];
    if (health.length) {
      const up = await Promise.all(health.map((target) => answers(target)));
      const state = up.every(Boolean) ? "up" : up.some(Boolean) ? "partly up" : "down";
      console.info(
        `   environment: ${state} (${health.map((target, i) => `${target.replace(/^any:/, "")} ${up[i] ? "answers" : "doesn't answer"}`).join(", ")})`
      );
    } else console.info("   environment: no health URLs in team.json, so not checked");
    if (entry.docker) console.info(`   Docker engine: ${docker.label(entry.docker)}${docker.answers(entry.docker) ? "" : ", which isn't running"}`);
    if (hold && pausing)
      console.info(
        `   pausing after ${describeHold(hold)} (asked ${hold.since.slice(0, 16)}): left ${hold.left.join("; ") || "nothing, so it pauses at the watchdog's next run"}${hold.stuck.length ? `; stopped: ${hold.stuck.join("; ")}` : ""}`
      );
    else if (hold?.settledAt && hold.scope !== "now")
      console.info(`   paused after ${describeHold(hold)} at ${hold.settledAt.slice(0, 16)}: a6g resume ${name} carries on`);
    const spend = readJson<Spend | null>(join(entry.run, "spend.json"), null);
    if (spend) console.info(`   ${describeSpend(spend, readLimits(entry.run))}`);
    const drain = join(entry.home, ".a6g", "run", "state", "drain");
    if (existsSync(drain)) console.info(`   draining: ${readFileSync(drain, "utf8").trim()} (a6g drain off, from the team's checkout)`);
    // The merge queue's last check of the integration branch: its pages and its end-to-end suite.
    const checked = readVerifyLog(entry.home).at(-1);
    if (checked) console.info(`   checked after merges: ${checked}`);
    const due = checkDue(entry.home);
    if (due) console.info(`   a check after merges is due${due.after ? ` (after ${due.after})` : ""}: the next merge runs it`);
    const kept = keptWorktrees(entry.run);
    if (kept.length)
      console.info(
        `   kept ${kept.length} finished worktrees that may hold work (nothing deletes them; look, then git worktree remove): ${kept.join("; ")}`
      );
    const log = join(entry.run, "watchdog.log");
    if (existsSync(log)) for (const line of readFileSync(log, "utf8").trim().split("\n").slice(-3)) console.info(`   ${line}`);
  }
  return 0;
}

// Every registered team on a line: its version, whether it runs, and its checkout (a6g status says more).
export function teams(): number {
  for (const name of teamNames()) {
    const entry = readRegistry(name);
    if (!entry) continue;
    const hold = readHold(entry.run);
    const state = existsSync(join(entry.run, "paused"))
      ? "paused"
      : hold && !hold.settledAt && hold.scope !== "now"
        ? "pausing"
        : existsSync(join(entry.run, "complete"))
          ? "complete"
          : "active";
    console.info(`${name.padEnd(20)} ${String(entry.version).padEnd(8)} ${state.padEnd(9)} ${entry.home}`);
  }
  return 0;
}

// a6g prompt <team|checkout> <role>: the text the role works under, compiled now.
export function prompt(argv: string[]): number {
  const [target, role] = argv;
  const home = (target ? readRegistry(target)?.home : undefined) ?? homeFrom(target);
  const team = loadTeam(home);
  if (!role || !team.roles[role]) die(`usage: a6g prompt <team> <role> (${Object.keys(team.roles).join(", ")})`);
  process.stdout.write(compile(team, role));
  const entry = readRegistry(team.name);
  if (entry) console.error(`\n(the registered copy is ${promptFile(entry.run, role)})`);
  return 0;
}

// team.json with its pin set to version, changing only that line (or adding one after "name"), so the commit is one
// line and the operator's formatting stays; a file that doesn't allow that is written out whole.
export function pinned(text: string, version: string): string {
  const pin = `"factory": ${JSON.stringify(version)}`;
  const edited = /"factory"\s*:\s*"[^"\n]*"/.test(text)
    ? text.replace(/"factory"\s*:\s*"[^"\n]*"/, pin)
    : text.replace(/^([ \t]*)"name"\s*:\s*"[^"\n]*",[ \t]*\n/m, (line, indent: string) => `${line}${indent}${pin},\n`);
  const wanted = { ...(JSON.parse(text) as RawTeam), factory: version };
  // Only when the edit changed nothing else (a "factory" inside vars, before the top-level one, mustn't be it).
  try {
    if (isDeepStrictEqual(JSON.parse(edited), wanted)) return edited;
  } catch {}
  return `${JSON.stringify(wanted, null, 2)}\n`;
}

// a6g upgrade <team> [version] [--force] [--docker <name>]: register the team again on an installed version (this one
// by default), then move its pin there. It runs in the version it moves to, whose code compiles the prompts and
// writes the instances; the pin moves only once that worked. --docker names the team's Docker engine, as register's.
export async function upgrade(argv: string[]): Promise<number> {
  operatorOnly("upgrade");
  const { positional, options } = parseArgs(argv, { booleans: ["force"] });
  const entry = entryFor(positional[0] ?? die("usage: a6g upgrade <team> [version] [--force] [--docker <name>]"));
  const version = positional[1] ?? PACKAGE.version;
  const engine = engineOption(options["docker"]);
  if (!existsSync(versionDir(version))) die(`Anything Factory ${version} isn't installed (a6g versions lists them)`);
  const force = Boolean(options["force"]);
  if (realpathSync(versionDir(version)) !== realpathSync(FACTORY_ROOT)) {
    if (process.env.A6G_UPGRADING === version)
      die(`Anything Factory ${version} at ${versionDir(version)} handed the upgrade back; run it from that version`);
    const flags = [...(force ? ["--force"] : []), ...(engine ? ["--docker", engine] : [])];
    const result = spawnSync(process.execPath, [entryOf(versionDir(version)), "upgrade", entry.name, version, ...flags], {
      stdio: "inherit",
      env: { ...process.env, A6G_HANDED_OVER: "1", A6G_UPGRADING: version },
    });
    return result.status ?? 1;
  }
  registerTeam(entry.home, { force, version, worker: Boolean(entry.worker), engine });
  await publishTeam(entry.home);
  const file = teamFile(entry.home);
  writeFileSync(file, pinned(readFileSync(file, "utf8"), version));
  // The prompts' sources include team.json, so compile them again with the pin in it.
  const team = loadTeam(entry.home);
  for (const role of Object.keys(team.roles)) writePrompt(team, role, entry.run);
  console.info(`a6g: ${entry.name} now pins Anything Factory ${version}. Commit .a6g/team.json on the integration branch.`);
  return 0;
}
