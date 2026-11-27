// The Claude subscriptions the factory's teams run on, how much of each one's limits is used, and which one each of a
// team's roles runs on.
//
// Usage: `claude -p /usage`, whose stream-json output carries Claude Code's documented usage report (a local command:
// no model, nothing used). With what this machine used in the same week, every session's (lib/usage.ts collectHours:
// the operator's own count against the same limit), that says what a subscription's week comes to in API-equivalent
// dollars, so a budget can be a share of one (tasks/controls.ts Limits, unit "subscription"): over 100% for a team that
// runs on more than one. The weekly limit across all models is the one measured; a model's own weekly limit (Fable's,
// on some plans) is reported, not budgeted, and once it's used up the roles on that model run on Opus there until it
// resets (fallbackFor); the five-hour window counts when the report has one.
//
// Accounts: ~/.a6g/subscriptions.json, [{ name, configDir }]; with none listed, this Mac's own Claude Code login
// (~/.claude). Another account has a Claude Code config folder of its own (CLAUDE_CONFIG_DIR), as Claude Code's docs
// say to run several, and a team's T3 instances run on it through T3 Code's own setting for that (homePath, lib/t3.ts).
// Each reading records the login in the folder (its account id and plan), so a name whose login changed is noticed.
//
// Choosing: the operator's limits per subscription and across all of them (subscriptions/limits.json) close a
// subscription; one whose week or five-hour window is used up is closed until it resets, as T3 Code treats a used-up
// window. Each team's roles run on the subscriptions the operator listed for them (subscriptions/use.json), in order:
// the watchdog keeps each role on an open one (lib/steer.ts). Readings and estimates: subscriptions/state.json.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadTeam } from "./config.ts";
import { type MachineSubscription, REPORT_LIMITS, USAGE_DAYS, USAGE_FIELDS, USAGE_HOURS, type UsageBucket } from "./fleet.ts";
import { fallbackModel, familyOf, MODEL_ALIASES, modelName, modelTitle, newerThan, newerThanShortNames, onShortName, versionOf } from "./models.ts";
import { A6G_HOME, PACKAGE, readRegistry, teamsDir } from "./paths.ts";
import { modelKey } from "./prices.ts";
import { dayOf, OWN_LOGIN, round } from "./tasks/spend.ts";
import { type AccountUsage, allTranscriptDirs, collectHours, emptyTally, type Tally, TALLY_FIELDS } from "./usage.ts";
import { readJson, writeJson } from "./util.ts";

export interface Account {
  name: string;
  // Its Claude Code config folder, or null for this Mac's own login.
  configDir: string | null;
}

// A window of a subscription's usage: how much is used, 0 to 100, and when it resets.
export interface Window {
  percent: number;
  resetsAt: string;
}

// What an account's usage report said, and what this machine used since its week began.
export interface Reading {
  account: string;
  at: string;
  // Of the weekly limit across all models, 0 to 100.
  percent: number;
  resetsAt: string;
  // The five-hour window, when the report has one.
  session?: Window | null;
  // Limits of one model's own (Fable's), for the record, with when each resets (from readings that said).
  scoped: { model: string; percent: number; resetsAt?: string }[];
  // Extra usage, paid by the month beyond the plan's limits, when the report says.
  extra?: { enabled: boolean; limit: number | null; used: number | null; currency: string | null } | null;
  // API-equivalent dollars this machine used since the week began.
  spent: number;
  // The login the folder held (its account id) and its plan, when Claude Code's config said.
  login?: string | null;
  plan?: string | null;
}

export interface Estimate {
  at: string;
  account: string;
  dollars: number;
  plan?: string | null;
}

export interface SubscriptionState {
  readings: Record<string, Reading>;
  // One subscription's week in API-equivalent dollars, estimated from each reading that said enough.
  estimates: Estimate[];
  // The estimate in use across all of them: the median of the newest, or null before there's one. Each
  // subscription's own is weekFor's.
  week: number | null;
}

// A subscription's limits, each in percent of its window: the share of it the factory's teams may take.
export interface SubscriptionLimit {
  weekly?: number | null;
  session?: number | null;
}

