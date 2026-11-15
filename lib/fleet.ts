// The machines that run teams, as the web app shows them, and how a machine is linked to a person's account there.
//
// A person links a machine from its terminal (a6g connect app, lib/app.ts) with OAuth's device authorization grant
// (RFC 8628): the CLI asks the app for a code, the person signs in to the app in their browser, checks the code and
// the machine, and approves; the CLI, polling meanwhile, then gets a token that does one thing, report this machine.
// It isn't a session: it can't read anything, act as the person, or reach any other page. Every ROTATE_DAYS the app
// answers a report with a new token, and an old one used after its successor ends the link (RFC 9700 section 4.14).
// Nothing the app answers is ever an instruction: the link carries reports one way, from the machine. The watchdog
// reports at the end of every full run (every five minutes): the machine's name, the factory it runs, and every team registered on
// it, those whose tasks are in files too. The app keeps the latest report with the link (web/server/machines.ts) and
// shows it to the person who linked the machine; an admin sees every machine.
//
// Shared by the CLI and the web app: pure.
import type { TeamState } from "./tasks/teams.ts";
import { UNSHOWN } from "./untrusted.ts";

// A machine's name, as the task graph knows it too (lib/machine.ts).
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

// --- The link (RFC 8628) ------------------------------------------------------------------------------------------

// Where the app answers: the CLI asks for a code, polls for its token, reports, and unlinks itself; the person
// approves on the page.
export const APP_PATHS = {
  link: "/api/machines/link",
  token: "/api/machines/token",
  report: "/api/machines/report",
  self: "/api/machines/self",
  approve: "/machines/link",
} as const;
export const CLIENT_ID = "a6g-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// What the person types or checks: eight letters with no vowels and no look-alikes (RFC 8628 section 6.1), shown as
// BCDF-GHJK, typed in either case with or without the dash. 20^8 codes; each person and each address gets a few looks
// in 15 minutes (web/server/machines.ts).
export const USER_CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_LENGTH = 8;
export function normalUserCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]+/g, "");
  return code.length === USER_CODE_LENGTH && [...code].every((c) => USER_CODE_LETTERS.includes(c)) ? code : null;
}
export const shownUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

// The machine's token: 32 random bytes, base64url, after a prefix that says what it is (so a scanner can spot one).
export const MACHINE_TOKEN = /^a6gm_[A-Za-z0-9_-]{43}$/;

// How long a code waits for the person, how often the CLI may ask whether it's been approved, how long a linked
// machine that hasn't reported keeps its link, how often its token is replaced and how long the one before keeps
// working for a CLI that missed the new one, and how many machines one person may link.
export const LINK_MINUTES = 10;
export const POLL_SECONDS = 5;
export const IDLE_DAYS = 30;
export const ROTATE_DAYS = 7;
export const ROTATE_GRACE_HOURS = 24;
export const MAX_MACHINES = 10;

export interface LinkStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}
export interface LinkToken {
  access_token: string;
  token_type: "Bearer";
  // Seconds it lasts without a report (it lasts as long as the machine keeps reporting).
  expires_in: number;
  // The machine as the app keeps it, and the account it's linked to, masked (m•••@example.com): shown once in the
  // terminal, never saved.
  machine: { id: string; name: string };
  account: string;
}
// A report's answer: nothing (204), or the machine's next token (200) when the one it used is due to be replaced.
export interface ReportAnswer {
  access_token?: string;
}
// RFC 8628 section 3.5: still waiting, asking too often, refused by the person, expired, or never issued (or gone).
export type LinkError = "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_request" | "invalid_grant";

// --- The report -----------------------------------------------------------------------------------------------------

