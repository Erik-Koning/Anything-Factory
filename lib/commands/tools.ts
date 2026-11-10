// The commands team members run: verdict, log, lock, gate, env, finish, progress and drain. Each works for the
// team the caller belongs to (its instance sets A6G_HOME_DIR) or the checkout a person runs it in.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquire, TIMED_OUT, withLock } from "../lock.ts";
import type { LoadedTeam } from "../config.ts";
import { journeysRequired, pagePlan, readHarness } from "../harness.ts";
import { e2eDone, namespaceOf } from "./e2e.ts";
import { keepLooks } from "./pages.ts";
import { stateDir } from "../paths.ts";
import { inTeam, teamSession } from "../session.ts";
import { blastRadius } from "../blast.ts";
import { branchRef, isLead } from "../tasks/machines.ts";
import { nowIso, type Risk, RISKS, ticketOf, withEvent } from "../tasks/model.ts";
import { changesRequested, openTeamStore } from "../tasks/ops.ts";
import { update } from "../tasks/store.ts";
import { git, list, localTime, minutes, parseArgs, readJson, text as optionText, writeJson } from "../util.ts";

// On a team, some commands are the planner's alone (the guard says so too; this holds when it's bypassed).
const plannerOnly = (what: string): boolean => {
  if (!inTeam() || process.env.A6G_ROLE === "planner") return false;
  console.error(`${what}: only the planner does this`);
  return true;
};
// Runs a team command with sh. Arguments go to it as "$@", so nothing in them is run as shell.
const runIn = (cwd: string, command: string, args: string[] = []): number =>
  spawnSync("sh", ["-c", args.length ? `${command} "$@"` : command, "sh", ...args], { cwd, stdio: "inherit" }).status ?? 1;

