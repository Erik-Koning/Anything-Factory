// Ditto: the operator's own record of their taste and judgment, served by an MCP server on their machine to the
// projects they grant (https://github.com/Erik-Koning/Ditto). A team whose rules name it (team.json `ditto`) gives
// the roles it lists Ditto's read tools and, with `notes`, its one write for agents: a note kept as coming from a
// secondary source, which Ditto never takes for the operator's word.
//
// What's where:
//   team.json `ditto`          which roles read it, and whether they may note (the team's rules; lib/config.ts)
//   ~/.a6g/ditto.json          where the operator's Ditto server is on this machine (a6g ditto)
//   the Keychain, a6g-ditto    each team's token for its grant; agents never see it
//   <run>/mcp/ditto.json       what a member's Claude Code starts with (--mcp-config): the launcher, plugin/mcp/ditto.ts
//
// The launcher reads the token and starts the server with it in the member's own folder, which is what the grant is
// bound to. So the token is in no file, no launch argument and no member's environment.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { forgetSecret, hasSecret, readSecret, storeSecret } from "./keychain.ts";
import { A6G_HOME, pluginDir } from "./paths.ts";
import { writeJson } from "./util.ts";

// The server's name in a member's MCP configuration, and so in every tool's name.
export const DITTO_SERVER = "ditto";
const tool = (name: string): string => `mcp__${DITTO_SERVER}__${name}`;
// What a role with Ditto may call. `status` is all the server gives a client it doesn't know, and says why.
export const DITTO_READ = ["whoami", "get_profile", "consult", "get_expertise", "status"].map(tool);
// The one write, and only where the team's rules allow notes. Ditto's other writes (answers, corrections, rules, the
// operator's focus) are the operator's own word, which no member records.
export const DITTO_NOTE = tool("record_note");
// The roles that read it where the team's rules name none: the planner decides in the operator's place, and the
// innovator works out how a thing should feel (a thinking stream).
export const DITTO_ROLES = ["planner", "innovator"];

export interface DittoSettings {
  roles: string[];
  notes: boolean;
}
export const dittoTools = (ditto: DittoSettings | null, role: string): string[] =>
  ditto?.roles.includes(role) ? [...DITTO_READ, ...(ditto.notes ? [DITTO_NOTE] : [])] : [];

// --- This machine -------------------------------------------------------------------------------------------------

const machineFile = (): string => join(A6G_HOME, "ditto.json");
// The operator's Ditto server (its bin/ditto-mcp.js), or null before a6g ditto has been told.
export function dittoServer(): string | null {
  try {
    const { server } = JSON.parse(readFileSync(machineFile(), "utf8")) as { server?: unknown };
    return typeof server === "string" && server ? server : null;
  } catch {
    return null;
  }
}
export const setDittoServer = (server: string): void => writeJson(machineFile(), { server });

const SERVICE = "a6g-ditto";
// The grant a team has in the operator's Ditto, by name.
export const grantName = (team: string): string => `a6g-${team}`;
export const storeToken = (team: string, token: string): boolean => storeSecret(SERVICE, team, `Anything Factory: Ditto (${team})`, token);
export const readToken = (team: string): string | null => readSecret(SERVICE, team);
export const hasToken = (team: string): boolean => hasSecret(SERVICE, team);
export const forgetToken = (team: string): void => forgetSecret(SERVICE, team);

// --- A member's launch --------------------------------------------------------------------------------------------

export const mcpConfigFile = (run: string): string => join(run, "mcp", "ditto.json");
// The MCP configuration a member with Ditto starts on. It names the launcher and the team, and holds no secret.
export function writeMcpConfig(run: string, team: string, version: string): string {
  const file = mcpConfigFile(run);
  writeJson(file, { mcpServers: { [DITTO_SERVER]: { command: process.execPath, args: [join(pluginDir(version), "mcp", "ditto.ts"), team] } } });
  return file;
}

// Starts the operator's Ditto server for a member of `team`, as Claude Code's child: its stdio is the server's. With
// no token it still starts, since the server then offers only `status`, which says why it's closed.
export function launch(team: string): Promise<number> {
  const server = dittoServer();
  if (!server || !existsSync(server)) {
    console.error(
      `a6g: Ditto isn't connected on this machine (${server ? `${server} is missing` : "no server set"}): a6g ditto ${team || "<team>"} --grant --server <ditto-mcp.js>`
    );
    return Promise.resolve(1);
  }
  const token = team ? readToken(team) : null;
  const env = { ...process.env, ...(token ? { DITTO_TOKEN: token } : {}) };
  return new Promise((done) => {
    const child = spawn(process.execPath, [server, "serve"], { stdio: "inherit", env });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code ?? 1));
  });
}
