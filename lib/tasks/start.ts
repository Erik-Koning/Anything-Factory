// An ask to start a new team, from the web app (docs/plans/run-from-the-site.md), and where it stands. The ask is a
// control of kind `start` under the new team's name, by the admin who made it; the machine it names answers with
// controls of kind `starting`, one per step. A machine takes asks only once its operator said so at its terminal
// (a6g connect app --projects <dir>), and only for a repository in that folder (lib/orders.ts).
//
// Shared by the CLI and the web app: pure.
import { UNSHOWN } from "../untrusted.ts";
import { isLevel, type Level } from "./agreement.ts";
import type { Limits } from "./controls.ts";

// The same shape as a team's name in team.json (lib/config.ts TEAM_NAME), and as a subscription's
// (lib/subscriptions.ts SUBSCRIPTION_NAME): kept here too, so the web app's bundle needs neither module.
export const START_TEAM = /^[a-z][a-z0-9-]{0,30}$/;
export const START_SUBSCRIPTION = /^[a-z0-9][a-z0-9-]{0,39}$/;
// A repository's folder in the machine's projects folder: one path segment, never a hidden one.
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The app's id for a linked machine (web/server/machines.ts), which the machine keeps in ~/.a6g/app.json.
export const MACHINE_ID = /^m[0-9a-f]{24}$/;
// A repository on GitHub, as owner/name: an account's name (letters, digits, single dashes inside) and a repository's.
export const GITHUB_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/;
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// A branch the team starts from: git's own characters, no ".." and nothing that reads as an option.
export const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,100}(?<![./])$/;

export const START_LIMITS = { title: 80, goal: 4000, use: 8 } as const;
// An ask no machine has picked up for this long is dropped.
export const START_EXPIRES_HOURS = 24;

export interface StartAsk {
  // The linked machine it's for, and that machine's name, for people.
  machine: string;
  machineName: string;
  title: string;
  // A repository already in the machine's projects folder, by its folder's name; one to make there (on GitHub too,
  // under the machine's own account, when `publish` says how it's seen); or one on GitHub, cloned into the folder, or
  // its fork when the machine's account can't push to it.
  repo: { existing: string } | { create: string; publish?: "private" | "public" } | { github: string };
  // That the operator trusts the code of a repository whose owner isn't the machine's GitHub account to run there.
  trusted?: boolean;
  // The branch the team's work starts from and its pull requests go into; null: the repository's default.
  base?: string | null;
  // The team's rules, chosen on the form (team.json mode, approval.mode, push), and how readily it asks (the working
  // agreement's level). Missing on an ask from before they were: the setup agent settles them, as it did.
  mode?: "finish" | "cycles";
  approval?: "operator" | "thresholds";
  push?: "none" | "branch" | "pull-request";
  level?: Level;
  // Set up, then wait for the operator: a pause recorded before the team's watch starts.
  hold?: boolean;
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
  // What the step did that the operator should know, in a sentence: the repository cloned or forked, the team waiting.
  note?: string | null;
}

// The settings an ask from before 0.8.2 doesn't carry: a machine that reads them says so in its report
// (projects.github), and the app sends them to no other.
export const NEWER_ASK = ["trusted", "base", "mode", "approval", "push", "level", "hold"] as const;
export const newerAsk = (ask: StartAsk): boolean =>
  "github" in ask.repo || ("create" in ask.repo && ask.repo.publish !== undefined) || NEWER_ASK.some((key) => ask[key] !== undefined);

