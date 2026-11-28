// A planner that can't work: one whose rules and documents nearly fill the window its context is compacted in, one T3
// Code left queued with nothing running, and a retired one that a late message woke beside the new one.
import { baseTeam, makeRepo } from "./helpers.ts";
import { fakeWorld } from "./fake-t3.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam } from "../lib/config.ts";
import { PACKAGE } from "../lib/paths.ts";
import { compile } from "../lib/prompts.ts";
import { carried, CARRIED_BEFORE_RULES, plannerWindow, roomIn, tightRoom, windowFor } from "../lib/room.ts";
import { midTurn, stalled, STALLED_AFTER_MIN, teamInstances } from "../lib/t3.ts";

const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
// Decisions long enough to fill most of the default window: about 86,000 tokens of them.
const LONG = { ".a6g/decisions.md": `# Decisions\n\n${"- The team decided something, and why it did.\n".repeat(6_500)}` };

describe("the room a planner has to work in", () => {
  test("what it carries: its rules, the repository's CLAUDE.md, and Claude Code's own", () => {
    const small = loadTeam(makeRepo());
    assert.equal(carried(small, "planner"), CARRIED_BEFORE_RULES + Math.round(compile(small, "planner").length / 3.5));
    const withClaude = loadTeam(makeRepo(baseTeam(), { "CLAUDE.md": "x".repeat(35_000) }));
    assert.ok(carried(withClaude, "planner") - carried(small, "planner") >= 10_000, "CLAUDE.md counts");
    assert.ok(carried(loadTeam(makeRepo(baseTeam(), LONG)), "planner") > 150_000, "and the decisions in its rules");
  });

  test("its window: what leaves it 80,000 tokens over what it carries, 160,000 at least; team.json's own when it sets one", () => {
    assert.equal(windowFor(40_000), 160_000);
    assert.equal(windowFor(112_153), 230_000);
    const small = loadTeam(makeRepo());
    assert.equal(plannerWindow(small), windowFor(carried(small, "planner")));
    assert.ok(plannerWindow(small) <= 200_000, `a team with few documents: ${plannerWindow(small)}`);
    const long = loadTeam(makeRepo(baseTeam(), LONG));
    const window = plannerWindow(long);
    assert.equal(window % 10_000, 0);
    assert.ok(roomIn(window, carried(long, "planner")) >= 80_000, `room in ${window}`);
    assert.ok(roomIn(window, carried(long, "planner")) < 90_000, "and no more than it needs");
    const set = loadTeam(makeRepo(baseTeam({ roles: { planner: { compactAt: 200_000 } } }), LONG));
    assert.equal(plannerWindow(set), 200_000);
  });

  test("too little room is said in words, with what fixes it", () => {
    const long = loadTeam(makeRepo(baseTeam(), LONG));
    assert.equal(tightRoom(loadTeam(makeRepo()), 160_000, { set: false, name: "app" }), null);
    assert.equal(tightRoom(long, plannerWindow(long), { set: false, name: "app" }), null);
    assert.match(
      tightRoom(long, 160_000, { set: false, name: "app" }) ?? "",
      /^its planner carries about 1\d\d,000 tokens of rules and documents into every turn and its context is compacted in a window of 160,000, which leaves it nothing to work in: it compacts every few minutes and loses its place \(a6g upgrade app gives it room; shorter \.a6g\/decisions\.md/
    );
    assert.match(
      tightRoom(long, 200_000, { set: true, name: "app" }) ?? "",
      /leaves it (about \d+,000|nothing) to work in: .* \(raise roles\.planner\.compactAt in \.a6g\/team\.json to \d\d\d,000 or leave it out, then a6g upgrade app;/
    );
  });

  test("register gives the planner's instance that window, and doctor says when a registered one is too small", async () => {
    const w = await fakeWorld(baseTeam(), { register: false });
    try {
      mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
      const registered = await w.a6g("register", w.home);
      assert.equal(registered.code, 0, registered.out);
      const settings = () => JSON.parse(read(join(w.t3Home, "userdata", "settings.json")));
      const first = teamInstances("fixture", settings())?.["planner"]?.compactAt ?? 0;
      assert.equal(first, plannerWindow(loadTeam(w.home)));
      assert.equal(teamInstances("fixture", settings())?.["builder"]?.compactAt, null);
      assert.doesNotMatch((await w.a6g("doctor")).out, /its planner carries/);

      // Its decisions grew: the registered window is too small now, and registering again fits it.
      writeFileSync(join(w.home, ".a6g", "decisions.md"), LONG[".a6g/decisions.md"]);
      assert.match(
        (await w.a6g("doctor")).out,
        new RegExp(
          `FAIL\\s+fixture: its planner carries about 1\\d\\d,000 tokens of rules and documents into every turn and its context is compacted in a window of ${first / 1000},000`
        )
      );
      assert.equal((await w.a6g("register", w.home)).code, 0);
      const window = teamInstances("fixture", settings())?.["planner"]?.compactAt ?? 0;
      assert.ok(window >= first + 80_000, `the window grew from ${first} to ${window}`);
      assert.doesNotMatch((await w.a6g("doctor")).out, /its planner carries/);
    } finally {
      await w.close();
    }
  });
});

describe("a planner T3 Code left queued with nothing running", () => {
  test("told from one in a turn, and from a message about to start", () => {
    const quiet = minutesAgo(STALLED_AFTER_MIN + 1);
    assert.equal(stalled({ status: "queued", activeRunId: null, updatedAt: quiet }), true);
    assert.equal(stalled({ status: "queued", updatedAt: quiet }), true, "a T3 Code that names no run");
    assert.equal(stalled({ status: "queued", activeRunId: null, updatedAt: minutesAgo(1) }), false, "about to start");
    assert.equal(stalled({ status: "queued", activeRunId: "run:1", updatedAt: quiet }), false, "behind a turn that's running");
    assert.equal(stalled({ status: "running", activeRunId: null, updatedAt: quiet }), false);
    assert.equal(stalled(null), false);
    assert.equal(midTurn({ status: "queued", activeRunId: null, updatedAt: quiet }), false);
    assert.equal(midTurn({ status: "queued", activeRunId: null, updatedAt: minutesAgo(1) }), true);
    assert.equal(midTurn({ status: "running", updatedAt: quiet }), true);
    assert.equal(midTurn({ status: "idle", updatedAt: quiet }), false);
  });

  test("the watchdog ticks it, where it leaves one in a turn alone; and it can be restarted", async () => {
    const w = await fakeWorld();
    try {
      const plannerFile = join(w.run, "planner-thread");
      writeFileSync(plannerFile, "mcp:old\n");
      const sent = () => w.calls().filter((call) => call.startsWith("t3 thread send"));
      w.show({ status: "queued", activeRunId: null, updatedAt: minutesAgo(1), pendingRequestCount: 0 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.deepEqual(sent(), [], "a message about to start is left to start");
      assert.match(read(join(w.run, "watchdog.log")), /planner queued \(quiet 1 min\)/);

      w.show({ status: "queued", activeRunId: null, updatedAt: minutesAgo(9), pendingRequestCount: 0 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(sent().length, 1);
      assert.match(sent()[0] ?? "", /^t3 thread send mcp:old tick \(/);
      assert.match(
        read(join(w.run, "watchdog.log")),
        /planner queued with nothing running \(quiet 9 min\)[^\n]*\n[^\n]*tick \(planner was queued with nothing running\)/
      );

      // Restarting it isn't refused as "in the middle of a turn": nothing of its own will ever start.
      const rotated = await w.a6g("rotate", "fixture");
      assert.equal(rotated.code, 0, rotated.out);
      assert.equal(read(plannerFile).trim(), "mcp:new-planner");
      assert.equal(read(join(w.run, "planner-thread.retired")).trim(), "mcp:old");
    } finally {
      await w.close();
    }
  });
});

describe("a retired planner that a late message woke", () => {
  test("the watchdog tells it to stand down, once in half an hour, and never the team's own planner", async () => {
    const w = await fakeWorld();
    try {
      const planner = { instance: "a6g-fixture-planner", title: "Fixture team · planner" };
      writeFileSync(join(w.run, "planner-thread"), "mcp:now\n");
      writeFileSync(join(w.run, "planner-thread.retired"), "mcp:long-gone\nmcp:old\n");
      w.thread({ id: "mcp:now", ...planner, createdMin: 60, updatedMin: 1 });
      w.thread({ id: "mcp:old", ...planner, createdMin: 180, updatedMin: 2 });
      w.thread({ id: "mcp:long-gone", ...planner, createdMin: 900, updatedMin: 600 });
      w.thread({ id: "mcp:someone", instance: "a6g-fixture-planner", title: "Somebody else", updatedMin: 1 });
      const stoodDown = () => w.calls().filter((call) => call.includes("Stand down"));

      // Idle: a retired planner nothing woke is left alone.
      w.show({ status: "idle", activeRunId: null, updatedAt: minutesAgo(2), pendingRequestCount: 0 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.deepEqual(stoodDown(), []);

      // In a turn again (the fake shows every thread the same, the team's planner too).
      w.show({ status: "running", activeRunId: "run:1", updatedAt: minutesAgo(0), pendingRequestCount: 0 });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(stoodDown().length, 1);
      assert.match(
        stoodDown()[0] ?? "",
        /^t3 thread send mcp:old This planner thread was retired when the team's planner was restarted: mcp:now is its planner now\. A late message woke this one\. Stand down: start no members, queue no merges/
      );
      assert.match(read(join(w.run, "watchdog.log")), /retired planner mcp:old is at work again: told to stand down/);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(stoodDown().length, 1, "said once in half an hour");
    } finally {
      await w.close();
    }
  });

  test("the check after merges reports to the planner of the moment, not the one it started under", () => {
    const merge = read(join(import.meta.dirname, "..", "lib", "commands", "merge.ts"));
    assert.match(merge, /wake: \(text\) => \{\n\s+const planner = plannerNow\(\);/);
    assert.doesNotMatch(merge, /const planner = [^\n]+\n\s+await verifyAfterMerge/, "not read before a check that runs for an hour");
  });
});
