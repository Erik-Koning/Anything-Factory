// Each team's tasks as this server last read them, brought up to date on every read by asking the database only for
// the tasks changed since (every change to a task writes its updatedAt, lib/tasks/model.ts withEvent). A page's reads
// then cost what changed, not every team's every task: those had grown to megabytes a page (the header counts what
// waits on the operator on every team), more than the database's link carries in the 30 seconds a page has.
//
// A whole read happens once per team when the server starts (instrumentation.ts warms them all), then in the background
// every half hour; a page never waits for one unless nothing was read yet. A task that's gone is dropped at the next
// read (its count says so). Each
// round trip of a whole read carries a few dozen tasks, well within a database call's 20 seconds (db.ts).
import type { Task } from "../../lib/tasks/model.ts";
import { graphDb } from "./db.ts";

// A whole read at most this often, after the first.
const WHOLE_MS = 30 * 60_000;
// Changes are asked for from this far before the last read, so one written by a machine whose clock runs behind is
// still caught.
const OVERLAP_MS = 10 * 60_000;
// Tasks a round trip carries.
const BATCH = 40;

interface Kept {
  tasks: Map<string, Task>;
  // When the last read of changes began, and the last whole read.
  readAt: number;
  wholeAt: number;
}

const held = globalThis as typeof globalThis & {
  a6gTasks?: Map<string, Kept>;
  a6gTasksReading?: Map<string, Promise<Task[]>>;
  a6gTasksWhole?: Map<string, Promise<Task[]>>;
};
const kept = (held.a6gTasks ??= new Map());
const reading = (held.a6gTasksReading ??= new Map());
// The whole reads under way, one per team at a time: a page with nothing kept yet waits for the one under way.
const wholeReads = (held.a6gTasksWhole ??= new Map());

const read = async (team: string, filter: Record<string, unknown> = {}): Promise<Task[]> =>
  (await graphDb()
    .collection("tasks")
    .find({ team, ...filter }, { projection: { _id: 0 }, batchSize: BATCH })
    .toArray()) as unknown as Task[];

// In the store's order (lib/tasks/mongo.ts): by number.
const ordered = (tasks: Map<string, Task>): Task[] => [...tasks.values()].sort((a, b) => Number(a.id) - Number(b.id));

// A whole read, once at a time per team; a failure leaves what's kept as it was, to try again later.
function readWhole(team: string): Promise<Task[]> {
  const under = wholeReads.get(team);
  if (under) return under;
  const at = Date.now();
  const run = read(team)
    .then((all) => {
      const tasks = new Map(all.map((t) => [t.id, t]));
      kept.set(team, { tasks, readAt: at, wholeAt: at });
      return ordered(tasks);
    })
    .finally(() => wholeReads.delete(team));
  wholeReads.set(team, run);
  return run;
}

// The same in the background, its failure only noted.
function refreshWhole(team: string): void {
  readWhole(team).catch((error: unknown) => console.warn(`[tasks] couldn't read ${team}'s tasks whole: ${(error as Error).message}`));
}

async function readChanges(team: string, from: Kept): Promise<Task[]> {
  const at = Date.now();
  const tasks = graphDb().collection("tasks");
  // With the changes, how many tasks the team has: a count that differs from what's kept, once the changes are in, means
  // some are gone (a team deleted, a graph moved), and only their ids are read to drop them.
  const [changed, count] = await Promise.all([
    read(team, { updatedAt: { $gte: new Date(from.readAt - OVERLAP_MS).toISOString() } }),
    tasks.countDocuments({ team }),
  ]);
  for (const t of changed) from.tasks.set(t.id, t);
  if (count !== from.tasks.size) {
    const there = new Set((await tasks.find({ team }, { projection: { _id: 0, id: 1 } }).toArray()).map((row) => String(row["id"])));
    for (const id of from.tasks.keys()) if (!there.has(id)) from.tasks.delete(id);
  }
  from.readAt = at;
  if (at - from.wholeAt > WHOLE_MS) refreshWhole(team);
  return ordered(from.tasks);
}

// A team's tasks, as current as the database's: the changes since the last read, over what's kept. Reads of one team
// at the same moment share one.
export function teamTasks(team: string): Promise<Task[]> {
  const already = reading.get(team);
  if (already) return already;
  const from = kept.get(team);
  const run = (from ? readChanges(team, from) : readWhole(team)).finally(() => reading.delete(team));
  reading.set(team, run);
  return run;
}

// Every team's tasks read once, in the background, as the server starts: the first page then waits for none.
export function warmTasks(teams: string[]): void {
  for (const team of teams) if (!kept.has(team)) refreshWhole(team);
}