// The full id of the commit `ref` names, or null.
const commitOf = (home: string, ref: string): string | null => {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { cwd: home, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};

const VERDICT_USAGE =
  'usage: a6g verdict review <branch> approve --sha <the commit you reviewed> --risk low|medium|high [--shots <dir>] [--security] [--note "…"] | review <branch> changes --sha <commit> [--note "…"] | security <branch> pass|issues --sha <the commit you reviewed> [--note "…"] | ux <subject> pass|issues --ref <the commit you audited> [--note "…"] | show review|security|ux <name>';

// Where each kind of verdict is kept in the team's state, and who records it.
const VERDICT_KINDS: Record<string, { dir: string; values: string[]; owner: string; who: string }> = {
  review: { dir: "reviews", values: ["approve", "changes"], owner: "reviewer", who: "reviewer" },
  security: { dir: "security", values: ["pass", "issues"], owner: "security-reviewer", who: "security reviewer" },
  ux: { dir: "ux", values: ["pass", "issues"], owner: "ux-specialist", who: "ux-specialist" },
};

// a6g verdict review <branch> approve|changes --sha <commit> [--note "…"]
// a6g verdict security <branch> pass|issues --sha <commit> [--note "…"]
// a6g verdict ux <subject> pass|issues --ref <commit> [--note "…"]
// a6g verdict show review|security|ux <name>
// Pinned to the exact commit judged, never to whatever a name points at when it's recorded: a review, and a security
// review, names the commit its reviewer read, refused when the branch has moved past it (the merge queue accepts only
// a verdict on the tip it merges), and a UX verdict names the commit the specialist audited and counts only for that
// source.
export async function verdict(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, { booleans: ["security"] });
  const [kind, name, value] = positional;
  const { home, team, run } = teamSession();
  const file = (k: string, n: string): string => join(stateDir(home), VERDICT_KINDS[k]?.dir ?? "ux", `${n.replaceAll("/", "_")}.json`);
  if (kind === "show") {
    const path = file(name ?? "", value ?? "");
    console.info(existsSync(path) ? readFileSync(path, "utf8").trim() : "none");
    return 0;
  }
  const spec = VERDICT_KINDS[kind ?? ""];
  if (!kind || !spec || !name || !value || !spec.values.includes(value)) {
    console.error(VERDICT_USAGE);
    return 2;
  }
  // Belt and braces with the guard: on a team, only the role that owns a verdict records it.
  const owner = spec.owner;
  if (inTeam() && process.env.A6G_ROLE !== owner) {
    console.error(`verdict: only the ${spec.who} records a ${kind} verdict`);
    return 2;
  }
  // A branch's verdicts (a review, a security review) are the merge queue's to read; a UX verdict is on a page.
  const ofBranch = kind !== "ux";
  // A team on several machines records them where it merges: on its lead.
  if (ofBranch && !isLead(team)) {
    console.error(
      `verdict: ${kind === "review" ? "reviews" : "security reviews"} are recorded on the team's lead machine, ${team.tasks.lead}, where the merge queue reads them`
    );
    return 2;
  }
  if (kind === "security" && !team.roles["security-reviewer"]) {
    console.error("verdict: this team has no security reviewer (team.json roles), so nothing reads a security verdict");
    return 2;
  }
  // Sending a branch on is an approval's, on a team that has someone to send it to.
  const sent = options["security"] === true;
  if (sent && (kind !== "review" || value !== "approve")) {
    console.error(`verdict: --security goes with a review's approval: it sends the branch on to the security reviewer\n${VERDICT_USAGE}`);
    return 2;
  }
  if (sent && !team.roles["security-reviewer"]) {
    console.error(
      "verdict: this team has no security reviewer to send it on to (team.json roles). Record the approval without --security only if what worries you is settled; otherwise ask for changes, or file it (a6g task add … --sev …)"
    );
    return 2;
  }
  const flag = ofBranch ? "--sha" : "--ref";
  const given = optionText(options[flag.slice(2)]);
  if (!given) {
    console.error(`verdict: say which commit you judged with ${flag}\n${VERDICT_USAGE}`);
    return 2;
  }
  // A commit id, never a branch or HEAD: a name would resolve to whatever it points at when the verdict is recorded.
  if (!/^[0-9a-f]{7,64}$/i.test(given)) {
    console.error(`verdict: ${flag} takes the id of the commit you judged (git rev-parse when you started), not ${given}`);
    return 2;
  }
  // The branch as it's merged from: on a team on several machines, the remote's copy, where every submit pushes it.
  let ref = `refs/heads/${name}`;
  if (ofBranch) {
    const from = branchRef(home, team, name);
    if (!from.ok) {
      console.error(`verdict: ${from.said}`);
      return 2;
    }
    ref = from.ref;
  }
  const sha = commitOf(home, given);
  if (!sha) {
    console.error(`verdict: ${given} isn't a commit in ${home}`);
    return 2;
  }
  if (ofBranch) {
    const tip = commitOf(home, ref);
    if (!tip) {
      console.error(`verdict: no branch ${name}`);
      return 2;
    }
    if (tip !== sha) {
      console.error(
        `verdict: ${name} is at ${tip.slice(0, 9)}, not ${sha.slice(0, 9)}: it has moved since the commit you reviewed. Review what changed (git log ${sha.slice(0, 9)}..${name}) and record the verdict for ${tip.slice(0, 9)}.`
      );
      return 2;
    }
  }
  // How much could break, as the reviewer judges it: a high-risk change merges only with its tests (a6g merge). Whether
  // to look at a change a person sees is the reviewer's call (the review skill); a UI change approved without
  // screenshots says so in the task's notes, for the planner to see.
  const risk = optionText(options["risk"]);
  if (kind === "review" && value === "approve" && !(RISKS as readonly string[]).includes(risk ?? "")) {
    console.error(`verdict: say how much this change could break: --risk ${RISKS.join("|")} (the review skill says how to judge it)\n${VERDICT_USAGE}`);
    return 2;
  }
  // Once a reviewer has sent a branch on, it stays sent: a later round's review doesn't take it back.
  let carried = false;
  if (kind === "review" && !sent && team.roles["security-reviewer"])
    try {
      carried = readJson<{ security?: boolean }>(file(kind, name))?.security === true;
    } catch {}
  const shots = optionText(options["shots"]);
  let unseen = "";
  if (kind === "review" && value === "approve" && !shots)
    try {
      const radius = blastRadius(home, { base: team.branch, ref: sha, touches: true });
      if (radius.ui) unseen = `approved without screenshots, though it changes ${radius.uiLines} lines of UI (${radius.uiFiles.slice(0, 3).join(", ")})`;
    } catch {}
  if (unseen) console.info(`verdict: ${unseen}`);
  const record = {
    kind,
    name,
    verdict: value,
    sha,
    ...(shots ? { shots } : {}),
    ...(risk ? { risk } : {}),
    ...(sent || carried ? { security: true } : {}),
    note: optionText(options["note"]) ?? "",
    by: process.env.A6G_ROLE ?? "operator",
    at: new Date().toISOString(),
  };
  writeJson(file(kind, name), record);
  console.info(`${kind} ${name}: ${value} at ${record.sha.slice(0, 9)}`);
  if (sent) console.info(`review ${name}: sent on to the security reviewer; it merges once that passes ${record.sha.slice(0, 9)} too`);
  else if (carried && value === "approve")
    console.info(
      `review ${name}: an earlier review sent this branch on to the security reviewer; it merges once that passes ${record.sha.slice(0, 9)} too`
    );
  // A page's pass keeps the screenshots the factory took at that commit: the look later checks compare against.
  if (kind === "ux" && value === "pass") console.info(`ux ${name}: ${keepLooks(home, stateDir(home), name, sha)}`);
  // The branch's task: changes send it back for another round (blocked at the team's limit); an approval is noted.
  const id = ofBranch && team.board.type === "tasks" ? ticketOf(name, team.branchPrefix) : undefined;
  if (id) {
    try {
      const store = await openTeamStore(team, run, home);
      try {
        if (kind === "security") {
          // Issues send it back like a review's changes. When the reviewer already has, the round is theirs, and the
          // findings still reach whoever reworks it.
          if (value === "issues") {
            const text = `security review of ${record.sha.slice(0, 9)} found issues: ${record.note}`;
            const { task, skipped } = await changesRequested(store, id, { branch: name, note: text, maxRounds: team.review.maxRounds, by: record.by });
            if (skipped) console.info(`task ${id}: left as it is (${skipped}); the verdict is recorded, and noted on the task`);
            else if (task) console.info(`task ${id}: ${task.status} (round ${task.rounds} of ${team.review.maxRounds})`);
            if (skipped) await update(store.tasks, id, (t) => ({ ...t, notes: [...t.notes, { at: nowIso(), by: record.by, text }] }));
          }
          // Once it's been in the security reviewer's hands it stays there: the merge queue asks for a pass of the tip.
          if (await store.tasks.get(id))
            await update(store.tasks, id, (t) => {
              const due = {
                files: t.security?.files ?? [],
                ...(t.security?.sent ? { sent: true } : {}),
                seen: true,
                ...(value === "pass" ? { passed: record.sha } : {}),
              };
              if (value !== "pass") return { ...t, security: due };
              const text = `security review passed ${record.sha.slice(0, 9)}: ${record.note}`;
              return withEvent({ ...t, security: due, notes: [...t.notes, { at: nowIso(), by: record.by, text }] }, record.by, "security passed", {
                sha: record.sha,
              });
            });
        } else if (value === "changes") {
          const { task, skipped } = await changesRequested(store, id, {
            branch: name,
            note: record.note,
            maxRounds: team.review.maxRounds,
            by: record.by,
          });
          if (skipped) console.info(`task ${id}: left as it is (${skipped}); the verdict is recorded`);
          else if (task) console.info(`task ${id}: ${task.status} (round ${task.rounds} of ${team.review.maxRounds})`);
        } else if (await store.tasks.get(id))
          await update(store.tasks, id, (t) =>
            withEvent(
              {
                ...t,
                // The commit the review approved is the task's round now: what merging it closes.
                sha: record.sha,
                risk: (risk as Risk | undefined) ?? t.risk,
                ...(sent ? { security: { ...(t.security ?? { files: [] }), sent: true } } : {}),
                notes: [
                  ...t.notes,
                  {
                    at: nowIso(),
                    by: record.by,
                    text: `review approved ${record.sha.slice(0, 9)} (${risk ?? "risk not said"}${unseen ? `; ${unseen}` : ""}${sent ? "; sent on to the security reviewer" : ""}): ${record.note}`,
                  },
                ],
              },
              record.by,
              "review approved",
              { sha: record.sha }
            )
          );
      } finally {
        await store.close();
      }
    } catch (error) {
      console.error(`verdict: recorded, but task ${id} couldn't be updated: ${(error as Error).message}`);
    }
  }
  return 0;
}

