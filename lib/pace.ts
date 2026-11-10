// Pacing: how much work a team starts at once, so that what it starts can finish within its budget. The work under way
// and the next tasks in claim order are each estimated at the team's own cost per unit of finished work; the budget's
// tightest limit, less what's spent, is the room. Builders and testers start, in order, only while their work fits in
// it. Pure but for pace.json: the planner's context hook and a6g task pace work it out (lib/tasks/ops.ts measurePace),
// and the guard holds the planner's starts to what it allows (lib/guard.ts).
import { join } from "node:path";
import type { Hold, Limits } from "./tasks/controls.ts";
import { CLAIMS, claimRank, claimRefusal, sentBack, type Size, SIZES, type Task } from "./tasks/model.ts";
import { dayOf, dollars, limitDollars, limitWords, type Spend, type UsageDay, weekOf } from "./tasks/spend.ts";
import { readJson, writeJson } from "./util.ts";

// Dollars a size unit (S 1, M 2, L 4, XL 8) costs, all in, until a team has a history of its own: the first team's first
// 158 tasks came to about $2.40 a unit, review, planning and ideas included.
export const DEFAULT_UNIT_COST = 3;
// Finished tasks before the team's own cost replaces the default.
export const HISTORY_MIN = 3;
// A start costs at least this share of its estimate however much its branch has used: it isn't merged yet.
const LEAST_LEFT = 0.25;
// How long the guard holds the planner to a pace it worked out; an older one is ignored.
export const PACE_FRESH_MIN = 120;

export interface PaceInput {
  all: Task[];
  // Every day of the team's use (store.usage), for its cost per unit and what each task's branch has used.
  days: UsageDay[];
  spend: Spend | null;
  limits: Limits | null;
  // Members of each role at work now, or null when T3 Code couldn't say.
  running: Record<string, number> | null;
  // The team's limit for each role that claims tasks.
  slots: Record<string, number>;
  hold?: Hold | null;
  now?: Date;
}
export interface Start {
  id: string;
  role: string;
  size: Size;
  // What it adds to the work under way: its estimate, or nothing for a task going back to its own branch.
  cost: number;
}
export interface Pace {
  unitCost: number;
  basis: "history" | "default";
  // Dollars left under the budget's tightest limit, and that limit in words; null without a budget that's measured.
  left: number | null;
  limit: string | null;
  // What the work under way will still cost.
  underWay: number;
  // What may start now, in claim order, and the next new task that doesn't fit in the budget; `tooBig` when it's more
  // than a day's or a week's limit could ever pay for at once, so waiting won't make room for it.
  starts: Start[];
  waiting: Start | null;
  tooBig: boolean;
  // When the budget is what stops the next start: how many new members of each role may start until it has more room.
  allow: Record<string, number> | null;
  // Why, as the guard says it.
  why: string | null;
  text: string;
}

export const sizeOf = (t: Task): Size => t.score?.size ?? "M";
// When the merge queue merged it: finished work. A task closed because it was folded into another, or marked done by
// the planner, built nothing.
const mergedAt = (t: Task): string | null => (t.status === "done" && t.sha ? (t.history.findLast((e) => e.to === "done")?.at ?? t.updatedAt) : null);
// Work that's begun: being built, in review, or sent back for changes with its branch made.
const begun = (t: Task): boolean => t.status === "building" || t.status === "review" || sentBack(t);

// What a size unit of finished work has cost this team: everything it spent since its use was first counted, over the
// size units of the tasks merged since then. The default until it has finished HISTORY_MIN.
export function unitCostOf(all: Task[], days: UsageDay[]): { unitCost: number; basis: "history" | "default" } {
  const first = days.map((d) => d.day).sort()[0];
  const spent = days.reduce((sum, d) => sum + d.rows.reduce((s, r) => s + r.cost, 0), 0);
  const finished = first ? all.filter((t) => t.kind !== "journey" && t.kind !== "research" && (mergedAt(t)?.slice(0, 10) ?? "") >= first) : [];
  const units = finished.reduce((sum, t) => sum + SIZES[sizeOf(t)], 0);
  return finished.length >= HISTORY_MIN && spent > 0 ? { unitCost: spent / units, basis: "history" } : { unitCost: DEFAULT_UNIT_COST, basis: "default" };
}

