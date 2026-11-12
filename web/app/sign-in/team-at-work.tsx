"use client";
import { useEffect, useRef } from "react";
import { cast, type Line, lineOf, lowWay, type Plan, planCycle, type Point, pointAt, type Random, rounded, route, seeded, type Task } from "./cycle.ts";

// A team at work, every member of it, drawn on the sheet above the sign-in page's words. A request comes in along the
// main line and the planner splits it into tasks, which are proposals until the approver has been through them, while
// the scaffolder lays the harness the checks will run on. Over the one task that's worth it the innovator thinks a
// stream: from first principles to what's free, to what the operator's taste makes of that, to one move, handed down
// as a concept before anyone builds the task. Builders go to the tasks that are ready and trace each out; a reviewer
// walks round it before it's filled in, and the security reviewer too where it guards something. A tester runs the
// whole of it over the harness while the UX specialist walks a journey through it, and the work merges, task by task,
// back into main. Then the next request. Each of them is a dot that goes where its work is. Whose work a task is at
// the moment is on a sign over the task, which turns over when the task changes hands, and the work itself shows as
// dots rising and falling inside it. It's a picture of how a team works (cycle.ts), not any team's state: nobody has
// signed in here.
//
// It's kept light: one canvas no taller than the drawing, a few hundred short strokes and dots a frame, at most 60
// frames a second, none while the tab is hidden, and nothing at all where there's no room for it. Anyone who asks for
// less motion gets one still drawing. Most of what's left is what drawing anything 60 times a second costs a browser:
// about a third of a core while it's on screen, against a fifth for one square moving on the same canvas.
export function TeamAtWork() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const title = useRef<HTMLParagraphElement>(null);
  useEffect(() => (canvas.current && title.current ? run(canvas.current, title.current) : undefined), []);
  return (
    <div className="team-at-work" aria-hidden="true">
      <p ref={title} />
      <canvas ref={canvas} />
    </div>
  );
}

type Role = "planner" | "approver" | "scaffolder" | "innovator" | "builder" | "reviewer" | "security reviewer" | "tester" | "ux specialist";
// Those who judge what someone else made: drawn as rings, where those who make something are dots.
const JUDGES: ReadonlySet<Role> = new Set<Role>(["approver", "reviewer", "security reviewer", "ux specialist"]);
// A task on the sheet: planned (an empty outline), a builder tracing it, built and waiting, a reviewer walking round
// it, reviewed and waiting for the security reviewer, the security reviewer going round it, done (filled in, the
// solid), merged (gone into main).
type State = "planned" | "building" | "built" | "reviewing" | "reviewed" | "securing" | "done" | "merged";
// The sign over a task, or by the rail: whose the work there is, and whose it was before, for as long as the sign
// takes to turn over from the one name to the other (since `turned`). Work goes on under it from `busy` until `idle`,
// and from `off` it turns away.
interface Sign {
  by: Role | null;
  was: Role | null;
  turned: number;
  busy: number;
  idle: number;
  off: number;
}
interface Part extends Task {
  x: number;
  y: number;
  state: State;
  // When it appeared, when its state began and how long the work on it now takes, in seconds on the scene's clock.
  shown: number;
  since: number;
  takes: number;
  // When the approver passed it: until then it's the planner's proposal.
  approved: number;
  // The security reviewer has to pass it too.
  guarded: boolean;
  // Someone is on their way to it, or at it; and the sign that says who.
  claimed: boolean;
  sign: Sign;
  // When the tester last went by, when the UX specialist last looked at it, and when a task last merged into it.
  passed: number;
  seen: number;
  bumped: number;
}
interface Way {
  from: Part;
  to: Part;
  line: Line;
  starts: number;
}
interface Agent {
  role: Role;
  at: Part;
  doing: "idle" | "going" | "working";
  line: Line | null;
  job: Part | null;
  // When it comes on, and when what it's doing began and how long that takes.
  from: number;
  since: number;
  takes: number;
  leaving: boolean;
  // How much of it shows (0 to 1).
  presence: number;
}
interface Commit {
  part: Part;
  line: Line;
  starts: number;
  takes: number;
  landed: boolean;
}
// One part of the problem a thinking stream splits it into: its line from the frame to the one move, how far along
// that its stops are (its start, its three beads, its end), and how long after the middle one it sets out.
interface Strand {
  line: Line;
  stops: number[];
  lag: number;
}
// A thinking stream over a task, drawn about the middle of the task's top edge (x, y): a stem up to the frame; the
// strands from there, which meet again in the one move; two checks out to a side from the bead they question; the
// heights of the frame, the three rows of beads and the one move, whose names go on the side the checks don't; and
// when the innovator comes to it.
interface Stream {
  part: Part;
  x: number;
  y: number;
  size: number;
  side: 1 | -1;
  stem: Line;
  strands: Strand[];
  checks: Line[];
  heights: number[];
  starts: number;
}
interface Scene {
  width: number;
  w: number;
  h: number;
  plan: Plan;
  parts: Part[];
  ways: Way[];
  // A task's outline, a reviewer's walk round it, the second outline of one that guards something, and its tick,
  // each about the task's middle.
  outline: Line;
  orbit: Line;
  guard: Line;
  tick: Line;
  // The main line: in to the request, and out from the merge.
  enter: Line;
  exit: Line;
  // The harness the checks run on: a rail under the tasks with a mark where each level is; when the scaffolder set
  // out along it and how long that takes; the sign at its start; how far along it the tester has proved the work; and
  // the top of the tasks, where the tester's line across them ends.
  rail: Line;
  marks: number[];
  laid: { from: number; takes: number };
  sign: Sign;
  proved: number;
  crest: number;
  // The tasks the UX specialist's journey goes through, and the thinking stream, where there's room for one.
  walked: Part[];
  stream: Stream | null;
  agents: Agent[];
  commits: Commit[];
  phase: "request" | "plan" | "approve" | "build" | "verify" | "merge" | "ship";
  since: number;
  until: number;
  // The band of the sheet it's drawn in, from its top to its bottom; whether there's room above for its title; and
  // whether it's the one still drawing.
  top: number;
  bottom: number;
  titled: boolean;
  still: boolean;
}
interface Paint {
  ink: string;
  soft: string;
  edge: string;
  line: string;
  surface: string;
  brand: string;
  solid: string;
  onSolid: string;
  ok: string;
  warn: string;
  font: string;
}

// Seconds, and pixels a second.
const ENTER = 0.7;
const LEAD = 0.45;
const STAGGER = 0.3;
const GROW = 0.45;
const POP = 0.3;
const APPROVE_SPEED = 900;
const RAIL_SPEED = 900;
const SPEED = 620;
const BUILD = 0.6;
const BUILD_MORE = 0.5;
const REVIEW = 0.45;
const SECURE = 0.5;
const VERIFY_SPEED = 820;
const WALK_SPEED = 700;
const MERGE_SPEED = 560;
const SHIP = 1.1;
const REST = 0.9;
// A sign turns over in this long, and stays this long after the work under it stops. Whoever only passes a task (the
// approver, the tester, the UX specialist) is at it for a glance.
const TURN = 0.36;
const LINGER = 0.3;
const GLANCE = 0.4;

