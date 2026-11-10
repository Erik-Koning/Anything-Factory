// The merge queue's check after merges: the team's pages and its end-to-end suite, re-run on the integration branch, so
// what was done stays done. One check for the newest commit, however many merged meanwhile: each merge marks a check
// due, and only a merge with none queued behind it runs one (a check already running takes the newer commit when it
// finishes). It holds the merge lock (nothing fast-forwards the checkout), then the app lock (nothing restarts the
// app), then a gate slot, in that order, as every holder of those locks takes them; and it throws a run away if the
// checkout's commit moved anyway. What newly fails becomes a finding by the merge queue, naming the merges since it last
// passed; a test that passes only on its retry is filed as flaky, for the scaffolder; and the harness's gaps are filed
// once. The planner is woken when there's anything new.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { differentLooks, recordPages, type PageResult } from "./commands/pages.ts";
import { recordSuite, suiteHistory } from "./commands/e2e.ts";
import type { LoadedTeam, Team } from "./config.ts";
import { HARNESS_FILE, pagePlan, readHarness } from "./harness.ts";
import { acquire } from "./lock.ts";
import { stateDir } from "./paths.ts";
import { journeysOf, type SuiteRecord } from "./suite.ts";
import { threadSend } from "./t3.ts";
import { addTask } from "./tasks/add.ts";
import { type Kind, MERGE, type Severity } from "./tasks/model.ts";
import { openTeamStore } from "./tasks/ops.ts";
import type { Store } from "./tasks/store.ts";
import { localTime, readJson, writeJson } from "./util.ts";

const dueFile = (state: string): string => join(state, "verify-due.json");
export const pendingDir = (state: string): string => join(state, "merges", "pending");
const head = (home: string): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: home, encoding: "utf8" }).trim();
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// Merges queued behind this one (a6g merge --queue marks each, and the queued run clears its own mark).
export function othersQueued(state: string, own: string): boolean {
  const dir = pendingDir(state);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => {
    if (name === `${own}.json`) return false;
    const pid = readJson<{ pid?: number } | null>(join(dir, name), null)?.pid;
    return typeof pid === "number" && alive(pid);
  });
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

// Files a finding once: nothing new while one with the same key is open, or once the planner rejected it; again when
// one was done and it came back. Resolves to the new task's id, or null.
async function fileOnce(
  store: Store,
  team: Team,
  key: string,
  input: { title: string; kind: Kind; severity: Severity; body: string }
): Promise<string | null> {
  const marker = `(a6g: ${key})`;
  const earlier = (await store.tasks.all()).filter((t) => t.body.includes(marker));
  if (earlier.some((t) => t.status !== "done")) return null;
  const task = await addTask(store, team.name, { ...input, body: `${input.body}\n\n${marker}` }, MERGE);
  return task.id;
}

