// a6g metrics [--quality] [--since <ISO time>] [--until …] [--team <name>] [--json]
//
// What a team has cost, per role: agents (T3 threads), runs (T3 turns: one wake of the planner, one task of a
// member), model requests and tool calls (from the Claude transcripts), tokens and wall time. Two sources that
// should agree: T3 Code's database (per-turn token usage) and the transcripts under each subscription's login (~/.claude/projects).
//
// --quality: how the merged work went instead (lib/quality.ts), from the team's tasks, the suite's recorded runs and
// its usage by day. It reads no T3 database, so it works before the team is registered and on any of its machines.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { roleForInstance, roleOfAgent } from "../config.ts";
import { readRegistry } from "../paths.ts";
import { describeQuality, quality } from "../quality.ts";
import { teamSession } from "../session.ts";
import { loginDirs } from "../subscriptions.ts";
import { isLead } from "../tasks/machines.ts";
import { openTeamStore } from "../tasks/ops.ts";
import { transcriptDirsByAccount } from "../usage.ts";
import { turns as t3Turns, worktreesDir } from "../t3.ts";
import { suiteHistory } from "./e2e.ts";

interface RoleRow {
  role: string;
  agents: Set<string>;
  runs: number;
  requests: number;
  toolCalls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  wallMin: number;
  sessions: Set<string>;
  tInput: number;
  tOutput: number;
}
type Tally = Pick<RoleRow, "requests" | "toolCalls" | "input" | "cacheRead" | "cacheWrite" | "output">;
type Counted = Omit<RoleRow, "agents" | "sessions"> & { agents: number; sessions: number };

// A line of a Claude Code transcript (the fields counted here).
interface TranscriptLine {
  type?: string;
  agentSetting?: string;
  timestamp?: string;
  message?: {
    id?: string;
    content?: { type?: string }[];
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
  };
}

// The quality numbers for a period: both ends are times (a date alone is its first moment, UTC), and open when not given.
async function qualityOf(option: (flag: string) => string | undefined, given: (flag: string) => boolean, json: boolean): Promise<number> {
  const bounds: { since: number | null; until: number | null } = { since: null, until: null };
  for (const flag of ["since", "until"] as const) {
    if (!given(`--${flag}`)) continue;
    const ms = Date.parse(option(`--${flag}`) ?? "");
    if (Number.isNaN(ms)) {
      console.error(`metrics: --${flag} takes a time like 2026-03-01 or 2026-03-01T09:00:00Z, not "${option(`--${flag}`) ?? ""}"`);
      return 2;
    }
    bounds[flag] = ms;
  }
  const { home, team, run: runDir } = teamSession({ team: option("--team") });
  if (team.board.type !== "tasks") {
    console.error(
      "metrics: the quality numbers are read from the team's task graph, and this team keeps its work on a GitHub board (board, .a6g/team.json)"
    );
    return 2;
  }
  const store = await openTeamStore(team, runDir, home);
  let numbers;
  try {
    numbers = quality(await store.tasks.all(), isLead(team) ? suiteHistory(home) : null, await store.usage.since("0000-00-00"), bounds);
  } finally {
    await store.close();
  }
  const [since, until] = [option("--since"), option("--until")];
  if (json) {
    console.info(JSON.stringify({ team: team.name, since: given("--since") ? since : null, until: given("--until") ? until : null, ...numbers }, null, 2));
    return 0;
  }
  const period =
    bounds.since !== null && bounds.until !== null
      ? `${since} to ${until}`
      : bounds.since !== null
        ? `since ${since}`
        : bounds.until !== null
          ? `until ${until}`
          : "all of it";
  console.info(`How team ${team.name}'s merged work went, ${period}:`);
  for (const line of describeQuality(numbers)) console.info(`  ${line}`);
  return 0;
}

