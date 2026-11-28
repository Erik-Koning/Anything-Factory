import { baseTeam, makeRepo, ROOT } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam } from "../lib/config.ts";
import { compile } from "../lib/prompts.ts";
import { newTask, type Task } from "../lib/tasks/model.ts";
import { awaitingBusinessRead, summary } from "../lib/tasks/ops.ts";

const task = (fields: Partial<Task> & { id: string }): Task => ({
  ...newTask({ team: "app", title: `task ${fields.id}`, kind: "feature", status: "proposed", by: "planner", ...fields }),
  version: 1,
  ...fields,
});
const read = (by: string) => [{ at: "2026-11-28T00:00:00.000Z", by, text: "business lead: back: brings charities in." }];

describe("the business lead", () => {
  const team = loadTeam(
    makeRepo(baseTeam({ mode: "cycles", roles: { planner: {}, builder: {}, reviewer: {}, approver: {}, innovator: {}, "business-lead": {} } }))
  );

  test("an optional read-only role on Fable, with its own instructions", () => {
    assert.deepEqual(team.problems, []);
    const lane = team.roles["business-lead"];
    assert.equal(lane?.readOnly, true);
    assert.deepEqual(lane?.write, []);
    assert.equal(lane?.model, "claude-fable-5-2");
    assert.equal(lane?.limit, 1);
    const agent = readFileSync(join(ROOT, "plugin", "agents", "business-lead.md"), "utf8");
    assert.match(agent, /^name: business-lead$/m);
    assert.match(agent, /^disallowedTools: Edit, NotebookEdit$/m);
    assert.doesNotMatch(compile(loadTeam(makeRepo(baseTeam())), "planner"), /Business lead:/, "no business lead line without one");
  });

  test("the planner consults it and the business lead gets its commands, the matrix and its board", () => {
    const planner = compile(team, "planner");
    assert.match(
      planner,
      /Business lead: this team has one, its business, marketing and growth voice\. It helps set the direction and the feature strategy, what gets built and for whom, never how/
    );
    assert.match(planner, /Nothing waits for its read/);
    assert.match(
      planner,
      /\| business-lead \| `a6g-fixture-business-lead` \| `"claude-fable-5-2"` \| `"shared"` \| 1 \| the business, marketing and growth lead/
    );
    const lead = compile(team, "business-lead");
    assert.match(lead, /`a6g task note <id> "business lead: for <who, and what it gets them>\. Told by: …\. Measure: …\. Could grow into: …"`/);
    assert.match(lead, /what it's for, never how it's built\. Nothing waits for it\./);
    assert.doesNotMatch(lead, /doubt|reshape/, "no vote that holds work back");
    assert.match(lead, /`a6g task add "<the outcome, in a few words>" --kind feature --body-file <file>/);
    assert.match(lead, /`WebSearch` and `WebFetch`/);
    assert.match(lead, /## Scoring\n\nEvery proposal is scored 0 to 3/);
    assert.match(lead, /You read and file, and build nothing/);
    assert.match(lead, /a growth idea beyond the documents is welcome when it follows the direction/);
    const agent = (name: string) => readFileSync(join(ROOT, "plugin", "agents", `${name}.md`), "utf8");
    // It sets what, never how, and holds nothing back; the tech side may build past the ask.
    assert.match(
      agent("approver"),
      /It's advice on\s+what to build, never a gate: don't wait for one, and never reject or shrink a feature, or its technical approach,\s+on it\./
    );
    assert.match(agent("approver"), /A solution more powerful than the ask .* is approved on what it unlocks, not sent back for being bigger/s);
    assert.match(agent("planner"), /## The business lead\n/);
    assert.match(agent("planner"), /\*\*Every feature gets its read, and nothing waits for it\.\*\*/);
    assert.match(agent("planner"), /\*\*The solution, not only the ask\.\*\*/);
    assert.match(agent("builder"), /\*\*Build the solution the problem deserves\.\*\*/);
    assert.match(agent("innovator"), /\*\*A capability, not only a feature\.\*\*/);
    for (const name of ["business-lead", "approver", "planner"]) assert.doesNotMatch(agent(name), /back, reshape or doubt|One it doubts/, name);
  });

  test("the planner's context lists the features proposed without its read, and starts it on them", () => {
    const all = [
      task({ id: "1" }),
      task({ id: "2", notes: read("business-lead") }),
      task({ id: "3", notes: read("approver") }),
      task({ id: "4", kind: "bug" }),
      task({ id: "5", status: "approved" }),
    ];
    assert.deepEqual(
      awaitingBusinessRead(all).map((t) => t.id),
      ["1", "3"]
    );
    assert.match(
      summary(all, { approval: "thresholds", business: { running: 0 } }),
      /Features the business lead hasn't read yet: #1, #3\. Start it, briefed "a business read of #1, #3"\. Nothing waits for its read: the approver decides as it would/
    );
    assert.match(summary(all, { approval: "thresholds", business: { running: 1 } }), /A business lead is at work/);
    assert.doesNotMatch(summary(all, { approval: "thresholds" }), /business lead/, "nothing on a team without one");
  });
});
