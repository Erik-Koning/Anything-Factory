// A team as the web app sees it, in the shared MongoDB beside its task graph: its settings, which the lead publishes
// when it registers (the app has no team.json), and its state, which the lead's watchdog refreshes every run.
import type { Team } from "../config.ts";
import type { HoldState } from "./controls.ts";
import type { Spend } from "./spend.ts";
import type { ApprovalRules } from "./model.ts";

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
  publishedAt: string;
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
  // Its lead ends a pause asked to end at the usage limit's reset (controls.ts Control.until): reported by a factory
  // version that does, so the web app offers it only where it will be read.
  untilReset?: boolean;
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

export const settingsOf = (team: Team, factory: string): TeamSettings => ({
  name: team.name,
  title: team.title,
  mode: team.mode,
  approval: team.approval,
  roles: Object.keys(team.roles),
  branch: team.branch,
  factory,
  operator: team.operator,
  publishedAt: new Date().toISOString(),
});