// The subscriptions a team's roles run on, in order of preference: "*" for every role, or a role's own list.
export type TeamUse = Record<string, string[]>;

// Why a role waits (with the figures of the last reading), until when, and `key`: which subscriptions are closed and
// what closed them, without the figures, so a wait that only changed by a reading isn't news.
export interface Wait {
  why: string;
  until: string | null;
  key?: string;
}

const SUBS = join(A6G_HOME, "subscriptions");
const accountsFile = join(A6G_HOME, "subscriptions.json");
const stateFile = join(SUBS, "state.json");
const limitsFile = join(SUBS, "limits.json");
const useFile = join(SUBS, "use.json");
// A reading needs this much of the week used, and this much spent, to say what a week comes to: the report gives
// whole percents, and a little use says little.
const MIN_PERCENT = 5;
const MIN_SPENT = 1;
const KEEP = 12;
// How far under its limits a subscription must be for a role to move back to it, so a reading near a limit doesn't
// move the team back and forth.
export const ROOM = 5;
// The limit across every subscription, in limits.json.
export const ALL = "all";
export const SUBSCRIPTION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const accounts = (): Account[] => {
  const listed = readJson<Account[]>(accountsFile, []);
  return listed.length ? listed : [{ name: "default", configDir: null }];
};
export const setAccounts = (list: Account[]): void => writeJson(accountsFile, list);
export const subscriptionState = (): SubscriptionState => readJson<SubscriptionState>(stateFile, { readings: {}, estimates: [], week: null });
export const subscriptionLimits = (): Record<string, SubscriptionLimit> => readJson<Record<string, SubscriptionLimit>>(limitsFile, {});
export const setSubscriptionLimits = (limits: Record<string, SubscriptionLimit>): void => writeJson(limitsFile, limits);
export const teamUses = (): Record<string, TeamUse> => readJson<Record<string, TeamUse>>(useFile, {});
export const setTeamUses = (uses: Record<string, TeamUse>): void => writeJson(useFile, uses);

// An account's Claude Code config folder: its own, or this Mac's (~/.claude).
export const configDirOf = (account: Account): string => account.configDir ?? join(homedir(), ".claude");

// Every login whose transcripts a team's spend is read from, by name: each subscription listed here, and this Mac's
// own login whether or not it's listed, since a team with no list of its own runs on it.
export function loginDirs(list = accounts()): Record<string, string> {
  const dirs: Record<string, string> = Object.fromEntries(list.map((a) => [a.name, configDirOf(a)]));
  const own = join(homedir(), ".claude");
  if (!Object.values(dirs).includes(own)) dirs[Object.hasOwn(dirs, OWN_LOGIN) ? "this-mac" : OWN_LOGIN] = own;
  return dirs;
}
// The account a T3 instance's homePath runs on (none: this Mac's own login), or null when it's no account listed here.
export function accountAt(homePath: string | null | undefined, list = accounts()): string | null {
  const path = homePath?.trim() ? homePath.trim() : null;
  return list.find((a) => (path ? a.configDir === path : a.configDir === null))?.name ?? null;
}

// The login in a Claude Code config folder: its account id and plan, from Claude Code's own config (.claude.json,
// beside the folder for this Mac's own login, inside it for another). Null when it holds none (signed out, or an
// API key).
export function loginOf(account: Account): { login: string; plan: string | null } | null {
  const file = account.configDir ? join(account.configDir, ".claude.json") : join(homedir(), ".claude.json");
  try {
    const oauth = readJson<{ oauthAccount?: Record<string, unknown> }>(file, {}).oauthAccount;
    const login = oauth?.["accountUuid"];
    if (typeof login !== "string" || !login) return null;
    const plan = oauth?.["planDisplayName"] ?? oauth?.["organizationType"];
    return { login, plan: typeof plan === "string" && plan ? plan : null };
  } catch {
    return null;
  }
}

interface ReportLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: { display_name?: string } } | null;
}
interface ReportExtra {
  is_enabled?: boolean;
  monthly_limit?: number | null;
  used_credits?: number | null;
  currency?: string | null;
}
const amount = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);

