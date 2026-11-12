// Thinking streams and Ditto. The mark on a task and the hold it puts on claims (lib/tasks/model.ts, a6g task stream),
// what the planner reads of it each wake (lib/tasks/ops.ts), where the label shows (the list, the task, the graph);
// which roles Ditto's tools go to (lib/config.ts, the guard, lib/prompts.ts), how a member's Ditto server starts
// (lib/commands/team.ts, plugin/mcp/ditto.ts), and a6g ditto, against a stand-in for Ditto's own command line.
import { a6g, baseTeam, bash, fakeKeychain, holds, makeRepo, ROOT, tmp, tool, write } from "./helpers.ts";
import { fakeWorld } from "./fake-t3.ts";
import { validator } from "./jsonschema.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam, type RawTeam, TeamError } from "../lib/config.ts";
import { DITTO_NOTE, DITTO_READ } from "../lib/ditto.ts";
import { PACKAGE } from "../lib/paths.ts";
import { compile } from "../lib/prompts.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { levelDiagram } from "../lib/tasks/graph.ts";
import { awaitsStream, claimRefusal, newTask, nextClaim, streamLabel, streamLine, type Stream, type Task } from "../lib/tasks/model.ts";
import { summary } from "../lib/tasks/ops.ts";

const ROLES = { planner: {}, builder: { limit: 2 }, reviewer: { limit: 1 }, tester: { limit: 1, write: ["^e2e/"] }, innovator: { limit: 1 } };
const team = (overrides: RawTeam = {}) => baseTeam({ board: "tasks", roles: ROLES, ...overrides });

function setup(raw: RawTeam = team()) {
  const home = makeRepo(raw);
  const run = tmp("a6g-run-");
  const as = (role: string | null, cwd = home) => ({
    cwd,
    env: role ? { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: role, A6G_RUN: run } : { A6G_RUN: run },
  });
  return { home, run, as, store: () => fileStore(run, "fixture") };
}

const task = (fields: Partial<Task> & { id: string }): Task => ({
  ...newTask({ team: "fixture", title: `task ${fields.id}`, kind: "feature", status: "approved", by: "planner", ...fields }),
  version: 1,
  ...fields,
});
const stream = (fields: Partial<Stream>): Stream => ({
  state: "wanted",
  why: "the first thing anyone sees.",
  by: "planner",
  at: "2026-11-11T12:00:00.000Z",
  ...fields,
});

