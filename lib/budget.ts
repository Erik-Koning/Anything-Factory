// A team's budget, enforced (tasks/controls.ts Limits, against tasks/spend.ts Spend). At four fifths of a limit the
// operator is warned, once per limit and period. At the limit the team pauses after the work under way; past it by a
// tenth it pauses now, since finishing that work costs too. A pause the budget made that the operator then resumed
// stays resumed for that limit and period, until they change the budget: they chose to carry on. With autoResume, a
// team only the budget paused starts again once nothing is over: when the next day or week starts, for a pause for a
// day or a week, or when the operator changes the budget so that nothing is (raising the total included). Pure: the
// watchdog applies what this decides, as controls in the team's store, the same as the operator's.
import { type Control, holdOf, type Limits, pauseControl, resumeControl } from "./tasks/controls.ts";
import type { Task } from "./tasks/model.ts";
import { type AccountSpend, dollars, limitDollars, percentOf, type Spend, weekOf } from "./tasks/spend.ts";

export const WARN_AT = 0.8;
export const HARD_AT = 1.1;
const LIMITS = [
  { name: "daily", spent: "today", per: "a day" },
  { name: "weekly", spent: "week", per: "a week" },
  { name: "total", spent: "total", per: "in all" },
] as const;

export interface BudgetMove {
  // Warnings to send, each once: `key` names its limit and period.
  warn: { key: string; text: string }[];
  // A pause or resume to make, and why, in words for the operator.
  control: Omit<Control, "id" | "version"> | null;
  why: string | null;
}

// The period a limit counts: today, this week (from Monday) or since the budget began, on the lead's clock.
function periodOf(name: (typeof LIMITS)[number]["name"], spend: Spend, limits: Limits): string {
  if (name === "daily") return `daily:${spend.day}`;
  if (name === "weekly") return `weekly:${weekOf(new Date(`${spend.day}T12:00:00`))}`;
  return `total:${limits.since.slice(0, 10)}`;
}

// What was spent against a limit, in words: shares of a subscription's week when the budget is in shares and the week
// is known, dollars otherwise.
function spentWords(spent: number, cap: number, per: string, limits: Limits, week: number | null | undefined): string {
  return limits.unit === "subscription" && week
    ? `${percentOf(spent, week)}% of the ${cap}% ${per} budget (shares of a subscription's week)`
    : `${dollars(spent)} of the ${dollars(cap)} ${per} budget`;
}

// Each of the team's limits on one subscription (Limits.accounts), against what it spent there, in that subscription's
// week when the budget is in shares: its share of the limit, or null when the week isn't measured yet.
function accountShares(
  limits: Limits | null,
  spend: Spend
): { name: string; limit: (typeof LIMITS)[number]; cap: number; share: number | null; said: string }[] {
  const out: { name: string; limit: (typeof LIMITS)[number]; cap: number; share: number | null; said: string }[] = [];
  if (!limits) return out;
  for (const [name, caps] of Object.entries(limits.accounts ?? {})) {
    const spent: AccountSpend = spend.accounts?.[name] ?? { today: 0, week: 0, total: 0 };
    const week = spent.subscriptionWeek ?? spend.subscriptionWeek;
    for (const limit of LIMITS) {
      const cap = caps[limit.name];
      if (!cap) continue;
      const capDollars = limitDollars(cap, limits, week);
      const amount = spent[limit.spent];
      out.push({ name, limit, cap, share: capDollars === null ? null : amount / capDollars, said: spentWords(amount, cap, limit.per, limits, week) });
    }
  }
  return out;
}

// The subscriptions the team's own budget on each has closed to it, and why: it moves on to its next one (lib/steer.ts).
export function accountClosures(limits: Limits | null, spend: Spend | null): Record<string, string> {
  const closed: Record<string, string> = {};
  if (!spend) return closed;
  for (const { name, share, said } of accountShares(limits, spend))
    if (share !== null && share >= 1) closed[name] ??= `the team has spent ${said} on ${name}`;
  return closed;
}

// When a pause for these limits ends by itself, in words ("tomorrow", "on Monday"): with autoResume, at the end of the
// longest period among them; null without autoResume, or when the total is among them (that waits for the operator).
export function resumesWhen(names: string[], limits: Pick<Limits, "autoResume"> | null): string | null {
  if (!limits?.autoResume || !names.length || names.some((name) => name !== "daily" && name !== "weekly")) return null;
  return names.includes("weekly") ? "on Monday" : "tomorrow";
}
const nameOf = (trigger: string | null | undefined): string => (trigger ?? "").split(":")[0] ?? "";
// The pauses since the last resume, but the watchdog's record of a hold that settled.
const pausesSinceResume = (controls: Control[]): Control[] =>
  controls.slice(controls.findLastIndex((c) => c.kind === "resume") + 1).filter((c) => c.kind === "pause" && c.by !== "watchdog");
// When the team's pause ends by itself, at the earliest (another limit may be over by then): only one the budget alone
// made, with autoResume. Null otherwise.
export function pausedUntil(controls: Control[], limits: Limits | null): string | null {
  const pauses = pausesSinceResume(controls);
  return pauses.length && pauses.every((c) => c.by === "budget")
    ? resumesWhen(
        pauses.map((c) => nameOf(c.trigger)),
        limits
      )
    : null;
}

