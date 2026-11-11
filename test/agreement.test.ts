// The working agreement (lib/tasks/agreement.ts): what it does with a question, what it may be set to, and which one
// is in force.
import "./helpers.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type Agreement,
  agreementChanges,
  agreementFrom,
  agreementLines,
  cleanNotes,
  DEFAULT_AGREEMENT,
  GRADES,
  type Grade,
  LEVELS,
  normalised,
  NOTES_MAX,
  RESERVED,
  route,
  sameAgreement,
  tableOf,
  TOPICS,
} from "../lib/tasks/agreement.ts";
import { agreementControl, agreementOf, budgetControl, type Control } from "../lib/tasks/controls.ts";

let n = 0;
const control = (fields: Omit<Control, "id" | "version">): Control => ({ ...fields, id: `k${++n}`, version: 1 });
const made = (input: Parameters<typeof agreementFrom>[0]): Agreement => {
  const agreement = agreementFrom(input);
  if ("problem" in agreement) throw new Error(agreement.problem);
  return agreement;
};
const at = (level: Agreement["level"], stakes: Grade, confidence: Grade, topic: (typeof TOPICS)[number] = "product") =>
  route({ ...DEFAULT_AGREEMENT, level }, { topic, stakes, confidence }).route;

describe("what the working agreement does with a question", () => {
  test("balanced asks only when two options still fit and a wrong call would be costly, as the planner's rules always said", () => {
    const asked = GRADES.flatMap((stakes) => GRADES.filter((confidence) => at("balanced", stakes, confidence) === "ask").map((c) => `${stakes}/${c}`));
    assert.deepEqual(asked, ["high/low"]);
    // What it decides at high stakes, it flags; a call a revert undoes is decided whatever the doubt.
    assert.equal(at("balanced", "high", "high"), "tell");
    assert.equal(at("balanced", "high", "medium"), "tell");
    assert.equal(at("balanced", "medium", "low"), "tell");
    for (const confidence of GRADES) assert.equal(at("balanced", "low", confidence), "decide");
    assert.match(
      route(DEFAULT_AGREEMENT, { topic: "product", stakes: "high", confidence: "low" }).rule,
      /^balanced: high stakes with low confidence is asked$/
    );
  });

  test("each level asks no less than the one after it, cell by cell", () => {
    const rank = { decide: 0, tell: 1, ask: 2 };
    for (const stakes of GRADES)
      for (const confidence of GRADES) {
        const [on, balanced, off] = LEVELS.map((level) => rank[tableOf(level)[stakes][confidence]]) as [number, number, number];
        assert.ok(on >= balanced && balanced >= off, `${stakes}/${confidence}: ${on} ${balanced} ${off}`);
      }
    // Hands-off never asks; hands-on asks whenever it's unsure and the call matters.
    for (const stakes of GRADES) for (const confidence of GRADES) assert.notEqual(at("hands-off", stakes, confidence), "ask");
    assert.equal(at("hands-on", "medium", "low"), "ask");
    assert.equal(at("hands-on", "high", "medium"), "ask");
    // More doubt, or more at stake, never asks less.
    for (const level of LEVELS)
      for (const [i, low] of GRADES.entries())
        for (const high of GRADES.slice(i + 1))
          for (const other of GRADES) {
            assert.ok(rank[tableOf(level)[high][other]] >= rank[tableOf(level)[low][other]], `${level}: stakes ${low}→${high} at ${other}`);
            assert.ok(rank[tableOf(level)[other][low]] >= rank[tableOf(level)[other][high]], `${level}: confidence ${high}→${low} at ${other}`);
          }
  });

  test("privacy and the team's rules are always asked, whatever the level or the topics say", () => {
    for (const topic of RESERVED)
      for (const level of LEVELS) {
        const routed = route({ level, topics: {}, notes: "" }, { topic, stakes: "low", confidence: "high" });
        assert.equal(routed.route, "ask");
        assert.match(routed.rule, /always the operator's \(Article 3\)/);
      }
    // A stored agreement that names one (written by hand) doesn't loosen it.
    assert.equal(
      route({ level: "hands-off", topics: { privacy: "decide" }, notes: "" }, { topic: "privacy", stakes: "low", confidence: "high" }).route,
      "ask"
    );
  });

  test("a topic set to always ask is asked; one set to never is decided, and flagged where it would have been asked", () => {
    const agreement = made({ level: "balanced", topics: { scope: "ask", design: "decide" } });
    assert.deepEqual(route(agreement, { topic: "scope", stakes: "low", confidence: "high" }), {
      route: "ask",
      rule: "the agreement always asks about scope",
    });
    const never = route(agreement, { topic: "design", stakes: "high", confidence: "low" });
    assert.equal(never.route, "tell");
    assert.match(never.rule, /never asks about design; high stakes with low confidence would be asked at balanced, so it's flagged/);
    assert.equal(route(agreement, { topic: "design", stakes: "low", confidence: "low" }).route, "decide");
    // A topic not set follows the level.
    assert.equal(route(agreement, { topic: "product", stakes: "high", confidence: "low" }).route, "ask");
  });

  test("an operator who isn't technical is never asked about the platform or the stack, even where the agreement says ask", () => {
    const agreement = made({ level: "hands-on", topics: { technical: "ask" } });
    const routed = route(agreement, { topic: "technical", stakes: "high", confidence: "low" }, { technical: false });
    assert.equal(routed.route, "tell");
    assert.match(routed.rule, /isn't technical/);
    assert.equal(route(agreement, { topic: "technical", stakes: "high", confidence: "low" }, { technical: true }).route, "ask");
    // Anything else of theirs goes by the agreement as for anyone.
    assert.equal(route(agreement, { topic: "product", stakes: "high", confidence: "low" }, { technical: false }).route, "ask");
  });
});

describe("the default", () => {
  test("a change of scope is asked until the operator gives it to the level or to the team", () => {
    assert.deepEqual(DEFAULT_AGREEMENT, { level: "balanced", topics: { scope: "ask" }, notes: "" });
    assert.deepEqual(route(DEFAULT_AGREEMENT, { topic: "scope", stakes: "low", confidence: "high" }), {
      route: "ask",
      rule: "the agreement always asks about scope",
    });
    // Given to the level, it goes by the table; given to the team, it's decided and flagged where it mattered.
    assert.equal(route(made({ level: "balanced", topics: { scope: "follow" } }), { topic: "scope", stakes: "low", confidence: "high" }).route, "decide");
    assert.equal(route(made({ level: "balanced", topics: { scope: "decide" } }), { topic: "scope", stakes: "high", confidence: "low" }).route, "tell");
    assert.deepEqual(agreementLines(DEFAULT_AGREEMENT), [
      "Level balanced: the team asks only when two options still fit and a wrong call would be costly.",
      "Always asked: scope. Always the operator's: privacy, rules.",
    ]);
  });
});

describe("setting the agreement", () => {
  test("a level, topics by name, and the operator's words without control characters", () => {
    const agreement = made({
      level: "hands-on",
      topics: { scope: "ask", cost: "follow", design: "decide", product: "" },
      notes: "  Away until Monday.‮\r\n\r\n\r\n\r\nBatch\u0007 it all.  ",
    });
    assert.deepEqual(agreement, { level: "hands-on", topics: { scope: "ask", design: "decide" }, notes: "Away until Monday.\n\nBatch  it all." });
    assert.equal(cleanNotes("a​b"), "a b");
  });

  test("what isn't an agreement says why", () => {
    const problem = (input: Parameters<typeof agreementFrom>[0]): string => {
      const result = agreementFrom(input);
      return "problem" in result ? result.problem : "";
    };
    assert.match(problem({ level: "relaxed" }), /Choose a level: hands-on, balanced, hands-off/);
    assert.match(problem({ level: "balanced", topics: { pricing: "ask" } }), /no topic pricing/);
    assert.match(problem({ level: "balanced", topics: { privacy: "decide" } }), /privacy is always asked \(Article 3\)/);
    assert.match(problem({ level: "balanced", topics: { rules: "ask" } }), /rules is always asked/);
    assert.match(problem({ level: "balanced", topics: { scope: "sometimes" } }), /scope: always ask, never ask, or follow the level/);
    assert.match(problem({ level: "balanced", notes: "x".repeat(NOTES_MAX + 1) }), /2,000 characters/);
    assert.equal(problem({ level: "balanced", notes: "x".repeat(NOTES_MAX) }), "");
  });

  test("the agreement in force is the newest one recorded, and the default until one is", () => {
    assert.deepEqual(agreementOf([]), { agreement: DEFAULT_AGREEMENT, control: null });
    const first = control(agreementControl("fixture", "operator", made({ level: "hands-on" })));
    const budget = control(budgetControl("fixture", "operator", null));
    const second = control(agreementControl("fixture", "web:s3", made({ level: "hands-off", topics: { scope: "ask" }, notes: "Ship it." })));
    assert.equal(agreementOf([first, budget]).control?.id, first.id);
    const inForce = agreementOf([first, budget, second]);
    assert.equal(inForce.control?.id, second.id);
    assert.deepEqual(inForce.agreement, { level: "hands-off", topics: { scope: "ask" }, notes: "Ship it." });
    // One written by something else is read without throwing: what it can't mean falls back.
    const odd = control({
      ...agreementControl("fixture", "operator", DEFAULT_AGREEMENT),
      agreement: { level: "wild", topics: { privacy: "decide", scope: "ask" }, notes: 7 } as never,
    });
    assert.deepEqual(agreementOf([odd]).agreement, { level: "balanced", topics: { scope: "ask" }, notes: "7" });
    assert.deepEqual(normalised(null), { level: "balanced", topics: {}, notes: "" });
  });

  test("in words: what it is, and what changed", () => {
    const before = made({ level: "balanced", topics: { design: "decide" }, notes: "Old." });
    const after = made({ level: "hands-on", topics: { scope: "ask" }, notes: "New." });
    assert.deepEqual(agreementChanges(before, after), [
      "level balanced → hands-on",
      "scope: always asked",
      "design: follows the level again",
      "standing instructions changed",
    ]);
    assert.deepEqual(agreementChanges(after, after), []);
    assert.ok(sameAgreement(after, made({ level: "hands-on", topics: { scope: "ask", cost: "follow" }, notes: "New." })));
    assert.deepEqual(agreementLines(after), [
      "Level hands-on: the team asks whenever it's unsure and the call matters, and flags more of what it decides.",
      "Always asked: scope. Always the operator's: privacy, rules.",
    ]);
    assert.match(agreementLines(before, { technical: false })[1] ?? "", /Never asked \(decided, and flagged when it matters\): design, technical\./);
    // Set to always ask, it still reads as never asked there.
    assert.equal(
      agreementLines(made({ level: "balanced", topics: { technical: "ask", cost: "ask" } }), { technical: false })[1],
      "Always asked: cost. Never asked (decided, and flagged when it matters): technical. Always the operator's: privacy, rules."
    );
  });
});
