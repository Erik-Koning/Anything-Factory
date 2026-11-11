// a6g agreement <team>: the working agreement between the operator and a team (lib/tasks/agreement.ts): how readily
// it asks them, which topics are always or never asked, and their standing instructions. With no options it shows the
// one in force, how the check-ins have gone and every earlier version; with some, it records a new one, which holds
// from that moment and reaches the planner at once (a control, like a6g pause and a6g budget). The operator's alone.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTeam } from "../config.ts";
import type { RegistryEntry } from "../paths.ts";
import { operatorOnly } from "../session.ts";
import {
  type Agreement,
  agreementChanges,
  agreementFrom,
  agreementLines,
  DEFAULT_AGREEMENT,
  isReserved,
  isTopic,
  LEVELS,
  sameAgreement,
  TOPICS,
  type TopicRule,
} from "../tasks/agreement.ts";
import { agreementControl, agreementOf, type Control } from "../tasks/controls.ts";
import { checkIns } from "../tasks/decisions.ts";
import { OPERATOR, Refused } from "../tasks/model.ts";
import { openStore } from "../tasks/store.ts";
import { die, localTime, parseArgs, text as optionText } from "../util.ts";
import { entryFor, recordControl } from "./team.ts";

const SETTABLE = TOPICS.filter((topic) => !isReserved(topic));
const USAGE = `usage: a6g agreement <team>                      the working agreement in force, how it has gone, and its history
       a6g agreement <team> [--level ${LEVELS.join("|")}]
                            [--ask <topics>] [--never <topics>] [--follow <topics>]   (${SETTABLE.join(", ")})
                            [--notes "<your standing instructions>" | --notes-file <file> | --clear-notes]
                            [--reset]              back to the default: balanced, scope always asked, no instructions`;

// Whether the team's operator is technical (team.json), for how the agreement reads; a checkout that can't be read
// (another machine's, a broken team.json) reads as technical.
function operatorOf(entry: RegistryEntry): { technical: boolean } {
  try {
    return loadTeam(entry.home, { strict: false }).operator;
  } catch {
    return { technical: true };
  }
}

const whoSet = (by: string): string => (by.startsWith("web:") ? "the operator, on the web app" : "the operator");
const topicsIn = (value: string | undefined, flag: string): string[] => {
  const names = (value ?? "")
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  for (const name of names) {
    if (!isTopic(name)) die(`--${flag}: there's no topic ${name} (${SETTABLE.join(", ")})`);
    if (isReserved(name)) die(`--${flag}: ${name} is always asked (Article 3): it isn't the agreement's to set`);
  }
  return names;
};

