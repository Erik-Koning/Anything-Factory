// Vulnerable packages are a finding. After merges, when a lockfile isn't the one last audited (and once a week when it
// is: advisories arrive for packages that didn't change), the package manager's own audit of what ships runs beside
// it, and each package with an advisory at high or critical is one finding.
//
// The audit asks the registry the install already uses, so that registry is sent the names and versions of the
// packages. team.json's "security": {"audit": false} turns it off. A registry that can't be reached, or a report that
// can't be read, is a line in the log and nothing more: it's tried again at the next check, and never fails a merge.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readJson, writeJson } from "./util.ts";

export interface Advisory {
  title: string;
  severity: string;
  url: string;
  // The versions it's in, and (where the report says) the versions it's fixed in.
  affects: string;
  fixed: string | null;
}

// A package with an advisory of its own at high or critical.
export interface Vulnerable {
  name: string;
  severity: "high" | "critical";
  // The app's own dependency, or one that comes with another: `through` names the app's own that bring it.
  direct: boolean;
  through: string[];
  // Every advisory the report has for it, the worst first.
  advisories: Advisory[];
  // What moves the app off it, where the report says.
  fix: string | null;
}

const RANK = ["info", "low", "moderate", "high", "critical"];
const rank = (severity: string): number => RANK.indexOf(severity);
const FILED_FROM = rank("high");
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

// A package's advisories as a finding, or null when none of its own reaches high.
function vulnerable(name: string, advisories: Advisory[], rest: Pick<Vulnerable, "direct" | "through" | "fix">): Vulnerable | null {
  const sorted = [...advisories].sort((a, b) => rank(b.severity) - rank(a.severity) || a.url.localeCompare(b.url));
  const worst = sorted[0]?.severity ?? "";
  if (rank(worst) < FILED_FROM) return null;
  return { name, severity: worst as Vulnerable["severity"], ...rest, advisories: sorted };
}
const worstFirst = (found: Vulnerable[]): Vulnerable[] =>
  found.sort((a, b) => rank(b.severity) - rank(a.severity) || Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));

// npm's report (npm audit --json, auditReportVersion 2): one entry per package, its advisories in `via` (an entry
// there that's only a name is another package's advisory reaching this one), the packages that depend on it in
// `effects`. Null when it isn't a report (offline, npm prints {"message": …, "error": {…}}).
export function readNpm(report: unknown): Vulnerable[] | null {
  const entries = record(record(report)?.["vulnerabilities"]);
  if (!entries) return null;
  const entry = (name: string): Record<string, unknown> => record(entries[name]) ?? {};
  const found: Vulnerable[] = [];
  for (const name of Object.keys(entries)) {
    const own = array(entry(name)["via"])
      .map(record)
      .filter((via) => via !== null)
      .map((via) => ({ title: text(via["title"]), severity: text(via["severity"]), url: text(via["url"]), affects: text(via["range"]), fixed: null }));
    // The app's own dependencies that bring it: up through what depends on it.
    const through = new Set<string>();
    const seen = new Set([name]);
    for (const queue = array(entry(name)["effects"]).map(text); queue.length;) {
      const next = queue.shift() ?? "";
      if (!next || seen.has(next)) continue;
      seen.add(next);
      if (entry(next)["isDirect"] === true) through.add(next);
      queue.push(...array(entry(next)["effects"]).map(text));
    }
    const fixIn = entry(name)["fixAvailable"];
    const fixTo = record(fixIn);
    const fix = fixTo
      ? `${text(fixTo["name"])} ${text(fixTo["version"])}${fixTo["isSemVerMajor"] === true ? " (a major version up)" : ""}`
      : fixIn === true
        ? "a version package.json's ranges already allow (npm audit fix moves the lockfile to it)"
        : null;
    const one = vulnerable(name, own, { direct: entry(name)["isDirect"] === true, through: [...through].sort(), fix });
    if (one) found.push(one);
  }
  return worstFirst(found);
}

