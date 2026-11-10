// The merge queue's check after merges: the team's pages and its end-to-end suite, re-run on the integration branch, so
// what was done stays done. One check for the newest commit, however many merged meanwhile: each merge that lands marks
// a check due, and every queued merge, however it ends, runs one that's due unless another merge is queued behind it (a
// check already running takes the newer commit when it finishes). It holds the merge lock (nothing fast-forwards the
// checkout), then the app lock (nothing restarts the app), then a gate slot, in that order, as every holder of those
// locks takes them; and it throws a run away if the checkout's commit moved anyway.
//
// The app's health comes first: an app that's down is one finding, nothing else runs, and the check stays due. Then
// what newly fails becomes a finding by the merge queue, naming the merges since it last passed: one per page, one per
// spec file, one for a suite or page checks that didn't run, one for a suite that checks less than its last run did. A
// test that passes only on its retry is filed as flaky, for the scaffolder; the harness's gaps are filed once; and the
// journeys whose proof now holds are closed. The planner is woken when there's anything new.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { forgetRun, journeyProofFor, notRun, recordSuite, suiteHistory, tally } from "./commands/e2e.ts";
import { fewerTests } from "./commands/harness.ts";
import { differentLooks, recordPages, type PageResult } from "./commands/pages.ts";
import type { LoadedTeam, Team } from "./config.ts";
import { HARNESS_FILE, pagePlan, readHarness } from "./harness.ts";
import { acquire, sameProcess, startOf } from "./lock.ts";
import { stateDir } from "./paths.ts";
import { checks, journeysOf, passed, type SpecResult, type SuiteRecord } from "./suite.ts";
import { addTask } from "./tasks/add.ts";
import { type Kind, MERGE, type Severity } from "./tasks/model.ts";
import { openTeamStore, settleWaits } from "./tasks/ops.ts";
import type { Store } from "./tasks/store.ts";
import { answers, localTime, readJson, writeJson } from "./util.ts";

const dueFile = (state: string): string => join(state, "verify-due.json");
const filedFile = (state: string): string => join(state, "verify-filed.json");
const lastFile = (state: string): string => join(state, "verify-last.json");
const baselineFile = (state: string): string => join(state, "verify-suite.json");
export const pendingDir = (state: string): string => join(state, "merges", "pending");
const head = (home: string): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: home, encoding: "utf8" }).trim();
const contains = (home: string, ancestor: string, commit: string): boolean =>
  spawnSync("git", ["merge-base", "--is-ancestor", ancestor, commit], { cwd: home }).status === 0;
const firstLine = (error: unknown): string => String((error as Error).message ?? error).split("\n")[0] ?? "";
const parsed = <T>(file: string): T | null => {
  try {
    return readJson<T | null>(file, null);
  } catch {
    return null;
  }
};

// A queued merge's mark (state/merges/pending/<branch>.json): the process that runs it and when that process started,
// as a lock's owner is kept (lib/lock.ts), so a pid the machine hands to something else doesn't read as a merge still
// queued. The merge that queues writes it; the queued run clears its own however it ends.
interface Pending {
  pid?: number;
  started?: string | null;
  at?: string;
}
// With no start time to compare (ps didn't say), a mark this old is nobody's: longer than a merge waits and runs.
const MARK_MAX_MS = 6 * 60 * 60_000;
export function markQueued(file: string, pid: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { pid, started: startOf(pid), at: new Date().toISOString() } satisfies Pending);
}
export function clearQueued(file: string, pid = process.pid): void {
  if (parsed<Pending>(file)?.pid === pid) rmSync(file, { force: true });
}

// Whether a merge is queued besides this process's own: its mark names a process that's still the one that wrote it.
// A mark whose process is gone is cleared on the way.
export function othersQueued(state: string, own = process.pid): boolean {
  const dir = pendingDir(state);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
  let queued = false;
  for (const name of names) {
    const mark = parsed<Pending>(join(dir, name));
    if (typeof mark?.pid !== "number" || mark.pid === own) continue;
    const old = !mark.started && Date.now() - Date.parse(mark.at ?? "") > MARK_MAX_MS;
    if (!old && sameProcess(mark.pid, mark.started)) queued = true;
    else rmSync(join(dir, name), { force: true });
  }
  return queued;
}

