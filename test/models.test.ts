// Which model each role runs on: team.json's settings and the defaults (lib/models.ts), the planner's table, the
// guard's check on a member's start, and what register and the watchdog start threads with.
import { baseTeam, holds, makeRepo, tool, write } from "./helpers.ts";
import { fakeWorld } from "./fake-t3.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam, modelsOf, normalize, type RawTeam } from "../lib/config.ts";
import { defaultModel, MODEL_ALIASES, modelId } from "../lib/models.ts";
import { priced } from "../lib/prices.ts";
import { compile } from "../lib/prompts.ts";
import { newTask } from "../lib/tasks/model.ts";
import { fileStore } from "../lib/tasks/files.ts";

const FABLE = "claude-fable-5-1";
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
    assert.match(planner, /\| scaffolder \| `a6g-fixture-scaffolder` \| `"claude-fable-5-1"` \| `"worktree"` \| 1 \|/);
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

  test("the refusal names the model to use", async () => {
    const { guard } = await import("./helpers.ts");
    const home = makeRepo();
    const wrong = guard(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-builder", model: FABLE }, isolation: "worktree" });
    assert.equal(wrong.outcome, "refuse");
    assert.match(wrong.said, /start a builder with target\.model: "claude-opus-5-5" \(beside target\.providerInstanceId\).*claude-fable-5-1 isn't it/);
    const none = guard(home, "planner", delegate, { target: { providerInstanceId: "a6g-fixture-builder" }, isolation: "worktree" });
    assert.match(none.said, /target\.model: "claude-opus-5-5".*without it, it would run on whichever model T3 Code lists first/);
  });
});

describe("register and the watchdog", () => {
  test("register records each role's model and says them; the watchdog starts the planner on its own", async () => {
    const w = await fakeWorld(baseTeam({ roles: { planner: {}, builder: { limit: 2 }, scaffolder: {}, reviewer: { limit: 1 } } }), { register: false });
    try {
      mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
      const result = await w.a6g("register", w.home);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /^ {2}models: claude-fable-5-1 for the planner, scaffolder; claude-opus-5-5 for the builder, reviewer$/m);
      const entry = JSON.parse(readFileSync(join(w.a6gHome, "teams", "fixture.json"), "utf8")) as { model: string; models: Record<string, string> };
      assert.equal(entry.model, FABLE, "the planner's, for a watchdog that knows one model");
      assert.deepEqual(entry.models, { planner: FABLE, builder: OPUS, scaffolder: FABLE, reviewer: OPUS });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      const starts = w.calls().filter((call) => call.startsWith("t3 thread start"));
      assert.equal(starts.length, 1, starts.join("\n"));
      assert.match(starts[0] ?? "", /--provider a6g-fixture-planner --model claude-fable-5-1 /);
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