// The limits in `claude -p /usage --output-format stream-json` output: null when there's no usage report, or it has no
// rate limits (an API key, or a token without the scope to read them).
export function parseUsageReport(output: string): Pick<Reading, "percent" | "resetsAt" | "scoped" | "session" | "extra"> | null {
  for (const raw of output.split("\n")) {
    let line: { usage_report?: { rate_limits?: { limits?: ReportLimit[]; extra_usage?: ReportExtra | null } | null } };
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const limits = line.usage_report?.rate_limits?.limits;
    if (!limits) continue;
    const extra = line.usage_report?.rate_limits?.extra_usage;
    const all = limits.find((l) => l.kind === "weekly_all");
    if (typeof all?.percent !== "number" || !all.resets_at) return null;
    const session = limits.find((l) => /^(session|five_hour)$/.test(l.kind ?? "") || l.group === "session");
    return {
      percent: all.percent,
      resetsAt: new Date(all.resets_at).toISOString(),
      session:
        typeof session?.percent === "number" && session.resets_at
          ? { percent: session.percent, resetsAt: new Date(session.resets_at).toISOString() }
          : null,
      scoped: limits
        .filter((l) => l.kind === "weekly_scoped" && typeof l.percent === "number")
        .map((l) => ({
          model: l.scope?.model?.display_name ?? "a model",
          percent: l.percent ?? 0,
          ...(l.resets_at && !Number.isNaN(Date.parse(l.resets_at)) ? { resetsAt: new Date(l.resets_at).toISOString() } : {}),
        })),
      extra:
        extra && typeof extra.is_enabled === "boolean"
          ? {
              enabled: extra.is_enabled,
              limit: amount(extra.monthly_limit),
              used: amount(extra.used_credits),
              currency: typeof extra.currency === "string" && /^[A-Z]{3}$/.test(extra.currency) ? extra.currency : null,
            }
          : null,
    };
  }
  return null;
}