// pnpm's report (pnpm audit --json): one entry per advisory, with the package it's in and the paths that reach it
// (importer>dependency>…>package). Null when it isn't a report.
export function readPnpm(report: unknown): Vulnerable[] | null {
  const entries = record(record(report)?.["advisories"]);
  if (!entries) return null;
  const byName = new Map<string, { advisories: Advisory[]; direct: boolean; through: Set<string> }>();
  for (const value of Object.values(entries)) {
    const advisory = record(value);
    const name = text(advisory?.["module_name"]);
    if (!advisory || !name) continue;
    const pkg = byName.get(name) ?? { advisories: [], direct: false, through: new Set<string>() };
    byName.set(name, pkg);
    pkg.advisories.push({
      title: text(advisory["title"]),
      severity: text(advisory["severity"]),
      url: text(advisory["url"]),
      affects: text(advisory["vulnerable_versions"]),
      fixed: text(advisory["patched_versions"]) || null,
    });
    for (const finding of array(advisory["findings"]))
      for (const path of array(record(finding)?.["paths"]).map(text)) {
        const [, ...chain] = path.split(">");
        if (chain.length === 1) pkg.direct = true;
        else if (chain[0]) pkg.through.add(chain[0]);
      }
  }
  const found: Vulnerable[] = [];
  for (const [name, pkg] of byName) {
    const one = vulnerable(name, pkg.advisories, { direct: pkg.direct, through: [...pkg.through].sort(), fix: null });
    if (one) found.push(one);
  }
  return worstFirst(found);
}

interface Tool {
  tool: string;
  args: string[];
  read: (report: unknown) => Vulnerable[] | null;
}
const NPM: Tool = { tool: "npm", args: ["audit", "--omit=dev", "--json"], read: readNpm };
const TOOLS: Record<string, Tool> = {
  "package-lock.json": NPM,
  "npm-shrinkwrap.json": NPM,
  "pnpm-lock.yaml": { tool: "pnpm", args: ["audit", "--prod", "--json"], read: readPnpm },
};
// Lockfiles whose manager's audit isn't read: said once, not audited.
const UNREAD = ["yarn.lock", "bun.lock", "bun.lockb"];
const MOST = 5;
const LIMIT_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

// The lockfiles the repository tracks (so none under node_modules), nearest the root first.
export function lockfiles(home: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z", "--", ...[...Object.keys(TOOLS), ...UNREAD].map((name) => `:(glob)**/${name}`)], {
      cwd: home,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter((path) => path && !path.split("/").includes("node_modules") && existsSync(join(home, path)))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  } catch {
    return [];
  }
}

export interface Ran {
  stdout: string;
  stderr: string;
  // Why it gave no output to read: the tool isn't there, or it ran out of time.
  failed?: "missing" | "timeout";
}
export type Runner = (tool: string, args: string[], cwd: string) => Promise<Ran>;

// Both audits exit 1 when they find something, so the exit status says nothing: what they print does.
const exec: Runner = (tool, args, cwd) =>
  new Promise((done) => {
    execFile(
      tool,
      args,
      { cwd, encoding: "utf8", timeout: LIMIT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1", NO_UPDATE_NOTIFIER: "1" } },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
        done({
          stdout,
          stderr,
          ...(failure?.code === "ENOENT" ? { failed: "missing" as const } : failure?.killed ? { failed: "timeout" as const } : {}),
        });
      }
    );
  });

// What a tool said went wrong, in a line: its own message, without the decoration.
const saidWrong = (ran: Ran, report: unknown): string => {
  const message = text(record(report)?.["message"]);
  if (message) return message.slice(0, 200);
  const line = `${ran.stderr}\n${ran.stdout}`
    .split("\n")
    .map((each) => each.replace(/^[\s│├╰─▶×]+/u, "").trim())
    .find((each) => each && !/^npm warn/i.test(each));
  return (line ?? "it printed no report").slice(0, 200);
};

// One lockfile's audit: what's vulnerable, or why nothing could be told.
export async function auditLockfile(home: string, lockfile: string, run: Runner = exec): Promise<{ command: string; vulnerable: Vulnerable[] } | string> {
  const tool = TOOLS[basename(lockfile)];
  if (!tool) return `${basename(lockfile)} isn't a lockfile a6g audits`;
  const ran = await run(tool.tool, tool.args, join(home, dirname(lockfile)));
  if (ran.failed === "missing") return `${tool.tool} isn't installed here`;
  if (ran.failed === "timeout") return `${tool.tool} audit didn't finish in ${LIMIT_MS / 1000} seconds`;
  let report: unknown = null;
  try {
    report = JSON.parse(ran.stdout);
  } catch {
    // Not a report: said below.
  }
  const vulnerable = tool.read(report);
  return vulnerable ? { command: `${tool.tool} ${tool.args.filter((arg) => arg !== "--json").join(" ")}`, vulnerable } : saidWrong(ran, report);
}

// state/package-audit.json: each lockfile as it was when last audited (or last said to be one a6g doesn't audit).
type Audited = Record<string, { hash: string; at: string }>;
const auditedFile = (state: string): string => join(state, "package-audit.json");
const readAudited = (state: string): Audited => {
  try {
    return (record(readJson(auditedFile(state))) ?? {}) as Audited;
  } catch {
    return {};
  }
};

