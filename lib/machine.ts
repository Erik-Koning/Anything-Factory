// This machine's name in a team's task graph: who holds a claim, and whether this is the team's lead (the always-on
// machine that merges), and on the web app (a6g connect app). ~/.a6g/machine.json, which `a6g connect mongo|app
// --machine <name>` writes, or the host's name.
import { hostname } from "node:os";
import { join } from "node:path";
import { MACHINE_NAME } from "./fleet.ts";
import { A6G_HOME } from "./paths.ts";
import { readJson, writeJson } from "./util.ts";

export const MACHINE_FILE = join(A6G_HOME, "machine.json");
export { MACHINE_NAME };

// The name saved for this machine, or null while it goes by its host's.
export function savedMachineName(): string | null {
  try {
    const saved = readJson<{ name?: unknown }>(MACHINE_FILE, {}).name;
    if (typeof saved === "string" && MACHINE_NAME.test(saved)) return saved;
  } catch {}
  return null;
}

export function machineName(): string {
  const saved = savedMachineName();
  if (saved) return saved;
  return (
    hostname()
      .replace(/\.local$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 41) || "this-mac"
  );
}

export const saveMachineName = (name: string): void => writeJson(MACHINE_FILE, { name });