// What's spent as of `now`: spend.json is the watchdog's, minutes old (or more, with the store out of reach), so on a new
// day nothing is spent today yet, and in a new week nothing this week.
export function spendAsOf(spend: Spend, now = new Date()): Spend {
  const today = dayOf(now);
  if (!spend.day || spend.day >= today) return spend;
  const sameWeek = weekOf(new Date(`${spend.day}T12:00:00`)) === weekOf(now);
  return { ...spend, day: today, today: 0, week: sameWeek ? spend.week : 0 };
}

// The budget's tightest limit: dollars left under it, which it is, and the limit in words. And the ceiling: the smallest
// daily or weekly limit, the most the budget could ever pay for at once. Null without a budget that's measured.
export interface Room {
  left: number;
  name: "daily" | "weekly" | "total";
  limit: string;
  ceiling: { dollars: number; limit: string } | null;
}
export function roomOf(spend: Spend | null, limits: Limits | null, now = new Date()): Room | null {
  if (!spend || !limits) return null;
  const spent = spendAsOf(spend, now);
  let room: Room | null = null;
  let ceiling: Room["ceiling"] = null;
  for (const [name, used] of [
    ["daily", spent.today],
    ["weekly", spent.week],
    ["total", spent.total],
  ] as const) {
    const cap = limits[name];
    if (!cap) continue;
    const capDollars = limitDollars(cap, limits, spend.subscriptionWeek);
    if (capDollars === null) continue;
    const words = `the ${name} ${limitWords(cap, limits)}`;
    if (name !== "total" && (!ceiling || capDollars < ceiling.dollars)) ceiling = { dollars: capDollars, limit: words };
    const left = Math.max(0, capDollars - used);
    if (!room || left < room.left) room = { left, name, limit: words, ceiling: null };
  }
  return room && { ...room, ceiling };
}

const ids = (starts: Start[]): string => starts.map((s) => `#${s.id}`).join(", ");
// A task going back to its branch is named in the brief: an unnamed claim takes the next in order.
const est = (s: Start): string => `#${s.id} (${s.size}, ${s.cost ? `about ${dollars(s.cost)}` : "back to its branch: name it in the brief"})`;

