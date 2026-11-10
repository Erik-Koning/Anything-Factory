// The quality numbers (a6g metrics --quality): how a team's merged work went over a period, read from what the factory
// records anyway: each task's history, the findings the check after merges filed, the suite's recorded runs, and what
// was spent on each task's branch. No member reports any of it, so none of it can be made to look better than it was.
// A number that can't be known (no merged task, no run of the suite) is null and says so, never a zero.
import { unprovenIn } from "./commands/e2e.ts";
import type { SuiteRecord } from "./suite.ts";
import { MERGE, type Kind, type Task } from "./tasks/model.ts";
import { dayOf, dollars, round, spendByWork, type UsageDay } from "./tasks/spend.ts";

// The period, in milliseconds; null is open on that side.
export interface Period {
  since: number | null;
  until: number | null;
}

export interface Quality {
  merged: { tasks: number; byKind: Partial<Record<Kind, number>> };
  // Of the merged tasks a review approved, those that needed no round of changes (the reviewer's, or the security
  // reviewer's issues).
  reviews: { reviewed: number; firstTime: number; share: number | null };
  // What the check after merges filed in the period. `failures` is what a merge broke (a page, a test, a test of who
  // may reach what, the app down), and `rejected` those of them the planner rejected since. Apart from them: the
  // harness's gaps, package advisories, findings about the checks themselves (one that didn't run, a flaky test, a
  // merge that left fewer tests), and any filed under a key this version doesn't know.
  afterMerge: { failures: number; rejected: number; perMerged: number | null; gaps: number; advisories: number; checks: number; other: number };
  // The team's journeys the newest recorded run of the suite proves; `proven` is null, and `why` says so, when no run
  // speaks for them.
  journeys: { total: number; proven: number | null; run: { commit: string; at: string } | null; why: string | null };
  // Tests that passed only on a retry, in the recorded runs of the period that ran (the factory keeps the last 20).
  // `runs` is null where the runs aren't kept (a machine that isn't the team's lead).
  flaky: { runs: number | null; since: string | null; tests: { id: string; times: number }[] };
  // Dollars at the API-equivalent rate. `merged` is what ran on the merged tasks' branches, on any day; `unpriced`
  // the requests among it that had no known price; `team` all the team spent on the period's days.
  cost: { merged: number; perMerged: number | null; unpriced: number; team: number };
  // From a task's first claim to its merge, for the merged tasks that were claimed.
  claimedToMerged: { tasks: number; medianMin: number | null };
}

const within = (at: string, { since, until }: Period): boolean => {
  const ms = Date.parse(at);
  return (since === null || ms >= since) && (until === null || ms <= until);
};

// A task's last merge: the merge queue's move to done, which carries the merge commit, and what led to it since the
// task was last closed (a reopened task's earlier life isn't this merge's). A task folded into another closes without
// one, and a journey closes on its tests: neither is a merged task.
function mergeOf(task: Task): { at: string; before: Task["history"] } | null {
  const index = task.history.findLastIndex((e) => e.to === "done" && e.by === MERGE && e.sha !== undefined);
  const event = task.history[index];
  if (!event) return null;
  const earlier = task.history.slice(0, index);
  return { at: event.at, before: earlier.slice(earlier.findLastIndex((e) => e.to === "done") + 1) };
}

// What a finding of the check after merges is about, from the key it was filed under (verify.ts, packages.ts); null
// for a task the check didn't file.
type Filed = "failures" | "gaps" | "advisories" | "checks" | "other";
const MARK = "(a6g: ";
export function filedAs(task: Pick<Task, "by" | "body">): Filed | null {
  const at = task.by === MERGE ? task.body.lastIndexOf(MARK) : -1;
  if (at < 0) return null;
  const key = task.body.slice(at + MARK.length);
  if (/^verify:(page|access|spec):|^verify:app\)/.test(key)) return "failures";
  if (key.startsWith("gap:")) return "gaps";
  if (key.startsWith("audit:")) return "advisories";
  if (/^verify:(flaky|less):|^verify:(pages|suite)\)/.test(key)) return "checks";
  return "other";
}