export interface MachineTeam {
  name: string;
  title: string;
  // The lead runs the planner, the reviews and the merge queue (a team on one machine has it as its lead); a worker
  // runs builders that claim from the shared task graph.
  part: "lead" | "worker";
  // Where its task graph is: only a team in Mongo has pages on the web app. Null for a board on GitHub.
  store: "files" | "mongo" | null;
  // The team's checkout on this machine, under ~/ when it's in the home folder (whose path names its user).
  home: string;
  // The factory version the team runs.
  factory: string;
  state: TeamState["state"];
  // The planner's thread as T3 Code reports it, on the lead; null on a worker, or when there's none.
  planner: string | null;
  // Members at work on this machine, by role.
  members: Record<string, number>;
}

// What a machine offers to start for the web app, once its operator said so at its terminal (a6g connect app
// --projects <dir>, lib/orders.ts): the folder, the repositories in it that no team uses yet, and its subscriptions, for
// the form that asks. A machine that starts none sends nothing.
export interface MachineProjects {
  // The folder, under ~/ when it's in the home folder.
  dir: string;
  // Each repository directly inside it, by its folder's name.
  repos: string[];
  // The Claude subscriptions here, by name, with how much of each one's week is used as last read (null before).
  subscriptions: { name: string; percent: number | null }[];
  // The GitHub account its gh is signed in as (null: none), which clones, forks and makes repositories for an ask. A
  // report from a version that can't do those, or read the settings an ask may carry since, has no such key.
  github?: string | null;
}

// A window of a subscription's limits: how much of it is used, 0 to 100, and when it resets.
export interface LimitWindow {
  percent: number;
  resetsAt: string | null;
}

// What a subscription used in one hour or day, on one model: [when, model, ...USAGE_FIELDS], when being the UTC hour
// ("2026-11-15T14") or the machine's own day ("2026-11-15"). A tuple, as a report carries many.
export const USAGE_FIELDS = [
  "requests",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
  "costInput",
  "costOutput",
  "costCacheRead",
  "costCacheWrite",
  "fast",
  "saved",
  "unpriced",
] as const;
export type UsageField = (typeof USAGE_FIELDS)[number];
export type UsageBucket = [string, string, ...number[]];

// A Claude subscription on a machine, for the web app's Subscriptions page: its limits as last read, the operator's
// limits for the factory's teams on it, the teams on it now, and what it used on this machine, every session's (the
// operator's own too), in the API-equivalent dollars of lib/prices.ts.
export interface MachineSubscription {
  name: string;
  // Its login, as a hash: the same login on two machines is one subscription on the page. Null when it's signed out.
  login: string | null;
  plan: string | null;
  // When its limits were last read (null: never), and those that haven't reset since.
  at: string | null;
  weekly: LimitWindow | null;
  session: LimitWindow | null;
  models: (LimitWindow & { model: string })[];
  // Extra usage, paid by the month beyond the plan's limits: whether it's on, its cap and what's used of it.
  extra: { enabled: boolean; limit: number | null; used: number | null; currency: string | null } | null;
  // One week of it in API-equivalent dollars, as estimated from its readings (null before there's one).
  week: number | null;
  // The share of its windows the factory's teams may take here (a6g subscriptions limit), and why it's closed to them
  // now, until when, and whether because it's used up.
  limits: { weekly: number | null; session: number | null };
  closed: { why: string; until: string | null; exhausted: boolean } | null;
  // The roles of each team on this machine that run on it now.
  teams: { team: string; roles: string[] }[];
  // What it used: each of the last USAGE_DAYS days (`today` is the machine's own day as it reported), the last
  // USAGE_HOURS hours, and how many sessions ran in the last day, 7, 30 and 90; when that was last counted.
  today: string;
  days: UsageBucket[];
  hours: UsageBucket[];
  sessions: [number, number, number, number];
  counted: string | null;
}
export const USAGE_DAYS = 90;
export const USAGE_HOURS = 25;