// A thinking stream, in seconds from when the innovator comes to the task. The stem goes up to the frame: who meets
// this, and in what moment. Each strand goes on in four stretches: to what its part is for and what's free in it, to
// what the operator's taste chooses of that, to the check of what the choice leans on, and to the one move. From the
// third row two subagents go out with a claim each to check, and come back. Then the concept comes down to the task,
// is handed in, and the planner settles it: only then may a builder claim the task.
const STEM = { at: 0.2, takes: 0.35 };
const STRETCHES = [
  { at: 0.7, takes: 0.5 },
  { at: 1.4, takes: 0.4 },
  { at: 2.0, takes: 0.4 },
  { at: 3.75, takes: 0.45 },
] as const;
const LAG = 0.08;
const CHECKS = [
  { out: 2.5, back: 3.1 },
  { out: 2.65, back: 3.3 },
] as const;
const CHECK = 0.38;
const MOVE = 4.2;
const FOLD = { at: 4.85, takes: 0.55 };
const HANDED = 5.4;
const SETTLED = 5.85;
// What each height of a stream is, from the frame up, and when its name comes up beside it.
const NAMES = [
  ["frame", 0.55],
  ["first principles", 1.2],
  ["taste", 1.8],
  ["check", 2.4],
  ["one move", MOVE],
] as const;
// How tall a stream is, in its own sizes, from the task's top edge to the one move; the least and the most a size
// is, in pixels; and the least at which each row has room for its name.
const TALL = 5.6;
const SMALLEST = 9;
const LARGEST = 18;
const ROOMY = 13;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
// Sets several of a thing's fields at once.
function put<T extends object>(target: T, fields: Partial<T>): void {
  Object.assign(target, fields);
}
const ease = (part: number) => {
  const p = clamp(part, 0, 1);
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
};
const easeOut = (part: number) => 1 - (1 - clamp(part, 0, 1)) ** 3;
// Out, a little past, and back: a part set down.
const settle = (part: number) => {
  const p = clamp(part, 0, 1) - 1;
  return 1 + 2.5 * p * p * p + 1.5 * p * p;
};

// The colours and the mono face, as the page has them now (its theme follows the system's).
function paints(canvas: HTMLCanvasElement): Paint {
  const style = getComputedStyle(canvas);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    ink: token("--ink"),
    soft: token("--ink-2"),
    edge: token("--edge"),
    line: token("--line"),
    surface: token("--surface"),
    brand: token("--brand"),
    solid: token("--solid"),
    onSolid: token("--on-solid"),
    ok: token("--ok"),
    warn: token("--warn"),
    font: style.fontFamily,
  };
}

const noSign = (): Sign => ({ by: null, was: null, turned: -Infinity, busy: -Infinity, idle: -Infinity, off: -Infinity });
// A sign is up from when it gets a name until it has turned away.
const up = (sign: Sign, now: number) => sign.by !== null && now < sign.off + TURN / 2;
// A task is claimed: its sign turns over to whoever is coming, and stays up.
function claim(sign: Sign, role: Role, now: number): void {
  if (!up(sign, now) || sign.by !== role) put(sign, { was: up(sign, now) ? sign.by : null, turned: now });
  put(sign, { by: role, off: Infinity });
}
// Work starts under a sign, for `takes` seconds where that's known, with the sign up for `stays` more ...
function begin(sign: Sign, role: Role, now: number, takes = Infinity, stays = LINGER): void {
  claim(sign, role, now);
  put(sign, { busy: now, idle: now + takes, off: now + takes + stays });
}
// ... and stops: the sign stays for whoever is due next, or turns away after a moment.
function end(sign: Sign, now: number, stays: boolean): void {
  put(sign, { idle: now, off: stays ? Infinity : now + LINGER });
}

// How far along a line that only climbs it has gone when it reaches a height.
function climbTo(line: Line, height: number): number {
  for (let i = 1; i < line.points.length; i++) {
    const below = line.points[i - 1];
    const above = line.points[i];
    if (!below || !above || below[1] < height || above[1] > height) continue;
    const start = line.along[i - 1] ?? 0;
    return start + (below[1] > above[1] ? (below[1] - height) / (below[1] - above[1]) : 0) * ((line.along[i] ?? start) - start);
  }
  return line.length;
}

// The thinking stream over a task, `size` between its strands and between its rows. Its names go on the right, and
// its checks out to the left, unless the longest name would run past `edge` there.
function streamOver(part: Part, h: number, size: number, edge: number): Stream {
  const side = part.x + size + 11 + 96 > edge ? -1 : 1;
  const heights = [-1, -2.4, -3.3, -4.2, -TALL].map((sizes) => sizes * size);
  const frame = heights[0] ?? 0;
  const check = heights[3] ?? 0;
  const strands = [-1, 0, 1].map((column): Strand => {
    // Out from the frame to its own column, straight up through its three beads, and in to the one move.
    const line = lineOf(
      rounded(
        [
          [0, frame],
          [column * size, -1.9 * size],
          [column * size, -4.7 * size],
          [0, -TALL * size],
        ],
        0.4 * size
      )
    );
    return { line, stops: [0, ...heights.slice(1, 4).map((height) => climbTo(line, height)), line.length], lag: Math.abs(column) * LAG };
  });
  const asked: Point = [-side * size, check];
  return {
    part,
    x: part.x,
    y: part.y - h / 2,
    size,
    side,
    stem: lineOf([
      [0, -4],
      [0, frame],
    ]),
    strands,
    checks: [lineOf([asked, [-side * 2.9 * size, check - 0.6 * size]]), lineOf([asked, [-side * 2.5 * size, check + 0.65 * size]])],
    heights,
    starts: Infinity,
  };
}