const median = (sorted: number[]): number | null => {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};
const per = (n: number, of: number, digits: number): number | null => (of ? Number((n / of).toFixed(digits)) : null);

// The suite's runs are recorded where the merge queue runs: on a team of several machines, the lead's.
const ELSEWHERE = "the suite's runs are kept on the team's lead machine: run this there";

// `runs` newest first, as the suite's history keeps them, or null on a machine that doesn't keep them; `days` every
// day of usage the team has, since a task merged in the period may have been built before it.
export function quality(tasks: Task[], runs: SuiteRecord[] | null, days: UsageDay[], period: Period): Quality {
  const merged = tasks.flatMap((task) => {
    const merge = mergeOf(task);
    return merge && within(merge.at, period) ? [{ task, ...merge }] : [];
  });
  const byKind: Partial<Record<Kind, number>> = {};
  for (const { task } of merged) byKind[task.kind] = (byKind[task.kind] ?? 0) + 1;

  const reviewed = merged.filter(({ before }) => before.some((e) => e.what === "review approved"));
  const firstTime = reviewed.filter(({ task }) => task.rounds === 0).length;

  const filed: Record<Filed, number> = { failures: 0, gaps: 0, advisories: 0, checks: 0, other: 0 };
  let rejected = 0;
  for (const task of tasks) {
    const as = within(task.createdAt, period) ? filedAs(task) : null;
    if (!as) continue;
    filed[as] += 1;
    if (as === "failures" && task.status === "rejected") rejected += 1;
  }

  const journeys = tasks.filter(
    (t) => t.kind === "journey" && t.status !== "rejected" && (period.until === null || Date.parse(t.createdAt) <= period.until)
  );
  const run = runs?.find((record) => period.until === null || Date.parse(record.at) <= period.until) ?? null;
  const proven = run?.ran ? journeys.filter((journey) => unprovenIn(run, journey.id) === null).length : null;
  const why = !runs
    ? ELSEWHERE
    : !run
      ? "no recorded run of the suite (a6g e2e run, or the merge queue's check)"
      : run.ran
        ? null
        : `the newest run of the suite, at ${run.commit.slice(0, 9)}, didn't run`;

  const counted = (runs ?? []).filter((record) => record.ran && within(record.at, period));
  const times = new Map<string, number>();
  for (const record of counted) for (const spec of record.specs) if (spec.outcome === "flaky") times.set(spec.id, (times.get(spec.id) ?? 0) + 1);

  const ids = new Set(merged.map(({ task }) => task.id));
  const spent = new Map(spendByWork(days, tasks).tasks.map((t) => [t.id, t.cost]));
  const onMerged = round([...ids].reduce((sum, id) => sum + (spent.get(id) ?? 0), 0));
  const from = period.since === null ? null : dayOf(new Date(period.since));
  const to = period.until === null ? null : dayOf(new Date(period.until));
  const rows = days.flatMap((day) => ((!from || day.day >= from) && (!to || day.day <= to) ? day.rows : []));

  const took = merged
    .flatMap(({ at, before }) => {
      const claimed = before.find((e) => e.to === "building")?.at;
      return claimed ? [(Date.parse(at) - Date.parse(claimed)) / 60_000] : [];
    })
    .sort((a, b) => a - b);
  const mid = median(took);

  return {
    merged: { tasks: merged.length, byKind },
    reviews: { reviewed: reviewed.length, firstTime, share: per(firstTime, reviewed.length, 3) },
    afterMerge: { ...filed, rejected, perMerged: per(filed.failures, merged.length, 2) },
    journeys: { total: journeys.length, proven, run: run ? { commit: run.commit, at: run.at } : null, why },
    flaky: {
      runs: runs ? counted.length : null,
      since: counted.at(-1)?.at ?? null,
      tests: [...times].map(([id, n]) => ({ id, times: n })).sort((a, b) => b.times - a.times || a.id.localeCompare(b.id)),
    },
    cost: {
      merged: onMerged,
      perMerged: merged.length ? round(onMerged / merged.length) : null,
      unpriced: days.flatMap((day) => day.rows).reduce((sum, row) => sum + (row.task && ids.has(row.task) ? row.unpriced : 0), 0),
      team: round(rows.reduce((sum, row) => sum + row.cost, 0)),
    },
    claimedToMerged: { tasks: took.length, medianMin: mid === null ? null : Math.round(mid) },
  };
}

