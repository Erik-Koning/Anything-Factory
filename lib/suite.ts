// Running a repository's own Playwright: its end-to-end suite (a6g e2e) and the project that signs in (a6g pages). The
// factory runs it itself, never a command from the manifest: `playwright test --config <the manifest's config>`, with
// the JSON report written to a file (so nothing the suite prints gets mixed into it), the base URL and a namespace for
// the run's data in the environment, and its output folder outside the checkout, so a run never leaves it dirty.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { readJson } from "./util.ts";

// The repository's Playwright command-line entry, or null when it has none installed: the nearest node_modules from
// `from` (the configuration's folder) upward, as Node finds it. So a monorepo's apps/web/node_modules is found before
// the root's, and from the merge's scratch worktree (inside the checkout) the checkout's own.
export function playwrightCli(from: string): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const name of ["@playwright/test", "playwright"]) {
      const cli = join(dir, "node_modules", name, "cli.js");
      if (existsSync(cli)) return cli;
    }
    if (dirname(dir) === dir) return null;
  }
}

export interface SuiteRun {
  // The command's exit, null when it was stopped (timedOut).
  status: number | null;
  // It ran past its limit, and everything it started was ended.
  timedOut: boolean;
  report: Report | null;
  // The last lines it printed, for a run with no report.
  tail: string;
}
interface ReportResult {
  status?: string;
  retry?: number;
  error?: { message?: string };
}
interface ReportTest {
  projectName?: string;
  // How it went against what was expected: expected, unexpected, flaky or skipped.
  status?: string;
  // What the test declared: passed, or failed (test.fail, test.info().fail()) or skipped.
  expectedStatus?: string;
  // What it was marked with where it's declared (fail, skip, fixme, slow): all a listing knows of it.
  annotations?: { type?: string }[];
  results?: ReportResult[];
}
interface ReportSpec {
  title: string;
  file?: string;
  line?: number;
  tags?: string[];
  tests?: ReportTest[];
}
interface ReportSuite {
  title?: string;
  file?: string;
  specs?: ReportSpec[];
  suites?: ReportSuite[];
}
export interface Report {
  config?: { rootDir?: string };
  suites?: ReportSuite[];
  errors?: { message?: string }[];
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// Runs `playwright test --config <config> [args…]` in `dir`. `env` adds to the environment (the base URL, the
// namespace); `work` is where the report and Playwright's output go, outside the checkout. Asynchronous, so a process
// that serves something itself (a test's own app) keeps answering while it runs.
//
// The time limit is a limit: the suite runs in a process group of its own, and past `timeoutMin` the whole group is
// asked to stop, ended `graceMs` later, and no longer waited for half as long again after that, whatever is left.
// Whenever the run ends, so does the rest of its group, and a process that left the group and still holds the output
// open (a server started for good) isn't waited for.
export async function runPlaywright(
  dir: string,
  {
    config,
    args = [],
    env = {},
    timeoutMin,
    work,
    graceMs = 10_000,
  }: { config: string; args?: string[]; env?: Record<string, string>; timeoutMin: number; work: string; graceMs?: number }
): Promise<SuiteRun> {
  const cli = playwrightCli(configDir(dir, config));
  if (!cli)
    return {
      status: 2,
      timedOut: false,
      report: null,
      tail: `no Playwright (@playwright/test) in a node_modules from ${configDir(dir, config)} up: install the repository's dependencies`,
    };
  mkdirSync(work, { recursive: true });
  const reportFile = join(work, "report.json");
  rmSync(reportFile, { force: true });
  const child = spawn(process.execPath, [cli, "test", "--config", config, "--reporter=json", "--output", join(work, "output"), ...args], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile, CI: "1", FORCE_COLOR: "0" },
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {}
  };
  // A group of its own doesn't hear the terminal's Ctrl-C, or a signal sent to this process: pass it on, and go.
  const passOn = (signal: NodeJS.Signals): void => {
    signalGroup(signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  for (const signal of SIGNALS) process.on(signal, passOn);
  let printed = "";
  const keep = (chunk: Buffer) => {
    printed = (printed + chunk.toString()).slice(-8000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let timedOut = false;
  const timers: NodeJS.Timeout[] = [];
  const status = await new Promise<number | null>((done) => {
    child.on("error", () => done(1));
    child.on("close", (code) => done(code));
    // Its output can stay open after it has gone (something it started holds it): what it printed is in by then.
    child.on("exit", (code) => timers.push(setTimeout(() => done(code), 1000)));
    timers.push(
      setTimeout(() => {
        timedOut = true;
        signalGroup("SIGTERM");
        timers.push(setTimeout(() => signalGroup("SIGKILL"), graceMs));
        timers.push(setTimeout(() => done(null), graceMs * 1.5));
      }, timeoutMin * 60_000)
    );
  });
  for (const timer of timers) clearTimeout(timer);
  for (const signal of SIGNALS) process.off(signal, passOn);
  // Nothing the run started in its group outlives it: what a test left running, or what ignored the limit's request.
  signalGroup("SIGKILL");
  // Whatever outlived the group's end keeps nothing of ours open.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  let report: Report | null = null;
  try {
    report = existsSync(reportFile) ? (JSON.parse(readFileSync(reportFile, "utf8")) as Report) : null;
  } catch {}
  return { status: timedOut ? null : status, timedOut, report, tail: printed.trim().split("\n").slice(-12).join("\n") };
}

// How a test went. `excused` is one declared to fail (test.fail, test.info().fail()) that did: Playwright calls that
// expected, and it proves nothing. `flaky` passed on a retry. `skipped` was told to skip, wherever that was said (its
// declaration, its body, a hook). `unreached` wasn't told to and didn't run: an earlier test of its group failed, or
// the run stopped at its failure limit. `listed` has no result (a listing, or a run that never got to it).
export type Outcome = "passed" | "failed" | "flaky" | "skipped" | "excused" | "unreached" | "listed";
export interface SpecResult {
  // file › describe › title [project]: the same test across runs.
  id: string;
  file: string;
  title: string;
  project: string;
  tags: string[];
  outcome: Outcome;
  // The first line of the first failure, for a finding.
  error?: string;
}

// Every test in a report, once per project. A listing (--list) has no results: each test is "listed". With the
// repository's folder (`dir`), files are named from its root (e2e/pay.spec.ts), not from the suite's own folder.
export function specsOf(report: Report | null, dir?: string): SpecResult[] {
  const found: SpecResult[] = [];
  const root = report?.config?.rootDir;
  const named = (file: string): string => (dir && root && file ? relative(dir, join(root, file)) || file : file);
  const walk = (suite: ReportSuite, titles: string[], file: string): void => {
    const here = suite.file ?? file;
    const path = suite.title && suite.title !== here ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      const specFile = named(spec.file ?? here);
      for (const test of spec.tests?.length ? spec.tests : [{} as ReportTest]) {
        const outcome = outcomeOf(test);
        const error = (test.results ?? []).find((r) => r.error?.message)?.error?.message;
        const project = test.projectName ?? "";
        const title = [...path, spec.title].join(" › ");
        found.push({
          id: `${specFile} › ${title}${project ? ` [${project}]` : ""}`,
          file: specFile,
          title,
          project,
          tags: (spec.tags ?? []).map((tag) => (tag.startsWith("@") ? tag : `@${tag}`)),
          outcome,
          ...(error ? { error: scrub(error) } : {}),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, path, here);
  };
  for (const suite of report?.suites ?? []) walk(suite, [], suite.file ?? "");
  return found;
}

// A test's outcome from Playwright's own account of it: how it went (status) against what it declared
// (expectedStatus), so a test that was told to fail or skip never reads as a pass, however that was spelled. With no
// result (a listing), what it's declared with is all there is: skipped, expected to fail, or just listed.
function outcomeOf({ status, expectedStatus: expected, annotations = [], results = [] }: ReportTest): Outcome {
  if (expected === "skipped") return "skipped";
  if (!results.length) return annotations.some((a) => a.type === "fail") ? "excused" : "listed";
  if (status === "skipped") return "unreached";
  if (status === "unexpected") return "failed";
  if (expected === "failed") return "excused";
  if (status === "flaky") return "flaky";
  return status === "expected" ? "passed" : "failed";
}

// Whether a report holds a result for any test: the run got as far as running one.
export function reachedTests(report: Report | null): boolean {
  const any = (suite: ReportSuite): boolean =>
    (suite.specs ?? []).some((spec) => (spec.tests ?? []).some((test) => (test.results ?? []).length > 0)) || (suite.suites ?? []).some(any);
  return (report?.suites ?? []).some(any);
}

// A test's journeys, by tag: exactly @journey-<id> (so @journey-1 isn't @journey-12).
export const journeysOf = (spec: Pick<SpecResult, "tags">): string[] => spec.tags.flatMap((tag) => /^@journey-(\d+)$/.exec(tag)?.[1] ?? []);

// The first lines of an error (what failed, and the locator or values it names), without colour codes, and without
// anything that looks like a secret's value.
export function scrub(text: string): string {
  const lines = text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3);
  return lines
    .join(" · ")
    .replace(/\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)=\S+/gi, "$1=…")
    .slice(0, 300);
}

// Why a run left no report, from the last of what it printed: without a stack's frames, which say where Playwright
// was and not what went wrong.
export function lastSaid(tail: string): string {
  const lines = tail.split("\n").filter((line) => line.trim());
  const said = lines.filter((line) => !/^\s*at\s/.test(line));
  return scrub((said.length ? said : lines).slice(-3).join("\n"));
}

// A test that found no browser says nothing about the app. The repository's Playwright asks for the browser build of
// its own version, and the factory installs only its own's: what's missing and what downloads it, or null when every
// test that asked for a browser had one.
export function browserMissing(specs: Pick<SpecResult, "error">[]): string | null {
  const error = specs.map((spec) => spec.error ?? "").find((text) => /Executable doesn't exist at /.test(text));
  if (error === undefined) return null;
  const build = /Executable doesn't exist at \S*?\/([\w.]+-\d+)\//.exec(error)?.[1];
  return `the repository's Playwright has no browser to run${build ? ` (${build.replaceAll("_", " ")})` : ""}: npx playwright install, run where the suite's configuration is, downloads the build its version asks for`;
}

// The config's folder holds the suite: a run's report file names tests relative to it.
export const configDir = (dir: string, config: string): string => dirname(join(dir, config));

// A saved run of the suite (a6g e2e run, and the merge queue's check), kept in the run folder's state.
export interface SuiteRecord {
  commit: string;
  at: string;
  // Whether the suite ran: it wrote a report, inside its time limit, with a result for at least one test, and its
  // tests had their browser. A run that didn't proves nothing and disproves nothing: no journey is proven by it, and
  // none of its tests failed.
  ran: boolean;
  timedOut: boolean;
  status: number | null;
  specs: SpecResult[];
  // What went wrong outside any test (the config didn't load, the app didn't answer).
  errors: string[];
}
export const passed = (spec: Pick<SpecResult, "outcome">): boolean => spec.outcome === "passed" || spec.outcome === "flaky";
// A test that's there to check something: every one but those told to skip or to fail. One a run didn't reach still is.
export const checks = (spec: Pick<SpecResult, "outcome">): boolean => spec.outcome !== "skipped" && spec.outcome !== "excused";
export const readSuiteRecord = (file: string): SuiteRecord | null => readJson<SuiteRecord | null>(file, null);
