import { baseTeam, commit, git, makeRepo, ROOT, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { browserProblem } from "../lib/browser.ts";
import { historyFile, journeyProofFor, namespaceOf, recordSuite, runFor, suiteGaps, suiteHistory, summary, unprovenIn } from "../lib/commands/e2e.ts";
import { loadTeam, type RawTeam } from "../lib/config.ts";
import { journeysRequired } from "../lib/harness.ts";
import { journeysOf, playwrightCli, reachedTests, runPlaywright, scrub, type SpecResult, specsOf, type SuiteRecord } from "../lib/suite.ts";
import { writeJson } from "../lib/util.ts";
import { moveRefusal, newTask, type Task } from "../lib/tasks/model.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir, "Library", "Caches", "ms-playwright");
const noBrowser = browserProblem();

const task = (fields: Partial<Task> & { id: string }): Task => ({
  ...newTask({ team: "fixture", title: `task ${fields.id}`, kind: "feature", status: "done", by: "planner", ...fields }),
  version: 1,
  ...fields,
});

describe("the suite's report", () => {
  test("names each test once per project, with its tags, outcome and first error, and journeys by exact tag", () => {
    const specs = specsOf({
      suites: [
        {
          title: "j1.spec.ts",
          file: "j1.spec.ts",
          specs: [
            { title: "signs up", tags: ["@journey-1"], tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed" }] }] },
            {
              title: "pays",
              tags: ["@journey-12", "@slow"],
              tests: [
                {
                  projectName: "chromium",
                  status: "unexpected",
                  results: [{ status: "failed", error: { message: "\u001b[31mExpected 2\u001b[0m\nReceived 3" } }],
                },
              ],
            },
          ],
          suites: [
            {
              title: "admin",
              specs: [{ title: "approves", tags: [], tests: [{ status: "flaky", results: [{ status: "failed" }, { status: "passed" }] }] }],
            },
          ],
        },
      ],
    });
    assert.deepEqual(
      specs.map((s) => [s.id, s.outcome, s.error ?? ""]),
      [
        ["j1.spec.ts › signs up [chromium]", "passed", ""],
        ["j1.spec.ts › pays [chromium]", "failed", "Expected 2 · Received 3"],
        ["j1.spec.ts › admin › approves", "flaky", ""],
      ]
    );
    assert.deepEqual(journeysOf(specs[0] as never), ["1"]);
    assert.deepEqual(journeysOf(specs[1] as never), ["12"], "@journey-12 is journey 12, not 1");
    assert.deepEqual(specsOf({ suites: [{ title: "a", file: "a", specs: [{ title: "t", tests: [{}] }] }] })[0]?.outcome, "listed");
    assert.equal(scrub("Error: STRIPE_SECRET_KEY=sk_test_123 was refused"), "Error: STRIPE_SECRET_KEY=… was refused");
  });

  test("a test's outcome is how it went against what it declared: told to fail or skip is never a pass", () => {
    const one = (test: Record<string, unknown>) =>
      specsOf({ suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [{ title: "t", tests: [test] }] }] })[0]?.outcome;
    const ran = (status: string, expectedStatus: string, ...results: string[]) =>
      one({ status, expectedStatus, results: results.map((r) => ({ status: r })) });
    assert.equal(ran("expected", "passed", "passed"), "passed");
    assert.equal(ran("unexpected", "passed", "failed"), "failed");
    assert.equal(ran("flaky", "passed", "failed", "passed"), "flaky");
    // test.fail(), test.fail("…"), test.info().fail(): Playwright calls the failure expected.
    assert.equal(ran("expected", "failed", "failed"), "excused");
    assert.equal(ran("unexpected", "failed", "passed"), "failed", "told to fail, and it passed");
    assert.equal(ran("skipped", "skipped", "skipped"), "skipped");
    assert.equal(ran("skipped", "passed", "interrupted"), "skipped");
    // A listing has no results: what a test is declared with is all there is.
    assert.equal(one({ status: "skipped", expectedStatus: "passed", results: [] }), "listed");
    assert.equal(one({ status: "skipped", expectedStatus: "skipped", results: [], annotations: [{ type: "fixme" }] }), "skipped");
    assert.equal(one({ status: "skipped", expectedStatus: "passed", results: [], annotations: [{ type: "fail" }] }), "excused");
    assert.ok(!reachedTests({ suites: [{ specs: [{ title: "t", tests: [{ status: "skipped", results: [] }] }] }] }));
    assert.ok(!reachedTests({ errors: [{ message: "Error: global setup blew up" }] }));
    assert.ok(reachedTests({ suites: [{ suites: [{ specs: [{ title: "t", tests: [{ results: [{ status: "passed" }] }] }] }] }] }));
  });

  test("one reading of a run: a journey is proven by the newest run holding its merges, where every tagged test passed", () => {
    const home = makeRepo(baseTeam({ board: "tasks", roles: { planner: {}, builder: {}, reviewer: {}, scaffolder: {} } }), {
      ".a6g/harness.json": { e2e: { config: "playwright.config.ts" } },
    });
    const first = git(home, "rev-parse", "HEAD");
    write(home, { "README.md": "later\n" });
    git(home, "add", "README.md");
    git(home, "commit", "-qm", "later");
    const later = git(home, "rev-parse", "HEAD");
    const spec = (title: string, outcome: SpecResult["outcome"], ...tags: string[]): SpecResult => ({
      id: `e2e/a.spec.ts › ${title}`,
      file: "e2e/a.spec.ts",
      title,
      project: "",
      tags,
      outcome,
    });
    const record = (commit: string, specs: SpecResult[], more: Partial<SuiteRecord> = {}): SuiteRecord => ({
      commit,
      at: "2026-01-01T00:00:00.000Z",
      ran: true,
      timedOut: false,
      status: 0,
      specs,
      errors: [],
      ...more,
    });
    const good = record(first, [spec("pays", "passed", "@journey-1"), spec("refunds", "flaky", "@journey-1"), spec("other", "failed", "@journey-2")]);
    assert.equal(unprovenIn(good, "1"), null, "a test that passed on its retry passed");
    assert.match(unprovenIn(good, "2") ?? "", /1 of journey 2's 1 tests didn't pass at .{9}: other$/);
    assert.match(unprovenIn(good, "3") ?? "", /no test is tagged @journey-3/);
    // Every test, not some: one skipped or told to fail keeps the journey open.
    const partial = record(first, [
      spec("pays", "passed", "@journey-1"),
      spec("refunds", "skipped", "@journey-1"),
      spec("cancels", "excused", "@journey-1"),
    ]);
    assert.match(unprovenIn(partial, "1") ?? "", /2 of journey 1's 3 tests didn't pass at .{9}: refunds \(skipped\); cancels \(expected to fail\)/);
    const stopped = record(later, [], { ran: false, timedOut: true, status: null, errors: ["it ran past 20 minutes (e2e.timeoutMin) and was stopped"] });
    assert.match(unprovenIn(stopped, "1") ?? "", /the suite didn't run at .{9} \(it ran past 20 minutes .*\), so journey 1 isn't proven yet/);

    const team = loadTeam(home);
    const journey = task({ id: "1", kind: "journey", status: "approved" });
    const all = [journey, task({ id: "5", parent: "1", sha: first })];
    const proof = journeyProofFor(home, team);
    writeJson(historyFile(home), [good]);
    assert.equal(proof(journey, all), null);
    assert.deepEqual(
      suiteGaps(home, [journey]).map((gap) => gap.replace(/[0-9a-f]{9}/g, "<sha>")),
      ["the last run was at <sha>, not the head (<sha>): a6g e2e run", "1 tests failed: e2e/a.spec.ts › other"]
    );
    // A newer run that didn't finish holds the merges too: it speaks for the journey, and the older pass doesn't.
    writeJson(historyFile(home), [stopped, good]);
    assert.equal(runFor(home, journey, all)?.commit, later);
    assert.match(proof(journey, all) ?? "", /the suite didn't run at .{9}/);
    assert.deepEqual(
      suiteGaps(home, [journey]),
      ["the last run didn't run: it ran past 20 minutes (e2e.timeoutMin) and was stopped"],
      "and it files no gaps"
    );
    // A run before one of the journey's merges says nothing of it.
    writeJson(historyFile(home), [good]);
    assert.match(
      proof(journey, [journey, task({ id: "5", parent: "1", sha: later })]) ?? "",
      /no recorded run of the suite holds all of journey 1's merges yet/
    );
    // At the finish line every journey is read the same way.
    writeJson(historyFile(home), [record(later, partial.specs)]);
    assert.deepEqual(
      suiteGaps(home, [journey]).map((gap) => gap.replace(/[0-9a-f]{9}/g, "<sha>")),
      ["journey 1 (task 1): 2 of journey 1's 3 tests didn't pass at <sha>: refunds (skipped); cancels (expected to fail)"]
    );
  });

  test("a run's namespace is the member's branch", () => {
    const home = makeRepo();
    git(home, "checkout", "-q", "-b", "a6g/b12-pay");
    assert.equal(namespaceOf(home, "a6g"), "b12");
    git(home, "checkout", "-q", "-b", "a6g/t-14-specs");
    assert.equal(namespaceOf(home, "a6g"), "t14");
    git(home, "checkout", "-q", "-b", "a6g/s3-harness");
    assert.equal(namespaceOf(home, "a6g"), "s3");
  });

  test("journeys are required once there's a suite, unless the operator says", () => {
    const roles = { planner: {}, builder: {}, reviewer: {}, tester: { write: ["^e2e/"] }, scaffolder: {} };
    const bare = makeRepo(baseTeam({ board: "tasks", roles }));
    assert.equal(loadTeam(bare).harness.journeys, "auto");
    assert.ok(!journeysRequired(bare, loadTeam(bare)), "a tester and a scaffolder, and no suite yet: journeys close as before");
    const pagesOnly = makeRepo(baseTeam({ board: "tasks", roles }), { ".a6g/harness.json": { pages: [{ id: "home", path: "/" }] } });
    assert.ok(!journeysRequired(pagesOnly, loadTeam(pagesOnly)), "pages alone aren't a suite");
    const manifest = { ".a6g/harness.json": { e2e: { config: "playwright.config.ts" } } };
    const suite = makeRepo(baseTeam({ board: "tasks", roles }), manifest);
    assert.ok(journeysRequired(suite, loadTeam(suite)));
    const optional = makeRepo(baseTeam({ board: "tasks", roles, harness: { journeys: "optional" } }), manifest);
    assert.ok(!journeysRequired(optional, loadTeam(optional)), "the operator's word wins");
    const required = makeRepo(baseTeam({ board: "tasks", roles, harness: { journeys: "required" } }));
    assert.ok(journeysRequired(required, loadTeam(required)));
  });

  test("Playwright is found from the configuration's folder upward", () => {
    const home = makeRepo();
    assert.equal(playwrightCli(home), null);
    write(home, { "apps/web/node_modules/@playwright/test/cli.js": "", "apps/web/e2e/playwright.config.ts": "" });
    assert.equal(playwrightCli(join(home, "apps", "web", "e2e")), join(home, "apps", "web", "node_modules", "@playwright", "test", "cli.js"));
    assert.equal(playwrightCli(home), null, "not downward");
    // The merge's scratch worktree is inside the checkout, so the checkout's own install is found from it.
    write(home, { "node_modules/playwright/cli.js": "", ".a6g/run/merge/playwright.config.ts": "" });
    assert.equal(playwrightCli(join(home, ".a6g", "run", "merge")), join(home, "node_modules", "playwright", "cli.js"));
    assert.equal(playwrightCli(join(home, "apps", "web")), join(home, "apps", "web", "node_modules", "@playwright", "test", "cli.js"), "the nearest");
  });

  test("the factory's browser is proven by starting it: one that isn't downloaded is said so", () => {
    const before = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = tmp("a6g-no-browsers-");
    try {
      assert.match(
        browserProblem() ?? "",
        /the factory's browser \(Chromium's headless shell\) can't start: it isn't downloaded\. a6g self-install fetches it/
      );
    } finally {
      process.env.PLAYWRIGHT_BROWSERS_PATH = before;
    }
  });
});

