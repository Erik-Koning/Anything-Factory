// One cycle of a team's work as the sign-in page draws it (team-at-work.tsx): a request planned into tasks, level by
// level, down to the one that merges; the ways between them; which tasks get more than a builder and a reviewer; and
// the lines all of it is drawn along. It's a picture of how a team works, not any team's state. Nothing here touches
// the page, so the tests read it as it is.

export type Random = () => number;

// A small seeded generator (mulberry32): the same seed draws the same cycles.
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Task {
  id: number;
  // How far from the request: it's level 0, the merge the last.
  level: number;
  // Half-rows above (negative) or below the line the request comes in on.
  slot: number;
  parents: number[];
  children: number[];
}
export interface Plan {
  // The request first, the merge last.
  tasks: Task[];
  links: (readonly [from: number, to: number])[];
}

// A request split into tasks: one at each end, more toward the middle (at most `rows` side by side), each on a way
// from the request to the merge, and linked only to the levels beside its own.
export function planCycle(random: Random, levels: number, rows: number): Plan {
  const count = Math.max(2, Math.floor(levels));
  const tall = Math.max(1, Math.floor(rows));
  const tasks: Task[] = [];
  const byLevel: Task[][] = [];
  for (let level = 0; level < count; level++) {
    const fromAnEnd = Math.min(level, count - 1 - level);
    const most = Math.min(tall, fromAnEnd + 1);
    const size = fromAnEnd === 0 ? 1 : Math.max(Math.min(2, tall), most - (random() < 0.3 ? 1 : 0));
    const row: Task[] = [];
    for (let i = 0; i < size; i++) {
      const task: Task = { id: tasks.length, level, slot: 2 * i - (size - 1), parents: [], children: [] };
      tasks.push(task);
      row.push(task);
    }
    byLevel.push(row);
  }
  const links: (readonly [number, number])[] = [];
  const link = (from: Task, to: Task) => {
    if (from.children.includes(to.id)) return;
    from.children.push(to.id);
    to.parents.push(from.id);
    links.push([from.id, to.id]);
  };
  // The one across from the `index`th of `from`, among `to`.
  const across = (index: number, from: number, to: number) => Math.round((index * (to - 1)) / Math.max(1, from - 1));
  for (let level = 0; level + 1 < count; level++) {
    const here = byLevel[level] ?? [];
    const next = byLevel[level + 1] ?? [];
    // Every task follows from one across from it, and leads to one; some lead to a second, beside that.
    next.forEach((to, j) => {
      const from = here[across(j, next.length, here.length)];
      if (from) link(from, to);
    });
    here.forEach((from, i) => {
      const j = across(i, here.length, next.length);
      const to = next[j];
      if (to && !from.children.length) link(from, to);
      const beside = next[j + (random() < 0.5 ? -1 : 1)];
      if (beside && random() < 0.3) link(from, beside);
    });
  }
  return { tasks, links };
}

// The shortest way from one task to another along the links, in either direction: the tasks passed, both ends
// included. Only along the links that are `open`, when that's given; empty when there's no way.
export function route(plan: Plan, from: number, to: number, open: (from: number, to: number) => boolean = () => true): number[] {
  const cameFrom = new Map<number, number>([[from, from]]);
  const queue = [from];
  for (const at of queue) {
    if (at === to) break;
    const task = plan.tasks[at];
    if (!task) continue;
    // Onward first, so of two ways as short the one that goes forward is taken.
    const beside = [...task.children.filter((child) => open(at, child)), ...task.parents.filter((parent) => open(parent, at))];
    for (const next of beside)
      if (!cameFrom.has(next)) {
        cameFrom.set(next, at);
        queue.push(next);
      }
  }
  if (!cameFrom.has(to)) return [];
  const way = [to];
  for (let at = to; at !== from;) {
    at = cameFrom.get(at) ?? from;
    way.unshift(at);
  }
  return way;
}

// A way from the request to the merge by the lowest task each one leads to: a journey through the plan, along its
// bottom edge.
export function lowWay(plan: Plan): number[] {
  const way: number[] = [];
  for (let task = plan.tasks[0]; task; task = plan.tasks[Math.max(-1, ...task.children)]) way.push(task.id);
  return way;
}

// Who else a plan calls on, besides those who build and review every task of it: the innovator, for the task that
// gets a thinking stream before it's built (the top one of a level near the merge, where the sheet above it is open;
// none in a plan of two tasks), and the security reviewer, for the tasks it has to pass as well (one, or two in a
// large plan, anywhere between the request and the merge).
export interface Cast {
  stream: number | null;
  guarded: number[];
}
export function cast(plan: Plan, random: Random): Cast {
  const last = plan.tasks.at(-1)?.level ?? 0;
  const level = last >= 5 ? last - 2 : last - 1;
  const stream = level > 0 ? (plan.tasks.find((task) => task.level === level)?.id ?? null) : null;
  const others = plan.tasks.filter((task) => task.level > 0 && task.level < last && task.id !== stream).map((task) => task.id);
  const guarded: number[] = [];
  for (let wanted = plan.tasks.length > 9 ? 2 : 1; wanted > 0 && others.length > 0; wanted--)
    guarded.push(...others.splice(Math.floor(random() * others.length), 1));
  return { stream, guarded };
}

export type Point = readonly [x: number, y: number];
// A line through points, with how far along it each one is.
export interface Line {
  points: Point[];
  along: number[];
  length: number;
}

export function lineOf(points: Point[]): Line {
  const along: number[] = [];
  let length = 0;
  let before: Point | undefined;
  for (const point of points) {
    if (before) length += Math.hypot(point[0] - before[0], point[1] - before[1]);
    along.push(length);
    before = point;
  }
  return { points, along, length };
}

// The point `distance` along a line, held to its ends.
export function pointAt(line: Line, distance: number): Point {
  const first = line.points[0] ?? [0, 0];
  if (distance <= 0) return first;
  for (let i = 1; i < line.points.length; i++) {
    const end = line.along[i] ?? 0;
    if (distance > end) continue;
    const start = line.along[i - 1] ?? 0;
    const a = line.points[i - 1] ?? first;
    const b = line.points[i] ?? first;
    const part = end > start ? (distance - start) / (end - start) : 0;
    return [a[0] + (b[0] - a[0]) * part, a[1] + (b[1] - a[1]) * part];
  }
  return line.points.at(-1) ?? first;
}

// The same points with each corner between them rounded, by no more than half of either side of it.
export function rounded(points: Point[], radius: number, steps = 6): Point[] {
  const out: Point[] = [];
  for (const [i, corner] of points.entries()) {
    const before = points[i - 1];
    const after = points[i + 1];
    const toBefore = before ? Math.hypot(before[0] - corner[0], before[1] - corner[1]) : 0;
    const toAfter = after ? Math.hypot(after[0] - corner[0], after[1] - corner[1]) : 0;
    const r = Math.min(radius, toBefore / 2, toAfter / 2);
    // An end, or a corner with no room to round.
    if (!before || !after || r < 0.5) {
      out.push(corner);
      continue;
    }
    const from: Point = [corner[0] + ((before[0] - corner[0]) / toBefore) * r, corner[1] + ((before[1] - corner[1]) / toBefore) * r];
    const to: Point = [corner[0] + ((after[0] - corner[0]) / toAfter) * r, corner[1] + ((after[1] - corner[1]) / toAfter) * r];
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const u = 1 - t;
      out.push([u * u * from[0] + 2 * u * t * corner[0] + t * t * to[0], u * u * from[1] + 2 * u * t * corner[1] + t * t * to[1]]);
    }
  }
  return out;
}
