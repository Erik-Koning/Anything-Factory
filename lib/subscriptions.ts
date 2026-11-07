// The Claude subscriptions the factory's teams run on, and how much of each one's weekly limit is used, as Claude Code
// reports it: `claude -p /usage`, whose stream-json output carries its documented usage report (a local command: no
// model, nothing used). With what this machine used in the same week, every session's (lib/usage.ts collectHours: the
// operator's own count against the same limit), that says what one subscription's week comes to in API-equivalent
// dollars, so a budget can be a share of a subscription (tasks/controls.ts Limits, unit "subscription"): over 100% for
// a team that runs on more than one. The weekly limit across all models is the one measured; a model's own weekly
// limit (Fable's, on some plans) is reported, not budgeted.
//
// Accounts: ~/.a6g/subscriptions.json, [{ name, configDir }]; with none listed, this Mac's own Claude Code login
// (~/.claude). Another account has a Claude Code config folder of its own (CLAUDE_CONFIG_DIR), as Claude Code's docs
// say to run several. Readings and estimates: ~/.a6g/subscriptions/state.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { A6G_HOME } from "./paths.ts";
import { round } from "./tasks/spend.ts";
import { allTranscriptDirs, collectHours } from "./usage.ts";
import { readJson, writeJson } from "./util.ts";

export interface Account {
  name: string;
  // Its Claude Code config folder, or null for this Mac's own login.
  configDir: string | null;
}

// What an account's usage report said, and what this machine used since its week began.
export interface Reading {
  account: string;
  at: string;
  // Of the weekly limit across all models, 0 to 100.
  percent: number;
  resetsAt: string;
  // Limits of one model's own (Fable's), for the record.
  scoped: { model: string; percent: number }[];
  // API-equivalent dollars this machine used since the week began.
  spent: number;
}

export interface SubscriptionState {
  readings: Record<string, Reading>;
  // One subscription's week in API-equivalent dollars, estimated from each reading that said enough.
  estimates: { at: string; account: string; dollars: number }[];
  // The estimate in use: the median of the newest, or null before there's one.
  week: number | null;
}

const SUBS = join(A6G_HOME, "subscriptions");
const accountsFile = join(A6G_HOME, "subscriptions.json");
const stateFile = join(SUBS, "state.json");
// A reading needs this much of the week used, and this much spent, to say what a week comes to: the report gives
// whole percents, and a little use says little.
const MIN_PERCENT = 5;
const MIN_SPENT = 1;
const KEEP = 12;

export const accounts = (): Account[] => {
  const listed = readJson<Account[]>(accountsFile, []);
  return listed.length ? listed : [{ name: "default", configDir: null }];
};
export const setAccounts = (list: Account[]): void => writeJson(accountsFile, list);
export const subscriptionState = (): SubscriptionState => readJson<SubscriptionState>(stateFile, { readings: {}, estimates: [], week: null });

interface ReportLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: { display_name?: string } } | null;
}

// The weekly limits in `claude -p /usage --output-format stream-json` output: null when there's no usage report, or it
// has no rate limits (an API key, or a token without the scope to read them).
export function parseUsageReport(output: string): Pick<Reading, "percent" | "resetsAt" | "scoped"> | null {
  for (const raw of output.split("\n")) {
    let line: { usage_report?: { rate_limits?: { limits?: ReportLimit[] } | null } };
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const limits = line.usage_report?.rate_limits?.limits;
    if (!limits) continue;
    const all = limits.find((l) => l.kind === "weekly_all");
    if (typeof all?.percent !== "number" || !all.resets_at) return null;
    return {
      percent: all.percent,
      resetsAt: new Date(all.resets_at).toISOString(),
      scoped: limits
        .filter((l) => l.kind === "weekly_scoped" && typeof l.percent === "number")
        .map((l) => ({ model: l.scope?.model?.display_name ?? "a model", percent: l.percent ?? 0 })),
    };
  }
  return null;
}

// Asks the account's Claude Code for its usage report, from a folder of the factory's own (its transcript there costs
// nothing, and belongs to no team). Null when it can't say.
export function readUsage(account: Account): Pick<Reading, "percent" | "resetsAt" | "scoped"> | null {
  const cwd = join(SUBS, "probe");
  mkdirSync(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (account.configDir) env["CLAUDE_CONFIG_DIR"] = account.configDir;
  const run = spawnSync("claude", ["-p", "/usage", "--output-format", "stream-json", "--verbose"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 90_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return run.status === 0 ? parseUsageReport(run.stdout) : null;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

// Folds a reading into the state: what this machine spent since that week began, and, when the reading says enough,
// an estimate of one subscription's week; the estimate in use is the median of the newest.
export function withReading(
  state: SubscriptionState,
  account: string,
  report: Pick<Reading, "percent" | "resetsAt" | "scoped">,
  hours: Record<string, number>,
  now = new Date()
): SubscriptionState {
  const weekBegan = new Date(Date.parse(report.resetsAt) - 7 * 86_400_000).toISOString().slice(0, 13);
  const spent = round(Object.entries(hours).reduce((sum, [hour, dollars]) => (hour >= weekBegan ? sum + dollars : sum), 0));
  const reading: Reading = { account, at: now.toISOString(), ...report, spent };
  const estimates =
    report.percent >= MIN_PERCENT && spent >= MIN_SPENT
      ? [...state.estimates, { at: reading.at, account, dollars: round(spent / (report.percent / 100)) }].slice(-KEEP)
      : state.estimates;
  return { readings: { ...state.readings, [account]: reading }, estimates, week: median(estimates.map((e) => e.dollars)) ?? state.week };
}

// Reads every account's usage and folds it in (the watchdog, every quarter hour). Resolves to lines for its log.
export function observeSubscriptions(now = new Date()): string[] {
  let state = subscriptionState();
  const said: string[] = [];
  for (const account of accounts()) {
    const configDir = account.configDir ?? join(homedir(), ".claude");
    // No Claude Code here (or not under this home): nothing to read.
    if (!existsSync(configDir)) continue;
    const hours = collectHours(join(SUBS, `${account.name}.hours.json`), allTranscriptDirs(configDir), now);
    const report = readUsage(account);
    if (!report) {
      said.push(`couldn't read the ${account.name} subscription's usage (claude -p /usage gave no usage report)`);
      continue;
    }
    state = withReading(state, account.name, report, hours, now);
  }
  mkdirSync(SUBS, { recursive: true });
  writeJson(stateFile, state);
  return said;
}

// One subscription's week in API-equivalent dollars, as last estimated; null before there's an estimate.
export const subscriptionWeek = (): number | null => subscriptionState().week;