// What a machine sends: the app adds when it came, and from which account's link.
export interface MachineReport {
  name: string;
  // The factory version a person runs here (a6g self-install).
  factory: string;
  teams: MachineTeam[];
  // Null from a machine whose factory version starts projects but whose operator hasn't said it may; absent from one
  // whose version doesn't know how.
  projects?: MachineProjects | null;
  // Its Claude subscriptions; absent from a version that doesn't report them.
  subscriptions?: MachineSubscription[];
}

// The most a report may hold; the app refuses a bigger one whole. `usage`: buckets across all its subscriptions.
export const REPORT_LIMITS = {
  bytes: 768 * 1024,
  teams: 100,
  members: 30,
  text: 200,
  home: 1024,
  repos: 200,
  subscriptions: 20,
  usage: 4000,
} as const;

const STATES: readonly TeamState["state"][] = ["active", "pausing", "paused", "idle", "complete"];
// A team's name as a report may give it: the shape of one in the app's URLs, which every name team.json allows fits.
const TEAM = /^[a-z][a-z0-9-]{0,62}$/;
const ROLE = /^[a-z][a-z0-9-]{0,40}$/;
const VERSION = /^[\w.+-]{1,40}$/;
const PLANNER = /^[\w-]{1,40}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// No control or format characters (bidirectional overrides, zero-width ones) or line separators (lib/untrusted.ts): a
// log could be split on them, or a page made to show text other than what it holds.
export { UNSHOWN };
// Printable text of at most `max` characters, with none of those.
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !UNSHOWN.test(value);

function parseTeam(value: unknown): MachineTeam | null {
  if (!isObject(value)) return null;
  const { name, title, part, store, home, factory, state, planner, members } = value;
  if (typeof name !== "string" || !TEAM.test(name)) return null;
  if (!isText(title, REPORT_LIMITS.text)) return null;
  if (part !== "lead" && part !== "worker") return null;
  if (store !== "files" && store !== "mongo" && store !== null) return null;
  if (!isText(home, REPORT_LIMITS.home) || !(home.startsWith("/") || home.startsWith("~/"))) return null;
  if (typeof factory !== "string" || !VERSION.test(factory)) return null;
  if (!STATES.includes(state as TeamState["state"])) return null;
  if (planner !== null && (typeof planner !== "string" || !PLANNER.test(planner))) return null;
  if (!isObject(members) || Object.keys(members).length > REPORT_LIMITS.members) return null;
  const counted: Record<string, number> = {};
  for (const [role, n] of Object.entries(members)) {
    if (!ROLE.test(role) || !Number.isInteger(n) || (n as number) < 0 || (n as number) > 999) return null;
    counted[role] = n as number;
  }
  return { name, title, part, store, home, factory, state: state as TeamState["state"], planner, members: counted };
}

// A repository's folder (lib/tasks/start.ts REPO_NAME) and a subscription's name (lib/subscriptions.ts).
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUBSCRIPTION = /^[a-z0-9][a-z0-9-]{0,39}$/;
// A GitHub account's name (lib/tasks/start.ts GITHUB_LOGIN): kept here too, as SUBSCRIPTION is.
const GITHUB_ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// What a machine offers to start: undefined when it's wrong.
function parseProjects(value: unknown): MachineProjects | undefined {
  if (!isObject(value)) return undefined;
  const { dir, repos, subscriptions, github } = value;
  if (!isText(dir, REPORT_LIMITS.home) || !(dir.startsWith("/") || dir.startsWith("~/"))) return undefined;
  if (!Array.isArray(repos) || repos.length > REPORT_LIMITS.repos || repos.some((repo) => typeof repo !== "string" || !REPO.test(repo))) return undefined;
  if (!Array.isArray(subscriptions) || subscriptions.length > REPORT_LIMITS.subscriptions) return undefined;
  const listed: MachineProjects["subscriptions"] = [];
  for (const sub of subscriptions) {
    if (!isObject(sub) || typeof sub["name"] !== "string" || !SUBSCRIPTION.test(sub["name"])) return undefined;
    const percent = sub["percent"];
    if (percent !== null && (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 1000)) return undefined;
    listed.push({ name: sub["name"], percent });
  }
  if (github !== undefined && github !== null && (typeof github !== "string" || !GITHUB_ACCOUNT.test(github))) return undefined;
  return { dir, repos: repos as string[], subscriptions: listed, ...(github === undefined ? {} : { github }) };
}

