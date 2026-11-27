// A team as the web app sees it, in the shared MongoDB beside its task graph: its settings, which the lead publishes
// when it registers (the app has no team.json), and its state, which the lead's watchdog refreshes every run.
import type { Team } from "../config.ts";
import type { HoldState } from "./controls.ts";
import type { Spend } from "./spend.ts";
import type { ApprovalRules } from "./model.ts";
import { githubRepoOf } from "./start.ts";

export interface TeamSettings {
  name: string;
  title: string;
  mode: Team["mode"];
  approval: ApprovalRules;
  roles: string[];
  branch: string;
  factory: string;
  // Who the team works for (team.json operator), which the working agreement reads: a team published by a factory
  // version from before the agreement has none, and the app says its agreement isn't read yet.
  operator?: Team["operator"];
  // The repository it works on, from the remote its checkout pushes to (repoOfRemote): a team published by a factory
  // version from before this has none, nor has one whose checkout has no remote, and the app shows nothing for it.
  repo?: TeamRepo | null;
  publishedAt: string;
}
// A repository as the web app shows it: owner/name on GitHub, or a remote's host and path elsewhere; and its page, when
// it has one to link to.
export interface TeamRepo {
  name: string;
  url: string | null;
}
export interface TeamState {
  // paused (by the operator, or a hold that settled), pausing (a graceful hold under way), complete (the finish line
  // held), idle (a cycles team waiting for work), or active.
  state: "active" | "pausing" | "paused" | "idle" | "complete";
  // The operator's latest pause while it's in force (controls.ts), as the watchdog last saw it.
  hold?: HoldState | null;
  // What it has spent (API-equivalent dollars, spend.ts), as of the watchdog's last full run.
  spend?: Spend | null;
  // The planner's thread as T3 Code reports it (running, completed, …), or null when there's none.
  planner: string | null;
  // Members at work, by role.
  members: Record<string, number>;
  // The subscriptions on the lead and which the team runs on (lib/steer.ts): a lead whose factory version takes a
  // `subscriptions` control reports it, so the web app offers the choice only where it will be read.
  subscriptions?: TeamSubscriptions | null;
  at: string;
}
// The Claude subscriptions on a team's lead, as the web app shows them (the folders behind them stay on the machine).
export interface TeamSubscriptions {
  // Each subscription there, by its name: how much of its week is used as last read (null before a reading), when
  // that resets, and why it's closed to the team now, when it is.
  available: { name: string; percent: number | null; resetsAt: string | null; closed: string | null }[];
  // What the operator listed, in order: "*" for every role, or a role's own list. Empty: the lead's own login.
  use: Record<string, string[]>;
  // What each role runs on now (null: the lead's own login), where a role is moving once it's free, and the roles no
  // subscription is open to, with why and until when.
  roles: Record<string, string | null>;
  moving: Record<string, string | null>;
  waiting: Record<string, { why: string; until: string | null }>;
  // The roles on another model than their own for now (Opus, while the subscription has used up Fable's own limit):
  // the model and its name ("Opus"), until when, and why. Missing from a lead whose factory version doesn't fall back.
  models?: Record<string, { model: string; name?: string; until: string | null; why: string }>;
}
export interface TeamDoc extends TeamSettings {
  status: TeamState | null;
}

// `remote`: the address of the remote the team's checkout pushes to, as git has it (null: none).
export const settingsOf = (team: Team, factory: string, remote: string | null = null): TeamSettings => ({
  name: team.name,
  title: team.title,
  mode: team.mode,
  approval: team.approval,
  roles: Object.keys(team.roles),
  branch: team.branch,
  factory,
  operator: team.operator,
  repo: repoOfRemote(remote),
  publishedAt: new Date().toISOString(),
});

// The repository behind a git remote's address, fit to show anyone who can see the team: a GitHub remote, over https
// or ssh, as owner/name with its page; any other as its host and path, linked when it's on the web. Whatever the
// address carries besides (a user, a token, a query) is left out. A folder on the machine is no repository to show:
// its path names the operator's account there, so it's null, as no remote is.
export function repoOfRemote(remote: string | null | undefined): TeamRepo | null {
  const text = remote?.trim() ?? "";
  let host = "";
  let path = "";
  // The page's scheme, for an address on the web; null for ssh or git's own protocol.
  let web: string | null = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol === "file:") return null;
    [host, path, web] = [url.host, url.pathname, url.protocol === "https:" || url.protocol === "http:" ? url.protocol : null];
  } else {
    // git's own short form, [user@]host:path.
    const short = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(\S+)$/.exec(text);
    if (!short) return null;
    [host, path] = [short[1] ?? "", short[2] ?? ""];
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !path) return null;
  const github = /^(?:www\.)?github\.com$/i.test(host) ? githubRepoOf(path) : null;
  if (github) return { name: github.full, url: `https://github.com/${github.full}` };
  return { name: `${host}/${path}`, url: web ? `${web}//${host}/${path}` : null };
}