// Asks the account's Claude Code for its usage report, from a folder of the factory's own (its transcript there costs
// nothing, and belongs to no team). Null when it can't say.
export function readUsage(account: Account): Pick<Reading, "percent" | "resetsAt" | "scoped" | "session" | "extra"> | null {
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
// an estimate of one subscription's week; the estimate in use is the median of the newest. A login other than the one
// the name was read on before drops that name's estimates: they were another account's.
export function withReading(
  state: SubscriptionState,
  account: string,
  report: Pick<Reading, "percent" | "resetsAt" | "scoped"> & Partial<Pick<Reading, "session" | "extra" | "login" | "plan">>,
  hours: Record<string, number>,
  now = new Date()
): SubscriptionState {
  const weekBegan = new Date(Date.parse(report.resetsAt) - 7 * 86_400_000).toISOString().slice(0, 13);
  const spent = round(Object.entries(hours).reduce((sum, [hour, dollars]) => (hour >= weekBegan ? sum + dollars : sum), 0));
  const reading: Reading = { account, at: now.toISOString(), ...report, spent };
  const before = state.readings[account]?.login;
  const kept = before && report.login && before !== report.login ? state.estimates.filter((e) => e.account !== account) : state.estimates;
  const estimates =
    report.percent >= MIN_PERCENT && spent >= MIN_SPENT
      ? [...kept, { at: reading.at, account, dollars: round(spent / (report.percent / 100)), plan: report.plan ?? null }].slice(-KEEP)
      : kept;
  return { readings: { ...state.readings, [account]: reading }, estimates, week: median(estimates.map((e) => e.dollars)) ?? state.week };
}

// One subscription's week in API-equivalent dollars: the median of its own estimates; else of those of subscriptions
// on the same plan; else of all of them. Null before there's one.
export function weekFor(state: SubscriptionState, account: string): number | null {
  const own = median(state.estimates.filter((e) => e.account === account).map((e) => e.dollars));
  if (own !== null) return own;
  const plan = state.readings[account]?.plan;
  const same = plan ? median(state.estimates.filter((e) => e.plan === plan).map((e) => e.dollars)) : null;
  return same ?? state.week;
}

// Names here on the same login, read from their folders: each pair counts the same usage twice.
export function sameLogins(list: Account[], login = loginOf): string[][] {
  const by = new Map<string, string[]>();
  for (const account of list) {
    const found = login(account)?.login;
    if (found) by.set(found, [...(by.get(found) ?? []), account.name]);
  }
  return [...by.values()].filter((names) => names.length > 1);
}

// Reads every account's usage and folds it in (the watchdog, every quarter hour, or five minutes near a limit).
// Resolves to lines for its log.
export function observeSubscriptions(now = new Date()): string[] {
  let state = subscriptionState();
  const said: string[] = [];
  const list = accounts();
  for (const account of list) {
    const configDir = configDirOf(account);
    // No Claude Code here (or not under this home): nothing to read.
    if (!existsSync(configDir)) continue;
    const hours = collectHours(join(SUBS, `${account.name}.hours.json`), allTranscriptDirs(configDir), now);
    const report = readUsage(account);
    if (!report) {
      said.push(`couldn't read the ${account.name} subscription's usage (claude -p /usage gave no usage report)`);
      continue;
    }
    const login = loginOf(account);
    const before = state.readings[account.name]?.login;
    if (before && login && before !== login.login)
      said.push(`the ${account.name} subscription is signed in to another account than when it was last read; its estimates start again`);
    state = withReading(state, account.name, { ...report, login: login?.login ?? null, plan: login?.plan ?? null }, hours, now);
  }
  for (const names of sameLogins(list)) said.push(`${names.join(" and ")} are the same Claude account: its usage counts once per name`);
  mkdirSync(SUBS, { recursive: true });
  writeJson(stateFile, state);
  return said;
}

// One subscription's week in API-equivalent dollars, as last estimated; null before there's an estimate.
export const subscriptionWeek = (): number | null => subscriptionState().week;

// --- Choosing --------------------------------------------------------------------------------------------------

// What a subscription allows now. Closed at the operator's limits for it (or across all of them), and always once its
// week or five-hour window is used up, until it resets; `room` when it's ROOM points or more under every one of them.
// A reading of a window that has since reset says nothing, and no reading yet counts as open.
export interface Gate {
  open: boolean;
  // Used up (100%), not only at the operator's limit.
  exhausted: boolean;
  room: boolean;
  why: string | null;
  // When it opens again, as far as the readings say.
  until: string | null;
  // What closed it, without the figures that change with each reading: "used", "limit", "all", "budget" (the team's
  // own on it) or "unknown" (no subscription of that name here).
  kind?: "used" | "limit" | "all" | "budget" | "unknown";
}

const OPEN: Gate = { open: true, exhausted: false, room: true, why: null, until: null };
const when = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export function gate(name: string, state: SubscriptionState, limits: Record<string, SubscriptionLimit>, names: string[], now = new Date()): Gate {
  const t = now.getTime();
  const live = (window: Window | null | undefined): window is Window => !!window && Date.parse(window.resetsAt) > t;
  const reading = state.readings[name];
  const week = reading && live(reading) ? reading : null;
  const session = live(reading?.session) ? reading.session : null;
  const cap = limits[name] ?? {};
  const weeklyCap = cap.weekly ?? 100;
  const sessionCap = cap.session ?? 100;
  const closed = (why: string, until: string | null, kind: NonNullable<Gate["kind"]>): Gate => ({
    open: false,
    exhausted: kind === "used",
    room: false,
    why,
    until,
    kind,
  });
  if (week && week.percent >= 100) return closed(`${name} has used its week`, week.resetsAt, "used");
  if (session && session.percent >= 100) return closed(`${name} has used its five hours`, session.resetsAt, "used");
  if (week && week.percent >= weeklyCap) return closed(`${name} is at ${week.percent}% of its week, its limit is ${weeklyCap}%`, week.resetsAt, "limit");
  if (session && session.percent >= sessionCap)
    return closed(`${name} is at ${session.percent}% of its five hours, its limit is ${sessionCap}%`, session.resetsAt, "limit");
  const allCap = limits[ALL]?.weekly ?? null;
  const counted = names.flatMap((n) => {
    const r = state.readings[n];
    return r && live(r) ? [r] : [];
  });
  const total = counted.reduce((sum, r) => sum + r.percent, 0);
  if (allCap !== null && total >= allCap)
    return closed(
      `the subscriptions together are at ${total}% of a week, their limit is ${allCap}%`,
      counted.map((r) => r.resetsAt).sort()[0] ?? null,
      "all"
    );
  if (!week && !session) return OPEN;
  const room = (week?.percent ?? 0) <= weeklyCap - ROOM && (session?.percent ?? 0) <= sessionCap - ROOM && (allCap === null || total <= allCap - ROOM);
  return { ...OPEN, room };
}

// The subscriptions a team's role may run on, in order: its own list, else the team's, else this Mac's own login when
// it's a listed subscription. Empty: this Mac's own login, which nothing watches.
export function listFor(use: TeamUse | undefined, role: string, list = accounts()): string[] {
  const own = use?.[role] ?? use?.["*"];
  if (own?.length) return own;
  const mac = list.find((a) => a.configDir === null);
  return mac ? [mac.name] : [];
}

// The subscription a role runs on: the one it's on while that's open; else the first open one in its list. It goes
// back to one earlier in the list only when that one has room, so a reading near a limit doesn't move it back and
// forth. Null when none is open.
export function choose(list: string[], current: string | null, gateOf: (name: string) => Gate): string | null {
  const open = list.filter((name) => gateOf(name).open);
  if (current && open.includes(current)) return list.slice(0, list.indexOf(current)).find((name) => gateOf(name).open && gateOf(name).room) ?? current;
  return open[0] ?? null;
}

// Each role's subscription (null: this Mac's own login, unwatched) and, for a role none is open to, why and until
// when. `current` is what each role's instance runs on now; `closedFor` closes subscriptions for this team alone (its
// budget on one, lib/budget.ts accountClosures).
export interface Choice {
  roles: Record<string, string | null>;
  waiting: Record<string, Wait>;
  // What each subscription it looked at allows, for saying why a role moved.
  gates: Record<string, Gate>;
}
export function chooseFor(
  roles: string[],
  current: Record<string, string | null>,
  ctx: {
    use: TeamUse | undefined;
    accounts: Account[];
    state: SubscriptionState;
    limits: Record<string, SubscriptionLimit>;
    closedFor?: Record<string, string>;
    now?: Date;
  }
): Choice {
  const names = ctx.accounts.map((a) => a.name);
  const gates = new Map<string, Gate>();
  const gateOf = (name: string): Gate => {
    let g = gates.get(name);
    if (!g) {
      const closedFor = ctx.closedFor?.[name];
      g = !names.includes(name)
        ? { ...OPEN, open: false, room: false, why: `${name} isn't a subscription on this Mac (a6g subscriptions add)`, kind: "unknown" }
        : closedFor
          ? { ...OPEN, open: false, room: false, why: closedFor, kind: "budget" }
          : gate(name, ctx.state, ctx.limits, names, ctx.now);
      gates.set(name, g);
    }
    return g;
  };
  const choice: Choice = { roles: {}, waiting: {}, gates: {} };
  for (const role of roles) {
    const list = listFor(ctx.use, role, ctx.accounts);
    const now = current[role] ?? null;
    if (!list.length) {
      choice.roles[role] = null;
      continue;
    }
    const chosen = choose(list, now, gateOf);
    if (chosen) {
      choice.roles[role] = chosen;
      continue;
    }
    // None open: it stays where it is (nothing of it starts), and waits for the first to open.
    choice.roles[role] = now;
    const shut = list.map((name) => gateOf(name));
    const until = shut.flatMap((g) => (g.until ? [g.until] : [])).sort()[0] ?? null;
    choice.waiting[role] = { why: shut.map((g) => g.why).join("; "), until, key: list.map((name, i) => `${name}:${shut[i]?.kind ?? "closed"}`).join(",") };
  }
  choice.gates = Object.fromEntries(gates);
  return choice;
}

// A role on another model than its own for now: the subscription it runs on has used up its own model's weekly limit
// (Fable's, on some plans), so it runs on that model's fallback (lib/models.ts FALLBACKS) until the limit resets, or a
// reading says it's under 100% again. The subscription stays open: its limit across all models has room.
export interface Fallback {
  // The role's own model, and the one it runs on meanwhile.
  from: string;
  model: string;
  // The subscription whose limit is used up, and when that limit resets (null: the report didn't say).
  subscription: string;
  until: string | null;
  why: string;
}

// "default's", "refdocs'".
export const owns = (name: string): string => `${name}'${name.endsWith("s") ? "" : "s"}`;

// The fallback for a role on `model` that runs on `subscription`, from its latest reading; null when it runs on its own.
// A used-up limit is 100%, as a used-up week is (gate); one whose reset has passed says nothing, as a window's doesn't.
export function fallbackFor(model: string, subscription: string | null, state: SubscriptionState, now = new Date()): Fallback | null {
  const to = fallbackModel(model);
  const reading = subscription ? state.readings[subscription] : undefined;
  if (!to || !subscription || !reading) return null;
  const family = familyOf(model);
  const used = reading.scoped.find(
    (limit) => familyOf(limit.model) === family && limit.percent >= 100 && Date.parse(limit.resetsAt ?? reading.resetsAt) > now.getTime()
  );
  if (!used) return null;
  return { from: model, model: to, subscription, until: used.resetsAt ?? null, why: `${owns(subscription)} ${used.model} limit is used up` };
}

// Whether a subscription is closed or within NEAR points of one of its limits (or the limit across all), or of a model's
// own, so the watchdog reads them every five minutes rather than every quarter hour.
const NEAR = 10;
export function nearLimit(state: SubscriptionState, limits: Record<string, SubscriptionLimit>, names: string[], now = new Date()): boolean {
  const shifted = (cap: number | null | undefined): number => (cap ?? 100) - NEAR;
  const nearer: Record<string, SubscriptionLimit> = Object.fromEntries(
    [...names, ALL].map((name) => [name, { weekly: shifted(limits[name]?.weekly), session: shifted(limits[name]?.session) }])
  );
  if (limits[ALL]?.weekly == null) delete nearer[ALL];
  const t = now.getTime();
  const ownNear = (name: string): boolean => {
    const reading = state.readings[name];
    return !!reading?.scoped.some((limit) => limit.percent >= 100 - NEAR && Date.parse(limit.resetsAt ?? reading.resetsAt) > t);
  };
  return names.some((name) => !gate(name, state, nearer, names, now).open || ownNear(name));
}

// A role's wait, in words: why, and until when.
export const describeWait = (wait: Wait): string => `${wait.why}${wait.until ? ` (until ${when(wait.until)})` : ""}`;

// How long a fallback lasts, in words: "until 2026-11-22 16:00 UTC", or "for now" when the report didn't say.
export const untilWords = (until: string | null): string => (until ? `until ${when(until)}` : "for now");

// A role's fallback, in words: "on Opus until 2026-11-22 16:00 UTC: refdocs' Fable limit is used up".
export const describeFallback = (fallback: Fallback): string => `on ${modelName(fallback.model)} ${untilWords(fallback.until)}: ${fallback.why}`;

// --- The web app's Subscriptions page ----------------------------------------------------------------------------

// A model's id as a report may carry it (lib/fleet.ts): any other is "other".
const MODEL_ID = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const DAY_MS = 86_400_000;

// What an account's tallies (lib/usage.ts collectAccountUsage, by UTC hour) come to by this machine's day for the last
// USAGE_DAYS, and by hour for the last USAGE_HOURS, per model, newest first: at most `room` buckets, the oldest days
// left out first.
export function usageBuckets(tallies: Record<string, Record<string, Tally>>, now: Date, room: number): { days: UsageBucket[]; hours: UsageBucket[] } {
  const firstDay = dayOf(new Date(now.getTime() - (USAGE_DAYS - 1) * DAY_MS));
  const firstHour = new Date(now.getTime() - (USAGE_HOURS - 1) * 3_600_000).toISOString().slice(0, 13);
  const days = new Map<string, Tally>();
  const hours = new Map<string, Tally>();
  const add = (into: Map<string, Tally>, key: string, tally: Tally): void => {
    const sum = into.get(key) ?? emptyTally();
    for (const field of TALLY_FIELDS) sum[field] += tally[field];
    into.set(key, sum);
  };
  for (const [hour, models] of Object.entries(tallies)) {
    const day = dayOf(new Date(`${hour}:00:00Z`));
    for (const [model, tally] of Object.entries(models)) {
      const id = MODEL_ID.test(model) ? model : "other";
      if (day >= firstDay) add(days, `${day} ${id}`, tally);
      if (hour >= firstHour) add(hours, `${hour} ${id}`, tally);
    }
  }
  // Tokens are whole; dollars to a hundredth of a cent, which is all a page shows and keeps a report small.
  const bucket = (key: string, tally: Tally): UsageBucket => {
    const [at = "", model = ""] = key.split(" ");
    return [at, model, ...USAGE_FIELDS.map((field) => (/^(cost|fast|saved)/.test(field) ? Math.round(tally[field] * 1e4) / 1e4 : tally[field]))];
  };
  const newest = (into: Map<string, Tally>) => [...into].sort(([a], [b]) => b.localeCompare(a)).map(([key, tally]) => bucket(key, tally));
  const byHour = newest(hours).slice(0, Math.max(0, room));
  return { days: newest(days).slice(0, Math.max(0, room - byHour.length)), hours: byHour };
}

// How many sessions ran in the last day, 7, 30 and 90, from the hour each last ran in.
export function sessionCounts(sessions: Record<string, string>, now: Date): MachineSubscription["sessions"] {
  const last = Object.values(sessions);
  const since = (days: number): number => {
    const from = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 13);
    return last.filter((hour) => hour >= from).length;
  };
  return [since(1), since(7), since(30), since(90)];
}

