// Keeps each of a team's roles on an open subscription on this machine (lib/subscriptions.ts chooseFor): the watchdog
// each run, `a6g register`, and `a6g subscriptions use` at once. A role runs on a subscription through its T3 instance's
// homePath (lib/t3.ts), as T3 Code runs an instance on a login of its own.
//
// A role moves only when nothing of it is at work, since T3 Code would resume a session of it (after a restart, or a
// failed turn it retries) under the new login, where that Claude session isn't. A member role moves once its members
// at work have finished, and none of it starts until then (the guard, a worker's watchdog); each member does one task,
// so that's soon. The planner moves when it's idle with no member running, the moment `a6g rotate` waits for: its
// thread is retired and the watchdog starts a fresh one on the new subscription at its next run.
//
// A role no subscription is open to waits: the guard starts none of its members, a worker's watchdog none of its
// builders, and a waiting planner gets no tick, no message (they're kept for it) and no new thread. What's running
// finishes. It lifts by itself when a subscription opens. What each role runs on, what moves once it can, and what
// waits: <run>/subscription.json, written by the factory alone.
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { accountClosures } from "./budget.ts";
import { applied, markApplied, readLimits, whoAsked } from "./holds.ts";
import type { RegistryEntry } from "./paths.ts";
import {
  type Account,
  accountAt,
  accounts,
  type Choice,
  chooseFor,
  describeWait,
  gate,
  listFor,
  setTeamUses,
  subscriptionLimits,
  subscriptionState,
  teamUses,
} from "./subscriptions.ts";
import * as t3 from "./t3.ts";
import type { Control } from "./tasks/controls.ts";
import type { Spend } from "./tasks/spend.ts";
import type { TeamSubscriptions } from "./tasks/teams.ts";
import { hash, readJson, writeJson } from "./util.ts";

export interface Steering {
  // Each role's subscription as its instance has it (null: this Mac's own login, which nothing watches).
  roles: Record<string, string | null>;
  // A role to move once it can (the planner, while it's at work), and where to.
  moving: Record<string, string | null>;
  // Roles no subscription is open to: why, and until when as far as the readings say.
  waiting: Choice["waiting"];
  at: string;
}

export const steeringFile = (run: string): string => join(run, "subscription.json");
export function readSteering(run: string): Steering | null {
  try {
    return readJson<Steering | null>(steeringFile(run), null);
  } catch {
    return null;
  }
}

const who = (role: string): string => (role === "planner" ? "planner" : `${role}s`);
const named = (name: string | null): string => name ?? "this Mac's own login";

// Why no member of `role` can start now (the guard, a worker's watchdog), or null: none of its subscriptions is open,
// or it's moving to another once those at work have finished.
export function waitRefusal(run: string | null, role: string): string | null {
  const steering = run ? readSteering(run) : null;
  const wait = steering?.waiting[role];
  if (wait)
    return `no ${role} can start now: no subscription it runs on is open (${describeWait(wait)}). Carry on with what needs no ${role}; the watchdog says when they can start again.`;
  if (steering && role !== "planner" && Object.hasOwn(steering.moving, role))
    return `no ${role} can start now: the ${who(role)} move from ${named(steering.roles[role] ?? null)} to ${named(steering.moving[role] ?? null)} once those at work have finished. Start them after that; it's soon.`;
  return null;
}

// For the planner's ticks: the members that wait or are moving, so it starts none of them yet.
export function steeringNote(run: string): string {
  const steering = readSteering(run);
  const waiting = Object.entries(steering?.waiting ?? {})
    .filter(([role]) => role !== "planner")
    .map(([role, wait]) => `${who(role)} (${describeWait(wait)})`);
  const moving = Object.entries(steering?.moving ?? {})
    .filter(([role]) => role !== "planner")
    .map(([role, to]) => `${who(role)} (moving to ${named(to)} once those at work finish)`);
  return waiting.length || moving.length ? ` Waiting for a subscription, so start none of them yet: ${[...waiting, ...moving].join("; ")}.` : "";
}

// Why the planner can't be retired now (members running, a turn under way, a person to answer), or null when it can.
// `then` says what happens once it can ("rotate", "it moves").
export function plannerBusy(run: string, then: string): string | null {
  const file = join(run, "planner-thread");
  const old = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!old) return null;
  const busy = t3.runningChildren(old);
  if (busy === null) return "T3 Code's database couldn't be read, so it isn't known whether the planner's members are running; try again";
  if (busy) return `the planner has ${busy} members running; they report to it, so ${then} once they've finished`;
  const thread = t3.threadShow(old);
  if (!thread && t3.threadExists(old) !== false) return `T3 Code couldn't say what planner ${old} is doing; try again`;
  if (thread && !thread.archived && t3.BUSY.includes(thread.status ?? ""))
    return `the planner is in the middle of a turn (${thread.status}); ${then} once it's idle`;
  // Waiting on a person: an answer would resume the old planner beside the new one.
  if (thread && !thread.archived && (thread.status === "waiting" || (thread.pendingRequestCount ?? 0) > 0))
    return `the planner is waiting for an answer in T3 Code; answer it (or dismiss the request), then ${then}`;
  return null;
}