// a6g log [--label "merge 27"] "What changed, what's running, what's next."
// Prepends one entry to the planner's log (.a6g/run/state/log.md, newest first) with the real local time.
export function log(argv: string[]): number {
  if (plannerOnly("log")) return 2;
  const { positional, options } = parseArgs(argv);
  const text = positional.join(" ").trim();
  if (!text) {
    console.error('usage: a6g log [--label "merge 27"] "<entry>"');
    return 2;
  }
  const { home, team } = teamSession();
  const file = join(stateDir(home), "log.md");
  mkdirSync(stateDir(home), { recursive: true });
  const previous = existsSync(file) ? readFileSync(file, "utf8") : `# ${team.title}: planner's log (newest first)\n`;
  const [heading, ...rest] = previous.split("\n\n");
  const label = optionText(options["label"]);
  const entry = `**${localTime()}${label ? `, ${label}` : ""}.** ${text}`;
  writeFileSync(file, [heading, entry, ...rest].join("\n\n"));
  console.info(entry.slice(0, 120));
  return 0;
}

// a6g lock <name> [--slots N] [--wait-min M] -- <command> [args…]
// The wait takes minutes or a duration (30, 30m, 2h). Exits 75 when no slot came free in time.
export async function lock(argv: string[]): Promise<number> {
  const usage = "usage: a6g lock <name> [--slots N] [--wait-min M] -- <command> [args…]";
  const { positional, options } = parseArgs(argv);
  const command = list(options["--"]);
  const name = positional[0] ?? "";
  if (!name || !command.length) {
    console.error(usage);
    return 2;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    console.error(`lock: a lock's name is letters, digits, dots, dashes and underscores, not ${name}\n${usage}`);
    return 2;
  }
  const slots = Number(optionText(options["slots"]) ?? 1);
  let waitMin: number;
  try {
    waitMin = minutes(optionText(options["wait-min"]), 60);
  } catch (error) {
    console.error(`lock: --wait-min: ${(error as Error).message}\n${usage}`);
    return 2;
  }
  if (!Number.isInteger(slots) || slots < 1 || options["slots"] === true) {
    console.error(`lock: --slots takes a whole number of at least 1\n${usage}`);
    return 2;
  }
  if (!(waitMin > 0) || options["wait-min"] === true) {
    console.error(`lock: --wait-min takes a wait longer than nothing (30, 30m, 2h)\n${usage}`);
    return 2;
  }
  const { home } = teamSession();
  return withLock(home, name, command, { slots, waitMin });
}

