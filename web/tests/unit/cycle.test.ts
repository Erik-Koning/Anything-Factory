// The picture of a team's cycle on the sign-in page (app/sign-in/cycle.ts): the plan it draws, the ways between its
// tasks, and the lines both are drawn along.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cast, lineOf, lowWay, planCycle, type Point, pointAt, rounded, route, seeded } from "../../app/sign-in/cycle.ts";

const SHAPES: [levels: number, rows: number][] = [
  [2, 1],
  [3, 1],
  [4, 2],
  [6, 3],
  [8, 5],
];

test("a plan runs from one request to one merge: every task follows from the level before and leads to the next", () => {
  for (const seed of [1, 2, 3, 7, 42, 2026])
    for (const [levels, rows] of SHAPES) {
      const { tasks, links } = planCycle(seeded(seed), levels, rows);
      const last = tasks.at(-1);
      assert.deepEqual(tasks[0]?.parents, [], "the request follows from nothing");
      assert.deepEqual(last?.children, [], "the merge leads nowhere");
      assert.equal(last?.level, levels - 1);
      for (const [id, task] of tasks.entries()) {
        assert.equal(task.id, id);
        if (task !== tasks[0]) assert.ok(task.parents.length > 0, `task ${id} follows from another`);
        if (task !== last) assert.ok(task.children.length > 0, `task ${id} leads to another`);
        for (const parent of task.parents) assert.equal(tasks[parent]?.level, task.level - 1);
        for (const child of task.children) assert.ok(tasks[child]?.parents.includes(id));
      }
      for (let level = 0; level < levels; level++) {
        const slots = tasks.filter((task) => task.level === level).map((task) => task.slot);
        assert.ok(slots.length >= 1 && slots.length <= rows, `level ${level} has ${slots.length} of at most ${rows}`);
        assert.equal(new Set(slots).size, slots.length, "no two tasks of a level in one place");
        // About the line the request comes in on, two half-rows apart.
        assert.equal(slots[0], 1 - slots.length);
        assert.equal(slots.at(-1), slots.length - 1);
      }
      assert.equal(
        links.length,
        tasks.reduce((n, task) => n + task.children.length, 0)
      );
      assert.equal(new Set(links.map(([from, to]) => `${from}>${to}`)).size, links.length, "no link twice");
    }
});

test("the same seed draws the same plan; another draws another", () => {
  assert.deepEqual(planCycle(seeded(5), 8, 5), planCycle(seeded(5), 8, 5));
  const plans = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => JSON.stringify(planCycle(seeded(seed), 8, 5).links)));
  assert.ok(plans.size > 1);
});

test("the way between two tasks is the shortest along the links, in either direction, and only along the open ones", () => {
  const plan = planCycle(seeded(11), 6, 4);
  const last = plan.tasks.length - 1;
  // From the request to the merge is a task a level: as many as there are levels.
  const through = route(plan, 0, last);
  assert.equal(through.length, 6);
  assert.deepEqual(
    through.map((id) => plan.tasks[id]?.level),
    [0, 1, 2, 3, 4, 5]
  );
  through.slice(1).forEach((id, i) => assert.ok(plan.tasks[id]?.parents.includes(through[i] ?? -1), "each step is a link"));
  // And back again, the other way along the same kind of links.
  const back = route(plan, last, 0);
  assert.equal(back.length, 6);
  back.slice(1).forEach((id, i) => assert.ok(plan.tasks[id]?.children.includes(back[i] ?? -1)));
  assert.deepEqual(route(plan, 3, 3), [3]);
  // Two tasks of one level: by way of one they share, before or after.
  const [a, b] = plan.tasks.filter((task) => task.level === 1).map((task) => task.id);
  assert.deepEqual(
    route(plan, a ?? -1, b ?? -1, (from) => from === 0),
    [a, 0, b],
    "only the request's links are open: back through it"
  );
  assert.deepEqual(
    route(plan, 0, last, () => false),
    [],
    "no link open, no way"
  );
});