// "45 min", "3 h 10 min", "2 d 4 h".
export function span(min: number): string {
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return min % 60 ? `${hours} h ${min % 60} min` : `${hours} h`;
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${Math.floor(hours / 24)} d`;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// The numbers in lines, each saying what it's of.
export function describeQuality(q: Quality): string[] {
  const kinds = Object.entries(q.merged.byKind)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${kind}`);
  const apart = [
    ...(q.afterMerge.gaps ? [count(q.afterMerge.gaps, "gap in the harness", "gaps in the harness")] : []),
    ...(q.afterMerge.advisories ? [count(q.afterMerge.advisories, "package advisory", "package advisories")] : []),
    ...(q.afterMerge.checks ? [`${q.afterMerge.checks} about the checks themselves (one that didn't run, a flaky test, fewer tests)`] : []),
    ...(q.afterMerge.other ? [`${q.afterMerge.other} of a kind this version doesn't know`] : []),
  ];
  const flaky = q.flaky.tests.slice(0, 5).map((t) => `${t.id}${t.times > 1 ? `, ${t.times} times` : ""}`);
  const more = q.flaky.tests.length - flaky.length;
  return [
    `Merged: ${count(q.merged.tasks, "task")}${kinds.length ? ` (${kinds.join(", ")})` : ""}`,
    q.reviews.share === null
      ? "Reviews passed first time: no merged task was reviewed"
      : `Reviews passed first time: ${q.reviews.firstTime} of ${q.reviews.reviewed} reviewed (${Math.round(q.reviews.share * 100)}%)`,
    `Found after merge: ${count(q.afterMerge.failures, "failure")} filed by the check after merges${
      q.afterMerge.perMerged === null ? "" : `, ${q.afterMerge.perMerged} per merged task`
    }${q.afterMerge.rejected ? ` (${q.afterMerge.rejected} rejected by the planner since)` : ""}`,
    ...(apart.length ? [`  counted apart: ${apart.join("; ")}`] : []),
    !q.journeys.total
      ? "Journeys proven: the team has no journeys"
      : q.journeys.proven === null
        ? `Journeys proven: not known for the team's ${q.journeys.total}: ${q.journeys.why}`
        : `Journeys proven: ${q.journeys.proven} of ${q.journeys.total}, by the suite's run at ${q.journeys.run?.commit.slice(0, 9)} (${q.journeys.run?.at.slice(0, 10)})`,
    q.flaky.runs === null
      ? `Flaky tests: not known here: ${ELSEWHERE}`
      : !q.flaky.runs
        ? "Flaky tests: no recorded run of the suite in the period"
        : `Flaky tests: ${q.flaky.tests.length} in ${count(q.flaky.runs, "recorded run")} since ${q.flaky.since?.slice(0, 10)}${
            flaky.length ? ` (${flaky.join("; ")}${more > 0 ? `; and ${more} more` : ""})` : ""
          }`,
    q.cost.perMerged === null
      ? `Cost per merged task: none merged; the team spent ${dollars(q.cost.team)} in the period`
      : `Cost per merged task: ${dollars(q.cost.perMerged)} (${dollars(q.cost.merged)} on their branches, at the API-equivalent rate; the team spent ${dollars(q.cost.team)} in the period)`,
    ...(q.cost.unpriced ? [`  ${count(q.cost.unpriced, "request")} on those branches had no known price and count as $0`] : []),
    q.claimedToMerged.medianMin === null
      ? "Claimed to merged: no merged task was claimed"
      : `Claimed to merged: ${span(q.claimedToMerged.medianMin)} (the median of ${count(q.claimedToMerged.tasks, "task")})`,
  ];
}