// a6g gate [--quick]: the team's checks in the checkout you're in (a worktree, or the team's own checkout).
export async function gate(argv: string[]): Promise<number> {
  const { options } = parseArgs(argv, { booleans: ["quick"] });
  const { home, team } = teamSession();
  const command = options["quick"] ? team.gate.quick : team.gate.full;
  if (!command) {
    console.error("gate: the team has no gate (team.json gate.full)");
    return 2;
  }
  const cwd = git(process.cwd(), "rev-parse", "--show-toplevel");
  return withLock(home, "gate", ["sh", "-c", command], { slots: team.gate.concurrency, waitMin: 60, cwd });
}

// a6g env up|reset|restart|down|status: the team's environment script, run from the team's checkout.
// a6g env use [--wait-min M] [--max-min N] -- <command>: anyone's command against the team's app, where it's run,
// holding the app lock (so a merge doesn't restart the app under it), with PLAYWRIGHT_BASE_URL and an A6G_NAMESPACE of
// its own. It waits M minutes for the app, and a command that holds it past N is ended, so nothing holds it for good.
export async function env(argv: string[]): Promise<number> {
  const sub = argv[0] ?? "status";
  if (sub === "use") return envUse(argv.slice(1));
  if (sub !== "status" && plannerOnly(`env ${sub}`)) return 2;
  const { home, team } = teamSession();
  if (!team.environment.script) {
    console.info("env: the team has no environment script (team.json environment.script)");
    return sub === "status" ? 0 : 2;
  }
  return runIn(home, team.environment.script, [sub, ...argv.slice(1)]);
}