// The subjects of the merges in `from`..`to` (all of `to`'s when `from` is null), for a finding.
function mergesBetween(home: string, from: string | null, to: string): string[] {
  try {
    const range = from ? `${from}..${to}` : to;
    return execFileSync("git", ["log", "--merges", "--first-parent", "--format=%h %s", "-n", "20", range], { cwd: home, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}
const mergedSince = (home: string, from: string | null, to: string, passedAt = "It passed at"): string =>
  `${from ? `${passedAt} ${from.slice(0, 9)}; merged since:` : "Merged lately:"}\n${
    mergesBetween(home, from, to)
      .slice(0, 10)
      .map((m) => `- ${m}`)
      .join("\n") || "- (none found)"
  }`;

interface Finding {
  title: string;
  kind: Kind;
  severity: Severity;
  body: string;
}

// Files a finding once: nothing new while one with the same key is open, or once the planner rejected it; again when
// one was done and it came back. Resolves to the new task's id, or null. For what stays true until someone acts (a
// gap, a flaky test, one commit that checks less): a rejection is an answer to the whole of it.
async function fileOnce(store: Store, team: Team, key: string, input: Finding): Promise<string | null> {
  const marker = `(a6g: ${key})`;
  const earlier = (await store.tasks.all()).filter((t) => t.body.includes(marker));
  if (earlier.some((t) => t.status !== "done")) return null;
  const task = await addTask(store, team.name, { ...input, body: `${input.body}\n\n${marker}` }, MERGE);
  return task.id;
}

// What the check last filed for each thing that can fail (a page, a spec file, the app, the suite, the page checks):
// the finding, what the failure was, and whether it has passed since. state/verify-filed.json.
interface Filed {
  task: string;
  signature: string;
  passed: boolean;
}
type Memory = Record<string, Filed>;

// Files a failure: nothing new while a finding for the same thing is open. A rejected finding quiets that failure, not
// that thing: the same failure stays quiet, and a different one, or the same one after a pass, is filed again.
async function fileFailure(store: Store, team: Team, memory: Memory, key: string, signature: string, input: Finding): Promise<string | null> {
  const marker = `(a6g: ${key})`;
  const earlier = (await store.tasks.all()).filter((t) => t.body.includes(marker));
  if (earlier.some((t) => t.status !== "done" && t.status !== "rejected")) return null;
  const last = memory[key];
  if (last && !last.passed && last.signature === signature && earlier.some((t) => t.id === last.task && t.status === "rejected")) return null;
  const task = await addTask(store, team.name, { ...input, body: `${input.body}\n\n${marker}` }, MERGE);
  memory[key] = { task: task.id, signature, passed: false };
  return task.id;
}

// What a failure is, apart from the numbers that change from run to run: a page's failing checks by viewport and
// scheme (axe keeps its rules), a spec file's failing tests, a reason something didn't run.
const steady = (text: string): string => text.replace(/\d+/g, "#").slice(0, 200);
const pageSignature = (result: PageResult): string =>
  [
    ...new Set(
      result.runs.flatMap((run) => run.problems.map((p) => `${run.viewport}/${run.scheme}: ${p.startsWith("axe: ") ? p : steady(p.split(": ")[0] ?? p)}`))
    ),
  ]
    .sort()
    .join("\n");

// The harness's gaps, filed once: a team with a scaffolder and no manifest; a journey with no tagged test in the
// latest run; a test that passed only on its retry. `record` is a run that ran, or null.
export async function fileGaps(store: Store, team: Team, home: string, record: SuiteRecord | null): Promise<string[]> {
  const filed: string[] = [];
  const { harness } = readHarness(home);
  const all = await store.tasks.all();
  if (!harness && team.roles["scaffolder"]) {
    const id = await fileOnce(store, team, "gap:harness", {
      title: "Set up the browser test harness",
      kind: "test-infra",
      severity: "major",
      body: `The team has no harness manifest (${HARNESS_FILE}), so its pages are checked only as team.json lists them and its journeys have no specs to prove them. The scaffolder sets Playwright up in the repository, with a sign-in for each kind of user, test data under A6G_NAMESPACE, stable screenshots, each page people reach, how the app switches to dark, and one spec file per journey tagged @journey-<id>.`,
    });
    if (id) filed.push(id);
  }
  if (record?.ran && harness?.e2e) {
    for (const journey of all.filter((t) => t.kind === "journey" && t.status !== "rejected")) {
      if (record.specs.some((spec) => journeysOf(spec).includes(journey.id))) continue;
      const id = await fileOnce(store, team, `gap:journey:${journey.id}`, {
        title: `Journey ${journey.id} has no end-to-end spec`,
        kind: "test",
        severity: "major",
        body: `No test in the suite at ${record.commit.slice(0, 9)} is tagged @journey-${journey.id} ("${journey.title}"). A journey is done only while its specs pass: one spec file that walks its steps as a person would and asserts each of its criteria, written by a tester (or the scaffolder where the team has none), never by who built it.`,
      });
      if (id) filed.push(id);
    }
    for (const spec of record.specs.filter((s) => s.outcome === "flaky")) {
      const id = await fileOnce(store, team, `verify:flaky:${spec.id}`, {
        title: `Flaky test: ${spec.title}`.slice(0, 120),
        kind: "test-infra",
        severity: "minor",
        body: `${spec.id} failed and then passed on its retry at ${record.commit.slice(0, 9)}${spec.error ? ` (first: ${spec.error})` : ""}. Find why (data another run shares, a fixed wait instead of waiting for a state, an order the tests depend on, an animation) and fix that; never a retry, a skip, a longer timeout or a looser assertion (Article 5).`,
      });
      if (id) filed.push(id);
    }
  }
  return filed;
}

// The findings a run's failures make: one per page, one per spec file. What passed is remembered as passed.
async function fileFailures(
  store: Store,
  team: Team,
  home: string,
  memory: Memory,
  {
    pages,
    before,
    suite,
    at,
  }: { pages: Record<string, PageResult> | null; before: Record<string, { passed: boolean; commit: string }>; suite: SuiteRecord | null; at: string }
): Promise<string[]> {
  const filed: string[] = [];
  for (const [id, result] of Object.entries(pages ?? {})) {
    const key = `verify:page:${id}`;
    if (result.passed) {
      if (memory[key]) memory[key].passed = true;
      continue;
    }
    const problems = result.runs.flatMap((run) => run.problems.map((problem) => `- ${run.viewport}/${run.scheme}: ${problem}`));
    const last = before[id]?.passed ? (before[id]?.commit ?? null) : null;
    const broken = problems.some((line) => /HTTP \d|didn't load|errors:|console:|sign-in/.test(line));
    const task = await fileFailure(store, team, memory, key, pageSignature(result), {
      title: `Page ${id} fails its checks after merges`,
      kind: broken ? "bug" : "ux",
      severity: "major",
      body: `Checked at ${at.slice(0, 9)} after merges, page ${id} fails:\n${problems.slice(0, 12).join("\n")}\n\n${mergedSince(home, last, at)}\n\nScreenshots: .a6g/run/shots/${id}/`,
    });
    if (task) filed.push(task);
  }
  if (!suite?.ran) return filed;
  const failing = suite.specs.filter((spec) => spec.outcome === "failed");
  const byFile = new Map<string, typeof failing>();
  for (const spec of failing) byFile.set(spec.file, [...(byFile.get(spec.file) ?? []), spec]);
  for (const key of Object.keys(memory))
    if (key.startsWith("verify:spec:") && !byFile.has(key.slice("verify:spec:".length)) && memory[key]) memory[key].passed = true;
  const history = suiteHistory(home).slice(1);
  for (const [file, specs] of byFile) {
    const lastPass = history.find((record) => specs.every((spec) => record.specs.some((s) => s.id === spec.id && passed(s))));
    const journeys = [...new Set(specs.flatMap(journeysOf))];
    const signature = specs
      .map((spec) => spec.id)
      .sort()
      .join("\n");
    const task = await fileFailure(store, team, memory, `verify:spec:${file}`, signature, {
      title: `${file}: ${specs.length} test${specs.length === 1 ? " fails" : "s fail"} after merges`,
      kind: "bug",
      severity: "major",
      body: `The suite at ${at.slice(0, 9)} after merges:\n${specs
        .slice(0, 10)
        .map((spec) => `- ${spec.title}${spec.project ? ` [${spec.project}]` : ""}: ${spec.error ?? "failed"}`)
        .join(
          "\n"
        )}\n${journeys.length ? `\nJourneys it proves: ${journeys.map((j) => `#${j}`).join(", ")}; they aren't done while it fails.\n` : ""}\n${mergedSince(home, lastPass?.commit ?? null, at)}`,
    });
    if (task) filed.push(task);
  }
  return filed;
}

// The suite as the last check ran it (state/verify-suite.json): what the next check's run is compared with. The
// check's own, so a run recorded between two checks (a6g e2e run) doesn't become what "before" means.
type Counted = Pick<SpecResult, "id" | "tags" | "outcome">;
interface Baseline {
  commit: string;
  specs: Counted[];
}

// What a run checks less than the one before it: fewer tests that are there to check something (in all, or for a
// journey), or more that are told to skip or to fail. A test a run didn't reach, because an earlier one failed, still
// counts as one that checks: its failure is the finding, not this. Measured from what Playwright reported, so it holds
// however the skip was spelled (a condition, a hook, an environment variable).
export function checksLess(before: { specs: Counted[] }, now: { specs: Counted[] }): { found: string[]; tests: string[] } {
  const count = (record: { specs: Counted[] }) => {
    const running = record.specs.filter(checks);
    const byJourney: Record<string, number> = {};
    for (const spec of running) for (const id of journeysOf(spec)) byJourney[id] = (byJourney[id] ?? 0) + 1;
    return { total: running.length, byJourney, idle: record.specs.length - running.length };
  };
  const [was, is] = [count(before), count(now)];
  const found = fewerTests(was, is);
  if (is.idle > was.idle) found.push(`${is.idle} test${is.idle === 1 ? " is" : "s are"} told to skip or to fail, ${is.idle - was.idle} more than before`);
  if (!found.length) return { found, tests: [] };
  const said = (spec: Counted): string => (spec.outcome === "excused" ? "expected to fail" : "skipped");
  const nowById = new Map(now.specs.map((spec) => [spec.id, spec]));
  const earlier = new Set(before.specs.map((spec) => spec.id));
  const tests = [
    ...before.specs.filter(checks).flatMap((spec) => {
      const same = nowById.get(spec.id);
      return !same ? [`gone: ${spec.id}`] : checks(same) ? [] : [`now ${said(same)}: ${spec.id}`];
    }),
    ...now.specs.filter((spec) => !checks(spec) && !earlier.has(spec.id)).map((spec) => `new, and ${said(spec)}: ${spec.id}`),
  ];
  return { found, tests };
}

// The operator's allowance (a6g harness allow) of a commit that's in `to` and wasn't in `from`, or null.
function allowedBetween(home: string, state: string, from: string, to: string): string | null {
  const dir = join(state, "harness-allow");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {}
  for (const name of names) {
    const allowance = parsed<{ branch?: string; sha?: string; why?: string }>(join(dir, name));
    if (!allowance?.sha || !/^[0-9a-f]{7,64}$/i.test(allowance.sha)) continue;
    if (contains(home, allowance.sha, to) && !contains(home, allowance.sha, from))
      return `${allowance.branch ?? name} at ${allowance.sha.slice(0, 9)}${allowance.why ? ` (${allowance.why})` : ""}`;
  }
  return null;
}

// What keeps the team's app from answering, as its watchdog asks: every environment.health address (any:<url> takes
// any answer), or the app's own address when it lists none. Asked a few times, `waitMs` apart, since an after-merge
// command may have only just restarted it. Null when it answers, or when the team says nowhere to ask.
async function appDown(team: Team, appUrl: string | undefined, waitMs: number): Promise<string | null> {
  const targets = team.environment.health.length ? team.environment.health : appUrl ? [`any:${appUrl}`] : [];
  if (!targets.length) return null;
  let down: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((done) => setTimeout(done, waitMs));
    const up = await Promise.all(targets.map((target) => answers(target)));
    down = targets.filter((_, i) => !up[i]).map((target) => target.replace(/^any:/, ""));
    if (!down.length) return null;
  }
  return `${down.join(", ")} ${down.length === 1 ? "doesn't" : "don't"} answer`;
}

// One check's account: what to tell the planner (null when nothing's new), and whether a check is still due: because
// the commit moved under it, or because it couldn't look (a lock stayed busy, the app is down).
interface Checked {
  told: string | null;
  due?: "moved" | "waiting";
}
export interface CheckOptions {
  // How long between asking a quiet app again, and how long to wait for the merge and app locks: shortened by tests.
  healthWaitMs?: number;
  lockWaitMin?: number;
}

// One check of the integration branch's head, holding merge, app and gate in that order.
async function checkOnce(home: string, team: LoadedTeam, run: string, { healthWaitMs = 5000, lockWaitMin }: CheckOptions): Promise<Checked> {
  const state = stateDir(home);
  const holder = "the merge queue's check";
  const log = (text: string): void => appendFileSync(join(state, "verify.log"), `${localTime()} ${text}\n`);
  const busy = (what: string): Checked => {
    log(`- the check didn't run: ${what}; it's still due`);
    return { told: `verify: ${what}, so the check after merges didn't run; the next merge runs it`, due: "waiting" };
  };
  const merge = await acquire(home, "merge", { slots: 1, waitMin: lockWaitMin ?? 120, holder });
  if (!merge) return busy(`the merge lock stayed busy for ${lockWaitMin ?? 120} minutes`);
  try {
    const app = await acquire(home, "app", { slots: 1, waitMin: lockWaitMin ?? 30, holder });
    if (!app) return busy(`the app lock stayed busy for ${lockWaitMin ?? 30} minutes`);
    process.env.A6G_APP_LOCK = "held";
    try {
      const gate = await acquire(home, "gate", { slots: team.gate.concurrency, waitMin: lockWaitMin ?? 60, holder });
      try {
        const at = head(home);
        const short = at.slice(0, 9);
        const { harness } = readHarness(home);
        const plan = pagePlan(team, harness);
        const board = team.board.type === "tasks";
        const memory = parsed<Memory>(filedFile(state)) ?? {};
        const pass = (key: string): void => {
          if (memory[key]) memory[key].passed = true;
        };
        const filing = async <T>(work: (store: Store) => Promise<T>): Promise<T> => {
          const store = await openTeamStore(team, run, home);
          try {
            return await work(store);
          } finally {
            await store.close();
          }
        };

        // The app first: down, nothing else can be told from what fails.
        const down = await appDown(team, plan.appUrl, healthWaitMs);
        if (down) {
          const last = parsed<{ commit?: string }>(lastFile(state))?.commit ?? null;
          const known = memory["verify:app"] && !memory["verify:app"].passed;
          const filed = board
            ? await filing((store) =>
                fileFailure(store, team, memory, "verify:app", down, {
                  title: "The app is down after merges",
                  kind: "bug",
                  severity: "blocker",
                  body: `Checked at ${short} after merges, the team's app doesn't answer: ${down}. Nothing else was checked (its pages, its end-to-end suite), and the check stays due: the next merge runs it.\n\n${mergedSince(home, last, at, "A check last found it up at")}\n\nSee what's up (a6g env status), start it as the team does, and find which merge keeps it from starting.`,
                })
              )
            : null;
          if (!board) memory["verify:app"] = { task: "", signature: down, passed: false };
          writeJson(filedFile(state), memory);
          log(`${short} the app is down (${down}); nothing was checked, and the check stays due${filed ? `; filed #${filed}` : ""}`);
          const news = board ? Boolean(filed) : !known;
          return {
            told: news
              ? `verify: at ${short}, the app is down after merges (${down}), so nothing was checked.${filed ? ` New finding in triage: #${filed}.` : ""}`
              : null,
            due: "waiting",
          };
        }
        pass("verify:app");

        const before = Object.fromEntries(
          Object.entries(parsed<{ pages?: Record<string, { passed: boolean; commit: string }> }>(join(state, "pages.json"))?.pages ?? {}).map(
            ([id, saved]) => [id, { passed: saved.passed, commit: saved.commit }]
          )
        );
        const said: string[] = [];
        // What didn't run at all: one finding each, with what it said.
        const unrun: { key: string; why: string; finding: Finding }[] = [];
        let pages: Record<string, PageResult> | null = null;
        if (plan.list.length && plan.appUrl)
          try {
            pages = await recordPages(home, team);
            const passing = Object.values(pages).filter((r) => r.passed).length;
            said.push(`pages ${passing}/${Object.keys(pages).length} pass`);
            pass("verify:pages");
          } catch (error) {
            const why = firstLine(error);
            said.push(`the page checks didn't run: ${why}`);
            unrun.push({
              key: "verify:pages",
              why,
              finding: {
                title: "The page checks didn't run after merges",
                kind: "test-infra",
                severity: "major",
                body: `Checked at ${short} after merges, the page checks didn't run, so no page was checked:\n- ${why}\n\n${mergedSince(home, null, at)}\n\na6g pages check, from the team's checkout, shows the same.`,
              },
            });
          }
        let suite: SuiteRecord | null = null;
        if (harness?.e2e) {
          let why: string | null = null;
          try {
            suite = await recordSuite(home, team, { retries: 1, namespace: `verify-${Date.now().toString(36)}` });
            if (!suite.ran) why = notRun(suite);
          } catch (error) {
            why = firstLine(error);
          }
          if (suite?.ran) {
            said.push(`the suite ${tally(suite.specs)}`);
            pass("verify:suite");
          } else {
            said.push(`the suite didn't run: ${why}`);
            unrun.push({
              key: "verify:suite",
              why: why ?? "",
              finding: {
                title: "The end-to-end suite didn't run after merges",
                kind: "test-infra",
                severity: "major",
                body: `Checked at ${short} after merges, the suite didn't run, so it proves nothing and no journey closes on it:\n- ${why}\n\n${mergedSince(home, suiteHistory(home).find((record) => record.ran && record.commit !== at)?.commit ?? null, at, "It last ran at")}\n\na6g e2e run, from the team's checkout, shows the same. Fix what keeps it from starting (its configuration, its set-up, its sign-ins); never by taking tests out (Article 5).`,
              },
            });
          }
        }
        if (head(home) !== at) {
          // A run on a checkout that moved under it says nothing of either commit.
          if (suite) forgetRun(home, suite);
          return { told: null, due: "moved" };
        }

        // Fewer checks than the last check's run, unless the operator allowed a commit merged between them.
        let less: Finding | null = null;
        const earlier = parsed<Baseline>(baselineFile(state));
        if (suite?.ran && earlier?.specs && earlier.commit !== at) {
          const { found, tests } = checksLess(earlier, suite);
          const allowance = found.length ? allowedBetween(home, state, earlier.commit, at) : null;
          if (allowance) said.push(`the suite checks less, as the operator allowed for ${allowance}`);
          else if (found.length) {
            said.push(`the suite checks less: ${found.join("; ")}`);
            less = {
              title: "The suite checks less after merges",
              kind: "test",
              severity: "major",
              body: `The suite at ${short} checks less than it did at ${earlier.commit.slice(0, 9)}: ${found.join("; ")}.\n${tests
                .slice(0, 12)
                .map((t) => `- ${t}`)
                .join(
                  "\n"
                )}\n\n${mergedSince(home, earlier.commit, at, "It checked more at")}\n\nA test that's skipped, removed or told to fail proves nothing (Article 5). Put back what was checked; or it's the operator's call that it may check less (raise it: they reject this finding, or allow the commit with a6g harness allow).`,
            };
          }
        }
        if (suite?.ran)
          writeJson(baselineFile(state), { commit: at, specs: suite.specs.map(({ id, tags, outcome }) => ({ id, tags, outcome })) } satisfies Baseline);

        const different = Object.keys(differentLooks(state));
        let filed: string[] = [];
        let closed: string[] = [];
        if (board)
          await filing(async (store) => {
            for (const { key, why, finding } of unrun) {
              const id = await fileFailure(store, team, memory, key, steady(why), finding);
              if (id) filed.push(id);
            }
            filed.push(...(await fileFailures(store, team, home, memory, { pages, before, suite, at })));
            if (less) {
              const id = await fileOnce(store, team, `verify:less:${short}`, less);
              if (id) filed.push(id);
            }
            filed.push(...(await fileGaps(store, team, home, suite?.ran ? suite : null)));
            // What waited on this run: a journey whose tasks are done closes once its tests pass.
            closed = (await settleWaits(store, MERGE, journeyProofFor(home, team))).filter((s) => s.to === "done").map((s) => s.id);
          });
        filed = [...new Set(filed)];
        writeJson(filedFile(state), memory);
        writeJson(lastFile(state), { commit: at, at: new Date().toISOString() });
        const ids = (list: string[]): string => list.map((id) => `#${id}`).join(", ");
        log(
          `${short} ${said.join("; ") || "nothing to check"}${filed.length ? `; filed ${ids(filed)}` : ""}${closed.length ? `; closed ${ids(closed)}` : ""}`
        );
        if (!filed.length && !closed.length && !different.length) return { told: null };
        return {
          told: `verify: at ${short}, ${said.join("; ") || "nothing to check"}.${filed.length ? ` New findings in triage: ${ids(filed)}.` : ""}${closed.length ? ` Closed, their tests pass: ${ids(closed)}.` : ""}${different.length ? ` Look different since their UX pass: ${different.join(", ")}.` : ""}`,
        };
      } finally {
        gate?.();
      }
    } finally {
      delete process.env.A6G_APP_LOCK;
      app();
    }
  } finally {
    merge();
  }
}

// Whether a check is due, and since when: for a6g status.
export const checkDue = (home: string): { at?: string; after?: string } | null => parsed(dueFile(stateDir(home)));

// For a queued merge, however it ended: a merge that landed marks a check due (`merged`), and every one runs a check
// that's due, unless another merge is queued behind it (which runs it) or a check is running (which takes the newest
// commit when it finishes). A check that couldn't look (a lock stayed busy, the app is down) leaves itself due for the
// next merge; one whose commit moved under it runs once more, then leaves it.
export async function verifyAfterMerge(
  home: string,
  team: LoadedTeam,
  run: string,
  branch: string,
  { wake, merged = true, ...options }: { wake: (text: string) => void; merged?: boolean } & CheckOptions
): Promise<void> {
  const state = stateDir(home);
  mkdirSync(state, { recursive: true });
  if (merged) writeJson(dueFile(state), { at: new Date().toISOString(), after: branch });
  let retried = false;
  // A merge that finished while a check held the lock, and found it taken, left its mark: that's the next round.
  for (let round = 0; round < 4 && existsSync(dueFile(state)); round++) {
    if (othersQueued(state)) return;
    const verify = await acquire(home, "verify", { slots: 1, waitMin: 0, holder: `check after ${branch}` });
    if (!verify) return;
    let checked: Checked;
    try {
      const due = parsed<{ at?: string; after?: string }>(dueFile(state));
      rmSync(dueFile(state), { force: true });
      checked = await checkOnce(home, team, run, options);
      if (checked.due && !existsSync(dueFile(state)))
        writeJson(dueFile(state), {
          at: due?.at ?? new Date().toISOString(),
          after: checked.due === "moved" ? "a commit that moved under the check" : (due?.after ?? branch),
        });
    } finally {
      verify();
    }
    if (checked.told) {
      console.info(checked.told);
      wake(checked.told);
    }
    if (checked.due === "waiting" || (checked.due === "moved" && retried)) return;
    if (checked.due === "moved") retried = true;
  }
}

// The last few checks after merges, for a6g status.
export const readVerifyLog = (home: string): string[] =>
  existsSync(join(stateDir(home), "verify.log"))
    ? readFileSync(join(stateDir(home), "verify.log"), "utf8")
        .trim()
        .split("\n")
        .slice(-5)
    : [];