// A cycle laid out in the room there is: as wide as the page's column, so it starts under the brand and ends over the
// button, and its rows on the sheet's own ruling (every 56px from the top of the page, which is `above` this room).
// Null where there's too little room to draw one.
function lay(random: Random, width: number, height: number, above: number, now: number): Scene | null {
  const gutter = width <= 720 ? 16 : 20;
  const left = Math.max(0, (width - 1240) / 2) + gutter;
  const room = width - 2 * left;
  if (room < 240 || height < 96) return null;
  const roomy = height >= 300 && room >= 480;
  const unit = roomy ? 28 : 20;
  const w = roomy ? 22 : 18;
  const h = roomy ? 16 : 13;
  // The harness's rail is this far under the lowest tasks, and whoever runs along it glows a little past it.
  const drop = roomy ? 18 : 12;
  const rows = clamp(Math.floor((height - (roomy ? 128 : 46)) / (2 * unit)), 1, 5);
  const levels = clamp(Math.floor((room - w) / (unit * 5)) + 1, 3, 8);
  const step = (room - w) / (levels - 1);
  const rule = unit * 2;

  const plan = planCycle(random, levels, rows);
  // How far from the middle line the tasks reach; the middle line is on the ruling, unless the rail wouldn't fit.
  const reach = Math.max(...plan.tasks.map((task) => Math.abs(task.slot))) * unit + h / 2;
  const mid = Math.min(Math.round((above + height / 2) / rule) * rule - above, height - reach - drop - 10);
  const parts: Part[] = plan.tasks.map((task) => ({
    ...task,
    x: Math.round(left + w / 2 + task.level * step),
    y: mid + task.slot * unit,
    state: "planned",
    shown: Infinity,
    since: now,
    takes: 0,
    approved: Infinity,
    guarded: false,
    claimed: false,
    sign: noSign(),
    passed: -Infinity,
    seen: -Infinity,
    bumped: -Infinity,
  }));
  const ways: Way[] = [];
  for (const [a, b] of plan.links) {
    const from = parts[a];
    const to = parts[b];
    if (!from || !to) continue;
    const bend = Math.round((from.x + to.x) / 2);
    ways.push({
      from,
      to,
      starts: Infinity,
      line: lineOf(
        rounded(
          [
            [from.x + w / 2, from.y],
            [bend, from.y],
            [bend, to.y],
            [to.x - w / 2, to.y],
          ],
          10
        )
      ),
    });
  }
  const root = parts[0];
  const sink = parts.at(-1);
  if (!root || !sink) return null;
  // Who else this plan calls on. A stream needs open sheet over its task: its own height, and the innovator's name
  // above that.
  const called = cast(plan, random);
  for (const id of called.guarded) {
    const part = parts[id];
    if (part) part.guarded = true;
  }
  const over = parts[called.stream ?? -1];
  const size = over ? Math.min(LARGEST, Math.floor((over.y - h / 2 - 30) / TALL)) : 0;
  const stream = over && size >= SMALLEST ? streamOver(over, h, size, width - left) : null;
  // Round a task from the middle of its left side, where the ways into it arrive.
  const round = (out: number, radius: number): Line => {
    const a = w / 2 + out;
    const b = h / 2 + out;
    return lineOf(
      rounded(
        [
          [-a, 0],
          [-a, -b],
          [a, -b],
          [a, b],
          [-a, b],
          [-a, 0],
        ],
        radius
      )
    );
  };
  return {
    width,
    w,
    h,
    plan,
    parts,
    ways,
    outline: round(0, 5),
    orbit: round(5, 9),
    guard: round(3.5, 8),
    tick: lineOf([
      [-w * 0.2, h * 0.02],
      [-w * 0.05, h * 0.2],
      [w * 0.21, -h * 0.2],
    ]),
    enter: lineOf([
      [-12, mid],
      [root.x - w / 2, mid],
    ]),
    exit: lineOf([
      [sink.x + w / 2, mid],
      [width + 12, mid],
    ]),
    rail: lineOf([
      [root.x - w / 2, mid + reach + drop],
      [sink.x + w / 2, mid + reach + drop],
    ]),
    marks: [...new Set(parts.map((part) => part.x))],
    laid: { from: Infinity, takes: 1 },
    sign: noSign(),
    proved: 0,
    crest: mid - reach,
    walked: lowWay(plan).flatMap((id) => parts[id] ?? []),
    stream,
    agents: [],
    commits: [],
    phase: "request",
    since: now,
    until: now + ENTER,
    // Room for a name above the top tasks, and for the stream where it stands higher than they do.
    top: Math.max(0, Math.min(mid - reach - 38, stream ? stream.y - TALL * stream.size - 30 : Infinity)),
    bottom: mid + reach + drop + 10,
    titled: roomy,
    still: false,
  };
}

// Where an agent waits at a task: just clear of its left side, on the way into it.
const WAIT = 7;

// The way through `hops`, from where an agent waits at the first task to the left side of the last: along the links,
// and straight across any task on the way.
function journey(scene: Scene, hops: number[]): Line {
  const { parts, ways, w } = scene;
  const points: Point[] = [];
  hops.forEach((id, i) => {
    const here = parts[id];
    const next = parts[hops[i + 1] ?? -1];
    if (!here) return;
    if (i === 0) points.push([here.x - w / 2 - WAIT, here.y]);
    if (!next) return;
    const onward = ways.find((way) => way.from === here && way.to === next);
    const back = onward ? undefined : ways.find((way) => way.from === next && way.to === here);
    if (onward) points.push([here.x + w / 2, here.y], ...onward.line.points);
    else if (back) points.push(...back.line.points.toReversed(), [next.x - w / 2, next.y]);
  });
  return lineOf(points);
}

const newAgent = (role: Role, at: Part, from: number): Agent => ({
  role,
  at,
  doing: "idle",
  line: null,
  job: null,
  from,
  since: from,
  takes: 0,
  leaving: false,
  presence: 0,
});

// The way an agent takes from the task it's at to another: only along links whose first task is done, where work has
// already gone.
const walk = (scene: Scene, from: Part, to: Part): number[] => route(scene.plan, from.id, to.id, (first) => scene.parts[first]?.state === "done");

// A task waits for its thinking stream: nobody claims it until the concept is in and settled.
const held = (scene: Scene, part: Part, now: number) => scene.stream?.part === part && now < scene.stream.starts + SETTLED;

// Work that's ready goes to whoever of the right role is free and nearest: an approved task whose parents are all
// done to a builder, a built one to a reviewer, a reviewed one that guards something to the security reviewer; the
// longest waiting first.
function assign(scene: Scene, now: number): void {
  const { parts, agents } = scene;
  const ready = (part: Part) =>
    part.state === "built" ||
    part.state === "reviewed" ||
    (part.state === "planned" && part.approved <= now && !held(scene, part, now) && part.parents.every((id) => parts[id]?.state === "done"));
  for (const part of parts.filter((each) => !each.claimed && ready(each)).sort((a, b) => a.since - b.since)) {
    const role: Role = part.state === "built" ? "reviewer" : part.state === "reviewed" ? "security reviewer" : "builder";
    const nearest = agents
      .filter((agent) => agent.role === role && agent.doing === "idle" && !agent.leaving && now >= agent.from)
      .map((agent) => ({ agent, hops: walk(scene, agent.at, part) }))
      .sort((a, b) => a.hops.length - b.hops.length)[0];
    if (!nearest) continue;
    part.claimed = true;
    claim(part.sign, role, now);
    const line = journey(scene, nearest.hops);
    put(nearest.agent, { job: part, line, doing: "going", since: now, takes: Math.max(0.3, line.length / SPEED) });
  }
}

// The innovator comes to the task that wants a stream once it's approved, and goes once the concept is handed in.
function think(scene: Scene, now: number): void {
  const { stream, agents } = scene;
  if (!stream || stream.part.approved > now) return;
  if (stream.starts === Infinity) {
    stream.starts = now + 0.3;
    agents.push({ ...newAgent("innovator", stream.part, stream.starts), doing: "working", job: stream.part, takes: HANDED });
  }
  const t = now - stream.starts;
  if (t >= 0 && t < HANDED && stream.part.sign.by !== "innovator") begin(stream.part.sign, "innovator", now, HANDED - t);
  if (t < HANDED) return;
  for (const agent of agents) if (agent.role === "innovator") agent.leaving = true;
}

