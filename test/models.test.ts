// Which model each role runs on: team.json's settings and the defaults (lib/models.ts), the planner's table, the
// guard's check on a member's start, and what register and the watchdog start threads with.
import { baseTeam, guard, holds, makeRepo, tmp, tool, write } from "./helpers.ts";
import { fakeWorld } from "./fake-t3.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam, modelsOf, normalize, type RawTeam } from "../lib/config.ts";
import {
  defaultModel,
  fallbackModel,
  familyOf,
  MODEL_ALIASES,
  modelId,
  modelName,
  modelTitle,
  newerThan,
  newerThanShortNames,
  onShortName,
  versionOf,
} from "../lib/models.ts";
import { priced, PRICES } from "../lib/prices.ts";
import { modelNotices } from "../lib/subscriptions.ts";
import { compile } from "../lib/prompts.ts";
import { newTask } from "../lib/tasks/model.ts";
import { fileStore } from "../lib/tasks/files.ts";

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const every = {
  planner: {},
  builder: {},
  tester: { write: ["^e2e/"] },
  scaffolder: {},
  reviewer: {},
  "security-reviewer": {},
  "ux-specialist": {},
  innovator: {},
  approver: {},
};
const norm = (raw: Record<string, unknown>) => normalize({ name: "fixture", branch: "a6g/next", ...raw } as RawTeam, "");
const delegate = "mcp__t3-code__delegate_task";
const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

