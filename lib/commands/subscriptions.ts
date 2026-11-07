// a6g subscriptions [check | add <name> --config-dir <dir> | remove <name>]: the Claude subscriptions the teams run on
// (lib/subscriptions.ts), what each one's usage report last said, and what one subscription's week comes to in
// API-equivalent dollars, which a budget in percent is a share of. The operator's: an agent never changes them.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { operatorOnly } from "../session.ts";
import { type Account, accounts, observeSubscriptions, setAccounts, subscriptionState } from "../subscriptions.ts";
import { die, parseArgs } from "../util.ts";

const USAGE = "usage: a6g subscriptions [check | add <name> --config-dir <dir> | remove <name>]";
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function show(): void {
  const state = subscriptionState();
  console.info("Subscriptions, as Claude Code's usage report says (the watchdog reads them every quarter hour):");
  for (const account of accounts()) {
    const r = state.readings[account.name];
    const where = account.configDir ? account.configDir : "this Mac's own login";
    console.info(
      r
        ? `  ${account.name} (${where}): ${r.percent}% of this week used, resets ${when(r.resetsAt)}${r.scoped.map((s) => `; ${s.model}'s own limit ${s.percent}%`).join("")}; this Mac used $${Math.round(r.spent).toLocaleString("en-US")} API-equivalent since the week began (read ${when(r.at)})`
        : `  ${account.name} (${where}): not read yet`
    );
  }
  console.info(
    state.week
      ? `One subscription's week comes to about $${Math.round(state.week).toLocaleString("en-US")} API-equivalent (the median of ${state.estimates.length} reading${state.estimates.length === 1 ? "" : "s"}); a budget in percent is a share of that, over 100% for more than one subscription's worth.`
      : "What a subscription's week comes to isn't known yet: it needs a reading with at least 5% of the week used."
  );
}

export function subscriptions(argv: string[]): number {
  const { positional, options } = parseArgs(argv);
  const [sub, name] = positional;
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
  if (sub === "add") {
    if (!name || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) die(`${USAGE}\n(a name: lowercase letters, digits and -)`);
    const dir =
      typeof options["config-dir"] === "string"
        ? resolve(options["config-dir"])
        : die(`${USAGE}\n(--config-dir: the account's Claude Code config folder, its CLAUDE_CONFIG_DIR)`);
    if (!existsSync(dir)) die(`${dir} doesn't exist: sign in to that account with CLAUDE_CONFIG_DIR=${dir} claude first`);
    if (list.some((a) => a.name === name)) die(`there's a subscription named ${name} already`);
    if (list.some((a) => a.configDir === dir)) die(`${dir} is a subscription already`);
    setAccounts([...list, { name, configDir: dir } satisfies Account]);
    console.info(`a6g: added ${name}; a6g subscriptions check reads it now`);
    return 0;
  }
  if (sub === "remove") {
    if (!name || !list.some((a) => a.name === name)) die(`no subscription named ${name ?? ""} (${list.map((a) => a.name).join(", ")})`);
    if (list.length === 1) die("that's the only one: the factory always reads at least this Mac's own");
    setAccounts(list.filter((a) => a.name !== name));
    console.info(`a6g: removed ${name}`);
    return 0;
  }
  die(USAGE);
}