// Moves the scene on to `now`; true once its cycle has merged and gone, and the next is due.
function advance(scene: Scene, now: number, random: Random): boolean {
  const { parts, ways, agents, rail } = scene;
  const root = parts[0];
  const sink = parts.at(-1);
  if (!root || !sink) return true;
  think(scene, now);
  if (scene.phase === "request") {
    if (now < scene.until) return false;
    // The request has arrived: the planner traces it while the plan grows out of it, level by level.
    scene.phase = "plan";
    scene.since = now;
    scene.until = now + LEAD + (sink.level - 1) * STAGGER + GROW + 0.35;
    put(root, { shown: now, approved: now, state: "building", since: now, takes: scene.until - now });
    for (const way of ways) {
      way.starts = now + LEAD + way.from.level * STAGGER;
      way.to.shown = Math.min(way.to.shown, way.starts + GROW * 0.8);
    }
    agents.push({ ...newAgent("planner", root, now), doing: "working", job: root, takes: root.takes });
    begin(root.sign, "planner", now, root.takes);
    return false;
  }
  if (scene.phase === "plan") {
    if (now < scene.until) return false;
    // The plan is a proposal: the approver goes through it, from the request to the merge, and what it has passed
    // may be built. Under it the scaffolder lays the harness.
    put(root, { state: "done", since: now });
    for (const agent of agents) agent.leaving = true;
    const line = journey(scene, route(scene.plan, root.id, sink.id));
    const takes = Math.max(0.9, line.length / APPROVE_SPEED);
    agents.push({ ...newAgent("approver", root, now), doing: "going", line, job: sink, takes });
    scene.laid = { from: now + 0.25, takes: Math.max(0.9, rail.length / RAIL_SPEED) };
    agents.push({ ...newAgent("scaffolder", root, scene.laid.from), doing: "going", line: rail, job: sink, takes: scene.laid.takes });
    begin(scene.sign, "scaffolder", scene.laid.from, scene.laid.takes);
    scene.phase = "approve";
    scene.since = now;
    scene.until = Math.max(now + takes, scene.laid.from + scene.laid.takes) + 0.2;
    return false;
  }
  if (scene.phase === "approve") {
    const approver = agents.find((agent) => agent.role === "approver");
    const [x] = approver ? whereIs(scene, approver, now) : [Infinity];
    for (const part of parts) {
      if (part.approved <= now || x < part.x - scene.w / 2) continue;
      part.approved = now;
      begin(part.sign, "approver", now, GLANCE, 0);
    }
    if (now < scene.until) return false;
    for (const agent of agents) if (agent.role !== "innovator") agent.leaving = true;
    const builders = clamp(Math.round(parts.length / 5), 2, 4);
    for (let i = 0; i < builders; i++) agents.push(newAgent("builder", root, now + i * 0.22));
    agents.push(newAgent("reviewer", root, now + 0.6));
    if (parts.length > 6) agents.push(newAgent("reviewer", root, now + 1.8));
    scene.phase = "build";
    scene.since = now;
    return false;
  }
  if (scene.phase === "build") {
    for (const agent of agents) {
      if (agent.leaving || now < agent.from || agent.role === "innovator") continue;
      const job = agent.job;
      if (!job || agent.doing === "idle" || now < agent.since + agent.takes) continue;
      if (agent.doing === "going") {
        // There: a builder traces the task out, a reviewer walks round it, the security reviewer round what guards it.
        const takes = agent.role === "reviewer" ? REVIEW : agent.role === "security reviewer" ? SECURE : BUILD + random() * BUILD_MORE;
        const state: State = agent.role === "reviewer" ? "reviewing" : agent.role === "security reviewer" ? "securing" : "building";
        put(job, { state, since: now, takes });
        put(agent, { at: job, line: null, doing: "working", since: now, takes });
        begin(job.sign, agent.role, now);
      } else {
        // A task that guards something isn't done at its review: the security reviewer has to pass it too.
        const state: State = agent.role === "builder" ? "built" : agent.role === "reviewer" && job.guarded ? "reviewed" : "done";
        put(job, { state, since: now, claimed: false });
        put(agent, { doing: "idle", job: null, since: now });
        end(job.sign, now, state !== "done");
      }
    }
    // The security reviewer comes when the first task waits for it, by a task that one follows from.
    const waiting = parts.find((part) => part.state === "reviewed");
    if (waiting && !agents.some((agent) => agent.role === "security reviewer"))
      agents.push(newAgent("security reviewer", parts[waiting.parents[0] ?? 0] ?? root, now));
    assign(scene, now);
    if (!parts.every((part) => part.state === "done")) return false;
    // Everything is built and passed: the tester runs it over the harness, from the request to the merge, and the UX
    // specialist walks a journey through it.
    for (const agent of agents) agent.leaving = true;
    const takes = Math.max(1.1, rail.length / VERIFY_SPEED);
    agents.push({ ...newAgent("tester", root, now), doing: "going", line: rail, job: sink, takes });
    const line = journey(
      scene,
      scene.walked.map((part) => part.id)
    );
    const walks = Math.max(1.1, line.length / WALK_SPEED);
    agents.push({ ...newAgent("ux specialist", root, now + 0.3), doing: "going", line, job: sink, takes: walks });
    scene.phase = "verify";
    scene.since = now;
    scene.until = Math.max(now + takes, now + 0.3 + walks) + 0.3;
    return false;
  }
  if (scene.phase === "verify") {
    const tester = agents.find((agent) => agent.role === "tester");
    if (tester) scene.proved = ease((now - tester.since) / tester.takes) * rail.length;
    const proved = (rail.points[0]?.[0] ?? 0) + scene.proved;
    for (const part of parts) {
      if (part.passed >= scene.since || proved < part.x - scene.w / 2) continue;
      part.passed = now;
      begin(part.sign, "tester", now, GLANCE, 0);
    }
    const walker = agents.find((agent) => agent.role === "ux specialist");
    const [x] = walker && now >= walker.from ? whereIs(scene, walker, now) : [-Infinity];
    for (const part of scene.walked) {
      if (part.seen >= scene.since || x < part.x - scene.w / 2) continue;
      part.seen = now;
      begin(part.sign, "ux specialist", now, GLANCE, 0);
    }
    if (now < scene.until) return false;
    // It holds: each task merges, the first ones first, along the ways to the last.
    for (const agent of agents) agent.leaving = true;
    scene.commits = parts
      .filter((part) => part !== sink)
      .map((part) => {
        const line = journey(scene, route(scene.plan, part.id, sink.id));
        return { part, line, starts: now + part.level * 0.13 + random() * 0.1, takes: Math.max(0.45, line.length / MERGE_SPEED), landed: false };
      });
    scene.phase = "merge";
    scene.since = now;
    scene.until = Math.max(...scene.commits.map((commit) => commit.starts + commit.takes)) + 0.4;
    return false;
  }
  if (scene.phase === "merge") {
    for (const commit of scene.commits) {
      if (now >= commit.starts && commit.part.state !== "merged") put(commit.part, { state: "merged", since: now });
      if (now >= commit.starts + commit.takes && !commit.landed) {
        commit.landed = true;
        sink.bumped = now;
      }
    }
    if (now < scene.until) return false;
    // All of it is in the last task, which goes out along main.
    put(sink, { state: "merged", since: now });
    scene.phase = "ship";
    scene.since = now;
    scene.until = now + SHIP + REST;
    return false;
  }
  return now >= scene.until;
}