describe("a role's model", () => {
  test("left out: Fable for the roles that decide what gets built and on what, Opus for those that build and check it", () => {
    const { team, problems, warnings } = norm({ roles: every });
    assert.deepEqual(problems, []);
    assert.deepEqual(modelsOf(team), {
      planner: FABLE,
      builder: OPUS,
      tester: OPUS,
      scaffolder: FABLE,
      reviewer: OPUS,
      "security-reviewer": OPUS,
      "ux-specialist": OPUS,
      innovator: FABLE,
      approver: OPUS,
    });
    assert.ok(!warnings.some((warning) => warning.startsWith("model")), warnings.join("\n"));
    // Every short name is a model this version can price, so a default never escapes a budget.
    for (const [alias, id] of Object.entries(MODEL_ALIASES)) assert.ok(priced(id), alias);
    assert.equal(defaultModel("a-role-of-tomorrow"), OPUS);
  });

  test("the team's model is every role's that names none; a role's own wins; a short name is the family's newest", () => {
    // A team.json written before roles had models keeps every role on the one it named.
    assert.deepEqual([...new Set(Object.values(modelsOf(norm({ roles: every, model: OPUS }).team)))], [OPUS]);
    const { team, problems } = norm({ model: "sonnet", roles: { planner: { model: "Fable" }, builder: {}, reviewer: { model: "claude-opus-5" } } });
    assert.deepEqual(problems, []);
    assert.deepEqual(modelsOf(team), { planner: FABLE, builder: "claude-sonnet-5-5", reviewer: "claude-opus-5" });
    assert.equal(modelId("OPUS"), OPUS);
    assert.equal(modelId("claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
    assert.equal(modelId("constructor"), "constructor", "own names only");
  });

  test("a value that isn't a model is a problem, and the role keeps one it can start on", () => {
    for (const bad of ["", "two words", "`x`\n| row |", 5, null, "-leading", "x".repeat(101)]) {
      const role = norm({ roles: { planner: {}, builder: { model: bad } } });
      assert.match(role.problems.join("\n"), /^roles\.builder\.model: a model: fable, opus, sonnet, haiku, or a model id such as claude-opus-5-5$/m);
      assert.equal(role.team.roles["builder"]?.model, OPUS);
      const whole = norm({ model: bad });
      assert.match(whole.problems.join("\n"), /^model: a model: /m, String(bad));
      assert.equal(whole.team.roles["planner"]?.model, FABLE);
    }
  });

  test("a model this version has no price for runs, with a warning that a budget can't count it", () => {
    const { problems, warnings, team } = norm({ roles: { planner: {}, builder: { model: "claude-opus-9" }, reviewer: { model: "claude-opus-9" } } });
    assert.deepEqual(problems, []);
    assert.equal(team.roles["builder"]?.model, "claude-opus-9");
    assert.deepEqual(
      warnings.filter((warning) => warning.startsWith("model")),
      [
        "model: this version has no price for claude-opus-9 (the builder, reviewer), so a6g usage and a budget can't count what it spends; check the id, or upgrade the factory",
      ]
    );
  });

  test("the planner's table gives each member's model, and says where it goes", () => {
    const home = makeRepo(baseTeam({ roles: { planner: {}, builder: { limit: 2 }, scaffolder: {}, reviewer: { model: "sonnet" } } }));
    const planner = compile(loadTeam(home), "planner");
    assert.match(planner, /from this table `target\.providerInstanceId`, `target\.model` and the top-level `isolation`/);
    assert.match(planner, /\| Role \| providerInstanceId \| model \| isolation \| At most \| Does \|/);
    assert.match(planner, /\| builder \| `a6g-fixture-builder` \| `"claude-opus-5-5"` \| `"worktree"` \| 2 \|/);
    assert.match(planner, /\| scaffolder \| `a6g-fixture-scaffolder` \| `"claude-fable-5-2"` \| `"worktree"` \| 1 \|/);
    assert.match(planner, /\| reviewer \| `a6g-fixture-reviewer` \| `"claude-sonnet-5-5"` \| `"shared"` \| 1 \|/);
    assert.doesNotMatch(compile(loadTeam(home), "builder"), /target\.model/);
  });

  test("the guard starts a member only on its role's model, given where T3 Code reads it", async () => {
    const home = makeRepo(baseTeam({ roles: { planner: {}, builder: { limit: 2 }, scaffolder: {}, reviewer: { model: "sonnet" } } }));
    const builder = (target: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      target: { providerInstanceId: "a6g-fixture-builder", ...target },
      isolation: "worktree",
      ...extra,
    });
    await holds([
      tool(home, "planner", delegate, builder({ model: OPUS }), "allow"),
      tool(home, "planner", delegate, builder({ model: FABLE }), "refuse"),
      tool(home, "planner", delegate, builder({ model: "opus" }), "refuse"),
      tool(home, "planner", delegate, builder({}), "refuse"),
      // T3 Code ignores a model beside the target, and the member would run on the instance's first.
      tool(home, "planner", delegate, builder({}, { model: OPUS }), "refuse"),
      tool(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-scaffolder", model: FABLE }, isolation: "worktree" }, "allow"),
      tool(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-scaffolder", model: OPUS }, isolation: "worktree" }, "refuse"),
      tool(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-reviewer", model: "claude-sonnet-5-5" } }, "allow"),
      tool(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-reviewer", model: OPUS } }, "refuse"),
    ]);
  });

  test("a model's family, and the model a role on it runs on while its family's own limit is used up", () => {
    assert.deepEqual([FABLE, "Fable", "claude-fable-5-2[1m]", OPUS, "claude-sonnet-5-5", "fabled", "m"].map(familyOf), [
      "fable",
      "fable",
      "fable",
      "opus",
      "sonnet",
      null,
      null,
    ]);
    assert.equal(fallbackModel(FABLE), OPUS);
    assert.equal(fallbackModel("claude-fable-5-2[1m]"), OPUS);
    // Only Fable falls back: a role that names another model keeps it.
    assert.deepEqual([OPUS, "claude-sonnet-5-5", "m"].map(fallbackModel), [null, null, null]);
    assert.deepEqual([OPUS, FABLE, "claude-opus-5"].map(modelName), ["Opus", "Fable", "claude-opus-5"]);
  });

  test("while the subscription a role runs on has used up Fable's own limit, the guard starts it on Opus", async () => {
    const home = makeRepo(baseTeam({ roles: { planner: {}, builder: { limit: 2 }, scaffolder: {}, reviewer: { model: "sonnet" } } }));
    const run = tmp("a6g-run-");
    const steering = (until: string) =>
      write(run, {
        "subscription.json": {
          roles: { planner: "default", builder: "default", scaffolder: "default", reviewer: "default" },
          moving: {},
          waiting: {},
          models: { scaffolder: { from: FABLE, model: OPUS, subscription: "default", until, why: "default's Fable limit is used up" } },
          at: new Date().toISOString(),
        },
      });
    steering(new Date(Date.now() + 86_400_000).toISOString());
    const scaffolder = (model: string) => ({ target: { providerInstanceId: "a6g-fixture-scaffolder", model }, isolation: "worktree" });
    await holds([
      tool(home, "planner", delegate, scaffolder(OPUS), "allow", { run }),
      tool(home, "planner", delegate, scaffolder(FABLE), "refuse", { run }),
      tool(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-builder", model: OPUS }, isolation: "worktree" }, "allow", { run }),
      tool(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-reviewer", model: "claude-sonnet-5-5" } }, "allow", { run }),
    ]);
    assert.match(
      guard(home, "planner", delegate, scaffolder(FABLE), { run }).said,
      /start a scaffolder with target\.model: "claude-opus-5-5" \(beside target\.providerInstanceId\), the model it runs on until \d{4}-\d\d-\d\d \d\d:\d\d UTC instead of its own claude-fable-5-2, since default's Fable limit is used up; claude-fable-5-2 isn't it/
    );
    // Once the limit's reset has passed, it's Fable again, before the watchdog next says so.
    steering(new Date(Date.now() - 60_000).toISOString());
    await holds([
      tool(home, "planner", delegate, scaffolder(FABLE), "allow", { run }),
      tool(home, "planner", delegate, scaffolder(OPUS), "refuse", { run }),
    ]);
    // A role team.json has moved off Fable since isn't held to the fallback chosen for it.
    const moved = makeRepo(baseTeam({ roles: { planner: {}, scaffolder: { model: "sonnet" } } }));
    steering(new Date(Date.now() + 86_400_000).toISOString());
    await holds([
      tool(
        moved,
        "planner",
        delegate,
        { target: { providerInstanceId: "a6g-fixture-scaffolder", model: "claude-sonnet-5-5" }, isolation: "worktree" },
        "allow",
        {
          run,
        }
      ),
    ]);
  });

  test("the refusal names the model to use", async () => {
    const { guard } = await import("./helpers.ts");
    const home = makeRepo();
    const wrong = guard(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-builder", model: FABLE }, isolation: "worktree" });
    assert.equal(wrong.outcome, "refuse");
    assert.match(wrong.said, /start a builder with target\.model: "claude-opus-5-5" \(beside target\.providerInstanceId\).*claude-fable-5-2 isn't it/);
    const none = guard(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-builder" }, isolation: "worktree" });
    assert.match(none.said, /target\.model: "claude-opus-5-5".*without it, it would run on whichever model T3 Code lists first/);
  });
});

describe("the newest model of each family", () => {
  test("a model's family and version, and which of two is newer", () => {
    assert.deepEqual(versionOf(FABLE), { family: "fable", version: [5, 2] });
    assert.deepEqual(versionOf("claude-opus-5[1m]"), { family: "opus", version: [5, 0] });
    assert.deepEqual(versionOf("claude-haiku-4-5-20251001"), { family: "haiku", version: [4, 5] });
    assert.deepEqual(["claude-mythos-5-2", "claude-fable", "m", "<synthetic>"].map(versionOf), [null, null, null, null]);
    assert.ok(newerThan(FABLE, "claude-fable-5-1"));
    assert.ok(newerThan("claude-opus-6", OPUS));
    assert.ok(newerThan("claude-opus-5-10", "claude-opus-5-9"), "by number, not by text");
    assert.ok(!newerThan("claude-fable-5-1", FABLE));
    assert.ok(!newerThan(FABLE, FABLE));
    assert.ok(!newerThan("claude-fable-9", OPUS), "only within a family");
    assert.deepEqual([FABLE, "claude-opus-5", "claude-sonnet-5-5[1m]", "m"].map(modelTitle), ["Fable 5.2", "Opus 5", "Sonnet 5.5", "m"]);
  });

  test("each short name is the newest model of its family this version can price", () => {
    for (const [family, id] of Object.entries(MODEL_ALIASES)) {
      const newer = Object.keys(PRICES).filter((model) => newerThan(model, id));
      assert.deepEqual(newer, [], `${family} is ${id}, though this version prices ${newer.join(", ")}`);
    }
  });

  test("the models in use that are newer than a short name, and the roles a short name moves", () => {
    assert.deepEqual(
      newerThanShortNames([
        "claude-fable-5-1",
        "claude-fable-9-1[1m]",
        "claude-fable-7",
        OPUS,
        "claude-opus-5",
        "claude-haiku-4-5-20251001",
        "claude-mythos-9",
        "m",
      ]),
      { fable: "claude-fable-9-1" }
    );
    assert.deepEqual(newerThanShortNames([FABLE, OPUS]), {});
    const raw = { model: "sonnet", roles: { planner: {}, builder: { model: "Opus" }, reviewer: { model: "claude-opus-5" } } };
    assert.deepEqual(
      ["planner", "builder", "reviewer", "tester"].map((role) => onShortName(raw, role)),
      [true, true, false, true]
    );
    assert.ok(onShortName({ roles: { planner: {} } }, "planner"), "left out: the default, a short name");
    assert.ok(!onShortName({ model: "claude-fable-5-1" }, "planner"), "a model id is kept on purpose");
  });

  test("what keeps roles off the newest: a newer model in use here, and a team behind this version", () => {
    const a6gHome = process.env["A6G_HOME"] as string;
    write(join(a6gHome, "subscriptions"), {
      "default.hours.json": {
        cursors: {},
        hours: {},
        sessions: {},
        tallies: {
          "2026-10-01T09": { "claude-sonnet-9": { requests: 5 }, "claude-fable-9-1": { requests: 1 } },
          "2026-11-10T08": { "claude-fable-9-1": { requests: 1 } },
          "2026-11-12T09": { "claude-fable-9-1[1m]": { requests: 2 }, [OPUS]: { requests: 9 } },
          "2026-11-19T08": { "claude-haiku-9": { requests: 0 } },
        },
      },
    });
    // Registered by a version whose Fable was 5.1: the planner is on the default, the reviewer names 5.1 itself.
    const home = makeRepo(baseTeam({ roles: { planner: {}, builder: {}, reviewer: { model: "claude-fable-5-1" } } }));
    write(join(a6gHome, "teams"), {
      "fixture.json": {
        name: "fixture",
        home,
        run: tmp("a6g-run-"),
        version: "0.8.8",
        model: "claude-fable-5-1",
        models: { planner: "claude-fable-5-1", builder: OPUS, reviewer: "claude-fable-5-1" },
      },
    });
    try {
      const notices = modelNotices(new Date("2026-11-20T12:00:00Z"));
      assert.deepEqual(
        notices.map((notice) => notice.key),
        ["factory claude-fable-9-1", `team fixture ${FABLE}`]
      );
      assert.equal(
        notices[0]?.text,
        `Fable 9.1 (claude-fable-9-1) is in use on default since 2026-10-01, but Anything Factory ${PACKAGE.version} runs Fable roles on Fable 5.2 (${FABLE}): a release that knows Fable 9.1 moves them (a6g self-install it, then a6g upgrade <team>)`
      );
      assert.equal(
        notices[1]?.text,
        `fixture runs its planner on Fable 5.1 (claude-fable-5-1), but Anything Factory ${PACKAGE.version} runs Fable roles on Fable 5.2 (${FABLE}): a6g upgrade fixture moves it`
      );
      // Out of the fortnight it looks at, a model in use says nothing.
      assert.deepEqual(
        modelNotices(new Date("2026-12-20T12:00:00Z")).map((notice) => notice.key),
        [`team fixture ${FABLE}`]
      );
    } finally {
      rmSync(join(a6gHome, "subscriptions"), { recursive: true, force: true });
      rmSync(join(a6gHome, "teams"), { recursive: true, force: true });
    }
  });
});

describe("register and the watchdog", () => {
  test("the watchdog says once what keeps roles off the newest model", async () => {
    const w = await fakeWorld();
    try {
      const hour = new Date(Date.now() - 3_600_000).toISOString().slice(0, 13);
      write(join(w.a6gHome, "subscriptions"), {
        "default.hours.json": { cursors: {}, hours: {}, sessions: {}, tallies: { [hour]: { "claude-fable-9-1": { requests: 4 } } } },
      });
      const log = () => readFileSync(join(w.a6gHome, "watchdog.log"), "utf8");
      const told = () => w.calls().filter((call) => call.startsWith("osascript") && call.includes("Fable 9.1")).length;
      assert.equal((await w.a6g("watchdog", "run")).code, 0);
      assert.match(log(), /Fable 9\.1 \(claude-fable-9-1\) is in use on default since \d{4}-\d\d-\d\d, but Anything Factory /);
      assert.equal(told(), 1);
      // The next reading of the subscriptions finds the same, and says nothing more.
      rmSync(join(w.a6gHome, ".stamp-subscriptions"));
      assert.equal((await w.a6g("watchdog", "run")).code, 0);
      assert.equal(log().match(/is in use on default/g)?.length, 1, log());
      assert.equal(told(), 1);
    } finally {
      await w.close();
    }
  });

  test("register records each role's model and says them; the watchdog starts the planner on its own", async () => {
    const w = await fakeWorld(baseTeam({ roles: { planner: {}, builder: { limit: 2 }, scaffolder: {}, reviewer: { limit: 1 } } }), { register: false });
    try {
      mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
      const result = await w.a6g("register", w.home);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /^ {2}models: claude-fable-5-2 for the planner, scaffolder; claude-opus-5-5 for the builder, reviewer$/m);
      const entry = JSON.parse(readFileSync(join(w.a6gHome, "teams", "fixture.json"), "utf8")) as { model: string; models: Record<string, string> };
      assert.equal(entry.model, FABLE, "the planner's, for a watchdog that knows one model");
      assert.deepEqual(entry.models, { planner: FABLE, builder: OPUS, scaffolder: FABLE, reviewer: OPUS });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      const starts = w.calls().filter((call) => call.startsWith("t3 thread start"));
      assert.equal(starts.length, 1, starts.join("\n"));
      assert.match(starts[0] ?? "", /--provider a6g-fixture-planner --model claude-fable-5-2 /);
    } finally {
      await w.close();
    }
  });

  test("an entry registered before roles had models starts the planner on the one it holds", async () => {
    const w = await fakeWorld();
    try {
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      const starts = w.calls().filter((call) => call.startsWith("t3 thread start"));
      assert.match(starts[0] ?? "", /--provider a6g-fixture-planner --model m /);
    } finally {
      await w.close();
    }
  });

  test("a worker machine starts each role on its own model", async () => {
    const w = await fakeWorld();
    try {
      const file = join(w.a6gHome, "teams", "fixture.json");
      write(join(w.a6gHome, "teams"), {
        "fixture.json": {
          ...JSON.parse(readFileSync(file, "utf8")),
          tasks: { store: "files", database: "a6g", lead: null },
          mode: "cycles",
          worker: true,
          limits: { builder: 1 },
          branch: "a6g/next",
          models: { builder: "claude-sonnet-5-5" },
        },
      });
      const store = fileStore(w.run, "fixture");
      await store.tasks.createAs("1", newTask({ team: "fixture", title: "t1", kind: "feature", status: "approved", by: "planner", files: ["src/1/"] }));
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      const starts = w.calls().filter((call) => call.startsWith("t3 thread start"));
      assert.equal(starts.length, 1, starts.join("\n"));
      assert.match(starts[0] ?? "", /--provider a6g-fixture-builder --model claude-sonnet-5-5 /);
    } finally {
      await w.close();
    }
  });
});
