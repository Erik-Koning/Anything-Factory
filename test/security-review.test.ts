// The security reviewer: which paths are its to pass, its verdict, the merge queue's wait for it, and what the task,
// the prompts and a drafted team say of it. Nothing here holds for a team without the role.
import { baseTeam, bash, commit, a6g, git, holds, makeRepo, ROOT, tmp, tool, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { blastRadius, isSecurityPath, securityFiles } from "../lib/blast.ts";
import { loadTeam, normalize, ROLES, type RawTeam } from "../lib/config.ts";
import { detect, draftTeam } from "../lib/detect.ts";
import { compile } from "../lib/prompts.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { needsSecurity, newTask, securityLine } from "../lib/tasks/model.ts";
import { summary } from "../lib/tasks/ops.ts";

// The fixture team with a security reviewer.
const secured = (overrides: RawTeam = {}): RawTeam =>
  baseTeam({
    roles: {
      planner: {},
      builder: { limit: 2, deny: ["^e2e/"] },
      reviewer: { limit: 1 },
      "security-reviewer": { limit: 1 },
      tester: { limit: 1, write: ["^e2e/"] },
    },
    ...overrides,
  });

// Each checkout's run folder beside it, as one of the team's roles or (no role) as the merge queue is run.
const as = (home: string, role?: string) => ({
  cwd: home,
  env: { A6G_HOME_DIR: home, A6G_RUN: `${home}-run`, ...(role ? { A6G_TEAM: "fixture", A6G_ROLE: role } : {}) },
});
const tip = (home: string, ref = "a6g/next"): string => git(home, "rev-parse", ref);
const merge = (home: string, ...args: string[]) => a6g(["merge", ...args], as(home));
const review = (home: string, name: string, ...more: string[]) =>
  a6g(["verdict", "review", name, "approve", "--sha", tip(home, name), "--risk", "low", "--note", "ok", ...more], as(home, "reviewer"));
const security = (home: string, name: string, value = "pass", note = "read every check on the session") =>
  a6g(["verdict", "security", name, value, "--sha", tip(home, name), "--note", note], as(home, "security-reviewer"));
const refusal = (home: string, name: string): string =>
  (JSON.parse(readFileSync(join(home, ".a6g/run/state/merges", `${name.replaceAll("/", "_")}.json`), "utf8")) as { message: string }).message;

// A branch made from the integration branch, with one commit, and the checkout back on the integration branch.
function branch(home: string, name: string, files: Record<string, unknown>): string {
  git(home, "checkout", "-q", "-b", name, "a6g/next");
  const sha = commit(home, files, `work on ${name}`);
  git(home, "checkout", "-q", "a6g/next");
  return sha;
}
// One more commit on a branch.
function more(home: string, name: string, files: Record<string, unknown>): string {
  git(home, "checkout", "-q", name);
  const sha = commit(home, files, `more on ${name}`);
  git(home, "checkout", "-q", "a6g/next");
  return sha;
}

describe("security paths", () => {
  test("a path is one by its words; a test or a document never is", () => {
    const paths = [
      "src/auth/session.ts",
      "src/hooks/useAuth.ts",
      "src/AuthProvider.tsx",
      "packages/api/src/SSOProvider.ts",
      "app/sign-in/page.tsx",
      "app/(auth)/reset/page.tsx",
      "src/log_in.py",
      "server/stripe_webhook.py",
      "src/web-hook/handler.ts",
      "src/middleware.ts",
      "lib/permissions.ts",
      "src/lib/apiKeys.ts",
      "src/accessToken.ts",
      "src/billing/invoice.ts",
      "src/config/cors.ts",
      "supabase/migrations/20260101_orders.sql",
      "db/schema.sql",
      "prisma/migrations/3_init/migration.toml",
      "firestore.rules",
      "database.rules.json",
    ];
    for (const path of paths) assert.ok(isSecurityPath(path), path);
    const others = [
      "src/author.ts",
      "src/lesson.ts",
      "src/authority.ts",
      "src/app.ts",
      "src/components/Button.tsx",
      "src/catalog/in-stock.ts",
      "src/rules.ts",
      "package.json",
      // Neither changes who can do what.
      "src/auth/session.test.ts",
      "e2e/login.spec.ts",
      "tests/test_payments.py",
      "docs/auth.md",
      "src/auth/README.md",
    ];
    for (const path of others) assert.ok(!isSecurityPath(path), path);
  });

  test("a team's own paths add to the factory's, match as written, and the factory's can be turned off", () => {
    const changed = ["src/auth/session.ts", "src/export/csv.ts", "e2e/export.spec.ts", "src/app.ts"];
    assert.deepEqual(securityFiles({ paths: [], builtIn: true }, changed), ["src/auth/session.ts"]);
    assert.deepEqual(securityFiles({ paths: ["^src/export/"], builtIn: true }, changed), ["src/auth/session.ts", "src/export/csv.ts"]);
    assert.deepEqual(securityFiles({ paths: ["export"], builtIn: false }, changed), ["src/export/csv.ts", "e2e/export.spec.ts"], "a test, when named");
    assert.deepEqual(securityFiles({ paths: [], builtIn: false }, changed), []);
    assert.deepEqual(securityFiles({ paths: ["("], builtIn: true }, changed), ["src/auth/session.ts"], "a pattern that doesn't compile matches nothing");
  });

  test("team.json: the role's defaults, the paths' defaults, and a warning where nothing would wait", () => {
    const norm = (raw: RawTeam) => normalize({ name: "fixture", branch: "a6g/next", ...raw }, "");
    const plain = norm({});
    assert.deepEqual(plain.team.security, { audit: true, paths: [], builtIn: true });
    assert.deepEqual(
      plain.warnings.filter((warning) => /security/.test(warning)),
      []
    );
    assert.ok(!plain.team.roles["security-reviewer"], "nobody gets one without asking");

    const withRole = norm({ roles: { planner: {}, builder: {}, reviewer: {}, "security-reviewer": {} }, security: { paths: ["^src/export/"] } });
    assert.deepEqual(withRole.problems, []);
    assert.deepEqual(
      withRole.warnings.filter((warning) => /security/.test(warning)),
      []
    );
    const role = withRole.team.roles["security-reviewer"];
    assert.deepEqual([role?.limit, role?.readOnly, role?.write], [ROLES["security-reviewer"]?.limit, true, []]);
    assert.deepEqual(withRole.team.security, { audit: true, paths: ["^src/export/"], builtIn: true });

    assert.match(norm({ security: { paths: ["^src/export/"] } }).warnings.join("\n"), /security\.paths: the team has no security reviewer.*a6g register/);
    assert.match(norm({ security: { builtIn: false } }).warnings.join("\n"), /security\.builtIn: the team has no security reviewer/);
    assert.match(norm({ security: { paths: ["("] } }).problems.join("\n"), /security\.paths/);
    assert.match(norm({ security: { builtIn: "no" } } as unknown as RawTeam).problems.join("\n"), /security\.builtIn/);
  });
});

describe("the security verdict", { concurrency: true }, () => {
  test("only the security reviewer records one, of the branch's tip", async () => {
    const home = makeRepo(secured());
    const sha = branch(home, "a6g/b1-session", { "src/auth/session.ts": "export const ttl = 3600;\n" });
    const record = (role: string, ...args: string[]) => a6g(["verdict", "security", "a6g/b1-session", ...args], as(home, role));

    for (const role of ["reviewer", "builder", "planner"]) {
      const refused = await record(role, "pass", "--sha", sha);
      assert.equal(refused.code, 2, role);
      assert.match(refused.out, /only the security reviewer records a security verdict/);
    }
    assert.match((await record("security-reviewer", "pass")).out, /say which commit you judged with --sha/);
    assert.match((await record("security-reviewer", "pass", "--sha", "a6g/b1-session")).out, /--sha takes the id of the commit you judged/);
    const moved = await record("security-reviewer", "pass", "--sha", tip(home));
    assert.equal(moved.code, 2);
    assert.match(moved.out, /a6g\/b1-session is at \w{9}, not \w{9}: it has moved since the commit you reviewed/);
    const wrong = await record("security-reviewer", "approve", "--sha", sha);
    assert.equal(wrong.code, 2, "a review's word isn't a security verdict's");
    assert.match(wrong.out, /usage: a6g verdict/);
    assert.equal((await a6g(["verdict", "show", "security", "a6g/b1-session"], as(home, "planner"))).out.trim(), "none");

    const passed = await record("security-reviewer", "pass", "--sha", sha, "--note", "the session is checked on the server");
    assert.equal(passed.code, 0, passed.out);
    assert.match(passed.out, new RegExp(`security a6g/b1-session: pass at ${sha.slice(0, 9)}`));
    const shown = JSON.parse((await a6g(["verdict", "show", "security", "a6g/b1-session"], as(home, "planner"))).out) as Record<string, unknown>;
    assert.deepEqual(
      [shown.kind, shown.verdict, shown.sha, shown.note, shown.by],
      ["security", "pass", sha, "the session is checked on the server", "security-reviewer"]
    );
  });

  test("--security goes with an approval, on a team that has someone to send it to", async () => {
    const home = makeRepo(secured());
    const sha = branch(home, "a6g/b1-export", { "src/export.ts": "export const all = true;\n" });
    const withChanges = await a6g(["verdict", "review", "a6g/b1-export", "changes", "--sha", sha, "--note", "no", "--security"], as(home, "reviewer"));
    assert.equal(withChanges.code, 2);
    assert.match(withChanges.out, /--security goes with a review's approval/);
    const sent = await review(home, "a6g/b1-export", "--security");
    assert.equal(sent.code, 0, sent.out);
    assert.match(sent.out, new RegExp(`sent on to the security reviewer; it merges once that passes ${sha.slice(0, 9)} too`));

    const alone = makeRepo(baseTeam());
    branch(alone, "a6g/b1-export", { "src/export.ts": "export const all = true;\n" });
    const nobody = await review(alone, "a6g/b1-export", "--security");
    assert.equal(nobody.code, 2);
    assert.match(nobody.out, /no security reviewer to send it on to.*otherwise ask for changes, or file it/);
    const unread = await security(alone, "a6g/b1-export");
    assert.equal(unread.code, 2);
    assert.match(unread.out, /this team has no security reviewer \(team\.json roles\), so nothing reads a security verdict/);
  });

  test("the guard: the verdict is the security reviewer's, who changes nothing", async () => {
    const home = makeRepo(secured());
    await holds([
      bash(home, "security-reviewer", "a6g verdict security a6g/b1-x pass --sha abc1234 --note 'read it'", "allow"),
      bash(home, "security-reviewer", "a6g verdict show review a6g/b1-x", "allow"),
      bash(home, "reviewer", "a6g verdict security a6g/b1-x pass --sha abc1234", "refuse"),
      bash(home, "builder", "a6g verdict security a6g/b1-x pass --sha abc1234", "refuse"),
      bash(home, "planner", "a6g verdict security a6g/b1-x pass --sha abc1234", "refuse"),
      bash(home, "security-reviewer", "a6g verdict review a6g/b1-x approve --sha abc1234 --risk low", "refuse"),
      bash(home, "security-reviewer", "a6g merge a6g/b1-x", "refuse"),
      bash(home, "security-reviewer", "a6g task fetch 3", "allow"),
      bash(home, "security-reviewer", "a6g blast abc1234", "allow"),
      bash(home, "security-reviewer", "a6g task add 'Anyone can read another order' --sev major --body x", "allow"),
      bash(home, "security-reviewer", "git worktree add --detach /tmp/security-1 abc1234", "allow"),
      bash(home, "security-reviewer", "git commit -am x", "refuse"),
      tool(home, "security-reviewer", "Write", { file_path: join(home, "src/app.ts"), content: "x\n" }, "refuse"),
    ]);
  });
});

describe("the merge queue and the security reviewer", { concurrency: true }, () => {
  test("a branch that changes a security path merges once its tip has passed", async () => {
    const home = makeRepo(secured());
    const name = "a6g/b1-session";
    branch(home, name, { "src/auth/session.ts": "export const ttl = 3600;\n" });
    assert.equal((await review(home, name)).code, 0);
    let result = await merge(home, name);
    assert.equal(result.code, 2, result.out);
    assert.match(refusal(home, name), /has no security review, and it changes src\/auth\/session\.ts; start a security reviewer/);

    assert.equal((await security(home, name, "issues", "anyone can extend a session")).code, 0);
    result = await merge(home, name);
    assert.equal(result.code, 2, result.out);
    assert.match(refusal(home, name), /found issues: anyone can extend a session; it merges once the security reviewer passes it/);

    // A pass is of one commit: the reviewer's approval of a later one doesn't carry it along.
    assert.equal((await security(home, name)).code, 0);
    more(home, name, { "src/auth/session.ts": "export const ttl = 60;\n" });
    assert.equal((await review(home, name)).code, 0);
    result = await merge(home, name);
    assert.equal(result.code, 2, result.out);
    assert.match(refusal(home, name), /the security review passed \w{9} but a6g\/b1-session is at \w{9}: have the security reviewer pass it again/);

    assert.equal((await security(home, name)).code, 0);
    result = await merge(home, name);
    assert.equal(result.code, 0, result.out);
    assert.equal(git(home, "rev-parse", "a6g/next^2"), tip(home, name));
  });

  test("a branch off the security paths merges on its review, unless a reviewer sent it on, which holds", async () => {
    const home = makeRepo(secured());
    branch(home, "a6g/b2-copy", { "src/copy.ts": "export const hello = 'hi';\n" });
    await review(home, "a6g/b2-copy");
    const plain = await merge(home, "a6g/b2-copy");
    assert.equal(plain.code, 0, plain.out);

    const name = "a6g/b3-export";
    branch(home, name, { "src/export.ts": "export const all = true;\n" });
    assert.equal((await review(home, name, "--security")).code, 0);
    let result = await merge(home, name);
    assert.equal(result.code, 2, result.out);
    assert.match(refusal(home, name), /has no security review, and its reviewer sent it on/);

    // A later review of the branch doesn't take it back.
    more(home, name, { "src/export.ts": "export const all = false;\n" });
    const later = await review(home, name);
    assert.equal(later.code, 0, later.out);
    assert.match(later.out, /an earlier review sent this branch on to the security reviewer/);
    result = await merge(home, name);
    assert.equal(result.code, 2, result.out);
    assert.match(refusal(home, name), /its reviewer sent it on/);

    assert.equal((await security(home, name)).code, 0);
    result = await merge(home, name);
    assert.equal(result.code, 0, result.out);
  });

  test("a branch sent back with issues waits for a pass, even once its rework leaves the security paths", async () => {
    const home = makeRepo(secured());
    const name = "a6g/b4-roles";
    branch(home, name, { "src/roles.ts": "export const admin = true;\n" });
    await review(home, name);
    assert.equal((await security(home, name, "issues", "every user is an admin")).code, 0);
    git(home, "checkout", "-q", name);
    git(home, "rm", "-q", "src/roles.ts");
    commit(home, { "src/members.ts": "export const admin = false;\n" }, "do it another way");
    git(home, "checkout", "-q", "a6g/next");
    assert.deepEqual(blastRadius(home, { base: "a6g/next", ref: name, security: { paths: [], builtIn: true } }).security, []);

    assert.equal((await review(home, name)).code, 0);
    let result = await merge(home, name);
    assert.equal(result.code, 2, result.out);
    assert.match(refusal(home, name), /found issues: every user is an admin/);
    assert.equal((await security(home, name)).code, 0);
    result = await merge(home, name);
    assert.equal(result.code, 0, result.out);
  });

  test("a plain rebase keeps the pass; a changed one doesn't", async () => {
    const home = makeRepo(secured());
    const passed = branch(home, "a6g/b5-login", { "src/login.ts": "export const login = 1;\n" });
    await review(home, "a6g/b5-login");
    await security(home, "a6g/b5-login");
    branch(home, "a6g/b6-other", { "src/other.ts": "export const other = 1;\n" });
    await review(home, "a6g/b6-other");
    assert.equal((await merge(home, "a6g/b6-other")).code, 0);
    git(home, "checkout", "-q", "a6g/b5-login");
    git(home, "rebase", "-q", "a6g/next");
    git(home, "checkout", "-q", "a6g/next");
    assert.equal((await merge(home, "a6g/b5-login")).code, 2, "a new tip without --rebased-from");
    let result = await merge(home, "a6g/b5-login", "--rebased-from", passed);
    assert.equal(result.code, 0, result.out);

    // The reviewer approved what the branch became; the security reviewer passed what it was.
    const was = branch(home, "a6g/b7-billing", { "src/billing.ts": "export const price = 1;\n" });
    await review(home, "a6g/b7-billing");
    await security(home, "a6g/b7-billing");
    git(home, "checkout", "-q", "a6g/b7-billing");
    git(home, "reset", "-q", "--hard", "a6g/next");
    commit(home, { "src/billing.ts": "export const price = 0;\n" }, "work on a6g/b7-billing");
    git(home, "checkout", "-q", "a6g/next");
    await review(home, "a6g/b7-billing");
    result = await merge(home, "a6g/b7-billing", "--rebased-from", was);
    assert.equal(result.code, 2, result.out);
    assert.match(refusal(home, "a6g/b7-billing"), /isn't only a rebase of \w{9}, which the security reviewer passed/);
  });

  test("a team without one is asked for nothing; a team's own paths count, and the factory's can be off", async () => {
    const alone = makeRepo(baseTeam());
    branch(alone, "a6g/b1-session", { "src/auth/session.ts": "export const ttl = 3600;\n" });
    await review(alone, "a6g/b1-session");
    const unasked = await merge(alone, "a6g/b1-session");
    assert.equal(unasked.code, 0, unasked.out);

    const home = makeRepo(secured({ security: { paths: ["^src/export/"], builtIn: false } }));
    branch(home, "a6g/b1-session", { "src/auth/session.ts": "export const ttl = 3600;\n" });
    await review(home, "a6g/b1-session");
    const off = await merge(home, "a6g/b1-session");
    assert.equal(off.code, 0, off.out);
    branch(home, "a6g/b2-export", { "src/export/csv.ts": "export const csv = 1;\n" });
    await review(home, "a6g/b2-export");
    const own = await merge(home, "a6g/b2-export");
    assert.equal(own.code, 2, own.out);
    assert.match(refusal(home, "a6g/b2-export"), /has no security review, and it changes src\/export\/csv\.ts/);
  });
});

describe("a task and the security reviewer", { concurrency: true }, () => {
  // One team checkout with a run folder of its own, and members' worktrees as T3 Code makes them.
  function setup(raw: RawTeam) {
    const home = makeRepo(raw);
    const run = tmp("a6g-run-");
    const member = (role: string, cwd = home) => ({ cwd, env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: role, A6G_RUN: run } });
    const worktree = (name: string) => {
      const dir = join(tmp("a6g-wt-"), name);
      git(home, "worktree", "add", "-q", "-b", `wt/${name}`, dir, "a6g/next");
      return realpathSync(dir);
    };
    const store = () => fileStore(run, "fixture");
    const add = (id: string, title: string) =>
      store().tasks.createAs(id, newTask({ team: "fixture", title, kind: "feature", status: "approved", by: "planner" }));
    return { home, member, worktree, store, add };
  }

  test("the task says it's the security reviewer's, goes back on issues, and merges once its tip has passed", async () => {
    const { member, worktree, store, add } = setup(secured());
    const name = "a6g/b1-sessions-expire";
    await add("1", "Sessions expire");
    const first = worktree("b1");
    assert.equal((await a6g(["task", "claim", "1"], member("builder", first))).code, 0);
    git(first, "branch", "-m", name);
    const sha = commit(first, { "src/auth/session.ts": "export const ttl = 3600;\n" });
    const submitted = await a6g(["task", "submit", "1"], member("builder", first));
    assert.equal(submitted.code, 0, submitted.out);
    git(first, "checkout", "-q", "--detach");
    let task = await store().tasks.get("1");
    assert.deepEqual(task?.security, { files: ["src/auth/session.ts"] });
    assert.match((await a6g(["task", "show", "1"], member("planner"))).out, /needs the security reviewer: it changes src\/auth\/session\.ts/);
    assert.match(
      summary(await store().tasks.all(), { approval: "planner" }),
      /Waiting for review: #1 Sessions expire \[a6g\/b1-sessions-expire\] \(needs the security reviewer\)/
    );

    // Issues send it back like a review's changes, with the finding where whoever reworks it reads it.
    const found = await a6g(
      ["verdict", "security", name, "issues", "--sha", sha, "--note", "a session never ends on the server"],
      member("security-reviewer")
    );
    assert.equal(found.code, 0, found.out);
    assert.match(found.out, /task 1: approved \(round 1 of 3\)/);
    task = await store().tasks.get("1");
    assert.deepEqual([task?.status, task?.rounds], ["approved", 1]);
    assert.deepEqual(task?.security, { files: ["src/auth/session.ts"], seen: true });
    assert.match(task?.notes.at(-1)?.text ?? "", new RegExp(`security review of ${sha.slice(0, 9)} found issues: a session never ends on the server`));

    const second = worktree("b2");
    assert.equal((await a6g(["task", "claim", "1"], member("builder", second))).code, 0);
    git(second, "checkout", "-q", name);
    const fixed = commit(second, { "src/auth/session.ts": "export const ttl = 3600;\nexport const endsOnServer = true;\n" });
    const again = await a6g(["task", "submit", "1"], member("builder", second));
    assert.equal(again.code, 0, again.out);
    git(second, "checkout", "-q", "--detach");
    assert.equal((await a6g(["verdict", "review", name, "approve", "--sha", fixed, "--risk", "medium", "--note", "ok"], member("reviewer"))).code, 0);
    const early = await a6g(["merge", name], member("planner"));
    assert.equal(early.code, 2, early.out);
    assert.match(early.out, /found issues: a session never ends on the server/);

    const passed = await a6g(["verdict", "security", name, "pass", "--sha", fixed, "--note", "it ends on the server now"], member("security-reviewer"));
    assert.equal(passed.code, 0, passed.out);
    task = await store().tasks.get("1");
    assert.deepEqual(task?.security, { files: ["src/auth/session.ts"], seen: true, passed: fixed });
    assert.match(task?.notes.at(-1)?.text ?? "", new RegExp(`security review passed ${fixed.slice(0, 9)}: it ends on the server now`));
    assert.match((await a6g(["task", "show", "1"], member("planner"))).out, new RegExp(`security reviewer: passed ${fixed.slice(0, 9)}`));
    assert.doesNotMatch(summary(await store().tasks.all(), { approval: "planner" }), /needs the security reviewer/);

    const merged = await a6g(["merge", name], member("planner"));
    assert.equal(merged.code, 0, merged.out);
    assert.equal((await store().tasks.get("1"))?.status, "done");
  });

  test("a task off the security paths isn't its, until a reviewer sends it on; a team without one records nothing", async () => {
    const { member, worktree, store, add } = setup(secured());
    const name = "a6g/b1-export-orders";
    await add("1", "Export orders");
    const tree = worktree("b1");
    await a6g(["task", "claim", "1"], member("builder", tree));
    git(tree, "branch", "-m", name);
    const sha = commit(tree, { "src/export.ts": "export const all = true;\n" });
    assert.equal((await a6g(["task", "submit", "1"], member("builder", tree))).code, 0);
    git(tree, "checkout", "-q", "--detach");
    assert.equal((await store().tasks.get("1"))?.security, null);
    assert.doesNotMatch((await a6g(["task", "show", "1"], member("planner"))).out, /security reviewer/);

    const sent = await a6g(
      ["verdict", "review", name, "approve", "--sha", sha, "--risk", "low", "--note", "it exports everyone's", "--security"],
      member("reviewer")
    );
    assert.equal(sent.code, 0, sent.out);
    const task = await store().tasks.get("1");
    assert.deepEqual(task?.security, { files: [], sent: true });
    assert.match(task?.notes.at(-1)?.text ?? "", /sent on to the security reviewer/);
    assert.match((await a6g(["task", "show", "1"], member("planner"))).out, /needs the security reviewer: the reviewer sent it on/);

    const alone = setup(baseTeam());
    await alone.add("1", "Sessions expire");
    const theirs = alone.worktree("b1");
    await a6g(["task", "claim", "1"], alone.member("builder", theirs));
    git(theirs, "branch", "-m", "a6g/b1-sessions-expire");
    commit(theirs, { "src/auth/session.ts": "export const ttl = 3600;\n" });
    assert.equal((await a6g(["task", "submit", "1"], alone.member("builder", theirs))).code, 0);
    assert.equal((await alone.store().tasks.get("1"))?.security, undefined);
    assert.doesNotMatch((await a6g(["task", "show", "1"], alone.member("planner"))).out, /security reviewer/);
  });

  test("in a few words: why it's theirs, and what they last passed", () => {
    const sha = "a".repeat(40);
    const other = "b".repeat(40);
    assert.equal(securityLine({ security: null, sha }), null);
    assert.equal(securityLine({ sha }), null);
    assert.equal(needsSecurity({ security: null, sha }), false);
    assert.equal(
      securityLine({ security: { files: ["a.sql", "b.sql", "c.sql", "d.sql", "e.sql"], sent: true }, sha }),
      "needs the security reviewer: it changes a.sql, b.sql, c.sql and 2 more, and the reviewer sent it on"
    );
    assert.equal(securityLine({ security: { files: [], seen: true }, sha }), "needs the security reviewer: it has been in its hands");
    assert.equal(securityLine({ security: { files: ["a.sql"], seen: true, passed: sha }, sha }), "security reviewer: passed aaaaaaaaa");
    assert.equal(needsSecurity({ security: { files: ["a.sql"], passed: other }, sha }), true, "a pass of another commit");
    assert.equal(
      securityLine({ security: { files: ["a.sql"], passed: other }, sha }),
      "needs the security reviewer: it changes a.sql (it passed bbbbbbbbb; a plain rebase of that merges with --rebased-from)"
    );
  });
});

describe("what a team is told of its security reviewer", () => {
  test("the prompts: the security reviewer's own commands, and --security for a reviewer who has one to send to", () => {
    const team = loadTeam(makeRepo(secured()));
    const prompt = compile(team, "security-reviewer");
    assert.match(prompt, /You are the \*\*security-reviewer\*\*/);
    assert.match(prompt, /`a6g verdict security <branch> pass\|issues --sha <the commit you reviewed>/);
    assert.match(prompt, /`a6g blast \[<sha>\] \[--json\]`.*and the security paths it changes/);
    // Its own prompt: it changes nothing, records its verdict and ends its report with it.
    const own = readFileSync(join(ROOT, "plugin/agents/security-reviewer.md"), "utf8");
    assert.match(own, /^disallowedTools: Edit, NotebookEdit$/m);
    assert.match(own, /a6g verdict security <branch> pass --sha <sha>/);
    assert.match(own, /a6g verdict security <branch> issues --sha <sha>/);
    assert.match(own, /VERDICT: pass/);
    assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
    assert.match(compile(team, "reviewer"), /Add `--security` to an approval to send the branch on/);
    assert.match(
      compile(team, "planner"),
      /\| security-reviewer \| `a6g-fixture-security-reviewer` \| `"claude-opus-5-5"` \| `"shared"` \| 1 \|/,
      "the planner's table of members"
    );

    // On several machines the branch is the remote's, for both reviewers to fetch.
    const spread = loadTeam(makeRepo(secured({ tasks: { store: "mongo", lead: "studio" }, push: { remote: "origin" } })));
    for (const role of ["reviewer", "security-reviewer"]) assert.match(compile(spread, role), /`a6g task fetch <id>`/, role);

    const alone = loadTeam(makeRepo(baseTeam()));
    assert.doesNotMatch(compile(alone, "reviewer"), /Add `--security` to an approval/);
    assert.doesNotMatch(compile(alone, "reviewer"), /and the security paths it changes/);
  });

  test("a6g blast lists the security paths a change touches, for a team with someone to read them", async () => {
    const files = { "src/auth/session.ts": "export const ttl = 3600;\n", "src/copy.ts": "export const hello = 'hi';\n" };
    const home = makeRepo(secured());
    branch(home, "a6g/b1-session", files);
    const listed = await a6g(["blast", "a6g/b1-session"], as(home));
    assert.equal(listed.code, 0, listed.out);
    assert.match(listed.out, /security paths it changes \(it merges once the security reviewer has passed it\)[^\n]*\n\s+src\/auth\/session\.ts/);
    assert.doesNotMatch(listed.out, /src\/copy\.ts\n[^]*security paths[^]*src\/copy\.ts/);
    assert.deepEqual((JSON.parse((await a6g(["blast", "a6g/b1-session", "--json"], as(home))).out) as { security: string[] }).security, [
      "src/auth/session.ts",
    ]);
    branch(home, "a6g/b2-copy", { "src/copy.ts": "export const hello = 'hi';\n" });
    assert.match((await a6g(["blast", "a6g/b2-copy"], as(home))).out, /security paths it changes: none/);

    const alone = makeRepo(baseTeam());
    branch(alone, "a6g/b1-session", files);
    const quiet = await a6g(["blast", "a6g/b1-session"], as(alone));
    assert.equal(quiet.code, 0, quiet.out);
    assert.doesNotMatch(quiet.out, /security/);
  });

  test("a6g init drafts one for a repository with sign-in, payments or an API of its own", () => {
    const repo = (files: Record<string, unknown>) => {
      const dir = tmp("a6g-detect-");
      write(dir, files);
      git(dir, "init", "-q", "-b", "main");
      return detect(dir);
    };
    const draft = (found: ReturnType<typeof detect>) => draftTeam(found, { name: "app", branch: "a6g/next" }).roles ?? {};

    const signIn = repo({ "package.json": { name: "app", dependencies: { next: "16", "next-auth": "5" } } });
    assert.deepEqual(signIn.security, ["sign-in"]);
    assert.deepEqual(draft(signIn)["security-reviewer"], { limit: 1 });
    const api = repo({ "package.json": { name: "app", dependencies: { next: "16" } }, "src/app/api/orders/route.ts": "export const GET = 1;\n" });
    assert.deepEqual(api.security, ["an API"]);
    assert.ok(draft(api)["security-reviewer"]);
    const server = repo({ "package.json": { name: "svc", dependencies: { hono: "4", stripe: "17" } } });
    assert.deepEqual(server.security, ["payments", "an API"]);

    const library = repo({ "package.json": { name: "tally", devDependencies: { vitest: "1" } }, "src/index.ts": "export const sum = 1;\n" });
    assert.deepEqual(library.security, []);
    assert.ok(!("security-reviewer" in draft(library)));
  });
});