// How far along its line a strand has grown, `t` seconds into its stream: the strands set out one after another on
// each stretch but the last, and reach the one move together.
function grown(strand: Strand, t: number): number {
  let along = 0;
  STRETCHES.forEach((stretch, i) => {
    const lag = i < STRETCHES.length - 1 ? strand.lag : 0;
    along += ((strand.stops[i + 1] ?? 0) - (strand.stops[i] ?? 0)) * ease((t - stretch.at - lag) / stretch.takes);
  });
  return along;
}

// How high over its task a stream's head is: the innovator going up the stem and then the middle strand, and coming
// down again with the concept.
function headOf(stream: Stream, now: number): number {
  const t = now - stream.starts;
  const middle = stream.strands[1];
  if (t >= FOLD.at || !middle) return (stream.heights.at(-1) ?? 0) * (1 - ease((t - FOLD.at) / FOLD.takes));
  if (t >= STRETCHES[0].at) return pointAt(middle.line, grown(middle, t))[1];
  return pointAt(stream.stem, ease((t - STEM.at) / STEM.takes) * stream.stem.length)[1];
}

// Where an agent is: in its stream, on its way, round the task it's working on, or waiting at the left of the one
// it's at (stepping back to there once its work is done).
function whereIs(scene: Scene, agent: Agent, now: number): Point {
  if (agent.role === "innovator" && scene.stream) return [scene.stream.x, scene.stream.y + headOf(scene.stream, now)];
  const part = (now - agent.since) / agent.takes;
  if (agent.doing === "going" && agent.line) return pointAt(agent.line, ease(part) * agent.line.length);
  if (agent.doing === "working" && agent.job) {
    const around = agent.role === "reviewer" ? scene.orbit : agent.role === "security reviewer" ? scene.guard : scene.outline;
    const [x, y] = pointAt(around, (agent.role === "reviewer" ? ease(part) : clamp(part, 0, 1)) * around.length);
    return [agent.job.x + x, agent.job.y + y];
  }
  return [agent.at.x - scene.w / 2 - WAIT * easeOut((now - agent.since) / 0.3), agent.at.y];
}

// A line's stretch from `from` to `to` along it, as the canvas's path; false when there's none of it.
function trace(ctx: CanvasRenderingContext2D, line: Line, from: number, to: number): boolean {
  if (to <= from) return false;
  const [x, y] = pointAt(line, from);
  ctx.beginPath();
  ctx.moveTo(x, y);
  line.points.forEach((point, i) => {
    const along = line.along[i] ?? 0;
    if (along > from && along < to) ctx.lineTo(point[0], point[1]);
  });
  const [endX, endY] = pointAt(line, to);
  ctx.lineTo(endX, endY);
  return true;
}

// Something on its way: a dot at `head` along its line, what's just behind it fading out, and a glow about it.
function dot(ctx: CanvasRenderingContext2D, line: Line, head: number, color: string, alpha: number, radius: number, tail: number): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    ctx.globalAlpha = alpha * 0.5 * (1 - i / 4);
    if (trace(ctx, line, Math.max(0, head - ((i + 1) * tail) / 4), head - (i * tail) / 4)) ctx.stroke();
  }
  const [x, y] = pointAt(line, head);
  glow(ctx, x, y, color, alpha, radius);
}
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, alpha: number, radius: number): void {
  ctx.fillStyle = color;
  for (const [grown, shown] of [
    [3, 0.1],
    [1.9, 0.16],
    [1, 1],
  ] as const) {
    ctx.globalAlpha = alpha * shown;
    ctx.beginPath();
    ctx.arc(x, y, radius * grown, 0, Math.PI * 2);
    ctx.fill();
  }
}
// A concept's mark, as the canvas's path: a square on its corner.
function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x + radius, y);
  ctx.lineTo(x, y + radius);
  ctx.lineTo(x - radius, y);
  ctx.closePath();
}