describe("a thinking stream on a task", () => {
  test("a task marked for one isn't claimed until its concept is settled, and says where it stands", () => {
    const wanted = task({ id: "1", priority: 90, stream: stream({}) });
    const plain = task({ id: "2", priority: 10 });
    const all = [wanted, plain];
    assert.equal(awaitsStream(wanted), true);
    assert.equal(awaitsStream(plain), false);
    assert.match(
      claimRefusal(wanted, "builder", all) ?? "",
      /task 1 waits for its thinking stream \(wanted, and not run yet\): nobody builds it until the planner settles/
    );
    assert.equal(nextClaim(all, "builder")?.id, "2", "the next task is claimed past it, whatever its priority");

    const concept = {
      ...wanted,
      stream: stream({ state: "concept", move: "Parting doors: two bands part to show the form.", record: "/x/concept.md", by: "innovator" }),
    };
    assert.match(claimRefusal(concept, "builder", [concept, plain]) ?? "", /its concept is in, for the planner to judge/);
    assert.equal(nextClaim([concept, plain], "builder")?.id, "2");

    for (const build of ["concept", "retreat"] as const) {
      const settled = { ...concept, stream: { ...concept.stream, state: "settled" as const, build } };
      assert.equal(awaitsStream(settled), false);
      assert.equal(claimRefusal(settled, "builder", [settled, plain]), null);
      assert.equal(nextClaim([settled, plain], "builder")?.id, "1", "settled, it's claimed in its turn");
      assert.equal(streamLabel(settled), `stream: ${build}`);
    }
    assert.equal(streamLabel(plain), null);
    assert.equal(streamLabel(wanted), "stream: wanted");
    assert.equal(streamLabel(concept), "stream: concept in");
    assert.match(streamLine(wanted) ?? "", /^thinking stream wanted: the first thing anyone sees\. Nobody claims it until its concept is settled$/);
    assert.match(streamLine(concept) ?? "", /^thinking stream, concept in, for the planner to judge: Parting doors: .* Record: \/x\/concept\.md$/);
  });

  test("the planner marks it, the innovator hands in a concept whose record is there, and the planner settles what's built", async () => {
    const { home, as, store } = setup();
    for (const title of ["Sign-in page", "Fix a typo"])
      assert.equal((await a6g(["task", "add", title, "--kind", "feature", "--approved"], as(null))).code, 0);
    const want = ["task", "stream", "1", "want", "--why", "The first thing anyone sees, and the operator wants it to be theirs."];

    // Only the planner marks work, and says why.
    for (const role of ["builder", "innovator", "reviewer"])
      assert.match((await a6g(want, as(role))).out, /marking work for a thinking stream is the planner's/);
    assert.match((await a6g(["task", "stream", "1", "want"], as("planner"))).out, /say why it's worth one/);
    const marked = await a6g(want, as("planner"));
    assert.equal(marked.code, 0, marked.out);
    assert.match(marked.out, /task 1: marked for a thinking stream; nobody claims it until its concept is settled/);

    // The label is on the task wherever it's listed, and the task isn't offered to a builder.
    assert.match((await a6g(["task", "list"], as("planner"))).out, /^#1 .* Sign-in page ≈ stream: wanted$/m);
    const claimable = (await a6g(["task", "list", "--claimable"], as("builder"))).out;
    assert.doesNotMatch(claimable, /Sign-in page/);
    assert.match(claimable, /Fix a typo/);
    assert.match(
      (await a6g(["task", "show", "1"], as("builder"))).out,
      /^thinking stream wanted: The first thing anyone sees.* Nobody claims it until its concept is settled$/m
    );

    // Nobody settles a concept that isn't in, and only the innovator hands one in, with its record written.
    assert.match((await a6g(["task", "stream", "1", "build", "concept"], as("planner"))).out, /has no concept yet: the innovator hands one in first/);
    const record = join(home, ".a6g", "run", "scratch", "streams", "1", "concept.md");
    const concept = ["task", "stream", "1", "concept", "--move", "Parting doors: two bands part to show the form.", "--record", record];
    assert.match((await a6g(concept, as("planner"))).out, /handing in a concept is the innovator's/);
    assert.match((await a6g(concept, as("innovator"))).out, /there's no record at .*concept\.md: write it first/);
    write(home, { ".a6g/run/scratch/streams/1/concept.md": "## The concept\n\nParting doors.\n" });
    assert.match(
      (await a6g(["task", "stream", "1", "concept", "--record", record], as("innovator"))).out,
      /--move "<the concept's name, and its one move>"/
    );
    const handed = await a6g(concept, as("innovator"));
    assert.equal(handed.code, 0, handed.out);
    assert.match((await a6g(["task", "list"], as("planner"))).out, /Sign-in page ≈ stream: concept in$/m);
    assert.equal((await store().tasks.get("1"))?.stream?.record, record);

    // The innovator doesn't settle its own concept (Article 4); the planner does, and the hold lifts.
    assert.match(
      (await a6g(["task", "stream", "1", "build", "concept"], as("innovator"))).out,
      /settling what a stream's task is built to is the planner's/
    );
    assert.match((await a6g(["task", "stream", "1", "build", "both"], as("planner"))).out, /what's built: concept, retreat, not both/);
    const settled = await a6g(["task", "stream", "1", "build", "concept", "--note", "The glance test read it as a door."], as("planner"));
    assert.equal(settled.code, 0, settled.out);
    assert.match(settled.out, /task 1: built to its concept; it can be claimed/);
    assert.match((await a6g(["task", "list", "--claimable"], as("builder"))).out, /Sign-in page ≈ stream: concept$/m);
    const done = await store().tasks.get("1");
    assert.deepEqual(
      done?.history.slice(-3).map((e) => `${e.by}: ${e.what}`),
      [
        "planner: marked for a thinking stream: The first thing anyone sees, and the operator wants it to be theirs.",
        "innovator: handed in a concept: Parting doors: two bands part to show the form.",
        "planner: settled its stream: build the concept. The glance test read it as a door.",
      ]
    );
    // Settled is settled: no second concept, no taking the mark off what was built from one.
    for (const step of [concept.slice(3), ["build", "retreat"], ["off", "--reason", "changed my mind"]])
      assert.match(
        (await a6g(["task", "stream", "1", ...step], as(step[0] === "concept" ? "innovator" : "planner"))).out,
        /task 1's stream is settled \(stream: concept\)/
      );
  });

  test("the mark comes off with a reason, and goes only on work a builder hasn't begun", async () => {
    const { as, store } = setup();
    await a6g(["task", "add", "Onboarding", "--kind", "feature", "--approved"], as(null));
    await a6g(["task", "add", "A spec for onboarding", "--kind", "test", "--approved"], as(null));
    await a6g(["task", "add", "Billing page", "--kind", "feature", "--approved"], as(null));
    const want = (id: string) => a6g(["task", "stream", id, "want", "--why", "First run."], as("planner"));
    assert.match((await want("2")).out, /task 2 is test work: a stream is for what a builder builds \(feature, bug, ux, chore\)/);
    await store().tasks.replace({ ...((await store().tasks.get("3")) as Task), status: "building", branch: "a6g/b3-billing-page" });
    assert.match((await want("3")).out, /task 3 is already begun: a stream comes before the work is built/);
    assert.match((await a6g(["task", "stream", "1", "off", "--reason", "no need"], as("planner"))).out, /task 1 isn't marked for a thinking stream/);

    assert.equal((await want("1")).code, 0);
    assert.match((await a6g(["task", "stream", "1", "off"], as("planner"))).out, /say why: --reason/);
    assert.match((await a6g(["task", "stream", "1", "off", "--reason", "x"], as("innovator"))).out, /taking a stream off a task is the planner's/);
    const off = await a6g(["task", "stream", "1", "off", "--reason", "The task shrank to a copy change."], as("planner"));
    assert.equal(off.code, 0, off.out);
    const after = await store().tasks.get("1");
    assert.equal(after?.stream, null);
    assert.equal(after?.history.at(-1)?.what, "took the thinking stream off: The task shrank to a copy change.");
    assert.doesNotMatch((await a6g(["task", "list"], as("planner"))).out, /≈/);
    assert.match((await a6g(["task", "stream", "1", "sideways"], as("planner"))).out, /a6g task stream 1 want --why "…" \| concept --move/);
  });

  test("a team without an innovator has nobody to think one through", async () => {
    const { as } = setup(baseTeam({ board: "tasks" }));
    await a6g(["task", "add", "Sign-in page", "--kind", "feature", "--approved"], as(null));
    assert.match(
      (await a6g(["task", "stream", "1", "want", "--why", "First sight."], as("planner"))).out,
      /this team has no innovator to think a stream through/
    );
    assert.doesNotMatch(compile(loadTeam(makeRepo(baseTeam({ board: "tasks" }))), "planner"), /a6g task stream/);
  });

  test("the planner's context says which streams to start and which concepts to judge", () => {
    const all = [
      task({ id: "1", title: "Sign-in page", stream: stream({}) }),
      task({ id: "2", title: "Onboarding", stream: stream({ state: "concept", move: "A path, not a form.", record: "/x/2.md", by: "innovator" }) }),
      task({ id: "3", title: "Landing", status: "proposed", stream: stream({}) }),
      task({ id: "4", title: "Settings", stream: stream({ state: "settled", build: "retreat" }) }),
      task({ id: "5", title: "Old idea", status: "rejected", stream: stream({}) }),
    ];
    const ideas = (running: number) => ({ min: 0, running, budgetBound: false });
    const text = summary(all, { approval: "thresholds", ideas: ideas(0) });
    assert.match(
      text,
      /Thinking streams \(held from claims until settled\): concept in, yours to judge and settle \(a6g task stream <id> build concept\|retreat\): #2 Onboarding\. wanted: #1 Sign-in page \(start the innovator on one: "a thinking stream on task <id>"\)\. wanted once approved: #3\./
    );
    assert.doesNotMatch(text.split("\n").find((line) => line.startsWith("Thinking streams")) ?? "", /#4|#5/, "settled and rejected work isn't held");
    assert.match(summary(all, { approval: "thresholds", ideas: ideas(1) }), /wanted: #1 Sign-in page \(an innovator is at work\)/);
    assert.doesNotMatch(summary([task({ id: "9" })], { approval: "thresholds", ideas: ideas(0) }), /Thinking streams/);
  });

  test("the label is on the task in the graph", () => {
    const tasks = [task({ id: "1", title: "Sign-in page", stream: stream({}) }), task({ id: "2", title: "Fix a typo" })];
    const doc = levelDiagram(tasks, { title: "Shop" }) as { nodes: { label: string; description?: string }[] };
    const node = (id: string) => doc.nodes.find((n) => n.label.startsWith(`#${id} `));
    assert.match(node("1")?.description ?? "", / · stream: wanted$/);
    assert.doesNotMatch(node("2")?.description ?? "", /stream/);
  });
});

describe("Ditto in a team's rules", () => {
  const lanes = (raw: RawTeam) => loadTeam(makeRepo(team(raw))).roles;

  test("the roles it names get its read tools in their lane, and its one write only with notes", () => {
    const off = loadTeam(makeRepo(team()));
    assert.equal(off.ditto, null);
    assert.ok(!off.roles["innovator"]?.mcp.some((name) => name.startsWith("mcp__ditto__")));

    const read = loadTeam(makeRepo(team({ ditto: {} })));
    assert.deepEqual(read.ditto, { roles: ["planner", "innovator"], notes: false });
    assert.deepEqual(read.roles["innovator"]?.mcp, DITTO_READ);
    // The planner keeps its email tools beside them.
    assert.ok(read.roles["planner"]?.mcp.includes("mcp__claude_ai_Gmail__send_message"));
    for (const name of DITTO_READ) assert.ok(read.roles["planner"]?.mcp.includes(name), name);
    assert.ok(!read.roles["planner"]?.mcp.includes(DITTO_NOTE));
    assert.deepEqual(read.roles["builder"]?.mcp, []);
    assert.deepEqual(read.roles["reviewer"]?.mcp, []);

    const notes = lanes({ ditto: { roles: ["innovator"], notes: true } });
    assert.deepEqual(notes["innovator"]?.mcp, [...DITTO_READ, DITTO_NOTE]);
    assert.ok(!notes["planner"]?.mcp.some((name) => name.startsWith("mcp__ditto__")), "only the roles named");
    // A team with no innovator: the planner alone.
    assert.deepEqual(loadTeam(makeRepo(baseTeam({ board: "tasks", ditto: {} }))).ditto?.roles, ["planner"]);
  });

  test("a role in a worktree of its own, or one the team doesn't have, can't be named", () => {
    const problems = (raw: RawTeam): string => {
      try {
        loadTeam(makeRepo(team(raw)));
        return "";
      } catch (error) {
        return (error as TeamError).problems.join("\n");
      }
    };
    assert.match(
      problems({ ditto: { roles: ["builder"] } }),
      /ditto\.roles: the builder works in a worktree of its own, where the team's grant doesn't hold/
    );
    assert.match(problems({ ditto: { roles: ["ux-specialist"] } }), /ditto\.roles: the team has no ux-specialist/);
    assert.match(problems({ ditto: { roles: ["designer"] } }), /ditto\.roles\[0\]: a role/);
    assert.match(problems({ ditto: { notes: "yes" } as unknown as NonNullable<RawTeam["ditto"]> }), /ditto\.notes: true or false/);
  });

  test("the schema takes the same setting", () => {
    const validate = validator(JSON.parse(readFileSync(join(ROOT, "schema", "team.schema.json"), "utf8")) as Record<string, unknown>);
    assert.deepEqual(validate(team({ ditto: { roles: ["planner", "innovator"], notes: true } })), []);
    assert.deepEqual(validate(team({ ditto: {} })), []);
    assert.notDeepEqual(validate(team({ ditto: { roles: ["designer"] } })), []);
    assert.notDeepEqual(validate(team({ ditto: { write: true } as unknown as NonNullable<RawTeam["ditto"]> })), []);
  });

  test("the guard passes Ditto's tools to the roles named, and to nobody else", async () => {
    const read = makeRepo(team({ ditto: {} }));
    const notes = makeRepo(team({ ditto: { notes: true } }));
    const none = makeRepo(team());
    const [profile, consult, note] = ["mcp__ditto__get_profile", "mcp__ditto__consult", DITTO_NOTE];
    await holds([
      tool(read, "planner", profile, { task: "design the sign-in page" }, "allow"),
      tool(read, "innovator", consult, { decision: "how bold?" }, "allow"),
      tool(read, "innovator", "mcp__ditto__status", {}, "allow"),
      tool(read, "builder", profile, { task: "x" }, "refuse"),
      tool(read, "reviewer", profile, { task: "x" }, "refuse"),
      // Reading isn't writing: no note without notes, and never the operator's own word.
      tool(read, "innovator", note, { text: "Leans bold.", basis: "inferred" }, "refuse"),
      tool(notes, "innovator", note, { text: "Leans bold.", basis: "inferred" }, "allow"),
      tool(notes, "planner", note, { text: "Overturned the bold one.", basis: "relayed" }, "allow"),
      tool(notes, "innovator", "mcp__ditto__record_feedback", { text: "Always be bold.", kind: "rule" }, "refuse"),
      tool(notes, "planner", "mcp__ditto__record_answer", { question_id: "Q-DSN-001", choice: "A" }, "refuse"),
      tool(notes, "planner", "mcp__ditto__set_focus", { areas: [] }, "refuse"),
      // A subagent has no lane, so nothing of Ditto's: the profile is read in one place.
      tool(notes, "Explore", profile, { task: "x" }, "refuse", { env: { A6G_ROLE: "innovator" } }),
      tool(none, "planner", profile, { task: "x" }, "refuse"),
      tool(none, "innovator", profile, { task: "x" }, "refuse"),
      // Connecting it is the operator's.
      bash(notes, "planner", "a6g ditto fixture --grant --all", "refuse"),
    ]);
  });

  test("each role's rules list what its lane has", () => {
    const loaded = loadTeam(makeRepo(team({ ditto: { notes: true } })));
    const innovator = compile(loaded, "innovator");
    assert.match(
      innovator,
      /Ditto, the operator's own record of their taste and judgment \(`mcp__ditto__whoami`, `mcp__ditto__get_profile`, `mcp__ditto__consult`, `mcp__ditto__get_expertise`\)/
    );
    assert.match(innovator, /They've given the team all of it to read\. It says what they'd want made, not what the product's users need/);
    assert.match(
      innovator,
      /`mcp__ditto__record_note` .*after a thinking stream, what you had to work out about their taste.*`basis: "inferred"`.*never as the operator's word/
    );
    assert.match(innovator, /`a6g task stream <id> concept --move "<the concept's name, and its one move>" --record <file>`/);
    const planner = compile(loaded, "planner");
    assert.match(planner, /`mcp__ditto__record_note` .*when the operator agrees with or overturns a call you made.*`basis: "relayed"`/);
    assert.match(planner, /`a6g task stream <id> want --why "<why it's worth one>"`, `a6g task stream <id> build concept\|retreat/);
    for (const role of ["builder", "reviewer", "tester"]) assert.doesNotMatch(compile(loaded, role), /Ditto|a6g task stream/, role);

    const readOnly = compile(loadTeam(makeRepo(team({ ditto: {} }))), "innovator");
    assert.match(readOnly, /mcp__ditto__get_profile/);
    assert.doesNotMatch(readOnly, /record_note/);
    assert.doesNotMatch(compile(loadTeam(makeRepo(team())), "innovator"), /mcp__ditto__/);
  });

  test("the prompts that use a stream say the same commands", () => {
    const prompt = (role: string) => readFileSync(join(ROOT, "plugin", "agents", `${role}.md`), "utf8");
    assert.match(prompt("innovator"), /^## A thinking stream$/m);
    assert.match(prompt("innovator"), /`a6g task stream <id> concept --move "<its name>: <the one move>" --record <the record's file>`/);
    assert.match(prompt("planner"), /^## Thinking streams$/m);
    assert.match(prompt("planner"), /`a6g task stream <id> want --why/);
    assert.match(prompt("planner"), /`a6g task stream <id> build concept\|retreat --note "<why>"`/);
    for (const role of ["builder", "tester", "ux-specialist"]) assert.match(prompt(role), /thinking stream/, role);
  });
});

describe("a member's Ditto server", () => {
  test("register starts the roles named on it, with a file that holds no secret", async () => {
    const w = await fakeWorld(team({ ditto: { notes: true } }), { register: false });
    try {
      mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
      const result = await w.a6g("register", w.home);
      assert.equal(result.code, 0, result.out);
      assert.match(
        result.out,
        /note: team\.json gives the planner and the innovator Ditto, which isn't connected here yet: a6g ditto fixture --grant --server/
      );
      const settings = JSON.parse(readFileSync(join(w.t3Home, "userdata", "settings.json"), "utf8")) as {
        providerInstances: Record<string, { config?: { launchArgs?: string } }>;
      };
      const flags = (role: string): string => settings.providerInstances[`a6g-fixture-${role}`]?.config?.launchArgs ?? "";
      const file = join(w.run, "mcp", "ditto.json");
      assert.ok(flags("innovator").endsWith(`--strict-mcp-config --mcp-config ${file}`), flags("innovator"));
      assert.ok(flags("planner").endsWith(`--mcp-config ${file}`), flags("planner"));
      assert.doesNotMatch(flags("planner"), /--strict-mcp-config/);
      for (const role of ["builder", "reviewer", "tester"]) assert.doesNotMatch(flags(role), /--mcp-config/, role);
      const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, { command: string; args: string[]; env?: unknown }> };
      assert.deepEqual(Object.keys(config.mcpServers), ["ditto"]);
      assert.deepEqual(config.mcpServers["ditto"]?.args, [join(w.a6gHome, "versions", PACKAGE.version, "plugin", "mcp", "ditto.ts"), "fixture"]);
      assert.equal(config.mcpServers["ditto"]?.env, undefined, "no token in the file");
    } finally {
      await w.close();
    }
  });

  test("a team without Ditto starts nobody on it", async () => {
    const w = await fakeWorld(team(), { register: false });
    try {
      mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
      const result = await w.a6g("register", w.home);
      assert.equal(result.code, 0, result.out);
      assert.doesNotMatch(result.out, /Ditto/);
      assert.doesNotMatch(readFileSync(join(w.t3Home, "userdata", "settings.json"), "utf8"), /--mcp-config/);
      assert.equal(existsSync(join(w.run, "mcp")), false);
    } finally {
      await w.close();
    }
  });
});

// Ditto's own command line, as a6g ditto and the launcher use it: grant, check, categories, revoke and serve. It logs
// each call with the token it was given and the folder it ran in.
const TOKEN = "ditto_FAKE-token_0123456789abcdefghij";
function fakeDitto(): { server: string; calls: () => { cmd: string; rest: string[]; cwd: string; token: string | null }[] } {
  const dir = tmp("a6g-ditto-");
  const log = join(dir, "calls");
  writeFileSync(
    join(dir, "ditto-mcp.js"),
    `const fs = require("node:fs");
const [cmd, ...rest] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cmd, rest, cwd: process.cwd(), token: process.env.DITTO_TOKEN ?? null }) + "\\n");
const after = (flag) => rest[rest.indexOf(flag) + 1];
if (cmd === "grant") {
  const wrote = rest.includes("--notes-only") ? "notes" : rest.includes("--read-only") ? "false" : "true";
  console.log(\`Granted "\${rest[0]}": categories=\${after("--categories")} write=\${wrote} sensitive=\${rest.includes("--sensitive")} paths=\${after("--path")}\`);
  console.log("\\nToken (shown once): ${TOKEN}\\n");
  console.log("  claude mcp add --scope local --env DITTO_TOKEN=${TOKEN} ditto -- node ditto-mcp.js serve");
} else if (cmd === "check") {
  const ok = process.env.DITTO_TOKEN === "${TOKEN}";
  console.log(ok ? \`OK: grant "a6g-fixture" is valid in \${process.cwd()}\` : "Denied: the configured DITTO_TOKEN is not recognized");
  process.exitCode = ok ? 0 : 1;
} else if (cmd === "categories") {
  console.log("SWE  Software engineering\\nDSN  Design & UX\\nHLT  Health  (sensitive: grant by name)");
} else if (cmd === "revoke") {
  console.log(\`Revoked "\${rest[0]}".\`);
} else if (cmd === "serve") {
  process.exitCode = 7;
}
`
  );
  return {
    server: join(dir, "ditto-mcp.js"),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { cmd: string; rest: string[]; cwd: string; token: string | null })
        : [],
  };
}

// A machine with one registered team, and a Keychain that keeps what it's given.
function registered(raw: RawTeam) {
  const keychain = fakeKeychain();
  const home = makeRepo(raw);
  const a6gHome = tmp("a6g-home-");
  const entry = {
    name: "fixture",
    title: "Fixture team",
    home,
    run: join(a6gHome, "runs", "fixture"),
    project: "proj-1",
    version: "dev",
    plannerInstance: "a6g-fixture-planner",
    model: "m",
  };
  write(a6gHome, { "teams/fixture.json": entry });
  const env = { A6G_HOME: a6gHome, HOME: tmp("a6g-user-") };
  return { home, a6gHome, env, kept: () => (existsSync(join(keychain, "a6g-ditto")) ? readFileSync(join(keychain, "a6g-ditto"), "utf8") : null) };
}

describe("a6g ditto", () => {
  test("--grant makes the team's grant, keeps its token in the Keychain and never shows it", async () => {
    const { home, a6gHome, env, kept } = registered(team({ ditto: { notes: true } }));
    const ditto = fakeDitto();

    const before = await a6g(["ditto", "fixture"], { env });
    assert.equal(before.code, 0, before.out);
    assert.match(
      before.out,
      /fixture: team\.json gives Ditto to the planner and the innovator, who may record notes there \(kept as coming from a secondary source\)\./
    );
    assert.match(before.out, /Ditto's server: not set/);
    assert.match(before.out, /Its grant: none/);
    assert.match(
      (await a6g(["ditto", "fixture", "--grant"], { env })).out,
      /where is your Ditto\? Give its server once: a6g ditto fixture --grant --server/
    );
    assert.match(
      (await a6g(["ditto", "fixture", "--grant", "--server", "/no/such/ditto-mcp.js"], { env })).out,
      /isn't there; --server is the path to Ditto's/
    );

    const granted = await a6g(["ditto", "fixture", "--grant", "--server", ditto.server], { env });
    assert.equal(granted.code, 0, granted.out);
    assert.match(granted.out, /^Granted "a6g-fixture": categories=\* write=notes sensitive=false paths=/m);
    assert.match(granted.out, /Its token is in your Keychain, and nowhere else\. OK: grant "a6g-fixture" is valid in /);
    assert.match(granted.out, /a6g sync fixture gives new threads Ditto's tools; a6g rotate fixture starts the planner on them\./);
    assert.doesNotMatch(granted.out, /ditto_FAKE/, "the token is never printed");
    assert.equal(kept(), TOKEN);
    assert.deepEqual(JSON.parse(readFileSync(join(a6gHome, "ditto.json"), "utf8")), { server: ditto.server });
    const made = ditto.calls().find((call) => call.cmd === "grant");
    assert.deepEqual(made?.rest, ["a6g-fixture", "--path", home, "--categories", "*", "--notes-only", "--replace"]);
    assert.equal(ditto.calls().find((call) => call.cmd === "check")?.cwd, home, "checked from the team's checkout, where the grant holds");

    // The server is remembered; --all names every category, the sensitive ones too.
    const all = await a6g(["ditto", "fixture", "--grant", "--all"], { env });
    assert.equal(all.code, 0, all.out);
    assert.deepEqual(ditto.calls().findLast((call) => call.cmd === "grant")?.rest, [
      "a6g-fixture",
      "--path",
      home,
      "--categories",
      "SWE,DSN,HLT",
      "--notes-only",
      "--sensitive",
      "--replace",
    ]);
    const status = await a6g(["ditto", "fixture"], { env });
    assert.match(status.out, /Its grant \(a6g-fixture\): OK: grant "a6g-fixture" is valid in /);
    assert.doesNotMatch(status.out, /ditto_FAKE/);

    const off = await a6g(["ditto", "fixture", "--off"], { env });
    assert.equal(off.code, 0, off.out);
    assert.match(off.out, /fixture is disconnected from Ditto: its grant is revoked and its token forgotten/);
    assert.deepEqual(ditto.calls().at(-1)?.rest, ["a6g-fixture"]);
    assert.equal(ditto.calls().at(-1)?.cmd, "revoke");
    assert.equal(kept(), null);
  });

  test("a team whose rules only read gets a read-only grant; an agent can't run it", async () => {
    const { env } = registered(team({ ditto: {} }));
    const ditto = fakeDitto();
    const granted = await a6g(["ditto", "fixture", "--grant", "--server", ditto.server, "--categories", "DSN,SWE"], { env });
    assert.equal(granted.code, 0, granted.out);
    assert.match(granted.out, /write=false/);
    assert.match(granted.out, /team\.json gives Ditto to the planner and the innovator, to read only\./);
    assert.ok(ditto.calls()[0]?.rest.includes("--read-only"));
    assert.ok(ditto.calls()[0]?.rest.includes("DSN,SWE"));
    const agent = await a6g(["ditto", "fixture", "--off"], { env: { ...env, A6G_TEAM: "fixture", A6G_ROLE: "planner" } });
    assert.equal(agent.code, 2);
    assert.match(agent.out, /ditto is the operator's; an agent on a team/);
  });

  test("the launcher gives the server the team's token, in the member's own folder, and passes on how it ended", () => {
    const { a6gHome, env } = registered(team({ ditto: {} }));
    const ditto = fakeDitto();
    const launcher = join(ROOT, "plugin", "mcp", "ditto.ts");
    const folder = tmp("a6g-member-");
    const start = () => spawnSync(process.execPath, [launcher, "fixture"], { cwd: folder, env: { ...process.env, ...env }, encoding: "utf8" });

    const unset = start();
    assert.equal(unset.status, 1);
    assert.match(unset.stderr, /a6g: Ditto isn't connected on this machine \(no server set\): a6g ditto fixture --grant --server/);

    // Connected, but no grant yet: the server still starts, with no token, and says why it's closed.
    write(a6gHome, { "ditto.json": { server: ditto.server } });
    assert.equal(start().status, 7, "the server's own exit code");
    assert.deepEqual({ ...ditto.calls().at(-1), cwd: "" }, { cmd: "serve", rest: [], cwd: "", token: null });

    writeFileSync(join(fakeKeychain(), "a6g-ditto"), TOKEN);
    assert.equal(start().status, 7);
    const served = ditto.calls().at(-1);
    assert.equal(served?.token, TOKEN);
    assert.equal(served?.cwd, folder, "in the member's folder, which the grant is bound to");
  });
});
