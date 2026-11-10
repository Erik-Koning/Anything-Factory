import { baseTeam, makeRepo, ROOT, tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { browserProblem } from "../lib/browser.ts";
import { loadTeam, type RawTeam } from "../lib/config.ts";
import { stateDir } from "../lib/paths.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask } from "../lib/tasks/model.ts";
import { fileGaps, othersQueued, pendingDir, verifyAfterMerge } from "../lib/verify.ts";
import { writeJson } from "../lib/util.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir, "Library", "Caches", "ms-playwright");
const noBrowser = browserProblem();
const roles = { planner: {}, builder: {}, reviewer: {}, scaffolder: {} };

describe("the check after merges", () => {
  test("waits for the last merge of a burst: one queued behind it runs the check", async () => {
    const home = makeRepo(baseTeam({ board: "tasks", roles }));
    const state = stateDir(home);
    mkdirSync(pendingDir(state), { recursive: true });
    writeJson(join(pendingDir(state), "a6g_b2-next.json"), { pid: process.pid, at: "" });
    assert.ok(othersQueued(state, "a6g_b1-first"));
    assert.ok(!othersQueued(state, "a6g_b2-next"), "a merge doesn't wait for itself");
    writeJson(join(pendingDir(state), "a6g_b3-gone.json"), { pid: 999_999_999, at: "" });
    await verifyAfterMerge(home, loadTeam(home), tmp("a6g-run-"), "a6g/b1-first", { wake: () => assert.fail("nothing ran") });
    assert.ok(existsSync(join(state, "verify-due.json")), "the check is left due, for the merge behind it");
    assert.ok(!existsSync(join(state, "verify.log")));
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
  let server: Server;
  let url = "";
  before(async () => {
    server = createServer((request, response) => {
      const ok = request.url === "/";
      response.writeHead(ok ? 200 : 500, { "content-type": "text/html" });
      response.end(`<!doctype html><html lang=en><title>t</title><main><h1>${ok ? "Fine" : "Broken"}</h1></main>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  after(() => server.close());

  test("checks pages and the suite at the head, files what fails and the journeys without specs once, and wakes the planner", async () => {
    const home = makeRepo({ ...baseTeam({ board: "tasks", roles }), pages: { appUrl: url, schemes: ["light"] } } as RawTeam, {
      ".a6g/harness.json": {
        e2e: { config: "playwright.config.mjs", timeoutMin: 3 },
        pages: [
          { id: "home", path: "/" },
          { id: "broken", path: "/broken" },
        ],
      },
      "playwright.config.mjs": "export default { testDir: 'e2e', use: { baseURL: process.env.PLAYWRIGHT_BASE_URL }, workers: 1 };\n",
      "e2e/journeys.spec.mjs": [
        'import { test, expect } from "playwright/test";',
        'test("sees a total", { tag: "@journey-1" }, async ({ page }) => { await page.goto("/"); await expect(page.getByText("Total")).toBeVisible({ timeout: 300 }); });',
        "",
      ].join("\n"),
      ".gitignore": "node_modules\n",
    });
    mkdirSync(join(home, "node_modules"), { recursive: true });
    for (const name of ["playwright", "playwright-core"]) symlinkSync(join(ROOT, "node_modules", name), join(home, "node_modules", name));
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    for (const title of ["Pay a need", "Follow an order"])
      await store.tasks.create(newTask({ team: "fixture", title, kind: "journey", status: "approved", by: "planner" }));
    const team = loadTeam(home);
    const woken: string[] = [];
    await verifyAfterMerge(home, team, run, "a6g/b3-pay", { wake: (text) => woken.push(text) });

    const filed = (await store.tasks.all()).filter((t) => t.by === "merge-queue");
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
    assert.match(readFileSync(join(stateDir(home), "verify.log"), "utf8"), /pages 1\/2 pass/);
    assert.ok(!existsSync(join(stateDir(home), "verify-due.json")), "nothing left due");

    // The same failures after the next merge are the same findings: nothing new, and the planner isn't woken again.
    await verifyAfterMerge(home, team, run, "a6g/b4-more", { wake: (text) => woken.push(text) });
    assert.equal((await store.tasks.all()).filter((t) => t.by === "merge-queue").length, 3);
    assert.equal(woken.length, 1);
  });
});