// Work going on in a task, as the canvas's path about the task's middle: columns of dots across it, every other
// column rising and the ones between falling, each dot swelling and shrinking as a wave goes along its column the
// way the dots do. `strength` (0 to 1) is how much of it there is; a dot is nothing at the task's top and bottom, so
// none of it shows outside.
function cloud(ctx: CanvasRenderingContext2D, w: number, h: number, now: number, strength: number): void {
  const gap = 4;
  const columns = Math.round((w - 6) / gap) + 1;
  const dots = Math.ceil(h / gap) + 1;
  const run = dots * gap;
  ctx.beginPath();
  for (let column = 0; column < columns; column++) {
    const x = (column - (columns - 1) / 2) * gap;
    const way = column % 2 ? 1 : -1;
    for (let each = 0; each < dots; each++) {
      // Each column a little out of step with the last, so the dots are a cloud and not a grid.
      const along = (each * gap + column * 1.7 + way * now * 16) % run;
      const y = (along < 0 ? along + run : along) - run / 2;
      const inside = clamp((h / 2 - 1 - Math.abs(y)) / 2.5, 0, 1);
      const radius = strength * inside * (0.4 + 0.8 * (0.5 + 0.5 * Math.sin(now * 10 - way * y * 0.9 + column * 2.1)));
      if (radius < 0.2) continue;
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}

// A sign at the height y, kept on the sheet: its middle at x, or out from x to the right (`side` 1) or to the left
// (-1). It turns over about its own middle line: the name it had goes edge-on, and the one it has comes round (a
// sign that had none comes round from edge-on). While the work under it goes on, its name and its border pulse in
// the worker's colour; once it's `off`, it turns away.
function post(
  ctx: CanvasRenderingContext2D,
  sign: Sign,
  x: number,
  y: number,
  side: number,
  width: number,
  paint: Paint,
  now: number,
  fade: number
): void {
  const turn = sign.was ? ease((now - sign.turned) / TURN) : 0.5 + ease((now - sign.turned) / (TURN / 2)) / 2;
  const name = turn < 0.5 ? sign.was : sign.by;
  const facing = Math.abs(Math.cos(turn * Math.PI)) * Math.cos((ease((now - sign.off) / (TURN / 2)) * Math.PI) / 2);
  if (!name || facing < 0.03) return;
  const wide = ctx.measureText(name).width + 10;
  const working = turn >= 0.5 && now >= sign.busy && now < sign.idle;
  const pulse = working ? 0.5 + 0.5 * Math.sin((now - sign.busy) * 9) : 0;
  ctx.save();
  ctx.translate(clamp(x + (side * wide) / 2, 4 + wide / 2, width - 4 - wide / 2), y);
  ctx.scale(1, facing);
  ctx.globalAlpha = fade * 0.94;
  ctx.fillStyle = paint.surface;
  ctx.beginPath();
  ctx.roundRect(-wide / 2, -7.5, wide, 15, 4);
  ctx.fill();
  ctx.strokeStyle = paint.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  if (working) {
    ctx.globalAlpha = fade * (0.2 + 0.7 * pulse);
    ctx.strokeStyle = tone(name, paint);
    ctx.stroke();
  }
  ctx.globalAlpha = fade * (working ? 0.65 + 0.35 * pulse : 0.6);
  ctx.fillStyle = working ? paint.ink : paint.soft;
  ctx.fillText(name, -wide / 2 + 5, 0.5);
  ctx.restore();
}

// A thinking stream as it is at `now`, over its task: what the innovator has worked out so far, each height named as
// it's reached.
function thought(ctx: CanvasRenderingContext2D, stream: Stream, paint: Paint, now: number, fade: number): void {
  const t = now - stream.starts;
  if (t <= 0 || t >= HANDED + 0.3) return;
  const { size, strands, heights } = stream;
  const bead = Math.min(size / 7, 2.3);
  // All of it but the stem goes as the concept comes down.
  const kept = fade * (1 - ease((t - FOLD.at) / 0.4));
  ctx.save();
  ctx.translate(stream.x, stream.y);
  ctx.lineWidth = 1;
  ctx.strokeStyle = paint.warn;
  ctx.globalAlpha = fade * 0.8 * (1 - ease((t - HANDED) / 0.3));
  if (trace(ctx, stream.stem, 0, ease((t - STEM.at) / STEM.takes) * stream.stem.length)) ctx.stroke();
  if (kept > 0) {
    ctx.globalAlpha = kept * 0.7;
    for (const strand of strands) if (trace(ctx, strand.line, 0, grown(strand, t))) ctx.stroke();

    // A claim taken out to be checked: the subagent going out along a dotted line to what it asks, and coming back
    // with the answer. The first claim holds; the second doesn't, and goes.
    stream.checks.forEach((line, i) => {
      const out = ease((t - (CHECKS[i]?.out ?? Infinity)) / CHECK);
      if (out <= 0) return;
      const back = ease((t - (CHECKS[i]?.back ?? Infinity)) / CHECK);
      const holds = i === 0;
      const stays = kept * (holds ? 1 : 1 - 0.85 * back);
      const [endX, endY] = line.points.at(-1) ?? [0, 0];
      ctx.strokeStyle = paint.warn;
      ctx.globalAlpha = stays * 0.7;
      ctx.setLineDash([1, 3.5]);
      if (trace(ctx, line, 0, out * line.length)) ctx.stroke();
      ctx.setLineDash([]);
      if (out >= 1) {
        ctx.beginPath();
        ctx.arc(endX, endY, bead * 1.15, 0, Math.PI * 2);
        ctx.globalAlpha = stays;
        ctx.fillStyle = holds && back >= 1 ? paint.ok : paint.surface;
        ctx.fill();
        ctx.strokeStyle = holds && back >= 1 ? paint.ok : paint.warn;
        ctx.stroke();
      }
      if (back < 1) {
        const [x, y] = pointAt(line, (out - back) * line.length);
        glow(ctx, x, y, back > 0 ? (holds ? paint.ok : paint.soft) : paint.warn, kept, bead * 0.9);
      }
      // The answer that holds, landing on the bead that asked.
      const landed = (t - (CHECKS[i]?.back ?? Infinity) - CHECK) / 0.5;
      if (holds && landed > 0 && landed < 1) {
        const [x, y] = line.points[0] ?? [0, 0];
        ctx.globalAlpha = kept * 0.7 * (1 - landed);
        ctx.strokeStyle = paint.ok;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, bead + 7 * easeOut(landed), 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    });

    // The frame, an open bead on the stem; then each strand's beads as it reaches them. What the operator's taste
    // chooses is in their ink.
    const framed = (t - STEM.at - STEM.takes) / 0.25;
    if (framed > 0) {
      ctx.globalAlpha = kept;
      ctx.beginPath();
      ctx.arc(0, heights[0] ?? 0, bead * 1.3 * settle(framed), 0, Math.PI * 2);
      ctx.fillStyle = paint.surface;
      ctx.fill();
      ctx.strokeStyle = paint.warn;
      ctx.stroke();
    }
    for (const strand of strands)
      for (let row = 0; row < 3; row++) {
        const stretch = STRETCHES[row];
        const popped = stretch ? (t - stretch.at - strand.lag - stretch.takes) / 0.25 : 0;
        if (popped <= 0) continue;
        const [x, y] = pointAt(strand.line, strand.stops[row + 1] ?? 0);
        ctx.globalAlpha = kept;
        ctx.fillStyle = row === 1 ? paint.ink : paint.warn;
        ctx.beginPath();
        ctx.arc(x, y, bead * settle(popped), 0, Math.PI * 2);
        ctx.fill();
      }

    // The names of the heights, the one being worked on the plainest: it alone, where the rows are too close for a
    // line of words each.
    const latest = NAMES.findLastIndex(([, at]) => t >= at);
    ctx.textAlign = stream.side > 0 ? "left" : "right";
    NAMES.forEach(([name, at], i) => {
      const shown = ease((t - at) / 0.25);
      if (shown <= 0 || (size < ROOMY && i !== latest)) return;
      ctx.globalAlpha = kept * shown * (i === latest ? 1 : 0.55);
      ctx.fillStyle = i === latest ? paint.ink : paint.soft;
      ctx.fillText(name, stream.side * (size + 11), heights[i] ?? 0);
    });
    ctx.textAlign = "left";
  }

  // The one move: a diamond where the strands meet, a ring going out from it as it's seen at first glance, and then
  // down the stem to the task, as small as the mark the task carries.
  const made = (t - MOVE) / 0.3;
  if (made > 0 && t < HANDED) {
    const fold = ease((t - FOLD.at) / FOLD.takes);
    const y = headOf(stream, now);
    const radius = (size * 0.4 + (3.4 - size * 0.4) * fold) * settle(made);
    ctx.globalAlpha = fade;
    ctx.fillStyle = paint.warn;
    diamond(ctx, 0, y, radius);
    ctx.fill();
    const ring = (t - MOVE - 0.1) / 0.7;
    if (ring > 0 && ring < 1) {
      ctx.globalAlpha = fade * 0.6 * (1 - ring);
      ctx.strokeStyle = paint.warn;
      ctx.lineWidth = 1.2;
      diamond(ctx, 0, y, radius + 3 + 12 * easeOut(ring));
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Where a cycle has got to, for the drawing's title.
const LABEL: Record<Scene["phase"], string> = {
  request: "Request",
  plan: "Planning",
  approve: "Approving",
  build: "Building",
  verify: "Verifying",
  merge: "Merging",
  ship: "Merged to main",
};
function titleOf(scene: Scene, cycle: number): string {
  if (!scene.titled || scene.still) return "";
  const done = scene.parts.filter((part) => part.state === "done").length;
  return `Cycle ${String(cycle).padStart(2, "0")} · ${LABEL[scene.phase]}${scene.phase === "build" ? ` ${done}/${scene.parts.length}` : ""}`;
}

// An agent's colour: the operator's ink for those who decide what's built, the tester's green for those who prove
// it, the stream's amber for the one who thinks it through, and the brand's blue for the rest.
const tone = (role: Role, paint: Paint) =>
  role === "planner" || role === "approver"
    ? paint.ink
    : role === "tester" || role === "ux specialist"
      ? paint.ok
      : role === "innovator"
        ? paint.warn
        : paint.brand;
// The corners of a task, clockwise from its top left.
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

// Draws the scene as it is at `now`; `passed` seconds since the last drawing, for what fades in and out.
function draw(ctx: CanvasRenderingContext2D, scene: Scene, paint: Paint, now: number, passed: number): void {
  const { w, h, parts, ways, agents, rail, stream } = scene;
  const sink = parts.at(-1);
  const age = now - scene.since;
  // The whole drawing fades once it has merged.
  const fade = scene.phase === "ship" ? 1 - ease(age / 0.8) : 1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);
  ctx.font = `500 9.5px ${paint.font}`;
  ctx.textBaseline = "middle";

  // Main, in from the left and out to the right.
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = paint.edge;
  ctx.lineWidth = 1;
  for (const line of [scene.enter, scene.exit]) if (trace(ctx, line, 0, line.length)) ctx.stroke();

  // The harness: its rail, and a mark at each level, as far as the scaffolder has laid it; then again in the
  // tester's colour, as far as the work is proved.
  const [railX, railY] = rail.points[0] ?? [0, 0];
  for (const [far, color, alpha] of [
    [ease((now - scene.laid.from) / scene.laid.takes) * rail.length, paint.edge, 0.55],
    [scene.proved, paint.ok, 0.9],
  ] as const) {
    if (!trace(ctx, rail, 0, far)) continue;
    for (const x of scene.marks) {
      if (x - railX > far) continue;
      ctx.moveTo(x, railY);
      ctx.lineTo(x, railY - 4);
    }
    ctx.globalAlpha = fade * alpha;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  // The ways between tasks: drawn as the plan grows, lit while work flows along them, kept once both ends are done.
  for (const way of ways) {
    const grown = ease((now - way.starts) / GROW) * way.line.length;
    if (!trace(ctx, way.line, 0, grown)) continue;
    const merged = way.from.state === "merged";
    const open = way.from.state === "done";
    const through = open && way.to.state === "done";
    ctx.lineWidth = 1;
    ctx.strokeStyle = through ? paint.brand : paint.edge;
    ctx.globalAlpha = fade * (merged ? 0.28 : through ? 0.6 : 0.5);
    ctx.stroke();
    if (open && !through) {
      ctx.strokeStyle = paint.brand;
      ctx.globalAlpha = fade * 0.9;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([2, 9]);
      ctx.lineDashOffset = -now * 26;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  for (const part of parts) {
    const shown = now - part.shown;
    if (shown <= 0) continue;
    const since = now - part.since;
    const alpha = clamp(shown / 0.16, 0, 1) * fade;
    const scale = settle(shown / POP) * (1 + 0.24 * (1 - easeOut((now - part.bumped) / 0.32)));
    const proposed = part.approved > now;
    // What's left of a task that has merged: its solid, and what was round it, go on into main.
    const left = part.state === "merged" ? 1 - ease(since / 0.4) : 1;
    ctx.save();
    ctx.translate(part.x, part.y);
    ctx.scale(scale, scale);
    // A proposal is flat, its edge dashed. Approved, it's raised: its shadow down and to the right, its face, its
    // edge.
    if (!proposed) {
      ctx.globalAlpha = alpha * 0.1;
      ctx.fillStyle = paint.ink;
      ctx.beginPath();
      ctx.roundRect(-w / 2 + 1, -h / 2 + 1.5, w, h, 5);
      ctx.fill();
    }
    ctx.globalAlpha = alpha * (proposed ? 0.6 : 1);
    ctx.fillStyle = paint.surface;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 5);
    ctx.fill();
    ctx.globalAlpha = alpha * (part.state === "merged" ? 0.4 : 0.7);
    ctx.strokeStyle = paint.edge;
    ctx.lineWidth = 1;
    if (proposed) ctx.setLineDash([2, 2.5]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Done is the solid, with its tick; merged, the solid has gone on into main.
    const filled = part.state === "done" ? ease(since / 0.26) : part.state === "merged" ? left : 0;
    // How much work is going on in it: coming up as it starts, and dying down as it stops.
    const worked = ease((now - part.sign.busy) / 0.2) * (1 - ease((now - part.sign.idle) / 0.25));
    if (filled > 0) {
      ctx.globalAlpha = alpha * filled;
      ctx.fillStyle = paint.solid;
      ctx.fill();
      // The work takes the tick's place while it's there.
      ctx.globalAlpha = alpha * filled * (1 - worked);
      ctx.strokeStyle = paint.onSolid;
      ctx.lineWidth = 1.6;
      const ticked = part.state === "done" ? ease((since - 0.1) / 0.28) : 1;
      if (trace(ctx, scene.tick, 0, ticked * scene.tick.length)) ctx.stroke();
    }
    if (worked > 0 && part.sign.by) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = filled > 0.5 ? paint.onSolid : tone(part.sign.by, paint);
      cloud(ctx, w, h, now, worked);
    }
    // Being built: its outline traced, as far as the builder has got. Built: the whole of it, until it's passed.
    const over = part.state === "planned" || part.state === "done" || part.state === "merged";
    const traced = part.state === "building" ? clamp(since / part.takes, 0, 1) : over ? 0 : 1;
    if (traced > 0) {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = paint.brand;
      ctx.lineWidth = 1.6;
      if (trace(ctx, scene.outline, 0, traced * scene.outline.length)) ctx.stroke();
    }
    // One that guards something has a second outline: dotted until the security reviewer has been round it.
    if (part.guarded && left > 0) {
      const secured = part.state === "securing" ? clamp(since / part.takes, 0, 1) : part.state === "done" || part.state === "merged" ? 1 : 0;
      ctx.lineWidth = 1;
      if (secured < 1) {
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = paint.edge;
        ctx.setLineDash([1, 3]);
        if (trace(ctx, scene.guard, secured * scene.guard.length, scene.guard.length)) ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = alpha * left * 0.9;
      ctx.strokeStyle = paint.brand;
      ctx.lineWidth = 1.2;
      if (trace(ctx, scene.guard, 0, secured * scene.guard.length)) ctx.stroke();
    }
    // A ring going out from it: as the approver passes it, as it's done, as the tester passes, and, for the one a
    // stream is for, as the concept is handed in and as the planner settles it.
    const streamed = stream?.part === part ? stream.starts : Infinity;
    for (const [from, color, far] of [
      [part.approved, paint.ink, 7],
      [part.state === "done" ? part.since : -Infinity, paint.brand, 13],
      [part.passed, paint.ok, 13],
      [streamed + HANDED, paint.warn, 13],
      [streamed + SETTLED, paint.ink, 9],
    ] as const) {
      const ring = (now - from) / 0.6;
      if (!(ring > 0 && ring < 1)) continue;
      const out = 2 + far * easeOut(ring);
      ctx.globalAlpha = alpha * 0.6 * (1 - ring);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(-w / 2 - out, -h / 2 - out, w + 2 * out, h + 2 * out, 5 + out);
      ctx.stroke();
    }
    // The UX specialist looking at it: a viewfinder's corners closing on it.
    const look = (now - part.seen) / 0.8;
    if (look > 0 && look < 1) {
      const out = 3 + 5 * (1 - easeOut(look * 2.5));
      const a = w / 2 + out;
      const b = h / 2 + out;
      ctx.globalAlpha = alpha * (1 - ease((look - 0.45) / 0.55));
      ctx.strokeStyle = paint.ok;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (const [x, y] of CORNERS) {
        ctx.moveTo(x * a, y * (b - 4));
        ctx.lineTo(x * a, y * b);
        ctx.lineTo(x * (a - 4), y * b);
      }
      ctx.stroke();
    }
    // The one a stream is for carries a diamond on its top edge: an open one while the concept is wanted, a full one
    // once it's in.
    if (stream?.part === part && left > 0) {
      const full = now >= stream.starts + HANDED;
      ctx.globalAlpha = alpha * left;
      diamond(ctx, 0, -h / 2, 3.4);
      ctx.fillStyle = full ? paint.warn : paint.surface;
      ctx.fill();
      ctx.strokeStyle = full ? paint.surface : paint.warn;
      ctx.lineWidth = full ? 0.8 : 1.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  if (stream) thought(ctx, stream, paint, now, fade);

  // The request coming in, each task's work on its way to the merge, and all of it going out along main.
  if (scene.phase === "request") dot(ctx, scene.enter, ease(age / ENTER) * scene.enter.length, paint.ink, 1, 3.2, 40);
  for (const commit of scene.commits) {
    const part = (now - commit.starts) / commit.takes;
    if (part > 0 && part < 1) dot(ctx, commit.line, ease(part) * commit.line.length, paint.brand, 1, 2.6, 34);
  }
  if (scene.phase === "ship" && sink) {
    const part = clamp(age / SHIP, 0, 1);
    if (part < 1) dot(ctx, scene.exit, part * part * scene.exit.length, paint.brand, 1, 3.6, 72);
  }

  for (const agent of agents) {
    if (now < agent.from) continue;
    agent.presence += ((agent.leaving ? 0 : 1) - agent.presence) * Math.min(1, passed * 7);
    if (agent.presence < 0.01) continue;
    const color = tone(agent.role, paint);
    const [x, y] = whereIs(scene, agent, now);
    // The tester's line across the tasks, as it runs them.
    if (agent.role === "tester" && scene.phase === "verify") {
      ctx.globalAlpha = agent.presence * 0.3;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x, scene.crest - 8);
      ctx.stroke();
    }
    if (agent.doing === "going" && agent.line)
      dot(ctx, agent.line, ease((now - agent.since) / agent.takes) * agent.line.length, color, agent.presence, 3.2, 44);
    else glow(ctx, x, y, color, agent.presence, 3.2);
    if (JUDGES.has(agent.role)) {
      ctx.globalAlpha = agent.presence;
      ctx.fillStyle = paint.surface;
      ctx.beginPath();
      ctx.arc(x, y, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The signs, which stay where the work is while the dots come and go: over the middle of each task that's
  // someone's (beside the stem of a stream, on the side its names aren't, where one stands on the task), and on the
  // start of the rail.
  for (const part of parts) {
    if (!up(part.sign, now)) continue;
    const beside = stream?.part === part ? -stream.side : 0;
    const x = part.x + beside * (0.6 * (stream?.size ?? 0) + 6);
    post(ctx, part.sign, x, part.y - h / 2 - 16.5, beside, scene.width, paint, now, fade);
  }
  if (up(scene.sign, now)) post(ctx, scene.sign, railX, railY, 1, scene.width, paint, now, fade);

  ctx.globalAlpha = 1;
}

// Runs the drawing in the canvas's box, with its title above, until the returned function is called.
function run(canvas: HTMLCanvasElement, title: HTMLElement): () => void {
  const ctx = canvas.getContext("2d");
  const stage = canvas.parentElement;
  if (!ctx || !stage) return () => {};
  const lessMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const theme = window.matchMedia("(prefers-color-scheme: dark)");
  const random = seeded(Date.now() % 2 ** 32);
  let paint = paints(canvas);
  let scene: Scene | null = null;
  let cycle = 1;
  let clock = 0;
  let last = 0;
  let frame = 0;
  let ratio = 1;
  let width = 0;
  let height = 0;
  let titled = "";

  const render = (passed: number) => {
    ctx.setTransform(ratio, 0, 0, ratio, 0, -(scene?.top ?? 0) * ratio);
    ctx.clearRect(0, 0, width, height);
    if (scene) draw(ctx, scene, paint, clock, passed);
    const text = scene ? titleOf(scene, cycle) : "";
    if (text !== titled) title.textContent = titled = text;
  };
  const above = () => stage.getBoundingClientRect().top + window.scrollY;
  // The next scene, with the canvas put over the band of the sheet it's drawn in and no bigger: at most twice as
  // fine as the page, and less on a very wide one. For anyone who asks for less motion, one still drawing: a cycle's
  // tasks, all done and proved, the concept in.
  const next = () => {
    scene = lay(lessMotion.matches ? seeded(7) : random, width, height, above(), clock);
    if (scene && lessMotion.matches) {
      for (const part of scene.parts) put(part, { shown: -Infinity, approved: -Infinity, state: "done", since: -Infinity });
      for (const way of scene.ways) way.starts = -Infinity;
      if (scene.stream) scene.stream.starts = -Infinity;
      put(scene, { phase: "build", still: true, laid: { from: -Infinity, takes: 1 }, proved: scene.rail.length });
    }
    const tall = scene ? scene.bottom - scene.top : 0;
    ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3_000_000 / Math.max(1, width * tall)));
    canvas.style.top = `${scene?.top ?? 0}px`;
    canvas.style.height = `${tall}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(tall * ratio);
  };
  const tick = (time: number) => {
    frame = requestAnimationFrame(tick);
    const elapsed = time - last;
    // At most 60 or so a second, however fast the display.
    if (elapsed < 12) return;
    last = time;
    const passed = Math.min(elapsed, 50) / 1000;
    clock += passed;
    if (scene && advance(scene, clock, random)) {
      cycle += 1;
      next();
    }
    render(passed);
    // No room for another: nothing more to draw until the window changes.
    if (!scene) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
  const fit = () => {
    const box = stage.getBoundingClientRect();
    // A scene goes on while it still fits: the words under it changing height don't start it again, and the next
    // cycle is laid out in the room there is then.
    const fits = scene !== null && Math.round(box.width) === width && scene.bottom <= box.height;
    width = Math.round(box.width);
    height = Math.round(box.height);
    if (!fits) next();
    render(0);
    const moving = scene !== null && !scene.still;
    if (moving && !frame) frame = requestAnimationFrame(tick);
    if (!moving) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
  const restart = () => {
    scene = null;
    fit();
  };
  const repaint = () => {
    paint = paints(canvas);
    if (!frame) render(0);
  };

  const observer = new ResizeObserver(fit);
  observer.observe(stage);
  lessMotion.addEventListener("change", restart);
  theme.addEventListener("change", repaint);
  // The mono face may arrive after the first frame.
  void document.fonts.ready.then(repaint);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    lessMotion.removeEventListener("change", restart);
    theme.removeEventListener("change", repaint);
  };
}
