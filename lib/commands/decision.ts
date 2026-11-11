// a6g decision …: the team's decision log (lib/tasks/decisions.ts) and the working agreement it's routed by
// (lib/tasks/agreement.ts). The planner records what it decided in the operator's place, and the command says why the
// operator wasn't asked, from the agreement in force; one the agreement makes theirs is refused, with the command that
// raises it. The operator reviews a record here or on the web app, and sets the agreement with a6g agreement.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Team } from "../config.ts";
import { teamSession, asOperator } from "../session.ts";
import { agreementLines, ROUTE_WORDS, route } from "../tasks/agreement.ts";
import { agreementOf, type Control } from "../tasks/controls.ts";
import {
  type DecisionRecord,
  decisionLine,
  flagged,
  judgedFrom,
  noteDecision,
  overturnedOpen,
  recordDecision,
  requestReview,
  reviewOf,
  toReview,
} from "../tasks/decisions.ts";
import { OPERATOR } from "../tasks/model.ts";
import { openTeamStore } from "../tasks/ops.ts";
import { Refused, type Store } from "../tasks/store.ts";
import { localTime, type Options, parseArgs, text as optionText } from "../util.ts";

export const USAGE = `usage: a6g decision <command>
  route --topic t --stakes s --confidence c      what the working agreement does with such a question: asked,
                                                 decided and flagged for the operator, or decided
  agreement                                      the working agreement in force, whole (the operator sets it: a6g agreement <team>)
  record "<the question>" --decided "…" --because "…" --topic t --stakes s --confidence c
         [--options "one | another"] [--task 12,14] [--undo "how it's undone"]
      (the planner: a decision made in the operator's place. It goes in the decision log, and its line in
       .a6g/decisions.md. Refused when the agreement makes the question theirs: a6g task status <id> question …)
      --topic product|scope|design|technical|cost|security|privacy|rules
      --stakes low|medium|high (what a wrong call costs)   --confidence low|medium|high (how sure of what they'd choose)
  list [--flagged] [--to-review] [--overturned] [--json]   ·   show <id> [--json]
  note <id> "<what you did>"                     the planner: what was done about a decision (an overturned one, above all)
  review <id> agree|overturn [--note "…"]        yours: agree with it, or overturn it and say what to do instead`;

// Who's acting: the member's role (its instance's A6G_ROLE), or the operator when a person runs it.
const actor = (): string => (asOperator() ? OPERATOR : process.env.A6G_ROLE || "unknown");

interface Context {
  home: string;
  team: Team;
  store: Store;
  who: string;
}
type Handler = (ctx: Context, positional: string[], options: Options) => Promise<number>;

const when = (iso: string): string => localTime(new Date(iso));
const whoSet = (control: Control): string => (control.by.startsWith("web:") ? "the operator, on the web app" : "the operator");

// The line that says where a question goes, as both a6g decision route and a refusal put it.
const routeCommand: Handler = async ({ team, store }, _positional, options) => {
  const call = judgedFrom({ topic: optionText(options["topic"]), stakes: optionText(options["stakes"]), confidence: optionText(options["confidence"]) });
  if ("problem" in call) throw new Refused(call.problem);
  const { agreement, control } = agreementOf(await store.controls.all());
  const routed = route(agreement, call, team.operator);
  const next =
    routed.route === "ask"
      ? `Raise it: a6g task status <id> question --topic ${call.topic} --stakes ${call.stakes} --confidence ${call.confidence} --reason "…" --recommend "…"`
      : `Decide it, and record it: a6g decision record "<the question>" --decided "…" --because "…" --topic ${call.topic} --stakes ${call.stakes} --confidence ${call.confidence}${
          routed.route === "tell" ? "\nIt's flagged for the operator: name it in your next message to them, under what you decided for them." : ""
        }`;
  console.info(`${ROUTE_WORDS[routed.route]}: ${routed.rule} (${control ? `agreement ${control.id}` : "the default agreement"}).\n${next}`);
  return 0;
};

const showAgreement: Handler = async ({ team, store }) => {
  const { agreement, control } = agreementOf(await store.controls.all());
  console.info(
    [
      control
        ? `The working agreement (${control.id}, set by ${whoSet(control)} at ${when(control.at)}):`
        : "The working agreement (the default: the operator hasn't changed it):",
      ...agreementLines(agreement, team.operator),
      "",
      agreement.notes ? `The operator's standing instructions:\n\n${agreement.notes}` : "No standing instructions.",
    ].join("\n")
  );
  return 0;
};

