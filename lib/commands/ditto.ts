// a6g ditto <team>: connects a team to the operator's Ditto on this machine (lib/ditto.ts). Ditto serves a project
// only with a token for a grant the operator made, bound to the project's folder. --grant makes the team's grant in
// their Ditto and keeps its token in the Keychain, so the token is never shown, typed or written to a file; the
// team's rules (team.json `ditto`) say which roles then read it, and whether they may record notes. The operator's
// alone: it gives agents a person's own preferences to read.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadTeam } from "../config.ts";
import { dittoServer, forgetToken, grantName, hasToken, readToken, setDittoServer, storeToken } from "../ditto.ts";
import { operatorOnly } from "../session.ts";
import { die, parseArgs, text as optionText } from "../util.ts";
import { entryFor } from "./team.ts";

const USAGE = `usage: a6g ditto <team>                    whether the team is connected to your Ditto, and what its grant allows
       a6g ditto <team> --grant [--server <path to ditto-mcp.js>] [--categories <codes> | --all] [--sensitive]
                                              make the team's grant in your Ditto and keep its token in the Keychain.
                                              Without --categories it reads every category but the sensitive ones;
                                              --all reads those too. The server's path is remembered after the first time
       a6g ditto <team> --off                 revoke the grant and forget its token`;

// Ditto's own command line, quietly: what it prints holds the token, so it's read here and never shown.
const run = (server: string, args: string[], options: { cwd?: string; token?: string } = {}) =>
  spawnSync(process.execPath, [server, ...args], {
    encoding: "utf8",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...(options.token ? { DITTO_TOKEN: options.token } : {}) },
  });

// Whether the token still opens the grant from the team's checkout (ditto-mcp check), in Ditto's own words.
function checked(server: string, home: string, token: string): string {
  const result = run(server, ["check"], { cwd: home, token });
  return (result.stdout || result.stderr || "no answer from Ditto").trim().split("\n")[0] ?? "";
}

export function ditto(argv: string[]): number {
  operatorOnly("ditto");
  const { positional, options } = parseArgs(argv, { booleans: ["grant", "off", "all", "sensitive", "help"] });
  if (options["help"] === true || !positional[0]) {
    console.info(USAGE);
    return options["help"] === true ? 0 : 2;
  }
  const entry = entryFor(positional[0]);
  const team = loadTeam(entry.home, { strict: false });
  const given = optionText(options["server"]);
  if (given && !existsSync(resolve(given))) die(`${given} isn't there; --server is the path to Ditto's mcp/bin/ditto-mcp.js`);
  const server = given ? realpathSync(resolve(given)) : dittoServer();
  const rules = team.ditto
    ? `team.json gives Ditto to the ${team.ditto.roles.join(" and the ")}${team.ditto.notes ? ", who may record notes there (kept as coming from a secondary source)" : ", to read only"}`
    : 'team.json has no "ditto" setting, so no role is given it yet (docs/team.md)';

  if (options["off"] === true) {
    if (server && existsSync(server)) run(server, ["revoke", grantName(team.name)]);
    forgetToken(team.name);
    console.info(
      `a6g: ${team.name} is disconnected from Ditto: its grant is revoked and its token forgotten. Threads already running lose it when they next start.`
    );
    return 0;
  }

  if (options["grant"] !== true) {
    console.info(`${team.name}: ${rules}.`);
    console.info(
      server ? `Ditto's server: ${server}${existsSync(server) ? "" : " (missing)"}` : "Ditto's server: not set (a6g ditto <team> --grant --server <path>)"
    );
    const token = server && existsSync(server) ? readToken(team.name) : null;
    console.info(
      token && server
        ? `Its grant (${grantName(team.name)}): ${checked(server, entry.home, token)}`
        : `Its grant: ${hasToken(team.name) ? "a token is kept" : "none"}`
    );
    return 0;
  }

  if (!server || !existsSync(server)) die(`where is your Ditto? Give its server once: a6g ditto ${team.name} --grant --server <path to ditto-mcp.js>`);
  let categories = optionText(options["categories"]) ?? "*";
  // Every category Ditto has, by name: its "*" leaves out the ones it marks sensitive.
  if (options["all"] === true) {
    const listed = run(server, ["categories"]).stdout ?? "";
    const codes = [...listed.matchAll(/^([A-Z]{3})\b/gm)].map((match) => match[1]);
    if (!codes.length) die(`${server} listed no categories: is it Ditto's ditto-mcp.js?`);
    categories = codes.join(",");
  }
  const sensitive = options["all"] === true || options["sensitive"] === true;
  const made = run(server, [
    "grant",
    grantName(team.name),
    "--path",
    entry.home,
    "--categories",
    categories,
    team.ditto?.notes ? "--notes-only" : "--read-only",
    ...(sensitive ? ["--sensitive"] : []),
    "--replace",
  ]);
  const token = /Token \(shown once\): (\S+)/.exec(made.stdout ?? "")?.[1];
  if (made.status !== 0 || !token) die(`Ditto didn't make the grant: ${(made.stderr || made.stdout || "no answer").trim().split("\n")[0]}`);
  if (!storeToken(team.name, token)) die("couldn't keep the token in the Keychain; the grant was made, so run this again (it replaces it)");
  setDittoServer(server);
  // Ditto's own line about the grant: its name, categories and what it may write. The token isn't in it.
  console.info((made.stdout ?? "").split("\n")[0]);
  console.info(`Its token is in your Keychain, and nowhere else. ${checked(server, entry.home, token)}`);
  console.info(`${team.name}: ${rules}.`);
  console.info(`a6g sync ${team.name} gives new threads Ditto's tools; a6g rotate ${team.name} starts the planner on them.`);
  return 0;
}
