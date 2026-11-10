// Secrets don't merge. What a branch would bring into the repository is read before it's pushed or merged: the lines
// each of its commits adds (the history, not the net diff: a commit that removes a key leaves it in the branch), their
// messages, and the files they add or change.
//
// Only shapes that are real by construction are refused, because nothing passes a refusal here: test-mode keys,
// JWTs, public API keys and text that only looks random are left alone. A made-up value in a test is built there.

import { execFileSync } from "node:child_process";
import { isSecretFile } from "./policies.ts";

// One thing found: where, and what kind. Never the value.
export interface Leak {
  kind: string;
  commit: string;
  file: string | null;
  line: number | null;
}

// A value's own text, after its prefix: a real one isn't one character repeated, or a word.
const made = (body: string): boolean => new Set(body.replace(/[-_.]/g, "")).size >= 8;

const SHAPES: { kind: string; shape: RegExp; body?: RegExp; real?: (value: string) => boolean }[] = [
  { kind: "a live Stripe key", shape: /\b[sr]k_live_[0-9a-zA-Z]{24,}/g, body: /^.k_live_/ },
  { kind: "a Stripe webhook secret", shape: /\bwhsec_[0-9a-zA-Z]{32,}/g, body: /^whsec_/ },
  // The documentation's own (AKIAIOSFODNN7EXAMPLE) is no key.
  { kind: "an AWS access key id", shape: /\bAKIA[0-9A-Z]{16}\b/g, body: /^AKIA/, real: (value) => !value.endsWith("EXAMPLE") },
  { kind: "a GitHub token", shape: /\b(?:gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z]{22}_[0-9A-Za-z]{59,})/g, body: /^(?:gh._|github_pat_)/ },
  { kind: "a Slack token", shape: /\bxox[abprs]-(?:\d{8,}-)+[0-9A-Za-z]{20,}/g, body: /^xox.-(?:\d+-)+/ },
  { kind: "an Anthropic API key", shape: /\bsk-ant-[a-z]+\d{2}-[0-9A-Za-z_-]{80,}/g, body: /^sk-ant-[a-z]+\d{2}-/ },
  // Every OpenAI key carries this marker in its middle.
  { kind: "an OpenAI API key", shape: /\bsk-(?:[a-z]+-)?[0-9A-Za-z_-]{20,}T3BlbkFJ[0-9A-Za-z_-]{20,}/g, body: /^sk-(?:[a-z]+-)?/ },
  { kind: "a SendGrid API key", shape: /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}/g, body: /^SG\./ },
];

// The kinds of live credential a line of text holds.
export function shapesIn(text: string): string[] {
  return SHAPES.filter(({ shape, body, real }) =>
    (text.match(shape) ?? []).some((value) => made(body ? value.replace(body, "") : value) && (real?.(value) ?? true))
  ).map(({ kind }) => kind);
}

// A private key is its header and the key under it: the header alone is what code that reads one looks for.
const KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_BODY = /[A-Za-z0-9+/]{40,}/;
const KEY_WITHIN = 4;

export interface Added {
  commit: string;
  file: string;
  line: number;
  text: string;
}

// The lines each commit adds, from `git log -p --cc --format=%x01%H`. Read hunk by hunk, by each hunk's own counts, so
// a line of a file is never taken for a header. A merge's hunks (@@@, one column per parent) give the lines no parent
// had: what the merge itself wrote.
export function addedLines(log: string): Added[] {
  const added: Added[] = [];
  let commit = "";
  let file = "";
  let parents = 1;
  // What's left of the hunk being read: each parent's lines, then the result's.
  let left: number[] = [];
  let at = 0;
  for (const line of log.split("\n")) {
    if (left.some((count) => count > 0)) {
      if (line.startsWith("\\")) continue;
      const marks = line.slice(0, parents).padEnd(parents);
      const kept = !marks.includes("-");
      for (let parent = 0; parent < parents; parent++) if (marks[parent] === "-" || (kept && marks[parent] === " ")) left[parent]!--;
      if (!kept) continue;
      if (marks === "+".repeat(parents)) added.push({ commit, file, line: at, text: line.slice(parents) });
      left[parents]!--;
      at++;
      continue;
    }
    if (line.startsWith("\x01")) {
      commit = line.slice(1);
      file = "";
    } else if (line.startsWith("diff --")) file = "";
    else if (line.startsWith("+++ b/")) file = line.slice(6).replace(/\t$/, "");
    else {
      const hunk = /^(@@+) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1/.exec(line);
      if (!hunk) continue;
      const olds = hunk[2]!.trim().split(" ");
      parents = olds.length;
      left = [...olds.map((range) => Number(range.split(",")[1] ?? 1)), Number(hunk[4] ?? 1)];
      at = Number(hunk[3]);
    }
  }
  return added;
}

