import { baseTeam, commit, a6g, git, makeRepo, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { addedLines, leakRefusal, leaksIn, leaksInWorktree, messageLeaksIn, secretFilesIn, shapesIn } from "../lib/secrets.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask } from "../lib/tasks/model.ts";

// Values with a real one's shape, built here from parts: no file of the factory's holds one, as it asks of a team's.
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const chars = (count: number, from = LETTERS): string => Array.from({ length: count }, (_, i) => from[(i * 7 + 3) % from.length]).join("");
const FAKES: Record<string, string[]> = {
  "a live Stripe key": [["sk", "live", chars(24)].join("_"), ["rk", "live", chars(30)].join("_")],
  "a Stripe webhook secret": [["whsec", chars(32)].join("_")],
  "an AWS access key id": [`AK${"IA"}${chars(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`],
  "a GitHub token": [["ghp", chars(36)].join("_"), ["github", "pat", chars(22), chars(59)].join("_")],
  "a Slack token": [["xoxb", "123456789012", "1234567890123", chars(24)].join("-")],
  "an Anthropic API key": [["sk", "ant", "api03", chars(93)].join("-")],
  "an OpenAI API key": [["sk", "proj", `${chars(40)}T3Blbk${"FJ"}${chars(40)}`].join("-")],
  "a SendGrid API key": [["SG", chars(22), chars(43)].join(".")],
};
const LIVE = FAKES["a live Stripe key"]![0]!;
const KEY_HEADER = ["-----BEGIN", "RSA", "PRIVATE KEY-----"].join(" ");
const KEY_BODY = chars(64);

describe("a live credential, by its shape", () => {
  test("each kind is found, wherever it sits in a line", () => {
    for (const [kind, values] of Object.entries(FAKES))
      for (const value of values) {
        assert.deepEqual(shapesIn(value), [kind], kind);
        assert.deepEqual(shapesIn(`  const key = "${value}"; // for now`), [kind], `${kind}, in code`);
      }
    assert.deepEqual(shapesIn(`STRIPE=${LIVE} HOOK=${FAKES["a Stripe webhook secret"]![0]}`), ["a live Stripe key", "a Stripe webhook secret"]);
  });

  test("what only looks like one is left alone: nothing passes a refusal here, so a false alarm would be a stall", () => {
    const not = [
      ["sk", "test", chars(24)].join("_"),
      ["pk", "live", chars(24)].join("_"),
      // Placeholders: one character repeated, or words.
      ["sk", "live", "x".repeat(24)].join("_"),
      ["sk", "live", "0000111100001111000011110000"].join("_"),
      ["ghp", "0".repeat(36)].join("_"),
      "sk_live_YOUR_KEY_HERE",
      "whsec_test_secret",
      // The documentation's own.
      `AK${"IA"}IOSFODNN7EXAMPLE`,
      // Public by design, or not a credential at all.
      `AIza${chars(35)}`,
      `eyJhbGciOiJIUzI1NiJ9.${chars(40)}.${chars(43)}`,
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "3f2b8c1e-7a4d-4e9b-9c55-0d6f1a2b3c4d",
      "const key = process.env.STRIPE_SECRET_KEY;",
      `sk-${chars(48)}`,
      KEY_HEADER,
    ];
    for (const text of not) assert.deepEqual(shapesIn(text), [], text);
  });
});

describe("the lines a branch's commits add", () => {
  test("are read hunk by hunk: a line of a file is never a header, and a removed line never counts", () => {
    const log = [
      "\x01aaa",
      "",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,3 +3,4 @@ export function a() {",
      " kept",
      "-removed",
      "+added",
      "+++ b/not-a-header.ts",
      " last",
      "@@ -20 +21,2 @@",
      " one",
      "+two",
      "\\ No newline at end of file",
      "diff --git a/my file.txt b/my file.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/my file.txt\t",
      "@@ -0,0 +1 @@",
      "+spaced",
      "\x01bbb",
      "",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-x",
      "-y",
      "",
    ].join("\n");
    assert.deepEqual(addedLines(log), [
      { commit: "aaa", file: "src/a.ts", line: 4, text: "added" },
      { commit: "aaa", file: "src/a.ts", line: 5, text: "++ b/not-a-header.ts" },
      { commit: "aaa", file: "src/a.ts", line: 22, text: "two" },
      { commit: "aaa", file: "my file.txt", line: 1, text: "spaced" },
    ]);
  });

  test("a merge's own lines are the ones no parent had", () => {
    const log = [
      "\x01ccc",
      "",
      "diff --cc x.txt",
      "index b5735da,dcc8a00..fca4bd3",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@@ -1,4 -1,3 +1,5 @@@",
      "  a",
      "- b",
      "+ main",
      "  c",
      " +feat",
      "++evil",
      "diff --cc new.txt",
      "index 0000000,0000000..4c8df28",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@@ -1,0 -1,0 +1,1 @@@",
      "++in the merge",
      "",
    ].join("\n");
    assert.deepEqual(addedLines(log), [
      { commit: "ccc", file: "x.txt", line: 5, text: "evil" },
      { commit: "ccc", file: "new.txt", line: 1, text: "in the merge" },
    ]);
  });

  test("a private key is its header with the key under it, or after it on the line", () => {
    const line = (text: string, at: number, file = "src/k.ts", commit = "aaa") => ({ commit, file, line: at, text });
    assert.deepEqual(leaksIn([line(`if (pem.startsWith("${KEY_HEADER}")) return parse(pem);`, 1), line("return null;", 2)]), [], "code that reads one");
    assert.deepEqual(leaksIn([line(KEY_HEADER, 7), line(KEY_BODY, 8)]), [{ kind: "a private key", commit: "aaa", file: "src/k.ts", line: 7 }]);
    assert.deepEqual(
      leaksIn([line(`  "private_key": "${KEY_HEADER}\\n${KEY_BODY}\\n",`, 3, "sa.json")]).map((leak) => leak.kind),
      ["a private key"]
    );
    assert.deepEqual(leaksIn([line(KEY_HEADER, 1), line(KEY_BODY, 1, "other.ts")]), [], "another file's line isn't under it");
    assert.deepEqual(leaksIn([line(`key: ${LIVE}`, 12)]), [{ kind: "a live Stripe key", commit: "aaa", file: "src/k.ts", line: 12 }]);
  });

  test("secrets files are the guard's own list, less the examples and the test lane's env files", () => {
    const listing = `\x01aaa\0\n.env.local\0src/a.ts\0certs/server.pem\0.env.example\0e2e/.env.test\0.env.e2e\0\x01bbb\0\0apps/web/.npmrc\0`;
    assert.deepEqual(
      secretFilesIn(listing).map((leak) => [leak.commit, leak.file]),
      [
        ["aaa", ".env.local"],
        ["aaa", "certs/server.pem"],
        ["bbb", "apps/web/.npmrc"],
      ]
    );
  });

  test("a commit's message is read too", () => {
    const log = `\x01aaa\nUse the key\n\n${LIVE} until the vault is ready\n\n\x01bbb\nA plain message\n\n`;
    assert.deepEqual(messageLeaksIn(log), [{ kind: "a live Stripe key", commit: "aaa", file: null, line: null }]);
  });

  test("the refusal says where and what, never the value, and the way through", () => {
    const said = leakRefusal("a6g/b1-pay", [
      { kind: "a live Stripe key", commit: "0123456789abcdef", file: "src/pay.ts", line: 12 },
      { kind: "a secrets file", commit: "0123456789abcdef", file: ".env.local", line: null },
      { kind: "a GitHub token", commit: "fedcba9876543210", file: null, line: null },
    ]);
    assert.match(said, /a live Stripe key at src\/pay\.ts:12 \(commit 012345678\); a secrets file, \.env\.local \(commit 012345678\)/);
    assert.match(said, /a GitHub token in the message of commit fedcba987/);
    assert.match(said, /rewrite the commits that hold it/);
    assert.match(said, /the operator's to rotate/);
    assert.match(
      leakRefusal(
        "b",
        Array.from({ length: 8 }, (_, i) => ({ kind: "a secrets file", commit: "c", file: `.env.${i}`, line: null }))
      ),
      /; and 3 more\./
    );
  });
});

// Each checkout's run folder beside it (the default is the team's name, which every fixture shares).
const merge = (home: string, ...args: string[]) => a6g(["merge", ...args], { cwd: home, env: { A6G_HOME_DIR: home, A6G_RUN: `${home}-run` } });
const approve = (home: string, branch: string) =>
  a6g(["verdict", "review", branch, "approve", "--sha", git(home, "rev-parse", branch), "--risk", "low", "--note", "ok"], {
    cwd: home,
    env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: "reviewer", A6G_RUN: `${home}-run` },
  });
const record = (home: string, branch: string): { result: string; message: string } =>
  JSON.parse(readFileSync(join(home, ".a6g/run/state/merges", `${branch.replaceAll("/", "_")}.json`), "utf8"));

describe("secrets don't merge", { concurrency: true }, () => {
  test("a key a later commit removed is still in the branch: refused, and its task goes back to be rebuilt", async () => {
    const home = makeRepo(baseTeam(), { ".a6g/run/board/1-pay.md": "status: review\nkind: feature\n\nTake payments.\n" });
    const before = git(home, "rev-parse", "a6g/next");
    git(home, "checkout", "-q", "-b", "a6g/b1-pay");
    const held = commit(home, { "src/pay.ts": `export const pay = () => charge();\nconst key = "${LIVE}";\n` }, "take payments");
    commit(home, { "src/pay.ts": "export const pay = () => charge();\nconst key = process.env.STRIPE_KEY;\n" }, "read the key from the environment");
    git(home, "checkout", "-q", "a6g/next");
    await approve(home, "a6g/b1-pay");

    const result = await merge(home, "a6g/b1-pay");
    assert.equal(result.code, 2, result.out);
    const { message } = record(home, "a6g/b1-pay");
    assert.match(message, new RegExp(`a live Stripe key at src/pay\\.ts:2 \\(commit ${held.slice(0, 9)}\\)`));
    assert.match(message, /task 1 went back to be claimed and rebuilt/);
    assert.ok(!`${message}${result.out}`.includes(LIVE), "the value is never repeated");
    assert.equal(git(home, "rev-parse", "a6g/next"), before, "nothing merged");
    const task = await fileStore(`${home}-run`, "fixture").tasks.get("1");
    assert.deepEqual([task?.status, task?.sha], ["approved", null]);
    assert.match(task?.notes.at(-1)?.text ?? "", /rewrite the commits that hold it/);
    assert.ok(!JSON.stringify(task).includes(LIVE));

    // Rebuilt without it, and reviewed again, it merges.
    git(home, "checkout", "-q", "a6g/b1-pay");
    git(home, "reset", "-q", "--soft", "a6g/next");
    git(home, "commit", "-qm", "take payments");
    git(home, "checkout", "-q", "a6g/next");
    await approve(home, "a6g/b1-pay");
    const again = await merge(home, "a6g/b1-pay");
    assert.equal(again.code, 0, again.out);
  });

  test("a secrets file, a key in a commit's message and a key a merge commit wrote are refused; an example file isn't", async () => {
    const home = makeRepo();
    const branch = (name: string, files: Record<string, unknown>, message = `work on ${name}`) => {
      git(home, "checkout", "-q", "-b", name, "a6g/next");
      const sha = commit(home, files, message);
      git(home, "checkout", "-q", "a6g/next");
      return sha;
    };
    branch("a6g/b2-env", { ".env.local": "PORT=3000\n", "src/two.ts": "2\n" });
    branch("a6g/b3-message", { "src/three.ts": "3\n" }, `Use ${FAKES["a GitHub token"]![0]} for now`);
    for (const [name, said] of [
      ["a6g/b2-env", /a secrets file, \.env\.local/],
      ["a6g/b3-message", /a GitHub token in the message of commit/],
    ] as const) {
      await approve(home, name);
      const result = await merge(home, name);
      assert.equal(result.code, 2, `${name}: ${result.out}`);
      assert.match(record(home, name).message, said);
    }

    // The branch merges the integration branch in, and the merge commit itself adds a key that a later commit takes out.
    branch("a6g/b4-merged", { "src/four.ts": "4\n" });
    commit(home, { "src/moved.ts": "the integration branch moved\n" }, "something else merged");
    git(home, "checkout", "-q", "a6g/b4-merged");
    git(home, "merge", "-q", "--no-commit", "--no-ff", "a6g/next");
    write(home, { "src/four.ts": `4\n// ${LIVE}\n` });
    git(home, "add", "-A");
    git(home, "commit", "-qm", "merge the integration branch");
    const merged = git(home, "rev-parse", "HEAD");
    commit(home, { "src/four.ts": "4\n" }, "tidy");
    git(home, "checkout", "-q", "a6g/next");
    await approve(home, "a6g/b4-merged");
    const result = await merge(home, "a6g/b4-merged");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/b4-merged").message, new RegExp(`a live Stripe key at src/four\\.ts:2 \\(commit ${merged.slice(0, 9)}\\)`));

    branch("a6g/b5-example", { ".env.example": "STRIPE_KEY=\n", "src/five.ts": "const header = '-----BEGIN PRIVATE KEY-----';\n" });
    await approve(home, "a6g/b5-example");
    const fine = await merge(home, "a6g/b5-example");
    assert.equal(fine.code, 0, fine.out);
  });
});

describe("secrets don't leave a member's worktree", () => {
  function setup() {
    const home = makeRepo(baseTeam({ roles: { planner: {}, builder: { limit: 2 }, reviewer: { limit: 1 }, approver: { limit: 1 } } }));
    const run = tmp("a6g-run-");
    const as = (role: string, cwd = home) => ({ cwd, env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: role, A6G_RUN: run } });
    const worktree = (name: string) => {
      const dir = join(tmp("a6g-wt-"), name);
      git(home, "worktree", "add", "-q", "-b", `wt/${name}`, dir, "a6g/next");
      return realpathSync(dir);
    };
    return { home, run, as, worktree, store: () => fileStore(run, "fixture") };
  }

  test("a6g task submit refuses a branch that holds one, and takes it rebuilt", async () => {
    const { as, worktree, store } = setup();
    await store().tasks.createAs("1", newTask({ team: "fixture", title: "pay", kind: "feature", status: "approved", by: "planner" }));
    const tree = worktree("pay");
    await a6g(["task", "claim"], as("builder", tree));
    git(tree, "branch", "-m", "a6g/b1-pay");
    const held = commit(tree, { "src/pay.ts": `const key = "${LIVE}";\n` }, "take payments");
    commit(tree, { "src/pay.ts": "const key = process.env.STRIPE_KEY;\n" }, "read it from the environment");
    assert.deepEqual(
      leaksInWorktree(tree, "a6g/next..HEAD").map((leak) => [leak.kind, leak.file, leak.line, leak.commit]),
      [["a live Stripe key", "src/pay.ts", 1, held]]
    );
    const refused = await a6g(["task", "submit", "1"], as("builder", tree));
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /a live Stripe key at src\/pay\.ts:1/);
    assert.ok(!refused.out.includes(LIVE));
    assert.equal((await store().tasks.get("1"))?.status, "building", "still the builder's");

    git(tree, "reset", "-q", "--soft", "a6g/next");
    git(tree, "commit", "-qm", "take payments");
    const submitted = await a6g(["task", "submit", "1"], as("builder", tree));
    assert.equal(submitted.code, 0, submitted.out);
  });

  test("a round that held one is the rework that doesn't build on its round", async () => {
    const { as, worktree, store } = setup();
    // A round handed in before this was read (an upgrade with work in flight), then sent back with changes.
    const tree = worktree("round");
    git(tree, "checkout", "-q", "-b", "a6g/b1-pay");
    const round = commit(tree, { "src/pay.ts": `const key = "${LIVE}";\n` }, "take payments");
    await store().tasks.createAs("1", {
      ...newTask({ team: "fixture", title: "pay", kind: "feature", status: "approved", by: "planner" }),
      rounds: 1,
      sha: round,
      branch: "a6g/b1-pay",
    });
    const claimed = await a6g(["task", "claim", "1"], as("builder", tree));
    assert.equal(claimed.code, 0, claimed.out);
    assert.equal(git(tree, "rev-parse", "HEAD"), round);
    git(tree, "reset", "-q", "--soft", "a6g/next");
    write(tree, { "src/pay.ts": "const key = process.env.STRIPE_KEY;\n" });
    git(tree, "add", "-A");
    git(tree, "commit", "-qm", "take payments");
    const submitted = await a6g(["task", "submit", "1"], as("builder", tree));
    assert.equal(submitted.code, 0, submitted.out);
  });
});
