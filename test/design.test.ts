// The design check-in (lib/tasks/design.ts): who the team works for (team.json operator), the task register files for a
// new project's foundation, what's claimed while it's open, and who settles it.
import { a6g, baseTeam, git, gitRepo, machine, makeRepo, tmp, write } from "./helpers.ts";
import { fakeWorld } from "./fake-t3.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam, normalize, type RawTeam } from "../lib/config.ts";
import { detect, draftTeam } from "../lib/detect.ts";
import { compile } from "../lib/prompts.ts";
import { addTask } from "../lib/tasks/add.ts";
import { answer, answersSince } from "../lib/tasks/answer.ts";
import { fileDesignCheckIn } from "../lib/tasks/design.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { claimRefusal, designOpen, MERGE, moveRefusal, newTask, nextClaim, OPERATOR, statusRefusal, type Task } from "../lib/tasks/model.ts";

const norm = (raw: Record<string, unknown>) => normalize({ name: "fixture", branch: "a6g/next", ...raw } as RawTeam, "");
const ROLES = { planner: {}, builder: { limit: 2 }, scaffolder: {}, reviewer: {}, approver: {} };
const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const task = (fields: Partial<Task> & { id: string }): Task => ({
  ...newTask({ team: "fixture", title: `task ${fields.id}`, kind: "feature", status: "approved", by: "planner", ...fields }),
  version: 1,
  ...fields,
});
const at = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
const ASKED = { at: at(5), by: "planner", what: "triage → question", from: "triage", to: "question" };
const ANSWER = { at: at(9), by: OPERATOR, text: "(a) agreed as built", kind: "answer" as const };

