// a6g e2e: the team's end-to-end suite, the repository's own Playwright run by the factory with the configuration its
// harness manifest names (lib/suite.ts). A journey's specs are its tests tagged @journey-<id>, and a journey is done
// only while they pass (journeyProofFor, which the move rules ask: lib/tasks/model.ts).
//
//   a6g e2e run                  run the suite against the team's app and record each test's result for the commit
//                                (the planner, and the merge queue after merges; in the team's checkout)
//   a6g e2e try [files…] [--base <url>]   run it from a worktree, with that worktree's manifest, recording nothing
//   a6g e2e status               which journeys have specs, and how the last run went
//   a6g e2e done                 exit 0 only when the suite passed at the integration branch's head and every
//                                journey has specs that passed
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedTeam, Team } from "../config.ts";
import { type Harness, journeysRequired, pagePlan, readHarness } from "../harness.ts";
import { stateDir, workDir } from "../paths.ts";
import { inTeam, teamSession } from "../session.ts";
import { journeysOf, passed as ok, reachedTests, runPlaywright, scrub, type SpecResult, specsOf, type SuiteRecord } from "../suite.ts";
import type { Task } from "../tasks/model.ts";
import { openTeamStore } from "../tasks/ops.ts";
import { parseArgs, readJson, text as optionText, writeJson } from "../util.ts";
import { holdingApp } from "./pages.ts";

const USAGE = "usage: a6g e2e run | try [files…] [--base <url>] | status | done";
// The runs kept, newest first: enough to find one that holds a journey's merges, and to see a test that flakes.
const KEEP = 20;

export const historyFile = (home: string): string => join(stateDir(home), "e2e", "history.json");
export const suiteHistory = (home: string): SuiteRecord[] => readJson<SuiteRecord[]>(historyFile(home), []);
const head = (home: string): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: home, encoding: "utf8" }).trim();
const contains = (home: string, ancestor: string, commit: string): boolean =>
  spawnSync("git", ["merge-base", "--is-ancestor", ancestor, commit], { cwd: home }).status === 0;

// A namespace for a run's data: the member's branch (a6g/b12-… is b12, a6g/t-14-… t14, a6g/s3-… s3), else its role.
export function namespaceOf(dir: string, prefix: string): string {
  let branch = "";
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}
  const stem = branch.startsWith(`${prefix}/`) ? branch.slice(prefix.length + 1) : "";
  const match = /^(?:([a-z])(\d+)|t-(\d+))-/.exec(stem);
  if (match) return match[3] ? `t${match[3]}` : `${match[1]}${match[2]}`;
  return process.env.A6G_ROLE || "try";
}

// The suite, as the manifest in `dir` describes it, against `base`.
function suiteOf(dir: string): { harness: Harness; config: string; timeoutMin: number } {
  const { harness, problems } = readHarness(dir);
  if (problems.length) throw new Error(problems.join("; "));
  if (!harness?.e2e) throw new Error("the harness manifest (.a6g/harness.json) names no suite (e2e.config): the scaffolder sets one up");
  return { harness, config: harness.e2e.config, timeoutMin: harness.e2e.timeoutMin };
}

// Runs the suite in the team's checkout against its app, holding the app, and records the run for the checkout's
// commit: a6g e2e run, and the merge queue's check after merges (one retry there, and its own namespace). A recorded
// run sets its own retries and forbids .only, so the repository's configuration can't forgive a failure or run a part.
export async function recordSuite(home: string, team: Team, { retries = 0, namespace = `e2e-${Date.now().toString(36)}` } = {}): Promise<SuiteRecord> {
  const { harness, config, timeoutMin } = suiteOf(home);
  const base = pagePlan(team, harness).appUrl;
  if (!base) throw new Error("team.json pages.appUrl (or environment.health) says where the team's app runs");
  const commit = head(home);
  const ran = await holdingApp(home, "e2e run", () =>
    runPlaywright(home, {
      config,
      args: ["--retries", String(retries), "--forbid-only"],
      env: { PLAYWRIGHT_BASE_URL: base, A6G_NAMESPACE: namespace },
      timeoutMin,
      work: join(workDir(home), "e2e"),
    })
  );
  const specs = specsOf(ran.report, home);
  const record: SuiteRecord = {
    commit,
    at: new Date().toISOString(),
    ran: !ran.timedOut && reachedTests(ran.report),
    timedOut: ran.timedOut,
    status: ran.status,
    specs,
    errors: [
      ...(ran.timedOut ? [`it ran past ${timeoutMin} minutes (e2e.timeoutMin) and was stopped`] : []),
      ...(ran.report?.errors ?? []).map((error) => scrub(error.message ?? "")),
      ...(!ran.report && !ran.timedOut ? [`no report: ${scrub(ran.tail.split("\n").slice(-3).join("\n"))}`] : []),
    ].filter(Boolean),
  };
  writeJson(historyFile(home), [record, ...suiteHistory(home)].slice(0, KEEP));
  return record;
}

