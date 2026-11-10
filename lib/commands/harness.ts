// The team's harness, as the merge queue and the operator see it.
//
//   a6g harness check            the manifest in this checkout or worktree: does it load, and what's missing (gaps)
//   a6g harness allow <branch> --sha <commit> --why "…"
//                                the operator allows that exact commit of a branch that checks less (Article 5)
//
// And the merge queue's rules for what a branch may do to the checks (lib/commands/merge.ts):
// - a scaffolder's test and test-infra work stays in test and harness files (testLaneProblems): a product change is a
//   builder's task, so nobody changes code to make their own specs pass;
// - a builder's branch changes no file that holds a journey's test (holdsJourneyTest, and the suite's own listing):
//   a journey's proof comes from someone who didn't build it;
// - a branch that checks less merges only with the operator's allowance of its exact commit. That's measured: the
//   suite is listed before the merge and with it (listSuite), and fewer tests that run, in all or for a journey, is
//   less (fewerTests); so is a page or the suite gone from the manifest. What a listing can't see is matched in the
//   suite's own files (narrowingAdded): a skip or an expected failure inside a test, a filter in the configuration.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { namedTest } from "../blast.ts";
import { HARNESS_FILE, narrowing, readHarness } from "../harness.ts";
import { stateDir } from "../paths.ts";
import { asOperator, inTeam, teamSession } from "../session.ts";
import { journeysOf, runPlaywright, scrub, specsOf } from "../suite.ts";
import { die, parseArgs, readJson, text as optionText, writeJson } from "../util.ts";

// What test and test-infra work may change: tests and their folders (fixtures, mocks, seeds), test runners'
// configuration, the suite's set-up files, its environment file and its CI workflow, lockfiles and .gitignore (sign-in
// states, reports), the manifest, a package.json's test dependencies and test scripts (packageOutside), and whatever
// the operator adds (team.json harness.lane).
const TEST_FOLDER = /(^|\/)(e2e|tests?|__tests__|__mocks__|__fixtures__|spec|specs|playwright|cypress|fixtures?|mocks?|msw|seeds?|test-utils|testing)\//;
// An app's own routes: a folder under them named like a test folder is a page of the app (app/test/page.tsx).
const ROUTES = /(^|\/)(app|pages|routes)\//;
const RUNNER_CONFIG =
  /(^|\/)(playwright|vitest|jest|cypress|knip)\.config\.[cm]?[jt]s$|(^|\/)knip\.jsonc?$|(^|\/)tsconfig\.(e2e|tests?|spec|playwright|vitest|jest|cypress)\.json$/;
const SUPPORT =
  /(^|\/)global[-.]?(setup|teardown)\.[cm]?[jt]s$|(^|\/)\.env\.(test|e2e)(\.example)?$|(^|\/)seeds?(\.[\w-]+)?\.([cm]?[jt]s|sql)$|^\.github\/workflows\/[\w.-]*(e2e|playwright|tests?)[\w.-]*\.ya?ml$|(^|\/)\.gitignore$/;
const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.npmrc)$/;
const PACKAGE = /(^|\/)package\.json$/;
export function inTestFolder(path: string): boolean {
  const at = path.search(TEST_FOLDER);
  return at >= 0 && !ROUTES.test(path.slice(0, at + 1));
}
// By its path alone: a package.json is in the lane, and testLaneProblems reads what changed in it.
export const inTestLane = (path: string, lane: RegExp[] = []): boolean =>
  namedTest(path) ||
  inTestFolder(path) ||
  RUNNER_CONFIG.test(path) ||
  SUPPORT.test(path) ||
  LOCKFILES.test(path) ||
  PACKAGE.test(path) ||
  path === HARNESS_FILE ||
  lane.some((rule) => rule.test(path));

// A script that runs or serves the tests, by its name: test, test:e2e, e2e:ui, pretest, db:seed, start:test.
const TEST_SCRIPT = /^(pre|post)?(tests?|e2e|playwright|pw|cypress|vitest|jest|coverage|seeds?|mocks?)$/;
const testScript = (name: string): boolean => name.split(/[:._-]/).some((part) => TEST_SCRIPT.test(part));
// What a package.json changes beyond its test dependencies and test scripts, by key: a dependency the product ships
// with, a build or install script, what the package exports.
export function packageOutside(before: string | null, after: string | null): string[] {
  const read = (text: string | null): Record<string, unknown> | null => {
    if (text === null) return {};
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const [was, now] = [read(before), read(after)];
  if (!was || !now) return ["not JSON"];
  if (after === null) return ["removed"];
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const scripts = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const found: string[] = [];
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (key === "devDependencies" || same(was[key], now[key])) continue;
    if (key !== "scripts") {
      found.push(key);
      continue;
    }
    const [old, next] = [scripts(was.scripts), scripts(now.scripts)];
    for (const name of new Set([...Object.keys(old), ...Object.keys(next)]))
      if (!same(old[name], next[name]) && !testScript(name)) found.push(`scripts.${name}`);
  }
  return found;
}

