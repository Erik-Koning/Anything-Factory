// A team's use and spend as the store keeps them (lib/usage.ts collects them from the transcripts): the documents, and
// the sums budgets and the web app read. Pure, for the CLI and the web app alike.
import type { Limits } from "./controls.ts";
import type { Task } from "./model.ts";

// A day's use by one role, model, task and subscription.
export interface UsageRow {
  role: string;
  model: string;
  task: string | null;
  // The subscription it ran on (lib/subscriptions.ts), by its name on the machine that counted it; missing in rows
  // counted before 0.7.0, which all ran on that machine's own login.
  account?: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // API-equivalent US dollars; requests of a model the price table doesn't know add nothing, and are counted here.
  cost: number;
  unpriced: number;
}

// One machine's use on one day (a calendar day on that machine's clock, YYYY-MM-DD).
export interface UsageDay {
  team: string;
  day: string;
  machine: string;
  rows: UsageRow[];
  updatedAt: string;
}

// A calendar day on the clock that counted it, YYYY-MM-DD.
export const dayOf = (at: Date): string => at.toLocaleDateString("sv-SE");

export const round = (dollars: number): number => Math.round(dollars * 1e6) / 1e6;

// The Monday of `at`'s week, on the same clock as dayOf.
export function weekOf(at: Date): string {
  const monday = new Date(at);
  monday.setDate(at.getDate() - ((at.getDay() + 6) % 7));
  return dayOf(monday);
}

// What a team spent: today, this week (from Monday) and since `since` (a day; every day when null), every machine's
// added up, with the requests no price covered.
export interface Spend {
  // Today on the clock that counted it (dayOf): where the web app's charts end, whatever its own clock says.
  day: string;
  today: number;
  week: number;
  total: number;
  since: string | null;
  unpriced: number;
  at: string;
  // One Claude subscription's week in API-equivalent dollars, as last measured (lib/subscriptions.ts); null before.
  subscriptionWeek?: number | null;
  // What each subscription's own usage report said, for the record.
  subscriptions?: { account: string; percent: number; resetsAt: string }[];
  // The same figures for each subscription the team ran on, with that subscription's week in dollars as last measured.
  accounts?: Record<string, AccountSpend>;
}
export interface AccountSpend {
  today: number;
  week: number;
  total: number;
  subscriptionWeek?: number | null;
}

// Rows from before subscriptions were told apart ran on the counting machine's own login, "default" by its name.
export const OWN_LOGIN = "default";

export function spendOf(days: UsageDay[], now: Date, since: string | null = null): Spend {
  const today = dayOf(now);
  const week = weekOf(now);
  const from = since ? dayOf(new Date(since)) : null;
  const spend: Spend = { day: today, today: 0, week: 0, total: 0, since: from, unpriced: 0, at: now.toISOString() };
  const accounts: Record<string, AccountSpend> = {};
  for (const day of days) {
    for (const row of day.rows) {
      const account = (accounts[row.account ?? OWN_LOGIN] ??= { today: 0, week: 0, total: 0 });
      if (day.day === today) account.today += row.cost;
      if (day.day >= week) account.week += row.cost;
      if (!from || day.day >= from) account.total += row.cost;
    }
    const cost = day.rows.reduce((sum, r) => sum + r.cost, 0);
    if (day.day === today) spend.today += cost;
    if (day.day >= week) spend.week += cost;
    if (!from || day.day >= from) {
      spend.total += cost;
      spend.unpriced += day.rows.reduce((sum, r) => sum + r.unpriced, 0);
    }
  }
  for (const account of Object.values(accounts))
    Object.assign(account, { today: round(account.today), week: round(account.week), total: round(account.total) });
  return { ...spend, today: round(spend.today), week: round(spend.week), total: round(spend.total), accounts };
}

// The week in dollars a share of "a subscription's week" means for a team that ran on several: what it spent this week
// over the shares of each one's week that was (so its percentage is the sum of each subscription's). Null when a
// subscription it spent on hasn't been measured, or it spent nothing this week.
export function blendedWeek(accounts: Record<string, AccountSpend>, weeks: Record<string, number | null>): number | null {
  let spent = 0;
  let share = 0;
  for (const [name, account] of Object.entries(accounts)) {
    if (!account.week) continue;
    const week = weeks[name];
    if (!week) return null;
    spent += account.week;
    share += account.week / week;
  }
  return share ? round(spent / share) : null;
}

