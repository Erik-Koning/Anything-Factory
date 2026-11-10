// a6g merge <branch> [--closes 12,13] [--rebased-from <approved sha>] [--light] [--no-after] [--queue]
//
// The only way into a team's integration branch. The planner runs it.
// --queue returns at once: the merge runs in the background, one at a time, and the planner is woken with the
// result (its next wake's context shows it too). Without --queue it runs in the foreground.
//
// 1. Lane: the branch's diff stays in the lane of the role its name belongs to (team.json roles.<role>.branch),
//    changes no protected path (team.json protect), and adds no symlink.
// 2. Approval: a branch whose role is in review.required needs a reviewer's approval of its exact tip (a6g verdict
//    review), or --rebased-from <the approved commit> when the tip is that same change rebased (git range-diff
//    finds every commit unchanged). A branch that removes lines matching review.removedPattern (an assertion) needs
//    one too.
// 3. Merges in a scratch worktree (.a6g/run/merge) and runs the full gate there, under the gate semaphore.
// 4. Fast-forwards the integration branch and closes the tickets (--closes and the number in the branch name).
// 5. Outside the merge lock, under the app lock: the team's afterMerge command (rebuild, restart, recheck), with
//    BEFORE and AFTER (the commits the branch moved between) and A6G_LIGHT=1 / JOURNEYS=0 with --light.
// Any git command that fails refuses the merge. Nothing merges while the operator has paused the team.
// Exit codes: 0 merged, 2 refused (lane, approval or state), 3 conflict, 4 gate failed, 75 timed out waiting for the
// merge lock or a gate slot (nothing ran; queue it again).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { FACTORY_PATH, factoryWrite, laneAllows, roleForBranch, type Team } from "../config.ts";
import { HARNESS_FILE, readHarness } from "../harness.ts";
import { acquire, TIMED_OUT, withLock } from "../lock.ts";
import { entryOf, FACTORY_ROOT, readRegistry, stateDir, workDir } from "../paths.ts";
import { leakRefusal, leaksInRange } from "../secrets.ts";
import { inTeam, teamSession } from "../session.ts";
import { machineName } from "../machine.ts";
import { isTest } from "../blast.ts";
import { branchRef, integrationDiverged, isLead, pushIntegration } from "../tasks/machines.ts";
import { ticketOf, type Task } from "../tasks/model.ts";
import { closeMerged, openTeamStore, sendBackToRebase } from "../tasks/ops.ts";
import { threadSend } from "../t3.ts";
import { list, localTime, parseArgs, readJson, text as optionText, writeJson } from "../util.ts";
import { clearQueued, markQueued, pendingDir, verifyAfterMerge } from "../verify.ts";
import { journeyProofFor } from "./e2e.ts";
import {
  allowed,
  CODE,
  fewerTests,
  holdsJourneyTest,
  importsRunner,
  listSuite,
  type Listing,
  manifestNarrowing,
  narrowingAdded,
  SUITE_MENTIONS,
  testLaneProblems,
} from "./harness.ts";
import { pruneWorktrees } from "./watchdog.ts";

// What a merge left in .a6g/run/state/merges/<branch>.json, and a reviewer's verdict in state/reviews/.
export interface MergeRecord {
  branch: string;
  result: string;
  message: string;
  sha: string;
  at: string;
}
export interface Verdict {
  kind: string;
  name: string;
  verdict: string;
  sha: string;
  // How much the reviewer judged the change could break (review approvals since 0.4.0).
  risk?: string;
  note: string;
  by: string;
  at: string;
}
type Recorder = (result: string, message: string, sha?: string) => void;

export const usage = "a6g merge <branch> [--closes 12,13] [--rebased-from <approved sha>] [--light] [--no-after] [--queue]";

// How long a merge waits for a lock: the merge lock and the app lock two hours, a gate slot one. A6G_MERGE_WAIT_MIN
// sets all three (the tests use it).
const waitMin = (minutes: number): number => Number(process.env.A6G_MERGE_WAIT_MIN) || minutes;

// Diffs and listings can be large; past this, git's output is cut off, and the merge is refused rather than checked
// on part of it.
const MAX_BUFFER = 256 * 1024 * 1024;

// The task a scaffolder's branch is named for, or why the branch can't merge (teams with a task graph). What the branch
// may change comes from its task's kind, so it has to name a task of its own that's approved and still open: named
// for none, or for one that's finished, it would take the widest lane there is.
const OPEN: readonly string[] = ["approved", "building", "review", "blocked", "question"];
async function ownTask(team: Team, run: string, home: string, branch: string): Promise<Task | string> {
  const id = ticketOf(branch, team.branchPrefix);
  if (!id)
    return `${branch} isn't named for a task (a6g task claim names a scaffolder's branch, ${team.branchPrefix}/s<task>-…), and what a scaffolder's branch may change comes from its task's kind`;
  let task: Task | null;
  try {
    const store = await openTeamStore(team, run, home);
    try {
      task = await store.tasks.get(id);
    } finally {
      await store.close();
    }
  } catch (error) {
    return `the team's tasks couldn't be read (${(error as Error).message.split("\n")[0] ?? ""}), so what ${branch} may change isn't known; nothing was merged, queue it again`;
  }
  if (!task) return `${branch} is named for task ${id}, and there's no such task: what a scaffolder's branch may change comes from its task's kind`;
  if (!OPEN.includes(task.status))
    return `${branch} is named for task ${id}, which is ${task.status}: a scaffolder's branch merges for its own approved, open task`;
  if (task.branch && task.branch !== branch)
    return `${branch} is named for task ${id}, which was submitted as ${task.branch}: a scaffolder's branch merges for its own task`;
  return task;
}

