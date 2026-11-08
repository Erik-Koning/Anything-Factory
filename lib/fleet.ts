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

// What a machine sends: the app adds when it came, and from which account's link.
export interface MachineReport {
  name: string;
  // The factory version a person runs here (a6g self-install).
  factory: string;
  teams: MachineTeam[];
}

// The most a report may hold; the app refuses a bigger one whole.
export const REPORT_LIMITS = { bytes: 256 * 1024, teams: 100, members: 30, text: 200, home: 1024 } as const;

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

// The report in `body`, rebuilt from the fields it may have (anything else is dropped), or null when any is wrong.
export function parseReport(body: unknown): MachineReport | null {
  if (!isObject(body)) return null;
  const { name, factory, teams } = body;
  if (typeof name !== "string" || !MACHINE_NAME.test(name)) return null;
  if (typeof factory !== "string" || !VERSION.test(factory)) return null;
  if (!Array.isArray(teams) || teams.length > REPORT_LIMITS.teams) return null;
  const parsed = teams.map(parseTeam);
  if (parsed.some((team) => team === null)) return null;
  return { name, factory, teams: parsed as MachineTeam[] };
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
