// a6g decision and a6g agreement (lib/commands/decision.ts, agreement.ts), how the watchdog delivers a new agreement
// and an overturned decision (lib/holds.ts, lib/reviews.ts), and what the planner reads of them: its compiled rules
// (lib/prompts.ts) and its context every wake (plugin/hooks/context.ts).
import { a6g, baseTeam, bash, holds as guardHolds, makeRepo, ROOT, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam, type RawTeam } from "../lib/config.ts";
import { agreementMessage, applied, applyControls, pendingNotes } from "../lib/holds.ts";
import { compile } from "../lib/prompts.ts";
import { applyReviews } from "../lib/reviews.ts";
import { DEFAULT_AGREEMENT } from "../lib/tasks/agreement.ts";
import { agreementControl, agreementOf, type Control, pauseControl, resumeControl, reviewControl } from "../lib/tasks/controls.ts";
import { recordDecision, requestReview } from "../lib/tasks/decisions.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask, OPERATOR } from "../lib/tasks/model.ts";
import { agreementContext } from "../lib/tasks/ops.ts";

function setup(raw: RawTeam = baseTeam({ board: "tasks" })) {
  const home = makeRepo(raw);
  const run = tmp("a6g-run-");
  const as = (role: string | null, cwd = home) => ({
    cwd,
    env: role ? { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: role, A6G_RUN: run } : { A6G_RUN: run },
  });
  return { home, run, as, store: () => fileStore(run, "fixture") };
}

const RECORD = [
  "decision",
  "record",
  "Which empty state for the orders list?",
  "--decided",
  "A line and a button",
  "--because",
  "the direction puts first-time owners first",
];
const JUDGED = (topic: string, stakes: string, confidence: string): string[] => ["--topic", topic, "--stakes", stakes, "--confidence", confidence];

