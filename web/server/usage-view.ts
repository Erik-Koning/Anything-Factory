// The Subscriptions page's figures (app/subscriptions), from what each machine reports of its Claude subscriptions
// (lib/fleet.ts MachineSubscription): pure, so it's tested without a database.
//
// A subscription is its login: the same login reported by two machines is one subscription, its limits as most recently
// read and its usage added up (each machine counts only its own transcripts). Usage is in the API-equivalent dollars
// of lib/prices.ts and in tokens: processed tokens are input, cache reads, cache writes and output together, as T3
// Code counts them.
import { type MachineSubscription, USAGE_FIELDS, type UsageBucket, type UsageField } from "../../lib/fleet.ts";

export type Metric = "limits" | "cost" | "tokens";
export type Period = 1 | 7 | 30 | 90;
export const PERIODS: { days: Period; label: string }[] = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];
export const METRICS: { value: Metric; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
];

export type Totals = Record<UsageField, number>;
export const zero = (): Totals => Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0])) as Totals;
const addInto = (into: Totals, from: Totals | readonly number[]): Totals => {
  USAGE_FIELDS.forEach((field, i) => {
    into[field] += Array.isArray(from) ? (from[i] ?? 0) : (from as Totals)[field];
  });
  return into;
};
export const processed = (t: Totals): number => t.input + t.cacheRead + t.cacheWrite + t.output;
export const valueOf = (t: Totals, metric: Exclude<Metric, "limits">): number => (metric === "cost" ? t.cost : processed(t));

// A machine's report as the page reads it.
export interface Reported {
  machine: { id: string; name: string };
  subscriptions: MachineSubscription[];
}

// One subscription across the machines that report it.
export interface Subscription {
  key: string;
  name: string;
  // Its place in the page's palette, by name, so it keeps its colour whatever is shown.
  colour: number;
  plan: string | null;
  machines: string[];
  // The newest reading's: when, its windows, extra usage and the operator's limits there, and whether it's closed.
  latest: MachineSubscription;
  teams: { team: string; roles: string[] }[];
  sessions: MachineSubscription["sessions"];
  counted: string | null;
  today: string;
  days: Map<string, Map<string, Totals>>;
  hours: Map<string, Map<string, Totals>>;
}

const bucketsInto = (into: Map<string, Map<string, Totals>>, buckets: UsageBucket[]): void => {
  for (const [at, model, ...figures] of buckets) {
    const byModel = into.get(at) ?? new Map<string, Totals>();
    byModel.set(model, addInto(byModel.get(model) ?? zero(), figures));
    into.set(at, byModel);
  }
};

