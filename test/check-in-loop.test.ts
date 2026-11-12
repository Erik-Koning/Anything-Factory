// Closing the loop on the working agreement (docs/plans/decision-log.md, phase 4): how often a message may go, set in
// the agreement and followed by the guard, the planner's context and the watchdog; hints drawn from the operator's own
// reviews and answers; an answer that takes the recommendation; an escalation that says which approval rule sent it
// up; the check-ins among the quality numbers; and the decision log on a6g serve's page.
import { a6g, baseTeam, guard, makeRepo, ROOT, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startServer } from "../lib/commands/serve.ts";
import { loadTeam, type RawTeam } from "../lib/config.ts";
import { type Contact, contactInForce, contactStatus, recordSent } from "../lib/contact.ts";
import { applyControls, keepAgreement } from "../lib/holds.ts";
import { describeQuality, quality } from "../lib/quality.ts";
import { type Agreement, agreementChanges, agreementFrom, agreementLines, DEFAULT_AGREEMENT, everyWords, sameAgreement } from "../lib/tasks/agreement.ts";
import { answer } from "../lib/tasks/answer.ts";
import { agreementControl, agreementOf, type Control } from "../lib/tasks/controls.ts";
import { decide, escalationRule } from "../lib/tasks/decide.ts";
import { applyReview, calibrationHints, recordDecision, requestReview } from "../lib/tasks/decisions.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { type ApprovalRules, newTask, OPERATOR, type Score, type Status, type Task } from "../lib/tasks/model.ts";
import { compile } from "../lib/prompts.ts";
import { type Store, update } from "../lib/tasks/store.ts";

const made = (input: Parameters<typeof agreementFrom>[0]): Agreement => {
  const agreement = agreementFrom(input);
  if ("problem" in agreement) throw new Error(agreement.problem);
  return agreement;
};
const DIGEST: Contact = { mode: "digest", everyMin: 240 };
let k = 0;
const control = (fields: Omit<Control, "id" | "version">): Control => ({ ...fields, id: `k${++k}`, version: 1 });

function setup(raw: RawTeam = baseTeam({ board: "tasks" })) {
  const home = makeRepo(raw);
  const run = tmp("a6g-run-");
  const as = (role: string | null, cwd = home) => ({
    cwd,
    env: role ? { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: role, A6G_RUN: run } : { A6G_RUN: run },
  });
  return { home, run, as, store: () => fileStore(run, "fixture") };
}

describe("how often a message may go, as part of the agreement", () => {
  test("a digest with its window, each as it's needed, or the team's own setting; said in words", () => {
    const digest = made({ level: "balanced", contact: { mode: "digest", everyMin: 120 } });
    assert.deepEqual(digest.contact, { mode: "digest", everyMin: 120 });
    assert.deepEqual(made({ level: "balanced", contact: { mode: "priority", everyMin: 999 } }).contact, { mode: "priority", everyMin: 0 });
    for (const none of [undefined, null, "", "team"]) assert.equal("contact" in made({ level: "balanced", contact: none }), false);
    const problem = (contact: unknown): string => {
      const result = agreementFrom({ level: "balanced", contact });
      return "problem" in result ? result.problem : "";
    };
    assert.match(problem({ mode: "hourly" }), /Messages: a digest .*, as soon as they're needed, or as the team's own settings say/);
    assert.match(problem({ mode: "digest" }), /from 15 minutes to a week/);
    assert.match(problem({ mode: "digest", everyMin: 5 }), /from 15 minutes to a week/);
    assert.match(problem({ mode: "digest", everyMin: 7 * 24 * 60 + 1 }), /from 15 minutes to a week/);
    assert.equal(agreementLines(digest).at(-1), "Messages to the operator, by the agreement: a digest, at most one every 2 h.");
    assert.equal(agreementLines(DEFAULT_AGREEMENT).length, 2, "nothing said of messages while the team's own setting holds");
    assert.deepEqual(agreementChanges(DEFAULT_AGREEMENT, { ...DEFAULT_AGREEMENT, contact: { mode: "digest", everyMin: 90 } }), [
      "messages: a digest, at most one every 1.5 h",
    ]);
    assert.deepEqual(agreementChanges(digest, { ...digest, contact: { mode: "priority", everyMin: 0 } }), ["messages: each as soon as it's needed"]);
    assert.deepEqual(
      agreementChanges(digest, made({ level: "balanced" })),
      ["scope: always asked", "messages: as the team's own settings say again"].slice(1)
    );
    assert.ok(!sameAgreement(digest, made({ level: "balanced", contact: { mode: "digest", everyMin: 180 } })));
    assert.deepEqual([everyWords(30), everyWords(240), everyWords(1440), everyWords(2880)], ["30 min", "4 h", "1 d", "2 d"]);
    // Read back from a control whatever wrote it.
    assert.deepEqual(agreementOf([control(agreementControl("fixture", OPERATOR, digest))]).agreement.contact, { mode: "digest", everyMin: 120 });
  });

  test("the run folder keeps the agreement in force, and the rule in force is its, else the team's", () => {
    const run = tmp("a6g-run-");
    assert.deepEqual(contactInForce(run, DIGEST), DIGEST, "none kept: the team's own");
    assert.deepEqual(contactInForce(null, DIGEST), DIGEST);
    const first = control(agreementControl("fixture", OPERATOR, made({ level: "balanced", contact: { mode: "digest", everyMin: 60 } })));
    applyControls(run, [first]);
    assert.deepEqual(JSON.parse(readFileSync(join(run, "agreement.json"), "utf8")).control, first.id);
    assert.deepEqual(contactInForce(run, DIGEST), { mode: "digest", everyMin: 60 });
    const second = control(agreementControl("fixture", "web:s1", made({ level: "balanced", contact: { mode: "priority", everyMin: 0 } })));
    keepAgreement(run, [first, second]);
    assert.deepEqual(contactInForce(run, DIGEST), { mode: "priority", everyMin: 0 });
    // Back to the team's own setting: the agreement says nothing of messages.
    keepAgreement(run, [first, second, control(agreementControl("fixture", OPERATOR, made({ level: "hands-on" })))]);
    assert.deepEqual(contactInForce(run, DIGEST), DIGEST);
    // Nobody ever set one (a store started again): nothing is kept.
    keepAgreement(run, []);
    assert.ok(!existsSync(join(run, "agreement.json")));
    write(run, { "agreement.json": "{ not json" });
    assert.deepEqual(contactInForce(run, DIGEST), DIGEST, "unreadable: the team's own");
  });

  test("the guard holds the planner's email to the agreement's window, and its context says when the next may go", () => {
    const home = makeRepo();
    const run = tmp("a6g-run-");
    const send = "mcp__claude_ai_Gmail__send_message";
    const subject = { to: ["op@example.com"], subject: "[A6G-Planner] [Fixture team] one more question" };
    recordSent(run, "normal", new Date(Date.now() - 90 * 60_000));
    assert.equal(guard(home, "planner", send, subject, { run }).outcome, "refuse", "the team's own: one every 4 h");
    // The operator finds that too quiet: one an hour.
    keepAgreement(run, [control(agreementControl("fixture", OPERATOR, made({ level: "balanced", contact: { mode: "digest", everyMin: 60 } })))]);
    assert.equal(guard(home, "planner", send, subject, { run }).outcome, "allow");
    assert.match(contactStatus(contactInForce(run, DIGEST), run) ?? "", /^Messages to the operator \(digest, every 1 h\): the next can go now/);
    // Or too loud: one a day.
    keepAgreement(run, [control(agreementControl("fixture", OPERATOR, made({ level: "balanced", contact: { mode: "digest", everyMin: 1440 } })))]);
    const refused = guard(home, "planner", send, subject, { run });
    assert.equal(refused.outcome, "refuse");
    assert.match(refused.said, /one message every 24 h/);
    keepAgreement(run, [control(agreementControl("fixture", OPERATOR, made({ level: "balanced", contact: { mode: "priority", everyMin: 0 } })))]);
    assert.equal(guard(home, "planner", send, subject, { run }).outcome, "allow");
    assert.equal(contactStatus(contactInForce(run, DIGEST), run), null);
    assert.match(
      compile(loadTeam(home), "planner"),
      /Messages to the operator \(team\.json contact\), digest: .* Their working agreement may set this in its place/
    );
  });
});