// "3 passed, 1 failed, 1 expected to fail": what a run's tests came to.
export function tally(specs: SpecResult[]): string {
  const count = (outcome: string) => specs.filter((spec) => spec.outcome === outcome).length;
  return [
    `${count("passed")} passed`,
    `${count("failed")} failed`,
    ...(count("flaky") ? [`${count("flaky")} flaky`] : []),
    ...(count("skipped") ? [`${count("skipped")} skipped`] : []),
    ...(count("excused") ? [`${count("excused")} expected to fail`] : []),
  ].join(", ");
}

// Why a run that didn't run didn't, in a line.
export const notRun = (record: SuiteRecord): string => record.errors.slice(0, 2).join("; ") || "it left no results";

export const summary = (record: SuiteRecord): string =>
  record.ran
    ? `${tally(record.specs)}${record.errors.length ? `; ${record.errors.slice(0, 2).join("; ")}` : ""}`
    : `the suite didn't run: ${notRun(record)}`;

const LABEL: Partial<Record<SpecResult["outcome"], string>> = { failed: "FAIL ", flaky: "flaky", excused: "expected to fail:", skipped: "skip " };
function printRun(record: { specs: SpecResult[]; errors: string[] }, { all = false } = {}): void {
  for (const spec of record.specs.filter((s) => s.outcome === "failed" || s.outcome === "flaky" || (all && s.outcome === "excused")))
    console.info(`  ${LABEL[spec.outcome]} ${spec.id}${spec.error ? `: ${spec.error}` : ""}`);
  for (const error of record.errors) console.info(`  ${error}`);
}

// The one reading of whether a run proves a journey, for the move to done and the finish line both: what keeps
// `record` from proving journey `id`, or null when it does. It proves it when the suite ran, has tests tagged
// @journey-<id>, and every one of them passed: a skipped test, or one declared to fail, counts against.
export function unprovenIn(record: SuiteRecord, id: string): string | null {
  const at = record.commit.slice(0, 9);
  if (!record.ran) return `the suite didn't run at ${at} (${notRun(record)}), so journey ${id} isn't proven yet: a6g e2e run once that's fixed`;
  const tagged = record.specs.filter((spec) => journeysOf(spec).includes(id));
  if (!tagged.length) return `no test is tagged @journey-${id} in the suite at ${at}: its specs come first (a test task)`;
  const failing = tagged.filter((spec) => !ok(spec));
  if (!failing.length) return null;
  return `${failing.length} of journey ${id}'s ${tagged.length} tests didn't pass at ${at}: ${failing
    .slice(0, 3)
    .map((spec) => (spec.outcome === "failed" ? spec.title : `${spec.title} (${spec.outcome === "excused" ? "expected to fail" : spec.outcome})`))
    .join("; ")}`;
}

// The run that speaks for a journey: the newest recorded one at a commit holding all its done tasks' merges, whether
// or not that run got to the end. An older pass never stands in for a newer run that didn't.
export function runFor(home: string, journey: Task, all: Task[], history = suiteHistory(home)): SuiteRecord | null {
  const merged = all.filter((t) => t.parent === journey.id && t.status === "done" && t.sha).map((t) => t.sha as string);
  return history.find((record) => merged.every((sha) => contains(home, sha, record.commit))) ?? null;
}

// Why `journey` isn't proven done yet, or null when it is (unprovenIn, of the run that speaks for it). Always null on
// a team whose journeys aren't required.
export function journeyProofFor(home: string, team: Team): (journey: Task, all: Task[]) => string | null {
  return (journey, all) => {
    if (!journeysRequired(home, team)) return null;
    const { harness } = readHarness(home);
    if (!harness?.e2e)
      return `journey ${journey.id} is done once its specs pass, and the team's harness has no suite yet (.a6g/harness.json e2e): that's a test-infra task for the scaffolder`;
    const record = runFor(home, journey, all);
    if (!record) return `no recorded run of the suite holds all of journey ${journey.id}'s merges yet: a6g e2e run, or wait for the merge queue's check`;
    return unprovenIn(record, journey.id);
  };
}

// What keeps the suite from being done, for a6g e2e done and a6g finish: nothing when it passed at the head and every
// journey has passing specs.
export function suiteGaps(home: string, journeys: Task[]): string[] {
  try {
    suiteOf(home);
  } catch (error) {
    return [(error as Error).message];
  }
  const latest = suiteHistory(home)[0];
  const commit = head(home);
  if (!latest) return ["the suite hasn't run: a6g e2e run"];
  const gaps: string[] = [];
  if (latest.commit !== commit) gaps.push(`the last run was at ${latest.commit.slice(0, 9)}, not the head (${commit.slice(0, 9)}): a6g e2e run`);
  if (!latest.ran) return [...gaps, `the last run didn't run: ${notRun(latest)}`];
  for (const error of latest.errors) gaps.push(error);
  const failed = latest.specs.filter((spec) => spec.outcome === "failed");
  if (failed.length)
    gaps.push(
      `${failed.length} tests failed: ${failed
        .slice(0, 5)
        .map((spec) => spec.id)
        .join("; ")}`
    );
  for (const journey of journeys.filter((t) => t.kind === "journey" && t.status !== "rejected")) {
    const unproven = unprovenIn(latest, journey.id);
    if (unproven) gaps.push(`journey ${journey.id} (${journey.title}): ${unproven}`);
  }
  return gaps;
}

