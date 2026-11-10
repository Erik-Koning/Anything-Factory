import { baseTeam, commit, a6g, git, makeRepo, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileStore } from "../lib/tasks/files.ts";

// Each checkout's run folder beside it (the default is the team's name, which every fixture shares).
const merge = (home: string, ...args: string[]) => a6g(["merge", ...args], { cwd: home, env: { A6G_HOME_DIR: home, A6G_RUN: `${home}-run` } });
const taskStatus = async (home: string, id: string) => (await fileStore(`${home}-run`, "fixture").tasks.get(id))?.status;
const approve = (home: string, branch: string) =>
  a6g(["verdict", "review", branch, "approve", "--sha", git(home, "rev-parse", branch), "--risk", "low", "--note", "ok"], {
    cwd: home,
    env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: "reviewer", A6G_RUN: `${home}-run` },
  });
const record = (home: string, branch: string): { result: string; message: string; sha: string } =>
  JSON.parse(readFileSync(join(home, ".a6g/run/state/merges", `${branch.replaceAll("/", "_")}.json`), "utf8"));
const tip = (home: string, ref = "a6g/next"): string => git(home, "rev-parse", ref);

// A branch made from the integration branch, with one commit, and the checkout back on the integration branch.
function branch(home: string, name: string, files: Record<string, unknown>, from = "a6g/next"): string {
  git(home, "checkout", "-q", "-b", name, from);
  const sha = commit(home, files, `work on ${name}`);
  git(home, "checkout", "-q", "a6g/next");
  return sha;
}

