// a6g subscriptions [check | add <name> --config-dir <dir> | remove <name> | use <team> … | limit <name|all> …]: the
// Claude subscriptions the teams run on (lib/subscriptions.ts), what each one's usage report last said, what one
// subscription's week comes to in API-equivalent dollars (which a budget in percent is a share of), which teams run on
// each, and the operator's limits. The operator's: an agent never changes them.
//
//   use <team> <name>[,<name>…] [--role <role>]   the subscriptions the team (or one role) runs on, in order: it moves
//                                                 to the next when one closes (lib/steer.ts); --clear forgets them
//   limit <name|all> [--weekly <n>%] [--session <n>%]
//                                                 how much of a subscription the teams may use; "all" limits the
//                                                 subscriptions' weekly percentages added up; 0 removes a limit
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readRegistry, teamsDir } from "../paths.ts";
import { operatorOnly } from "../session.ts";
import { readSteering, steer } from "../steer.ts";
import {
  type Account,
  ALL,
  accounts,
  gate,
  listFor,
  loginOf,
  observeSubscriptions,
  sameLogins,
  setAccounts,
  setSubscriptionLimits,
  setTeamUses,
  SUBSCRIPTION_NAME,
  type SubscriptionLimit,
  subscriptionLimits,
  subscriptionState,
  teamUses,
  weekFor,
} from "../subscriptions.ts";
import * as t3 from "../t3.ts";
import { die, parseArgs } from "../util.ts";
import { describeSteering, teamNames } from "./team.ts";

const USAGE =
  "usage: a6g subscriptions [check | add <name> --config-dir <dir> | remove <name> | use <team> <name>[,<name>…] [--role <role>] [--clear] | limit <name|all> [--weekly <n>%] [--session <n>%]]";
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

// Which teams' roles run on each subscription now, from each registered team's record (lib/steer.ts).
function teamsOn(): Map<string, string[]> {
  const on = new Map<string, string[]>();
  for (const team of existsSync(teamsDir) ? teamNames() : []) {
    const entry = readRegistry(team);
    const steering = entry ? readSteering(entry.run) : null;
    const by = new Map<string, string[]>();
    for (const [role, name] of Object.entries(steering?.roles ?? {})) if (name) by.set(name, [...(by.get(name) ?? []), role]);
    for (const [name, roles] of by) on.set(name, [...(on.get(name) ?? []), `${team} (${roles.join(", ")})`]);
  }
  return on;
}

function limitWords(limit: SubscriptionLimit | undefined): string {
  const parts = [limit?.weekly ? `${limit.weekly}% a week` : "", limit?.session ? `${limit.session}% of five hours` : ""].filter(Boolean);
  return parts.length ? `limit ${parts.join(", ")}` : "no limit of yours (closed only when used up)";
}

function show(): void {
  const state = subscriptionState();
  const limits = subscriptionLimits();
  const list = accounts();
  const names = list.map((a) => a.name);
  const on = teamsOn();
  console.info("Subscriptions, as Claude Code's usage report says (the watchdog reads them every quarter hour, every five minutes near a limit):");
  for (const account of list) {
    const r = state.readings[account.name];
    const login = loginOf(account);
    const where = account.configDir ? account.configDir : "this Mac's own login";
    const signed = login ? `signed in${login.plan ? ` to ${login.plan}` : ""} (account ${login.login.slice(0, 8)})` : "not signed in";
    const g = gate(account.name, state, limits, names);
    const week = weekFor(state, account.name);
    console.info(
      r
        ? `  ${account.name} (${where}): ${r.percent}% of this week used, resets ${when(r.resetsAt)}${r.session ? `; ${r.session.percent}% of five hours, resets ${when(r.session.resetsAt)}` : ""}${r.scoped.map((s) => `; ${s.model}'s own limit ${s.percent}%`).join("")}; this Mac used ${money(r.spent)} API-equivalent since the week began (read ${when(r.at)})`
        : `  ${account.name} (${where}): not read yet`
    );
    console.info(
      `      ${signed}; ${limitWords(limits[account.name])}; ${g.open ? "open" : `closed: ${g.why}${g.until ? `, until ${when(g.until)}` : ""}`}${week ? `; its week is about ${money(week)} API-equivalent` : ""}`
    );
    const teams = on.get(account.name);
    if (teams) console.info(`      runs: ${teams.join(", ")}`);
  }
  const allCap = limits[ALL]?.weekly;
  if (allCap) {
    const total = names.reduce((sum, name) => sum + (state.readings[name]?.percent ?? 0), 0);
    console.info(`Across all of them: ${total}% of a week used, the limit is ${allCap}%.`);
  }
  for (const same of sameLogins(list)) console.info(`Note: ${same.join(" and ")} are the same Claude account; remove one (a6g subscriptions remove).`);
  const uses = teamUses();
  const teams = Object.keys(uses);
  if (teams.length) {
    console.info("What each team runs on, in order (a6g subscriptions use):");
    for (const team of teams)
      for (const [role, order] of Object.entries(uses[team] ?? {})) console.info(`  ${team}${role === "*" ? "" : ` ${role}`}: ${order.join(", ")}`);
  }
  console.info(
    state.week
      ? `One subscription's week comes to about ${money(state.week)} API-equivalent (the median of ${state.estimates.length} reading${state.estimates.length === 1 ? "" : "s"}); a budget in percent is a share of that, over 100% for more than one subscription's worth.`
      : "What a subscription's week comes to isn't known yet: it needs a reading with at least 5% of the week used."
  );
}