describe("a6g decision", () => {
  test("route says what the agreement does with a question, and the command that follows", async () => {
    const { as, store } = setup();
    const asked = await a6g(["decision", "route", ...JUDGED("product", "high", "low")], as("planner"));
    assert.equal(asked.code, 0, asked.out);
    assert.match(
      asked.out,
      /^asked: balanced: high stakes with low confidence is asked \(the default agreement\)\.\nRaise it: a6g task status <id> question --topic product/
    );
    const told = await a6g(["decision", "route", ...JUDGED("product", "high", "medium")], as("builder"));
    assert.match(told.out, /^decided and flagged: .*\nDecide it, and record it: a6g decision record .*\nIt's flagged for the operator/);
    assert.match(
      (await a6g(["decision", "route", "--topic", "pricing"], as("planner"))).out,
      /decision: say what the question is about: --topic product\|scope/
    );
    // The operator stops being asked about the product: the same question is the team's.
    const set = await store().controls.create(agreementControl("fixture", OPERATOR, { level: "balanced", topics: { product: "decide" }, notes: "" }));
    assert.match(
      (await a6g(["decision", "route", ...JUDGED("product", "high", "low")], as("planner"))).out,
      new RegExp(`^decided and flagged: the agreement never asks about product; .* \\(agreement ${set.id}\\)`)
    );
  });

  test("the planner records a decision: it's in the log, and its line in decisions.md", async () => {
    const { home, as, store } = setup();
    await a6g(["task", "add", "Orders list"], as("planner"));
    const recorded = await a6g(
      [...RECORD, ...JUDGED("design", "high", "medium"), "--options", "Nothing | A line and a button", "--task", "1", "--undo", "revert #1"],
      as("planner")
    );
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.out, /^d1 recorded: decided and flagged \(balanced: high stakes with medium confidence is decided and flagged\)\./);
    assert.match(recorded.out, /Its line is in \.a6g\/decisions\.md: commit it/);
    assert.match(recorded.out, /flagged for the operator: name it in your next message/);
    const d = await store().decisions.get("d1");
    assert.deepEqual([d?.route, d?.options, d?.tasks, d?.undo, d?.agreement], ["tell", ["Nothing", "A line and a button"], ["1"], "revert #1", null]);
    assert.equal(
      readFileSync(join(home, ".a6g", "decisions.md"), "utf8"),
      "# Decisions\n\nOne line each: the question, the decision, and the direction or earlier decision it follows.\n\n- Which empty state for the orders list → A line and a button. Because the direction puts first-time owners first. (planner, d1, task 1)\n"
    );
    // A second is added under the first, to a file the planner has tidied since.
    write(home, { ".a6g/decisions.md": "# Decisions\n\n- Empty states say what will appear. (planner)" });
    assert.equal((await a6g([...RECORD, ...JUDGED("design", "low", "high")], as("planner"))).code, 0);
    assert.match(
      readFileSync(join(home, ".a6g", "decisions.md"), "utf8"),
      /what will appear\. \(planner\)\n- Which empty state for the orders list → .* \(planner, d2\)\n$/
    );
  });

  test("what the agreement makes the operator's isn't recorded, nor is anyone else's decision", async () => {
    const { home, as, store } = setup();
    const theirs = await a6g([...RECORD, ...JUDGED("product", "high", "low")], as("planner"));
    assert.equal(theirs.code, 2);
    assert.match(
      theirs.out,
      /decision: this one is the operator's to decide \(balanced: high stakes with low confidence is asked\): raise it instead: a6g task status <id> question --topic product/
    );
    // A change of scope is theirs however sure the team is, until their agreement says otherwise.
    assert.match(
      (await a6g([...RECORD, ...JUDGED("scope", "low", "high")], as("planner"))).out,
      /the operator's to decide \(the agreement always asks about scope\)/
    );
    assert.match((await a6g([...RECORD, ...JUDGED("rules", "low", "high")], as("planner"))).out, /rules is always the operator's \(Article 3\)/);
    assert.match(
      (await a6g([...RECORD, ...JUDGED("design", "low", "high")], as("builder"))).out,
      /the planner records what it decides for the operator; you're the builder/
    );
    assert.match((await a6g([...RECORD], as("planner"))).out, /--topic product\|scope/);
    assert.match(
      (await a6g([...RECORD, ...JUDGED("design", "low", "high"), "--sev", "minor"], as("planner"))).out,
      /a6g decision record takes --decided, .* not --sev/
    );
    assert.deepEqual(await store().decisions.all(), []);
    assert.ok(!existsSync(join(home, ".a6g", "decisions.md")));
  });

  test("a team whose operator isn't technical records the stack rather than asking", async () => {
    const { as, store } = setup(baseTeam({ board: "tasks", operator: { technical: false } }));
    const recorded = await a6g(
      [
        "decision",
        "record",
        "Postgres or SQLite?",
        "--decided",
        "Postgres, managed",
        "--because",
        "the safer choice",
        ...JUDGED("technical", "high", "low"),
      ],
      as("planner")
    );
    assert.equal(recorded.code, 0, recorded.out);
    assert.match((await store().decisions.get("d1"))?.rule ?? "", /the operator isn't technical/);
    // And is never asked it, whatever the grades.
    await a6g(["task", "add", "Pick a database"], as("planner"));
    assert.match(
      (await a6g(["task", "status", "1", "question", "--reason", "r", "--recommend", "Postgres", ...JUDGED("technical", "high", "low")], as("planner")))
        .out,
      /yours to decide \(the operator isn't technical/
    );
  });

  test("list and show say what was decided, why it wasn't asked, and where its review stands", async () => {
    const { as, store } = setup();
    await a6g([...RECORD, ...JUDGED("design", "low", "high")], as("planner"));
    await a6g(
      [
        "decision",
        "record",
        "Cap on uploads?",
        "--decided",
        "25 MB",
        "--because",
        "the brief's largest sample is 18 MB",
        ...JUDGED("product", "high", "medium"),
        "--undo",
        "raise the limit in config",
      ],
      as("planner")
    );
    const listed = (await a6g(["decision", "list"], as("reviewer"))).out.trimEnd().split("\n");
    assert.equal(listed.length, 2);
    assert.match(listed[0] ?? "", /^d1 +\d{4}-\d\d-\d\d design +Which empty state for the orders list\? → A line and a button$/);
    assert.match(listed[1] ?? "", /^d2 +\d{4}-\d\d-\d\d product +flagged to review +Cap on uploads\? → 25 MB$/);
    assert.equal((await a6g(["decision", "list", "--to-review"], as(null))).out.trimEnd().split("\n").length, 1);
    assert.equal((await a6g(["decision", "list", "--overturned"], as(null))).out.trim(), "no decisions");
    const shown = (await a6g(["decision", "show", "d2"], as(null))).out;
    assert.match(
      shown,
      /^d2 Cap on uploads\?\ndecided by the planner at .*: 25 MB\nbecause: the brief's largest sample is 18 MB\nproduct · stakes high · confidence medium\n/
    );
    assert.match(shown, /not asked: decided and flagged \(balanced: high stakes with medium confidence is decided and flagged; the default agreement\)/);
    assert.match(
      shown,
      /to undo: raise the limit in config\nflagged for the operator: not reviewed yet\n\nYours to review: a6g decision review d2 agree, or overturn --note/
    );
    assert.match((await a6g(["decision", "show", "d9"], as(null))).out, /decision: no decision d9/);
    assert.equal(JSON.parse((await a6g(["decision", "list", "--json"], as(null))).out).length, 2);

    // The operator overturns one: a control, pending until the team's machine writes it onto the record.
    assert.match((await a6g(["decision", "review", "d2", "overturn"], as(null))).out, /say what to do instead/);
    assert.match((await a6g(["decision", "review", "d2", "agree"], as("planner"))).out, /reviewing what was decided for the operator is the operator's/);
    const overturned = await a6g(["decision", "review", "d2", "overturn", "--note", "100 MB: people upload video."], as(null));
    assert.equal(overturned.code, 0, overturned.out);
    assert.match(overturned.out, /d2: overturned\. The planner hears within a minute/);
    assert.deepEqual(
      (await store().controls.all()).map((c) => [c.kind, c.by, c.review]),
      [["review", "operator", { decision: "d2", verdict: "overturned", note: "100 MB: people upload video." }]]
    );
    assert.match((await a6g(["decision", "list", "--overturned"], as(null))).out, /^d2 .* overturned \(not applied yet\)/);
    assert.match(
      (await a6g(["decision", "show", "d2"], as("planner"))).out,
      /the operator overturned it at .* \(not applied yet\): 100 MB: people upload video\./
    );
    assert.match((await a6g(["decision", "review", "d1", "agree"], as(null))).out, /d1: agreed\./);

    // The planner notes what it did about it.
    assert.match((await a6g(["decision", "note", "d2", "Raised", "to", "100", "MB", "in", "#7."], as("planner"))).out, /d2: note added/);
    assert.match((await a6g(["decision", "note", "d2", "x"], as("builder"))).out, /the planner notes what it did/);
    assert.match((await a6g(["decision", "show", "d2"], as(null))).out, /Notes:\n- .* planner: Raised to 100 MB in #7\./);
  });

  test("agreement shows the one in force, with the operator's standing instructions whole", async () => {
    const { as, store } = setup();
    assert.match(
      (await a6g(["decision", "agreement"], as("planner"))).out,
      /^The working agreement \(the default: the operator hasn't changed it\):\nLevel balanced: .*\nAlways asked: scope\. Always the operator's: privacy, rules\.\n\nNo standing instructions\.$/m
    );
    const set = await store().controls.create(
      agreementControl("fixture", "web:s2", { level: "hands-off", topics: { cost: "ask" }, notes: "Away until Monday.\nBatch everything." })
    );
    const shown = (await a6g(["decision", "agreement"], as("builder"))).out;
    assert.match(shown, new RegExp(`^The working agreement \\(${set.id}, set by the operator, on the web app at `));
    assert.match(
      shown,
      /Always asked: cost\. Always the operator's: privacy, rules\.\n\nThe operator's standing instructions:\n\nAway until Monday\.\nBatch everything\.$/m
    );
  });

  test("a team on a GitHub board keeps no decision log", async () => {
    const { as } = setup(baseTeam({ board: { github: {} } }));
    assert.match((await a6g(["decision", "list"], as("planner"))).out, /this team's board is GitHub issues .* so it keeps no decision log/);
    assert.match((await a6g(["decision"], as("planner"))).out, /^usage: a6g decision <command>/);
  });
});

describe("what the review of this work found", () => {
  test("a question the planner raised without a judgment is judged when it's raised again; the approver's and the operator's aren't", async () => {
    const { as, store } = setup();
    const at = "2026-11-01T00:00:00.000Z";
    // Imported from an old board as a question: no ask at all.
    const imported = await store().tasks.create(newTask({ team: "fixture", title: "Which carrier?", kind: "research", status: "question", by: "import" }));
    const again = ["task", "ask", imported.id, "--reason", "carriers differ by country", "--recommend", "(a) the national post"];
    assert.match((await a6g(again, as("planner"))).out, /say what the question is about: --topic product\|scope/);
    assert.match((await a6g([...again, ...JUDGED("product", "low", "low")], as("planner"))).out, /yours to decide/);
    assert.equal((await store().tasks.get(imported.id))?.ask ?? null, null, "refused, nothing raised");
    assert.equal((await a6g([...again, ...JUDGED("product", "high", "low")], as("planner"))).code, 0);
    assert.equal((await store().tasks.get(imported.id))?.ask?.rule, "balanced: high stakes with low confidence is asked");
    // The approver escalated this one, by the approval rules: the planner adds to it without routing it.
    const escalated = await store().tasks.create(
      newTask({
        team: "fixture",
        title: "A whole new area",
        kind: "feature",
        status: "question",
        by: "planner",
        ask: { reason: "over the size", recommendation: "build it", by: "approver", at },
      })
    );
    assert.equal((await a6g(["task", "ask", escalated.id, "--reason", "over the size", "--recommend", "split it first"], as("planner"))).code, 0);
    assert.equal((await store().tasks.get(escalated.id))?.ask?.rule, undefined);
    // The approver re-raising the planner's judged question keeps how it was judged.
    assert.equal((await a6g(["task", "ask", imported.id, "--reason", "carriers differ", "--recommend", "(b) a courier"], as("approver"))).code, 0);
    assert.deepEqual(
      [(await store().tasks.get(imported.id))?.ask?.by, (await store().tasks.get(imported.id))?.ask?.rule],
      ["approver", "balanced: high stakes with low confidence is asked"]
    );
  });

  test("a journey with finished work is raised as a matter of the team's rules, which every agreement asks", async () => {
    const { as, store } = setup();
    await store().controls.create(agreementControl("fixture", OPERATOR, { level: "hands-off", topics: { scope: "decide" }, notes: "" }));
    const journey = await store().tasks.create(
      newTask({ team: "fixture", title: "J1 · A donor gives", kind: "journey", status: "proposed", by: "planner" })
    );
    await store().tasks.create(
      newTask({
        team: "fixture",
        title: "The form",
        kind: "feature",
        status: "done",
        by: "planner",
        parent: journey.id,
        history: [{ at: "2026-11-01T00:00:00.000Z", by: "merge-queue", what: "review → done", from: "review", to: "done", sha: "abc" }],
      })
    );
    const refused = (await a6g(["task", "status", journey.id, "rejected", "--reason", "out of scope now"], as("planner"))).out;
    assert.match(
      refused,
      /rejecting it is the operator's call: raise it, as a matter of checking less \(a6g task status 1 question --topic rules --stakes … --confidence …/
    );
    const raise = ["task", "status", journey.id, "question", "--reason", "its tests are owed", "--recommend", "keep it"];
    assert.match((await a6g([...raise, ...JUDGED("scope", "high", "high")], as("planner"))).out, /yours to decide \(the agreement never asks about scope/);
    assert.equal((await a6g([...raise, ...JUDGED("rules", "medium", "high")], as("planner"))).code, 0);
    assert.match((await store().tasks.get(journey.id))?.ask?.rule ?? "", /rules is always the operator's/);
  });

  test("a note the planner wrote before the machine put an overturn on the record doesn't count as acting on it", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const d = await recordDecision(
      store,
      "fixture",
      { question: "Cap on uploads?", decision: "25 MB", because: "the brief" },
      { topic: "product", stakes: "low", confidence: "high" },
      "planner"
    );
    const asked = await requestReview(store, "fixture", { id: d.id, verdict: "overturned", note: "100 MB.", by: OPERATOR });
    // The operator has clicked; the planner, not yet told, notes something else on the record.
    await new Promise((done) => setTimeout(done, 5));
    await (await import("../lib/tasks/decisions.ts")).noteDecision(store, d.id, { who: "planner", text: "Config key is UPLOAD_MAX." });
    await new Promise((done) => setTimeout(done, 5));
    await applyReviews(run, store, [asked]);
    assert.match(agreementContext([], await store.decisions.all()), /Overturned by the operator, for you to act on and note .*: d1 "Cap on uploads\?"\.$/);
  });

  test("a team whose operator isn't technical is told the stack is never asked, and can't be set to ask it", async () => {
    const run = tmp("a6g-holds-");
    const first: Control = {
      ...agreementControl("fixture", OPERATOR, { level: "hands-on", topics: { technical: "ask", cost: "ask" }, notes: "" }),
      id: "k1",
      version: 1,
    };
    const text = applyControls(run, [first], { technical: false }).tell[0]?.text ?? "";
    assert.match(text, /Always asked: cost\. Never asked \(decided, and flagged when it matters\): technical\./);
    assert.doesNotMatch(text, /Always asked: [^.]*technical/);
  });
});

describe("the guard, the rules and the context", () => {
  test("only the planner records and notes; reviewing and setting the agreement are the operator's", async () => {
    const { home } = setup();
    await guardHolds([
      bash(home, "planner", 'a6g decision record "q" --decided "d" --because "b" --topic design --stakes low --confidence high', "allow"),
      bash(home, "planner", 'a6g decision note d1 "done"', "allow"),
      bash(home, "builder", 'a6g decision record "q" --decided "d" --because "b" --topic design --stakes low --confidence high', "refuse"),
      bash(home, "approver", 'a6g decision note d1 "done"', "refuse"),
      bash(home, "builder", "a6g decision list", "allow"),
      bash(home, "reviewer", "a6g decision show d1", "allow"),
      bash(home, "builder", "a6g decision route --topic design --stakes low --confidence high", "allow"),
      bash(home, "builder", "a6g decision agreement", "allow"),
      bash(home, "planner", "a6g decision review d1 agree", "refuse"),
      bash(home, "planner", "a6g agreement fixture --level hands-off", "refuse"),
      bash(home, "planner", "a6g agreement fixture", "refuse"),
    ]);
  });

  test("the planner's rules say what it judges, from the agreement's own constants; a non-technical operator's team never asks the stack", () => {
    const { home } = setup();
    const planner = compile(loadTeam(home), "planner");
    assert.match(planner, /## The working agreement\n\nHow readily you bring a question to the operator is theirs to set/);
    assert.match(planner, /\*\*Topic\*\* \(`--topic`\): `product` \(what a person sees or can do/);
    assert.match(planner, /\*\*Stakes\*\* \(`--stakes`\), what a wrong call costs: `low` \(a revert undoes it/);
    assert.match(planner, /\*\*Confidence\*\* \(`--confidence`\), .*: `high` \(the direction, a recorded decision or the brief says so\); `medium`/);
    assert.match(
      planner,
      /`privacy` and `rules` are always asked, whatever the agreement says \(Article 3\), and `scope` is asked until the operator's agreement says otherwise\.\n/
    );
    assert.match(planner, /`a6g decision route --topic … --stakes … --confidence …`, `a6g decision record/);
    assert.doesNotMatch(planner, /is never asked on this team/);
    for (const role of ["builder", "reviewer"]) assert.doesNotMatch(compile(loadTeam(home), role), /## The working agreement/);
    const plain = setup(baseTeam({ board: "tasks", operator: { technical: false } }));
    assert.match(compile(loadTeam(plain.home), "planner"), /`technical` is never asked on this team, whose operator isn't technical/);
    // A team on a GitHub board has no store to route by or to log in: its planner is told what to do by hand.
    const github = compile(loadTeam(setup(baseTeam({ board: { github: {} } })).home), "planner");
    assert.match(
      github,
      /## The working agreement\n\nThis team keeps its work on GitHub issues, which hold neither a working agreement nor a decision log/
    );
    assert.match(github, /Always ask about a change of scope, privacy and personal data, and the team's own rules/);
    assert.match(github, /write in `\.a6g\/decisions\.md` yourself, one line each/);
    assert.doesNotMatch(github, /a6g decision record/);

    // The articles the planner works under name the agreement and the log.
    assert.match(planner, /How readily it asks beyond\s+that is the team's working agreement, which the operator sets/);
    assert.match(planner, /What the team decides in the operator's place is recorded in its decision log/);
  });

  test("the agreement in force is in the planner's context, with the instructions and what was overturned", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    assert.equal(
      agreementContext([], []),
      "Working agreement (the default: the operator hasn't changed it). Level balanced: the team asks only when two options still fit and a wrong call would be costly. Always asked: scope. Always the operator's: privacy, rules."
    );
    await store.controls.create(
      agreementControl("fixture", "web:s2", {
        level: "hands-on",
        topics: { scope: "ask", design: "decide" },
        notes: "Away until Monday.\nBatch everything.",
      })
    );
    const d = await recordDecision(
      store,
      "fixture",
      { question: "Cap on uploads?", decision: "25 MB", because: "the brief" },
      { topic: "product", stakes: "low", confidence: "high" },
      "planner"
    );
    const asked = await requestReview(store, "fixture", { id: d.id, verdict: "overturned", note: "100 MB.", by: OPERATOR });
    await applyReviews(run, store, [asked]);
    const context = agreementContext(await store.controls.all(), await store.decisions.all(), { technical: false });
    const lines = context.split("\n");
    assert.match(
      lines[0] ?? "",
      /^Working agreement \(k1, set by the operator, on the web app at .*\)\. Level hands-on: .* Always asked: scope\. Never asked \(decided, and flagged when it matters\): design, technical\. Always the operator's: privacy, rules\.$/
    );
    assert.equal(lines[1], "The operator's standing instructions: Away until Monday.");
    assert.equal(lines[2], "Batch everything.");
    assert.equal(
      lines[3],
      'Overturned by the operator, for you to act on and note (a6g decision show <id>, then a6g decision note <id> "…"): d1 "Cap on uploads?".'
    );
    assert.match(
      agreementContext(
        [{ ...agreementControl("fixture", OPERATOR, { ...DEFAULT_AGREEMENT, notes: "x".repeat(40) }), id: "k9", version: 1 }],
        [],
        undefined,
        { notesMax: 10 }
      ),
      /instructions: x{10}… \(cut: a6g decision agreement shows them whole\)$/
    );
  });

  test("every wake, the hook gives the planner the agreement as it stands", async () => {
    const home = makeRepo(baseTeam({ board: "tasks" }));
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    await store.tasks.create(newTask({ team: "fixture", title: "Orders list", kind: "feature", status: "approved", by: "planner" }));
    await store.controls.create(
      agreementControl("fixture", OPERATOR, { level: "hands-off", topics: { cost: "ask" }, notes: "Never add a dependency without asking." })
    );
    const t3 = tmp("a6g-t3-");
    mkdirSync(join(t3, "userdata"));
    execFileSync("sqlite3", [join(t3, "userdata", "statev2.sqlite")], { input: readFileSync(join(ROOT, "test", "fake-t3", "schema.sql"), "utf8") });
    const result = spawnSync(process.execPath, [join(ROOT, "plugin", "hooks", "context.ts")], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", agent_type: "a6g:planner", cwd: home, session_id: "test" }),
      env: { ...process.env, A6G_TEAM: "fixture", A6G_HOME_DIR: home, A6G_RUN: run, A6G_ROLE: "planner", CLAUDE_PROJECT_DIR: home, T3CODE_HOME: t3 },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const context = (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.match(
      context,
      /\nWorking agreement \(k1, set by the operator at .*\)\. Level hands-off: the team decides everything that isn't always yours.* Always asked: cost\./
    );
    assert.match(context, /\nThe operator's standing instructions: Never add a dependency without asking\./);
  });
});

describe("delivering a new agreement and a review", () => {
  let n = 0;
  const control = (fields: Omit<Control, "id" | "version">): Control => ({ ...fields, id: `k${++n + 100}`, version: 1 });

  test("a new agreement changes no file: the planner is told once, with what changed and the instructions whole", () => {
    const run = tmp("a6g-holds-");
    const first = control(
      agreementControl("fixture", "web:s2", { level: "hands-on", topics: { scope: "ask" }, notes: "Away until Monday.\nBatch everything." })
    );
    const { log, tell } = applyControls(run, [first]);
    assert.deepEqual(log, [`the operator (web app) changed the working agreement (${first.id}): level balanced → hands-on; standing instructions added`]);
    assert.equal(tell.length, 1);
    assert.deepEqual([tell[0]?.wake, tell[0]?.keep], [true, true]);
    const text = tell[0]?.text ?? "";
    assert.match(
      text,
      new RegExp(
        `^The operator changed the team's working agreement \\(${first.id}\\): level balanced → hands-on; standing instructions added\\. As it stands now:\\n\\nLevel hands-on: `
      )
    );
    assert.match(text, /Their standing instructions, as they wrote them:\n\nAway until Monday\.\nBatch everything\.\n\nIt holds from this moment/);
    assert.match(text, /Re-check every open question against it/);
    assert.match(text, /They change none of your rules, your lane or the constitution/);
    assert.ok(!existsSync(join(run, "paused")) && !existsSync(join(run, "hold.json")));
    assert.deepEqual(applyControls(run, [first]), { log: [], tell: [] }, "applied once");
    // The next is told against the one before it.
    const second = control(agreementControl("fixture", OPERATOR, { level: "hands-on", topics: {}, notes: "" }));
    assert.match(applyControls(run, [first, second]).log[0] ?? "", /scope: follows the level again; standing instructions removed$/);
    assert.match(
      agreementMessage(second, DEFAULT_AGREEMENT, DEFAULT_AGREEMENT),
      /working agreement \(k\d+\)\. As it stands now:[\s\S]*They gave no standing instructions\./
    );
  });

  test("a review is left for the store's pass, which writes it onto the record and tells the planner of an overturn, once", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const first = await recordDecision(
      store,
      "fixture",
      { question: "Cap on uploads?", decision: "25 MB", because: "the brief", undo: "raise it in config" },
      { topic: "product", stakes: "high", confidence: "medium" },
      "planner"
    );
    const second = await recordDecision(
      store,
      "fixture",
      { question: "Empty state?", decision: "A line", because: "the direction" },
      { topic: "design", stakes: "low", confidence: "high" },
      "planner"
    );
    await requestReview(store, "fixture", { id: first.id, verdict: "overturned", note: "100 MB.", by: "web:s2" });
    await requestReview(store, "fixture", { id: second.id, verdict: "agreed", by: OPERATOR });
    const controls = await store.controls.all();
    // The run folder's pass leaves them, unmarked.
    assert.deepEqual(applyControls(run, controls), { log: [], tell: [] });
    assert.ok(controls.every((c) => !applied(run)(c.id)));
    const { log, tell } = await applyReviews(run, store, controls);
    assert.deepEqual(log, ["the operator (web app) overturned d1", "the operator agreed with d2"]);
    assert.equal(tell.length, 1, "an agreement changes nothing for the planner");
    assert.deepEqual([tell[0]?.wake, tell[0]?.keep], [true, true]);
    assert.match(
      tell[0]?.text ?? "",
      /^The operator overturned a decision the team made for them:\n\n1\. d1 \(product\) "Cap on uploads\?": you decided "25 MB"\. They wrote: 100 MB\.\n {3}To undo, the record says: raise it in config/
    );
    assert.deepEqual([(await store.decisions.get("d1"))?.review?.verdict, (await store.decisions.get("d2"))?.review?.verdict], ["overturned", "agreed"]);
    assert.ok(controls.every((c) => applied(run)(c.id)));
    assert.deepEqual(await applyReviews(run, store, controls), { log: [], tell: [] });
    // One that names nothing is logged and not tried again.
    const stray = await store.controls.create(reviewControl("fixture", OPERATOR, { decision: "d77", verdict: "agreed", note: "" }));
    assert.match((await applyReviews(run, store, [stray])).log[0] ?? "", /names a decision that isn't there \(d77\)/);
    assert.ok(applied(run)(stray.id));
  });
});

describe("a6g agreement, and the watchdog", () => {
  async function world() {
    const { fakeWorld } = await import("./fake-t3.ts");
    const w = await fakeWorld(baseTeam({ board: "tasks" }));
    const file = join(w.a6gHome, "teams", "fixture.json");
    write(join(w.a6gHome, "teams"), {
      "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "files", database: "a6g", lead: null } },
    });
    write(w.run, { "planner-thread": "mcp:planner\n" });
    return { w, store: fileStore(w.run, "fixture") };
  }

  test("the operator sets it, it holds at once, and the planner is told; shown alone, it says how it has gone", async () => {
    const { w, store } = await world();
    try {
      const shown = await w.a6g("agreement", "fixture");
      assert.equal(shown.code, 0, shown.out);
      assert.match(shown.out, /^fixture's working agreement \(the default: you haven't changed it\):\nLevel balanced: /);
      assert.match(shown.out, /The last 30 days: 0 asked of you, 0 decided for you \(0 flagged, 0 overturned\); 0 to review now/);

      const set = await w.a6g("agreement", "fixture", "--level", "hands-on", "--ask", "scope,cost", "--never", "design", "--notes", "Away until Monday.");
      assert.equal(set.code, 0, set.out);
      assert.match(
        set.out,
        /^a6g: fixture's working agreement is now k1: level balanced → hands-on; design: never asked; cost: always asked; standing instructions added\.\nLevel hands-on: /
      );
      assert.deepEqual(agreementOf(await store.controls.all()).agreement, {
        level: "hands-on",
        topics: { scope: "ask", design: "decide", cost: "ask" },
        notes: "Away until Monday.",
      });
      assert.ok(
        w.calls().some((c) => /thread send mcp:planner The operator changed the team's working agreement \(k1\): level balanced → hands-on/.test(c)),
        w.calls().join("\n")
      );
      assert.match(readFileSync(join(w.run, "watchdog.log"), "utf8"), /the operator changed the working agreement \(k1\)/);

      // The same again records nothing; a change builds on the one in force.
      assert.match((await w.a6g("agreement", "fixture", "--level", "hands-on")).out, /is that already; nothing was recorded/);
      const changed = await w.a6g("agreement", "fixture", "--follow", "cost", "--clear-notes");
      assert.match(changed.out, /is now k2: cost: follows the level again; standing instructions removed\./);
      assert.deepEqual(agreementOf(await store.controls.all()).agreement, { level: "hands-on", topics: { scope: "ask", design: "decide" }, notes: "" });
      const history = (await w.a6g("agreement", "fixture")).out;
      assert.match(history, /^fixture's working agreement \(k2, set by the operator at /);
      assert.match(
        history,
        /History:\n {2}k1 .* the operator: level balanced → hands-on; .*\n {2}k2 .* the operator: cost: follows the level again; standing instructions removed/
      );
      assert.match(
        (await w.a6g("agreement", "fixture", "--reset")).out,
        /is now k3: level hands-on → balanced; design: follows the level again\.\nLevel balanced: .*\nAlways asked: scope\./
      );

      // What it can't be.
      assert.match((await w.a6g("agreement", "fixture", "--level", "relaxed")).out, /Choose a level: hands-on, balanced, hands-off/);
      assert.match((await w.a6g("agreement", "fixture", "--ask", "privacy")).out, /--ask: privacy is always asked \(Article 3\)/);
      assert.match((await w.a6g("agreement", "fixture", "--never", "pricing")).out, /--never: there's no topic pricing/);
      assert.match((await w.a6g("agreement", "fixture", "--ask", "scope", "--never", "scope")).out, /scope is in both --ask and --never/);
      assert.match((await w.a6g("agreement", "fixture", "--notes", "x", "--clear-notes")).out, /one way: --notes, --notes-file or --clear-notes/);
      assert.match((await w.a6g("agreement", "nobody")).out, /no team named nobody/);
      assert.equal((await store.controls.all()).length, 3);
    } finally {
      await w.close();
    }
  });

  test("an agent on the team doesn't set it", async () => {
    const { w, store } = await world();
    try {
      const refused = await a6g(["agreement", "fixture", "--level", "hands-off"], {
        env: { ...w.env, A6G_TEAM: "fixture", A6G_ROLE: "planner", A6G_HOME_DIR: w.home, A6G_RUN: w.run },
      });
      assert.notEqual(refused.code, 0);
      assert.match(refused.out, /agreement is the operator's; an agent on a team/);
      assert.deepEqual(await store.controls.all(), []);
    } finally {
      await w.close();
    }
  });

  test("an overturn from the web app reaches the planner at the watchdog's next pass; a paused team's planner hears once it's resumed", async () => {
    const { w, store } = await world();
    try {
      const d = await recordDecision(
        store,
        "fixture",
        { question: "Cap on uploads?", decision: "25 MB", because: "the brief" },
        { topic: "product", stakes: "high", confidence: "medium" },
        "planner"
      );
      await requestReview(store, "fixture", { id: d.id, verdict: "overturned", note: "100 MB.", by: "web:s2" });
      // Any control the operator records applies what's waiting, as the watchdog's minute does.
      assert.equal((await w.a6g("agreement", "fixture", "--level", "hands-on")).code, 0);
      assert.equal((await store.decisions.get(d.id))?.review?.verdict, "overturned");
      assert.ok(
        w.calls().some((c) => /thread send mcp:planner The operator overturned a decision the team made for them/.test(c)),
        w.calls().join("\n")
      );

      // Paused: an agreement and an overturn ask for work, so they wait with the planner's other held messages.
      const sent = w.calls().length;
      await store.controls.create(pauseControl([], "fixture", { scope: "now", by: OPERATOR }));
      const second = await recordDecision(
        store,
        "fixture",
        { question: "Empty state?", decision: "A line", because: "the direction" },
        { topic: "design", stakes: "low", confidence: "high" },
        "planner"
      );
      await requestReview(store, "fixture", { id: second.id, verdict: "overturned", note: "Show samples.", by: OPERATOR });
      assert.equal((await w.a6g("agreement", "fixture", "--level", "hands-off")).code, 0);
      assert.ok(existsSync(join(w.run, "paused")));
      assert.ok(
        !w
          .calls()
          .slice(sent)
          .some((c) => /thread send mcp:planner The operator (changed|overturned)/.test(c)),
        w.calls().slice(sent).join("\n")
      );
      const held = pendingNotes(w.run);
      assert.equal(held.length, 2);
      assert.match(held[0] ?? "", /^The operator changed the team's working agreement \(k\d+\): level hands-on → hands-off/);
      assert.match(held[1] ?? "", /^The operator overturned a decision/);
      assert.equal((await store.decisions.get(second.id))?.review?.verdict, "overturned", "on the record all the same");

      // Resumed, and the agreement changed again in the same minute: what was kept goes first, in order, so the planner
      // ends on the agreement that stands.
      await store.controls.create(resumeControl("fixture", OPERATOR));
      const before = w.calls().length;
      assert.equal((await w.a6g("agreement", "fixture", "--level", "balanced")).code, 0);
      const told = w
        .calls()
        .slice(before)
        .filter((c) => c.includes("thread send mcp:planner"))
        .map(
          (c) =>
            /The operator (changed the team's working agreement \(k\d+\): level [a-z-]+ → [a-z-]+|overturned|resumed)/
              .exec(c)?.[1]
              ?.replace(/ \(k\d+\)/, "") ?? c
        );
      assert.deepEqual(told, [
        "changed the team's working agreement: level hands-on → hands-off",
        "overturned",
        "resumed",
        "changed the team's working agreement: level hands-off → balanced",
      ]);
      assert.deepEqual(pendingNotes(w.run), []);
    } finally {
      await w.close();
    }
  });
});
