// What this Mac's Claude Code can run, as T3 Code sees it. T3 Code's model catalogue (userdata/model-manifest.json)
// names the oldest Claude Code each model needs, and T3 Code refuses to start a member on a model the installed one is
// too old for ("model_unavailable: Model … is not advertised by provider …"); a thread started from its CLI isn't
// checked, so a planner still starts. On 2026-11-27 every team's innovator and scaffolder were refused Fable 5.2 for a
// day: the catalogue wanted Claude Code 2.1.321 and Homebrew's was 2.1.311, and the guard held the planner to Fable for
// them. The steering now runs such a role on its fallback until Claude Code is updated (lib/steer.ts), and
// `a6g doctor` says what to update.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelName } from "./models.ts";
import { T3_HOME, satisfies } from "./t3.ts";

export const MANIFEST = join(T3_HOME, "userdata", "model-manifest.json");

// The update, as the operator runs it: Homebrew's cask where that's where claude comes from, else Claude Code's own.
export const UPDATE = "brew upgrade --cask claude-code, or claude update";

// The oldest Claude Code each model needs, by its id and each alias, from T3 Code's catalogue; {} when it can't be read.
export function modelNeeds(file = MANIFEST): Record<string, string> {
  try {
    const read = JSON.parse(readFileSync(file, "utf8")) as {
      manifest?: {
        providers?: { claudeAgent?: { models?: { slug?: unknown; aliases?: unknown; adapter?: { claudeCode?: { minVersion?: unknown } } }[] } };
      };
    };
    const needs: Record<string, string> = {};
    for (const model of read.manifest?.providers?.claudeAgent?.models ?? []) {
      const min = model.adapter?.claudeCode?.minVersion;
      if (typeof model.slug !== "string" || typeof min !== "string" || !/^\d+\.\d+\.\d+$/.test(min)) continue;
      for (const name of [model.slug, ...(Array.isArray(model.aliases) ? model.aliases : [])]) if (typeof name === "string") needs[name] = min;
    }
    return needs;
  } catch {
    return {};
  }
}

// The installed Claude Code's version, as T3 Code finds it (claude on PATH), or null; read once per process.
let installed: string | null | undefined;
export function claudeCodeVersion(): string | null {
  if (installed === undefined)
    installed = /(\d+\.\d+\.\d+)/.exec(spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout ?? "")?.[1] ?? null;
  return installed;
}

// What Claude Code can run here: its version and the catalogue's needs. The steering and doctor take one, so a test
// gives its own. Without a catalogue nothing is refused, so the version isn't asked for.
export interface ClaudeCode {
  version: string | null;
  needs: Record<string, string>;
}
export function claudeCodeHere(): ClaudeCode {
  const needs = modelNeeds();
  return { version: Object.keys(needs).length ? claudeCodeVersion() : null, needs };
}

// The Claude Code version `model` needs when the installed one is older, or null: when it's new enough, or either
// isn't known (nothing is refused for a guess).
export function tooOldFor(model: string, here: ClaudeCode): string | null {
  const min = here.needs[model];
  return min && here.version && !satisfies(here.version, `>=${min}`) ? min : null;
}

// Why a role on `model` can't start on it here, in the operator's words.
export const tooOldWords = (model: string, min: string, here: ClaudeCode): string =>
  `this Mac's Claude Code ${here.version} is older than the ${min} T3 Code needs to start ${modelName(model)}: update it (${UPDATE})`;
