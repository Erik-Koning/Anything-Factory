// The quality numbers (a6g metrics --quality): what each one counts, over a fixture task store, and that they read
// what the commands and the check after merges really record.
import { a6g, baseTeam, bash, commit, git, makeRepo, ROOT, tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { PageResult } from "../lib/commands/pages.ts";
import { loadTeam, type RawTeam } from "../lib/config.ts";
import { readNpm } from "../lib/packages.ts";
import { stateDir } from "../lib/paths.ts";
import { compile } from "../lib/prompts.ts";
import { describeQuality, filedAs, quality, span } from "../lib/quality.ts";
import type { SpecResult, SuiteRecord } from "../lib/suite.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { type Event, newTask, type Task } from "../lib/tasks/model.ts";
import type { UsageDay } from "../lib/tasks/spend.ts";
import { writeJson } from "../lib/util.ts";
import { fileAudit, fileFailures, fileGaps } from "../lib/verify.ts";

// A moment in March 2026 (UTC), and the month as a period.
const at = (day: number, hour = 12, month = 3): string => new Date(Date.UTC(2026, month - 1, day, hour)).toISOString();
const MARCH = { since: Date.parse(at(1, 0)), until: Date.parse(at(31, 23)) };
const ALL = { since: null, until: null };

// Events as the commands record them (model.ts move and withEvent; tools.ts for a review's approval).
const claimed = (when: string): Event => ({ at: when, by: "builder", what: "approved → building", from: "approved", to: "building" });
const submitted = (when: string): Event => ({ at: when, by: "builder", what: "building → review", from: "building", to: "review" });
const changes = (when: string): Event => ({
  at: when,
  by: "reviewer",
  what: "review → approved: changes requested (round 1 of 3): no",
  from: "review",
  to: "approved",
});
const approved = (when: string): Event => ({ at: when, by: "reviewer", what: "review approved", sha: "aaa" });
const merged = (when: string, from: Task["status"] = "review"): Event => ({
  at: when,
  by: "merge-queue",
  what: `${from} → done: merged a6g/b at bbb`,
  from,
  to: "done",
  sha: "bbb",
});
const task = (id: string, fields: Partial<Task> = {}, history: Event[] = []): Task => {
  const made = newTask({ team: "fixture", title: `task ${id}`, kind: "feature", status: "done", by: "planner", createdAt: at(1, 1), ...fields });
  return { ...made, id, version: 1, history: [...made.history, ...history] } as Task;
};
// A finding as the check after merges files it: by the merge queue, its key at the end of its body.
const finding = (id: string, key: string, fields: Partial<Task> = {}): Task =>
  task(id, { kind: "bug", status: "triage", by: "merge-queue", body: `What failed, and where.\n\n(a6g: ${key})`, createdAt: at(12), ...fields });

const spec = (id: string, outcome: SpecResult["outcome"], tags: string[] = []): SpecResult => ({
  id: `e2e/${id}.spec.ts › ${id} [chromium]`,
  file: `e2e/${id}.spec.ts`,
  title: id,
  project: "chromium",
  tags,
  outcome,
});
const ran = (when: string, specs: SpecResult[], more: Partial<SuiteRecord> = {}): SuiteRecord => ({
  commit: "c0ffee1234567890",
  at: when,
  ran: true,
  timedOut: false,
  status: 0,
  specs,
  errors: [],
  ...more,
});
const usage = (day: string, ...rows: [task: string | null, cost: number, unpriced?: number][]): UsageDay => ({
  team: "fixture",
  day,
  machine: "studio",
  rows: rows.map(([on, cost, unpriced = 0]) => ({
    role: on ? "builder" : "planner",
    model: "claude-opus-4-7",
    task: on,
    requests: 4,
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
    unpriced,
  })),
  updatedAt: at(1),
});

// A month of a team's work.
const TASKS: Task[] = [
  // Approved the first time, merged three hours after it was claimed.
  task("1", {}, [claimed(at(2, 10)), submitted(at(2, 12)), approved(at(2, 12)), merged(at(2, 13))]),
  // One round of changes; a day from its first claim to its merge.
  task("2", { kind: "bug", rounds: 1 }, [
    claimed(at(3, 9)),
    submitted(at(3, 10)),
    changes(at(3, 11)),
    claimed(at(3, 12)),
    submitted(at(3, 13)),
    approved(at(4, 8)),
    merged(at(4, 9)),
  ]),
  // Merged on another task's branch: no review of its own.
  task("3", {}, [claimed(at(5, 10)), merged(at(5, 11), "approved")]),
  // The planner's own, never claimed.
  task("4", { kind: "chore" }, [merged(at(6, 9), "approved")]),
  // Merged the month before.
  task("5", {}, [claimed(at(9, 9, 2)), submitted(at(9, 10, 2)), approved(at(9, 11, 2)), merged(at(9, 12, 2))]),
  // Folded into another task: closed with it, by no merge of its own.
  task("6", {}, [{ at: at(7), by: "merge-queue", what: "blocked → done: done with 1, which it was folded into", from: "blocked", to: "done" }]),
  // Journeys: one the suite proves, one it doesn't, one the planner rejected.
  task("7", { kind: "journey" }, [{ at: at(8), by: "merge-queue", what: "blocked → done", from: "blocked", to: "done" }]),
  task("8", { kind: "journey", status: "approved" }),
  task("9", { kind: "journey", status: "rejected" }),
  // Merged in February, reopened, and merged again in March two hours after it was claimed again.
  task("10", {}, [
    claimed(at(10, 9, 2)),
    submitted(at(10, 10, 2)),
    approved(at(10, 11, 2)),
    merged(at(10, 12, 2)),
    { at: at(9), by: "planner", what: "done → proposed", from: "done", to: "proposed" },
    claimed(at(10, 8)),
    submitted(at(10, 9)),
    approved(at(10, 9)),
    merged(at(10, 10)),
  ]),
  // What the check after merges filed: four failures (one rejected since), and the rest counted apart.
  finding("20", "verify:page:pricing"),
  finding("21", "verify:spec:e2e/pay.spec.ts", { status: "rejected" }),
  finding("22", "verify:app"),
  finding("23", "verify:access:admin"),
  finding("24", "gap:journey:8", { kind: "test" }),
  finding("25", "gap:access", { kind: "test" }),
  finding("26", "audit:package-lock.json:lodash", { kind: "chore" }),
  finding("27", "verify:flaky:e2e/pay.spec.ts › pays (card) [chromium]", { kind: "test-infra" }),
  finding("28", "verify:suite", { kind: "test-infra" }),
  finding("29", "verify:less:c0ffee123", { kind: "test-infra" }),
  finding("30", "verify:later:a key of a later version"),
  // Not the period's, and not the check's.
  finding("31", "verify:page:old", { createdAt: at(20, 12, 2) }),
  finding("32", "verify:page:quoted", { by: "builder" }),
];
// Newest first, as the history keeps them.
const RUNS: SuiteRecord[] = [
  ran(at(2, 12, 4), [spec("signs-up", "passed", ["@journey-7"]), spec("pays", "passed", ["@journey-8"])]),
  ran(at(20), [spec("signs-up", "passed", ["@journey-7"]), spec("pays", "failed", ["@journey-8"]), spec("lists", "flaky")]),
  ran(at(15), [spec("pays", "flaky", ["@journey-8"])], { ran: false, errors: ["the app didn't answer"] }),
  ran(at(11), [spec("signs-up", "passed", ["@journey-7"]), spec("pays", "flaky", ["@journey-8"])]),
  ran(at(5), [spec("pays", "flaky", ["@journey-8"])]),
  ran(at(20, 12, 2), [spec("pays", "flaky", ["@journey-8"])]),
];
const DAYS: UsageDay[] = [
  usage("2026-02-20", ["10", 4], ["5", 7]),
  usage("2026-03-02", ["1", 2], ["2", 3], [null, 1.5]),
  usage("2026-03-10", ["10", 1, 2], ["6", 0.5]),
];

describe("the quality numbers", () => {
  test("a month of work: what merged, how its reviews went, what was found after, and what it cost", () => {
    const q = quality(TASKS, RUNS, DAYS, MARCH);
    assert.deepEqual(q.merged, { tasks: 5, byKind: { feature: 3, bug: 1, chore: 1 } });
    // #3 and #4 merged without a review of their own; of the three reviewed, #2 took a round of changes.
    assert.deepEqual(q.reviews, { reviewed: 3, firstTime: 2, share: 0.667 });
    assert.deepEqual(q.afterMerge, { failures: 4, rejected: 1, perMerged: 0.8, gaps: 2, advisories: 1, checks: 3, other: 1 });
    // The newest run in the period speaks, not April's.
    assert.deepEqual(q.journeys, { total: 2, proven: 1, run: { commit: "c0ffee1234567890", at: at(20) }, why: null });
    // The run that didn't run and February's count for nothing.
    assert.deepEqual(q.flaky, {
      runs: 3,
      since: at(5),
      tests: [
        { id: "e2e/pays.spec.ts › pays [chromium]", times: 2 },
        { id: "e2e/lists.spec.ts › lists [chromium]", times: 1 },
      ],
    });
    // #10 was built partly in February, and all of it is its cost; the team's spend is the month's days.
    assert.deepEqual(q.cost, { merged: 10, perMerged: 2, unpriced: 2, team: 8 });
    // 60, 120, 180 and 1440 minutes; #10 from its claim after it was reopened.
    assert.deepEqual(q.claimedToMerged, { tasks: 4, medianMin: 150 });

    assert.deepEqual(describeQuality(q), [
      "Merged: 5 tasks (3 feature, 1 bug, 1 chore)",
      "Reviews passed first time: 2 of 3 reviewed (67%)",
      "Found after merge: 4 failures filed by the check after merges, 0.8 per merged task (1 rejected by the planner since)",
      "  counted apart: 2 gaps in the harness; 1 package advisory; 3 about the checks themselves (one that didn't run, a flaky test, fewer tests); 1 of a kind this version doesn't know",
      "Journeys proven: 1 of 2, by the suite's run at c0ffee123 (2026-03-20)",
      "Flaky tests: 2 in 3 recorded runs since 2026-03-05 (e2e/pays.spec.ts › pays [chromium], 2 times; e2e/lists.spec.ts › lists [chromium])",
      "Cost per merged task: $2.00 ($10 on their branches, at the API-equivalent rate; the team spent $8.00 in the period)",
      "  2 requests on those branches had no known price and count as $0",
      "Claimed to merged: 2 h 30 min (the median of 4 tasks)",
    ]);
  });

  test("the period bounds what's counted, and an open one counts everything once", () => {
    const early = quality(TASKS, RUNS, DAYS, { since: MARCH.since, until: Date.parse(at(4, 12)) });
    assert.deepEqual(early.merged, { tasks: 2, byKind: { feature: 1, bug: 1 } });
    assert.deepEqual(early.reviews, { reviewed: 2, firstTime: 1, share: 0.5 });
    assert.equal(early.afterMerge.failures, 0);
    // The newest run by then is February's, where #8's test passed on its retry and #7 had none.
    assert.deepEqual([early.journeys.proven, early.journeys.run?.at], [1, at(20, 12, 2)]);
    assert.equal(early.flaky.runs, 0);
    assert.deepEqual(early.claimedToMerged, { tasks: 2, medianMin: 810 });

    const all = quality(TASKS, RUNS, DAYS, ALL);
    // February's #5 too; #10 once, at its last merge.
    assert.equal(all.merged.tasks, 6);
    assert.deepEqual(all.reviews, { reviewed: 4, firstTime: 3, share: 0.75 });
    assert.equal(all.afterMerge.failures, 5);
    assert.deepEqual([all.journeys.proven, all.journeys.run?.at], [2, at(2, 12, 4)]);
    assert.deepEqual([all.flaky.runs, all.flaky.tests[0]?.times], [5, 3]);
    assert.deepEqual(all.cost, { merged: 17, perMerged: 2.833333, unpriced: 2, team: 19 });
  });

  test("a number that can't be known says so, and is never a zero", () => {
    const none = quality([], [], [], ALL);
    assert.deepEqual(none.reviews, { reviewed: 0, firstTime: 0, share: null });
    assert.deepEqual([none.afterMerge.perMerged, none.cost.perMerged, none.claimedToMerged.medianMin, none.journeys.proven], [null, null, null, null]);
    assert.deepEqual(describeQuality(none), [
      "Merged: 0 tasks",
      "Reviews passed first time: no merged task was reviewed",
      "Found after merge: 0 failures filed by the check after merges",
      "Journeys proven: the team has no journeys",
      "Flaky tests: no recorded run of the suite in the period",
      "Cost per merged task: none merged; the team spent $0.00 in the period",
      "Claimed to merged: no merged task was claimed",
    ]);

    // No run of the suite, and one that didn't run: an older pass doesn't stand in for it.
    const journeys = TASKS.filter((t) => t.kind === "journey");
    const unrun = quality(journeys, [], [], MARCH);
    assert.deepEqual([unrun.journeys.total, unrun.journeys.proven], [2, null]);
    assert.equal(
      describeQuality(unrun)[3],
      "Journeys proven: not known for the team's 2: no recorded run of the suite (a6g e2e run, or the merge queue's check)"
    );
    const stale = quality(journeys, [ran(at(21), [], { ran: false }), ...RUNS], [], MARCH);
    assert.deepEqual([stale.journeys.total, stale.journeys.proven], [2, null]);
    assert.match(describeQuality(stale)[3] ?? "", /^Journeys proven: not known for the team's 2: the newest run of the suite, at c0ffee123, didn't run$/);
    // A machine that doesn't keep the suite's runs (a team of several, and not its lead) says where they are.
    const worker = quality(journeys, null, [], MARCH);
    assert.deepEqual([worker.journeys.proven, worker.flaky.runs], [null, null]);
    assert.deepEqual(describeQuality(worker).slice(3, 5), [
      "Journeys proven: not known for the team's 2: the suite's runs are kept on the team's lead machine: run this there",
      "Flaky tests: not known here: the suite's runs are kept on the team's lead machine: run this there",
    ]);
    // A journey with no test tagged for it isn't proven by a run that passes.
    assert.equal(quality(journeys, [ran(at(21), [spec("signs-up", "passed", ["@journey-7"])])], [], MARCH).journeys.proven, 1);
  });

  test("a span of minutes in words", () => {
    assert.deepEqual([0, 45, 60, 190, 1440, 1500, 3000].map(span), ["0 min", "45 min", "1 h", "3 h 10 min", "1 d", "1 d 1 h", "2 d 2 h"]);
  });
});

describe("what the check after merges files, counted", { concurrency: true }, () => {
  const roles = { planner: {}, builder: {}, reviewer: {}, scaffolder: {} };

  test("each finding it files is counted as what it is", async () => {
    const bare = makeRepo(baseTeam({ board: "tasks", roles }));
    const states = { staff: "e2e/.auth/staff.json", member: "e2e/.auth/member.json" };
    const home = makeRepo(baseTeam({ board: "tasks", roles }), {
      ".a6g/harness.json": { e2e: { config: "playwright.config.ts" }, auth: { project: "setup", states } },
    });
    const team = loadTeam(home);
    const store = fileStore(tmp("a6g-run-"), "fixture");
    await store.tasks.createAs("1", newTask({ team: "fixture", title: "Pay for an order", kind: "journey", status: "approved", by: "planner" }));
    const head = git(home, "rev-parse", "HEAD");
    const count = async () => quality(await store.tasks.all(), [], [], ALL).afterMerge;
    const titles = async (ids: string[]) => (await Promise.all(ids.map((id) => store.tasks.get(id)))).map((t) => t?.title);

    // Gaps: no manifest, a journey with no test, no test of who may reach what; and a test that passed on its retry.
    assert.equal((await fileGaps(store, loadTeam(bare), bare, null)).length, 1);
    const gaps = await fileGaps(store, team, home, { ...ran(at(1), [spec("lists", "flaky")]), commit: head });
    assert.deepEqual(await titles(gaps), ["Journey 1 has no end-to-end spec", "No test shows one user is refused another's records", "Flaky test: lists"]);
    assert.deepEqual(await count(), { failures: 0, rejected: 0, perMerged: null, gaps: 3, advisories: 0, checks: 1, other: 0 });

    // Failures: a page served to someone it refuses, a page that fails its checks, and a spec file with a failing test.
    const pages: Record<string, PageResult> = {
      admin: {
        passed: false,
        runs: [{ viewport: "desktop", scheme: "light", problems: [], status: 200 }],
        refusals: [{ state: "member", problem: "served to member" }],
      },
      pricing: { passed: false, runs: [{ viewport: "desktop", scheme: "light", problems: ["HTTP 500"], status: 500 }] },
    };
    const suite = { ...ran(at(1), [spec("pays", "failed")]), commit: head };
    const failures = await fileFailures(store, team, home, {}, { pages, before: {}, suite, at: head });
    assert.equal(failures.length, 3, (await titles(failures)).join("; "));
    // A package with an advisory.
    const vulnerable = (readNpm(JSON.parse(readFileSync(join(ROOT, "test/fixtures/npm-audit.json"), "utf8"))) ?? []).slice(0, 1);
    const round = { said: [], seen: {}, audited: [{ lockfile: "package-lock.json", command: "npm audit --omit=dev", vulnerable }] };
    assert.equal((await fileAudit(store, team, {}, round, head)).filed.length, 1);
    assert.deepEqual(await count(), { failures: 3, rejected: 0, perMerged: null, gaps: 3, advisories: 1, checks: 1, other: 0 });
  });

  test("every key the check files under is one the count knows", () => {
    // The keys in the check's source: "verify:app", `verify:page:${id}`, "gap:harness", … A new one is counted as
    // something here before it ships, or this fails.
    const source = readFileSync(join(ROOT, "lib/verify.ts"), "utf8");
    const keys = new Map([...source.matchAll(/["`]((?:verify|gap):[a-z]+)(:?)/g)].map((found) => [found[1] ?? "", found[2] === ":"]));
    assert.ok(keys.size >= 11, [...keys.keys()].join(" "));
    for (const [key, more] of keys) {
      const as = filedAs({ by: "merge-queue", body: `What failed.\n\n(a6g: ${key}${more ? ":what (it) names" : ""})` });
      assert.ok(as && as !== "other", `${key} isn't counted as anything`);
    }
    assert.equal(filedAs({ by: "merge-queue", body: "No key." }), null);
    assert.equal(filedAs({ by: "planner", body: "Quoting one.\n\n(a6g: verify:app)" }), null);
  });
});

describe("a6g metrics --quality", { concurrency: true }, () => {
  // One team checkout with a run folder of its own, and members' worktrees as T3 Code makes them.
  function setup(raw: RawTeam = baseTeam()) {
    const home = makeRepo(raw);
    const run = tmp("a6g-run-");
    const member = (role?: string, cwd = home) => ({
      cwd,
      env: { A6G_HOME_DIR: home, A6G_RUN: run, ...(role ? { A6G_TEAM: "fixture", A6G_ROLE: role } : {}) },
    });
    const worktree = (name: string) => {
      const dir = join(tmp("a6g-wt-"), name);
      git(home, "worktree", "add", "-q", "-b", `wt/${name}`, dir, "a6g/next");
      return realpathSync(dir);
    };
    const store = () => fileStore(run, "fixture");
    return { home, member, worktree, store };
  }

  test("reads what claiming, reviewing and merging recorded", async () => {
    const { home, member, worktree, store } = setup();
    const ok = async (args: string[], who: ReturnType<typeof member>) => {
      const result = await a6g(args, who);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.out}`);
    };
    // A builder's turn at a task: claim it in a worktree, commit on its branch, hand it in.
    const build = async (id: string, name: string, dir: string, file: string, first: boolean) => {
      await ok(["task", "claim", id], member("builder", dir));
      if (first) git(dir, "branch", "-m", name);
      else git(dir, "checkout", "-q", name);
      const sha = commit(dir, { [file]: `export const made = "${dir}";\n` });
      await ok(["task", "submit", id], member("builder", dir));
      git(dir, "checkout", "-q", "--detach");
      return sha;
    };
    for (const [id, title] of [
      ["1", "Export orders"],
      ["2", "List orders"],
    ] as const)
      await store().tasks.createAs(id, newTask({ team: "fixture", title, kind: id === "1" ? "feature" : "bug", status: "approved", by: "planner" }));

    // #1 takes a round of changes; #2 is approved the first time.
    const one = "a6g/b1-export-orders";
    const first = await build("1", one, worktree("b1"), "src/export.ts", true);
    await ok(["verdict", "review", one, "changes", "--sha", first, "--note", "it exports nothing"], member("reviewer"));
    const second = await build("1", one, worktree("b2"), "src/export.ts", false);
    await ok(["verdict", "review", one, "approve", "--sha", second, "--risk", "low", "--note", "ok"], member("reviewer"));
    await ok(["merge", one], member("planner"));
    const two = "a6g/b2-list-orders";
    const third = await build("2", two, worktree("b3"), "src/list.ts", true);
    await ok(["verdict", "review", two, "approve", "--sha", third, "--risk", "low", "--note", "ok"], member("reviewer"));
    await ok(["merge", two], member("planner"));
    assert.deepEqual(
      (await store().tasks.all()).map((t) => [t.id, t.status, t.rounds]),
      [
        ["1", "done", 1],
        ["2", "done", 0],
      ]
    );

    // What ran on #1's branch, and the suite's one recorded run.
    await store().usage.publish([usage("2026-03-02", ["1", 3], [null, 1])]);
    writeJson(join(stateDir(home), "e2e", "history.json"), [ran(new Date().toISOString(), [spec("lists", "flaky"), spec("pays", "passed")])]);

    const json = await a6g(["metrics", "--quality", "--json"], member());
    assert.equal(json.code, 0, json.out);
    const q = JSON.parse(json.out);
    assert.deepEqual([q.team, q.since, q.until], ["fixture", null, null]);
    assert.deepEqual(q.merged, { tasks: 2, byKind: { feature: 1, bug: 1 } });
    assert.deepEqual(q.reviews, { reviewed: 2, firstTime: 1, share: 0.5 });
    assert.deepEqual(q.afterMerge, { failures: 0, gaps: 0, advisories: 0, checks: 0, other: 0, rejected: 0, perMerged: 0 });
    assert.deepEqual([q.journeys.total, q.flaky.runs, q.flaky.tests], [0, 1, [{ id: "e2e/lists.spec.ts › lists [chromium]", times: 1 }]]);
    assert.deepEqual(q.cost, { merged: 3, perMerged: 1.5, unpriced: 0, team: 4 });
    assert.equal(q.claimedToMerged.tasks, 2);

    const text = await a6g(["metrics", "--quality"], member());
    assert.equal(text.code, 0, text.out);
    assert.match(
      text.out,
      /^How team fixture's merged work went, all of it:\n {2}Merged: 2 tasks \(1 bug, 1 feature\)\n {2}Reviews passed first time: 1 of 2 reviewed \(50%\)\n/
    );
    assert.match(text.out, /\n {2}Cost per merged task: \$1\.50 \(\$3\.00 on their branches/);

    // A period after all of it, and before it.
    const since = await a6g(["metrics", "--quality", "--since", "2999-01-01"], member());
    assert.match(since.out, /^How team fixture's merged work went, since 2999-01-01:\n {2}Merged: 0 tasks\n/);
    const until = JSON.parse((await a6g(["metrics", "--quality", "--json", "--since", "2020-01-01", "--until", "2020-02-01T00:00:00Z"], member())).out);
    assert.deepEqual([until.since, until.until, until.merged.tasks, until.cost.team], ["2020-01-01", "2020-02-01T00:00:00Z", 0, 0]);
  });

  test("a time it can't read, and a team with no task graph, are refused with why", async () => {
    const { member } = setup();
    for (const args of [["--since", "last-week"], ["--until"], ["--since", "--json"]]) {
      const bad = await a6g(["metrics", "--quality", ...args], member());
      assert.equal(bad.code, 2, bad.out);
      assert.match(bad.out, /^metrics: --(since|until) takes a time like 2026-03-01 or 2026-03-01T09:00:00Z, not "/);
    }
    const github = setup(baseTeam({ board: { github: { label: "a6g" } } }));
    const refused = await a6g(["metrics", "--quality"], github.member());
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /the quality numbers are read from the team's task graph, and this team keeps its work on a GitHub board/);
  });

  test("the planner is told of it, where the team has a task graph, and may run it", async () => {
    const line = /`a6g metrics --quality \[--since <ISO time>\]`: how the merged work went/;
    assert.match(compile(loadTeam(makeRepo(baseTeam())), "planner"), line);
    assert.doesNotMatch(compile(loadTeam(makeRepo(baseTeam({ board: { github: { label: "a6g" } } }))), "planner"), line);
    assert.doesNotMatch(compile(loadTeam(makeRepo(baseTeam())), "builder"), line);
    await bash(makeRepo(baseTeam()), "planner", "a6g metrics --quality --since 2026-03-01", "allow");
    assert.match((await a6g(["help"])).out, /a6g metrics --quality/);
  });
});