// How long a command may hold the team's app when it doesn't say (--max-min), and the most it may ask for: a check
// after merges waits 30 minutes for the app, and a merge two hours.
const USE_MAX_MIN = 30;
const USE_MOST_MIN = 120;
const USE_USAGE = `usage: a6g env use [--wait-min M] [--max-min N] -- <command>  (waits M minutes for the app, 8 unless said; ends the command after N, ${USE_MAX_MIN} unless said, ${USE_MOST_MIN} at most)`;

// Runs `command` in a process group of its own, so its time limit ends all of it (what it started too): past `maxMin`
// the group is asked to stop, and ended `graceMs` later. Resolves to its exit code, or 124 when the limit ended it.
function runLimited(
  command: string[],
  { cwd, env, maxMin, graceMs = 10_000 }: { cwd: string; env: NodeJS.ProcessEnv; maxMin: number; graceMs?: number }
): Promise<{ status: number; ended: boolean }> {
  const child = spawn(command[0] ?? "", command.slice(1), { cwd, env, stdio: "inherit", detached: true });
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {}
  };
  // A group of its own doesn't hear the terminal's Ctrl-C, or a signal sent to this process: pass it on.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const passOn = (signal: NodeJS.Signals): void => signalGroup(signal);
  for (const signal of signals) process.on(signal, passOn);
  let ended = false;
  const timers: NodeJS.Timeout[] = [];
  return new Promise<number>((done) => {
    child.on("error", (error) => {
      console.error(`env use: ${error.message}`);
      done(127);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
    timers.push(
      setTimeout(() => {
        ended = true;
        signalGroup("SIGTERM");
        timers.push(setTimeout(() => signalGroup("SIGKILL"), graceMs));
        timers.push(setTimeout(() => done(124), graceMs * 1.5));
      }, maxMin * 60_000)
    );
  }).then((status) => {
    for (const timer of timers) clearTimeout(timer);
    for (const signal of signals) process.off(signal, passOn);
    // Past its limit, nothing of the group goes on holding what the command held.
    if (ended) signalGroup("SIGKILL");
    return { status: ended ? 124 : status, ended };
  });
}

async function envUse(argv: string[]): Promise<number> {
  const dash = argv.indexOf("--");
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  const { options } = parseArgs(dash >= 0 ? argv.slice(0, dash) : argv);
  let waitMin = 8;
  let maxMin = USE_MAX_MIN;
  try {
    waitMin = minutes(optionText(options["wait-min"]), waitMin);
    maxMin = minutes(optionText(options["max-min"]), maxMin);
  } catch (error) {
    console.error(`env use: ${(error as Error).message}\n${USE_USAGE}`);
    return 2;
  }
  if (!command.length || !(maxMin > 0)) {
    console.error(USE_USAGE);
    return 2;
  }
  if (maxMin > USE_MOST_MIN) {
    console.error(
      `env use: --max-min ${maxMin} is more than the ${USE_MOST_MIN} minutes anything may hold the team's app; split the work, or ask the planner`
    );
    return 2;
  }
  const { home, team } = teamSession();
  const appUrl = pagePlan(team, readHarness(home).harness).appUrl;
  const here = process.cwd();
  const namespace = namespaceOf(here, team.branchPrefix);
  // Inside something that holds the app already (an after-merge command), the lock is that holder's.
  const held = process.env.A6G_APP_LOCK === "held";
  const release = held
    ? null
    : await acquire(home, "app", { slots: 1, waitMin, holder: `env use (${namespace})`, onWait: (text) => console.error(`env use: ${text}`) });
  if (!held && !release) {
    console.error(`env use: the team's app stayed busy for ${waitMin} minutes (a merge restarting it, or another run); try again`);
    return TIMED_OUT;
  }
  try {
    const { status, ended } = await runLimited(command, {
      cwd: here,
      env: { ...process.env, A6G_APP_LOCK: "held", A6G_NAMESPACE: namespace, ...(appUrl ? { PLAYWRIGHT_BASE_URL: appUrl } : {}) },
      maxMin,
    });
    if (ended)
      console.error(
        `env use: the command held the team's app for ${maxMin} minutes (--max-min) and was ended, with everything it started. Run less at a time, or say --max-min (${USE_MOST_MIN} at most).`
      );
    return status;
  } finally {
    release?.();
  }
}

// The team's finish line, run from its checkout: its finish command, when it has one, and, where its journeys are
// required (journeysRequired), the end-to-end suite done: passed at the head, every journey with specs that passed
// (a6g e2e done). Null when the team has neither, so there's no line to hold.
async function finishLine(home: string, team: LoadedTeam, run: string): Promise<number | null> {
  const own = team.finish ? runIn(home, team.finish) : null;
  if (!journeysRequired(home, team)) return own;
  const suite = await e2eDone(home, team, run);
  return own ? own : suite;
}

// a6g finish / a6g progress: the finish line and its status.
export async function finish(): Promise<number> {
  const { home, team, run } = teamSession();
  const code = await finishLine(home, team, run);
  if (code === null) console.error("finish: the team has no finish command (team.json finish), and no suite its journeys must pass");
  return code ?? 2;
}

// a6g complete: the planner marks the work complete, only once the finish line holds (a6g finish); the guard keeps the
// marker from being written any other way. A team with no finish line has nothing more to hold.
export async function complete(): Promise<number> {
  if (plannerOnly("complete")) return 2;
  const { home, team, run } = teamSession();
  const code = await finishLine(home, team, run);
  if (code) {
    console.error("complete: the finish line doesn't hold, so the work isn't complete (above: why)");
    return 1;
  }
  writeFileSync(join(run, "complete"), `${new Date().toISOString()}\n`);
  console.info(
    `complete: ${code === null ? "the team has no finish line to hold" : "the finish line holds"}; the work is marked complete, and the watchdog drops to a nightly tick`
  );
  return 0;
}
export function progress(): number {
  const { home, team } = teamSession();
  if (!team.progress) {
    console.info("progress: the team has no progress command (team.json progress)");
    return 0;
  }
  return runIn(home, team.progress);
}

// a6g drain <role…> | off: no new members of those roles start (the guard refuses them) until drained off.
export function drain(argv: string[]): number {
  if (argv.length && argv[0] !== "status" && plannerOnly("drain")) return 2;
  const { home } = teamSession();
  const file = join(stateDir(home), "drain");
  if (!argv.length || argv[0] === "status") {
    console.info(existsSync(file) ? `draining: ${readFileSync(file, "utf8").trim()}` : "not draining");
    return 0;
  }
  if (argv[0] === "off") {
    rmSync(file, { force: true });
    console.info("drain: off");
    return 0;
  }
  mkdirSync(stateDir(home), { recursive: true });
  writeFileSync(file, `${argv.join(" ")}\n`);
  console.info(`drain: no new ${argv.join(", ")} until a6g drain off`);
  return 0;
}