describe("merge queue", { concurrency: true }, () => {
  test("a builder branch needs an approval of its exact tip", async () => {
    const home = makeRepo(baseTeam(), { ".a6g/run/board/1-feature.md": "status: review\nkind: feature\n\nDo it.\n" });
    const before = tip(home);
    branch(home, "a6g/b1-feature", { "src/feature.ts": "export const f = 1;\n" });

    let result = await merge(home, "a6g/b1-feature");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/b1-feature").message, /has no review/);

    assert.equal((await approve(home, "a6g/b1-feature")).code, 0);
    git(home, "checkout", "-q", "a6g/b1-feature");
    commit(home, { "src/feature.ts": "export const f = 2;\n" }, "after the review");
    git(home, "checkout", "-q", "a6g/next");
    result = await merge(home, "a6g/b1-feature");
    assert.equal(result.code, 2);
    assert.match(record(home, "a6g/b1-feature").message, /the approval is for/);
    assert.equal(tip(home), before, "nothing merged");

    await approve(home, "a6g/b1-feature");
    result = await merge(home, "a6g/b1-feature");
    assert.equal(result.code, 0, result.out);
    assert.equal(record(home, "a6g/b1-feature").result, "merged");
    assert.equal(git(home, "rev-parse", "a6g/next^2"), tip(home, "a6g/b1-feature"), "a merge commit of the approved tip");
    assert.equal(await taskStatus(home, "1"), "done", "the board's ticket, now a task, is done");
    assert.match(readFileSync(join(home, ".a6g/run/state/merges.log"), "utf8"), /a6g\/b1-feature merged/);
    assert.ok(!existsSync(join(home, ".a6g/run/merge")), "the scratch worktree is gone");
  });

  test("a branch outside its lane is refused, approved or not", async () => {
    const home = makeRepo();
    const cases: [string, Record<string, string>][] = [
      ["a6g/b2-rules", { ".a6g/notes.md": "changed\n" }],
      ["a6g/b3-specs", { "e2e/a.spec.ts": "test\n" }],
      ["a6g/b4-settings", { ".claude/settings.json": "{}\n" }],
    ];
    for (const [name, files] of cases) {
      branch(home, name, files);
      await approve(home, name);
      const result = await merge(home, name);
      assert.equal(result.code, 2, `${name}: ${result.out}`);
      assert.match(record(home, name).message, /outside its lane/);
    }
    branch(home, "feature/x", { "src/x.ts": "x\n" });
    assert.equal((await merge(home, "feature/x")).code, 2, "not a team branch");
  });

  test("a failing gate merges nothing", async () => {
    const home = makeRepo(baseTeam({ gate: { full: "echo 'tests: 3 FAILED' && false" } }));
    const before = tip(home);
    branch(home, "a6g/b5-thing", { "src/thing.ts": "x\n" });
    await approve(home, "a6g/b5-thing");
    const result = await merge(home, "a6g/b5-thing");
    assert.equal(result.code, 4, result.out);
    assert.equal(tip(home), before);
    assert.match(record(home, "a6g/b5-thing").message, /the gate fails.*3 FAILED/);
  });

  test("a pure rebase merges on its earlier approval; a changed one doesn't", async () => {
    const home = makeRepo();
    const approved = branch(home, "a6g/b6-rebase", { "src/six.ts": "6\n" });
    await approve(home, "a6g/b6-rebase");
    branch(home, "a6g/b7-other", { "src/seven.ts": "7\n" });
    await approve(home, "a6g/b7-other");
    assert.equal((await merge(home, "a6g/b7-other")).code, 0);
    git(home, "checkout", "-q", "a6g/b6-rebase");
    git(home, "rebase", "-q", "a6g/next");
    git(home, "checkout", "-q", "a6g/next");
    assert.equal((await merge(home, "a6g/b6-rebase")).code, 2, "a new tip without --rebased-from");
    let result = await merge(home, "a6g/b6-rebase", "--rebased-from", approved);
    assert.equal(result.code, 0, result.out);

    const second = branch(home, "a6g/b8-sneaky", { "src/eight.ts": "8\n" });
    await approve(home, "a6g/b8-sneaky");
    git(home, "checkout", "-q", "a6g/b8-sneaky");
    git(home, "reset", "-q", "--hard", "a6g/next");
    commit(home, { "src/eight.ts": "8, and something else\n" }, "work on a6g/b8-sneaky");
    git(home, "checkout", "-q", "a6g/next");
    result = await merge(home, "a6g/b8-sneaky", "--rebased-from", second);
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/b8-sneaky").message, /isn't only a rebase/);
  });

  test("the planner's own commit during a merge still lets it in", async () => {
    const home = makeRepo(
      baseTeam({ gate: { full: `cd "$A6G_HOME_DIR" && echo lesson >> .a6g/lessons.md && git add .a6g/lessons.md && git commit -qm lessons` } })
    );
    branch(home, "a6g/b9-meanwhile", { "src/nine.ts": "9\n" });
    await approve(home, "a6g/b9-meanwhile");
    const result = await merge(home, "a6g/b9-meanwhile");
    assert.equal(result.code, 0, result.out);
    assert.equal(git(home, "log", "-1", "--format=%s", "a6g/next^1"), "lessons", "merged on top of the planner's commit");
    assert.ok(existsSync(join(home, "src/nine.ts")));
  });

  test("a test branch merges without review unless it removes an assertion", async () => {
    const home = makeRepo(baseTeam({ review: { required: ["builder"], removedPattern: "\\bexpect\\(" } }), {
      "e2e/a.spec.ts": "expect(one);\nexpect(two);\n",
    });
    branch(home, "a6g/t-more", { "e2e/b.spec.ts": "expect(three);\n" });
    let result = await merge(home, "a6g/t-more");
    assert.equal(result.code, 0, result.out);
    branch(home, "a6g/t-fewer", { "e2e/a.spec.ts": "expect(one);\n" });
    result = await merge(home, "a6g/t-fewer");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/t-fewer").message, /has no review/);
  });

  test("a scaffolder's branch is always reviewed, keeps test work to test files, and builders leave journey tags alone", async () => {
    const roles = { planner: {}, builder: {}, reviewer: {}, scaffolder: {} };
    const home = makeRepo(baseTeam({ roles, review: { required: ["builder"] } }), {
      ".a6g/run/board/5-harness.md": "status: review\nkind: test-infra\n\nSet the browser checks up.\n",
      ".a6g/run/board/6-skeleton.md": "status: review\nkind: scaffold\n\nMake the app's skeleton.\n",
    });
    // review.required names only builders here; the scaffolder's branches are reviewed anyway.
    branch(home, "a6g/s5-harness", { "e2e/home.spec.ts": "test('home', () => {});\n", "playwright.config.ts": "export default {};\n" });
    let result = await merge(home, "a6g/s5-harness");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s5-harness").message, /has no review/);
    await approve(home, "a6g/s5-harness");
    assert.equal((await merge(home, "a6g/s5-harness")).code, 0);
    // Test-infra work that changes product code is refused; scaffold work may change anything a builder may.
    branch(home, "a6g/s5-more", { "e2e/b.spec.ts": "test('b', () => {});\n", "src/app.ts": "export const fixed = true;\n" });
    await approve(home, "a6g/s5-more");
    result = await merge(home, "a6g/s5-more");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s5-more").message, /is test-infra work, which changes test and harness files only, and it changes src\/app\.ts/);
    branch(home, "a6g/s6-skeleton", { "src/app.ts": "export const app = 1;\n", "package.json": "{}\n" });
    await approve(home, "a6g/s6-skeleton");
    assert.equal((await merge(home, "a6g/s6-skeleton")).code, 0);
    // A builder's branch that touches a journey's tag is refused: its proof comes from someone else.
    branch(home, "a6g/b7-pay", { "src/pay.ts": "export const pay = 1;\n", "src/pay.spec.ts": "test('pays', { tag: '@journey-3' }, () => {});\n" });
    await approve(home, "a6g/b7-pay");
    result = await merge(home, "a6g/b7-pay");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/b7-pay").message, /adds or changes @journey- tags in src\/pay\.spec\.ts/);
  });

  test("a branch that checks less merges only once the operator allows its exact commit", async () => {
    const roles = { planner: {}, builder: {}, reviewer: {}, scaffolder: {} };
    const manifest = {
      e2e: { config: "playwright.config.ts" },
      pages: [
        { id: "home", path: "/" },
        { id: "admin", path: "/admin" },
      ],
    };
    const home = makeRepo(baseTeam({ roles }), { ".a6g/harness.json": manifest, "e2e/a.spec.ts": "test('a', () => {});\n" });
    // A manifest that doesn't load is refused.
    branch(home, "a6g/s1-broken", { ".a6g/harness.json": "{ nope" });
    await approve(home, "a6g/s1-broken");
    let result = await merge(home, "a6g/s1-broken");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s1-broken").message, /harness\.json doesn't load: .*not JSON/);
    // A page gone from the manifest, or a test skipped, checks less.
    const fewer = branch(home, "a6g/s2-drop", { ".a6g/harness.json": { ...manifest, pages: [{ id: "home", path: "/" }] } });
    await approve(home, "a6g/s2-drop");
    result = await merge(home, "a6g/s2-drop");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s2-drop").message, /checks less than a6g\/next: page admin is no longer checked\. That's the operator's call/);
    branch(home, "a6g/s3-skip", { "e2e/a.spec.ts": "test.skip('a', () => {});\n" });
    await approve(home, "a6g/s3-skip");
    result = await merge(home, "a6g/s3-skip");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s3-skip").message, /e2e\/a\.spec\.ts: test\.skip\('a'/);
    // No agent allows it; the operator allows that commit, and it merges.
    const asAgent = await a6g(["harness", "allow", "a6g/s2-drop", "--sha", fewer, "--why", "x"], {
      cwd: home,
      env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: "planner", A6G_RUN: `${home}-run` },
    });
    assert.notEqual(asAgent.code, 0);
    assert.match(asAgent.out, /operator's call/);
    const asOperator = await a6g(["harness", "allow", "a6g/s2-drop", "--sha", fewer, "--why", "the admin page moved to its own app"], { cwd: home });
    assert.equal(asOperator.code, 0, asOperator.out);
    result = await merge(home, "a6g/s2-drop");
    assert.equal(result.code, 0, result.out);
    // An allowance is for that commit only: a commit added after it checks less again, and waits for the operator.
    assert.equal((await a6g(["harness", "allow", "a6g/s3-skip", "--sha", tip(home, "a6g/s3-skip"), "--why", "x"], { cwd: home })).code, 0);
    git(home, "checkout", "-q", "a6g/s3-skip");
    commit(home, { "e2e/b.spec.ts": "test.only('b', () => {});\n" }, "only b");
    git(home, "checkout", "-q", "a6g/next");
    await approve(home, "a6g/s3-skip");
    result = await merge(home, "a6g/s3-skip");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s3-skip").message, /checks less than a6g\/next: .*test\.only/);
  });

  test("closes the tickets it's told to, and refuses a dirty checkout", async () => {
    const home = makeRepo(baseTeam(), { ".a6g/run/board/7-seven.md": "status: review\n" });
    branch(home, "a6g/b10-ten", { "src/ten.ts": "10\n" });
    await approve(home, "a6g/b10-ten");
    write(home, { "README.md": "edited but not committed\n" });
    assert.equal((await merge(home, "a6g/b10-ten")).code, 2);
    assert.match(record(home, "a6g/b10-ten").message, /uncommitted changes/);
    git(home, "checkout", "--", "README.md");
    const result = await merge(home, "a6g/b10-ten", "--closes", "7");
    assert.equal(result.code, 0, result.out);
    assert.equal(await taskStatus(home, "7"), "done");
  });

  test("a branch that conflicts sends its task back to be rebased; a6g merge --push closes what a failed push held", async () => {
    const home = makeRepo(baseTeam(), { ".a6g/run/board/4-four.md": "status: review\n", "src/shared.ts": "0\n" });
    branch(home, "a6g/b4-four", { "src/shared.ts": "from the branch\n" });
    await approve(home, "a6g/b4-four");
    commit(home, { "src/shared.ts": "from the integration branch\n" }, "a change the branch conflicts with");
    const result = await merge(home, "a6g/b4-four");
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /task 4 went back to be claimed and rebased/);
    const task = await fileStore(`${home}-run`, "fixture").tasks.get("4");
    assert.deepEqual([task?.status, task?.sha], ["approved", null]);
    assert.match(task?.notes.at(-1)?.text ?? "", /rebase a6g\/b4-four onto it/);
    // Held open by a merge whose push failed: closed once a push goes through.
    write(`${home}-run`, { "unpushed.json": [{ ids: ["4"], branch: "a6g/b4-four", sha: "abc", tip: "abc" }] });
    const pushed = await merge(home, "--push");
    assert.equal(pushed.code, 0, pushed.out);
    assert.equal(await taskStatus(home, "4"), "done");
  });
});