// Retires the planner's thread, so the watchdog starts a fresh one; resolves to the old one's id ("" for none).
export function retirePlanner(run: string): string {
  const file = join(run, "planner-thread");
  const old = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!old) return "";
  appendFileSync(join(run, "planner-thread.retired"), `${old}\n`);
  rmSync(file);
  return old;
}

export interface SteerResult {
  // Lines for the team's log.
  said: string[];
  // The planner's instance moved to another login: its next thread starts at the watchdog's next run, once T3 Code has
  // read the instance's new login.
  plannerMoved: boolean;
  // What the operator is told, once per change: null when nothing changed.
  tell: { key: string; text: string } | null;
  steering: Steering;
}

// Chooses each role's subscription and moves those that should and can. Null when T3 Code's settings can't be read.
export function steer(entry: Pick<RegistryEntry, "name" | "run" | "worker">, now = new Date()): SteerResult | null {
  const instances = t3.teamInstances(entry.name);
  if (!instances) return null;
  const list = accounts();
  const roles = Object.keys(instances);
  const current: Record<string, string | null> = Object.fromEntries(roles.map((role) => [role, accountAt(instances[role]?.homePath, list)]));
  let spend: Spend | null = null;
  try {
    spend = readJson<Spend | null>(join(entry.run, "spend.json"), null);
  } catch {}
  const use = teamUses()[entry.name];
  const choice = chooseFor(roles, current, {
    use,
    accounts: list,
    state: subscriptionState(),
    limits: subscriptionLimits(),
    closedFor: accountClosures(readLimits(entry.run), spend),
    now,
  });
  const previous = readSteering(entry.run);
  const homes: Record<string, string | null> = {};
  const moving: Record<string, string | null> = {};
  const said: string[] = [];
  const changes: string[] = [];
  // What changed, without a reading's figures: the alert's key, so the same change isn't sent twice running.
  const signature: string[] = [];
  for (const role of roles) {
    const from = current[role] ?? null;
    const to = choice.roles[role] ?? null;
    if (to === from || choice.waiting[role]) continue;
    // Why: it isn't listed for that one (any more), that one closed, or one before it in its list has room.
    const order = listFor(use, role, list);
    const shut = from ? choice.gates[from] : undefined;
    const why =
      !from || !order.includes(from)
        ? `it runs on ${order.join(", then ") || "this Mac's own login"} now`
        : shut && !shut.open
          ? shut.why
          : `${to} comes before ${from} in its list, and has room`;
    // Something of it at work: it moves once that's done.
    let busy: string | null;
    if (role === "planner") busy = plannerBusy(entry.run, "it moves");
    else if (entry.worker) {
      // A worker's builders are threads its watchdog started (worker-threads.json), not the planner's members.
      let started: Record<string, { id: string }[]> = {};
      try {
        started = readJson<Record<string, { id: string }[]>>(join(entry.run, "worker-threads.json"), {});
      } catch {}
      const n = (started[role] ?? []).filter(({ id }) => t3.threadAtWork(id)).length;
      busy = n ? `${n} at work` : null;
    } else {
      const id = instances[role]?.id ?? "";
      const running = t3.runningByInstance([id]);
      busy = running === null ? "T3 Code's database couldn't be read" : running[id] ? `${running[id]} at work` : null;
    }
    if (busy) {
      moving[role] = to;
      if (!previous || !Object.hasOwn(previous.moving, role) || previous.moving[role] !== to)
        said.push(
          `the ${who(role)} ${role === "planner" ? "moves" : "move"} from ${named(from)} to ${named(to)} once ${role === "planner" ? "it's" : "they're"} free (${why}): ${busy}`
        );
      continue;
    }
    homes[role] = to === null ? null : (list.find((a: Account) => a.name === to)?.configDir ?? null);
    changes.push(`${who(role)} from ${named(from)} to ${named(to)} (${why})`);
    signature.push(`${role}:${from}>${to}`);
  }
  if (Object.keys(homes).length) {
    t3.setHomes(entry.name, homes);
    for (const change of changes) said.push(`moved the ${change}`);
    if (Object.hasOwn(homes, "planner")) {
      const retired = retirePlanner(entry.run);
      if (retired) said.push(`retired planner ${retired}: the next one starts on ${named(choice.roles["planner"] ?? null)}`);
    }
  }
  // A wait is news when what closed its subscriptions changed, not when only a reading's figures did.
  const was = previous?.waiting ?? {};
  const same = (a: Choice["waiting"][string] | undefined, b: Choice["waiting"][string]): boolean => !!a && (a.key ?? a.why) === (b.key ?? b.why);
  for (const [role, wait] of Object.entries(choice.waiting))
    if (!same(was[role], wait)) {
      said.push(`the ${who(role)} wait for a subscription: ${describeWait(wait)}`);
      changes.push(`${who(role)} wait: ${describeWait(wait)}`);
      signature.push(`${role}:wait:${wait.key ?? wait.why}`);
    }
  for (const role of Object.keys(was))
    if (!choice.waiting[role] && roles.includes(role)) {
      said.push(`the ${who(role)} can start again, on ${named(choice.roles[role] ?? null)}`);
      changes.push(`${who(role)} can start again, on ${named(choice.roles[role] ?? null)}`);
      signature.push(`${role}:open:${choice.roles[role] ?? ""}`);
    }
  const steering: Steering = {
    roles: Object.fromEntries(roles.map((role) => [role, Object.hasOwn(homes, role) ? (choice.roles[role] ?? null) : (current[role] ?? null)])),
    moving,
    waiting: choice.waiting,
    at: now.toISOString(),
  };
  writeJson(steeringFile(entry.run), steering);
  const tell = changes.length ? { key: `subscriptions-${hash(...signature)}`, text: `Subscriptions: the team's ${changes.join("; the ")}.` } : null;
  return { said, plannerMoved: Object.hasOwn(homes, "planner"), tell, steering };
}

