// The room a planner has to work in: the window T3 Code compacts its context in, less what it carries into every
// turn. A planner whose rules and documents nearly fill its window compacts every few minutes, loses its place each
// time, and has its turn ended by Claude Code once three compactions in a row couldn't keep up ("Autocompact is
// thrashing"); a turn that ends so can leave its thread queued for good (lib/t3.ts stalled).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedTeam } from "./config.ts";
import { compile } from "./prompts.ts";

// Claude Code's own instructions and tools, the skills and agents it lists, and T3 Code's: what a turn holds before
// the team's rules and the repository's CLAUDE.md. Measured on Claude Code 2.1.326 under T3 Code 0.1: a planner whose
// rules came to 111,000 characters and whose CLAUDE.md to 54,000 began at 113,000 tokens.
export const CARRIED_BEFORE_RULES = 65_000;
const CHARS_A_TOKEN = 3.5;
// Claude Code compacts this far short of its window: 20,000 tokens kept for its answer, and 13,000 spare.
export const COMPACTS_SHORT = 33_000;
// What a planner is given to work in when team.json doesn't set its window, the least it works well in, and the
// smallest window it's given.
export const WORK_ROOM = 80_000;
export const TIGHT_ROOM = 40_000;
export const LEAST_WINDOW = 160_000;

const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");

// About how many tokens a role carries into every turn: its compiled rules (the team's decisions and lessons are in
// them), the repository's CLAUDE.md, and Claude Code's own.
export const carried = (team: LoadedTeam, role: string): number =>
  CARRIED_BEFORE_RULES + Math.round((compile(team, role).length + read(join(team.home, "CLAUDE.md")).length) / CHARS_A_TOKEN);

// What's left to work in, in a window, over what's carried.
export const roomIn = (window: number, carries: number): number => window - COMPACTS_SHORT - carries;

// The window T3 Code compacts the planner's context in: team.json's roles.planner.compactAt when it sets one, else
// what leaves it WORK_ROOM over what it carries (to the next 10,000, and 160,000 at least): about 190,000 for a team
// with few documents, more as its decisions and lessons grow. A window past the model's own changes nothing: Claude
// Code compacts at whichever comes first.
export const windowFor = (carries: number): number => Math.max(LEAST_WINDOW, Math.ceil((carries + COMPACTS_SHORT + WORK_ROOM) / 10_000) * 10_000);
export const plannerWindow = (team: LoadedTeam): number => team.roles["planner"]?.compactAt ?? windowFor(carried(team, "planner"));

// Why a planner compacting in this window has too little room, in words for the operator; null when it has enough.
// `set` says whether team.json sets the window, which decides what fixes it.
export function tightRoom(team: LoadedTeam, window: number, { set, name }: { set: boolean; name: string }): string | null {
  const carries = carried(team, "planner");
  const room = roomIn(window, carries);
  if (room >= TIGHT_ROOM) return null;
  const k = (tokens: number): string => `${Math.round(tokens / 1000).toLocaleString("en-US")},000`;
  const fix = set
    ? `raise roles.planner.compactAt in .a6g/team.json to ${k(windowFor(carries))} or leave it out, then a6g upgrade ${name}`
    : `a6g upgrade ${name} gives it room`;
  return `its planner carries about ${k(carries)} tokens of rules and documents into every turn and its context is compacted in a window of ${k(window)}, which leaves it ${room > 0 ? `about ${k(room)}` : "nothing"} to work in: it compacts every few minutes and loses its place (${fix}; shorter .a6g/decisions.md, .a6g/lessons.md and CLAUDE.md help too)`;
}
