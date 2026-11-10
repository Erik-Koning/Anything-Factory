// Running a repository's own Playwright: its end-to-end suite (a6g e2e) and the project that signs in (a6g pages). The
// factory runs it itself, never a command from the manifest: `playwright test --config <the manifest's config>`, with
// the JSON report written to a file (so nothing the suite prints gets mixed into it), the base URL and a namespace for
// the run's data in the environment, and its output folder outside the checkout, so a run never leaves it dirty.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readJson } from "./util.ts";

// The repository's Playwright command-line entry, or null when it has none installed.
export function playwrightCli(dir: string): string | null {
  for (const name of ["@playwright/test", "playwright"]) {
    const cli = join(dir, "node_modules", name, "cli.js");
    if (existsSync(cli)) return cli;
  }
  return null;
}

export interface SuiteRun {
  // The command's exit, null when it was stopped (timedOut).
  status: number | null;
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
  status?: string;
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

// Runs `playwright test --config <config> [args…]` in `dir`. `env` adds to the environment (the base URL, the
// namespace); `work` is where the report and Playwright's output go, outside the checkout. Asynchronous, so a process
// that serves something itself (a test's own app) keeps answering while it runs.
export async function runPlaywright(
  dir: string,
  { config, args = [], env = {}, timeoutMin, work }: { config: string; args?: string[]; env?: Record<string, string>; timeoutMin: number; work: string }
): Promise<SuiteRun> {
  const cli = playwrightCli(dir);
  if (!cli)
    return {
      status: 2,
      timedOut: false,
      report: null,
      tail: `no Playwright in ${dir}/node_modules (@playwright/test): install the repository's dependencies`,
    };
  mkdirSync(work, { recursive: true });
  const reportFile = join(work, "report.json");
  rmSync(reportFile, { force: true });
  const child = spawn(process.execPath, [cli, "test", "--config", config, "--reporter=json", "--output", join(work, "output"), ...args], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile, CI: "1", FORCE_COLOR: "0" },
  });
  let printed = "";
  const keep = (chunk: Buffer) => {
    printed = (printed + chunk.toString()).slice(-8000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, timeoutMin * 60_000);
  const status = await new Promise<number | null>((done) => {
    child.on("error", () => done(1));
    child.on("close", (code) => done(code));
  });
  clearTimeout(timer);
  let report: Report | null = null;
  try {
    report = existsSync(reportFile) ? (JSON.parse(readFileSync(reportFile, "utf8")) as Report) : null;
  } catch {}
  return { status: timedOut ? null : status, timedOut, report, tail: printed.trim().split("\n").slice(-12).join("\n") };
}

export type Outcome = "passed" | "failed" | "flaky" | "skipped" | "listed";
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
      for (const test of spec.tests?.length ? spec.tests : [{}]) {
        const results = test.results ?? [];
        const status = test.status;
        const outcome: Outcome = !results.length
          ? status === "skipped"
            ? "skipped"
            : "listed"
          : status === "flaky"
            ? "flaky"
            : status === "skipped"
              ? "skipped"
              : status === "expected"
                ? "passed"
                : "failed";
        const error = results.find((r) => r.error?.message)?.error?.message;
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

// The config's folder holds the suite: a run's report file names tests relative to it.
export const configDir = (dir: string, config: string): string => dirname(join(dir, config));

// A saved run of the suite (a6g e2e run, and the merge queue's check), kept in the run folder's state.
export interface SuiteRecord {
  commit: string;
  at: string;
  timedOut: boolean;
  status: number | null;
  specs: SpecResult[];
  // What went wrong outside any test (the config didn't load, the app didn't answer).
  errors: string[];
}
export const readSuiteRecord = (file: string): SuiteRecord | null => readJson<SuiteRecord | null>(file, null);