// The paths a branch of test or test-infra work changes outside the test lane. `versions` gives a package.json's text
// before and on the branch, so it's judged by what changed in it; one in a test folder is the suite's own.
export function testLaneProblems(
  changed: string[],
  lane: RegExp[] = [],
  versions?: (path: string) => { before: string | null; after: string | null }
): string[] {
  return changed.flatMap((path) => {
    if (!inTestLane(path, lane)) return [path];
    if (!versions || !PACKAGE.test(path) || inTestFolder(path) || lane.some((rule) => rule.test(path))) return [];
    const { before, after } = versions(path);
    const outside = packageOutside(before, after);
    return outside.length ? [`${path} (${outside.slice(0, 4).join(", ")}: test work changes its devDependencies and test scripts only)`] : [];
  });
}

// Source files the rules below read.
export const CODE = /\.[cm]?[jt]sx?$/;
// What a file mentions when it could be one of the suite's: `git grep` finds these before any file is read.
export const SUITE_MENTIONS = ["@journey-", "playwright/test"];
const RUNNER_IMPORT = /["'](?:@playwright\/test|playwright\/test)["']/;
export const importsRunner = (text: string | null): boolean => text !== null && RUNNER_IMPORT.test(text);
// Whether a file holds a journey's test, by its text: it names a journey's tag, and it's a test (by its name or
// folder, or because it imports Playwright's test runner). Judged by the whole file, not by which lines a branch
// changed: a test gutted with its tag left alone is still a journey's proof made by whoever changed it.
export const holdsJourneyTest = (path: string, text: string | null): boolean =>
  text !== null && text.includes("@journey-") && (namedTest(path) || inTestFolder(path) || importsRunner(text));

// A source text without its comments. Strings stay as they are, so a glob ("**/*.spec.ts") starts no comment.
export function withoutComments(text: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === quote || (c === "\n" && quote !== "`")) quote = "";
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      // A comment's line breaks stay, so the lines after it keep their place.
      out += text.slice(i, end < 0 ? text.length : end).replace(/[^\n]/g, "");
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out;
}

// What runs fewer of the suite's tests, or forgives one, that a listing can't see or that's cheap to refuse early: a
// skip, fixme or .only, an expected failure, a filter in the configuration. Not retries: a recorded run sets its own.
const NARROWS = /\.(skip|fixme|only)\s*\(|\b(test|testInfo|info\(\))\.fail\s*\(|\b(testIgnore|grepInvert|grep)\s*:/;
const narrowsIn = (text: string | null): string[] =>
  text === null
    ? []
    : withoutComments(text)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => NARROWS.test(line));
// The narrowing lines a branch adds to the suite's files (those that import Playwright's test runner, the manifest's
// configuration, and the files a listing names), net of the same lines it takes away: a file that only moved, or a
// skip that only changed files, adds nothing.
export function narrowingAdded(files: { path: string; before: string | null; after: string | null }[]): string[] {
  const had = new Map<string, number>();
  for (const file of files) for (const line of narrowsIn(file.before)) had.set(line, (had.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const file of files)
    for (const line of narrowsIn(file.after)) {
      const left = had.get(line) ?? 0;
      if (left > 0) had.set(line, left - 1);
      else added.push(`${file.path}: ${line.slice(0, 100)}`);
    }
  return added;
}

// What a branch's manifest checks less than the integration branch's.
export const manifestNarrowing = (home: string, integration: string, tip: string): string[] =>
  narrowing(readHarness(home, integration).harness, readHarness(home, tip).harness);

// The suite as `playwright test --list` gives it in `dir` (the merge's scratch worktree, before the merge and with
// it): the tests that would run (declared without skip, fixme or fail), in all and per journey, and the files they're
// in. A string says why it can't be listed there. A .only is refused, so it can't shorten a listing.
export interface Listing {
  total: number;
  byJourney: Record<string, number>;
  files: string[];
  journeyFiles: string[];
}
export async function listSuite(dir: string, config: string, work: string): Promise<Listing | string> {
  if (!existsSync(join(dir, config))) return `there's no ${config}`;
  const listed = await runPlaywright(dir, { config, args: ["--list", "--forbid-only", "--pass-with-no-tests"], timeoutMin: 3, work });
  if (listed.timedOut) return "listing its tests ran past 3 minutes";
  const error = (listed.report?.errors ?? []).find((e) => e.message)?.message;
  if (!listed.report || error) return scrub(error ?? listed.tail) || "it wrote no listing";
  const specs = specsOf(listed.report, dir);
  const byJourney: Record<string, number> = {};
  for (const spec of specs) if (spec.outcome === "listed") for (const id of journeysOf(spec)) byJourney[id] = (byJourney[id] ?? 0) + 1;
  return {
    total: specs.filter((spec) => spec.outcome === "listed").length,
    byJourney,
    files: [...new Set(specs.map((spec) => spec.file))],
    journeyFiles: [...new Set(specs.filter((spec) => journeysOf(spec).length).map((spec) => spec.file))],
  };
}
export function fewerTests(before: Pick<Listing, "total" | "byJourney">, after: Pick<Listing, "total" | "byJourney">): string[] {
  const found: string[] = [];
  if (after.total < before.total) found.push(`the suite runs ${after.total} tests, ${before.total - after.total} fewer than before`);
  for (const [id, count] of Object.entries(before.byJourney))
    if ((after.byJourney[id] ?? 0) < count) found.push(`journey ${id} has ${after.byJourney[id] ?? 0} tests that run, not ${count}`);
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
