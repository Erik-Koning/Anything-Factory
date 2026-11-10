import { baseTeam, commit, makeRepo, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalize, type RawTeam } from "../lib/config.ts";
import {
  fewerTests,
  holdsJourneyTest,
  inTestFolder,
  inTestLane,
  narrowingAdded,
  packageOutside,
  testLaneProblems,
  withoutComments,
} from "../lib/commands/harness.ts";
import { narrowing, pagePlan, parseHarness, readHarness } from "../lib/harness.ts";

const manifest = {
  e2e: { config: "playwright.config.ts" },
  auth: { project: "auth", states: { staff: "e2e/.auth/staff.json" } },
  pages: [
    { id: "home", path: "/" },
    { id: "admin", path: "/admin", as: "staff", mask: ["[data-live]"] },
  ],
  schemes: { dark: { htmlClass: "dark" } },
};

describe("the harness manifest", () => {
  test("holds pages, sign-ins, scheme set-up and where the suite is, and nothing else", () => {
    const { harness, problems } = parseHarness(manifest);
    assert.deepEqual(problems, []);
    assert.deepEqual(harness.e2e, { config: "playwright.config.ts", timeoutMin: 20 });
    assert.deepEqual(harness.auth, { project: "auth", states: { staff: "e2e/.auth/staff.json" } });
    assert.deepEqual(harness.pages[1], { id: "admin", path: "/admin", as: "staff", mask: ["[data-live]"] });
    assert.deepEqual(harness.schemes, { dark: { htmlClass: "dark" } });
  });

  test("refuses what could loosen a check or run a command, and what it can't use", () => {
    const said = (input: unknown) => parseHarness(input).problems.join("\n");
    // A command, the app's address, console rules and the target size aren't the manifest's: they're refused.
    assert.match(said({ ...manifest, e2e: { command: "pnpm exec playwright test --grep-invert @slow" } }), /e2e\.command: not one of config, timeoutMin/);
    assert.match(said({ ...manifest, app: "https://example.com" }), /harness\.json\.app: not one of/);
    assert.match(said({ ...manifest, ignoreConsole: ["."] }), /ignoreConsole: not one of/);
    assert.match(said({ ...manifest, minTarget: 1 }), /minTarget: not one of/);
    assert.match(said({ ...manifest, auth: { command: "sh login.sh", states: { staff: "x.json" } } }), /auth\.command: not one of project, states/);
    assert.match(
      said({ ...manifest, e2e: { config: "../elsewhere/playwright.config.ts" } }),
      /e2e\.config: the Playwright configuration file, a path inside/
    );
    assert.match(said({ ...manifest, pages: [{ id: "x", path: "/x", as: "nobody" }] }), /pages\[0\]\.as: a sign-in state auth\.states names \(staff\)/);
    assert.match(said({ ...manifest, pages: [{ id: "x", path: "x" }] }), /pages\[0\]\.path/);
    assert.match(
      said({
        ...manifest,
        pages: [
          { id: "x", path: "/x" },
          { id: "x", path: "/y" },
        ],
      }),
      /more than one page is named x/
    );
    assert.match(said({ ...manifest, schemes: { dark: {} } }), /schemes\.dark: how the app switches to it/);
    assert.match(said({ ...manifest, schemes: { sepia: { htmlClass: "sepia" } } }), /schemes\.sepia: a colour scheme/);
    assert.match(said({ pages: [], auth: manifest.auth }), /auth: sign-ins are made by a project in e2e\.config/);
  });

  test("a branch that checks less narrows the checks, page by page; one that adds doesn't", () => {
    const before = parseHarness(manifest).harness;
    assert.deepEqual(narrowing(before, parseHarness({ ...manifest, pages: [...manifest.pages, { id: "new", path: "/new" }] }).harness), []);
    assert.deepEqual(narrowing(null, before), [], "a first manifest only adds");
    assert.deepEqual(narrowing(before, parseHarness({ ...manifest, pages: [{ id: "home", path: "/" }] }).harness), ["page admin is no longer checked"]);
    assert.deepEqual(narrowing(before, parseHarness({ ...manifest, pages: [manifest.pages[0], { id: "admin", path: "/admin" }] }).harness), [
      "page admin is seen signed out instead of as staff",
    ]);
    const { e2e: _e2e, auth: _auth, ...withoutSuite } = manifest;
    assert.deepEqual(narrowing(before, parseHarness({ ...withoutSuite, pages: [manifest.pages[0]] }).harness), [
      "page admin is no longer checked",
      "the end-to-end suite is no longer run",
      "the sign-ins are no longer made",
    ]);
    assert.deepEqual(narrowing(before, null).length, 5, "removing the manifest narrows everything it checked");
  });

  test("its pages join the operator's, which keep their ids, settings and the app's address", () => {
    const { team } = normalize(
      {
        ...baseTeam(),
        pages: { appUrl: "http://localhost:9330", minTarget: 44, ignoreConsole: ["favicon"], list: [{ id: "home", path: "/", title: "Home" }] },
      } as RawTeam,
      ""
    );
    const plan = pagePlan(team, parseHarness(manifest).harness);
    assert.deepEqual(
      plan.list.map((page) => [page.id, page.title ?? ""]),
      [
        ["home", "Home"],
        ["admin", ""],
      ]
    );
    assert.deepEqual(plan.fromHarness, ["admin"]);
    assert.equal(plan.appUrl, "http://localhost:9330");
    assert.equal(plan.minTarget, 44);
    assert.deepEqual(plan.ignoreConsole, ["favicon"]);
    assert.deepEqual(plan.schemeSetup, { dark: { htmlClass: "dark" } });
    // Without the operator's pages, the environment's health address is the app, and WCAG's 24 px the target.
    const bare = normalize({ ...baseTeam(), environment: { script: null, health: ["http://localhost:9400/health"] } } as RawTeam, "").team;
    assert.equal(pagePlan(bare, null).appUrl, "http://localhost:9400");
    assert.equal(pagePlan(bare, null).minTarget, 24);
  });

  test("is read from a checkout or a commit, and a broken one says why", () => {
    const home = makeRepo(baseTeam(), { ".a6g/harness.json": manifest });
    assert.equal(readHarness(home).harness?.pages.length, 2);
    const first = commit(home, { ".a6g/harness.json": "{ not json" }, "break it");
    assert.match(readHarness(home).problems.join(""), /\.a6g\/harness\.json: not JSON/);
    assert.equal(readHarness(home, `${first}~1`).harness?.pages.length, 2, "the commit before still has it");
    write(home, { ".a6g/harness.json": { pages: [{ id: "a", path: "/a" }], extra: true } });
    assert.match(readHarness(home).problems.join(""), /\.a6g\/harness\.json harness\.json\.extra: not one of/);
    assert.deepEqual(readHarness(makeRepo()), { harness: null, problems: [] });
  });

  test("what test work may change: test files and folders, the suite's own files, and a package.json by key", () => {
    for (const path of [
      "e2e/home.spec.ts",
      "tests/fixtures/users.ts",
      "src/pay.test.ts",
      "src/__mocks__/stripe.ts",
      "mocks/handlers.ts",
      "playwright.config.ts",
      "tsconfig.e2e.json",
      "apps/web/global-setup.ts",
      ".env.test",
      ".env.e2e.example",
      "scripts/seed.e2e.ts",
      "db/seeds/users.sql",
      ".github/workflows/e2e.yml",
      "pnpm-lock.yaml",
      "apps/web/package.json",
      ".gitignore",
      ".a6g/harness.json",
    ])
      assert.ok(inTestLane(path), path);
    for (const path of [
      "src/app.tsx",
      "apps/web/src/pay.ts",
      ".a6g/team.json",
      "README.md",
      ".env",
      ".env.production",
      "tsconfig.json",
      ".github/workflows/deploy.yml",
      // A folder under an app's routes is a page of the app, whatever it's called.
      "app/test/page.tsx",
      "apps/web/app/(shop)/fixtures/page.tsx",
      "src/pages/e2e/index.astro",
      "src/routes/tests/+page.svelte",
    ])
      assert.ok(!inTestLane(path), path);
    assert.ok(inTestFolder("apps/web/e2e/pages/home.ts"), "a pages folder inside a test folder is the suite's");
    assert.ok(inTestLane("tools/smoke/run.ts", [/^tools\/smoke\//]), "the operator's own patterns add to it");

    const pkg = (value: object): string => JSON.stringify(value);
    const before = pkg({ name: "web", scripts: { build: "next build", test: "vitest" }, dependencies: { next: "15" }, devDependencies: {} });
    assert.deepEqual(
      packageOutside(
        before,
        pkg({
          name: "web",
          scripts: { build: "next build", test: "vitest run", "test:e2e": "playwright test", "db:seed": "tsx seed.ts", pretest: "tsc" },
          dependencies: { next: "15" },
          devDependencies: { "@playwright/test": "1.50.0" },
        })
      ),
      [],
      "test dependencies and test scripts"
    );
    assert.deepEqual(
      packageOutside(
        before,
        pkg({ name: "web", scripts: { build: "true", test: "vitest", postinstall: "node x.js" }, dependencies: { next: "15", leftpad: "1" } })
      ),
      ["scripts.build", "scripts.postinstall", "dependencies"],
      "what the product ships with, builds with or runs on install"
    );
    assert.deepEqual(packageOutside(null, pkg({ devDependencies: { vitest: "3" }, scripts: { test: "vitest" } })), [], "a new one with tests only");
    assert.deepEqual(packageOutside(before, null), ["removed"]);
    assert.deepEqual(packageOutside(before, "{ not json"), ["not JSON"]);
    assert.deepEqual(packageOutside(pkg({ scripts: { contest: "x", attest: "y" } }), pkg({ scripts: { contest: "z", attest: "y" } })), [
      "scripts.contest",
    ]);

    const versions = (path: string) => ({ before, after: path.startsWith("apps/") ? pkg({ name: "web", main: "x.js" }) : before });
    assert.deepEqual(testLaneProblems(["e2e/a.spec.ts", "src/pay.ts", "package.json"], [], versions), ["src/pay.ts"]);
    assert.deepEqual(testLaneProblems(["apps/web/package.json"], [], versions), [
      "apps/web/package.json (scripts.build, dependencies, main: test work changes its devDependencies and test scripts only)",
    ]);
    assert.deepEqual(testLaneProblems(["apps/web/package.json"], [/^apps\/web\/package\.json$/], versions), [], "allowed whole by the operator");
    assert.deepEqual(
      testLaneProblems(["e2e/package.json"], [], () => ({ before: null, after: pkg({ main: "x" }) })),
      [],
      "the suite's own package"
    );
  });

  test("a file holds a journey's test by its text, wherever the tag sits and whatever lines changed", () => {
    const spec = 'import { test } from "./fixtures";\ntest("pays", { tag: "@journey-3" }, async () => {});\n';
    assert.ok(holdsJourneyTest("e2e/pay.spec.ts", spec), "a test by its name");
    assert.ok(holdsJourneyTest("e2e/flows/pay.ts", spec), "in a test folder");
    assert.ok(holdsJourneyTest("src/flows/pay.ts", 'import { test } from "@playwright/test";\ntest("pays @journey-3", async () => {});'), "by its import");
    assert.ok(!holdsJourneyTest("src/pay.ts", "// see @journey-3\nexport const pay = 1;"), "product code that mentions one");
    assert.ok(!holdsJourneyTest("e2e/pay.spec.ts", 'import { test } from "./fixtures";\ntest("pays", async () => {});'), "a test with no journey");
    assert.ok(!holdsJourneyTest("e2e/pay.spec.ts", null), "no such file");
  });

  test("lines that check less: counted net, outside comments, in the suite's files", () => {
    assert.equal(
      withoutComments("const glob = \"**/*.spec.ts\"; // test.only(\n/* test.skip( */ const b = `/* ${a} */`;\nconst c = '//x';"),
      "const glob = \"**/*.spec.ts\"; \n const b = `/* ${a} */`;\nconst c = '//x';"
    );
    const config = 'export default {\n  testMatch: "**/*.spec.ts",\n  retries: 3,\n  /* a note */\n};\n';
    assert.deepEqual(narrowingAdded([{ path: "playwright.config.ts", before: null, after: config }]), [], "a glob, retries and a comment narrow nothing");
    const spec = (body: string): string => `import { test } from "@playwright/test";\n${body}\n`;
    assert.deepEqual(
      narrowingAdded([
        { path: "e2e/a.spec.ts", before: spec('test("a", async () => {});'), after: spec('test.skip("a", async () => {});\n// was test.only("a")') },
        { path: "e2e/b.spec.ts", before: spec('test("b", async () => {});'), after: spec('test("b", async () => {\n  test.fail();\n});') },
        { path: "playwright.config.ts", before: config, after: config.replace("retries: 3", "grepInvert: /@slow/") },
      ]),
      ['e2e/a.spec.ts: test.skip("a", async () => {});', "e2e/b.spec.ts: test.fail();", "playwright.config.ts: grepInvert: /@slow/,"]
    );
    const skipped = spec('test.skip("old", async () => {});\ntest.fixme("later", async () => {});');
    assert.deepEqual(
      narrowingAdded([
        { path: "e2e/old.spec.ts", before: skipped, after: null },
        { path: "e2e/flows/new.spec.ts", before: null, after: skipped },
      ]),
      [],
      "a file that moved adds nothing"
    );
    assert.deepEqual(
      narrowingAdded([{ path: "e2e/a.spec.ts", before: skipped, after: `${skipped}test.skip("old", async () => {});\n` }]),
      ['e2e/a.spec.ts: test.skip("old", async () => {});'],
      "the same line once more is one more"
    );
    assert.deepEqual(fewerTests({ total: 10, byJourney: { "1": 3, "2": 1 } }, { total: 10, byJourney: { "1": 3, "2": 1 } }), []);
    assert.deepEqual(fewerTests({ total: 10, byJourney: { "1": 3, "2": 1 } }, { total: 9, byJourney: { "1": 3 } }), [
      "the suite runs 9 tests, 1 fewer than before",
      "journey 2 has 0 tests that run, not 1",
    ]);
  });
});