test("the low way is a journey from the request to the merge, a task a level, by the lowest each one leads to", () => {
  for (const seed of [1, 2, 3, 7, 42, 2026])
    for (const [levels, rows] of SHAPES) {
      const plan = planCycle(seeded(seed), levels, rows);
      const way = lowWay(plan);
      assert.equal(way[0], 0);
      assert.equal(way.at(-1), plan.tasks.length - 1);
      assert.deepEqual(
        way.map((id) => plan.tasks[id]?.level),
        Array.from({ length: levels }, (_, level) => level)
      );
      way.slice(1).forEach((id, i) => assert.equal(id, Math.max(...(plan.tasks[way[i] ?? -1]?.children ?? []))));
    }
});

test("a plan calls on the innovator for one task near the merge, and on the security reviewer for one or two others", () => {
  for (const seed of [1, 2, 3, 7, 42, 2026])
    for (const [levels, rows] of SHAPES) {
      const plan = planCycle(seeded(seed), levels, rows);
      const last = plan.tasks.length - 1;
      const { stream, guarded } = cast(plan, seeded(seed));
      // Two tasks are the request and the merge: nothing between them to think through, or to guard.
      assert.equal(stream === null, levels === 2);
      const marked = plan.tasks[stream ?? -1];
      if (marked) {
        assert.ok(marked.level > 0 && marked.level === levels - (levels >= 6 ? 3 : 2), `a stream at level ${marked.level} of ${levels}`);
        // The top of its level, where the sheet above it is open.
        assert.equal(marked.slot, Math.min(...plan.tasks.filter((task) => task.level === marked.level).map((task) => task.slot)));
      }
      const between = plan.tasks.filter((task) => task.id !== 0 && task.id !== last && task.id !== stream).length;
      assert.equal(guarded.length, Math.min(between, plan.tasks.length > 9 ? 2 : 1));
      assert.equal(new Set(guarded).size, guarded.length, "no task guarded twice");
      for (const id of guarded) assert.ok(id !== 0 && id !== last && id !== stream && plan.tasks[id], `task ${id} can be guarded`);
      assert.deepEqual(cast(plan, seeded(seed)), { stream, guarded }, "the same seed calls on the same");
    }
});

test("a line knows how far along each point is, and the point at any distance, held to its ends", () => {
  const line = lineOf([
    [0, 0],
    [30, 0],
    [30, 40],
  ]);
  assert.deepEqual(line.along, [0, 30, 70]);
  assert.equal(line.length, 70);
  assert.deepEqual(pointAt(line, 15), [15, 0]);
  assert.deepEqual(pointAt(line, 50), [30, 20]);
  assert.deepEqual(pointAt(line, -5), [0, 0]);
  assert.deepEqual(pointAt(line, 500), [30, 40]);
  // A point twice (a way with no bend in it) is passed over.
  const flat = lineOf([
    [0, 0],
    [10, 0],
    [10, 0],
    [20, 0],
  ]);
  assert.deepEqual(pointAt(flat, 10), [10, 0]);
  assert.deepEqual(pointAt(flat, 15), [15, 0]);
  assert.deepEqual(pointAt(lineOf([]), 3), [0, 0]);
});

test("rounding keeps a line's ends, cuts each corner by no more than the radius, and leaves a straight line alone", () => {
  const corner: Point[] = [
    [0, 0],
    [100, 0],
    [100, 100],
  ];
  const round = rounded(corner, 10);
  assert.deepEqual(round[0], [0, 0]);
  assert.deepEqual(round.at(-1), [100, 100]);
  assert.deepEqual(round[1], [90, 0], "the corner starts a radius before it");
  assert.deepEqual(round.at(-2), [100, 10], "and ends a radius after");
  assert.ok(!round.some(([x, y]) => x === 100 && y === 0), "the corner itself is gone");
  for (const [x, y] of round) assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 100);
  assert.ok(lineOf(round).length < lineOf(corner).length);
  // Sides shorter than twice the radius give half of themselves, so two corners never cross.
  const tight = rounded(
    [
      [0, 0],
      [8, 0],
      [8, 8],
      [16, 8],
    ],
    10
  );
  assert.deepEqual(tight[1], [4, 0]);
  assert.ok(tight.some(([x, y]) => x === 8 && y === 4));
  // No bend: the points as they were.
  const straight: Point[] = [
    [0, 5],
    [10, 5],
    [10, 5],
    [20, 5],
  ];
  assert.deepEqual(rounded(straight, 10), straight);
});