async function journeysOfTeam(team: LoadedTeam, run: string, home: string): Promise<Task[]> {
  if (team.board.type !== "tasks") return [];
  const store = await openTeamStore(team, run, home);
  try {
    return (await store.tasks.all()).filter((t) => t.kind === "journey");
  } finally {
    await store.close();
  }
}

// a6g e2e done, for a6g finish too: prints what's missing; 0 when nothing is.
export async function e2eDone(home: string, team: LoadedTeam, run: string): Promise<number> {
  const gaps = suiteGaps(home, await journeysOfTeam(team, run, home));
  if (gaps.length) {
    console.info(`e2e: not done (${gaps.length}):\n${gaps.map((gap) => `- ${gap}`).join("\n")}`);
    return 1;
  }
  console.info("e2e: done: the suite passed at the head, and every journey has specs that passed");
  return 0;
}

export async function e2e(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const [command, ...files] = positional;
  const { home, team, run } = teamSession();
  if (command === "run") {
    // Belt and braces with the guard: results are the planner's (and the merge queue's) to record.
    if (inTeam() && process.env.A6G_ROLE !== "planner") {
      console.error("e2e: the planner records the suite's results; use a6g e2e try to run it yourself");
      return 2;
    }
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: home, encoding: "utf8" }).trim();
    if (branch !== team.branch) {
      console.error(`e2e: results are recorded only on ${team.branch} in the team's checkout; use a6g e2e try for anything else`);
      return 2;
    }
    const record = await recordSuite(home, team);
    console.info(`e2e: at ${record.commit.slice(0, 9)}: ${summary(record)}`);
    printRun(record, { all: true });
    return !record.ran || record.specs.some((spec) => spec.outcome === "failed") || record.errors.length ? 1 : 0;
  }
  if (command === "try") {
    let dir = home;
    try {
      dir = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {}
    const { harness, config, timeoutMin } = suiteOf(dir);
    const appUrl = pagePlan(team, harness).appUrl;
    const base = optionText(options["base"]) ?? appUrl;
    if (!base) {
      console.error("e2e: say where the app runs: --base <url> (the team's is team.json pages.appUrl)");
      return 2;
    }
    const namespace = namespaceOf(dir, team.branchPrefix);
    const go = () =>
      runPlaywright(dir, {
        config,
        args: files,
        env: { PLAYWRIGHT_BASE_URL: base, A6G_NAMESPACE: namespace },
        timeoutMin,
        work: join(tmpdir(), `a6g-e2e-${namespace}-${process.pid}`),
      });
    const shared = appUrl !== undefined && new URL(base).origin === new URL(appUrl).origin;
    const ran = shared ? await holdingApp(home, "e2e try", go) : await go();
    const specs = specsOf(ran.report, dir);
    const errors = ran.report ? (ran.report.errors ?? []).map((error) => scrub(error.message ?? "")).filter(Boolean) : [ran.tail];
    console.info(
      `e2e try (${namespace}, against ${base}): ${tally(specs)}${ran.timedOut ? `, and it ran past ${timeoutMin} minutes and was stopped` : ""}`
    );
    printRun({ specs, errors }, { all: true });
    return ran.status === 0 ? 0 : 1;
  }
  if (command === "status") {
    const latest = suiteHistory(home)[0];
    const journeys = (await journeysOfTeam(team, run, home)).filter((t) => t.status !== "rejected");
    if (!latest) console.info("e2e: the suite hasn't run yet");
    else
      console.info(`e2e: last run at ${latest.commit.slice(0, 9)}${latest.commit === head(home) ? " (the head)" : ""}, ${latest.at}: ${summary(latest)}`);
    for (const journey of journeys) {
      const tagged = latest?.specs.filter((spec) => journeysOf(spec).includes(journey.id)) ?? [];
      const passed = tagged.filter(ok).length;
      console.info(
        `  journey ${journey.id} ${journey.status.padEnd(8)} ${tagged.length ? `${passed}/${tagged.length} tests passed` : "no tests tagged @journey-" + journey.id}  ${journey.title}`
      );
    }
    if (latest) printRun(latest, { all: true });
    return 0;
  }
  if (command === "done") return e2eDone(home, team, run);
  console.error(USAGE);
  return 2;
}