// Every subscription here as the machine's report carries it (lib/fleet.ts): its limits as last read (a window that
// has reset since says nothing), the operator's limits, whether it's closed to the teams, the roles of each team here
// that run on it (`on`, by name), and what it used here. Its login goes as a hash only, the same on every machine.
export function subscriptionsReport(on: Record<string, MachineSubscription["teams"]>, now = new Date()): MachineSubscription[] {
  const state = subscriptionState();
  const limits = subscriptionLimits();
  const list = accounts().slice(0, REPORT_LIMITS.subscriptions);
  const names = list.map((a) => a.name);
  const t = now.getTime();
  const live = (window: Window | null | undefined) =>
    window && Date.parse(window.resetsAt) > t ? { percent: window.percent, resetsAt: window.resetsAt } : null;
  let room: number = REPORT_LIMITS.usage;
  return list.map((account) => {
    const { name } = account;
    const reading = state.readings[name];
    const file = join(SUBS, `${name}.hours.json`);
    let usage: Partial<AccountUsage> = {};
    let counted: string | null = null;
    try {
      usage = readJson<Partial<AccountUsage>>(file, {});
      if (usage.tallies) counted = statSync(file).mtime.toISOString();
    } catch {}
    const { days, hours } = usageBuckets(usage.tallies ?? {}, now, room);
    room -= days.length + hours.length;
    const shut = gate(name, state, limits, names, now);
    const login = reading?.login ?? loginOf(account)?.login ?? null;
    const week = weekFor(state, name);
    return {
      name,
      login: login ? createHash("sha256").update(`a6g-login:${login}`).digest("hex").slice(0, 16) : null,
      plan: reading?.plan?.slice(0, 40) ?? null,
      at: reading?.at ?? null,
      weekly: reading ? live(reading) : null,
      session: live(reading?.session),
      models: (reading?.scoped ?? [])
        .filter((m) => !m.resetsAt || Date.parse(m.resetsAt) > t)
        .slice(0, 10)
        .map((m) => ({ model: m.model.slice(0, 60), percent: m.percent, resetsAt: m.resetsAt ?? null })),
      extra: reading?.extra ?? null,
      week: week === null ? null : Math.round(week * 100) / 100,
      limits: { weekly: limits[name]?.weekly ?? null, session: limits[name]?.session ?? null },
      closed: shut.open ? null : { why: (shut.why ?? "closed").slice(0, 300), until: shut.until, exhausted: shut.exhausted },
      teams: on[name] ?? [],
      today: dayOf(now),
      days,
      hours,
      sessions: sessionCounts(usage.sessions ?? {}, now),
      counted,
    };
  });
}

