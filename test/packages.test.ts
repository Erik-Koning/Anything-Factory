// Vulnerable packages are a finding (32). The reports under test/fixtures are what npm 11 and pnpm 12 printed for a
// project pinned to old releases of lodash and mkdirp (which brings minimist), with marked as a devDependency.
import { baseTeam, commit, git, makeRepo, ROOT, tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam } from "../lib/config.ts";
import {
  auditFinding,
  auditLockfile,
  auditPackages,
  auditSignature,
  lockfiles,
  readNpm,
  readPnpm,
  recordAudited,
  type Ran,
  type Runner,
} from "../lib/packages.ts";
import { stateDir } from "../lib/paths.ts";
import { fileStore } from "../lib/tasks/files.ts";
import type { Task } from "../lib/tasks/model.ts";
import { update } from "../lib/tasks/store.ts";
import { fileAudit, type Memory, verifyAfterMerge } from "../lib/verify.ts";

const fixture = (name: string): string => readFileSync(join(ROOT, "test", "fixtures", name), "utf8");
const report = (name: string): unknown => JSON.parse(fixture(name));
const DAY = 24 * 60 * 60_000;
// A runner that prints a fixture, and counts what it was asked.
function printing(stdout: string, more: Partial<Ran> = {}): { run: Runner; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    run: (tool, args, cwd) => {
      asked.push(`${tool} ${args.join(" ")} in ${cwd}`);
      return Promise.resolve({ stdout, stderr: "", ...more });
    },
  };
}