// A model's id as a transcript names it (lib/prices.ts modelKey), a login's hash, a plan's name and a currency.
const MODEL = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const LOGIN = /^[a-f0-9]{16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const isTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isAmount = (value: unknown, max = 1e12): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const orNull = <T>(value: unknown, check: (v: unknown) => v is T): T | null | undefined => (value === null ? null : check(value) ? value : undefined);

function parseWindow(value: unknown): LimitWindow | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || !isAmount(value["percent"], 1000)) return undefined;
  const resetsAt = orNull(value["resetsAt"], isTime);
  return resetsAt === undefined ? undefined : { percent: value["percent"], resetsAt };
}

function parseBuckets(value: unknown, when: RegExp): UsageBucket[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const buckets: UsageBucket[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== USAGE_FIELDS.length + 2) return undefined;
    const [at, model, ...figures] = row as unknown[];
    if (typeof at !== "string" || !when.test(at) || typeof model !== "string" || !MODEL.test(model)) return undefined;
    if (!figures.every((n) => isAmount(n))) return undefined;
    buckets.push([at, model, ...(figures as number[])]);
  }
  return buckets;
}

// A machine's subscriptions: undefined when any is wrong.
function parseSubscriptions(value: unknown): MachineSubscription[] | undefined {
  if (!Array.isArray(value) || value.length > REPORT_LIMITS.subscriptions) return undefined;
  const parsed: MachineSubscription[] = [];
  let usage = 0;
  for (const sub of value) {
    if (!isObject(sub)) return undefined;
    const { name, login, plan, at, weekly, session, models, extra, week, limits, closed, teams, today, days, hours, sessions, counted } = sub;
    if (typeof name !== "string" || !SUBSCRIPTION.test(name)) return undefined;
    const ownLogin = orNull(login, (v): v is string => typeof v === "string" && LOGIN.test(v));
    const ownPlan = orNull(plan, (v): v is string => isText(v, 40));
    const readAt = orNull(at, isTime);
    const week7 = parseWindow(weekly);
    const five = parseWindow(session);
    if (ownLogin === undefined || ownPlan === undefined || readAt === undefined || week7 === undefined || five === undefined) return undefined;
    if (!Array.isArray(models) || models.length > 10) return undefined;
    const scoped: MachineSubscription["models"] = [];
    for (const m of models) {
      const window = isObject(m) ? parseWindow(m) : undefined;
      if (!window || !isObject(m) || !isText(m["model"], 60)) return undefined;
      scoped.push({ model: m["model"], ...window });
    }
    let paid: MachineSubscription["extra"] = null;
    if (extra !== null) {
      if (!isObject(extra) || typeof extra["enabled"] !== "boolean") return undefined;
      const limit = orNull(extra["limit"], isAmount);
      const used = orNull(extra["used"], isAmount);
      const currency = orNull(extra["currency"], (v): v is string => typeof v === "string" && /^[A-Z]{3}$/.test(v));
      if (limit === undefined || used === undefined || currency === undefined) return undefined;
      paid = { enabled: extra["enabled"], limit, used, currency };
    }
    const dollars = orNull(week, isAmount);
    if (dollars === undefined || !isObject(limits)) return undefined;
    const capWeekly = orNull(limits["weekly"], (v): v is number => isAmount(v, 100));
    const capSession = orNull(limits["session"], (v): v is number => isAmount(v, 100));
    if (capWeekly === undefined || capSession === undefined) return undefined;
    let shut: MachineSubscription["closed"] = null;
    if (closed !== null) {
      if (!isObject(closed) || !isText(closed["why"], 300) || typeof closed["exhausted"] !== "boolean") return undefined;
      const until = orNull(closed["until"], isTime);
      if (until === undefined) return undefined;
      shut = { why: closed["why"], until, exhausted: closed["exhausted"] };
    }
    if (!Array.isArray(teams) || teams.length > REPORT_LIMITS.teams) return undefined;
    const on: MachineSubscription["teams"] = [];
    for (const t of teams) {
      if (
        !isObject(t) ||
        typeof t["team"] !== "string" ||
        !TEAM.test(t["team"]) ||
        !Array.isArray(t["roles"]) ||
        t["roles"].length > REPORT_LIMITS.members
      )
        return undefined;
      if (!t["roles"].every((role) => typeof role === "string" && ROLE.test(role))) return undefined;
      on.push({ team: t["team"], roles: t["roles"] as string[] });
    }
    if (typeof today !== "string" || !DAY.test(today)) return undefined;
    const byDay = parseBuckets(days, DAY);
    const byHour = parseBuckets(hours, HOUR);
    if (!byDay || !byHour) return undefined;
    usage += byDay.length + byHour.length;
    if (usage > REPORT_LIMITS.usage) return undefined;
    if (!Array.isArray(sessions) || sessions.length !== 4 || !sessions.every((n) => Number.isInteger(n) && isAmount(n, 1e7))) return undefined;
    const countedAt = orNull(counted, isTime);
    if (countedAt === undefined) return undefined;
    parsed.push({
      name,
      login: ownLogin,
      plan: ownPlan,
      at: readAt,
      weekly: week7,
      session: five,
      models: scoped,
      extra: paid,
      week: dollars,
      limits: { weekly: capWeekly, session: capSession },
      closed: shut,
      teams: on,
      today,
      days: byDay,
      hours: byHour,
      sessions: sessions as MachineSubscription["sessions"],
      counted: countedAt,
    });
  }
  return parsed;
}