// --- Newer models ------------------------------------------------------------------------------------------------

// The models the subscriptions here used in the last `days`, by id (lib/prices.ts modelKey): on which subscriptions,
// and the first hour each was used in, as far back as the tallies go. From the tallies observeSubscriptions keeps
// (lib/usage.ts collectAccountUsage).
export function modelsInUse(now = new Date(), days = 14): Record<string, { since: string; on: string[] }> {
  const from = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 13);
  const first: Record<string, string> = {};
  const used: Record<string, { since: string; on: string[] }> = {};
  for (const { name } of accounts()) {
    let tallies: Record<string, Record<string, Tally>> = {};
    try {
      tallies = readJson<Partial<AccountUsage>>(join(SUBS, `${name}.hours.json`), {}).tallies ?? {};
    } catch {}
    for (const [hour, models] of Object.entries(tallies)) {
      for (const [model, tally] of Object.entries(models)) {
        if (!tally.requests) continue;
        const id = modelKey(model);
        if (!first[id] || hour < first[id]) first[id] = hour;
        if (hour < from) continue;
        const seen = (used[id] ??= { since: hour, on: [] });
        if (!seen.on.includes(name)) seen.on.push(name);
      }
    }
  }
  for (const [id, seen] of Object.entries(used)) seen.since = first[id] ?? seen.since;
  return used;
}