describe("journeys as specs, in a real browser", { skip: noBrowser ?? false }, () => {
  let server: Server;
  let url = "";
  before(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html lang=en><title>t</title><h1>Fine</h1>");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  after(() => server.close());

  test("a journey is done only on a recorded run that holds its merges, where its tagged tests passed", async () => {
    const team = {
      ...baseTeam({ board: "tasks" }),
      roles: { planner: {}, builder: {}, reviewer: {}, scaffolder: {} },
      pages: { appUrl: url },
    } as RawTeam;
    const home = makeRepo(team, {
      ".a6g/harness.json": { e2e: { config: "playwright.config.mjs", timeoutMin: 3 } },
      "playwright.config.mjs": "export default { testDir: 'e2e', use: { baseURL: process.env.PLAYWRIGHT_BASE_URL }, workers: 1 };\n",
      "e2e/journeys.spec.mjs": [
        'import { test, expect } from "playwright/test";',
        'test("sees the heading", { tag: "@journey-1" }, async ({ page }) => { await page.goto("/"); await expect(page.getByRole("heading")).toHaveText("Fine"); });',
        'test("sees a total", { tag: "@journey-2" }, async ({ page }) => { await page.goto("/"); await expect(page.getByText("Total")).toBeVisible({ timeout: 500 }); });',
        "test('names its namespace', async () => { expect(process.env.A6G_NAMESPACE).toMatch(/^e2e-/); });",
        "",
      ].join("\n"),
      ".gitignore": "node_modules\n",
    });
    // The repository's own Playwright: the factory's copy, linked in.
    mkdirSync(join(home, "node_modules"), { recursive: true });
    for (const name of ["playwright", "playwright-core"]) symlinkSync(join(ROOT, "node_modules", name), join(home, "node_modules", name));
    const loaded = loadTeam(home);
    assert.ok(journeysRequired(home, loaded), "a team with a suite requires its journeys");
    const first = git(home, "rev-parse", "HEAD");
    const journeys = [task({ id: "1", kind: "journey", status: "approved" }), task({ id: "2", kind: "journey", status: "approved" })];
    const all = [...journeys, task({ id: "3", parent: "1", sha: first }), task({ id: "4", parent: "2", sha: first })];
    const proof = journeyProofFor(home, loaded);
    assert.match(proof(journeys[0] as Task, all) ?? "", /no recorded run of the suite holds all of journey 1's merges yet/);

    const record = await recordSuite(home, loaded);
    assert.equal(record.commit, first);
    assert.deepEqual(
      record.specs.map((s) => [s.title, s.outcome]),
      [
        ["sees the heading", "passed"],
        ["sees a total", "failed"],
        ["names its namespace", "passed"],
      ]
    );
    assert.equal(proof(journeys[0] as Task, all), null, "journey 1's test passed at a commit holding its merges");
    assert.match(proof(journeys[1] as Task, all) ?? "", /1 of journey 2's 1 tests didn't pass at/);
    // The move rules ask the proof of every move to done but the operator's.
    const ctx = { all, journeyProof: proof };
    assert.match(moveRefusal(journeys[1] as Task, "done", "status", "planner", ctx) ?? "", /didn't pass/);
    assert.equal(moveRefusal(journeys[1] as Task, "done", "status", "operator", ctx), null);
    assert.match(suiteGaps(home, journeys).join("\n"), /1 tests failed: .*sees a total/);

    // A later merge isn't in that run: the journey that merged it waits for a run that holds it.
    write(home, { "README.md": "later\n" });
    git(home, "add", "README.md");
    git(home, "commit", "-qm", "later");
    const later = git(home, "rev-parse", "HEAD");
    const moved = [...journeys, task({ id: "3", parent: "1", sha: later }), task({ id: "4", parent: "2", sha: first })];
    assert.match(proof(journeys[0] as Task, moved) ?? "", /no recorded run of the suite holds all of journey 1's merges/);
    assert.match(suiteGaps(home, journeys).join("\n"), /the last run was at .*, not the head/);
    assert.equal(suiteHistory(home).length, 1);
  });

  test("a recorded run sets its own retries and forbids .only, whatever the repository's configuration says", async () => {
    const team = { ...baseTeam({ board: "tasks" }), roles: { planner: {}, builder: {}, reviewer: {}, scaffolder: {} }, pages: { appUrl: url } } as RawTeam;
    const home = makeRepo(team, {
      ".a6g/harness.json": { e2e: { config: "playwright.config.mjs", timeoutMin: 3 } },
      "playwright.config.mjs": "export default { testDir: 'e2e', retries: 3, workers: 1 };\n",
      "e2e/a.spec.mjs": [
        'import { test, expect } from "playwright/test";',
        'test("passes", { tag: "@journey-1" }, async () => { expect(1).toBe(1); });',
        'test("passes second time", { tag: "@journey-2" }, async ({}, info) => { expect(info.retry).toBe(1); });',
        'test("told to fail", { tag: "@journey-3" }, async ({}, info) => { info.fail(); expect(1).toBe(2); });',
        'test.skip("left out", { tag: "@journey-3" }, async () => {});',
        "",
      ].join("\n"),
      ".gitignore": "node_modules\n",
    });
    mkdirSync(join(home, "node_modules"), { recursive: true });
    for (const name of ["playwright", "playwright-core"]) symlinkSync(join(ROOT, "node_modules", name), join(home, "node_modules", name));
    const loaded = loadTeam(home);
    const record = await recordSuite(home, loaded);
    assert.deepEqual(
      record.specs.map((s) => [s.title, s.outcome]),
      [
        ["passes", "passed"],
        ["passes second time", "failed"],
        ["told to fail", "excused"],
        ["left out", "skipped"],
      ],
      "the configuration's three retries didn't forgive the failure"
    );
    assert.ok(record.ran);
    assert.equal(summary(record), "1 passed, 1 failed, 1 skipped, 1 expected to fail");
    assert.equal(unprovenIn(record, "1"), null);
    assert.match(unprovenIn(record, "3") ?? "", /2 of journey 3's 2 tests didn't pass/);
    // The check after merges allows one retry of its own: the same test is flaky there, not failed.
    assert.equal((await recordSuite(home, loaded, { retries: 1 })).specs[1]?.outcome, "flaky");

    // A .only would run a part of the suite and report it whole: the run is refused, and it's no run at all.
    commit(home, { "e2e/b.spec.mjs": 'import { test } from "playwright/test";\ntest.only("just this", async () => {});\n' });
    const only = await recordSuite(home, loaded);
    assert.ok(!only.ran);
    assert.match(summary(only), /^the suite didn't run: Error: item focused with '\.only' is not allowed/);
    const journey = task({ id: "1", kind: "journey", status: "approved" });
    assert.match(journeyProofFor(home, loaded)(journey, [journey]) ?? "", /the suite didn't run at/, "the pass before it doesn't stand in");
  });
});

describe("the suite's time limit", () => {
  test("ends everything the suite started, and stops waiting for what won't end", async () => {
    const home = makeRepo(baseTeam(), {
      "playwright.config.mjs": "export default { testDir: 'e2e', workers: 1, globalSetup: './setup.mjs' };\n",
      // Two processes the suite leaves behind: one a test starts that ignores being asked to stop, and one its setup
      // starts for good, which has left the group and holds the suite's output open.
      "setup.mjs": [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "export default () => {",
        "  const away = spawn('sh', ['-c', 'sleep 300'], { stdio: 'inherit', detached: true });",
        "  away.unref();",
        "  writeFileSync(`${process.env.PIDS}.away`, String(away.pid));",
        "};",
        "",
      ].join("\n"),
      "e2e/hang.spec.mjs": [
        'import { test } from "playwright/test";',
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'test("hangs", async () => {',
        "  test.skip(!!process.env.QUICK);",
        "  const deaf = spawn('sh', ['-c', 'trap \"\" TERM; sleep 300'], { stdio: 'inherit' });",
        "  writeFileSync(process.env.PIDS, String(deaf.pid));",
        "  await new Promise(() => {});",
        "});",
        "",
      ].join("\n"),
      ".gitignore": "node_modules\n",
    });
    mkdirSync(join(home, "node_modules"), { recursive: true });
    for (const name of ["playwright", "playwright-core"]) symlinkSync(join(ROOT, "node_modules", name), join(home, "node_modules", name));
    const work = tmp("a6g-work-");
    const pids = join(work, "pids");
    const started = Date.now();
    const ran = await runPlaywright(home, { config: "playwright.config.mjs", env: { PIDS: pids }, timeoutMin: 0.08, work, graceMs: 600 });
    const took = Date.now() - started;
    assert.deepEqual([ran.timedOut, ran.status], [true, null]);
    assert.ok(took < 12_000, `it stopped waiting (${took} ms)`);
    assert.ok(existsSync(pids), "the test got as far as starting them");
    const [deaf, away] = [pids, `${pids}.away`].map((file) => Number(readFileSync(file, "utf8"))) as [number, number];
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const end = (...ids: number[]): void => {
      for (const pid of ids)
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
    };
    try {
      // Ended, though not yet gone the instant the signal is sent.
      for (let i = 0; i < 40 && alive(deaf); i++) await new Promise((wait) => setTimeout(wait, 50));
      assert.ok(!alive(deaf), "the one that ignored the request was ended with its group");
      assert.ok(alive(away), "what left the group is not the suite's to end");
    } finally {
      end(-away, away, deaf);
    }
    // A run that ends by itself isn't kept waiting by what still holds its output.
    const again = Date.now();
    const quick = await runPlaywright(home, { config: "playwright.config.mjs", env: { PIDS: pids, QUICK: "1" }, timeoutMin: 2, work });
    end(-Number(readFileSync(`${pids}.away`, "utf8")));
    assert.deepEqual([quick.timedOut, quick.status, specsOf(quick.report)[0]?.outcome], [false, 0, "skipped"]);
    assert.ok(Date.now() - again < 30_000);
  });
});