// Spend by journey and by task, every machine's and day's in `days` added up: a task's cost goes to its journey too
// (its parent), and what ran on no task's branch (the planner's own work) is "the planner and the team". Most first.
export function spendByWork(days: UsageDay[], tasks: Task[]): { journeys: { id: string | null; cost: number }[]; tasks: { id: string; cost: number }[] } {
  const parent = new Map(tasks.map((t) => [t.id, t.kind === "journey" ? t.id : t.parent]));
  const byTask = new Map<string, number>();
  const byJourney = new Map<string | null, number>();
  for (const day of days)
    for (const row of day.rows) {
      if (row.task) byTask.set(row.task, (byTask.get(row.task) ?? 0) + row.cost);
      const journey = row.task ? (parent.get(row.task) ?? null) : null;
      byJourney.set(journey, (byJourney.get(journey) ?? 0) + row.cost);
    }
  const sorted = <K>(map: Map<K, number>) => [...map].map(([id, cost]) => ({ id, cost: round(cost) })).sort((a, b) => b.cost - a.cost);
  return { journeys: sorted(byJourney), tasks: sorted(byTask) };
}

// Dollars in words: cents under $10, whole dollars to $10,000 (with a thousands comma), then compact.
export function dollars(n: number): string {
  if (n >= 10_000) return `$${Math.round(n / 1000)}K`;
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

// What a team spent, against its budget when it has one, in a line; this week by subscription when it ran on more than
// one, or on one with a limit of its own.
export function describeSpend(spend: Spend, limits: Limits | null): string {
  const week = spend.subscriptionWeek ?? null;
  const sub = limits?.unit === "subscription";
  const of = (cap: number | null | undefined) => (cap ? ` of ${sub ? `${cap}%` : dollars(cap)}` : "");
  const figure = (n: number) => (sub && week ? `${percentOf(n, week)}%` : dollars(n));
  const parts = [
    `${figure(spend.today)} today${of(limits?.daily)}`,
    `${figure(spend.week)} this week${of(limits?.weekly)}`,
    `${figure(spend.total)} ${spend.since ? `since ${spend.since}` : "in all"}${of(limits?.total)}`,
  ];
  const unit = sub
    ? week
      ? ` (shares of one subscription's week, about ${dollars(week)} API-equivalent)`
      : " (API-equivalent dollars: no subscription reading yet, so the budget's shares aren't checked)"
    : week
      ? ` (this week is ${percentOf(spend.week, week)}% of a subscription's week)`
      : "";
  const by = Object.entries(spend.accounts ?? {});
  const each =
    by.length > 1 || Object.keys(limits?.accounts ?? {}).length
      ? `; this week by subscription: ${by
          .map(([name, a]) => {
            const own = limits?.accounts?.[name]?.weekly;
            const share = a.subscriptionWeek ? ` (${percentOf(a.week, a.subscriptionWeek)}% of its week)` : "";
            return `${name} ${dollars(a.week)}${share}${own ? ` of ${sub ? `${own}%` : dollars(own)}` : ""}`;
          })
          .join(", ")}`
      : "";
  return `Spent${sub && week ? "" : " (API-equivalent)"}: ${parts.join(", ")}${unit}${each}${spend.unpriced ? `; ${spend.unpriced} requests of models with no price` : ""}.`;
}

// `dollars` as a percentage of one subscription's week (`week` dollars), to one decimal below 10%.
export const percentOf = (dollars: number, week: number): number => {
  const p = (dollars / week) * 100;
  return p < 10 ? Math.round(p * 10) / 10 : Math.round(p);
};

// A limit in dollars: as set, or a share of a subscription's week; null when that can't be known yet.
export const limitDollars = (cap: number, limits: Pick<Limits, "unit">, week: number | null | undefined): number | null =>
  limits.unit === "subscription" ? (week ? (cap / 100) * week : null) : cap;

// A limit in words: "$40" or "60% of a subscription's week".
export const limitWords = (cap: number, limits: Pick<Limits, "unit">): string =>
  limits.unit === "subscription" ? `${cap}% of a subscription's week` : dollars(cap);