describe("team.json operator", () => {
  test("left out: a technical operator, and no check-in, so a team that had neither changes nothing", () => {
    const { team, problems, warnings } = norm({ roles: ROLES });
    assert.deepEqual(problems, []);
    assert.deepEqual(team.operator, { technical: true, designCheckIn: false });
    assert.ok(!warnings.some((warning) => warning.startsWith("operator")), warnings.join("\n"));
  });

  test("a check-in is held with a technical operator only, and needs a scaffolder to build what's checked", () => {
    assert.deepEqual(norm({ roles: ROLES, operator: { designCheckIn: true } }).team.operator, { technical: true, designCheckIn: true });
    const plain = norm({ roles: ROLES, operator: { technical: false, designCheckIn: true } });
    assert.deepEqual(plain.problems, []);
    assert.deepEqual(plain.team.operator, { technical: false, designCheckIn: false });
    assert.match(plain.warnings.join("\n"), /^operator\.designCheckIn: a check-in on the platform and the stack is for a technical operator/m);
    const alone = norm({ roles: { planner: {}, builder: {} }, operator: { designCheckIn: true } });
    assert.match(alone.warnings.join("\n"), /^operator\.designCheckIn: the foundation is the scaffolder's to build, and this team has none/m);
  });

  test("anything but true or false is a problem, and a key it doesn't know is said", () => {
    const { problems, warnings, team } = norm({ roles: ROLES, operator: { technical: "no", designCheckIn: 1, level: "expert" } });
    assert.match(problems.join("\n"), /^operator\.technical: /m);
    assert.match(problems.join("\n"), /^operator\.designCheckIn: /m);
    assert.match(warnings.join("\n"), /unknown key "operator\.level" \(ignored; operator takes technical, designCheckIn\)/);
    assert.deepEqual(team.operator, { technical: true, designCheckIn: false });
  });

  test("every member's rules say who the operator is, and what that means for what's asked", () => {
    const technical = makeRepo(baseTeam({ roles: ROLES, operator: { designCheckIn: true } }));
    assert.match(compile(loadTeam(technical), "planner"), /\*\*The operator\*\* is technical/);
    assert.match(compile(loadTeam(technical), "planner"), /design check-in/);
    const plain = makeRepo(baseTeam({ roles: ROLES, operator: { technical: false } }));
    for (const role of ["planner", "scaffolder", "builder"]) {
      const rules = compile(loadTeam(plain), role);
      assert.match(rules, /\*\*The operator\*\* isn't technical/, role);
      assert.match(rules, /never ask them about the platform, the stack or the architecture/, role);
    }
    // A team that says nothing about its operator reads as it did.
    assert.doesNotMatch(compile(loadTeam(makeRepo(baseTeam({ roles: ROLES }))), "planner"), /\*\*The operator\*\*/);
  });
});

describe("what's claimed while the design check-in is open", () => {
  const board = (design: Partial<Task>) => [
    task({ id: "1", kind: "design", status: "triage", by: MERGE, ...design }),
    task({ id: "2", kind: "scaffold" }),
    task({ id: "3", kind: "test-infra" }),
    task({ id: "4", kind: "feature" }),
    task({ id: "5", kind: "test" }),
    task({ id: "6", kind: "bug", severity: "blocker" }),
  ];

  test("the foundation only: the skeleton and the harness, and never a feature, a spec or a bug", () => {
    for (const status of ["triage", "proposed", "question", "blocked"] as const) {
      const all = board({ status });
      assert.equal(designOpen(all)?.id, "1");
      assert.equal(claimRefusal(all[1] as Task, "scaffolder", all), null, status);
      assert.equal(claimRefusal(all[2] as Task, "scaffolder", all), null, status);
      assert.match(
        claimRefusal(all[3] as Task, "builder", all) ?? "",
        new RegExp(`^task 4 waits for the operator to agree the design \\(#1, ${status}\\): until then only scaffold and test-infra work is claimed$`)
      );
      assert.match(claimRefusal(all[4] as Task, "scaffolder", all) ?? "", /waits for the operator to agree the design/);
      assert.match(claimRefusal(all[5] as Task, "builder", all) ?? "", /waits for the operator to agree the design/);
      assert.equal(nextClaim(all, "builder"), null);
      assert.equal(nextClaim(all, "scaffolder")?.id, "2");
    }
  });

  test("everything, once the operator has agreed it or said they want none", () => {
    for (const status of ["done", "rejected"] as const) {
      const all = board({ status });
      assert.equal(designOpen(all), null);
      assert.equal(nextClaim(all, "builder")?.id, "6", status);
      assert.equal(claimRefusal(all[4] as Task, "scaffolder", all), null);
    }
  });

  test("a task that waits for another says that first", () => {
    const all = [...board({}), task({ id: "7", after: ["2"] })];
    assert.match(claimRefusal(all[6] as Task, "builder", all) ?? "", /^task 7 waits for 2 \(approved\)$/);
  });
});

describe("who settles the design check-in", () => {
  const design = (fields: Partial<Task> = {}) => task({ id: "1", kind: "design", status: "triage", by: MERGE, ...fields });
  const asked = (fields: Partial<Task> = {}) => design({ status: "question", history: [ASKED], ...fields });

  test("the planner raises it, and does nothing else with it", () => {
    const fresh = design();
    assert.equal(statusRefusal(fresh, "question", "planner", [fresh]), null);
    for (const to of ["proposed", "rejected", "blocked"] as const)
      assert.match(statusRefusal(fresh, to, "planner", [fresh]) ?? "", /is the design check-in, which only the operator settles: raise it once/, to);
    assert.match(statusRefusal(fresh, "done", "planner", [fresh]) ?? "", /is done on the operator's word/);
    for (const to of ["proposed", "approved", "rejected", "blocked"] as const)
      assert.match(statusRefusal(asked(), to, "planner", [asked()]) ?? "", /is the design check-in/, to);
  });

  test("it's done on the operator's answer, and goes back to the planner on one that asks for changes", () => {
    const waiting = asked();
    assert.match(statusRefusal(waiting, "done", "planner", [waiting]) ?? "", /is done on the operator's word/);
    assert.match(statusRefusal(waiting, "triage", "planner", [waiting]) ?? "", /the operator hasn't answered #1 yet/);
    const answered = asked({ notes: [ANSWER] });
    assert.equal(statusRefusal(answered, "done", "planner", [answered]), null);
    assert.equal(statusRefusal(answered, "triage", "planner", [answered]), null);
    // An answer to an earlier round doesn't settle the one asked since.
    const again = asked({ notes: [{ ...ANSWER, at: at(2) }] });
    assert.match(statusRefusal(again, "done", "planner", [again]) ?? "", /is done on the operator's word/);
    // The way back is the check-in's alone.
    const question = task({ id: "2", kind: "research", status: "question", history: [ASKED], notes: [ANSWER] });
    assert.match(statusRefusal(question, "triage", "planner", [question]) ?? "", /isn't the design check-in/);
  });

  test("the operator settles it whenever they like; the approver and the merge queue never do", () => {
    for (const to of ["done", "rejected"] as const) assert.equal(statusRefusal(design(), to, OPERATOR, [design()]), null);
    const proposed = design({ status: "proposed", by: OPERATOR });
    for (const via of ["approve", "reject", "research", "escalate"] as const) {
      const to = { approve: "approved", reject: "rejected", research: "researching", escalate: "question" } as const;
      assert.match(moveRefusal(proposed, to[via], via, "approver", { all: [proposed] }) ?? "", /is the design check-in: the operator settles it/, via);
    }
    assert.match(moveRefusal(asked(), "done", "merge", MERGE, { all: [asked()] }) ?? "", /is the design check-in, done on the operator's word/);
  });
});

describe("a6g task and the design check-in", () => {
  function setup() {
    const home = makeRepo(baseTeam({ roles: ROLES, operator: { designCheckIn: true } }));
    const run = tmp("a6g-run-");
    const as = (role: string | null, cwd = home) => ({
      cwd,
      env: role ? { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: role, A6G_RUN: run } : { A6G_RUN: run },
    });
    // A member's own worktree, as T3 Code makes it: claims are made from one.
    const worktree = (name: string) => {
      const dir = join(tmp("a6g-wt-"), name);
      git(home, "worktree", "add", "-q", "-b", `wt/${name}`, dir, "a6g/next");
      return realpathSync(dir);
    };
    return { home, as, worktree, store: fileStore(run, "fixture") };
  }

  test("it's filed once, for the planner, and never again once it's settled", async () => {
    const { home, store } = setup();
    const team = loadTeam(home);
    assert.equal(await fileDesignCheckIn(store, team), "1");
    const filed = await store.tasks.get("1");
    assert.deepEqual([filed?.kind, filed?.status, filed?.by], ["design", "triage", MERGE]);
    assert.match(filed?.body ?? "", /raise it: a6g task status <this task> question/);
    assert.equal(await fileDesignCheckIn(store, team), null);
    await store.tasks.replace({ ...(filed as Task), status: "done" });
    assert.equal(await fileDesignCheckIn(store, team), null, "asked once");
    const off = fileStore(tmp("a6g-run-"), "fixture");
    assert.equal(await fileDesignCheckIn(off, loadTeam(makeRepo(baseTeam({ roles: ROLES })))), null);
    assert.deepEqual(await off.tasks.all(), []);
  });

  test("the round: the foundation is built, the planner asks, the operator answers, features start", async () => {
    const { home, as, worktree, store } = setup();
    const tree = worktree("b1");
    await fileDesignCheckIn(store, loadTeam(home));
    await store.tasks.createAs("2", newTask({ team: "fixture", title: "Skeleton", kind: "scaffold", status: "approved", by: "planner" }));
    await store.tasks.createAs("3", newTask({ team: "fixture", title: "Sign-in", kind: "feature", status: "approved", by: "planner" }));
    const listed = await a6g(["task", "list", "--claimable"], as("builder"));
    assert.doesNotMatch(listed.out, /Sign-in/);
    const refused = await a6g(["task", "claim", "3"], as("builder", tree));
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /task 3 waits for the operator to agree the design \(#1, triage\)/);
    assert.match((await a6g(["task", "list", "--claimable"], as("scaffolder"))).out, /Skeleton/);

    // A member can't add one (it would hold the team's work), and there's one at a time.
    const members = await a6g(
      ["task", "add", "Rethink it all", "--kind", "design", "--body", "I'd rather it were written in another language."],
      as("builder")
    );
    assert.match(members.out, /the design check-in is the planner's to add \(or the operator's\); you're the builder/);
    assert.match((await a6g(["task", "add", "Another", "--kind", "design"], as("planner"))).out, /#1 is the design check-in already \(triage\)/);
    assert.match((await a6g(["task", "edit", "1", "--kind", "chore"], as("planner"))).out, /#1 is the design check-in, which the operator settles/);
    assert.match((await a6g(["task", "edit", "3", "--kind", "design"], as("planner"))).out, /the design check-in is a task of its own/);

    assert.match((await a6g(["task", "status", "1", "done"], as("planner"))).out, /is done on the operator's word/);
    const raised = await a6g(
      [
        "task",
        "status",
        "1",
        "question",
        "--reason",
        "The skeleton runs end to end; docs/architecture.md has each choice. (a) agreed as built (b) change something",
        "--recommend",
        "(a) agreed as built",
      ],
      as("planner")
    );
    assert.equal(raised.code, 0, raised.out);
    // The operator reads what was asked once: the note and the history entry that repeat it point to it.
    const shown = (await a6g(["task", "show", "1"], as(null))).out;
    assert.equal(shown.split("The skeleton runs end to end").length - 1, 1, shown);
    assert.match(shown, /raised to the operator by the planner: The skeleton runs end to end/);
    assert.match(shown, /planner: triage → question: \(as raised, above\)/);
    assert.match(shown, /Yours to answer: a6g task answer 1 "<your answer>"/);
    assert.doesNotMatch((await a6g(["task", "show", "1"], as("planner"))).out, /Yours to answer/);
    assert.match((await a6g(["task", "status", "1", "done"], as("planner"))).out, /is done on the operator's word/);

    // The answer is the operator's to give, in words, from the terminal as from the web app; no member gives it for them.
    const posed = await a6g(["task", "answer", "1", "(a) agreed as built"], as("planner"));
    assert.equal(posed.code, 2);
    assert.match(posed.out, /only the operator answers what waits on them/);
    assert.match((await a6g(["task", "answer", "1"], as(null))).out, /say what your answer is/);
    assert.match((await a6g(["task", "answer", "3", "Go on"], as(null))).out, /#3 is approved now and doesn't wait on an answer/);
    assert.match((await a6g(["task", "status", "1", "done"], as("planner"))).out, /is done on the operator's word/);

    // Changes asked for: back to the planner, made as scaffold work, and asked again.
    const changes = await a6g(["task", "answer", "1", "(b) Use the managed database instead of the container."], as(null));
    assert.equal(changes.code, 0, changes.out);
    assert.match(changes.out, /task 1: answered\. The planner hears within a minute/);
    const heard = answersSince(await store.tasks.all(), new Date(0).toISOString());
    assert.deepEqual(
      heard.map((a) => [a.task.id, a.note.by, a.note.text]),
      [["1", OPERATOR, "(b) Use the managed database instead of the container."]],
      "the watchdog passes it to the planner, as it does an answer from the web app"
    );
    assert.equal((await a6g(["task", "status", "1", "triage"], as("planner"))).code, 0);
    assert.match((await a6g(["task", "claim", "3"], as("builder", tree))).out, /waits for the operator to agree the design \(#1, triage\)/);
    await a6g(
      ["task", "status", "1", "question", "--reason", "Now on the managed database. (a) agreed (b) change", "--recommend", "(a) agreed"],
      as("planner")
    );
    assert.match(
      (await a6g(["task", "status", "1", "done"], as("planner"))).out,
      /is done on the operator's word/,
      "the earlier answer was to the earlier round"
    );
    await answer(store, "1", { who: OPERATOR, text: "(a) agreed" });
    const closed = await a6g(["task", "status", "1", "done"], as("planner"));
    assert.equal(closed.code, 0, closed.out);
    assert.match((await a6g(["task", "list", "--claimable"], as("builder"))).out, /Sign-in/);

    // Or the operator just says so.
    const direct = setup();
    await addTask(direct.store, "fixture", { title: "Design check-in", kind: "design" }, OPERATOR);
    assert.equal((await a6g(["task", "status", "1", "done", "--reason", "read the record; go"], direct.as(null))).code, 0);
  });
});

describe("the watchdog while the design waits for the operator", () => {
  const ticks = (w: { calls: () => string[] }) => w.calls().filter((c) => /thread send mcp:planner tick/.test(c));
  async function world(tasks: Task[]) {
    const w = await fakeWorld(baseTeam({ roles: ROLES, operator: { designCheckIn: true } }));
    const file = join(w.a6gHome, "teams", "fixture.json");
    write(join(w.a6gHome, "teams"), {
      "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "files", database: "a6g", lead: null } },
    });
    write(w.run, { "planner-thread": "mcp:planner\n" });
    const store = fileStore(w.run, "fixture");
    for (const { id, version: _v, ...fields } of tasks) await store.tasks.createAs(id, fields);
    // The last tick was `min` minutes ago.
    const ticked = (min: number) => {
      const stamp = join(w.run, ".stamp-tick");
      writeFileSync(stamp, "");
      utimesSync(stamp, new Date(Date.now() - min * 60_000), new Date(Date.now() - min * 60_000));
    };
    return { w, store, ticked };
  }
  const QUESTION = task({ id: "1", kind: "design", status: "question", title: "Design check-in" });
  const FEATURE = task({ id: "3", title: "Sign-in" });

  test("the tick slows to an hour: nothing can be built, and the answer wakes the planner by itself", async () => {
    const { w, ticked } = await world([QUESTION, task({ id: "2", kind: "scaffold", status: "done" }), FEATURE]);
    try {
      ticked(15);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.deepEqual(ticks(w), [], "a quarter of an hour after the last tick, none is sent");
      ticked(61);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.equal(ticks(w).length, 1);
      assert.match(ticks(w)[0] ?? "", /hourly: the team waits for the operator's word on the design/);
      assert.match(readFileSync(join(w.run, "watchdog.log"), "utf8"), /hourly tick \(the design check-in waits for the operator\)/);
    } finally {
      await w.close();
    }
  });

  test("it keeps its pace while the foundation is still being built, and once the check-in is settled", async () => {
    for (const tasks of [
      [QUESTION, task({ id: "2", kind: "test-infra", status: "approved" }), FEATURE],
      [{ ...QUESTION, status: "triage" as const }, task({ id: "2", kind: "scaffold", status: "done" }), FEATURE],
      [{ ...QUESTION, status: "done" as const }, FEATURE],
    ]) {
      const { w, ticked } = await world(tasks);
      try {
        ticked(15);
        assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
        assert.equal(ticks(w).length, 1, tasks.map((t) => `${t.kind} ${t.status}`).join(", "));
        assert.doesNotMatch(ticks(w)[0] ?? "", /hourly/);
      } finally {
        await w.close();
      }
    }
  });
});

describe("register", () => {
  test("files the check-in where the operator asked for one, says so, and files it once", async () => {
    const w = await fakeWorld(baseTeam({ roles: ROLES, operator: { designCheckIn: true } }), { register: false });
    try {
      mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
      const first = await w.a6g("register", w.home);
      assert.equal(first.code, 0, first.out);
      assert.match(first.out, /^ {2}the design check-in is #\d+: the team builds the foundation, then asks you; features wait until you've agreed it$/m);
      const store = fileStore(w.run, "fixture");
      assert.equal((await store.tasks.all()).filter((t) => t.kind === "design").length, 1);
      const again = await w.a6g("register", w.home, "--force");
      assert.equal(again.code, 0, again.out);
      assert.doesNotMatch(again.out, /the design check-in is #/);
      assert.equal((await store.tasks.all()).filter((t) => t.kind === "design").length, 1);
    } finally {
      await w.close();
    }
  });

  test("files none on a team that asked for none", async () => {
    const w = await fakeWorld(baseTeam({ roles: ROLES }), { register: false });
    try {
      mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
      const result = await w.a6g("register", w.home);
      assert.equal(result.code, 0, result.out);
      assert.equal((await fileStore(w.run, "fixture").tasks.all()).filter((t) => t.kind === "design").length, 0);
    } finally {
      await w.close();
    }
  });
});

describe("a6g init and who the team works for", { concurrency: true }, () => {
  const NEW = { "README.md": "# Greenhouse\n", LICENSE: "MIT\n", "docs/idea.md": "Sensors, then a page.\n", ".gitignore": "node_modules\n" };
  const drafted = (checkout: string) => JSON.parse(readFileSync(join(checkout, ".a6g", "team.json"), "utf8")) as RawTeam;

  test("nothing built yet is a new project: documents, pictures and dot-files only, committed or not", () => {
    const repo = gitRepo(join(tmp("a6g-new-"), "greenhouse"), NEW);
    write(repo, { "sketch.png": "\n", "notes.txt": "MQTT?\n" });
    assert.equal(detect(repo).empty, true);
    write(repo, { "firmware/main.c": "int main(void) { return 0; }\n" });
    assert.equal(detect(repo).empty, false, "a source file nobody committed is still something built");
    assert.equal(detect(tmp("a6g-not-a-repo-")).empty, false, "a folder git can't list isn't known to be empty");
  });

  test("its draft holds a design check-in for a technical operator, and none for one who isn't", () => {
    const found = detect(gitRepo(join(tmp("a6g-new-"), "greenhouse"), NEW));
    const draft = draftTeam(found, { name: "greenhouse", branch: "a6g/next" });
    assert.deepEqual(draft.operator, { designCheckIn: true });
    const { team, problems, warnings } = normalize(JSON.parse(JSON.stringify(draft)), "/tmp/x");
    assert.deepEqual([problems, warnings.filter((w) => /operator/.test(w))], [[], []]);
    assert.deepEqual(team.operator, { technical: true, designCheckIn: true });
    assert.ok(team.roles.scaffolder, "with the scaffolder who builds what's checked");
    assert.deepEqual(draftTeam(found, { name: "greenhouse", branch: "a6g/next", technical: false }).operator, { technical: false });
    const built = detect(gitRepo(join(tmp("a6g-built-"), "shop"), { "package.json": { name: "shop", scripts: { dev: "vite" } }, "src/main.ts": "\n" }));
    assert.equal(draftTeam(built, { name: "shop", branch: "a6g/next" }).operator, undefined, "a repository with a stack says nothing");
    assert.deepEqual(draftTeam(built, { name: "shop", branch: "a6g/next", technical: false }).operator, { technical: false });
  });

  test("init says which it drafted, and --non-technical drafts a team that never asks about the stack", async () => {
    const m = machine();
    const repo = gitRepo(join(tmp("a6g-new-"), "greenhouse"), NEW);
    const made = await a6g(["init", repo, "--no-interview"], { cwd: repo, env: m.env });
    assert.equal(made.code, 0, made.out);
    assert.match(
      made.out,
      /^a6g: nothing is built here yet, so the draft team builds the foundation, then checks its design with you before any feature$/m
    );
    assert.deepEqual(drafted(`${repo}-a6g`).operator, { designCheckIn: true });
    const other = gitRepo(join(tmp("a6g-new-"), "orchard"), NEW);
    const plain = await a6g(["init", other, "--non-technical", "--no-interview"], { cwd: other, env: m.env });
    assert.equal(plain.code, 0, plain.out);
    assert.match(
      plain.out,
      /^a6g: the draft team chooses the platform and the stack itself, the safer way each time, and asks you only about the product$/m
    );
    assert.doesNotMatch(plain.out, /checks its design with you/);
    assert.deepEqual(drafted(`${other}-a6g`).operator, { technical: false });
  });

  test("the interview runs on Fable unless --model names another, and is told a new project from an old one", async () => {
    const m = machine();
    // A claude that writes down what it was started with, one argument a line.
    writeFileSync(join(m.bin, "claude"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$A6G_TEST_ARGS"\n');
    chmodSync(join(m.bin, "claude"), 0o755);
    const started = async (repo: string, ...options: string[]) => {
      const args = join(tmp("a6g-args-"), "args");
      const result = await a6g(["init", repo, ...options], { cwd: repo, env: { ...m.env, A6G_TEST_ARGS: args } });
      assert.equal(result.code, 0, result.out);
      return readFileSync(args, "utf8").trimEnd().split("\n");
    };
    const fresh = await started(gitRepo(join(tmp("a6g-new-"), "greenhouse"), NEW));
    assert.equal(fresh[fresh.indexOf("--model") + 1], "claude-fable-5-1");
    assert.equal(fresh[fresh.indexOf("--agent") + 1], "a6g:setup");
    assert.match(fresh.at(-1) ?? "", /Nothing is built here yet: this is a new project, and its foundation is yours to propose\./);
    assert.doesNotMatch(fresh.at(-1) ?? "", /isn't technical/);
    const built = { "package.json": { name: "shop", scripts: { dev: "vite" } }, "src/main.ts": "\n" };
    const old = await started(gitRepo(join(tmp("a6g-built-"), "shop"), built), "--model", "Opus", "--non-technical");
    assert.equal(old[old.indexOf("--model") + 1], "claude-opus-5-5");
    assert.doesNotMatch(old.at(-1) ?? "", /Nothing is built here yet/);
    assert.match(old.at(-1) ?? "", /The draft says the operator isn't technical \(operator\.technical\): whoever started this said so, so it stands\./);
    const pinned = await started(gitRepo(join(tmp("a6g-built-"), "till"), built), "--model", "claude-sonnet-5-5");
    assert.equal(pinned[pinned.indexOf("--model") + 1], "claude-sonnet-5-5", "an id is taken as written");
    const repo = gitRepo(join(tmp("a6g-built-"), "stall"), built);
    const refused = await a6g(["init", repo, "--model", "opus; rm -rf ~"], { cwd: repo, env: m.env });
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--model opus; rm -rf ~: a model's name \(fable, opus, sonnet, haiku\) or its id/);
  });
});
