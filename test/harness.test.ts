import { baseTeam, commit, makeRepo, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalize, type RawTeam } from "../lib/config.ts";
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
});