describe("a6g agreement: messages and hints", () => {
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

  test("--messages sets how often a message may go, kept for the guard and told to the planner", async () => {
    const { w, store } = await world();
    try {
      const set = await w.a6g("agreement", "fixture", "--messages", "digest", "--every", "2h");
      assert.equal(set.code, 0, set.out);
      assert.match(
        set.out,
        /is now k1: messages: a digest, at most one every 2 h\.\n[\s\S]*Messages to the operator, by the agreement: a digest, at most one every 2 h\./
      );
      assert.deepEqual(agreementOf(await store.controls.all()).agreement, { ...DEFAULT_AGREEMENT, contact: { mode: "digest", everyMin: 120 } });
      assert.deepEqual(contactInForce(w.run, DIGEST), { mode: "digest", everyMin: 120 });
      assert.ok(
        w
          .calls()
          .some((c) =>
            /thread send mcp:planner The operator changed the team's working agreement \(k1\): messages: a digest, at most one every 2 h/.test(c)
          ),
        w.calls().join("\n")
      );
      // A change of level keeps it; --messages team gives it back to team.json.
      assert.equal((await w.a6g("agreement", "fixture", "--level", "hands-on")).code, 0);
      assert.deepEqual(agreementOf(await store.controls.all()).agreement.contact, { mode: "digest", everyMin: 120 });
      assert.match((await w.a6g("agreement", "fixture", "--messages", "priority")).out, /messages: each as soon as it's needed/);
      assert.match((await w.a6g("agreement", "fixture", "--messages", "team")).out, /messages: as the team's own settings say again/);
      assert.deepEqual(contactInForce(w.run, DIGEST), DIGEST);
      assert.match(
        (await w.a6g("agreement", "fixture", "--messages", "hourly")).out,
        /--messages digest --every <2h\|30m\|1d>, --messages priority, or --messages team/
      );
      assert.match((await w.a6g("agreement", "fixture", "--messages", "digest")).out, /a digest goes at most once per window/);
      assert.match((await w.a6g("agreement", "fixture", "--messages", "digest", "--every", "5m")).out, /from 15 minutes to a week/);
      assert.match((await w.a6g("agreement", "fixture", "--messages", "digest", "--every", "soon")).out, /--every: not a duration/);
      assert.match((await w.a6g("agreement", "fixture", "--every", "2h")).out, /--every is a digest's window/);
    } finally {
      await w.close();
    }
  });

  test("shown alone, it says what the operator's own reviews and answers suggest, with the command for each", async () => {
    const { w, store } = await world();
    try {
      const decide3 = async (topic: "design" | "product", n: number): Promise<string[]> => {
        const ids: string[] = [];
        for (let i = 0; i < n; i++)
          ids.push(
            (
              await recordDecision(
                store,
                "fixture",
                { question: `${topic} call ${i}`, decision: "x", because: "y" },
                { topic, stakes: "low", confidence: "high" },
                "planner"
              )
            ).id
          );
        return ids;
      };
      const design = await decide3("design", 3);
      for (const id of design.slice(0, 2)) await requestReview(store, "fixture", { id, verdict: "overturned", note: "No.", by: OPERATOR });
      await decide3("product", 2);
      const shown = (await w.a6g("agreement", "fixture")).out;
      assert.match(
        shown,
        /What your reviews and answers suggest \(yours to take or leave\):\n {2}You overturned 2 of the 3 design decisions the team made\. a6g agreement fixture --ask design\n/
      );
      assert.doesNotMatch(shown, /product decisions/);
    } finally {
      await w.close();
    }
  });
});

describe("hints from the operator's own reviews and answers", () => {
  const SINCE = "2026-01-01T00:00:00.000Z";
  async function graph() {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const decision = (topic: "design" | "product" | "cost" | "technical", stakes: "low" | "high" = "low") =>
      recordDecision(store, "fixture", { question: `a ${topic} call`, decision: "x", because: "y" }, { topic, stakes, confidence: "high" }, "planner");
    const overturn = async (id: string) =>
      applyReview(store, await requestReview(store, "fixture", { id, verdict: "overturned", note: "No.", by: OPERATOR }));
    const question = async (topic: "design" | "product" | "scope" | "cost", recommended: boolean) => {
      const at = new Date().toISOString();
      const task = await store.tasks.create(
        newTask({
          team: "fixture",
          title: `a ${topic} question`,
          kind: "feature",
          status: "question",
          by: "planner",
          ask: { reason: "r", recommendation: "(a) do it", by: "planner", at, topic },
        })
      );
      return answer(store, task.id, { who: OPERATOR, text: recommended ? "" : "Something else.", recommended });
    };
    const hints = async (agreement: Agreement = DEFAULT_AGREEMENT, operator = { technical: true }) =>
      calibrationHints(await store.decisions.all(), await store.tasks.all(), await store.controls.all(), agreement, SINCE, operator);
    return { store, decision, overturn, question, hints };
  }

  test("a topic they keep overturning is one to be asked about; one never asked goes back to the level", async () => {
    const { decision, overturn, hints } = await graph();
    const design = [await decision("design"), await decision("design"), await decision("design"), await decision("design"), await decision("design")];
    await overturn(design[0]?.id ?? "");
    assert.deepEqual(await hints(), [], "one overturn says little");
    await overturn(design[1]?.id ?? "");
    assert.deepEqual(await hints(), [
      { topic: "design", set: "ask", why: "You overturned 2 of the 5 design decisions the team made.", flag: "--ask design" },
    ]);
    assert.deepEqual(await hints(made({ level: "balanced", topics: { design: "decide" } })), [
      {
        topic: "design",
        set: "follow",
        why: "You overturned 2 of the 5 design decisions the team made, and it never asks about them.",
        flag: "--follow design",
      },
    ]);
    assert.deepEqual(await hints(made({ level: "balanced", topics: { design: "ask" } })), [], "asked already");
    // Two of seven is under a third: not enough to say so.
    await decision("design");
    await decision("design");
    assert.deepEqual(await hints(), []);
  });

  test("a topic where they take the recommendation every time is one the team could decide; scope goes to the level first", async () => {
    const { question, hints } = await graph();
    await question("product", true);
    await question("product", true);
    assert.deepEqual(await hints(), [], "two say little");
    await question("product", true);
    assert.deepEqual(await hints(), [
      {
        topic: "product",
        set: "decide",
        why: "You took the team's recommendation, as it stood, on all 3 product questions it asked.",
        flag: "--never product",
      },
    ]);
    for (let i = 0; i < 3; i++) await question("scope", true);
    assert.deepEqual(
      (await hints()).find((h) => h.topic === "scope"),
      {
        topic: "scope",
        set: "follow",
        why: "You took the team's recommendation, as it stood, on all 3 scope questions it asked, and it always asks about them.",
        flag: "--follow scope",
      }
    );
    // One answered another way, and the topic isn't suggested.
    await question("product", false);
    assert.deepEqual(
      (await hints()).map((h) => h.topic),
      ["scope"]
    );
  });

  test("across topics, a level closer; from hands-on, one wider; never what isn't the agreement's to set", async () => {
    const { decision, overturn, question, hints } = await graph();
    const calls = [await decision("design"), await decision("product"), await decision("cost"), await decision("design"), await decision("product")];
    for (const d of calls.slice(0, 3)) await overturn(d.id);
    assert.deepEqual(await hints(), [
      { topic: null, set: "hands-on", why: "You overturned 3 of the 5 decisions the team made, across topics.", flag: "--level hands-on" },
    ]);
    assert.deepEqual(
      (await hints(made({ level: "hands-off" }))).map((h) => h.flag),
      ["--level balanced"]
    );
    assert.deepEqual(await hints(made({ level: "hands-on" })), [], "no closer level than hands-on");
    // A non-technical operator's technical decisions are never theirs to be asked, however many they overturn.
    const stack = [await decision("technical"), await decision("technical")];
    for (const d of stack) await overturn(d.id);
    assert.ok(!(await hints(DEFAULT_AGREEMENT, { technical: false })).some((h) => h.topic === "technical"));
    assert.ok((await hints()).some((h) => h.topic === "technical" && h.set === "ask"));

    const other = await graph();
    for (const topic of ["design", "product", "cost", "design", "cost"] as const) await other.question(topic, true);
    assert.deepEqual(await other.hints(made({ level: "hands-on" })), [
      { topic: null, set: "balanced", why: "You took the team's recommendation, as it stood, on all 5 questions it asked.", flag: "--level balanced" },
    ]);
    assert.deepEqual(await other.hints(), [], "from balanced, only a topic is suggested");
  });
});

describe("what the review of this half found", () => {
  const SINCE = "2026-01-01T00:00:00.000Z";
  async function graph() {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const decision = (topic: "design" | "product" | "cost") =>
      recordDecision(
        store,
        "fixture",
        { question: `a ${topic} call`, decision: "x", because: "y" },
        { topic, stakes: "low", confidence: "high" },
        "planner"
      );
    const overturn = async (id: string) =>
      applyReview(store, await requestReview(store, "fixture", { id, verdict: "overturned", note: "No.", by: OPERATOR }));
    const ask = (topic: "design" | "product" | "cost") =>
      store.tasks.create(
        newTask({
          team: "fixture",
          title: `a ${topic} question`,
          kind: "feature",
          status: "question",
          by: "planner",
          ask: { reason: "r", recommendation: "(a) do it", by: "planner", at: new Date().toISOString(), topic },
        })
      );
    const hints = async (agreement: Agreement = agreementOf([]).agreement) =>
      calibrationHints(await store.decisions.all(), await store.tasks.all(), await store.controls.all(), agreement, SINCE);
    return { store, decision, overturn, ask, hints };
  }

  test("no wider level is suggested over overturned decisions", async () => {
    const { decision, overturn, ask, store, hints } = await graph();
    for (const topic of ["design", "product", "cost"] as const) await overturn((await decision(topic)).id);
    for (const topic of ["design", "product", "cost", "design", "product"] as const)
      await answer(store, (await ask(topic)).id, { who: OPERATOR, text: "", recommended: true });
    // Three of three overturned, across topics, on hands-on: there's no closer level, and it isn't the time for a wider one.
    assert.deepEqual(await hints(made({ level: "hands-on" })), []);
  });

  test("a hint counts only what happened under the agreement in force: taking it doesn't bring the next one along", async () => {
    const { decision, overturn, store, hints } = await graph();
    for (let i = 0; i < 3; i++) await overturn((await decision("design")).id);
    assert.deepEqual(
      (await hints()).map((h) => h.flag),
      ["--ask design"]
    );
    // The operator takes it. The same three overturns were what it was changed for: they suggest nothing more.
    await new Promise((done) => setTimeout(done, 5));
    const taken = made({ level: "balanced", topics: { scope: "ask", design: "ask" } });
    await store.controls.create(agreementControl("fixture", OPERATOR, taken));
    assert.deepEqual(await hints(taken), []);
    // What's decided and overturned from here on counts again.
    await new Promise((done) => setTimeout(done, 5));
    for (let i = 0; i < 3; i++) await overturn((await decision("product")).id);
    assert.deepEqual(
      (await hints(taken)).map((h) => h.flag),
      ["--ask product"]
    );
  });

  test("a question answered three times is one question", async () => {
    const { ask, store, hints } = await graph();
    const question = await ask("product");
    for (let i = 0; i < 3; i++) await answer(store, question.id, { who: OPERATOR, text: "", recommended: true });
    assert.deepEqual(await hints(), [], "one question says little, however often it was answered");
    // And its last answer is the one that counts.
    for (let i = 0; i < 2; i++) await answer(store, (await ask("product")).id, { who: OPERATOR, text: "", recommended: true });
    assert.deepEqual(
      (await hints()).map((h) => h.flag),
      ["--never product"]
    );
    await answer(store, question.id, { who: OPERATOR, text: "On second thought: (b)." });
    assert.deepEqual(await hints(), []);
  });

  test("the recommendation is taken as it stands: in the operator's own words it's their answer, wherever it's given", async () => {
    const { ask, store } = await graph();
    const question = await ask("design");
    await assert.rejects(
      answer(store, question.id, { who: OPERATOR, text: "No, do (b)", recommended: true }),
      /taken as it stands; to change it, say your answer in words/
    );
    assert.equal((await store.tasks.get(question.id))?.notes.length, 0);
  });

  test("a draft held under a longer window goes when the operator shortens it, rather than lapsing", async () => {
    const { sendOutbox } = await import("../lib/commands/watchdog.ts");
    const run = tmp("a6g-run-");
    const outbox = join(run, "outbox");
    write(outbox, { "2026-11-01-questions.md": "Subject: 2 questions\n\n1. …\n" });
    const draft = join(outbox, "2026-11-01-questions.md");
    const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);
    utimesSync(draft, hoursAgo(29), hoursAgo(29));
    recordSent(run, "normal", hoursAgo(30));
    const notified: string[] = [];
    const pass = (contact: Contact) =>
      sendOutbox(
        [],
        outbox,
        "Fixture team",
        "fixture",
        () => {},
        contact,
        (text) => notified.push(text)
      );
    // Three days' window: it waits, and the wait is marked.
    await pass({ mode: "digest", everyMin: 3 * 1440 });
    assert.deepEqual(notified, []);
    assert.equal(readFileSync(`${draft}.waited`, "utf8"), String(3 * 1440));
    // The operator finds that too quiet. More than a day old, it still goes.
    await pass({ mode: "priority", everyMin: 0 });
    assert.equal(notified.length, 1);
    assert.ok(existsSync(`${draft}.notified`));
    // One that never waited under a longer window is left after a day, as before.
    write(outbox, { "2026-11-02-old.md": "Subject: an old one\n\n…\n" });
    utimesSync(join(outbox, "2026-11-02-old.md"), hoursAgo(29), hoursAgo(29));
    await pass({ mode: "priority", everyMin: 0 });
    assert.equal(notified.length, 1);
  });

  test("a window that opens another day says which day", () => {
    const run = tmp("a6g-run-");
    // At noon, so an hour's window opens the same day whenever this runs.
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    recordSent(run, "normal", noon);
    const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const day = (ms: number): string => new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    const hour = noon.getTime() + 3_600_000;
    assert.equal(
      contactStatus({ mode: "digest", everyMin: 60 }, run, noon.getTime()),
      `Messages to the operator (digest, every 1 h): the next can go from ${time(hour)}; keep questions as question tickets until then.`
    );
    const three = noon.getTime() + 3 * 86_400_000;
    assert.equal(
      contactStatus({ mode: "digest", everyMin: 3 * 1440 }, run, noon.getTime()),
      `Messages to the operator (digest, every 72 h): the next can go from ${time(three)} on ${day(three)}; keep questions as question tickets until then.`
    );
  });
});

describe("an answer that takes the recommendation, and an escalation that says why", () => {
  test("a6g task answer --recommended says the team's recommendation, and the answer keeps that and its topic", async () => {
    const { as, store } = setup();
    await a6g(["task", "add", "Prices with tax?"], as("planner"));
    await a6g(
      [
        "task",
        "status",
        "1",
        "question",
        "--reason",
        "it changes what every owner sees",
        "--recommend",
        "(a) with tax",
        "--topic",
        "product",
        "--stakes",
        "high",
        "--confidence",
        "low",
      ],
      as("planner")
    );
    assert.match(
      (await a6g(["task", "answer", "1", "--recommended", "but", "only", "in", "Canada"], as(null))).out,
      /--recommended takes the team's recommendation as it stands/
    );
    const answered = await a6g(["task", "answer", "1", "--recommended"], as(null));
    assert.equal(answered.code, 0, answered.out);
    assert.match(answered.out, /task 1: answered with the team's recommendation \(\(a\) with tax\)/);
    const note = (await store().tasks.get("1"))?.notes.at(-1);
    assert.deepEqual(
      [note?.kind, note?.took, note?.topic, note?.text],
      ["answer", "recommendation", "product", "Go with your recommendation: (a) with tax"]
    );
    // In words, it's an answer like any other: its topic is kept, and nothing says it took the recommendation.
    await a6g(["task", "answer", "1", "With tax, but show both."], as(null));
    const second = (await store().tasks.get("1"))?.notes.at(-1);
    assert.deepEqual([second?.took, second?.topic], [undefined, "product"]);
    // The operator's own question carries no recommendation to take.
    await a6g(["task", "add", "Mine"], as("planner"));
    await a6g(["task", "status", "2", "question", "--reason", "I want to think"], as(null));
    assert.match((await a6g(["task", "answer", "2", "--recommended"], as(null))).out, /carries no recommendation to go with/);
  });

  test("an escalation carries the approval rule that sent it up, and what it's about when the approver says", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const approval: ApprovalRules = { mode: "thresholds", maxSize: "M", findings: "planner", stakeholders: "operator" };
    const score = (size: Score["size"]): Score => ({
      pain: 1,
      reach: 1,
      revenue: 1,
      wow: 1,
      distribution: 1,
      leverage: 1,
      urgency: 1,
      risk: 1,
      confidence: "asks",
      size,
      why: "w",
    });
    const add = (fields: Partial<Task> = {}, status: Status = "proposed") =>
      store.tasks.create(newTask({ team: "fixture", title: "t", kind: "feature", status, by: "planner", score: score("S"), ...fields }));
    const large = await decide(store, (await add({ score: score("L") })).id, "escalate", {
      who: "approver",
      approval,
      text: "over the size",
      recommendation: "build it",
    });
    assert.equal(large.ask?.rule, "the approval rules: size L is over this team's M (team.json approval)");
    assert.equal("agreement" in (large.ask ?? {}), false, "not routed by the agreement");
    const scoped = await decide(store, (await add()).id, "escalate", {
      who: "approver",
      approval,
      text: "a new area",
      recommendation: "later",
      topic: "scope",
    });
    assert.deepEqual(
      [scoped.ask?.rule, scoped.ask?.topic],
      ["the approver's own call: a change of scope, or something it judged the operator's", "scope"]
    );
    const risky = await add({ request: "r1", screen: { verdict: "risky", by: "planner", at: "x", note: "asks for an export" } });
    assert.equal(escalationRule(risky, "approver", approval), "the approval rules: work screened risky is the operator's to approve");
    const theirs = await add({ request: "r2", screen: { verdict: "clear", by: "planner", at: "x", note: "fine" } });
    assert.match(escalationRule(theirs, "approver", approval) ?? "", /work made of a stakeholder's words is the operator's to approve/);
    assert.equal(escalationRule(theirs, OPERATOR, approval), undefined, "the operator's own carries none");
    await assert.rejects(
      decide(store, (await add()).id, "escalate", { who: "approver", approval, text: "x", recommendation: "y", topic: "pricing" }),
      /--topic says what an escalation is about/
    );
    await assert.rejects(
      decide(store, (await add()).id, "reject", { who: "approver", approval, text: "x", topic: "scope" }),
      /--topic says what an escalation is about/
    );
  });

  test("the command line takes --topic on an escalation, and shows why it was asked", async () => {
    const { as, store } = setup(baseTeam({ board: "tasks", roles: { planner: {}, builder: {}, reviewer: {}, approver: {} } }));
    await store().tasks.create(newTask({ team: "fixture", title: "A whole new area", kind: "feature", status: "proposed", by: "planner" }));
    const escalated = await a6g(
      ["task", "escalate", "1", "--reason", "it changes who the product serves", "--recommend", "later", "--topic", "scope"],
      as("approver")
    );
    assert.equal(escalated.code, 0, escalated.out);
    assert.match(
      (await a6g(["task", "show", "1"], as(null))).out,
      /asked because: the approver's own call: a change of scope, or something it judged the operator's \(scope\)/
    );
  });
});

describe("the check-ins among the quality numbers", () => {
  test("what was raised and decided in the period, and what the operator said of it; nothing without the log", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const raised = (at: string, by = "planner") => ({ at, by, what: "proposed → question", from: "proposed", to: "question" });
    await store.tasks.create(
      newTask({ team: "fixture", title: "q", kind: "feature", status: "question", by: "planner", history: [raised("2026-03-05T00:00:00.000Z")] })
    );
    await store.tasks.create(
      newTask({ team: "fixture", title: "old", kind: "feature", status: "question", by: "planner", history: [raised("2026-02-05T00:00:00.000Z")] })
    );
    await store.tasks.create(
      newTask({
        team: "fixture",
        title: "mine",
        kind: "feature",
        status: "question",
        by: "planner",
        history: [raised("2026-03-06T00:00:00.000Z", OPERATOR)],
      })
    );
    const march = { since: Date.parse("2026-03-01"), until: Date.parse("2026-04-01") };
    const record = async (at: string, stakes: "low" | "high") => {
      const d = await recordDecision(
        store,
        "fixture",
        { question: "q", decision: "d", because: "b" },
        { topic: "design", stakes, confidence: "high" },
        "planner"
      );
      return store.decisions.replace({ ...d, at });
    };
    const flaggedOne = await record("2026-03-10T00:00:00.000Z", "high");
    const plain = await record("2026-03-11T00:00:00.000Z", "low");
    await record("2026-04-11T00:00:00.000Z", "high");
    await requestReview(store, "fixture", { id: flaggedOne?.id ?? "", verdict: "overturned", note: "No.", by: OPERATOR });
    await applyReview(store, await requestReview(store, "fixture", { id: plain?.id ?? "", verdict: "agreed", by: OPERATOR }));
    const log = { decisions: await store.decisions.all(), controls: await store.controls.all() };
    const q = quality(await store.tasks.all(), [], [], march, log);
    assert.deepEqual(q.checkIns, { asked: 1, decided: 2, flagged: 1, agreed: 1, overturned: 1 });
    assert.equal(
      describeQuality(q).at(-1),
      "Check-ins: 1 question raised to the operator; 2 decisions made for them (1 flagged; the operator agreed with 1 and overturned 1)"
    );
    assert.equal(
      describeQuality(quality([], [], [], march, { decisions: [], controls: [] })).at(-1),
      "Check-ins: 0 questions raised to the operator; 0 decisions made for them"
    );
    const without = quality(await store.tasks.all(), [], [], march);
    assert.equal(without.checkIns, null);
    assert.doesNotMatch(describeQuality(without).join("\n"), /Check-ins/);
  });

  test("a6g metrics --quality prints them", async () => {
    const { as, store } = setup();
    await recordDecision(
      store(),
      "fixture",
      { question: "q", decision: "d", because: "b" },
      { topic: "design", stakes: "high", confidence: "high" },
      "planner"
    );
    const shown = await a6g(["metrics", "--quality"], as("planner"));
    assert.equal(shown.code, 0, shown.out);
    assert.match(
      shown.out,
      /Check-ins: 0 questions raised to the operator; 1 decision made for them \(1 flagged; the operator agreed with 0 and overturned 0\)/
    );
    assert.deepEqual(JSON.parse((await a6g(["metrics", "--quality", "--json"], as("planner"))).out).checkIns, {
      asked: 0,
      decided: 1,
      flagged: 1,
      agreed: 0,
      overturned: 0,
    });
  });
});

describe("the decision log on a6g serve's page", () => {
  async function served() {
    const home = makeRepo(baseTeam({ board: "tasks" }));
    const run = tmp("a6g-run-");
    const server = await startServer({ home, run, team: loadTeam(home), host: "127.0.0.1", port: 0, token: null });
    return { home, run, store: fileStore(run, "fixture"), url: server.url, close: () => server.close() };
  }
  const post = (url: string, body: Record<string, string>) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("what's flagged waits with Agree and Overturn, under the agreement in force; the rest is on the record", async () => {
    const s = await served();
    try {
      assert.match(await (await fetch(s.url)).text(), /<h2>Decided for you<\/h2>[\s\S]*The team has decided nothing in your place yet\./);
      await s.store.controls.create(agreementControl("fixture", OPERATOR, made({ level: "hands-on", notes: "Never add a <dependency> without asking." })));
      const flaggedOne = await recordDecision(
        s.store,
        "fixture",
        {
          question: "Cap on <uploads>?",
          decision: "25 MB",
          because: "the brief's largest sample is 18 MB",
          options: ["10 MB", "25 MB"],
          undo: "raise it in config",
        },
        { topic: "product", stakes: "high", confidence: "high" },
        "planner"
      );
      const plain = await recordDecision(
        s.store,
        "fixture",
        { question: "Empty state?", decision: "A line", because: "the direction" },
        { topic: "design", stakes: "low", confidence: "high" },
        "planner"
      );
      const page = await (await fetch(s.url)).text();
      assert.match(page, /1 decided for you to review · /);
      const section = /<h2>Decided for you<\/h2>[\s\S]*?<\/section>/.exec(page)?.[0] ?? "";
      assert.match(
        section,
        /The working agreement \(k1\): Level hands-on: .* Your standing instructions: Never add a &lt;dependency&gt; without asking\. Change it with <code>a6g agreement fixture<\/code>/
      );
      assert.match(
        section,
        /<span class="title">Cap on &lt;uploads&gt;\?<\/span> <span class="chip">product<\/span><span class="chip status-question">flagged<\/span>/
      );
      assert.match(
        section,
        /The team decided:<\/b> 25 MB[\s\S]*Because:<\/b> the brief&#39;s largest sample is 18 MB[\s\S]*Weighed:<\/b> 10 MB · 25 MB[\s\S]*To undo:<\/b> raise it in config/
      );
      assert.match(
        section,
        /Why you weren't asked: hands-on: high stakes with high confidence is decided and flagged \(agreement k1; high stakes, high confidence\)/
      );
      assert.match(section, new RegExp(`action="/api/decisions/${flaggedOne.id}/agree"[\\s\\S]*action="/api/decisions/${flaggedOne.id}/overturn"`));
      assert.match(section, /<details><summary>On the record \(1\)<\/summary>[\s\S]*Empty state\?/);

      // Overturning needs what to do instead; with it, the review is a control, as from the web app.
      assert.equal((await post(`${s.url}/api/decisions/${flaggedOne.id}/overturn`, { note: " " })).status, 400);
      const overturned = await post(`${s.url}/api/decisions/${flaggedOne.id}/overturn`, { note: "--100 MB: people upload video" });
      const result = (await overturned.json()) as { ok: boolean; output: string };
      assert.deepEqual([overturned.status, result.ok], [200, true], result.output);
      assert.equal((await post(`${s.url}/api/decisions/${plain.id}/agree`, {})).status, 200);
      assert.deepEqual(
        (await s.store.controls.all()).filter((c) => c.kind === "review").map((c) => c.review),
        [
          { decision: flaggedOne.id, verdict: "overturned", note: "--100 MB: people upload video" },
          { decision: plain.id, verdict: "agreed", note: "" },
        ]
      );
      const after = /<h2>Decided for you<\/h2>[\s\S]*?<\/section>/.exec(await (await fetch(s.url)).text())?.[0] ?? "";
      assert.match(after, /Nothing the team flagged waits for your review\./);
      assert.match(after, /You overturned it \(the team's machine applies it within a minute\)\.<\/b> --100 MB: people upload video/);
      assert.doesNotMatch(after, new RegExp(`action="/api/decisions/${flaggedOne.id}/`), "an overturn stands");
      assert.match(after, new RegExp(`action="/api/decisions/${plain.id}/overturn"`), "agreed may still be overturned");
      assert.doesNotMatch(after, new RegExp(`action="/api/decisions/${plain.id}/agree"`));
      // What the command refuses, the page says.
      const again = await post(`${s.url}/api/decisions/${flaggedOne.id}/agree`, {});
      assert.equal(again.status, 422);
      assert.match(((await again.json()) as { output: string }).output, /overturned already/);
      assert.equal((await post(`${s.url}/api/decisions/d99/agree`, {})).status, 422);
      assert.equal((await post(`${s.url}/api/decisions/7/agree`, {})).status, 404);
    } finally {
      await s.close();
    }
  });

  test("a question says which rule of the agreement asked it", async () => {
    const s = await served();
    try {
      const at = new Date().toISOString();
      await s.store.tasks.create({
        ...newTask({ team: "fixture", title: "Sell outside the two markets?", kind: "research", status: "question", by: "planner" }),
        ask: {
          reason: "it changes who the shop serves",
          recommendation: "(a) not yet",
          by: "planner",
          at,
          topic: "scope",
          stakes: "medium",
          confidence: "low",
          rule: "the agreement always asks about scope",
          agreement: null,
        },
        history: [{ at, by: "planner", what: "proposed → question", from: "proposed", to: "question" }],
      });
      assert.match(await (await fetch(s.url)).text(), /Asked because: the agreement always asks about scope<\/p>/);
    } finally {
      await s.close();
    }
  });
});

describe("where the rule in force is read, and who may review on the local page", () => {
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

  test("the watchdog's outbox follows the agreement's window, and a pass puts back the run folder's copy", async () => {
    const { w } = await world();
    try {
      // This team's own rule lets every message go at once (its entry is from before the setting).
      const outbox = join(w.run, "outbox");
      write(outbox, { "2026-11-01-questions.md": "Subject: 2 questions\n\n1. …\n" });
      const draft = join(outbox, "2026-11-01-questions.md");
      const twoMinutesAgo = new Date(Date.now() - 120_000);
      utimesSync(draft, twoMinutesAgo, twoMinutesAgo);
      recordSent(w.run, "normal", new Date());
      // The operator asks for one message a day: the draft waits, though the team's own rule would send it.
      assert.equal((await w.a6g("agreement", "fixture", "--messages", "digest", "--every", "1d")).code, 0);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.ok(!existsSync(`${draft}.notified`), "held for the agreement's window");
      // The run folder's copy, lost (a folder made anew), is put back by the next pass that reads the controls.
      rmSync(join(w.run, "agreement.json"));
      assert.equal((await w.a6g("budget", "fixture", "--daily", "40")).code, 0);
      assert.deepEqual(contactInForce(w.run, DIGEST), { mode: "digest", everyMin: 1440 });
      // Given back to the team's own rule, it goes at the next run.
      assert.equal((await w.a6g("agreement", "fixture", "--messages", "team")).code, 0);
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.ok(existsSync(`${draft}.notified`), "the team's own rule: at once");
    } finally {
      await w.close();
    }
  });

  test("--reset takes the agreement's message window with the rest", async () => {
    const { w, store } = await world();
    try {
      await w.a6g("agreement", "fixture", "--level", "hands-on", "--messages", "digest", "--every", "2h");
      assert.deepEqual(contactInForce(w.run, DIGEST), { mode: "digest", everyMin: 120 });
      assert.match((await w.a6g("agreement", "fixture", "--reset")).out, /level hands-on → balanced; messages: as the team's own settings say again\./);
      assert.deepEqual(agreementOf(await store.controls.all()).agreement, DEFAULT_AGREEMENT);
      assert.deepEqual(contactInForce(w.run, DIGEST), DIGEST);
    } finally {
      await w.close();
    }
  });

  test("every wake, the planner's context says when the next message may go by the agreement's window", () => {
    const home = makeRepo(baseTeam({ board: "tasks" }));
    const run = tmp("a6g-run-");
    const t3 = tmp("a6g-t3-");
    mkdirSync(join(t3, "userdata"));
    execFileSync("sqlite3", [join(t3, "userdata", "statev2.sqlite")], { input: readFileSync(join(ROOT, "test", "fake-t3", "schema.sql"), "utf8") });
    const context = (): string => {
      const result = spawnSync(process.execPath, [join(ROOT, "plugin", "hooks", "context.ts")], {
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", agent_type: "a6g:planner", cwd: home, session_id: "test" }),
        env: { ...process.env, A6G_TEAM: "fixture", A6G_HOME_DIR: home, A6G_RUN: run, A6G_ROLE: "planner", CLAUDE_PROJECT_DIR: home, T3CODE_HOME: t3 },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    };
    assert.match(context(), /Messages to the operator \(digest, every 4 h\): the next can go now/, "the team's own");
    keepAgreement(run, [control(agreementControl("fixture", OPERATOR, made({ level: "balanced", contact: { mode: "digest", everyMin: 60 } })))]);
    assert.match(context(), /Messages to the operator \(digest, every 1 h\): the next can go now/);
    keepAgreement(run, [control(agreementControl("fixture", OPERATOR, made({ level: "balanced", contact: { mode: "priority", everyMin: 0 } })))]);
    assert.doesNotMatch(context(), /Messages to the operator \(digest/);
  });

  test("a review on the local page takes the operator's token: none, a stakeholder's link and another origin are refused", async () => {
    const home = makeRepo(baseTeam({ board: "tasks" }));
    const run = tmp("a6g-run-");
    const server = await startServer({ home, run, team: loadTeam(home), host: "127.0.0.1", port: 0, token: "operator-token" });
    const store = fileStore(run, "fixture");
    try {
      const d = await recordDecision(
        store,
        "fixture",
        { question: "Cap?", decision: "25 MB", because: "the brief" },
        { topic: "product", stakes: "high", confidence: "high" },
        "planner"
      );
      const { keyHash } = await import("../lib/tasks/requests.ts");
      await store.stakeholders.create({
        team: "fixture",
        name: "Dana",
        email: "dana@example.com",
        role: "customer",
        key: keyHash("danas-link"),
        createdAt: "x",
      });
      const agree = `${server.url}/api/decisions/${d.id}/agree`;
      const post = (headers: Record<string, string>) =>
        fetch(agree, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
      assert.equal((await post({})).status, 401);
      assert.equal((await post({ "x-a6g-token": "guess" })).status, 401);
      assert.equal((await post({ "x-a6g-token": "danas-link" })).status, 403, "a stakeholder's link sends requests, nothing else");
      assert.equal((await post({ "x-a6g-token": "operator-token", origin: "http://evil.example" })).status, 403);
      assert.deepEqual(await store.controls.all(), []);
      assert.equal((await post({ "x-a6g-token": "operator-token" })).status, 200);
      assert.equal((await store.controls.all()).length, 1);
      // And a stakeholder's page shows none of the log.
      assert.doesNotMatch(await (await fetch(server.url, { headers: { "x-a6g-token": "danas-link" } })).text(), /Decided for you|25 MB/);
    } finally {
      await server.close();
    }
  });
});

describe("what the third review found", () => {
  test("a window is said exactly, down to the quarter of an hour the agreement allows", () => {
    assert.deepEqual([15, 20, 45, 60, 75, 90, 100, 240, 1440].map(everyWords), [
      "15 min",
      "20 min",
      "45 min",
      "1 h",
      "1 h 15 min",
      "1.5 h",
      "1 h 40 min",
      "4 h",
      "1 d",
    ]);
    const run = tmp("a6g-run-");
    const said = (everyMin: number): string => contactStatus({ mode: "digest", everyMin }, run) ?? "";
    assert.match(said(15), /^Messages to the operator \(digest, every 15 min\): /);
    assert.match(said(45), /\(digest, every 45 min\)/);
    assert.match(said(75), /\(digest, every 1 h 15 min\)/);
    assert.match(said(90), /\(digest, every 1\.5 h\)/);
    assert.match(said(1440), /\(digest, every 24 h\)/);
  });

  test("the recommendation taken is the one the operator read: changed since, it's refused; a write tried again reads it again", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const question = await store.tasks.create(
      newTask({
        team: "fixture",
        title: "Which carrier?",
        kind: "feature",
        status: "question",
        by: "planner",
        ask: { reason: "two fit", recommendation: "(a) the national post", by: "planner", at: new Date().toISOString(), topic: "product" },
      })
    );
    const recommend = (recommendation: string) => update(store.tasks, question.id, (t) => (t.ask ? { ...t, ask: { ...t.ask, recommendation } } : t));
    // The planner sets another recommendation after the operator's page was drawn.
    await recommend("(b) a courier");
    await assert.rejects(
      answer(store, question.id, { who: OPERATOR, text: "", recommended: true, seen: "(a) the national post" }),
      /the team changed its recommendation on #1 since you read it: read it again, then answer/
    );
    assert.equal((await store.tasks.get(question.id))?.notes.length, 0);
    // Someone else's write lands between this answer's read and its write: tried again, it says what the task says then.
    let raced = false;
    const tasks = Object.assign(Object.create(store.tasks) as Store["tasks"], {
      replace: async (doc: Task) => {
        if (!raced) {
          raced = true;
          await recommend("(c) both");
        }
        return store.tasks.replace(doc);
      },
    });
    const answered = await answer({ ...store, tasks }, question.id, { who: OPERATOR, text: "", recommended: true });
    assert.ok(raced);
    const note = answered.notes.at(-1);
    assert.deepEqual([note?.text, note?.took, note?.topic], ["Go with your recommendation: (c) both", "recommendation", "product"]);
  });
});