// Each step, as the Teams page says it while it's under way.
export const STEP_WORDS: Record<StartStep | "waiting", string> = {
  waiting: "Waiting for the Mac to pick it up",
  "picked-up": "Getting ready",
  repository: "Getting the repository",
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
  const { machine, machineName, title, repo, goal, technical, limits, use, trusted, base, mode, approval, push, level, hold } = input;
  if (typeof machine !== "string" || !MACHINE_ID.test(machine)) return { problem: "Choose the Mac that runs it." };
  if (typeof machineName !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(machineName)) return { problem: "Choose the Mac that runs it." };
  if (typeof title !== "string" || !title.trim()) return { problem: "Give the project a title." };
  if (title.length > START_LIMITS.title || UNSHOWN.test(title)) return { problem: `Keep the title to one line of ${START_LIMITS.title} characters.` };
  if (!isObject(repo)) return { problem: "Choose a repository, or name a new one." };
  const existing = repo["existing"];
  const create = repo["create"];
  const github = repo["github"];
  const publish = repo["publish"];
  if ([existing, create, github].filter((value) => value !== undefined).length !== 1) return { problem: "Choose a repository, or name a new one." };
  if (github !== undefined) {
    const named = typeof github === "string" ? githubRepoOf(github) : null;
    if (!named) return { problem: "Name the GitHub repository as owner/name, like octocat/hello-world." };
  } else {
    const name = typeof existing === "string" ? existing : typeof create === "string" ? create : "";
    if (!REPO_NAME.test(name) || name.endsWith(".git") || /\.\./.test(name))
      return { problem: "A repository's folder is letters, digits, dots, dashes and underscores, like shop-redesign." };
  }
  if (publish !== undefined && (create === undefined || (publish !== "private" && publish !== "public")))
    return { problem: "A new repository on GitHub is private or public." };
  if (typeof goal !== "string" || !goal.trim()) return { problem: "Say what should exist when the team is done." };
  if (goal.length > START_LIMITS.goal || !shown(goal)) return { problem: `Keep what should exist to ${START_LIMITS.goal} characters of plain text.` };
  if (typeof technical !== "boolean") return { problem: "Say whether the team agrees its design with you first." };
  if (!Array.isArray(use) || use.length > START_LIMITS.use || use.some((sub) => typeof sub !== "string" || !START_SUBSCRIPTION.test(sub)))
    return { problem: "Choose the subscriptions from the Mac's own." };
  const kept = limitsFrom(limits);
  if (kept === undefined) return { problem: "The budget is a number for each limit, or none." };
  if (trusted !== undefined && typeof trusted !== "boolean") return { problem: "Say whether you trust the repository's code." };
  if (base !== undefined && base !== null && (typeof base !== "string" || !BRANCH_NAME.test(base)))
    return { problem: "The base is a branch's name, like main or develop." };
  if (mode !== undefined && mode !== "finish" && mode !== "cycles") return { problem: "Choose the team's aim: a finish line, or cycles." };
  if (approval !== undefined && approval !== "operator" && approval !== "thresholds") return { problem: "Choose who approves new work." };
  if (push !== undefined && push !== "none" && push !== "branch" && push !== "pull-request") return { problem: "Choose what the team may do on GitHub." };
  if (level !== undefined && !isLevel(level)) return { problem: "Choose how readily the team asks you." };
  if (hold !== undefined && typeof hold !== "boolean") return { problem: "Say whether it starts once it's set up." };
  const repoAsked: StartAsk["repo"] =
    typeof github === "string"
      ? { github: githubRepoOf(github)?.full ?? github }
      : typeof existing === "string"
        ? { existing }
        : { create: create as string, ...(publish === "private" || publish === "public" ? { publish } : {}) };
  return {
    machine,
    machineName,
    title: title.trim(),
    repo: repoAsked,
    // A form sends a text area's lines with carriage returns: the brief and the README take plain new lines.
    goal: goal.replace(/\r\n?/g, "\n").trim(),
    technical,
    limits: kept,
    use: [...new Set(use as string[])],
    ...(trusted === undefined ? {} : { trusted }),
    ...(base === undefined ? {} : { base: base === null || base === "" ? null : base }),
    ...(mode === undefined ? {} : { mode }),
    ...(approval === undefined ? {} : { approval }),
    ...(push === undefined ? {} : { push }),
    ...(level === undefined ? {} : { level }),
    ...(hold === undefined ? {} : { hold }),
  };
}

// A GitHub repository as typed: owner/name, or its address (https://github.com/owner/name, with .git or a trailing
// slash, or git@github.com:owner/name.git). Null for anything else, another host's among them.
export function githubRepoOf(text: string): { owner: string; name: string; full: string } | null {
  const trimmed = text.trim();
  const path = /^(?:https:\/\/)?(?:www\.)?github\.com\/([^?#]+?)\/?$/i.exec(trimmed)?.[1] ?? /^git@github\.com:([^?#]+)$/i.exec(trimmed)?.[1] ?? trimmed;
  const found = GITHUB_REPO.exec(path.replace(/\.git$/i, ""));
  if (!found) return null;
  const [, owner = "", name = ""] = found;
  if (name === "." || name === ".." || name.endsWith(".")) return null;
  return { owner, name, full: `${owner}/${name}` };
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

// The repository's folder name an ask names, and whether the machine makes it (a clone from GitHub is made too: its
// folder is the repository's name).
export const repoOf = (ask: Pick<StartAsk, "repo">): { name: string; create: boolean } =>
  "existing" in ask.repo
    ? { name: ask.repo.existing, create: false }
    : "github" in ask.repo
      ? { name: githubRepoOf(ask.repo.github)?.name ?? ask.repo.github, create: true }
      : { name: ask.repo.create, create: true };