export async function agreement(argv: string[]): Promise<number> {
  operatorOnly("agreement");
  const { positional, options } = parseArgs(argv, { booleans: ["clear-notes", "reset", "help"] });
  if (options["help"] === true) {
    console.info(USAGE);
    return 0;
  }
  const known = ["level", "ask", "never", "follow", "notes", "notes-file", "clear-notes", "reset"];
  const unknown = Object.keys(options).filter((key) => key !== "--" && !known.includes(key));
  if (unknown.length) die(`${USAGE}\n(not ${unknown.map((k) => `--${k}`).join(", ")})`);
  const entry = entryFor(positional[0] ?? die(USAGE));
  const tasks = entry.tasks ?? die(`${entry.name} keeps its tickets on a GitHub board, which has no working agreement`);
  const operator = operatorOf(entry);
  const store = await openStore({ name: entry.name, tasks }, entry.run);
  let controls: Control[];
  let stats: ReturnType<typeof checkIns>;
  try {
    controls = await store.controls.all();
    stats = checkIns(await store.decisions.all(), await store.tasks.all(), controls, new Date(Date.now() - 30 * 86_400_000).toISOString());
  } finally {
    await store.close();
  }
  const current = agreementOf(controls);
  const changing = known.some((key) => options[key] !== undefined);

  if (!changing) {
    const versions = controls.filter((c) => c.kind === "agreement");
    const history = versions.map((c, i) => {
      const before = i ? agreementOf(versions.slice(0, i)).agreement : DEFAULT_AGREEMENT;
      const changes = agreementChanges(before, agreementOf([c]).agreement);
      return `  ${c.id}  ${localTime(new Date(c.at))}  ${whoSet(c.by)}: ${changes.join("; ") || "nothing in it differed"}`;
    });
    console.info(
      [
        current.control
          ? `${entry.name}'s working agreement (${current.control.id}, set by ${whoSet(current.control.by)} at ${localTime(new Date(current.control.at))}):`
          : `${entry.name}'s working agreement (the default: you haven't changed it):`,
        ...agreementLines(current.agreement, operator),
        current.agreement.notes ? `\nYour standing instructions:\n\n${current.agreement.notes}` : "No standing instructions.",
        "",
        `The last 30 days: ${stats.asked} asked of you, ${stats.decided} decided for you (${stats.flagged} flagged, ${stats.overturned} overturned); ${stats.toReview} to review now (a6g decision list --to-review, in the team's checkout).`,
        ...(history.length ? ["", "History:", ...history] : []),
        "",
        `Change it: a6g agreement ${entry.name} --level ${LEVELS.join("|")} [--ask scope,cost] [--never design] [--notes "…"]`,
      ].join("\n")
    );
    return 0;
  }

  // What was asked for, made of an agreement: the one in force, or with --reset the default.
  const sets: [string, TopicRule | "follow"][] = [
    ["ask", "ask"],
    ["never", "decide"],
    ["follow", "follow"],
  ];
  const named = new Map<string, [string, TopicRule | "follow"]>();
  for (const [flag, rule] of sets)
    for (const topic of topicsIn(optionText(options[flag]), flag)) {
      if (named.has(topic)) die(`${topic} is in both --${named.get(topic)?.[0]} and --${flag}: say one`);
      named.set(topic, [flag, rule]);
    }
  if (!operator.technical && named.get("technical")?.[1] === "ask")
    die("--ask technical: this team's operator isn't technical (team.json operator.technical), so the platform and the stack are never asked");
  if ([options["notes"], options["notes-file"], options["clear-notes"]].filter((v) => v !== undefined).length > 1)
    die("give the standing instructions one way: --notes, --notes-file or --clear-notes");
  let notes: string | null = null;
  const file = optionText(options["notes-file"]);
  if (options["clear-notes"]) notes = "";
  else if (file !== undefined) {
    try {
      notes = readFileSync(resolve(file), "utf8");
    } catch {
      die(`can't read ${file}`);
    }
  } else if (options["notes"] !== undefined) notes = optionText(options["notes"]) ?? die('--notes "<your standing instructions>" (or --clear-notes)');
  const level = options["level"] === undefined ? null : (optionText(options["level"]) ?? die(`--level ${LEVELS.join("|")}`));
  const build = (inForce: Agreement): Agreement => {
    const base = options["reset"] ? DEFAULT_AGREEMENT : inForce;
    const topics: Record<string, TopicRule | "follow"> = { ...base.topics };
    for (const [topic, [, rule]] of named) topics[topic] = rule;
    const made = agreementFrom({ level: level ?? base.level, topics, notes: notes ?? base.notes });
    return "problem" in made ? die(made.problem) : made;
  };
  if (sameAgreement(build(current.agreement), current.agreement)) {
    console.info(`a6g: ${entry.name}'s working agreement is that already; nothing was recorded`);
    return 0;
  }
  // Made of the agreement in force as the control is recorded, read again there: a change from the web app a moment
  // ago is built on, not written over.
  let before = current.agreement;
  let made = before;
  const control = await recordControl(entry, async (store) => {
    before = agreementOf(await store.controls.all()).agreement;
    made = build(before);
    if (sameAgreement(made, before)) throw new Refused(`${entry.name}'s working agreement is that already; nothing was recorded`);
    return agreementControl(entry.name, OPERATOR, made);
  });
  console.info(
    [
      `a6g: ${entry.name}'s working agreement is now ${control.id}: ${agreementChanges(before, made).join("; ")}.`,
      ...agreementLines(made, operator),
      "It holds from now; the planner is told, and re-checks its open questions against it.",
    ].join("\n")
  );
  return 0;
}
