// Running a repository's own Playwright: its end-to-end suite (a6g e2e) and the project that signs in (a6g pages). The
// factory runs it itself, never a command from the manifest: `playwright test --config <the manifest's config>`, with
// the JSON report written to a file (so nothing the suite prints gets mixed into it), the base URL and a namespace for
// the run's data in the environment, and its output folder outside the checkout, so a run never leaves it dirty.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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
  suites?: ReportSuite[];
  errors?: { message?: string }[];
}

// Runs `playwright test --config <config> [args…]` in `dir`. `env` adds to the environment (the base URL, the
// namespace); `work` is where the report and Playwright's output go, outside the checkout.
export function runPlaywright(
  dir: string,
  { config, args = [], env = {}, timeoutMin, work }: { config: string; args?: string[]; env?: Record<string, string>; timeoutMin: number; work: string }
): SuiteRun {
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
  const result = spawnSync(process.execPath, [cli, "test", "--config", config, "--reporter=json", "--output", join(work, "output"), ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: timeoutMin * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile, CI: "1", FORCE_COLOR: "0" },
  });
  const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  let report: Report | null = null;
  try {
    report = existsSync(reportFile) ? (JSON.parse(readFileSync(reportFile, "utf8")) as Report) : null;
  } catch {}
  const printed = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n");
  return { status: timedOut ? null : result.status, timedOut, report, tail: printed.slice(-12).join("\n") };
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

// Every test in a report, once per project. A listing (--list) has no results: each test is "listed".
export function specsOf(report: Report | null): SpecResult[] {
  const found: SpecResult[] = [];
  const walk = (suite: ReportSuite, titles: string[], file: string): void => {
    const here = suite.file ?? file;
    const path = suite.title && suite.title !== here ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? here;
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

// The first line of an error, without colour codes, and without anything that looks like a secret's value.
export function scrub(text: string): string {
  const line =
    text
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  return line.replace(/\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)=\S+/gi, "$1=…").slice(0, 300);
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