// The live credentials among the lines commits add.
export function leaksIn(added: Added[]): Leak[] {
  const leaks: Leak[] = [];
  added.forEach(({ commit, file, line, text }, index) => {
    for (const kind of shapesIn(text)) leaks.push({ kind, commit, file, line });
    const header = KEY_HEADER.exec(text);
    if (!header) return;
    // The key follows on the same line (a JSON string, a one-line literal), or on the lines the commit adds under it.
    const under = added.slice(index + 1, index + 1 + KEY_WITHIN).filter((next) => next.commit === commit && next.file === file);
    if ([text.slice(header.index + header[0].length), ...under.map((next) => next.text)].some((rest) => KEY_BODY.test(rest)))
      leaks.push({ kind: "a private key", commit, file, line });
  });
  return leaks;
}

// The test lane's own env files (.env.test, .env.e2e) merge by name; their lines are read like any file's.
const TEST_ENV = /(^|\/)\.env\.(test|e2e)$/;

// The secrets files commits add or change, from `git log -z --name-only --format=%x01%H`.
export function secretFilesIn(listing: string): Leak[] {
  return listing
    .split("\x01")
    .filter(Boolean)
    .flatMap((chunk) => {
      const [commit = "", ...paths] = chunk.split("\0");
      return paths
        .map((path) => path.replace(/^\n/, ""))
        .filter((path) => path && isSecretFile(path) && !TEST_ENV.test(path))
        .map((file) => ({ kind: "a secrets file", commit, file, line: null }));
    });
}

// The live credentials in commits' messages, from `git log --format=%x01%H%n%B`.
export function messageLeaksIn(log: string): Leak[] {
  return log
    .split("\x01")
    .filter(Boolean)
    .flatMap((chunk) => {
      const [commit = "", ...message] = chunk.split("\n");
      const text = message.join("\n");
      return [
        ...new Set([...message.flatMap(shapesIn), ...(KEY_HEADER.test(text) && KEY_BODY.test(text.replace(KEY_HEADER, "")) ? ["a private key"] : [])]),
      ].map((kind) => ({ kind, commit, file: null, line: null }));
    });
}

// Everything a range of commits (integration..tip) would bring in. `git` returns a command's output, and throws when
// it fails: a branch that can't be read is refused, not passed unread.
export function leaksInRange(git: (...args: string[]) => string, range: string): Leak[] {
  const patches = git("-c", "core.quotePath=false", "log", "-p", "--cc", "-M", "--no-color", "--no-ext-diff", "--no-textconv", "--format=%x01%H", range);
  const files = git("log", "-z", "--name-only", "-M", "--diff-filter=AMT", "--cc", "--format=%x01%H", range);
  const messages = git("log", "--format=%x01%H%n%B", range);
  const seen = new Set<string>();
  return [...secretFilesIn(files), ...leaksIn(addedLines(patches)), ...messageLeaksIn(messages)].filter((leak) => {
    const key = [leak.kind, leak.commit, leak.file, leak.line].join("\0");
    return !seen.has(key) && seen.add(key);
  });
}

// A worktree's own branch, read with git there. Past the buffer git's output is cut off, and the read throws.
export const leaksInWorktree = (cwd: string, range: string): Leak[] =>
  leaksInRange((...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }), range);

const SHOWN = 5;
const where = (leak: Leak): string => {
  const commit = `commit ${leak.commit.slice(0, 9)}`;
  if (leak.file === null) return `${leak.kind} in the message of ${commit}`;
  return leak.line === null ? `${leak.kind}, ${leak.file} (${commit})` : `${leak.kind} at ${leak.file}:${leak.line} (${commit})`;
};

// What the member is told: where each is, never the value, and the way through.
export function leakRefusal(branch: string, leaks: Leak[]): string {
  const more = leaks.length > SHOWN ? `; and ${leaks.length - SHOWN} more` : "";
  return (
    `${branch} would bring ${leaks.length === 1 ? "a secret" : "secrets"} into the repository: ${leaks.slice(0, SHOWN).map(where).join("; ")}${more}. ` +
    "A commit that removes it leaves it in the branch's history: rewrite the commits that hold it so none carries it (git rebase, or git reset --soft " +
    "<the commit before them> and commit afresh), then submit again. A real key that reached a commit is the operator's to rotate: the planner tells " +
    "them which. A made-up value a test needs is built in the test (generated, or joined from parts), so no file holds a real one's shape; a secrets " +
    "file that holds no secrets is the operator's to commit."
  );
}
