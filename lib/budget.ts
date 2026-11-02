// A team's budget, enforced (tasks/controls.ts Limits, against tasks/spend.ts Spend). At four fifths of a limit the
// operator is warned, once per limit and period. At the limit the team pauses after the work under way; past it by a
// tenth it pauses now, since finishing that work costs too. A pause the budget made that the operator then resumed
// stays resumed for that limit and period, until they change the budget: they chose to carry on. With autoResume, a
// team only the budget paused, for a day or a week, starts again when the next one does, if nothing else is over. Pure: the watchdog applies what this
// decides, as controls in the team's store, the same as the operator's.
import { type Control, holdOf, type Limits, pauseControl, resumeControl } from "./tasks/controls.ts";
import type { Task } from "./tasks/model.ts";
import { dollars, type Spend, weekOf } from "./tasks/spend.ts";

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

export function budgetCheck(team: string, limits: Limits | null, spend: Spend, controls: Control[], all: Task[], paused: boolean): BudgetMove {
  const move: BudgetMove = { warn: [], control: null, why: null };
  if (!limits) return move;
  const hold = holdOf(controls);
  // The operator carried on past a pause the budget made for this limit and period, and hasn't changed the budget since.
  const lastChange = controls.findLastIndex((c) => c.kind === "budget");
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
  for (const limit of LIMITS) {
    const cap = limits[limit.name];
    if (!cap) continue;
    const spent = spend[limit.spent];
    const share = spent / cap;
    const trigger = periodOf(limit.name, spend, limits);
    const said = `${dollars(spent)} of the ${dollars(cap)} ${limit.per} budget`;
    if (share >= WARN_AT) move.warn.push({ key: `budget-${trigger}-${cap}`, text: `The team has spent ${said} (API-equivalent).` });
    if (share < 1 || overridden(trigger)) continue;
    over = true;
    if (share >= HARD_AT && !paused && hold?.scope !== "now" && !hard) {
      hard = { ...pauseControl(all, team, { scope: "now", by: "budget", note: `${said} is spent, and more` }), trigger: `${trigger}:hard` };
      why = `The team has spent ${said}, a tenth past it: it's paused now.`;
    } else if (!paused && !hold && !graceful) {
      graceful = { ...pauseControl(all, team, { scope: "tasks", by: "budget", note: `${said} is spent` }), trigger };
      why ??= `The team has spent ${said}: it pauses once the work under way is merged.`;
    }
  }
  move.control = hard ?? graceful;
  move.why = move.control ? why : null;
  // A new day or week: a team only the budget paused, for the last one, starts again unless another limit is over. A
  // pause of the operator's since the last resume keeps it paused; the watchdog's record of a settled hold is neither.
  const pauses = controls.slice(controls.findLastIndex((c) => c.kind === "resume") + 1).filter((c) => c.kind === "pause" && c.by !== "watchdog");
  const last = pauses.at(-1);
  const onlyBudget = pauses.length > 0 && pauses.every((c) => c.by === "budget");
  // Every one of them for a day or week that's over (a pause for the total waits for the operator).
  const ended = (c: Control): boolean => {
    const [name] = (c.trigger ?? "").split(":");
    return (name === "daily" || name === "weekly") && !(c.trigger ?? "").startsWith(periodOf(name, spend, limits));
  };
  if (!move.control && !over && limits.autoResume && onlyBudget && last?.trigger && pauses.every(ended)) {
    const [name] = last.trigger.split(":");
    const period = name === "daily" ? "day" : "week";
    move.control = {
      ...resumeControl(team, "budget", `a new ${period}: the ${name} budget starts again`),
      trigger: periodOf(name as "daily", spend, limits),
    };
    move.why = `A new ${period}, so the team the ${name} budget paused starts again.`;
  }
  return move;
}