const record: Handler = async ({ home, team, store, who }, positional, options) => {
  const call = judgedFrom({ topic: optionText(options["topic"]), stakes: optionText(options["stakes"]), confidence: optionText(options["confidence"]) });
  if ("problem" in call) throw new Refused(call.problem);
  const made = await recordDecision(
    store,
    team.name,
    {
      question: positional.join(" "),
      decision: optionText(options["decided"]) ?? "",
      because: optionText(options["because"]) ?? "",
      options: (optionText(options["options"]) ?? "").split("|"),
      undo: optionText(options["undo"]) ?? "",
      tasks: (optionText(options["task"]) ?? "").split(/[\s,]+/),
    },
    call,
    who,
    team.operator
  );
  // The team's working memory of rulings, compiled into every member's rules: the same decision, said once.
  const file = join(home, ".a6g", "decisions.md");
  const line = decisionLine(made);
  let filed = true;
  try {
    if (!existsSync(file))
      writeFileSync(file, "# Decisions\n\nOne line each: the question, the decision, and the direction or earlier decision it follows.\n\n");
    const before = readFileSync(file, "utf8");
    appendFileSync(file, `${before.endsWith("\n") || !before ? "" : "\n"}${line}\n`);
  } catch {
    filed = false;
  }
  console.info(
    [
      `${made.id} recorded: ${ROUTE_WORDS[made.route]} (${made.rule}).`,
      filed ? "Its line is in .a6g/decisions.md: commit it with your lane's files." : `Couldn't write .a6g/decisions.md: add its line yourself:\n${line}`,
      ...(flagged(made) ? ["It's flagged for the operator: name it in your next message to them, under what you decided for them."] : []),
    ].join("\n")
  );
  return 0;
};

const pad = (text: string, n: number): string => (text.length >= n ? text : `${text}${" ".repeat(n - text.length)}`);
const state = (d: DecisionRecord, controls: Control[]): string => {
  const review = reviewOf(d, controls);
  if (review) return `${review.verdict}${review.pending ? " (not applied yet)" : ""}`;
  return flagged(d) ? "to review" : "";
};
const line = (d: DecisionRecord, controls: Control[]): string =>
  `${pad(d.id, 5)} ${pad(d.at.slice(0, 10), 10)} ${pad(d.topic, 9)} ${pad(flagged(d) ? "flagged" : "", 7)} ${pad(state(d, controls), 12)} ${d.question} → ${d.decision}`;