// The paths in a diff that a role may not change: outside its lane, the factory's own files, or the paths only the
// team's scripts write (team.json protect).
export function outsideLane(team: Team, role: string, paths: string[]): string[] {
  return paths.filter(
    (path) => factoryWrite(team, role, path) || !laneAllows(team, role, path) || team.protect.some((rule) => new RegExp(rule).test(path))
  );
}

// The lines a unified diff removes, read hunk by hunk: a removed line that itself starts with "-" counts, and a
// file header ("--- a/x") doesn't.
export function removedLines(diff: string): string[] {
  const removed: string[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) {
        removed.push(line.slice(1));
        oldLeft--;
      } else if (line.startsWith("+")) newLeft--;
      else if (!line.startsWith("\\")) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
    }
  }
  return removed;
}

// Why a symlink a branch adds or changes can't merge, or null. Members' branches merge none: a link can point a
// path the lane allows at the factory's files, or anywhere outside the checkout.
export function symlinkProblem(team: Team, role: string, path: string, target: string): string | null {
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (role !== "planner") return `${path} is a symlink (to ${target}); branches from the ${role} don't merge symlinks`;
  if (FACTORY_PATH.test(path) || FACTORY_PATH.test(resolved) || factoryWrite(team, role, resolved))
    return `${path} is a symlink into the factory's own files (${target})`;
  if (posix.isAbsolute(target) || resolved === ".." || resolved.startsWith("../")) return `${path} is a symlink outside the checkout (${target})`;
  return null;
}

class GitFailed extends Error {}

// a6g merge --push: the lead, once the remote takes pushes again after a merge whose push failed. It pushes the
// integration branch and closes the tasks those merges were holding open.
async function pushWaiting(): Promise<number> {
  if (inTeam() && process.env.A6G_ROLE !== "planner") {
    console.error("merge: only the planner merges");
    return 2;
  }
  const { home, team, run } = teamSession();
  if (!isLead(team)) {
    console.error(`merge: merges happen on the team's lead machine, ${team.tasks.lead}`);
    return 2;
  }
  const unpushed = join(run, "unpushed.json");
  const waiting = readJson<{ ids: string[]; branch: string; sha: string; tip: string; rebasedFrom?: string }[]>(unpushed, []);
  const pushed = pushIntegration(home, team);
  if (!pushed.ok) {
    console.error(`merge: ${pushed.said}`);
    return 1;
  }
  const closed: string[] = [];
  if (waiting.length && team.board.type === "tasks") {
    const store = await openTeamStore(team, run, home);
    try {
      for (const merge of waiting) closed.push(...(await closeMerged(store, merge.ids, { ...merge, journeyProof: journeyProofFor(home, team) })).closed);
    } finally {
      await store.close();
    }
  }
  rmSync(unpushed, { force: true });
  console.info(`merge: ${pushed.said ?? `${team.branch} needs no push`}.${closed.length ? ` Closed: ${closed.join(" ")}.` : ""}`);
  return 0;
}

// A queued run clears its own queue mark however it ends (refused, timed out, thrown), so the check after merges never
// waits for a merge that's over (lib/verify.ts).
export async function run(argv: string[]): Promise<number> {
  const mark = process.env.A6G_MERGE_QUEUED ? process.env.A6G_MERGE_MARK : undefined;
  try {
    return await merge(argv);
  } finally {
    if (mark) clearQueued(mark);
  }
}