// Something that keeps a role off its family's newest model, in words. `key` says what it's about, so the watchdog
// says each once: "factory claude-fable-5-2" (this version's short name is behind a model in use here), or "team
// <name> claude-fable-5-2" (a team's roles are behind this version's short name).
export interface ModelNotice {
  key: string;
  text: string;
}

// What keeps roles off their family's newest model: a newer one in use on a subscription here than this version's
// short name for it (a release that knows it, then a6g upgrade, moves the teams); and each registered team whose roles
// on a short name run an older one than this version's (a6g upgrade moves them). A team whose team.json can't be read
// says nothing here: a6g doctor says why.
export function modelNotices(now = new Date()): ModelNotice[] {
  const inUse = modelsInUse(now);
  const notices: ModelNotice[] = [];
  for (const [family, id] of Object.entries(newerThanShortNames(Object.keys(inUse)))) {
    const own = MODEL_ALIASES[family] as string;
    const seen = inUse[id];
    notices.push({
      key: `factory ${id}`,
      text: `${modelTitle(id)} (${id}) is in use on ${seen?.on.join(", ") ?? "a subscription here"}${seen ? ` since ${seen.since.slice(0, 10)}` : ""}, but Anything Factory ${PACKAGE.version} runs ${modelName(own)} roles on ${modelTitle(own)} (${own}): a release that knows ${modelTitle(id)} moves them (a6g self-install it, then a6g upgrade <team>)`,
    });
  }
  const names = existsSync(teamsDir) ? readdirSync(teamsDir).flatMap((file) => (file.endsWith(".json") ? [file.slice(0, -5)] : [])) : [];
  for (const name of names) {
    try {
      const entry = readRegistry(name);
      if (!entry) continue;
      const team = loadTeam(entry.home, { strict: false });
      const models = entry.models ?? Object.fromEntries(Object.keys(team.roles).map((role) => [role, entry.model]));
      const behind = new Map<string, string[]>();
      for (const [role, model] of Object.entries(models)) {
        const family = versionOf(model)?.family;
        if (family && newerThan(MODEL_ALIASES[family] as string, model) && onShortName(team.raw, role))
          behind.set(modelKey(model), [...(behind.get(modelKey(model)) ?? []), role]);
      }
      for (const [old, roles] of behind) {
        const newest = MODEL_ALIASES[versionOf(old)?.family ?? ""] as string;
        notices.push({
          key: `team ${name} ${newest}`,
          text: `${name} runs its ${roles.join(", ")} on ${modelTitle(old)} (${old}), but Anything Factory ${PACKAGE.version} runs ${modelName(newest)} roles on ${modelTitle(newest)} (${newest}): a6g upgrade ${name} moves ${roles.length === 1 ? "it" : "them"}`,
        });
      }
    } catch {}
  }
  return notices;
}
