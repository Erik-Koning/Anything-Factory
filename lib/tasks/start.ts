// An ask to start a new team, from the web app (docs/plans/run-from-the-site.md), and where it stands. The ask is a
// control of kind `start` under the new team's name, by the admin who made it; the machine it names answers with
// controls of kind `starting`, one per step. A machine takes asks only once its operator said so at its terminal
// (a6g connect app --projects <dir>), and only for a repository in that folder (lib/orders.ts).
//
// Shared by the CLI and the web app: pure.
import { UNSHOWN } from "../untrusted.ts";
import type { Limits } from "./controls.ts";

// The same shape as a team's name in team.json (lib/config.ts TEAM_NAME), and as a subscription's
// (lib/subscriptions.ts SUBSCRIPTION_NAME): kept here too, so the web app's bundle needs neither module.
export const START_TEAM = /^[a-z][a-z0-9-]{0,30}$/;
export const START_SUBSCRIPTION = /^[a-z0-9][a-z0-9-]{0,39}$/;
// A repository's folder in the machine's projects folder: one path segment, never a hidden one.
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The app's id for a linked machine (web/server/machines.ts), which the machine keeps in ~/.a6g/app.json.
export const MACHINE_ID = /^m[0-9a-f]{24}$/;

export const START_LIMITS = { title: 80, goal: 4000, use: 8 } as const;
// An ask no machine has picked up for this long is dropped.
export const START_EXPIRES_HOURS = 24;

export interface StartAsk {
  // The linked machine it's for, and that machine's name, for people.
  machine: string;
  machineName: string;
  title: string;
  // A repository already in the machine's projects folder, by its folder's name, or one to make there.
  repo: { existing: string } | { create: string };
  // What should exist when the team is done, in the operator's words.
  goal: string;
  // Whether the operator has a view on the platform and the stack: the team agrees its design with them before any
  // feature (team.json operator.designCheckIn), or chooses for them and never asks (operator.technical false).
  technical: boolean;
  limits: Limits | null;
  // The subscriptions the team runs on, in order; none: the machine's own login.
  use: string[];
}

// The steps a machine reports, in order; the last three end it.
export const START_STEPS = ["picked-up", "repository", "draft", "setup", "check", "register", "started", "failed", "refused"] as const;
export type StartStep = (typeof START_STEPS)[number];
export const startEnded = (step: StartStep | "waiting"): boolean => step === "started" || step === "failed" || step === "refused";

export interface StartProgress {
  // The ask it answers, by its control's id (k1, …).
  of: string;
  step: StartStep;
  // For a step that failed or was refused: the step it stopped at, and why, in words for the operator.
  stoppedAt?: StartStep | null;
  problem: string | null;
  // What the command that failed last said, in its own words (its last lines), when one did.
  said?: string | null;
  // What the operator can do about it at the machine's terminal, when anything: the words, and the command to run
  // there, apart, so a page can show the command as one.
  fix?: string | null;
  command?: string | null;
}

// Each step, as the Teams page says it while it's under way.
export const STEP_WORDS: Record<StartStep | "waiting", string> = {
  waiting: "Waiting for the Mac to pick it up",
  "picked-up": "Getting ready",
  repository: "Making the repository",
  draft: "Drafting the team's rules",
  setup: "Setting the team up",
  check: "Proving the setup",
  register: "Registering the team",
  started: "Started",
  failed: "Stopped",
  refused: "Refused",
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// A goal runs to paragraphs: each line is held to what a page may show (lib/untrusted.ts), a tab aside.
const shown = (text: string): boolean => text.split(/\r?\n/).every((line) => !UNSHOWN.test(line.replaceAll("\t", " ")));

// A team's short name from a title: "Shop redesign 2" is shop-redesign-2; "" when nothing in it can be one.
export function slugOf(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const named = /^[a-z]/.test(slug) ? slug : slug ? `team-${slug}` : "";
  return named.slice(0, 31).replace(/-+$/, "");
}

// The ask in `input`, rebuilt from the fields it may have, or what's wrong with it, in words for the form. Both sides
// call it: the web app before it records one, and the machine before it acts on one.
export function startFrom(input: unknown): StartAsk | { problem: string } {
  if (!isObject(input)) return { problem: "That isn't an ask to start a team." };
  const { machine, machineName, title, repo, goal, technical, limits, use } = input;
  if (typeof machine !== "string" || !MACHINE_ID.test(machine)) return { problem: "Choose the Mac that runs it." };
  if (typeof machineName !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(machineName)) return { problem: "Choose the Mac that runs it." };
  if (typeof title !== "string" || !title.trim()) return { problem: "Give the project a title." };
  if (title.length > START_LIMITS.title || UNSHOWN.test(title)) return { problem: `Keep the title to one line of ${START_LIMITS.title} characters.` };
  if (!isObject(repo)) return { problem: "Choose a repository, or name a new one." };
  const existing = repo["existing"];
  const create = repo["create"];
  const name = typeof existing === "string" ? existing : typeof create === "string" ? create : "";
  if ((existing === undefined) === (create === undefined) || !REPO_NAME.test(name) || name.endsWith(".git") || /\.\./.test(name))
    return { problem: "A repository's folder is letters, digits, dots, dashes and underscores, like shop-redesign." };
  if (typeof goal !== "string" || !goal.trim()) return { problem: "Say what should exist when the team is done." };
  if (goal.length > START_LIMITS.goal || !shown(goal)) return { problem: `Keep what should exist to ${START_LIMITS.goal} characters of plain text.` };
  if (typeof technical !== "boolean") return { problem: "Say whether the team agrees its design with you first." };
  if (!Array.isArray(use) || use.length > START_LIMITS.use || use.some((sub) => typeof sub !== "string" || !START_SUBSCRIPTION.test(sub)))
    return { problem: "Choose the subscriptions from the Mac's own." };
  const kept = limitsFrom(limits);
  if (kept === undefined) return { problem: "The budget is a number for each limit, or none." };
  return {
    machine,
    machineName,
    title: title.trim(),
    repo: typeof existing === "string" ? { existing: name } : { create: name },
    // A form sends a text area's lines with carriage returns: the brief and the README take plain new lines.
    goal: goal.replace(/\r\n?/g, "\n").trim(),
    technical,
    limits: kept,
    use: [...new Set(use as string[])],
  };
}

// A budget as an ask may carry it: every limit a number or null, none of the per-subscription limits. Undefined when
// it's something else.
function limitsFrom(input: unknown): Limits | null | undefined {
  if (input === null || input === undefined) return null;
  if (!isObject(input)) return undefined;
  const amount = (value: unknown): number | null | undefined =>
    value === null || value === undefined
      ? null
      : typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000
        ? value
        : undefined;
  const daily = amount(input["daily"]);
  const weekly = amount(input["weekly"]);
  const total = amount(input["total"]);
  if (daily === undefined || weekly === undefined || total === undefined) return undefined;
  const unit = input["unit"] === "subscription" ? "subscription" : "usd";
  const since = typeof input["since"] === "string" && !Number.isNaN(Date.parse(input["since"])) ? input["since"] : new Date().toISOString();
  if (daily === null && weekly === null && total === null) return null;
  return { daily, weekly, total, unit, since, autoResume: input["autoResume"] === true };
}

// The repository's folder name an ask names, and whether the machine makes it.
export const repoOf = (ask: Pick<StartAsk, "repo">): { name: string; create: boolean } =>
  "existing" in ask.repo ? { name: ask.repo.existing, create: false } : { name: ask.repo.create, create: true };