async function merge(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, { booleans: ["queue", "light", "no-journeys", "no-after", "skip-after", "push"], repeat: ["closes"] });
  const branch = positional[0];
  if (!branch && options["push"] === true) return pushWaiting();
  if (!branch) {
    console.error(`usage: ${usage}`);
    return 2;
  }
  // --closes 12,13, --closes 12 --closes 13, or --closes 12 13 (the numbers after it).
  const closes = [...list(options["closes"]), ...positional.slice(1)].flatMap((value) => String(value).split(/[,\s#]+/)).filter((n) => /^\d+$/.test(n));
  if (inTeam() && process.env.A6G_ROLE !== "planner") {
    console.error("merge: only the planner merges");
    return 2;
  }
  const { home, team, run: runDir } = teamSession();
  const state = stateDir(home);
  const safe = branch.replaceAll("/", "_");
  const recordFile = join(state, "merges", `${safe}.json`);
  mkdirSync(join(state, "merges"), { recursive: true });

  // The record is kept here and always written whole: the planner's context hook moves a record it has shown to
  // <branch>.seen.json at any moment, so it's never read back.
  const kept: { last: MergeRecord | null } = { last: null };
  const record: Recorder = (result, message, sha = "") => {
    kept.last = { branch, result, message, sha, at: new Date().toISOString() };
    writeJson(recordFile, kept.last);
    appendFileSync(join(state, "merges.log"), `${localTime()} ${branch} ${result} ${message}\n`);
  };
  // A queued merge wakes the planner once, with the whole result.
  const wake = () => {
    const last = kept.last;
    if (!process.env.A6G_MERGE_QUEUED || !runDir || !last) return;
    const planner = existsSync(join(runDir, "planner-thread")) ? readFileSync(join(runDir, "planner-thread"), "utf8").trim() : "";
    if (planner) threadSend(planner, `merge-queue: ${branch} ${last.result}${last.sha ? ` at ${last.sha}` : ""}. ${last.message}`.trim());
  };

  // Belt and braces with the guard: while the operator has paused the team, nothing merges.
  if (inTeam() && runDir && existsSync(join(runDir, "paused"))) {
    record("refused", "the operator paused the team; nothing merges until they resume it (a6g resume)");
    console.error("merge: the operator paused the team; nothing merges until they resume it");
    return 2;
  }

  // A team on several machines merges only on its lead, the always-on machine (lib/tasks/machines.ts).
  if (!isLead(team)) {
    record("refused", `merges happen on the team's lead machine, ${team.tasks.lead}; this is ${machineName()}`);
    console.error(`merge: merges happen on the team's lead machine, ${team.tasks.lead}`);
    return 2;
  }

  // The queued run itself (A6G_MERGE_QUEUED) merges in the foreground, whatever form of --queue it was given.
  const queue = options["queue"];
  if (queue !== undefined && !["false", "0", "no"].includes(String(queue)) && !process.env.A6G_MERGE_QUEUED) {
    const rest = argv.filter((arg) => !/^--queue(=.*)?$/.test(arg));
    const log = openSync(join(state, "merges", `${safe}.log`), "w");
    const mark = join(pendingDir(state), `${safe}.json`);
    const child = spawn(process.execPath, [entryOf(FACTORY_ROOT), "merge", ...rest], {
      cwd: home,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, A6G_MERGE_QUEUED: "1", A6G_MERGE_MARK: mark },
    });
    // Marked as queued until it finishes, so the check after merges waits for the last of a burst (lib/verify.ts).
    if (child.pid) markQueued(mark, child.pid);
    child.unref();
    closeSync(log);
    console.info(`merge: ${branch} queued. The result comes as a message and in your next wake's context; the log is .a6g/run/state/merges/${safe}.log.`);
    return 0;
  }

  // The check after merges (lib/verify.ts): a queued merge, however it ends, runs one that's due, since a merge before
  // it may have left its check to this one; and a merge that landed marks one due.
  const check = async (merged: boolean): Promise<void> => {
    if (!process.env.A6G_MERGE_QUEUED || !runDir) return;
    try {
      const planner = existsSync(join(runDir, "planner-thread")) ? readFileSync(join(runDir, "planner-thread"), "utf8").trim() : "";
      await verifyAfterMerge(home, team, runDir, branch, { merged, wake: (text) => planner && threadSend(planner, text) });
    } catch (error) {
      console.error(`merge: the check after merges failed: ${(error as Error).message}`);
    }
  };

  const release = await acquire(home, "merge", {
    slots: 1,
    waitMin: waitMin(120),
    holder: `merge ${branch}`,
    onWait: (text) => console.error(`merge: ${text}`),
  });
  if (!release) {
    record("timed-out", `another merge held the merge lock for ${waitMin(120)} min; nothing was merged, queue it again`);
    console.error(`merge: another merge held the merge lock for ${waitMin(120)} min; nothing was merged`);
    wake();
    await check(false);
    return TIMED_OUT;
  }
  let code: number;
  let before: string | null = null;
  try {
    ({ code, before = null } = await mergeLocked({
      home,
      team,
      run: runDir,
      branch,
      closes,
      rebasedFrom: optionText(options["rebased-from"]),
      record,
      safe,
      state,
    }));
  } catch (error) {
    if (!(error instanceof GitFailed)) throw error;
    record("refused", `${error.message}; nothing was merged`);
    console.error(`merge: ${error.message}; nothing was merged`);
    code = 2;
  } finally {
    release();
  }

  const light = Boolean(options["light"] || options["no-journeys"]);
  if (code === 0 && team.afterMerge && !options["no-after"] && !options["skip-after"]) {
    const after = spawnSync("git", ["rev-parse", "HEAD"], { cwd: home, encoding: "utf8" }).stdout.trim();
    const output: string[] = [];
    let busy = false;
    const status = await withLock(home, "app", ["sh", "-c", team.afterMerge], {
      slots: 1,
      waitMin: waitMin(120),
      cwd: home,
      // A6G_APP_LOCK: the command holds the app lock, so the checks it runs (a6g pages, a6g e2e) don't wait on it.
      env: { BEFORE: before ?? "", AFTER: after, A6G_LIGHT: light ? "1" : "0", JOURNEYS: light ? "0" : "1", A6G_APP_LOCK: "held" },
      stdio: ["ignore", "pipe", "pipe"],
      onOutput: (chunk) => {
        process.stdout.write(chunk);
        output.push(String(chunk));
      },
      onTimeout: () => (busy = true),
    });
    const summary = output
      .join("")
      .split("\n")
      .filter((line) => /^(journeys|after|pages):/.test(line))
      .slice(-3)
      .join(" ");
    const outcome = busy ? `didn't run, the app lock stayed busy for ${waitMin(120)} min` : status === 0 ? "ok" : `FAILED, exit ${status}`;
    const last = kept.last;
    if (last) {
      kept.last = { ...last, message: `${last.message} after merge: ${outcome} ${summary}`.trim() };
      writeJson(recordFile, kept.last);
    }
  }
  wake();
  // The queue runs where the planner does, which can read a checkout the launchd watchdog can't (~/Documents).
  if (process.env.A6G_MERGE_QUEUED) {
    const entry = readRegistry(team.name);
    try {
      if (entry && entry.home === home) pruneWorktrees(entry);
    } catch (error) {
      console.error(`merge: pruning finished worktrees failed: ${(error as Error).message}`);
    }
    // The pages and the suite on the merged result. A light merge, or one that didn't land, marks no check due, and
    // still runs one an earlier merge left. Whether the app came back up after an after-merge command that failed is
    // the check's to find: it asks the app first.
    await check(code === 0 && !light);
  }
  return code;
}

async function mergeLocked({
  home,
  team,
  run,
  branch,
  closes,
  rebasedFrom,
  record,
  safe,
  state,
}: {
  home: string;
  team: Team;
  run: string;
  branch: string;
  closes: string[];
  rebasedFrom: string | undefined;
  record: Recorder;
  safe: string;
  state: string;
}): Promise<{ code: number; before?: string }> {
  const g = (...args: string[]) => spawnSync("git", args, { cwd: home, encoding: "utf8", maxBuffer: MAX_BUFFER });
  // The output of a git command that has to work; anything else (an error, an exit code, output past the buffer)
  // refuses the merge, rather than checking nothing.
  const raw = (...args: string[]): string => {
    const result = g(...args);
    if (result.error || result.status !== 0)
      throw new GitFailed(`git ${args.join(" ")} failed: ${(result.error?.message ?? result.stderr ?? "").trim().split("\n")[0] ?? ""}`.trim());
    return result.stdout;
  };
  const out = (...args: string[]): string => raw(...args).trim();
  const commit = (ref: string): string | null => {
    const result = g("rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const fail = (code: number, result: string, message: string) => {
    record(result, message);
    console.error(`merge: ${message}`);
    return { code };
  };
  const integration = team.branch;
  // The branch's task goes back to be claimed and rebuilt (a conflict, a secret), on whichever machine claims it: the
  // branch is on the remote. What's said of it, to end the refusal.
  const sentBack = async (rebuild?: string): Promise<string> => {
    const id = ticketOf(branch, team.branchPrefix);
    if (team.board.type !== "tasks" || !id) return "";
    try {
      const store = await openTeamStore(team, run, home);
      try {
        const why = await sendBackToRebase(store, id, { branch, integration, ...(rebuild ? { rebuild } : {}) });
        return why ? ` (task ${id} wasn't sent back: ${why})` : `; task ${id} went back to be claimed and ${rebuild ? "rebuilt" : "rebased"}`;
      } finally {
        await store.close();
      }
    } catch (error) {
      return ` (task ${id} couldn't be sent back: ${(error as Error).message})`;
    }
  };
  const scratch = join(workDir(home), "merge");
  const cleanup = () => {
    if (g("worktree", "remove", "--force", scratch).status !== 0) rmSync(scratch, { recursive: true, force: true });
    g("worktree", "prune");
  };

  if (out("rev-parse", "--abbrev-ref", "HEAD") !== integration) return fail(2, "refused", `the team's checkout must be on ${integration}`);
  if (out("status", "--porcelain", "--untracked-files=no") !== "")
    return fail(2, "refused", `${integration} has uncommitted changes; commit or discard them first`);
  // A branch a worker pushed: what the remote has (the approval below still has to name that exact commit).
  // On a team on several machines, the remote's copy of the branch, where every submit pushes it.
  const from = branchRef(home, team, branch);
  if (!from.ok) return fail(2, "refused", from.said);
  const diverged = integrationDiverged(home, team);
  if (diverged) return fail(2, "refused", diverged);
  const tip = commit(from.ref);
  if (!tip) return fail(2, "refused", `no branch ${branch}`);
  if (Number(out("rev-list", "--count", `${integration}..${tip}`)) === 0) return fail(2, "refused", `${branch} has nothing that ${integration} doesn't`);

  const role = roleForBranch(team, branch);
  if (!role)
    return fail(
      2,
      "refused",
      `${branch} isn't a team branch (${Object.entries(team.roles)
        .filter(([, l]) => l.branch)
        .map(([r, l]) => `${r}: ${l.branch}`)
        .join(", ")})`
    );
  // Secrets don't merge (lib/secrets.ts): read in every commit the branch would bring, before anything else is.
  const leaks = leaksInRange(raw, `${integration}..${tip}`);
  if (leaks.length) {
    const why = leakRefusal(branch, leaks);
    return fail(2, "refused", `${why}${await sentBack(why)}`);
  }
  // --no-renames lists both sides of a rename, so a move can't hide a deletion outside the lane. -z gives each path
  // as it is: git quotes unusual ones otherwise, and a quoted path matches no lane rule.
  const paths = (...args: string[]): string[] =>
    raw("diff", "--name-only", "--no-renames", "-z", ...args)
      .split("\0")
      .filter(Boolean);
  const changed = paths(`${integration}...${tip}`);
  const outside = outsideLane(team, role, changed);
  if (outside.length) return fail(2, "refused", `${branch} (${role}) changes files outside its lane: ${outside.join(" ")}`);
  // Each file's new mode: 120000 is a symlink, which the paths alone don't show.
  const entries = raw("diff", "--raw", "--no-renames", "-z", "--no-abbrev", `${integration}...${tip}`).split("\0");
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const [, mode, , blob] = (entries[i] ?? "").split(" ");
    const path = entries[i + 1] ?? "";
    if (mode !== "120000" || !blob) continue;
    const problem = symlinkProblem(team, role, path, out("cat-file", "blob", blob));
    if (problem) return fail(2, "refused", `${branch} (${role}): ${problem}`);
  }

  // The harness (lib/harness.ts, ./harness.ts). A branch's manifest must load.
  const touchesHarness = changed.includes(HARNESS_FILE);
  if (touchesHarness) {
    const problems = readHarness(home, tip).problems;
    if (problems.length) return fail(2, "refused", `${branch}'s ${HARNESS_FILE} doesn't load: ${problems.slice(0, 3).join("; ")}`);
  }
  const diff = raw("diff", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", `${integration}...${tip}`);
  // Where the branch started: what it changed is judged against that, not against what merged since.
  const base = out("merge-base", integration, tip);
  const show = (ref: string, path: string): string | null => {
    const blob = g("cat-file", "blob", `${ref}:${path}`);
    return blob.error || blob.status !== 0 ? null : blob.stdout;
  };

  // A scaffolder's test and test-infra work stays in test and harness files. Which kind of work a branch is comes from
  // its own task, so on a team with a task graph it has to name one.
  if (role === "scaffolder" && team.board.type === "tasks") {
    const task = await ownTask(team, run, home, branch);
    if (typeof task === "string") return fail(2, "refused", task);
    const outside =
      task.kind === "scaffold"
        ? []
        : testLaneProblems(
            changed,
            team.harness.lane.map((rule) => new RegExp(rule)),
            (path) => ({ before: show(base, path), after: show(tip, path) })
          );
    if (outside.length)
      return fail(
        2,
        "refused",
        `${branch} is ${task.kind} work, which changes test and harness files only, and it changes ${outside.slice(0, 5).join(" ")}: a product change is a builder's task`
      );
  }

  // The changed files that could be the suite's, by what they mention where the branch started, on the integration
  // branch or on the branch: git finds them, and only those are read.
  const mentions = (ref: string): string[] => {
    const found = g("grep", "-l", "-z", "-I", "-F", ...SUITE_MENTIONS.flatMap((text) => ["-e", text]), ref, "--");
    // Exit 1: no file mentions them.
    if (found.error || (found.status !== 0 && found.status !== 1))
      throw new GitFailed(`git grep in ${ref} failed: ${(found.error?.message ?? found.stderr ?? "").trim().split("\n")[0] ?? ""}`.trim());
    return found.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(ref.length + 1));
  };
  const mentioned = new Set([base, integration, tip].flatMap(mentions));
  const suiteFiles = changed
    .filter((path) => CODE.test(path) && mentioned.has(path))
    .map((path) => ({ path, base: show(base, path), mid: show(integration, path), tip: show(tip, path) }));

  // A builder's branch changes no file that holds a journey's test: nobody makes their own proof. On a team with
  // someone else to write them, that is.
  const proofIsOthers = role === "builder" && Boolean(team.roles["tester"] || team.roles["scaffolder"]);
  const ownProof = (held: string[]): string =>
    `${branch} (a builder's) changes ${held.slice(0, 5).join(" ")}, where a journey's tests are: a journey's proof comes from a tester or the scaffolder, not from who built it. Take those changes out of the branch, and ask the planner for a test task for them`;
  if (proofIsOthers) {
    const held = suiteFiles.filter((file) => [file.base, file.mid, file.tip].some((text) => holdsJourneyTest(file.path, text)));
    if (held.length) return fail(2, "refused", ownProof(held.map((file) => file.path)));
  }

  // Checking less is the operator's call (Article 5): only once the team has a suite to narrow. Here, what the text of
  // the suite's files says (those that import Playwright's test runner, and its configuration); below, in the scratch
  // worktree, what the suite's own listing says.
  const suiteBefore = readHarness(home, integration).harness?.e2e;
  const allowance = allowed(state, branch, tip);
  const checksLess = (found: string[]): string =>
    `${branch} checks less than ${integration}: ${found.slice(0, 5).join("; ")}. That's the operator's call: ask them, and they allow this commit with a6g harness allow ${branch} --sha ${tip.slice(0, 9)} --why "…"`;
  const configs = [suiteBefore?.config, readHarness(home, tip).harness?.e2e?.config];
  const suiteTexts = !suiteBefore
    ? []
    : [
        ...suiteFiles
          .filter((file) => importsRunner(file.base) || importsRunner(file.tip))
          .map((file) => ({ path: file.path, before: file.base, after: file.tip })),
        ...changed
          .filter(
            (path) => configs.includes(path) && !suiteFiles.some((file) => file.path === path && (importsRunner(file.base) || importsRunner(file.tip)))
          )
          .map((path) => ({ path, before: show(base, path), after: show(tip, path) })),
      ];
  const narrows = [...(touchesHarness ? manifestNarrowing(home, base, tip) : []), ...narrowingAdded(suiteTexts)];
  if (narrows.length && !allowance) return fail(2, "refused", checksLess(narrows));
  // What the suite's listings say of a branch: the tests that run before it (`was`) and with it merged (`now`).
  const measured = (was: Listing, now: Listing | string): string | null => {
    if (typeof now === "string")
      return allowance
        ? null
        : `${branch} breaks the suite's listing (${now.slice(0, 300)}), so its tests can't be counted: fix that. If the suite is meant to go, that's the operator's call: they allow this commit with a6g harness allow ${branch} --sha ${tip.slice(0, 9)} --why "…"`;
    // A tag can come from a helper or a variable; the listing names the files whichever way.
    const held = proofIsOthers ? changed.filter((path) => was.journeyFiles.includes(path) || now.journeyFiles.includes(path)) : [];
    if (held.length) return ownProof(held);
    if (allowance) return null;
    const fewer = fewerTests(was, now);
    if (fewer.length) return checksLess(fewer);
    // The suite's files that the text above didn't find (a spec that takes `test` from the suite's own fixtures).
    const more = changed.filter((path) => (was.files.includes(path) || now.files.includes(path)) && !suiteTexts.some((file) => file.path === path));
    const added = more.length ? narrowingAdded([...suiteTexts, ...more.map((path) => ({ path, before: show(base, path), after: show(tip, path) }))]) : [];
    return added.length ? checksLess(added) : null;
  };

  // Every scaffolder branch, and any that changes the manifest, is reviewed, whatever review.required says.
  let required = team.review.required.includes(role) || role === "scaffolder" || touchesHarness;
  const removedPattern = team.review.removedPattern;
  if (!required && removedPattern) {
    const pattern = new RegExp(removedPattern);
    required = removedLines(diff).some((line) => pattern.test(line));
  }
  if (required) {
    const review = readJson<Verdict>(join(state, "reviews", `${safe}.json`));
    if (!review) return fail(2, "refused", `${branch} has no review; start a reviewer (it records one with a6g verdict review)`);
    if (review.verdict !== "approve") return fail(2, "refused", `the review of ${branch} asks for changes: ${review.note}`);
    if (review.sha !== tip) {
      const approved = review.sha.slice(0, 9);
      if (rebasedFrom && g("cat-file", "-e", `${review.sha}^{commit}`).status !== 0)
        return fail(
          2,
          "refused",
          `the approved commit ${approved} is gone from the repository, so the rebase can't be compared; have ${branch} reviewed again`
        );
      if (!rebasedFrom || commit(rebasedFrom) !== review.sha)
        return fail(
          2,
          "refused",
          `the approval is for ${approved} but ${branch} is at ${tip.slice(0, 9)}: have it reviewed again, or pass --rebased-from ${approved} if it's only a rebase`
        );
      // range-diff skips merge commits, so a "rebase" that merged the integration branch in could carry new code in
      // the merge itself. A rebase has none.
      const oldRange = `${out("merge-base", review.sha, integration)}..${review.sha}`;
      const newRange = `${out("merge-base", tip, integration)}..${tip}`;
      if (out("rev-list", "--merges", oldRange) || out("rev-list", "--merges", newRange))
        return fail(
          2,
          "refused",
          `${branch} has merge commits, so it isn't a plain rebase of ${approved}; rebase it without merges, or have it reviewed again`
        );
      // Every commit in both ranges paired with one unchanged ("=") on the other side, and nothing else.
      const commits = Number(out("rev-list", "--count", oldRange));
      const lines = out("range-diff", "--no-color", oldRange, newRange).split("\n").filter(Boolean);
      const same = lines.filter((line) => /^\s*\d+:\s+[0-9a-f]+\s+=\s+\d+:\s+[0-9a-f]+(\s|$)/.test(line)).length;
      if (!commits || Number(out("rev-list", "--count", newRange)) !== commits || lines.length !== commits || same !== commits)
        return fail(2, "refused", `${branch} isn't only a rebase of the approved ${approved} (git range-diff shows changes); have it reviewed again`);
    }
    // A change the reviewer judged high-risk merges with its tests: they come in the same branch, not after it.
    // Tests added or changed, that is: deleting one isn't testing the change.
    if (review.risk === "high" && !paths("--diff-filter=AM", `${integration}...${tip}`).some(isTest))
      return fail(
        2,
        "refused",
        `the reviewer judged ${branch} high-risk, and it changes no tests: its tests come with it (unit tests for logic, end-to-end for a flow); send it back with changes`
      );
  }

  const before = out("rev-parse", integration);
  cleanup();
  if (g("worktree", "add", "--detach", "--quiet", scratch, integration).status !== 0) return fail(2, "refused", "couldn't make the scratch worktree");
  try {
    // The suite's own count of its tests, in the same worktree before the merge and with it.
    const listWork = join(workDir(home), "merge-list");
    const listMerged = (config: string): Promise<Listing | string> => listSuite(scratch, readHarness(scratch).harness?.e2e?.config ?? config, listWork);
    let was = suiteBefore ? await listSuite(scratch, suiteBefore.config, listWork) : null;
    // The commit that was checked and approved, not whatever the branch points at by now.
    const merged = spawnSync("git", ["merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} into ${integration}`, tip], {
      cwd: scratch,
      encoding: "utf8",
    });
    if (merged.status !== 0) {
      spawnSync("git", ["merge", "--abort"], { cwd: scratch });
      return fail(3, "conflict", `${branch} conflicts with ${integration}; rebase it onto ${integration}${await sentBack()}`);
    }
    // Two changes to the manifest can merge into one that doesn't load, and with no manifest nothing here checks.
    const mergedProblems = touchesHarness ? readHarness(scratch).problems : [];
    if (mergedProblems.length)
      return fail(
        3,
        "conflict",
        `${HARNESS_FILE} doesn't load once ${branch} is merged into ${integration} (${mergedProblems.slice(0, 3).join("; ")}); rebase it onto ${integration}`
      );
    // Where the suite lists as git has it, the branch is measured before the gate's time is spent.
    let now = suiteBefore && was && typeof was !== "string" ? await listMerged(suiteBefore.config) : null;
    const counted = Boolean(was && now && typeof was !== "string" && typeof now !== "string");
    if (was && now && typeof was !== "string" && typeof now !== "string") {
      const refusal = measured(was, now);
      if (refusal) return fail(2, "refused", refusal);
    }
    if (team.gate.full) {
      const gateLog = join(state, "merges", `${safe}.gate.log`);
      const fd = openSync(gateLog, "w");
      let busy = false;
      const status = await withLock(home, "gate", ["sh", "-c", team.gate.full], {
        slots: team.gate.concurrency,
        waitMin: waitMin(60),
        cwd: scratch,
        stdio: ["ignore", fd, fd],
        onTimeout: () => (busy = true),
      });
      closeSync(fd);
      if (busy)
        return fail(
          TIMED_OUT,
          "timed-out",
          `no gate slot came free in ${waitMin(60)} min (other gates held all ${team.gate.concurrency}), so the gate never ran; nothing was merged, queue ${branch} again`
        );
      const log = readFileSync(gateLog, "utf8");
      process.stdout.write(log);
      if (status !== 0) {
        const said = log
          .split("\n")
          .filter((line) => /fail|error/i.test(line))
          .slice(0, 3)
          .join(" ")
          .slice(0, 300);
        return fail(
          4,
          "gate-failed",
          `the gate fails on ${branch} merged into ${integration}; nothing was merged. ${said ? `It says: ${said} ` : ""}(full output: .a6g/run/state/merges/${safe}.gate.log)`
        );
      }
    }
    const result = out("-C", scratch, "rev-parse", "HEAD");
    // Where it didn't, the gate may have set up what the suite needs (packages installed per folder, generated files):
    // the same two listings in the worktree as the gate left it, the integration branch's files last.
    if (suiteBefore && !counted) {
      if (team.gate.full) {
        now = await listMerged(suiteBefore.config);
        const back = spawnSync("git", ["checkout", "--force", "--detach", "--quiet", before], { cwd: scratch });
        was = back.status === 0 ? await listSuite(scratch, suiteBefore.config, listWork) : "the scratch worktree couldn't go back to it";
      }
      if (!was || typeof was === "string")
        console.error(
          `merge: the suite couldn't be listed at ${integration} (${(was ?? "").slice(0, 200)}), so ${branch}'s tests weren't counted against it`
        );
      else {
        const refusal = measured(was, now ?? "it wasn't listed");
        if (refusal) return fail(2, "refused", refusal);
      }
    }

    // The gate took a while: the team's checkout must still be on the integration branch and clean.
    if (out("rev-parse", "--abbrev-ref", "HEAD") !== integration || out("status", "--porcelain", "--untracked-files=no") !== "")
      return fail(2, "refused", `the team's checkout moved off ${integration} or has uncommitted changes; nothing was merged, queue ${branch} again`);
    // Files in the checkout that git doesn't track but the merge would write: git won't overwrite them.
    const incoming = new Set(paths("HEAD", result));
    const untracked = raw("ls-files", "--others", "--exclude-standard", "-z")
      .split("\0")
      .filter((path) => incoming.has(path));
    if (untracked.length)
      return fail(
        2,
        "refused",
        `the team's checkout has untracked files that ${branch} adds: ${untracked.slice(0, 10).join(" ")}; nothing was merged. They aren't in git: move them out of the way, then queue ${branch} again`
      );
    // The planner may have committed its own files meanwhile; those merge without another gate.
    const forward = g("merge", "--ff-only", "--quiet", result);
    if (forward.status !== 0) {
      if (out("rev-parse", integration) === before)
        return fail(
          2,
          "refused",
          `${integration} couldn't be fast-forwarded to the merged result (${forward.stderr.trim().split("\n")[0] ?? ""}); nothing was merged`
        );
      const moved = paths(before, integration);
      const notPlanner = outsideLane(team, "planner", moved);
      if (notPlanner.length)
        return fail(3, "conflict", `${integration} moved while ${branch} was being merged (${notPlanner.join(" ")}); nothing was merged, queue it again`);
      if (g("merge", "--no-ff", "--no-edit", "--quiet", "-m", `Merge ${branch} into ${integration}`, result).status !== 0) {
        // Never leave the team's checkout mid-merge: every later merge would be refused for its changes.
        g("merge", "--abort");
        return fail(
          3,
          "conflict",
          `${integration} moved while ${branch} was being merged, and the planner's commits conflict with it; nothing was merged, queue it again`
        );
      }
    }
  } finally {
    cleanup();
  }
  const sha = g("rev-parse", "--short", "HEAD").stdout.trim();

  // A team on several machines: the integration branch goes to the remote before its tasks are done, so a worker that
  // claims what they unblock builds on it.
  const pushed = pushIntegration(home, team);
  // Close what the branch did: --closes, plus the number in the branch's name (a6g/b89-… closes 89). Merges whose push
  // failed close theirs with the next one that pushes, since only then can a worker build on them.
  const fromName = ticketOf(branch, team.branchPrefix);
  const unpushed = join(run, "unpushed.json");
  const waiting = readJson<{ ids: string[]; branch: string; sha: string; tip: string; rebasedFrom?: string }[]>(unpushed, []);
  const ids = [...new Set([...closes, ...(fromName ? [fromName] : [])])];
  const closed: string[] = [];
  const skipped: string[] = [];
  if (!pushed.ok) {
    writeJson(unpushed, [...waiting, { ids, branch, sha, tip, ...(rebasedFrom ? { rebasedFrom: commit(rebasedFrom) ?? rebasedFrom } : {}) }]);
    console.error(
      `merge: merged here, but ${pushed.said}. Its tasks (${ids.join(" ") || "none"}) stay open until a merge pushes, or a6g merge --push once the remote takes pushes again; the operator sorts out the remote.`
    );
  } else if (team.board.type === "tasks") {
    // The merge happened; a task graph that can't be reached doesn't undo it, and the planner hears why.
    try {
      const store = await openTeamStore(team, run, home);
      try {
        for (const earlier of [...waiting, { ids, branch, sha, tip, ...(rebasedFrom ? { rebasedFrom: commit(rebasedFrom) ?? rebasedFrom } : {}) }]) {
          const result = await closeMerged(store, earlier.ids, {
            branch: earlier.branch,
            sha: earlier.sha,
            tip: earlier.tip,
            rebasedFrom: earlier.rebasedFrom,
            journeyProof: journeyProofFor(home, team),
          });
          closed.push(...result.closed);
          skipped.push(...result.skipped);
        }
        rmSync(unpushed, { force: true });
      } finally {
        await store.close();
      }
    } catch (error) {
      console.error(`merge: merged, but couldn't close the tasks (${ids.join(" ")}): ${(error as Error).message}`);
    }
  } else {
    const label = team.board.label;
    for (const n of ids) {
      spawnSync("gh", ["issue", "edit", n, "--remove-label", `${label}:building`, "--remove-label", `${label}:review`], { cwd: home, stdio: "ignore" });
      const close = spawnSync("gh", ["issue", "close", n, "--comment", `Merged into ${integration} at ${sha} (a6g merge, ${branch}).`], {
        cwd: home,
        stdio: "ignore",
      });
      if (close.status === 0) closed.push(n);
    }
  }
  const note = `${integration} was ${before.slice(0, 7)}.${closed.length ? ` Closed: ${[...new Set(closed)].join(" ")}.` : ""}${skipped.length ? ` Not closed: ${skipped.join("; ")}.` : ""}${pushed.said ? ` ${pushed.said}.` : ""}`;
  record("merged", note, sha);
  console.info(`merge: ${integration} is now ${sha} (was ${before.slice(0, 7)}).${closed.length ? ` Closed: ${[...new Set(closed)].join(" ")}.` : ""}`);
  return { code: 0, before };
}
