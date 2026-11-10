import { baseTeam, git, makeRepo, ROOT, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { browserProblem } from "../lib/browser.ts";
import { journeyProofFor, namespaceOf, recordSuite, suiteGaps, suiteHistory } from "../lib/commands/e2e.ts";
import { loadTeam, type RawTeam } from "../lib/config.ts";
import { journeysOf, scrub, specsOf } from "../lib/suite.ts";
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
        ["j1.spec.ts › pays [chromium]", "failed", "Expected 2"],
        ["j1.spec.ts › admin › approves", "flaky", ""],
      ]
    );
    assert.deepEqual(journeysOf(specs[0] as never), ["1"]);
    assert.deepEqual(journeysOf(specs[1] as never), ["12"], "@journey-12 is journey 12, not 1");
    assert.deepEqual(specsOf({ suites: [{ title: "a", file: "a", specs: [{ title: "t", tests: [{}] }] }] })[0]?.outcome, "listed");
    assert.equal(scrub("Error: STRIPE_SECRET_KEY=sk_test_123 was refused"), "Error: STRIPE_SECRET_KEY=… was refused");
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
    assert.equal(loaded.harness.journeys, "required", "a team with a scaffolder requires its journeys");
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
});
