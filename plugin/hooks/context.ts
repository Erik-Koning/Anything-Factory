#!/usr/bin/env node
// Live context, so no agent works from memory. Claude Code shows a hook's context in full only under about 10,000
// characters, so this stays short and the static rules live in the compiled prompt instead.
// - SessionStart, every role: who and when; recompiles the team's prompt if its sources changed (for the next
//   session) and says so. The planner also gets how the operator is connected (a6g connect), the members running
//   against the limits, the team's context commands (team.json "context") and its latest log entries.
// - UserPromptSubmit, planner only (every wake): the real time, members running, merge results it hasn't seen,
//   whether the environment is draining, when it may next write to the operator (team.json contact), the task graph
//   with the ideas queue and the pace (whose caps it saves for the guard), the working agreement in force with the
//   operator's standing instructions and what they overturned, and whether the operator paused the team.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { reachSummary } from "../../lib/channels.ts";
import { DEFAULT_MIN_QUEUE, instancesOf } from "../../lib/config.ts";
import { contactInForce, contactStatus } from "../../lib/contact.ts";
import { stateDir } from "../../lib/paths.ts";
import { promptFile, promptStale, writePrompt } from "../../lib/prompts.ts";
import { type HookInput, inTeam, teamSession } from "../../lib/session.ts";
import { lastFinished, runningByInstance } from "../../lib/t3.ts";
import { localTime } from "../../lib/util.ts";

if (!inTeam()) process.exit(0);
const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
const event = input.hook_event_name ?? "SessionStart";
const { home, team, run, role } = teamSession({ cwd: input.cwd, agentType: input.agent_type });
if (!team.roles[role]) process.exit(0);
if (event === "UserPromptSubmit" && role !== "planner") process.exit(0);
const state = stateDir(home);
const LIMIT = 9000;
// While the operator has the team paused, the guard refuses new members and merges.
const paused = existsSync(join(run, "paused")) ? "The operator paused the team: start no members and merge nothing until they run a6g resume." : null;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n(… cut at ${max} characters)` : text);
const runCommand = (command: string): string => {
  try {
    return execFileSync("sh", ["-c", command], { cwd: home, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return `(${command.split(" ").slice(0, 3).join(" ")} failed: ${String((error as Error).message).split("\n")[0]})`;
  }
};

const members = Object.keys(team.roles).filter((r) => r !== "planner");
// Members at work by instance (a role's legacy instances too), read once per hook; null when T3 Code's database
// couldn't be read.
const counts = role === "planner" ? runningByInstance(members.flatMap((r) => instancesOf(team, r))) : null;
const atWork = (r: string): number => instancesOf(team, r).reduce((sum, id) => sum + (counts?.[id] ?? 0), 0);
function slots() {
  if (!counts) return "Members running: unknown (T3 Code's database couldn't be read).";
  return `Members running / limit: ${members.map((r) => `${r} ${atWork(r)}/${team.roles[r]?.limit}`).join(", ")}.`;
}

// Merge results the queue finished since the planner last looked; each is shown once.
function merges() {
  const dir = join(state, "merges");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".seen.json"))
    .map((name) => {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
      renameSync(join(dir, name), join(dir, name.replace(/\.json$/, ".seen.json")));
      return `- ${record.branch}: ${record.result}${record.sha ? ` at ${record.sha}` : ""}. ${record.message ?? ""}`.trim();
    });
}

// The task graph in a few lines (lib/tasks/ops.ts summary), with the ideas queue and the pace (lib/pace.ts), for the
// planner. The pace goes to the run folder, where the guard holds the planner's starts to it. A pace that can't be worked
// out leaves the summary, and clears what the guard holds the planner to: the role limits alone, as without a budget.
async function graph(): Promise<string | null> {
  if (team.board.type !== "tasks") return null;
  try {
    const { agreementContext, measurePace, openTeamStore, summary } = await import("../../lib/tasks/ops.ts");
    const { clearPace, writePace } = await import("../../lib/pace.ts");
    const store = await openTeamStore(team, run, home);
    try {
      const all = await store.tasks.all();
      let pace: Awaited<ReturnType<typeof measurePace>> | null = null;
      let paceText: string;
      try {
        pace = await measurePace(team, run, store, { all, counts });
        writePace(run, pace, pace.started);
        paceText = pace.text;
      } catch (error) {
        clearPace(run);
        paceText = `Pace: couldn't be worked out (${String((error as Error).message).split("\n")[0]}), so only the role limits hold; a6g task pace tries again.`;
      }
      const innovator = team.roles["innovator"];
      const ideas = innovator
        ? {
            min: innovator.minQueue ?? DEFAULT_MIN_QUEUE,
            running: counts ? atWork("innovator") : null,
            budgetBound: pace?.waiting != null,
            lastPass: lastFinished(instancesOf(team, "innovator")),
          }
        : undefined;
      // How readily to ask the operator, as it stands now (the working agreement), and what they overturned.
      const checkIns = agreementContext(await store.controls.all(), await store.decisions.all(), team.operator);
      return [
        clip(summary(all, { approval: team.approval.mode, requests: await store.requests.all(), ideas }), 2500),
        paceText,
        clip(checkIns, 2800),
      ].join("\n");
    } finally {
      await store.close();
    }
  } catch (error) {
    return `The task graph couldn't be read: ${String((error as Error).message).split("\n")[0]}`;
  }
}

let context;
if (event === "UserPromptSubmit") {
  const finished = merges();
  const drain = join(state, "drain");
  context = [
    `Now: ${localTime()} (local). a6g log stamps this time.`,
    slots(),
    finished.length ? `Merge queue results:\n${finished.join("\n")}` : null,
    existsSync(drain) ? `Draining for an environment reset: no new ${readFileSync(drain, "utf8").trim()} until a6g drain off.` : null,
    contactStatus(contactInForce(run, team.contact), run),
    await graph(),
    paused,
  ]
    .filter(Boolean)
    .join("\n");
} else {
  const parts = [`You are the ${role} of the ${team.title} (session ${input.session_id}, ${input.source ?? "startup"}, ${localTime()}).`];
  if (promptStale(team, role, run)) {
    writePrompt(team, role, run);
    parts.push(
      `The team's rules changed after this session's prompt was compiled. Read the current ones before you start: ${promptFile(run, role)}. Where they differ, they win.`
    );
  }
  if (role === "planner") {
    if (paused) parts.push(paused);
    const { working, failing } = reachSummary();
    if (working.length)
      parts.push(
        `The operator is connected (${working.join("; ")}): put messages for them in ${join(run, "outbox")}, as Talking to the operator says. The watchdog delivers them, and passes on their replies.`
      );
    if (failing.length)
      parts.push(
        `Not reaching the operator now: ${failing.join("; ")}. The watchdog has told them on their Mac.${working.length ? "" : " Until it works, use Gmail if you have it."}`
      );
    const contact = contactStatus(contactInForce(run, team.contact), run);
    if (contact) parts.push(contact);
    parts.push(slots());
    const tasks = await graph();
    if (tasks) parts.push(tasks);
    for (const { title, command } of team.context) parts.push(`${title}:\n${clip(runCommand(command), 2000)}`);
    const logFile = join(state, "log.md");
    const log = existsSync(logFile)
      ? readFileSync(logFile, "utf8").split("\n\n").slice(1, 5).join("\n\n")
      : "(no log yet: this is the team's first session)";
    parts.push(`Your latest log entries (a6g log; newest first):\n${clip(log, 3000)}`);
  }
  context = parts.join("\n\n");
}

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: clip(context, LIMIT) } }));