// Every subscription the reports name, one per login (or per machine and name for one signed out), in name order.
export function subscriptionsOf(reports: readonly Reported[]): Subscription[] {
  const by = new Map<string, Subscription>();
  for (const { machine, subscriptions } of reports) {
    for (const sub of subscriptions) {
      const key = sub.login ?? `${machine.id}/${sub.name}`;
      const had = by.get(key);
      if (!had) {
        const fresh: Subscription = {
          key,
          name: sub.name,
          colour: 0,
          plan: sub.plan,
          machines: [machine.name],
          latest: sub,
          teams: [...sub.teams],
          sessions: [...sub.sessions],
          counted: sub.counted,
          today: sub.today,
          days: new Map(),
          hours: new Map(),
        };
        bucketsInto(fresh.days, sub.days);
        bucketsInto(fresh.hours, sub.hours);
        by.set(key, fresh);
        continue;
      }
      if (!had.machines.includes(machine.name)) had.machines.push(machine.name);
      if (!had.name.split(" / ").includes(sub.name)) had.name = `${had.name} / ${sub.name}`;
      if ((sub.at ?? "") > (had.latest.at ?? "")) {
        had.latest = sub;
        had.plan = sub.plan ?? had.plan;
      }
      for (const t of sub.teams) if (!had.teams.some((h) => h.team === t.team)) had.teams.push(t);
      had.sessions = had.sessions.map((n, i) => n + (sub.sessions[i] ?? 0)) as Subscription["sessions"];
      if ((sub.counted ?? "") > (had.counted ?? "")) had.counted = sub.counted;
      if (sub.today > had.today) had.today = sub.today;
      bucketsInto(had.days, sub.days);
      bucketsInto(had.hours, sub.hours);
    }
  }
  const list = [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  list.forEach((sub, i) => {
    sub.colour = i % PALETTE_SIZE;
  });
  return list;
}
export const PALETTE_SIZE = 6;

// --- Cost and tokens ----------------------------------------------------------------------------------------------

// The periods of a window, oldest first: the last `days` days to the newest machine's today, or the last 24 hours to
// the hour `now` is in (UTC hours, as reported).
export function periodsOf(days: Period, subs: readonly Subscription[], now: Date): { hourly: boolean; periods: string[] } {
  if (days === 1) {
    const hour = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    return { hourly: true, periods: Array.from({ length: 24 }, (_, i) => new Date(hour - (23 - i) * 3_600_000).toISOString().slice(0, 13)) };
  }
  const today = subs.reduce((latest, s) => (s.today > latest ? s.today : latest), now.toISOString().slice(0, 10));
  const end = Date.parse(`${today}T12:00:00Z`);
  return { hourly: false, periods: Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10)) };
}

export interface SeriesUsage {
  sub: Subscription;
  totals: Totals;
  // Aligned with the window's periods.
  byPeriod: Totals[];
  sessions: number;
}
export interface ModelUsage {
  model: string;
  totals: Totals;
  // Each subscription's part, aligned with the window's periods.
  bySub: { sub: Subscription; byPeriod: Totals[]; totals: Totals }[];
}
export interface Usage {
  hourly: boolean;
  periods: string[];
  series: SeriesUsage[];
  models: ModelUsage[];
  totals: Totals;
  sessions: number;
}

const SESSIONS_INDEX: Record<Period, number> = { 1: 0, 7: 1, 30: 2, 90: 3 };

export function usageOf(subs: readonly Subscription[], days: Period, now: Date): Usage {
  const { hourly, periods } = periodsOf(days, subs, now);
  const models = new Map<string, ModelUsage>();
  const series = subs.map((sub): SeriesUsage => {
    const source = hourly ? sub.hours : sub.days;
    const byPeriod = periods.map(() => zero());
    const totals = zero();
    periods.forEach((period, i) => {
      for (const [model, t] of source.get(period) ?? []) {
        addInto(byPeriod[i] as Totals, t);
        addInto(totals, t);
        const m = models.get(model) ?? { model, totals: zero(), bySub: [] };
        let part = m.bySub.find((p) => p.sub === sub);
        if (!part) {
          part = { sub, byPeriod: periods.map(() => zero()), totals: zero() };
          m.bySub.push(part);
        }
        addInto(part.byPeriod[i] as Totals, t);
        addInto(part.totals, t);
        addInto(m.totals, t);
        models.set(model, m);
      }
    });
    return { sub, totals, byPeriod, sessions: sub.sessions[SESSIONS_INDEX[days]] ?? 0 };
  });
  const totals = series.reduce((sum, s) => addInto(sum, s.totals), zero());
  return { hourly, periods, series, models: [...models.values()], totals, sessions: series.reduce((n, s) => n + s.sessions, 0) };
}

// Biggest first by the metric, then by the other.
export const ranked = <T extends { totals: Totals }>(list: readonly T[], metric: Exclude<Metric, "limits">): T[] =>
  [...list].sort((a, b) => {
    const other: Exclude<Metric, "limits"> = metric === "cost" ? "tokens" : "cost";
    return valueOf(b.totals, metric) - valueOf(a.totals, metric) || valueOf(b.totals, other) - valueOf(a.totals, other);
  });

