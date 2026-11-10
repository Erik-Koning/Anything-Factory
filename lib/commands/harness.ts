// The team's harness, as the merge queue and the operator see it.
//
//   a6g harness check            the manifest in this checkout or worktree: does it load, and what's missing (gaps)
//   a6g harness allow <branch> --sha <commit> --why "…"
//                                the operator allows that exact commit of a branch that checks less (Article 5)
//
// And the merge queue's rules for what a branch may do to the checks (lib/commands/merge.ts):
// - a scaffolder's test and test-infra work stays in test and harness files (testLaneProblems): a product change is a
//   builder's task, so nobody changes code to make their own specs pass;
// - a builder's branch adds or changes no @journey- tag (journeyTagProblems): a journey's proof comes from someone who
//   didn't build it;
// - a branch that checks less (narrowing): a page or the suite gone from the manifest, a test skipped, filtered,
//   retried or ignored, or fewer tests than before, merges only with the operator's allowance of its exact commit.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTest } from "../blast.ts";
import { HARNESS_FILE, narrowing, readHarness } from "../harness.ts";
import { stateDir } from "../paths.ts";
import { asOperator, inTeam, teamSession } from "../session.ts";
import { journeysOf, runPlaywright, specsOf } from "../suite.ts";
import { die, parseArgs, readJson, text as optionText, writeJson } from "../util.ts";

// What test and test-infra work may change: tests and their folders, test runners' configuration, fixtures, package
// manifests and lockfiles (a test dependency), .gitignore (sign-in states, reports) and the manifest.
const TEST_FOLDER = /(^|\/)(e2e|tests?|__tests__|spec|specs|playwright|cypress|fixtures?|test-utils|testing)\//;
const RUNNER_CONFIG = /(^|\/)(playwright|vitest|jest|cypress|knip)\.config\.[cm]?[jt]s$|(^|\/)knip\.jsonc?$/;
const PACKAGES = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.npmrc)$/;
export const inTestLane = (path: string): boolean =>
  isTest(path) || TEST_FOLDER.test(path) || RUNNER_CONFIG.test(path) || PACKAGES.test(path) || /(^|\/)\.gitignore$/.test(path) || path === HARNESS_FILE;

// The paths a branch of test or test-infra work changes outside the test lane.
export const testLaneProblems = (changed: string[]): string[] => changed.filter((path) => !inTestLane(path));

// A diff's added and removed lines, by file.
export function diffLines(diff: string): { path: string; sign: "+" | "-"; text: string }[] {
  const found: { path: string; sign: "+" | "-"; text: string }[] = [];
  let path = "";
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ (?:b\/)?(.*)$/.exec(line) ?? /^--- (?:a\/)?(.*)$/.exec(line);
    if (header) {
      if (header[1] !== "/dev/null" && (line.startsWith("+++") || !path)) path = header[1] ?? "";
      continue;
    }
    if (line.startsWith("diff --git ")) {
      path = /^diff --git a\/(.*) b\//.exec(line)?.[1] ?? "";
      continue;
    }
    if ((line.startsWith("+") || line.startsWith("-")) && path) found.push({ path, sign: line[0] as "+" | "-", text: line.slice(1) });
  }
  return found;
}

const JOURNEY_TAG = /@journey-\d+/;
// A builder's branch that adds, changes or removes a journey's tag.
export const journeyTagProblems = (diff: string): string[] => [
  ...new Set(
    diffLines(diff)
      .filter((line) => JOURNEY_TAG.test(line.text))
      .map((line) => line.path)
  ),
];