function detail(d: DecisionRecord, controls: Control[]): string {
  const review = reviewOf(d, controls);
  const out = [
    `${d.id} ${d.question}`,
    `decided by the ${d.by} at ${when(d.at)}: ${d.decision}`,
    `because: ${d.because}`,
    ...(d.options.length ? [`weighed: ${d.options.join(" | ")}`] : []),
    `${d.topic} · stakes ${d.stakes} · confidence ${d.confidence}`,
    `not asked: ${ROUTE_WORDS[d.route]} (${d.rule}; ${d.agreement ? `agreement ${d.agreement}` : "the default agreement"})`,
    ...(d.undo ? [`to undo: ${d.undo}`] : []),
    ...(d.tasks.length ? [`tasks: ${d.tasks.map((id) => `#${id}`).join(", ")}`] : []),
    review
      ? `the operator ${review.verdict === "agreed" ? "agreed" : "overturned it"} at ${when(review.at)}${review.pending ? " (not applied yet)" : ""}${review.note ? `: ${review.note}` : ""}`
      : flagged(d)
        ? "flagged for the operator: not reviewed yet"
        : "not reviewed",
  ];
  if (d.notes.length) out.push("", "Notes:", ...d.notes.map((n) => `- ${n.at.slice(0, 16)} ${n.by}: ${n.text}`));
  return out.join("\n");
}

const list: Handler = async ({ store }, _positional, options) => {
  const controls = await store.controls.all();
  let all = await store.decisions.all();
  if (options["flagged"]) all = all.filter(flagged);
  if (options["to-review"]) all = toReview(all, controls);
  if (options["overturned"]) all = all.filter((d) => reviewOf(d, controls)?.verdict === "overturned");
  if (options["json"]) console.info(JSON.stringify(all, null, 2));
  else console.info(all.length ? all.map((d) => line(d, controls)).join("\n") : "no decisions");
  return 0;
};

const getDecision = async (store: Store, id: string | undefined): Promise<DecisionRecord> => {
  if (!id) throw new Refused("which decision? Give its id (d3).");
  const found = await store.decisions.get(id.replace(/^#/, ""));
  if (!found) throw new Refused(`no decision ${id}`);
  return found;
};

const show: Handler = async ({ store, who }, [id], options) => {
  const found = await getDecision(store, id);
  const controls = await store.controls.all();
  console.info(options["json"] ? JSON.stringify(found, null, 2) : detail(found, controls));
  if (!options["json"] && who === OPERATOR && reviewOf(found, controls)?.verdict !== "overturned")
    console.info(`\nYours to review: a6g decision review ${found.id} agree, or overturn --note "<what to do instead>"`);
  return 0;
};

const note: Handler = async ({ store, who }, [id, ...rest], options) => {
  const said = optionText(options["text"]) ?? rest.join(" ");
  const noted = await noteDecision(store, id ?? "", { who, text: said });
  const left = overturnedOpen(await store.decisions.all());
  console.info(`${noted.id}: note added${left.length ? `; still to act on: ${left.map((d) => d.id).join(", ")}` : ""}`);
  return 0;
};

const VERDICT: Record<string, "agreed" | "overturned"> = { agree: "agreed", agreed: "agreed", overturn: "overturned", overturned: "overturned" };
// The operator's review, as the web app gives it: a control, which the team's machine writes onto the record within a
// minute, passing an overturn to the planner.
const review: Handler = async ({ team, store, who }, [id, verdict], options) => {
  if (who !== OPERATOR) throw new Refused("reviewing what was decided for the operator is the operator's");
  if (!id || !verdict || !VERDICT[verdict])
    throw new Refused('a6g decision review <id> agree, or a6g decision review <id> overturn --note "<what to do instead>"');
  const control = await requestReview(store, team.name, { id, verdict: VERDICT[verdict], note: optionText(options["note"]) ?? "", by: OPERATOR });
  console.info(
    control.review?.verdict === "overturned"
      ? `${control.review.decision}: overturned. The planner hears within a minute, undoes it as you say and notes what it did.`
      : `${control.review?.decision}: agreed.`
  );
  return 0;
};

const OPTIONS: Record<string, string[]> = {
  route: ["topic", "stakes", "confidence"],
  agreement: [],
  record: ["decided", "because", "topic", "stakes", "confidence", "options", "task", "undo"],
  list: ["flagged", "to-review", "overturned", "json"],
  show: ["json"],
  note: ["text"],
  review: ["note"],
};
const COMMANDS: Record<string, Handler> = { route: routeCommand, agreement: showAgreement, record, list, show, note, review };

export async function decision(argv: string[]): Promise<number> {
  const [sub = "help", ...rest] = argv;
  const handler = COMMANDS[sub];
  if (!handler) {
    console.info(USAGE);
    return sub === "help" || sub === "--help" ? 0 : 2;
  }
  const { positional, options } = parseArgs(rest, { booleans: ["flagged", "to-review", "overturned", "json", "help"] });
  if (options["help"] === true) {
    console.info(USAGE);
    return 0;
  }
  try {
    const known = OPTIONS[sub] ?? [];
    const unknown = Object.keys(options).filter((key) => key !== "--" && !known.includes(key));
    if (unknown.length)
      throw new Refused(
        `a6g decision ${sub} takes ${known.length ? known.map((k) => `--${k}`).join(", ") : "no options"}, not ${unknown.map((k) => `--${k}`).join(", ")}`
      );
    const { home, team, run } = teamSession();
    if (team.board.type !== "tasks") throw new Refused("this team's board is GitHub issues (team.json board), so it keeps no decision log");
    const store = await openTeamStore(team, run, home);
    try {
      return await handler({ home, team, store, who: actor() }, positional, options);
    } finally {
      await store.close();
    }
  } catch (error) {
    if (error instanceof Refused) {
      console.error(`decision: ${error.message}`);
      return 2;
    }
    throw error;
  }
}