// Chooses each registered team's subscriptions now (rather than at the watchdog's next run), saying what moved.
function steerNow(only?: string): void {
  for (const team of only ? [only] : existsSync(teamsDir) ? teamNames() : []) {
    const entry = readRegistry(team);
    if (!entry) continue;
    const steered = steer(entry);
    if (!steered) {
      console.warn(`a6g: couldn't read T3 Code's settings; the watchdog chooses ${team}'s subscriptions at its next run`);
      continue;
    }
    for (const line of steered.said) console.info(`a6g: ${team}: ${line}`);
    console.info(`a6g: ${team}: ${describeSteering(steered.steering)}`);
  }
}

function use(team: string | undefined, names: string | undefined, options: Record<string, unknown>): number {
  if (!team) die(USAGE);
  const entry = readRegistry(team) ?? die(`no team named ${team} on this Mac (registered: ${teamNames().join(", ") || "none"})`);
  const role = typeof options["role"] === "string" ? options["role"] : null;
  const roles = Object.keys(t3.teamInstances(entry.name) ?? {});
  if (role && roles.length && !roles.includes(role)) die(`${team} has no ${role} on this Mac (it has ${roles.join(", ")})`);
  const uses = teamUses();
  const mine = { ...(uses[team] ?? {}) };
  const key = role ?? "*";
  if (options["clear"]) {
    delete mine[key];
  } else {
    const order = [
      ...new Set(
        (names ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      ),
    ];
    if (!order.length) die(`${USAGE}\n(the subscriptions, in order, separated by commas)`);
    const known = accounts().map((a) => a.name);
    const unknown = order.filter((name) => !known.includes(name));
    if (unknown.length) die(`no subscription named ${unknown.join(", ")} on this Mac (${known.join(", ")}; a6g subscriptions add adds one)`);
    mine[key] = order;
  }
  if (Object.keys(mine).length) uses[team] = mine;
  else delete uses[team];
  setTeamUses(uses);
  const now = role ? listFor(mine, role) : null;
  console.info(
    options["clear"]
      ? `a6g: ${team}${role ? `'s ${role}s` : ""} run on ${role ? `the team's subscriptions (${now?.join(", ") || "this Mac's own login"})` : "this Mac's own login"} now`
      : `a6g: ${team}${role ? `'s ${role}s` : ""} run on ${mine[key]?.join(", then ")}, moving on when one closes (its limits: a6g subscriptions limit; the team's own on one: a6g budget ${team} --account <name>)`
  );
  steerNow(team);
  return 0;
}

function limit(name: string | undefined, options: Record<string, unknown>): number {
  const list = accounts();
  if (!name || (name !== ALL && !list.some((a) => a.name === name)))
    die(`${USAGE}\n(a subscription's name, ${list.map((a) => a.name).join(", ")}, or ${ALL} for their weekly use added up)`);
  const limits = subscriptionLimits();
  const mine: SubscriptionLimit = { ...(limits[name] ?? {}) };
  const max = name === ALL ? 100 * list.length : 100;
  const asked = ["weekly", "session"].filter((key) => options[key] !== undefined);
  if (name === ALL && options["session"] !== undefined) die(`--session: ${ALL} limits the weekly use only`);
  for (const key of asked as ("weekly" | "session")[]) {
    const n = Number(String(options[key]).trim().replace(/%$/, ""));
    if (!Number.isFinite(n) || n < 0 || n > max) die(`--${key}: a percentage of the ${key === "weekly" ? "week" : "five hours"}, from 0 (none) to ${max}`);
    if (n === 0) delete mine[key];
    else mine[key] = Math.round(n);
  }
  if (asked.length) {
    if (Object.keys(mine).length) limits[name] = mine;
    else delete limits[name];
    setSubscriptionLimits(limits);
  }
  console.info(
    name === ALL
      ? `a6g: the subscriptions together: ${mine.weekly ? `limit ${mine.weekly}% of a week, their weekly percentages added up` : "no limit"}`
      : `a6g: ${name}: ${limitWords(mine)}`
  );
  if (asked.length) steerNow();
  return 0;
}

export function subscriptions(argv: string[]): number {
  const { positional, options } = parseArgs(argv, { booleans: ["clear"] });
  const [sub, name, more] = positional;
  if (!sub) {
    show();
    return 0;
  }
  operatorOnly(`subscriptions ${sub}`);
  const list = accounts();
  if (sub === "check") {
    for (const line of observeSubscriptions()) console.error(`a6g: ${line}`);
    show();
    return 0;
  }
  if (sub === "use") return use(name, more, options);
  if (sub === "limit") return limit(name, options);
  if (sub === "add") {
    if (!name || !SUBSCRIPTION_NAME.test(name)) die(`${USAGE}\n(a name: lowercase letters, digits and -)`);
    if (name === ALL) die(`${ALL} names every subscription at once (a6g subscriptions limit ${ALL}); pick another name`);
    const dir =
      typeof options["config-dir"] === "string"
        ? resolve(options["config-dir"])
        : die(`${USAGE}\n(--config-dir: the account's Claude Code config folder, its CLAUDE_CONFIG_DIR)`);
    if (!existsSync(dir)) die(`${dir} doesn't exist: sign in to that account with CLAUDE_CONFIG_DIR=${dir} claude auth login first`);
    if (list.some((a) => a.name === name)) die(`there's a subscription named ${name} already`);
    if (list.some((a) => a.configDir === dir)) die(`${dir} is a subscription already`);
    const login = loginOf({ name, configDir: dir });
    const same = login ? list.find((a) => loginOf(a)?.login === login.login) : undefined;
    if (same) die(`${dir} is signed in to the same Claude account as ${same.name}: its usage would count twice. Sign it in to the other account first.`);
    setAccounts([...list, { name, configDir: dir } satisfies Account]);
    console.info(
      `a6g: added ${name}${login ? ` (${login.plan ?? "signed in"})` : ` (not signed in yet: CLAUDE_CONFIG_DIR=${dir} claude auth login)`}; a6g subscriptions check reads it now, and a6g subscriptions use <team> ${name} runs a team on it`
    );
    return 0;
  }
  if (sub === "remove") {
    if (!name || !list.some((a) => a.name === name)) die(`no subscription named ${name ?? ""} (${list.map((a) => a.name).join(", ")})`);
    if (list.length === 1) die("that's the only one: the factory always reads at least this Mac's own");
    const listedBy = Object.entries(teamUses()).filter(([, roles]) => Object.values(roles).some((order) => order.includes(name)));
    if (listedBy.length)
      die(`${listedBy.map(([team]) => team).join(", ")} run${listedBy.length === 1 ? "s" : ""} on ${name}: change that first (a6g subscriptions use)`);
    const running = teamsOn().get(name);
    if (running)
      die(
        `${running.join(", ")} still run${running.length === 1 ? "s" : ""} on ${name}; the watchdog moves them off it within minutes once no team lists it`
      );
    setAccounts(list.filter((a) => a.name !== name));
    console.info(`a6g: removed ${name}`);
    return 0;
  }
  die(USAGE);
}