export function budgetCheck(team: string, limits: Limits | null, spend: Spend, controls: Control[], all: Task[], paused: boolean): BudgetMove {
  const move: BudgetMove = { warn: [], control: null, why: null };
  if (!limits) return move;
  const hold = holdOf(controls);
  // The operator carried on past a pause the budget made for this limit and period, and hasn't changed the budget since:
  // its own limits, that is (a change to its limits on one subscription alone decides nothing about that pause).
  const own = (l: Limits | null): string => JSON.stringify(l ? [l.daily, l.weekly, l.total, l.unit ?? "usd", l.since] : null);
  let lastChange = -1;
  let was: string | null = null;
  controls.forEach((c, i) => {
    if (c.kind !== "budget") return;
    if (own(c.limits) !== was) lastChange = i;
    was = own(c.limits);
  });
  const overridden = (trigger: string): boolean => {
    const paused = controls.findIndex((c) => c.kind === "pause" && c.by === "budget" && c.trigger?.startsWith(trigger));
    if (paused < 0) return false;
    const resumed = controls.findIndex((c, i) => i > paused && c.kind === "resume" && c.by !== "budget");
    return resumed > paused && resumed > lastChange;
  };
  let graceful: BudgetMove["control"] = null;
  let hard: BudgetMove["control"] = null;
  let why: string | null = null;
  let over = false;
  const overNames: string[] = [];
  for (const limit of LIMITS) {
    const cap = limits[limit.name];
    if (!cap) continue;
    const spent = spend[limit.spent];
    // A share of a subscription needs the subscription measured first (lib/subscriptions.ts); until then it isn't checked.
    const capDollars = limitDollars(cap, limits, spend.subscriptionWeek);
    const week = spend.subscriptionWeek;
    if (capDollars === null) {
      if (!move.warn.some((w) => w.key === "budget-unmeasured"))
        move.warn.push({
          key: "budget-unmeasured",
          text: "The team's budget is in shares of a subscription, and there's no reading of the subscription yet (a6g subscriptions): it isn't checked until there is.",
        });
      continue;
    }
    const share = spent / capDollars;
    const trigger = periodOf(limit.name, spend, limits);
    const said = spentWords(spent, cap, limit.per, limits, week);
    if (share >= WARN_AT)
      move.warn.push({
        key: `budget-${trigger}-${cap}${limits.unit === "subscription" ? "pct" : ""}`,
        text: `The team has spent ${said} (API-equivalent).`,
      });
    if (share < 1 || overridden(trigger)) continue;
    over = true;
    overNames.push(limit.name);
    if (share >= HARD_AT && !paused && hold?.scope !== "now" && !hard) {
      hard = { ...pauseControl(all, team, { scope: "now", by: "budget", note: `${said} is spent, and more` }), trigger: `${trigger}:hard` };
      why = `The team has spent ${said}, a tenth past it: it's paused now.`;
    } else if (!paused && !hold && !graceful) {
      graceful = { ...pauseControl(all, team, { scope: "tasks", by: "budget", note: `${said} is spent` }), trigger };
      why ??= `The team has spent ${said}: it pauses once the work under way is merged.`;
    }
  }
  // The team's budget on one subscription: a warning at four fifths, and at the limit word that the team moves on (the
  // watchdog closes that subscription to it, lib/steer.ts).
  for (const { name, limit, cap, share, said } of accountShares(limits, spend)) {
    if (share === null) {
      if (!move.warn.some((w) => w.key === "budget-unmeasured"))
        move.warn.push({
          key: "budget-unmeasured",
          text: "The team's budget is in shares of a subscription, and there's no reading of the subscription yet (a6g subscriptions): it isn't checked until there is.",
        });
      continue;
    }
    if (share < WARN_AT) continue;
    const trigger = `${periodOf(limit.name, spend, limits)}@${name}`;
    const pct = limits.unit === "subscription" ? "pct" : "";
    move.warn.push(
      share >= 1
        ? {
            key: `budget-${trigger}-${cap}${pct}-spent`,
            text: `The team has spent ${said} on ${name}: it moves to its next subscription, and roles with none left wait.`,
          }
        : { key: `budget-${trigger}-${cap}${pct}`, text: `The team has spent ${said} on ${name} (API-equivalent).` }
    );
  }
  move.control = hard ?? graceful;
  // The operator hears when it starts again by itself, if it does: at the end of the longest period that's over.
  const when = resumesWhen(overNames, limits);
  move.why = move.control && why ? `${why}${when ? ` With auto-resume, it starts again ${when}.` : ""}` : null;
  // A team only the budget paused, since the last resume, starts again once nothing is over: a new day or week ends a
  // pause for the last one, and a change to the budget since the last pause ends any (the operator chose the new
  // limits). A pause of the operator's keeps it paused; the watchdog's record of a settled hold is neither.
  const pauses = pausesSinceResume(controls);
  const last = pauses.at(-1);
  const onlyBudget = pauses.length > 0 && pauses.every((c) => c.by === "budget");
  // For a day or week that's over (a pause for the total waits for the operator).
  const ended = (c: Control): boolean => {
    const name = nameOf(c.trigger);
    return (name === "daily" || name === "weekly") && !(c.trigger ?? "").startsWith(periodOf(name, spend, limits));
  };
  const changed = last !== undefined && lastChange > controls.indexOf(last);
  if (!move.control && !over && limits.autoResume && onlyBudget && last?.trigger && (changed || pauses.every(ended))) {
    if (changed) {
      move.control = { ...resumeControl(team, "budget", "the budget changed, and nothing is over it now"), trigger: "budget" };
      move.why = "The budget changed, and the team is under every limit now, so it starts again.";
    } else {
      // The longest period that ended: a new week ends a daily pause too.
      const name = pauses.some((c) => nameOf(c.trigger) === "weekly") ? "weekly" : "daily";
      const period = name === "daily" ? "day" : "week";
      move.control = {
        ...resumeControl(team, "budget", `a new ${period}: the ${name} budget starts again`),
        trigger: periodOf(name, spend, limits),
      };
      move.why = `A new ${period}, so the team the ${name} budget paused starts again.`;
    }
  }
  return move;
}
