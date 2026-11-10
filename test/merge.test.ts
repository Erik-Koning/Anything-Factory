import { baseTeam, commit, a6g, git, makeRepo, ROOT, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startOf } from "../lib/lock.ts";
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

  test("a scaffolder's branch is always reviewed, merges for its own open task, and keeps test work to test files", async () => {
    const roles = { planner: {}, builder: {}, reviewer: {}, scaffolder: {} };
    const testInfra = "status: review\nkind: test-infra\n\nSet the browser checks up.\n";
    const pkg = { name: "app", scripts: { build: "tsc" }, dependencies: {} };
    const home = makeRepo(baseTeam({ roles, review: { required: ["builder"] }, harness: { lane: ["^tools/smoke/"] } }), {
      ".a6g/run/board/5-harness.md": testInfra,
      ".a6g/run/board/6-skeleton.md": "status: review\nkind: scaffold\n\nMake the app's skeleton.\n",
      ".a6g/run/board/8-idea.md": "status: proposed\nkind: scaffold\n\nNot approved.\n",
      ".a6g/run/board/9-more.md": testInfra,
      ".a6g/run/board/10-deps.md": testInfra,
      "package.json": pkg,
    });
    // review.required names only builders here; the scaffolder's branches are reviewed anyway. Test work changes
    // tests, the runner's configuration, what the operator added to the lane, and a package.json's test keys.
    branch(home, "a6g/s5-harness", {
      "e2e/home.spec.ts": "test('home', () => {});\n",
      "playwright.config.ts": "export default {};\n",
      "tools/smoke/run.ts": "export {};\n",
      "package.json": { ...pkg, scripts: { build: "tsc", "test:e2e": "playwright test" }, devDependencies: { "@playwright/test": "1.50.0" } },
    });
    let result = await merge(home, "a6g/s5-harness");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s5-harness").message, /has no review/);
    await approve(home, "a6g/s5-harness");
    assert.equal((await merge(home, "a6g/s5-harness")).code, 0);
    // Its task's kind decides what it may change, so it merges for its own approved, open task: 5 is done by now, 8
    // was never approved, and there's no 12.
    for (const [name, why] of [
      ["a6g/s5-again", /is named for task 5, which is done: a scaffolder's branch merges for its own approved, open task/],
      ["a6g/s8-idea", /is named for task 8, which is proposed/],
      ["a6g/s12-none", /is named for task 12, and there's no such task/],
    ] as const) {
      branch(home, name, { "src/app.ts": `export const from = "${name}";\n` });
      await approve(home, name);
      result = await merge(home, name);
      assert.equal(result.code, 2, result.out);
      assert.match(record(home, name).message, why);
    }
    // Test-infra work that changes product code is refused, and so is what a package.json ships with; scaffold work
    // may change anything a builder may.
    branch(home, "a6g/s9-more", { "e2e/b.spec.ts": "test('b', () => {});\n", "src/app.ts": "export const fixed = true;\n" });
    await approve(home, "a6g/s9-more");
    result = await merge(home, "a6g/s9-more");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s9-more").message, /is test-infra work, which changes test and harness files only, and it changes src\/app\.ts/);
    branch(home, "a6g/s10-deps", { "package.json": { ...pkg, dependencies: { "left-pad": "1.3.0" } } });
    await approve(home, "a6g/s10-deps");
    result = await merge(home, "a6g/s10-deps");
    assert.equal(result.code, 2, result.out);
    assert.match(
      record(home, "a6g/s10-deps").message,
      /is test-infra work.* it changes package\.json \(dependencies: test work changes its devDependencies and test scripts only\)/
    );
    branch(home, "a6g/s6-skeleton", { "src/app.ts": "export const app = 1;\n", "package.json": "{}\n" });
    await approve(home, "a6g/s6-skeleton");
    assert.equal((await merge(home, "a6g/s6-skeleton")).code, 0);
  });

  test("a builder's branch changes no file that holds a journey's tests, where someone else can write them", async () => {
    const roles = { planner: {}, builder: {}, reviewer: {}, scaffolder: {} };
    const journey = [
      'import { test, expect } from "./fixtures";',
      'test("pays", { tag: "@journey-3" }, async ({ page }) => {',
      '  await expect(page.getByText("Paid")).toBeVisible();',
      "});",
      "",
    ].join("\n");
    const files = { "e2e/pay.spec.ts": journey, "src/pay.ts": "export const pay = 0;\n" };
    const home = makeRepo(baseTeam({ roles }), files);
    const refused = async (name: string): Promise<string> => {
      await approve(home, name);
      const result = await merge(home, name);
      assert.equal(result.code, 2, result.out);
      return record(home, name).message;
    };
    // The test gutted and its tag's line left alone: it's still the journey's proof, made by who built it.
    branch(home, "a6g/b7-gut", { "src/pay.ts": "export const pay = 1;\n", "e2e/pay.spec.ts": journey.replace(/ {2}await expect.*\n/, "") });
    assert.match(
      await refused("a6g/b7-gut"),
      /a6g\/b7-gut \(a builder's\) changes e2e\/pay\.spec\.ts, where a journey's tests are: a journey's proof comes from a tester or the scaffolder/
    );
    // Deleted, or a new one of its own wherever it puts it: the same.
    git(home, "checkout", "-q", "-b", "a6g/b8-drop");
    git(home, "rm", "-q", "e2e/pay.spec.ts");
    git(home, "commit", "-q", "-m", "drop it");
    git(home, "checkout", "-q", "a6g/next");
    assert.match(await refused("a6g/b8-drop"), /changes e2e\/pay\.spec\.ts, where a journey's tests are/);
    branch(home, "a6g/b9-own", { "src/flows.ts": 'import { test } from "@playwright/test";\ntest("pays @journey-3", async () => {});\n' });
    assert.match(await refused("a6g/b9-own"), /changes src\/flows\.ts, where a journey's tests are/);
    // Its own unit tests, and code that only mentions a journey, are its own.
    branch(home, "a6g/b10-fine", {
      "src/pay.ts": "// The total of @journey-3's order.\nexport const pay = 2;\n",
      "src/pay.test.ts": "test('adds', () => {});\n",
    });
    await approve(home, "a6g/b10-fine");
    assert.equal((await merge(home, "a6g/b10-fine")).code, 0);
    // A team with no tester and no scaffolder: its builders are the only ones who can write them.
    const alone = makeRepo(baseTeam({ roles: { planner: {}, builder: {}, reviewer: {} } }), files);
    branch(alone, "a6g/b7-gut", { "e2e/pay.spec.ts": journey.replace("Paid", "Thanks") });
    await approve(alone, "a6g/b7-gut");
    assert.equal((await merge(alone, "a6g/b7-gut")).code, 0);
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
    const spec = (body: string): string => `import { test } from "@playwright/test";\n${body}\n`;
    const testInfra = "status: review\nkind: test-infra\n";
    const home = makeRepo(baseTeam({ roles }), {
      ".a6g/harness.json": manifest,
      "playwright.config.ts": 'export default { testMatch: "**/*.spec.ts", retries: 1 };\n',
      "e2e/a.spec.ts": spec("test('a', () => {});"),
      "e2e/old.spec.ts": spec("test.fixme('old', () => {});"),
      "src/list.test.ts": "it('lists', () => {});\n",
      ".a6g/run/board/1-broken.md": testInfra,
      ".a6g/run/board/2-drop.md": testInfra,
      ".a6g/run/board/3-skip.md": testInfra,
      ".a6g/run/board/4-tidy.md": testInfra,
    });
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
    branch(home, "a6g/s3-skip", { "e2e/a.spec.ts": spec("test.skip('a', () => {});") });
    await approve(home, "a6g/s3-skip");
    result = await merge(home, "a6g/s3-skip");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s3-skip").message, /e2e\/a\.spec\.ts: test\.skip\('a'/);
    // What only looks like it merges: a file that moved with its fixme, a comment about .only(, a unit test's own
    // skip (not the suite's), more retries, another glob.
    git(home, "checkout", "-q", "-b", "a6g/s4-tidy");
    git(home, "mv", "e2e/old.spec.ts", "e2e/older.spec.ts");
    commit(
      home,
      {
        "e2e/a.spec.ts": spec("// Never test.only( here.\ntest('a', () => {});"),
        "src/list.test.ts": "it.skip('lists', () => {});\n",
        "playwright.config.ts": 'export default { testMatch: "**/*.{spec,e2e}.ts", retries: 3 };\n',
      },
      "tidy"
    );
    git(home, "checkout", "-q", "a6g/next");
    await approve(home, "a6g/s4-tidy");
    result = await merge(home, "a6g/s4-tidy");
    assert.equal(result.code, 0, result.out);
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
    commit(home, { "e2e/b.spec.ts": spec("test.only('b', () => {});") }, "only b");
    git(home, "checkout", "-q", "a6g/next");
    await approve(home, "a6g/s3-skip");
    result = await merge(home, "a6g/s3-skip");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/s3-skip").message, /checks less than a6g\/next: .*test\.only/);
  });

  test("the suite's own listing says what a branch stops checking, however its tests are written", async () => {
    const roles = { planner: {}, builder: {}, reviewer: {}, scaffolder: {} };
    const testInfra = "status: review\nkind: test-infra\n";
    const spec = (...tests: string[]): string => ['import { test, journey } from "./fixtures.mjs";', ...tests, ""].join("\n");
    const pays = 'test("pays", journey(3), async () => {});';
    const home = makeRepo(baseTeam({ roles }), {
      ".a6g/harness.json": { e2e: { config: "playwright.config.mjs" } },
      "playwright.config.mjs": 'export default { testDir: "e2e" };\n',
      // The tag comes from a helper and `test` from the suite's own fixtures: no spec's text says either.
      "e2e/fixtures.mjs": 'export { test, expect } from "playwright/test";\nexport const journey = (id) => ({ tag: "@" + "journey-" + id });\n',
      "e2e/pay.spec.mjs": spec(pays, 'test("pays twice", journey(3), async () => {});'),
      "e2e/home.spec.mjs": spec('test("home", async () => {});', 'test.fixme("search", async () => {});'),
      "src/pay.ts": "export const pay = 0;\n",
      ".gitignore": "node_modules\n",
      ...Object.fromEntries(["1-less", "2-skip", "4-move", "5-broken"].map((name) => [`.a6g/run/board/${name}.md`, testInfra])),
    });
    mkdirSync(join(home, "node_modules"), { recursive: true });
    for (const name of ["playwright", "playwright-core"]) symlinkSync(join(ROOT, "node_modules", name), join(home, "node_modules", name));
    const refused = async (name: string): Promise<string> => {
      await approve(home, name);
      const result = await merge(home, name);
      assert.equal(result.code, 2, result.out);
      return record(home, name).message;
    };
    // A test taken out: nothing in the text narrows, and the suite runs one fewer.
    const less = branch(home, "a6g/s1-less", { "e2e/pay.spec.mjs": spec(pays) });
    assert.match(
      await refused("a6g/s1-less"),
      /a6g\/s1-less checks less than a6g\/next: the suite runs 2 tests, 1 fewer than before; journey 3 has 1 tests that run, not 2\. That's the operator's call/
    );
    // A skip inside a test's body isn't in a listing; the listing says which files are the suite's, and their text is read.
    branch(home, "a6g/s2-skip", {
      "e2e/home.spec.mjs": spec('test("home", async () => {\n  test.skip(true, "later");\n});', 'test.fixme("search", async () => {});'),
    });
    assert.match(await refused("a6g/s2-skip"), /checks less than a6g\/next: e2e\/home\.spec\.mjs: test\.skip\(true, "later"\);/);
    // A builder's change to a file the listing gives a journey's tests to.
    branch(home, "a6g/b3-pay", {
      "src/pay.ts": "export const pay = 1;\n",
      "e2e/pay.spec.mjs": spec(pays, 'test("pays twice", journey(3), async () => { /* later */ });'),
    });
    assert.match(await refused("a6g/b3-pay"), /a6g\/b3-pay \(a builder's\) changes e2e\/pay\.spec\.mjs, where a journey's tests are/);
    // A spec that no longer loads can't be counted.
    branch(home, "a6g/s5-broken", { "e2e/home.spec.mjs": 'import { test } from "./gone.mjs";\ntest("home", async () => {});\n' });
    assert.match(await refused("a6g/s5-broken"), /a6g\/s5-broken breaks the suite's listing \(.*gone\.mjs.*\), so its tests can't be counted: fix that/s);
    // A file that moves, its fixme with it, runs what it ran.
    git(home, "checkout", "-q", "-b", "a6g/s4-move");
    git(home, "mv", "e2e/home.spec.mjs", "e2e/start.spec.mjs");
    git(home, "commit", "-q", "-m", "move it");
    git(home, "checkout", "-q", "a6g/next");
    await approve(home, "a6g/s4-move");
    let result = await merge(home, "a6g/s4-move");
    assert.equal(result.code, 0, result.out);
    // The operator allows the first, and it merges.
    assert.equal((await a6g(["harness", "allow", "a6g/s1-less", "--sha", less, "--why", "paying twice is no longer offered"], { cwd: home })).code, 0);
    result = await merge(home, "a6g/s1-less");
    assert.equal(result.code, 0, result.out);
    assert.ok(!existsSync(join(home, ".a6g/run/merge")), "the scratch worktree is gone");
  });

  test("a queued merge is marked by its process and when it started, clears its mark however it ends, and runs the check that's due", async () => {
    const home = makeRepo(baseTeam({ gate: { full: "sleep 2", quick: "true" } }));
    const state = join(home, ".a6g/run/state");
    const mark = (name: string): string => join(state, "merges", "pending", `${name}.json`);
    const until = async (done: () => boolean): Promise<void> => {
      for (let i = 0; i < 300 && !done(); i++) await new Promise((next) => setTimeout(next, 100));
      assert.ok(done(), "it finished");
    };
    branch(home, "a6g/b1-x", { "src/x.ts": "1\n" });
    await approve(home, "a6g/b1-x");
    const queued = await merge(home, "a6g/b1-x", "--queue");
    assert.equal(queued.code, 0, queued.out);
    assert.match(queued.out, /a6g\/b1-x queued/);
    const written = JSON.parse(readFileSync(mark("a6g_b1-x"), "utf8")) as { pid: number; started: string | null };
    assert.equal(written.started, startOf(written.pid), "the queued process, and when it started");
    await until(() => !existsSync(mark("a6g_b1-x")));
    assert.equal(record(home, "a6g/b1-x").result, "merged");
    assert.match(readFileSync(join(state, "verify.log"), "utf8"), /[0-9a-f]{9} nothing to check\n$/);
    assert.ok(!existsSync(join(state, "verify-due.json")));

    // One that's refused (nobody approved it) clears its mark too, and runs the check a merge before it left due.
    branch(home, "a6g/b2-y", { "src/y.ts": "1\n" });
    writeFileSync(join(state, "verify-due.json"), JSON.stringify({ at: new Date().toISOString(), after: "a6g/b1-x" }));
    await merge(home, "a6g/b2-y", "--queue");
    await until(() => existsSync(join(state, "merges", "a6g_b2-y.json")) && !existsSync(mark("a6g_b2-y")));
    assert.equal(record(home, "a6g/b2-y").result, "refused");
    assert.ok(!existsSync(join(state, "verify-due.json")), "the check ran");
    assert.equal(readFileSync(join(state, "verify.log"), "utf8").trim().split("\n").length, 2);
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