// Added lines that run fewer tests, or forgive them: in tests and their runners' configuration.
const NARROWS = /\.(skip|fixme|only)\s*\(|\btest\.fail\s*\(|\b(testIgnore|grepInvert|grep)\s*:|\bretries\s*:(?!\s*0\b)/;
export function narrowingLines(diff: string): string[] {
  return diffLines(diff)
    .filter((line) => line.sign === "+" && (isTest(line.path) || TEST_FOLDER.test(line.path) || RUNNER_CONFIG.test(line.path)) && NARROWS.test(line.text))
    .map((line) => `${line.path}: ${line.text.trim().slice(0, 100)}`);
}

// What a branch's manifest checks less than the integration branch's.
export const manifestNarrowing = (home: string, integration: string, tip: string): string[] =>
  narrowing(readHarness(home, integration).harness, readHarness(home, tip).harness);

// How many tests the suite has, in all and per journey, as `playwright test --list` says in `dir` (the team's checkout,
// or the merge's scratch worktree). Null when it can't be listed there.
export async function suiteCounts(dir: string, config: string, work: string): Promise<{ total: number; byJourney: Record<string, number> } | null> {
  if (!existsSync(join(dir, config))) return null;
  const listed = await runPlaywright(dir, { config, args: ["--list"], timeoutMin: 3, work });
  if (!listed.report) return null;
  const specs = specsOf(listed.report);
  const byJourney: Record<string, number> = {};
  for (const spec of specs) for (const id of journeysOf(spec)) byJourney[id] = (byJourney[id] ?? 0) + 1;
  return { total: specs.length, byJourney };
}
export function fewerTests(
  before: { total: number; byJourney: Record<string, number> },
  after: { total: number; byJourney: Record<string, number> }
): string[] {
  const found: string[] = [];
  if (after.total < before.total) found.push(`the suite has ${after.total} tests, ${before.total - after.total} fewer than before`);
  for (const [id, count] of Object.entries(before.byJourney))
    if ((after.byJourney[id] ?? 0) < count) found.push(`journey ${id} has ${after.byJourney[id] ?? 0} tests, not ${count}`);
  return found;
}

// The operator's allowance of a commit that checks less: state/harness-allow/<branch>.json.
interface Allowance {
  branch: string;
  sha: string;
  why: string;
  at: string;
}
const allowanceFile = (state: string, branch: string): string => join(state, "harness-allow", `${branch.replaceAll("/", "_")}.json`);
export const allowed = (state: string, branch: string, tip: string): Allowance | null => {
  const record = readJson<Allowance | null>(allowanceFile(state, branch), null);
  return record?.sha === tip ? record : null;
};

export async function harness(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const [command, branch] = positional;
  if (command === "allow") {
    // The operator's call (Article 5); the guard refuses it to every agent too.
    if (inTeam() && !asOperator()) {
      console.error("harness allow: allowing a branch that checks less is the operator's call");
      return 2;
    }
    const { home } = teamSession();
    const sha = optionText(options["sha"]);
    const why = optionText(options["why"]);
    if (!branch || !sha || !/^[0-9a-f]{7,64}$/i.test(sha) || !why)
      die('usage: a6g harness allow <branch> --sha <the commit> --why "<why it may check less>"');
    const { spawnSync } = await import("node:child_process");
    const full = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { cwd: home, encoding: "utf8" }).stdout.trim();
    if (!full) die(`${sha} isn't a commit in ${home}`);
    writeJson(allowanceFile(stateDir(home), branch), { branch, sha: full, why, at: new Date().toISOString() } satisfies Allowance);
    console.info(`harness: ${branch} at ${full.slice(0, 9)} may check less (${why}); queue its merge again`);
    return 0;
  }
  if (command === "check") {
    const { home } = teamSession();
    let dir = home;
    try {
      const { execFileSync } = await import("node:child_process");
      dir = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {}
    const { harness: manifest, problems } = readHarness(dir);
    for (const problem of problems) console.info(`FAIL  ${problem}`);
    if (!manifest && !problems.length) console.info(`harness: there's no ${HARNESS_FILE} in ${dir} yet`);
    else if (manifest && !problems.length)
      console.info(
        `harness: ${HARNESS_FILE} loads: ${manifest.pages.length} pages${manifest.e2e ? `, the suite in ${manifest.e2e.config}` : ", no suite"}${manifest.auth ? `, sign-ins ${Object.keys(manifest.auth.states).join(", ")}` : ""}`
      );
    return problems.length ? 1 : 0;
  }
  console.error('usage: a6g harness check | allow <branch> --sha <commit> --why "…"');
  return 2;
}