export function pace({ all, days, spend, limits, running, slots, hold = null, now = new Date() }: PaceInput): Pace {
  const { unitCost, basis } = unitCostOf(all, days);
  const costOf = (t: Task): number => unitCost * SIZES[sizeOf(t)];
  const used = new Map<string, number>();
  for (const day of days) for (const row of day.rows) if (row.task) used.set(row.task, (used.get(row.task) ?? 0) + row.cost);
  const underWay = all.filter(begun).reduce((sum, t) => sum + Math.max(costOf(t) - (used.get(t.id) ?? 0), costOf(t) * LEAST_LEFT), 0);
  const room = roomOf(spend, limits, now);

  // Claims in order, as builders and testers would make them: each role up to its free slots, each claim keeping the
  // next off its files, each start only while the budget has room for it after the work under way. The first new task
  // that doesn't fit holds the queue: nothing new behind it starts. Work sent back to its own branch (a rebase, or
  // changes asked for) is in the work under way already, and finishing it is what the budget waits for, so it goes back
  // whatever is left, behind that task too.
  const roles = Object.keys(slots).filter((role) => CLAIMS[role]);
  const free = Object.fromEntries(roles.map((role) => [role, Math.max(0, (slots[role] ?? 0) - (running?.[role] ?? 0))]));
  let graph = all;
  let committed = underWay;
  const starts: Start[] = [];
  let waiting: Start | null = null;
  for (;;) {
    const rank = claimRank(graph);
    const next = roles
      .filter((role) => (free[role] ?? 0) > 0)
      .flatMap((role) => {
        const t = graph.filter((x) => (!waiting || sentBack(x)) && claimRefusal(x, role, graph, hold) === null).sort(rank)[0];
        return t ? [{ t, role }] : [];
      })
      .sort((x, y) => rank(x.t, y.t))[0];
    if (!next) break;
    const start = { id: next.t.id, role: next.role, size: sizeOf(next.t), cost: sentBack(next.t) ? 0 : costOf(next.t) };
    if (room && start.cost > 0 && committed + start.cost > room.left) {
      waiting = start;
      continue;
    }
    starts.push(start);
    committed += start.cost;
    free[next.role] = (free[next.role] ?? 0) - 1;
    graph = graph.map((x) => (x.id === next.t.id ? { ...x, status: "building" as const } : x));
  }
  const tooBig = Boolean(waiting && room?.ceiling && waiting.cost > room.ceiling.dollars);

  const at = roles.map((role) => `${role} ${running ? (running[role] ?? 0) : "?"}/${slots[role] ?? 0}`).join(", ");
  const unit = `Estimates: ${dollars(unitCost)} a size unit (S 1, M 2, L 4, XL 8), ${basis === "history" ? "what the team has spent per unit of finished work" : `a default until ${HISTORY_MIN} tasks are done`}.`;
  const budget = room
    ? `Budget: ${dollars(room.left)} left under ${room.limit}; the work under way needs about ${dollars(underWay)}.`
    : "No budget is measured, so only the role limits hold.";
  const startLine = starts.length
    ? `Start ${starts.length} now, in order: ${starts.map((s) => `${s.role} for ${est(s)}`).join("; ")}.`
    : waiting
      ? "Start nothing new now."
      : roles.some((role) => (free[role] ?? 0) > 0)
        ? "Nothing approved can be claimed now."
        : "Every slot is taken.";
  const later = { daily: "wait for tomorrow's budget", weekly: "wait for next week's", total: "raise it with the operator" }[room?.name ?? "total"];
  const held = !waiting
    ? null
    : tooBig && room?.ceiling
      ? `${est(waiting)} is next, and it's more than ${room.ceiling.limit} could ever pay for at once: split it now into parts that fit (a6g task add … --after), and the work behind it waits until you do.`
      : `${est(waiting)} is next and doesn't fit: let the work under way finish and merge, split it smaller, or ${later}.`;
  const allow = waiting ? Object.fromEntries(roles.map((role) => [role, starts.filter((s) => s.role === role).length])) : null;
  const why =
    waiting && room
      ? `${dollars(room.left)} is left under ${room.limit}, the work under way needs about ${dollars(underWay)}${starts.some((s) => s.cost) ? `, ${ids(starts.filter((s) => s.cost))} about ${dollars(committed - underWay)} more` : ""}, and ${est(waiting)} ${tooBig && room.ceiling ? `is more than ${room.ceiling.limit} at once` : "doesn't fit"} (a6g task pace).`
      : null;
  return {
    unitCost,
    basis,
    left: room?.left ?? null,
    limit: room?.limit ?? null,
    underWay,
    starts,
    waiting,
    tooBig,
    allow,
    why,
    text: [`Pace: at work ${at}.`, budget, startLine, held, unit].filter(Boolean).join(" "),
  };
}

// --- pace.json, in the run folder: what the planner may start until it next looks -------------------------------
// When the budget binds: how many new members of each role may start, and how many T3 Code had ever started on each
// role's instances when the pace was worked out, so the guard counts starts since then rather than heads (a member
// that finishes frees a slot, not the money its work still needs).

interface SavedPace {
  at: string;
  allow: Record<string, number> | null;
  started: Record<string, number> | null;
  why: string | null;
}
export const paceFile = (run: string): string => join(run, "pace.json");
export const writePace = (run: string, { allow, why }: Pick<Pace, "allow" | "why">, started: Record<string, number> | null, at = new Date()): void =>
  writeJson(paceFile(run), { at: at.toISOString(), allow: started ? allow : null, started, why } satisfies SavedPace);
// No pace: the guard holds the planner to the role limits alone (a pace that couldn't be worked out fails open).
export const clearPace = (run: string): void => writePace(run, { allow: null, why: null }, null);

// How many new members of `role` the latest pace allows, how many had started on its instances then, and why; null when
// the pace leaves it to the role's limit, or is older than PACE_FRESH_MIN.
export function paceAllowance(run: string, role: string, now = Date.now()): { allow: number; started: number; why: string } | null {
  let saved: SavedPace | null;
  try {
    saved = readJson<SavedPace | null>(paceFile(run), null);
  } catch {
    return null;
  }
  const allow = saved?.allow?.[role];
  const started = saved?.started?.[role];
  if (!saved || allow === undefined || started === undefined || !(now - Date.parse(saved.at) <= PACE_FRESH_MIN * 60_000)) return null;
  return { allow, started, why: saved.why ?? "" };
}