export function run(args: string[]): number | Promise<number> {
  const option = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  if (args.includes("--quality")) return qualityOf(option, (flag) => args.includes(flag), args.includes("--json"));
  const { home, team } = teamSession({ team: option("--team") });
  const project = option("--project") ?? readRegistry(team.name)?.project ?? team.raw.t3ProjectId;
  const since = option("--since") ?? "1970-01-01T00:00:00Z";
  const until = option("--until") ?? "9999-12-31T00:00:00Z";
  const roleOf = (instance: string) => roleForInstance(team, instance) ?? instance;
  if (!project) {
    console.error("metrics: the team isn't registered with T3 Code yet (a6g register), and no --project was given");
    return 2;
  }

  // --- T3 Code's database ------------------------------------------------------------------------------------
  const turns = t3Turns(project, since, until);

  const byRole: Record<string, RoleRow> = {};
  const row = (role: string): RoleRow => {
    byRole[role] ??= {
      role,
      agents: new Set(),
      runs: 0,
      requests: 0,
      toolCalls: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      wallMin: 0,
      sessions: new Set(),
      tInput: 0,
      tOutput: 0,
    };
    return byRole[role];
  };
  for (const turn of turns) {
    const r = row(roleOf(turn.instance));
    r.agents.add(turn.thread);
    r.runs += 1;
    r.tInput += turn.input ?? 0;
    r.tOutput += turn.output ?? 0;
    if (turn.started && turn.completed) r.wallMin += (Date.parse(turn.completed) - Date.parse(turn.started)) / 60_000;
  }

  // --- Claude transcripts: the loop checkout and the T3 worktrees made from it. --------------------------------
  const worktrees = worktreesDir(home);
  // Every transcript folder for the loop checkout or a worktree made from it, including worktrees the watchdog has
  // already removed (their transcripts stay in ~/.claude/projects), under every subscription's login. No transcripts
  // yet (Claude Code hasn't run on this machine, or under this HOME): T3 Code's counts stand alone.
  const dirs = Object.values(transcriptDirsByAccount(home, worktrees, loginDirs())).flat();
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".jsonl"))) {
      const path = join(dir, name);
      if (statSync(path).mtimeMs < sinceMs) continue;
      let role: string | null = null;
      const seen = new Set<string>();
      const tally: Tally = { requests: 0, toolCalls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let entry: TranscriptLine;
        try {
          entry = JSON.parse(line) as TranscriptLine;
        } catch {
          continue;
        }
        if (entry.type === "agent-setting") role = roleOfAgent(entry.agentSetting);
        if (entry.type !== "assistant" || !entry.message?.id) continue;
        const at = Date.parse(entry.timestamp ?? "");
        if (at < sinceMs || at >= untilMs) continue;
        tally.toolCalls += (entry.message.content ?? []).filter((block) => block.type === "tool_use").length;
        if (seen.has(entry.message.id)) continue; // one request streams several lines with the same id
        seen.add(entry.message.id);
        const usage = entry.message.usage ?? {};
        tally.requests += 1;
        tally.input += usage.input_tokens ?? 0;
        tally.cacheRead += usage.cache_read_input_tokens ?? 0;
        tally.cacheWrite += usage.cache_creation_input_tokens ?? 0;
        tally.output += usage.output_tokens ?? 0;
      }
      if (!role || !tally.requests) continue; // not a loop agent (no --agent), or nothing in the window
      const r = row(role);
      r.sessions.add(name);
      for (const key of Object.keys(tally) as (keyof Tally)[]) r[key] += tally[key];
    }
  }

  const rows: Counted[] = Object.values(byRole).map((r) => ({ ...r, agents: r.agents.size, sessions: r.sessions.size, wallMin: Math.round(r.wallMin) }));
  const total = rows.reduce(
    (sum, r) => {
      for (const key of [
        "agents",
        "sessions",
        "runs",
        "requests",
        "toolCalls",
        "input",
        "cacheRead",
        "cacheWrite",
        "output",
        "wallMin",
        "tInput",
        "tOutput",
      ] as const)
        sum[key] += r[key];
      return sum;
    },
    {
      role: "total",
      agents: 0,
      sessions: 0,
      runs: 0,
      requests: 0,
      toolCalls: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      wallMin: 0,
      tInput: 0,
      tOutput: 0,
    }
  );

  if (args.includes("--json")) {
    console.info(JSON.stringify({ project, since, until, roles: rows, total }, null, 2));
    return 0;
  }
  const k = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const header = ["role", "agents", "runs", "requests", "tool calls", "input", "cache read", "cache write", "output", "agent-min"];
  const lines = [...rows.sort((a, b) => b.cacheRead + b.input - (a.cacheRead + a.input)), total].map((r) => [
    r.role,
    r.agents,
    r.runs,
    r.requests,
    r.toolCalls,
    k(r.input),
    k(r.cacheRead),
    k(r.cacheWrite),
    k(r.output),
    r.wallMin,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((line) => String(line[i]).length)));
  const fmt = (cells: (string | number)[]) =>
    cells.map((cell, i) => (i ? String(cell).padStart(widths[i] ?? 0) : String(cell).padEnd(widths[i] ?? 0))).join("  ");
  console.info(`T3 project ${project}, ${since} → ${until === "9999-12-31T00:00:00Z" ? "now" : until}`);
  console.info(fmt(header));
  for (const line of lines) console.info(fmt(line));
  console.info(
    `Input = uncached prompt tokens; cache read/write are prompt tokens served from or written to the prompt cache. T3's own count of all prompt tokens: ${k(total.tInput)}, output ${k(total.tOutput)}.`
  );
  return 0;
}