describe("the package audit", () => {
  test("npm's report: a package with an advisory of its own at high or critical, whose it is, and what fixes it", () => {
    const found = readNpm(report("npm-audit.json")) ?? [];
    // mkdirp is in the report only because it brings minimist: the advisory is minimist's, and so is the finding.
    assert.deepEqual(
      found.map((pkg) => [pkg.name, pkg.severity, pkg.direct, pkg.through, pkg.fix]),
      [
        ["minimist", "critical", false, ["mkdirp"], "mkdirp 0.5.6"],
        ["lodash", "high", true, [], "lodash 4.18.1"],
      ]
    );
    const lodash = found[1]?.advisories ?? [];
    assert.deepEqual(
      lodash.map((advisory) => advisory.severity),
      ["high", "high", "moderate", "moderate"],
      "all of the package's advisories, the worst first"
    );
    assert.deepEqual(lodash[0], {
      title: "Command Injection in lodash",
      severity: "high",
      url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
      affects: "<4.17.21",
      fixed: null,
    });
    assert.ok(!JSON.stringify(found).includes("marked"), "what doesn't ship isn't audited");
    // A fix inside the ranges package.json already allows is `true` in the report.
    assert.match(readNpm(report("npm-audit-in-range.json"))?.[1]?.fix ?? "", /already allow \(npm audit fix/);
    assert.deepEqual(readNpm({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} }), []);
    // Only moderate: nothing to file.
    assert.deepEqual(readNpm({ vulnerabilities: { qs: { name: "qs", severity: "moderate", isDirect: true, via: [{ severity: "moderate" }] } } }), []);
    assert.equal(readNpm(report("npm-audit-offline.json")), null, "what npm prints when it can't reach the registry is no report");
    for (const not of [null, "", [], { vulnerabilities: [] }, { advisories: {} }]) assert.equal(readNpm(not), null);
    // A report that loops (each a dependency of the other) is read once.
    const loop = { vulnerabilities: { a: { isDirect: false, via: [{ severity: "high", url: "u" }], effects: ["b"] }, b: { via: ["a"], effects: ["a"] } } };
    assert.deepEqual(readNpm(loop)?.[0]?.through, []);
  });

  test("pnpm's report: advisories gathered by package, with the paths that say whose it is", () => {
    const found = readPnpm(report("pnpm-audit.json")) ?? [];
    assert.deepEqual(
      found.map((pkg) => [pkg.name, pkg.severity, pkg.direct, pkg.through, pkg.advisories.length]),
      [
        ["minimist", "critical", false, ["mkdirp"], 2],
        ["lodash", "high", true, [], 4],
      ]
    );
    assert.deepEqual(found[0]?.advisories[0], {
      title: "Prototype Pollution in minimist",
      severity: "critical",
      url: "https://github.com/advisories/GHSA-xvch-5gv4-984h",
      affects: "<0.2.4",
      fixed: ">=0.2.4",
    });
    // In a workspace the path starts at the package that depends on it.
    assert.deepEqual(readPnpm(report("pnpm-audit-workspace.json"))?.[0]?.through, ["mkdirp"]);
    assert.deepEqual(readPnpm({ advisories: {}, metadata: {} }), []);
    for (const not of [null, "", { vulnerabilities: {} }]) assert.equal(readPnpm(not), null);
  });

  test("a finding says what the audit named, whose the package is and how to move off it; a new advisory makes it a different one", () => {
    const [minimist, lodash] = readNpm(report("npm-audit.json")) ?? [];
    assert.ok(minimist && lodash);
    const own = auditFinding("package-lock.json", "npm audit --omit=dev", lodash, "0123456789abcdef");
    assert.equal(own.title, "Vulnerable package: lodash (high)");
    assert.match(own.body, /^The audit of what ships \(npm audit --omit=dev, beside package-lock\.json\) at 012345678 names lodash, one of the app's own/);
    assert.match(own.body, /\n- high: Command Injection in lodash \(in <4\.17\.21\) https:\/\/github\.com\/advisories\/GHSA-35jh-r3h4-6jhm\n/);
    assert.match(own.body, /moves the app off it: lodash 4\.18\.1\. Move it to a fixed version, run the gate, and run the audit again/);
    assert.match(own.body, /the operator's call/);
    const theirs = auditFinding("web/pnpm-lock.yaml", "pnpm audit --prod", (readPnpm(report("pnpm-audit.json")) ?? [])[0] ?? minimist, "0123456789abcdef");
    assert.match(theirs.body, /names minimist, a package that comes with mkdirp, not one the app names itself/);
    assert.match(theirs.body, /\(in <0\.2\.4; fixed in >=0\.2\.4\)/);
    assert.match(theirs.body, /Move mkdirp to a version that brings a fixed one \(or pin a fixed one with an override/);

    // What makes a rejected finding speak again is an advisory at high or critical it didn't have.
    const high = (url: string) => ({ title: "t", severity: "high", url, affects: "", fixed: null });
    assert.equal(auditSignature({ ...lodash, advisories: [...lodash.advisories, { ...high("m"), severity: "moderate" }] }), auditSignature(lodash));
    assert.notEqual(auditSignature({ ...lodash, advisories: [...lodash.advisories, high("https://github.com/advisories/new")] }), auditSignature(lodash));
  });

  test("runs the manager's own audit beside each tracked lockfile, and says in a line what it couldn't read", async () => {
    const home = makeRepo(baseTeam(), {
      "package-lock.json": "{}\n",
      "web/pnpm-lock.yaml": "lockfileVersion: 9\n",
      "tools/yarn.lock": "# yarn\n",
      ".gitignore": "node_modules/\nscratch/\n",
      "node_modules/dep/package-lock.json": "{}\n",
      "scratch/package-lock.json": "{}\n",
    });
    assert.deepEqual(lockfiles(home), ["package-lock.json", "tools/yarn.lock", "web/pnpm-lock.yaml"], "the ones the repository tracks");

    const npm = printing(fixture("npm-audit.json"));
    const ran = await auditLockfile(home, "package-lock.json", npm.run);
    assert.ok(typeof ran !== "string");
    assert.equal(ran.command, "npm audit --omit=dev");
    assert.deepEqual(npm.asked, [`npm audit --omit=dev --json in ${home}`]);
    const pnpm = printing(fixture("pnpm-audit.json"));
    assert.equal(((await auditLockfile(home, "web/pnpm-lock.yaml", pnpm.run)) as { command: string }).command, "pnpm audit --prod");
    assert.deepEqual(pnpm.asked, [`pnpm audit --prod --json in ${join(home, "web")}`]);

    // Offline, each in its own words.
    assert.match((await auditLockfile(home, "package-lock.json", printing(fixture("npm-audit-offline.json")).run)) as string, /^request to http.* failed/);
    const offline: Runner = () => Promise.resolve({ stdout: "", stderr: fixture("pnpm-audit-offline.txt") });
    assert.equal(await auditLockfile(home, "web/pnpm-lock.yaml", offline), "Error: ERR_PNPM_AUDIT_BAD_RESPONSE");
    assert.equal(await auditLockfile(home, "package-lock.json", printing("", { failed: "missing" }).run), "npm isn't installed here");
    assert.equal(await auditLockfile(home, "package-lock.json", printing("", { failed: "timeout" }).run), "npm audit didn't finish in 60 seconds");
    assert.equal(await auditLockfile(home, "package-lock.json", printing("").run), "it printed no report");
    assert.equal(await auditLockfile(home, "package-lock.json", printing("<html>502</html>").run), "<html>502</html>");
    assert.equal(await auditLockfile(home, "tools/yarn.lock", npm.run), "yarn.lock isn't a lockfile a6g audits");
  });

  test("a lockfile is audited when it changed, and once a week when it didn't; an audit that didn't run stays due", async () => {
    const home = makeRepo(baseTeam(), { "package-lock.json": "{}\n", "tools/yarn.lock": "# yarn\n" });
    const state = stateDir(home);
    const now = Date.parse("2026-03-02T10:00:00Z");
    const npm = printing(fixture("npm-audit.json"));

    const first = await auditPackages(home, state, { now, run: npm.run });
    assert.deepEqual(first.said, [
      "packages: package-lock.json has 2 with an advisory at high or critical (minimist, lodash)",
      "packages: tools/yarn.lock isn't audited (npm's and pnpm's audits are the ones read)",
    ]);
    assert.deepEqual(
      first.audited.map((each) => [each.lockfile, each.command, each.vulnerable.length]),
      [["package-lock.json", "npm audit --omit=dev", 2]]
    );
    // Remembered only once its findings are filed: until then it's due again.
    assert.equal((await auditPackages(home, state, { now, run: npm.run })).audited.length, 1);
    recordAudited(state, first);
    assert.deepEqual(await auditPackages(home, state, { now: now + 6 * DAY, run: npm.run }), { said: [], audited: [], seen: {} });
    assert.equal(npm.asked.length, 2);

    // A week on, advisories may have arrived for the same packages.
    const weekly = await auditPackages(home, state, { now: now + 7 * DAY, run: printing('{"vulnerabilities": {}}').run });
    assert.deepEqual(weekly.said, [
      "packages: package-lock.json has none with an advisory at high or critical",
      "packages: tools/yarn.lock isn't audited (npm's and pnpm's audits are the ones read)",
    ]);
    recordAudited(state, weekly);

    // A changed lockfile is due at once. Offline, nothing is remembered, so the next check tries again.
    commit(home, { "package-lock.json": '{"lockfileVersion": 3}\n' });
    const offline = printing(fixture("npm-audit-offline.json"));
    const failed = await auditPackages(home, state, { now: now + 8 * DAY, run: offline.run });
    assert.equal(failed.said.length, 1);
    assert.match(failed.said[0] ?? "", /^the package audit of package-lock\.json didn't run: request to http.* failed/);
    assert.deepEqual([failed.audited, failed.seen], [[], {}]);
    recordAudited(state, failed);
    assert.equal((await auditPackages(home, state, { now: now + 8 * DAY, run: npm.run })).audited.length, 1);

    // More lockfiles than are audited at once: the nearest the root, and a line that says so.
    const many = makeRepo(baseTeam(), Object.fromEntries(["a", "b", "c", "d", "e", "f/g"].map((dir) => [`${dir}/package-lock.json`, "{}\n"])));
    const most = await auditPackages(many, stateDir(many), { now, run: printing('{"vulnerabilities": {}}').run });
    assert.equal(most.said[0], "packages: 6 lockfiles, and the 5 nearest the root are audited");
    assert.deepEqual(
      most.audited.map((each) => each.lockfile),
      ["a", "b", "c", "d", "e"].map((dir) => `${dir}/package-lock.json`)
    );
  });

  test("one finding per package, quiet while it's open, quiet once rejected until a new advisory, and a handful at a time", async () => {
    const home = makeRepo(baseTeam({ board: "tasks", roles: { planner: {}, builder: {}, reviewer: {} } }));
    const team = loadTeam(home);
    const store = fileStore(tmp("a6g-run-"), "fixture");
    const memory: Memory = {};
    const at = git(home, "rev-parse", "HEAD");
    const vulnerable = readNpm(report("npm-audit.json")) ?? [];
    const round = (found = vulnerable) => ({
      said: [],
      seen: {},
      audited: [{ lockfile: "package-lock.json", command: "npm audit --omit=dev", vulnerable: found }],
    });
    const get = async (id: string | undefined) => (await store.tasks.get(id ?? "")) as Task;
    const set = (id: string | undefined, status: "done" | "rejected") => update(store.tasks, id ?? "", (t) => ({ ...t, status }));

    const first = await fileAudit(store, team, memory, round(), at);
    assert.equal(first.waiting, 0);
    const tasks = await Promise.all(first.filed.map(get));
    assert.deepEqual(
      tasks.map((task) => [task.title, task.kind, task.severity, task.status, task.by]),
      [
        ["Vulnerable package: minimist (critical)", "chore", "major", "triage", "merge-queue"],
        ["Vulnerable package: lodash (high)", "chore", "major", "triage", "merge-queue"],
      ]
    );
    assert.match(tasks[1]?.body ?? "", /\(a6g: audit:package-lock\.json:lodash\)$/);
    assert.deepEqual((await fileAudit(store, team, memory, round(), at)).filed, [], "not again while they're open");

    // Rejected: the operator's answer for these advisories. A new one at high or critical is a new question.
    await set(first.filed[1], "rejected");
    assert.deepEqual((await fileAudit(store, team, memory, round(), at)).filed, []);
    const [minimist, lodash] = vulnerable;
    assert.ok(minimist && lodash);
    const more = {
      ...lodash,
      advisories: [
        ...lodash.advisories,
        { title: "Another", severity: "critical", url: "https://github.com/advisories/another", affects: "<5", fixed: null },
      ],
    };
    const again = await fileAudit(store, team, memory, round([minimist, more]), at);
    assert.deepEqual(
      (await Promise.all(again.filed.map(get))).map((task) => task.title),
      ["Vulnerable package: lodash (high)"]
    );

    // Done, and the audit no longer names it: remembered as passed. Done, and still named: it comes back.
    await set(first.filed[0], "done");
    await fileAudit(store, team, memory, round([more]), at);
    assert.equal(memory["audit:package-lock.json:minimist"]?.passed, true);
    assert.equal((await fileAudit(store, team, memory, round([minimist, more]), at)).filed.length, 1);

    // An old lockfile names dozens: five are open at once, the worst first, and the rest wait.
    const flood = fileStore(tmp("a6g-run-"), "fixture");
    const dozen = Array.from({ length: 12 }, (_, index) => ({
      ...lodash,
      name: `pkg-${String(index).padStart(2, "0")}`,
      severity: index === 11 ? ("critical" as const) : ("high" as const),
    }));
    const sorted = [dozen[11], ...dozen.slice(0, 11)].filter((pkg) => pkg !== undefined);
    const filled = await fileAudit(flood, team, {}, round(sorted), at);
    assert.deepEqual([filled.filed.length, filled.waiting], [5, 7]);
    assert.equal((await flood.tasks.get(filled.filed[0] ?? ""))?.title, "Vulnerable package: pkg-11 (critical)");
    assert.deepEqual([(await fileAudit(flood, team, {}, round(sorted), at)).filed.length], [0], "none while five are open");
    await update(flood.tasks, filled.filed[0] ?? "", (t) => ({ ...t, status: "done" as const }));
    const next = await fileAudit(flood, team, {}, round(sorted.slice(1)), at);
    assert.deepEqual([next.filed.length, next.waiting], [1, 6], "one closes, the next is filed");
  });

  test("the check after merges audits, files and remembers; security.audit false turns it off; offline is a line in the log", async () => {
    const roles = { planner: {}, builder: {}, reviewer: {} };
    const logOf = (home: string): string => readFileSync(join(stateDir(home), "verify.log"), "utf8");
    // One run folder (its task store) for each team.
    const runs = new Map<string, string>();
    const check = async (home: string, audit: Runner): Promise<string[]> => {
      if (!runs.has(home)) runs.set(home, tmp("a6g-run-"));
      const told: string[] = [];
      await verifyAfterMerge(home, loadTeam(home), runs.get(home) ?? "", "a6g/b1-landed", { wake: (text) => told.push(text), audit });
      return told;
    };
    const home = makeRepo(baseTeam({ board: "tasks", roles }), { "package-lock.json": "{}\n" });
    const npm = printing(fixture("npm-audit.json"));
    const told = await check(home, npm.run);
    assert.equal(told.length, 1);
    assert.match(
      told[0] ?? "",
      /packages: package-lock\.json has 2 with an advisory at high or critical \(minimist, lodash\)\. New findings in triage: #\d+, #\d+\.$/
    );
    assert.match(logOf(home), /packages: package-lock\.json has 2 with an advisory at high or critical \(minimist, lodash\); filed #/);
    // The same lockfile, the same week: not asked again.
    assert.deepEqual(await check(home, npm.run), []);
    assert.equal(npm.asked.length, 1);

    const offline = makeRepo(baseTeam({ board: "tasks", roles }), { "package-lock.json": "{}\n" });
    assert.deepEqual(await check(offline, printing(fixture("npm-audit-offline.json")).run), [], "nobody is woken for it");
    assert.match(logOf(offline), /the package audit of package-lock\.json didn't run: request to http/);

    const off = makeRepo(baseTeam({ board: "tasks", roles, security: { audit: false } }), { "package-lock.json": "{}\n" });
    const never = printing(fixture("npm-audit.json"));
    assert.deepEqual(await check(off, never.run), []);
    assert.deepEqual(never.asked, []);
    assert.match(logOf(off), /nothing to check$/m);
    assert.throws(() => loadTeam(makeRepo(baseTeam({ security: { audit: "no" } } as never))), /security\.audit: true or false/);
  });
});
