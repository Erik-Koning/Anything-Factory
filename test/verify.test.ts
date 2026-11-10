import { baseTeam, commit, git, makeRepo, ROOT, tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { browserProblem } from "../lib/browser.ts";
import { loadTeam, type RawTeam } from "../lib/config.ts";
import { acquire, startOf } from "../lib/lock.ts";
import { stateDir } from "../lib/paths.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask, type Task } from "../lib/tasks/model.ts";
import { update } from "../lib/tasks/store.ts";
import { checkDue, checksLess, clearQueued, fileGaps, markQueued, othersQueued, pendingDir, verifyAfterMerge } from "../lib/verify.ts";
import { readJson, writeJson } from "../lib/util.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir, "Library", "Caches", "ms-playwright");
const noBrowser = browserProblem();
const roles = { planner: {}, builder: {}, reviewer: {}, scaffolder: {} };
// A team with nothing the check files a gap for.
const plain = { planner: {}, builder: {}, reviewer: {} };
const logOf = (home: string): string => readFileSync(join(stateDir(home), "verify.log"), "utf8");
const filedBy = async (store: ReturnType<typeof fileStore>): Promise<Task[]> => (await store.tasks.all()).filter((t) => t.by === "merge-queue");
const reject = (store: ReturnType<typeof fileStore>, id: string): Promise<Task> => update(store.tasks, id, (t) => ({ ...t, status: "rejected" as const }));

// A server whose answer a test changes: what a page serves, and whether the app is up (503 is down, to a health check).
function app(): { start: () => Promise<string>; stop: () => void; serve: Record<string, () => [number, string]> } {
  const serve: Record<string, () => [number, string]> = {};
  const page = (body: string): string => `<!doctype html><html lang=en><title>t</title><main><h1>${body}</h1></main>`;
  const server: Server = createServer((request, response) => {
    const [status, body] = serve[request.url ?? ""]?.() ?? serve["*"]?.() ?? [200, "Fine"];
    response.writeHead(status, { "content-type": "text/html" });
    response.end(page(body));
  });
  return {
    serve,
    stop: () => void server.close(),
    start: async () => {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    },
  };
}

describe("the check after merges", () => {
  test("a queued merge is a mark naming a live process and when it started; anything else is swept", async () => {
    const home = makeRepo(baseTeam({ board: "tasks", roles }));
    const state = stateDir(home);
    const mark = (name: string): string => join(pendingDir(state), `${name}.json`);
    const marks = (): string[] => readdirSync(pendingDir(state)).sort();
    const other = spawn("sleep", ["60"], { stdio: "ignore" });
    const gone = new Promise((done) => other.on("exit", done));
    const pid = other.pid ?? 0;
    try {
      assert.ok(pid);
      markQueued(mark("a6g_b1-own"), process.pid);
      assert.ok(!othersQueued(state), "a merge doesn't wait for itself");
      markQueued(mark("a6g_b2-next"), pid);
      assert.equal(readJson<{ started?: string }>(mark("a6g_b2-next"), {}).started, startOf(pid), "it carries when the process started, as a lock does");
      assert.ok(othersQueued(state));
      await verifyAfterMerge(home, loadTeam(home), tmp("a6g-run-"), "a6g/b1-own", { wake: () => assert.fail("nothing ran") });
      assert.equal(checkDue(home)?.after, "a6g/b1-own", "the check is left due, for the merge behind it");
      assert.ok(!existsSync(join(state, "verify.log")));

      // A run clears its own mark, never another's.
      clearQueued(mark("a6g_b2-next"));
      assert.ok(existsSync(mark("a6g_b2-next")));
      clearQueued(mark("a6g_b2-next"), pid);
      assert.deepEqual(marks(), ["a6g_b1-own.json"]);

      // Nobody's: a pid the machine handed to something else, a process that's gone, a mark with no start time that's
      // older than any merge. None is a merge still queued, and each is cleared on the way.
      const now = new Date().toISOString();
      writeJson(mark("a6g_b3-reused"), { pid, started: "Mon Jan  1 00:00:00 2001", at: now });
      writeJson(mark("a6g_b4-gone"), { pid: 999_999_999, started: null, at: now });
      writeJson(mark("a6g_b5-old"), { pid, at: new Date(Date.now() - 7 * 3_600_000).toISOString() });
      writeFileSync(mark("a6g_b6-torn"), "{");
      assert.ok(!othersQueued(state));
      assert.deepEqual(marks(), ["a6g_b1-own.json", "a6g_b6-torn.json"]);
      // With no start time to compare, a live process is all there is to go on.
      writeJson(mark("a6g_b7-bare"), { pid, at: now });
      assert.ok(othersQueued(state));
    } finally {
      other.kill("SIGKILL");
    }
    await gone;
    assert.ok(!othersQueued(state), "its process ended");
    assert.deepEqual(marks(), ["a6g_b1-own.json", "a6g_b6-torn.json"]);
  });

  test("a merge that didn't land runs the check a landed one left due, and marks none of its own", async () => {
    const home = makeRepo(baseTeam({ board: "tasks", roles: plain }));
    const [team, run, state] = [loadTeam(home), tmp("a6g-run-"), stateDir(home)];
    const wake = (): void => assert.fail("nothing new to say");
    await verifyAfterMerge(home, team, run, "a6g/b1-refused", { wake, merged: false });
    assert.ok(!existsSync(join(state, "verify.log")), "nothing due, so nothing ran");
    assert.equal(checkDue(home), null);

    writeJson(join(state, "verify-due.json"), { at: new Date().toISOString(), after: "a6g/b0-landed" });
    await verifyAfterMerge(home, team, run, "a6g/b1-refused", { wake, merged: false });
    assert.match(logOf(home), /^\S+ \S+ [0-9a-f]{9} nothing to check\n$|[0-9a-f]{9} nothing to check\n$/);
    assert.equal(checkDue(home), null);
    assert.equal(readJson<{ commit?: string }>(join(state, "verify-last.json"), {}).commit, git(home, "rev-parse", "HEAD"));
  });

  test("a check that can't take the merge lock says so and stays due, for the next merge however it ends", async () => {
    const home = makeRepo(baseTeam({ board: "tasks", roles: plain }));
    const [team, run] = [loadTeam(home), tmp("a6g-run-")];
    const woken: string[] = [];
    const held = await acquire(home, "merge", { slots: 1, waitMin: 1, holder: "a merge that hangs" });
    assert.ok(held);
    try {
      await verifyAfterMerge(home, team, run, "a6g/b1-first", { wake: (text) => woken.push(text), lockWaitMin: 0 });
    } finally {
      held();
    }
    assert.deepEqual(woken, ["verify: the merge lock stayed busy for 0 minutes, so the check after merges didn't run; the next merge runs it"]);
    assert.equal(checkDue(home)?.after, "a6g/b1-first");
    assert.match(logOf(home), /- the check didn't run: the merge lock stayed busy for 0 minutes; it's still due\n$/);

    await verifyAfterMerge(home, team, run, "a6g/b2-conflicts", { wake: (text) => woken.push(text), merged: false });
    assert.equal(checkDue(home), null);
    assert.match(logOf(home), /[0-9a-f]{9} nothing to check\n$/);
    assert.equal(woken.length, 1);
  });

  test("an app that's down is one finding: nothing else is checked, the check stays due, and a rejection quiets that failure only", async () => {
    const { start, stop, serve } = app();
    const url = await start();
    try {
      const home = makeRepo({ ...baseTeam({ board: "tasks", roles }), environment: { health: [`${url}/`] } } as RawTeam);
      const [team, run, state] = [loadTeam(home), tmp("a6g-run-"), stateDir(home)];
      const store = fileStore(run, "fixture");
      const woken: string[] = [];
      const check = (branch: string, merged = true): Promise<void> =>
        verifyAfterMerge(home, team, run, branch, { wake: (text) => woken.push(text), merged, healthWaitMs: 1 });

      serve["*"] = () => [503, "Starting"];
      await check("a6g/b1-breaks");
      let filed = await filedBy(store);
      assert.deepEqual(
        filed.map((t) => [t.id, t.title, t.kind, t.severity, t.status]),
        [["1", "The app is down after merges", "bug", "blocker", "triage"]],
        "the one finding: no gap is filed, no page or suite looked at"
      );
      assert.match(filed[0]?.body ?? "", /the team's app doesn't answer: http:\/\/127\.0\.0\.1:\d+\/ doesn't answer\. Nothing else was checked/);
      assert.equal(woken.length, 1);
      assert.match(
        woken[0] ?? "",
        /^verify: at [0-9a-f]{9}, the app is down after merges \(\S+ doesn't answer\), so nothing was checked\. New finding in triage: #1\.$/
      );
      assert.equal(checkDue(home)?.after, "a6g/b1-breaks", "still due");
      assert.ok(!existsSync(join(state, "verify-last.json")), "nothing was checked at this commit");

      // Still down at the next merge, and after the planner rejected it: the same failure, so nothing new.
      await check("a6g/b2-refused", false);
      await reject(store, "1");
      await check("a6g/b3-more");
      assert.equal((await filedBy(store)).length, 1);
      assert.equal(woken.length, 1);
      assert.ok(checkDue(home));

      // Up: the check that was due runs (and files the gap it couldn't look for before).
      delete serve["*"];
      await check("a6g/b4-refused", false);
      filed = await filedBy(store);
      assert.deepEqual(
        filed.map((t) => t.title),
        ["The app is down after merges", "Set up the browser test harness"]
      );
      assert.equal(checkDue(home), null);
      assert.equal(woken.length, 2);

      // Down again after it was up: the same failure after a pass is filed again.
      serve["*"] = () => [503, "Starting"];
      await check("a6g/b5-breaks-again");
      filed = await filedBy(store);
      assert.deepEqual(
        filed.map((t) => [t.title, t.status]),
        [
          ["The app is down after merges", "rejected"],
          ["Set up the browser test harness", "triage"],
          ["The app is down after merges", "triage"],
        ]
      );
      assert.equal(woken.length, 3);
    } finally {
      stop();
    }
  });

  test("checking less is fewer tests that check, or more told to skip or to fail", () => {
    const spec = (id: string, outcome: "passed" | "failed" | "skipped" | "excused" | "unreached", tags = ["@journey-1"]) => ({ id, tags, outcome });
    const was = { specs: [spec("a", "passed"), spec("b", "failed"), spec("c", "passed", [])] };
    assert.deepEqual(checksLess(was, was), { found: [], tests: [] });
    // A test an earlier failure kept the run from reaching still checks: its failure is the finding, not this.
    assert.deepEqual(checksLess(was, { specs: [spec("a", "failed"), spec("b", "unreached"), spec("c", "unreached", [])] }).found, []);
    assert.deepEqual(checksLess(was, { specs: [...was.specs, spec("d", "passed")] }).found, []);

    const skipped = checksLess(was, { specs: [spec("a", "passed"), spec("b", "skipped"), spec("c", "passed", [])] });
    assert.deepEqual(skipped.found, [
      "the suite runs 2 tests, 1 fewer than before",
      "journey 1 has 1 tests that run, not 2",
      "1 test is told to skip or to fail, 1 more than before",
    ]);
    assert.deepEqual(skipped.tests, ["now skipped: b"]);

    const gutted = checksLess(was, { specs: [spec("a", "excused"), spec("c", "passed", []), spec("e", "skipped", [])] });
    assert.deepEqual(gutted.tests, ["now expected to fail: a", "gone: b", "new, and skipped: e"]);
    // As many tests as before, one of them new and told to skip: the count alone would miss it.
    const swapped = checksLess(was, { specs: [...was.specs, spec("f", "skipped", [])] });
    assert.deepEqual(swapped.found, ["1 test is told to skip or to fail, 1 more than before"]);
    assert.deepEqual(swapped.tests, ["new, and skipped: f"]);
  });

  test("files the gap of a team with a scaffolder and no harness, once, and a flaky test for the scaffolder", async () => {
    const home = makeRepo(baseTeam({ board: "tasks", roles }));
    const team = loadTeam(home);
    const store = fileStore(tmp("a6g-run-"), "fixture");
    const first = await fileGaps(store, team, home, null);
    assert.equal(first.length, 1);
    assert.equal((await store.tasks.get(first[0] ?? ""))?.title, "Set up the browser test harness");
    assert.equal((await store.tasks.get(first[0] ?? ""))?.status, "triage");
    assert.equal((await store.tasks.get(first[0] ?? ""))?.by, "merge-queue");
    assert.deepEqual(await fileGaps(store, team, home, null), [], "not again while it's open");
  });
});

describe("the check after merges, in a real browser", { skip: noBrowser ?? false }, () => {
  const { start, stop, serve } = app();
  let url = "";
  before(async () => {
    url = await start();
  });
  after(stop);
  const withPlaywright = (home: string): void => {
    mkdirSync(join(home, "node_modules"), { recursive: true });
    for (const name of ["playwright", "playwright-core"]) symlinkSync(join(ROOT, "node_modules", name), join(home, "node_modules", name));
  };
  const config = "export default { testDir: 'e2e', use: { baseURL: process.env.PLAYWRIGHT_BASE_URL }, workers: 1 };\n";
  // One viewport and a short settle: each check is quick.
  const pages = (): RawTeam["pages"] => ({ appUrl: url, schemes: ["light"], settleMs: 50, viewports: [{ id: "desktop", width: 1024, height: 768 }] });

  test("checks pages and the suite at the head, files what fails and the journeys without specs once, and wakes the planner", async () => {
    serve["/broken"] = () => [500, "Broken"];
    const home = makeRepo({ ...baseTeam({ board: "tasks", roles }), pages: pages() } as RawTeam, {
      ".a6g/harness.json": {
        e2e: { config: "playwright.config.mjs", timeoutMin: 3 },
        pages: [
          { id: "home", path: "/" },
          { id: "broken", path: "/broken" },
        ],
      },
      "playwright.config.mjs": config,
      "e2e/journeys.spec.mjs": [
        'import { test, expect } from "playwright/test";',
        'test("sees a total", { tag: "@journey-1" }, async ({ page }) => { await page.goto("/"); await expect(page.getByText("Total")).toBeVisible({ timeout: 300 }); });',
        "",
      ].join("\n"),
      ".gitignore": "node_modules\n",
    });
    withPlaywright(home);
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    for (const title of ["Pay a need", "Follow an order"])
      await store.tasks.create(newTask({ team: "fixture", title, kind: "journey", status: "approved", by: "planner" }));
    const team = loadTeam(home);
    const woken: string[] = [];
    const check = (branch: string): Promise<void> => verifyAfterMerge(home, team, run, branch, { wake: (text) => woken.push(text) });
    await check("a6g/b3-pay");

    const filed = await filedBy(store);
    assert.deepEqual(
      filed.map((t) => [t.title, t.kind, t.severity, t.status]).sort(),
      [
        ["Journey 2 has no end-to-end spec", "test", "major", "triage"],
        ["Page broken fails its checks after merges", "bug", "major", "triage"],
        ["e2e/journeys.spec.mjs: 1 test fails after merges", "bug", "major", "triage"],
      ].sort()
    );
    const spec = filed.find((t) => t.title.startsWith("e2e/"));
    assert.match(spec?.body ?? "", /sees a total: .*Total/);
    assert.match(spec?.body ?? "", /Journeys it proves: #1/);
    assert.equal(woken.length, 1);
    assert.match(woken[0] ?? "", /verify: at [0-9a-f]{9}, pages 1\/2 pass; the suite 0 passed, 1 failed\. New findings in triage: #3, #4, #5\./);
    assert.match(logOf(home), /pages 1\/2 pass; the suite 0 passed, 1 failed; filed #3, #4, #5\n$/);
    assert.equal(checkDue(home), null, "nothing left due");

    // The same failures after the next merge are the same findings: nothing new, and the planner isn't woken again.
    await check("a6g/b4-more");
    assert.equal((await filedBy(store)).length, 3);
    assert.equal(woken.length, 1);

    // The planner rejects the page's finding. The same failure stays quiet...
    const page = filed.find((t) => t.title.startsWith("Page broken"));
    assert.ok(page);
    await reject(store, page.id);
    await check("a6g/b5-more");
    assert.equal((await filedBy(store)).length, 3);
    assert.equal(woken.length, 1);
    // ...and a different one on the same page is a new finding: the rejection wasn't of the page.
    serve["/broken"] = () => [200, "Loads<script>throw new Error('boom')</script>"];
    await check("a6g/b6-other");
    const again = (await filedBy(store)).filter((t) => t.title.startsWith("Page broken"));
    assert.deepEqual(
      again.map((t) => t.status),
      ["rejected", "triage"]
    );
    assert.match(again[1]?.body ?? "", /errors: .*boom/);
    assert.doesNotMatch(again[1]?.body ?? "", /HTTP 500/);
    assert.equal(woken.length, 2);
    assert.match(woken[1] ?? "", /New findings in triage: #6\./);

    // Rejected too, then fixed, then broken the same way: the same failure after a pass is filed again.
    await reject(store, again[1]?.id ?? "");
    delete serve["/broken"];
    await check("a6g/b8-fixed");
    assert.match(logOf(home), /pages 2\/2 pass; the suite 0 passed, 1 failed\n$/);
    serve["/broken"] = () => [200, "Loads<script>throw new Error('boom')</script>"];
    await check("a6g/b9-back");
    assert.deepEqual(
      (await filedBy(store)).filter((t) => t.title.startsWith("Page broken")).map((t) => t.status),
      ["rejected", "rejected", "triage"]
    );
    assert.equal(woken.length, 3);
  });

  test("a suite that didn't run is one finding with what it said, and proves nothing: no gap is filed from it", async () => {
    const home = makeRepo({ ...baseTeam({ board: "tasks", roles }), pages: pages() } as RawTeam, {
      ".a6g/harness.json": { e2e: { config: "playwright.config.mjs", timeoutMin: 3 } },
      "playwright.config.mjs": "throw new Error('the set-up is broken');\n",
      "e2e/journeys.spec.mjs": 'import { test } from "playwright/test";\ntest("walks", { tag: "@journey-1" }, async () => {});\n',
      ".gitignore": "node_modules\n",
    });
    withPlaywright(home);
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    await store.tasks.create(newTask({ team: "fixture", title: "Pay a need", kind: "journey", status: "approved", by: "planner" }));
    await store.tasks.create(newTask({ team: "fixture", title: "Follow an order", kind: "journey", status: "approved", by: "planner" }));
    const team = loadTeam(home);
    const woken: string[] = [];
    await verifyAfterMerge(home, team, run, "a6g/b3-breaks", { wake: (text) => woken.push(text) });
    const filed = await filedBy(store);
    assert.deepEqual(
      filed.map((t) => [t.title, t.kind, t.severity]),
      [["The end-to-end suite didn't run after merges", "test-infra", "major"]],
      "journey 2 has no spec, and a run that didn't run can't say so"
    );
    assert.match(
      filed[0]?.body ?? "",
      /the suite didn't run, so it proves nothing and no journey closes on it:\n- no report: Error: the set-up is broken\n/
    );
    assert.match(woken[0] ?? "", /^verify: at [0-9a-f]{9}, the suite didn't run: no report: Error: the set-up is broken\. New findings in triage: #3\.$/);
    assert.equal(checkDue(home), null, "it looked: what it found is the finding");

    await verifyAfterMerge(home, team, run, "a6g/b4-more", { wake: (text) => woken.push(text) });
    assert.equal((await filedBy(store)).length, 1);
    assert.equal(woken.length, 1);
  });

  test("closes the journeys whose tests now pass, and files a suite that checks less unless the operator allowed the commit", async () => {
    const suite = (...skip: string[]): string =>
      [
        'import { test, expect } from "playwright/test";',
        ...["opens", "pays", "sees a receipt"].map(
          (title) =>
            `test${skip.includes(title) ? ".skip" : ""}(${JSON.stringify(title)}, { tag: "@journey-1" }, async ({ page }) => { await page.goto("/"); await expect(page.getByText("Fine")).toBeVisible(); });`
        ),
        "",
      ].join("\n");
    const home = makeRepo({ ...baseTeam({ board: "tasks", roles }), pages: pages() } as RawTeam, {
      ".a6g/harness.json": { e2e: { config: "playwright.config.mjs", timeoutMin: 3 } },
      "playwright.config.mjs": config,
      "e2e/journeys.spec.mjs": suite(),
      ".gitignore": "node_modules\n",
    });
    withPlaywright(home);
    const [run, state] = [tmp("a6g-run-"), stateDir(home)];
    const store = fileStore(run, "fixture");
    // Journey 1 waits on its one task, which merged.
    await store.tasks.create(newTask({ team: "fixture", title: "Pay a need", kind: "journey", status: "approved", by: "planner" }));
    await store.tasks.create(
      newTask({ team: "fixture", title: "The pay form", kind: "feature", status: "done", by: "planner", parent: "1", sha: git(home, "rev-parse", "HEAD") })
    );
    await update(store.tasks, "1", (t) => ({
      ...t,
      status: "blocked" as const,
      wait: { on: ["2"], then: "close" as const, by: "planner", at: new Date().toISOString() },
    }));
    const team = loadTeam(home);
    const woken: string[] = [];
    const check = (branch: string): Promise<void> => verifyAfterMerge(home, team, run, branch, { wake: (text) => woken.push(text) });

    await check("a6g/b2-pay-form");
    assert.equal((await store.tasks.get("1"))?.status, "done", "its tests passed in the run that holds its merges");
    assert.deepEqual(await filedBy(store), []);
    assert.match(woken[0] ?? "", /^verify: at [0-9a-f]{9}, the suite 3 passed, 0 failed\. Closed, their tests pass: #1\.$/);
    assert.match(logOf(home), /the suite 3 passed, 0 failed; closed #1\n$/);
    const first = git(home, "rev-parse", "HEAD");

    // A merge that skips one of them: every test still passes, and the suite checks less.
    commit(home, { "e2e/journeys.spec.mjs": suite("pays") }, "Merge a6g/b3-faster");
    await check("a6g/b3-faster");
    const less = await filedBy(store);
    assert.deepEqual(
      less.map((t) => [t.title, t.kind, t.severity, t.status]),
      [["The suite checks less after merges", "test", "major", "triage"]]
    );
    assert.match(
      less[0]?.body ?? "",
      new RegExp(
        `checks less than it did at ${first.slice(0, 9)}: the suite runs 2 tests, 1 fewer than before; journey 1 has 2 tests that run, not 3; 1 test is told`
      )
    );
    assert.match(less[0]?.body ?? "", /- now skipped: e2e\/journeys\.spec\.mjs › pays/);
    assert.match(woken[1] ?? "", /the suite 2 passed, 0 failed, 1 skipped; the suite checks less: .*New findings in triage: #3\./);

    // The same suite at the next merge checks no less than the check before it did.
    commit(home, { "src/app.ts": "export const a = 2;\n" }, "Merge a6g/b4-other");
    await check("a6g/b4-other");
    assert.equal((await filedBy(store)).length, 1);
    assert.equal(woken.length, 2);

    // A commit the operator allowed to check less is a line in the log, not a finding.
    const allowedSha = commit(home, { "e2e/journeys.spec.mjs": suite("pays", "sees a receipt") }, "Merge a6g/b5-no-receipts");
    writeJson(join(state, "harness-allow", "a6g_b5-no-receipts.json"), {
      branch: "a6g/b5-no-receipts",
      sha: allowedSha,
      why: "receipts are gone",
      at: new Date().toISOString(),
    });
    await check("a6g/b5-no-receipts");
    assert.equal((await filedBy(store)).length, 1);
    assert.equal(woken.length, 2);
    assert.match(
      logOf(home),
      new RegExp(`the suite checks less, as the operator allowed for a6g/b5-no-receipts at ${allowedSha.slice(0, 9)} \\(receipts are gone\\)\\n$`)
    );
  });
});