export interface Segment {
  key: string;
  label: string;
  value: number;
}
// Processed tokens by kind, and dollars by what they paid for and by speed (fast mode costs twice: its premium is half).
export function tokenSegments(t: Totals): Segment[] {
  return [
    { key: "input", label: "Input", value: t.input },
    { key: "cacheRead", label: "Cache read", value: t.cacheRead },
    { key: "cacheWrite", label: "Cache write", value: t.cacheWrite },
    { key: "output", label: "Output", value: t.output },
  ];
}
export function costSegments(t: Totals): Segment[] {
  const split = t.costInput + t.costCacheRead + t.costCacheWrite + t.costOutput;
  const other = t.cost - split;
  return [
    { key: "input", label: "Input", value: t.costInput },
    { key: "cacheRead", label: "Cache read", value: t.costCacheRead },
    { key: "cacheWrite", label: "Cache write", value: t.costCacheWrite },
    { key: "output", label: "Output", value: t.costOutput },
    ...(other >= 0.005 ? [{ key: "other", label: "Other", value: other }] : []),
  ];
}
export function speedSegments(t: Totals): Segment[] {
  return [
    { key: "standard", label: "Standard", value: Math.max(0, t.cost - 2 * t.fast) },
    { key: "fast", label: "Fast", value: 2 * t.fast },
  ];
}
// What a model's priced tokens cost per million, and how much of its prompt was read from the cache.
export const perMillion = (t: Totals): number | null => {
  const tokens = processed(t);
  return t.cost > 0 && tokens > 0 ? (t.cost / tokens) * 1e6 : null;
};
export const cacheHit = (t: Totals): number | null => {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  return prompt > 0 ? t.cacheRead / prompt : null;
};

// --- Limits -------------------------------------------------------------------------------------------------------

export type WindowKind = "session" | "weekly" | "model" | "monthly";
const DURATION: Record<WindowKind, number | null> = { session: 5 * 3_600_000, weekly: 7 * 86_400_000, model: 7 * 86_400_000, monthly: null };