// The harness's gaps, filed once: a team with a scaffolder and no manifest; a journey with no tagged test in the
// latest run; a test that passed only on its retry.
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
  if (record && harness?.e2e) {
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

// The findings a run's failures make: one per page, one per spec file.
async function fileFailures(
  store: Store,
  team: Team,
  home: string,
  {
    pages,
    before,
    suite,
    at,
  }: { pages: Record<string, PageResult> | null; before: Record<string, { passed: boolean; commit: string }>; suite: SuiteRecord | null; at: string }
): Promise<string[]> {
  const filed: string[] = [];
  for (const [id, result] of Object.entries(pages ?? {})) {
    if (result.passed) continue;
    const problems = result.runs.flatMap((run) => run.problems.map((problem) => `- ${run.viewport}/${run.scheme}: ${problem}`));
    const last = before[id]?.passed ? before[id]?.commit : null;
    const merges = mergesBetween(home, last ?? null, at).slice(0, 10);
    const broken = problems.some((line) => /HTTP \d|didn't load|errors:|console:|sign-in/.test(line));
    const task = await fileOnce(store, team, `verify:page:${id}`, {
      title: `Page ${id} fails its checks after merges`,
      kind: broken ? "bug" : "ux",
      severity: "major",
      body: `Checked at ${at.slice(0, 9)} after merges, page ${id} fails:\n${problems.slice(0, 12).join("\n")}\n\n${last ? `It passed at ${last}; merged since:` : "Merged lately:"}\n${merges.map((m) => `- ${m}`).join("\n") || "- (none found)"}\n\nScreenshots: .a6g/run/shots/${id}/`,
    });
    if (task) filed.push(task);
  }
  const failing = (suite?.specs ?? []).filter((spec) => spec.outcome === "failed");
  const byFile = new Map<string, typeof failing>();
  for (const spec of failing) byFile.set(spec.file, [...(byFile.get(spec.file) ?? []), spec]);
  const history = suite ? suiteHistory(home).slice(1) : [];
  for (const [file, specs] of byFile) {
    const lastPass = history.find((record) =>
      specs.every((spec) => record.specs.some((s) => s.id === spec.id && (s.outcome === "passed" || s.outcome === "flaky")))
    );
    const merges = mergesBetween(home, lastPass?.commit ?? null, at).slice(0, 10);
    const journeys = [...new Set(specs.flatMap(journeysOf))];
    const task = await fileOnce(store, team, `verify:spec:${file}`, {
      title: `${file}: ${specs.length} test${specs.length === 1 ? " fails" : "s fail"} after merges`,
      kind: "bug",
      severity: "major",
      body: `The suite at ${at.slice(0, 9)} after merges:\n${specs
        .slice(0, 10)
        .map((spec) => `- ${spec.title}${spec.project ? ` [${spec.project}]` : ""}: ${spec.error ?? "failed"}`)
        .join(
          "\n"
        )}\n${journeys.length ? `\nJourneys it proves: ${journeys.map((j) => `#${j}`).join(", ")}; they aren't done while it fails.\n` : ""}\n${lastPass ? `It passed at ${lastPass.commit.slice(0, 9)}; merged since:` : "Merged lately:"}\n${merges.map((m) => `- ${m}`).join("\n") || "- (none found)"}`,
    });
    if (task) filed.push(task);
  }
  return filed;
}

// One check of the integration branch's head, holding merge, app and gate in that order. Resolves to what to tell
// the planner, or null when nothing's new; "moved" when the commit moved under it (it's due again).
async function checkOnce(home: string, team: LoadedTeam, run: string): Promise<string | null | "moved"> {
  const state = stateDir(home);
  const holder = "the merge queue's check";
  const merge = await acquire(home, "merge", { slots: 1, waitMin: 120, holder });
  if (!merge) return "the merge lock stayed busy for 2 hours; the check didn't run";
  try {
    const app = await acquire(home, "app", { slots: 1, waitMin: 30, holder });
    if (!app) return "the app lock stayed busy for 30 minutes; the check didn't run";
    process.env.A6G_APP_LOCK = "held";
    try {
      const gate = await acquire(home, "gate", { slots: team.gate.concurrency, waitMin: 60, holder });
      try {
        const at = head(home);
        const { harness } = readHarness(home);
        const plan = pagePlan(team, harness);
        const before = Object.fromEntries(
          Object.entries(readJson<{ pages: Record<string, { passed: boolean; commit: string }> }>(join(state, "pages.json"), { pages: {} }).pages).map(
            ([id, saved]) => [id, { passed: saved.passed, commit: saved.commit }]
          )
        );
        const said: string[] = [];
        let pages: Record<string, PageResult> | null = null;
        if (plan.list.length && plan.appUrl)
          try {
            pages = await recordPages(home, team);
            const passing = Object.values(pages).filter((r) => r.passed).length;
            said.push(`pages ${passing}/${Object.keys(pages).length} pass`);
          } catch (error) {
            said.push(`the page checks didn't run: ${(error as Error).message.split("\n")[0]}`);
          }
        let suite: SuiteRecord | null = null;
        if (harness?.e2e)
          try {
            suite = await recordSuite(home, team, { retries: 1, namespace: `verify-${Date.now().toString(36)}` });
            const count = (o: string) => suite?.specs.filter((s) => s.outcome === o).length ?? 0;
            said.push(
              `the suite ${count("passed")} passed, ${count("failed")} failed${count("flaky") ? `, ${count("flaky")} flaky` : ""}${suite.timedOut ? ", timed out" : ""}`
            );
          } catch (error) {
            said.push(`the suite didn't run: ${(error as Error).message.split("\n")[0]}`);
          }
        if (head(home) !== at) return "moved";
        const different = Object.keys(differentLooks(state));
        let filed: string[] = [];
        if (team.board.type === "tasks") {
          const store = await openTeamStore(team, run, home);
          try {
            filed = [...(await fileFailures(store, team, home, { pages, before, suite, at })), ...(await fileGaps(store, team, home, suite))];
          } finally {
            await store.close();
          }
        }
        appendFileSync(
          join(state, "verify.log"),
          `${localTime()} ${at.slice(0, 9)} ${said.join("; ")}${filed.length ? `; filed ${filed.map((id) => `#${id}`).join(" ")}` : ""}\n`
        );
        if (!filed.length && !different.length) return null;
        return `verify: at ${at.slice(0, 9)}, ${said.join("; ")}.${filed.length ? ` New findings in triage: ${filed.map((id) => `#${id}`).join(", ")}.` : ""}${different.length ? ` Look different since their UX pass: ${different.join(", ")}.` : ""}`;
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

// After a merge (the queued run, its after-merge command done): marks a check due, and runs it unless another merge
// is queued behind this one or a check is running (which takes the newest commit when it finishes).
export async function verifyAfterMerge(
  home: string,
  team: LoadedTeam,
  run: string,
  branch: string,
  { wake }: { wake: (text: string) => void }
): Promise<void> {
  const state = stateDir(home);
  mkdirSync(state, { recursive: true });
  writeJson(dueFile(state), { at: new Date().toISOString(), after: branch });
  const own = branch.replaceAll("/", "_");
  for (let round = 0; round < 3; round++) {
    if (othersQueued(state, own)) return;
    const verify = await acquire(home, "verify", { slots: 1, waitMin: 0, holder: `check after ${branch}` });
    if (!verify) return;
    try {
      for (let pass = 0; pass < 5 && existsSync(dueFile(state)); pass++) {
        rmSync(dueFile(state), { force: true });
        const told = await checkOnce(home, team, run);
        if (told === "moved") writeJson(dueFile(state), { at: new Date().toISOString(), after: "a commit that moved under the check" });
        else if (told) {
          console.info(told);
          wake(told);
        }
      }
    } finally {
      verify();
    }
    // A merge that finished while the check held the lock, and found it taken, left its mark: take it now.
    if (!existsSync(dueFile(state))) return;
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