// The report in `body`, rebuilt from the fields it may have (anything else is dropped), or null when any is wrong. Its
// subscriptions only are dropped when they're wrong: they're for one page, and the rest still says the machine is up.
export function parseReport(body: unknown): MachineReport | null {
  if (!isObject(body)) return null;
  const { name, factory, teams, projects, subscriptions } = body;
  if (typeof name !== "string" || !MACHINE_NAME.test(name)) return null;
  if (typeof factory !== "string" || !VERSION.test(factory)) return null;
  if (!Array.isArray(teams) || teams.length > REPORT_LIMITS.teams) return null;
  const parsed = teams.map(parseTeam);
  if (parsed.some((team) => team === null)) return null;
  const offered = projects === undefined || projects === null ? null : parseProjects(projects);
  if (offered === undefined) return null;
  const subs = subscriptions === undefined ? undefined : parseSubscriptions(subscriptions);
  return {
    name,
    factory,
    teams: parsed as MachineTeam[],
    ...(projects === undefined ? {} : { projects: offered }),
    ...(subs === undefined ? {} : { subscriptions: subs }),
  };
}

// --- Reading reports ------------------------------------------------------------------------------------------------

// A machine reports every five minutes; one not heard from for three of them is offline (asleep, off, or its
// watchdog stopped).
export const ONLINE_MIN = 15;
export const online = (machine: { at: string | null }, now = Date.now()): boolean =>
  machine.at !== null && now - Date.parse(machine.at) < ONLINE_MIN * 60_000;

// The machines `team` runs on, its lead first.
export const machinesRunning = <M extends { name: string; teams: readonly MachineTeam[] }>(
  machines: readonly M[],
  team: string
): { machine: M; part: MachineTeam["part"] }[] =>
  machines
    .flatMap((machine) => machine.teams.filter((t) => t.name === team).map(({ part }) => ({ machine, part })))
    .sort((a, b) => Number(a.part === "worker") - Number(b.part === "worker") || a.machine.name.localeCompare(b.machine.name));