export interface PoolPart {
  sub: Subscription;
  // Used, 0 to 100, when it resets, and the operator's limit for the factory's teams on it (session and weekly).
  used: number;
  resetsAt: string | null;
  limit: number | null;
  // How far through the window it is, 0 to 1, when that's known; whether it's used up; its weight in the pool.
  elapsed: number | null;
  exhausted: boolean;
  weight: number;
  // For a monthly window: its cap and what's used, in its currency.
  amount?: { used: number | null; cap: number | null; currency: string | null };
}
export interface Pool {
  kind: WindowKind;
  label: string;
  parts: PoolPart[];
  // The pool's used share (weighted), and the next refill: whose, when, and what share of the pool it gives back.
  used: number;
  next: { part: PoolPart; restores: number } | null;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
// A five-hour window weighs what the plan allows in it (Pro 1, Max 5, Ultra 20); every one weighs the same while any
// plan isn't known, and a weekly one always does.
const planWeight = (plan: string | null): number | null =>
  !plan ? null : /ultra/i.test(plan) ? 20 : /max/i.test(plan) ? 5 : /pro/i.test(plan) ? 1 : null;

// How far a window that resets at `resetsAt` and lasts `duration` has run.
export const elapsedOf = (resetsAt: string | null, duration: number | null, now: number): number | null =>
  resetsAt && duration ? clamp((duration - (Date.parse(resetsAt) - now)) / duration, 0, 1) : null;

// Ahead of pace when more is used than the window's time has run (by over five points), under it when less.
export type Pace = "ahead" | "on" | "under";
export const paceOf = (used: number, elapsed: number | null): Pace | null => {
  if (elapsed === null) return null;
  const gap = used - elapsed * 100;
  return gap > 5 ? "ahead" : gap < -5 ? "under" : "on";
};

function pool(kind: WindowKind, label: string, parts: Omit<PoolPart, "weight">[], now: number): Pool {
  const weights = parts.map((p) => (kind === "session" ? planWeight(p.sub.plan) : 1));
  const known = weights.every((w) => w !== null);
  const withWeights: PoolPart[] = parts.map((p, i) => ({ ...p, weight: known ? (weights[i] ?? 1) : 1 }));
  // Soonest reset first, then by name.
  withWeights.sort((a, b) => (a.resetsAt ?? "~").localeCompare(b.resetsAt ?? "~") || a.sub.name.localeCompare(b.sub.name));
  const total = withWeights.reduce((n, p) => n + p.weight, 0) || 1;
  const used = withWeights.reduce((n, p) => n + p.used * p.weight, 0) / total;
  const refilling = withWeights.filter((p) => p.resetsAt && Date.parse(p.resetsAt) > now && p.used > 0);
  const first = refilling[0];
  return { kind, label, parts: withWeights, used, next: first ? { part: first, restores: (first.used * first.weight) / total } : null };
}

// One card per window the subscriptions report: the five-hour session, the week, each model's own week, and extra
// usage by the month, in that order. A subscription whose week is used up has nothing left of its session either.
export function poolsOf(subs: readonly Subscription[], now: Date): Pool[] {
  const t = now.getTime();
  const live = (resetsAt: string | null) => !resetsAt || Date.parse(resetsAt) > t;
  const pools: Pool[] = [];
  const weekSpent = (s: Subscription) => (s.latest.weekly && live(s.latest.weekly.resetsAt) ? s.latest.weekly.percent >= 100 : false);
  const part = (sub: Subscription, kind: WindowKind, used: number, resetsAt: string | null, limit: number | null): Omit<PoolPart, "weight"> => ({
    sub,
    used: clamp(used, 0, 100),
    resetsAt,
    limit,
    elapsed: elapsedOf(resetsAt, DURATION[kind], t),
    exhausted: used >= 100 && live(resetsAt),
  });
  const sessions = subs.filter((s) => s.latest.session && live(s.latest.session.resetsAt));
  if (sessions.length)
    pools.push(
      pool(
        "session",
        "Session",
        sessions.map((s) =>
          part(s, "session", weekSpent(s) ? 100 : (s.latest.session?.percent ?? 0), s.latest.session?.resetsAt ?? null, s.latest.limits.session)
        ),
        t
      )
    );
  const weekly = subs.filter((s) => s.latest.weekly && live(s.latest.weekly.resetsAt));
  if (weekly.length)
    pools.push(
      pool(
        "weekly",
        "Weekly",
        weekly.map((s) => part(s, "weekly", s.latest.weekly?.percent ?? 0, s.latest.weekly?.resetsAt ?? null, s.latest.limits.weekly)),
        t
      )
    );
  const models = [...new Set(subs.flatMap((s) => s.latest.models.map((m) => m.model)))].sort();
  for (const model of models) {
    const parts = subs.flatMap((s) => {
      const m = s.latest.models.find((x) => x.model === model && live(x.resetsAt));
      // A model's week without its own reset time resets with the subscription's week.
      return m ? [part(s, "model", m.percent, m.resetsAt ?? s.latest.weekly?.resetsAt ?? null, null)] : [];
    });
    if (parts.length) pools.push(pool("model", `Weekly · ${model}`, parts, t));
  }
  const monthly = subs.filter((s) => s.latest.extra?.enabled);
  if (monthly.length)
    pools.push(
      pool(
        "monthly",
        "Monthly extra usage",
        monthly.map((s) => {
          const extra = s.latest.extra;
          const used = extra?.limit ? ((extra.used ?? 0) / extra.limit) * 100 : 0;
          return {
            ...part(s, "monthly", used, null, null),
            amount: { used: extra?.used ?? null, cap: extra?.limit ?? null, currency: extra?.currency ?? null },
          };
        }),
        t
      )
    );
  return pools;
}