export interface AuditRound {
  // One line each, for the check's log.
  said: string[];
  // The lockfiles whose audit gave a report.
  audited: { lockfile: string; command: string; vulnerable: Vulnerable[] }[];
  // What to remember once the round's findings are filed (recordAudited).
  seen: Audited;
}

// Audits the lockfiles that are due: changed since their last audit, or audited a week ago or more.
export async function auditPackages(
  home: string,
  state: string,
  { now = Date.now(), run = exec }: { now?: number; run?: Runner } = {}
): Promise<AuditRound> {
  const round: AuditRound = { said: [], audited: [], seen: {} };
  const before = readAudited(state);
  const all = lockfiles(home);
  const audits = all.filter((lockfile) => TOOLS[basename(lockfile)]);
  if (audits.length > MOST) round.said.push(`packages: ${audits.length} lockfiles, and the ${MOST} nearest the root are audited`);
  for (const lockfile of [...audits.slice(0, MOST), ...all.filter((each) => !TOOLS[basename(each)])]) {
    const hash = createHash("sha256")
      .update(readFileSync(join(home, lockfile)))
      .digest("hex");
    const last = before[lockfile];
    if (last?.hash === hash && now - Date.parse(last.at) < WEEK_MS) continue;
    const mark = { hash, at: new Date(now).toISOString() };
    if (!TOOLS[basename(lockfile)]) {
      round.said.push(`packages: ${lockfile} isn't audited (npm's and pnpm's audits are the ones read)`);
      round.seen[lockfile] = mark;
      continue;
    }
    const result = await auditLockfile(home, lockfile, run);
    if (typeof result === "string") {
      round.said.push(`the package audit of ${lockfile} didn't run: ${result}`);
      continue;
    }
    const names = result.vulnerable.map((pkg) => pkg.name);
    round.said.push(
      names.length
        ? `packages: ${lockfile} has ${names.length} with an advisory at high or critical (${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""})`
        : `packages: ${lockfile} has none with an advisory at high or critical`
    );
    round.audited.push({ lockfile, ...result });
    round.seen[lockfile] = mark;
  }
  return round;
}

// Remembers what a round audited, so it's next due when a lockfile changes or a week has passed.
export function recordAudited(state: string, round: AuditRound): void {
  if (Object.keys(round.seen).length) writeJson(auditedFile(state), { ...readAudited(state), ...round.seen });
}

// The finding's key, what makes it a different failure (a new advisory at high or critical), and its text.
export const auditKey = (lockfile: string, name: string): string => `audit:${lockfile}:${name}`;
export const auditSignature = (pkg: Vulnerable): string =>
  pkg.advisories
    .filter((advisory) => rank(advisory.severity) >= FILED_FROM)
    .map((advisory) => advisory.url || advisory.title)
    .sort()
    .join("\n");
export function auditFinding(lockfile: string, command: string, pkg: Vulnerable, at: string): { title: string; body: string } {
  const whose = pkg.direct
    ? "one of the app's own dependencies"
    : `a package that comes with ${pkg.through.length ? pkg.through.join(", ") : "another"}, not one the app names itself`;
  const lines = pkg.advisories.map((advisory) =>
    `- ${advisory.severity}: ${advisory.title} (in ${advisory.affects || "every version"}${advisory.fixed ? `; fixed in ${advisory.fixed}` : ""}) ${advisory.url}`.trimEnd()
  );
  const fix = pkg.fix ? `What the audit says moves the app off it: ${pkg.fix}.` : "";
  const how = pkg.direct
    ? "Move it to a fixed version"
    : `Move ${pkg.through.length ? pkg.through.join(" or ") : "the dependency that brings it"} to a version that brings a fixed one (or pin a fixed one with an override where there's no such release)`;
  return {
    title: `Vulnerable package: ${pkg.name} (${pkg.severity})`.slice(0, 120),
    body: `The audit of what ships (${command}, beside ${lockfile}) at ${at.slice(0, 9)} names ${pkg.name}, ${whose}:\n${lines.join("\n")}\n\n${fix ? `${fix} ` : ""}${how}, run the gate, and run the audit again to see it no longer names ${pkg.name}. Nothing else changes in the same branch. If the advisory can't reach the way the app uses the package, that's the operator's call: say why, and they reject this finding, which then stays quiet until a new advisory names the package.`,
  };
}