// The operator's `subscriptions` controls the run folder hasn't applied yet (the web app's; a6g subscriptions use
// writes the list itself): each one's list is written where that command writes it, oldest first, and the team is
// steered once. A subscription this machine doesn't have, or a role the team doesn't, is refused whole and said in
// the log: the list stays as it was. Resolves to lines for the team's log; empty when there was none.
export function applySubscriptionControls(entry: Pick<RegistryEntry, "name" | "run" | "worker">, controls: Control[], now = new Date()): string[] {
  const done = applied(entry.run);
  const fresh = controls.filter((c) => c.kind === "subscriptions" && !done(c.id));
  if (!fresh.length) return [];
  const said: string[] = [];
  const known = accounts().map((a) => a.name);
  const roles = Object.keys(t3.teamInstances(entry.name) ?? {});
  const uses = teamUses();
  const mine = { ...(uses[entry.name] ?? {}) };
  let changed = false;
  for (const control of fresh) {
    const ask = control.subscriptions;
    if (!ask) continue;
    const whose = ask.role ? `the ${ask.role} role's` : "the team's";
    const unknown = ask.use.filter((name) => !known.includes(name));
    if (unknown.length) {
      said.push(
        `${whoAsked(control.by)} asked for ${whose} subscriptions to be ${ask.use.join(", then ")} (${control.id}), but this Mac has no ${unknown.join(", ")} (it has ${known.join(", ")}): nothing changed`
      );
      continue;
    }
    if (ask.role && roles.length && !roles.includes(ask.role)) {
      said.push(
        `${whoAsked(control.by)} asked for the ${ask.role}'s own subscriptions (${control.id}), but the team has no ${ask.role} here: nothing changed`
      );
      continue;
    }
    const key = ask.role ?? "*";
    if (ask.use.length) mine[key] = ask.use;
    else delete mine[key];
    changed = true;
    said.push(
      ask.use.length
        ? `${whoAsked(control.by)} set ${whose} subscriptions (${control.id}): ${ask.use.join(", then ")}`
        : `${whoAsked(control.by)} cleared ${whose} subscriptions (${control.id}): ${ask.role ? "they follow the team's list" : "the team runs on this Mac's own login"}`
    );
  }
  if (changed) {
    if (Object.keys(mine).length) uses[entry.name] = mine;
    else delete uses[entry.name];
    setTeamUses(uses);
    const steered = steer(entry, now);
    if (steered) said.push(...steered.said);
    else said.push("T3 Code's settings couldn't be read: the roles move at the watchdog's next run");
  }
  markApplied(
    entry.run,
    fresh.map((c) => c.id)
  );
  return said;
}

// The subscriptions on this machine and which the team runs on, as its lead reports them to the web app
// (lib/tasks/teams.ts): names and readings, never a login or a folder.
export function subscriptionsView(entry: Pick<RegistryEntry, "name" | "run">, now = new Date()): TeamSubscriptions {
  const list = accounts();
  const names = list.map((a) => a.name);
  const state = subscriptionState();
  const limits = subscriptionLimits();
  let spend: Spend | null = null;
  try {
    spend = readJson<Spend | null>(join(entry.run, "spend.json"), null);
  } catch {}
  const closedFor = accountClosures(readLimits(entry.run), spend);
  const steering = readSteering(entry.run);
  return {
    available: names.map((name) => {
      const reading = state.readings[name];
      const live = reading && Date.parse(reading.resetsAt) > now.getTime() ? reading : null;
      const shut = closedFor[name] ?? gate(name, state, limits, names, now).why;
      return { name, percent: live ? live.percent : null, resetsAt: live ? live.resetsAt : null, closed: shut ?? null };
    }),
    use: teamUses()[entry.name] ?? {},
    roles: steering?.roles ?? {},
    moving: steering?.moving ?? {},
    waiting: Object.fromEntries(Object.entries(steering?.waiting ?? {}).map(([role, wait]) => [role, { why: wait.why, until: wait.until }])),
  };
}
