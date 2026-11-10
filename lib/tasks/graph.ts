// The task graph as a BetterDiagrams document, generated from the tasks and never edited: a band per journey with its
// tasks inside, a band for the tasks in no journey, columns by how many tasks must come first, and an edge for each
// dependency. Open it with `npx @mosphere/better-diagrams <file>`; a6g serve draws the same layout itself. The web app
// also draws it by level (levelDiagram, below): the journeys on the top level, their tasks drilled into.
import { claimOrder, journeyDue, type Kind, type Task } from "./model.ts";

const W = 220;
const H = 76;
const COL = W + 48;
const ROW = H + 20;
const PAD = 24;
const TOP = 44;

const ICON: Record<Kind, string> = {
  feature: "code",
  bug: "activity",
  ux: "eye",
  test: "check",
  "test-infra": "gear",
  scaffold: "gear",
  chore: "gear",
  research: "search",
  journey: "layers",
};

export interface Placed {
  task: Task;
  band: string;
  col: number;
  row: number;
}
export interface Band {
  id: string;
  label: string;
  journey: Task | null;
  cols: number;
  rows: number;
}

// Where each task goes: its band (its journey, or none) and its column (the longest chain of tasks before it).
export function layout(tasks: Task[], { all = false } = {}): { bands: Band[]; placed: Placed[] } {
  const shown = tasks.filter((t) => all || t.status !== "rejected");
  const byId = new Map(shown.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const depthOf = (t: Task, seen = new Set<string>()): number => {
    const known = depth.get(t.id);
    if (known !== undefined) return known;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const before = t.after.flatMap((id) => byId.get(id) ?? []);
    const d = before.length ? 1 + Math.max(...before.map((b) => depthOf(b, seen))) : 0;
    depth.set(t.id, d);
    return d;
  };
  const journeys = shown.filter((t) => t.kind === "journey");
  const bands: Band[] = [
    ...journeys.map((j) => ({ id: `j${j.id}`, label: `#${j.id} ${j.title}`, journey: j, cols: 0, rows: 0 })),
    { id: "none", label: "Not in a journey", journey: null, cols: 0, rows: 0 },
  ];
  const placed: Placed[] = [];
  for (const band of bands) {
    const members = shown.filter((t) => t.kind !== "journey" && (band.journey ? t.parent === band.journey.id : !t.parent || !byId.has(t.parent)));
    const columns = new Map<number, Task[]>();
    for (const t of members) columns.set(depthOf(t), [...(columns.get(depthOf(t)) ?? []), t]);
    for (const [col, list] of columns) list.sort(claimOrder).forEach((task, row) => placed.push({ task, band: band.id, col, row }));
    band.cols = Math.max(1, ...[...columns.keys()].map((c) => c + 1));
    band.rows = Math.max(1, ...[...columns.values()].map((l) => l.length));
  }
  return { bands: bands.filter((b) => b.journey || placed.some((p) => p.band === b.id)), placed };
}

const label = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function betterDiagram(tasks: Task[], { title, all = false }: { title: string; all?: boolean }): Record<string, unknown> {
  const { bands, placed } = layout(tasks, { all });
  const nodes: Record<string, unknown>[] = [];
  let y = 40;
  for (const band of bands) {
    const w = PAD * 2 + band.cols * COL - (COL - W);
    const h = TOP + band.rows * ROW - (ROW - H) + PAD;
    const j = band.journey;
    nodes.push({
      id: band.id,
      label: label(band.label, 60),
      kind: "group",
      icon: j ? ICON.journey : "folder",
      x: 40,
      y,
      w,
      h,
      ...(j ? { description: journeyDue(j, tasks) ? "due its verification" : j.status } : {}),
    });
    for (const p of placed.filter((p) => p.band === band.id)) {
      const t = p.task;
      nodes.push({
        id: `t${t.id}`,
        label: label(`#${t.id} ${t.title}`, 48),
        kind: "service",
        icon: ICON[t.kind],
        x: PAD + p.col * COL,
        y: TOP + p.row * ROW,
        w: W,
        h: H,
        parentId: band.id,
        description: [t.status, t.severity, t.priority === null ? null : `p${t.priority}`, t.claim ? `${t.claim.role}@${t.claim.machine}` : null]
          .filter(Boolean)
          .join(" · "),
        ...(t.status === "done" || t.status === "rejected" ? { status: "dark" } : {}),
      });
    }
    y += h + 40;
  }
  const ids = new Set(placed.map((p) => p.task.id));
  let k = 0;
  const edges = placed.flatMap(({ task }) =>
    task.after.filter((id) => ids.has(id)).map((id) => ({ id: `e${++k}`, source: `t${id}`, target: `t${task.id}`, label: "first", style: "dashed" }))
  );
  return { version: 1, meta: { title: `${title}: task graph`, routing: "orthogonal", versionTag: new Date().toISOString().slice(0, 10) }, nodes, edges };
}

// --- By level -------------------------------------------------------------------------------------------------------
// The same graph as BetterDiagrams' C1–C4 levels, drilled into rather than laid out at once: the journeys on the top
// level (C1), with a card for the tasks in none; a journey's tasks a level down (C2); and whatever sits inside those
// further down, a level for every `parent`. Each card is placed on its own level, among the cards beside it.

// The card on the top level that holds the tasks in no journey (task ids are numbers).
export const NO_JOURNEY = "none";

export interface LevelCard {
  // The task's id, or NO_JOURNEY.
  id: string;
  task: Task | null;
  // The card it's inside (an id, as above), or null on the top level.
  inside: string | null;
  col: number;
  row: number;
}

// What a task waits on: the tasks it comes after, and those a blocked task waits for (its wait).
const waitsOn = (t: Task): string[] => [...new Set([...t.after, ...(t.wait?.on ?? [])])];

// Where each card goes: inside its parent's card when its parent is shown, a journey in none on the top level, other
// work in none inside NO_JOURNEY. Its column is the longest chain of cards beside it that must come first (one does
// when something in it is waited on by something in the other), its row the order members claim them in; a column
// with more cards than the level should be tall goes on in the next.
export function levels(tasks: Task[], { all = false } = {}): LevelCard[] {
  // By id, so the same graph is drawn the same way whatever order the store gives it in.
  const shown = tasks.filter((t) => all || t.status !== "rejected").sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
  const byId = new Map(shown.map((t) => [t.id, t]));
  const rank = new Map(shown.map((t, i) => [t.id, i]));
  const parentOf = (t: Task): string | null => (t.parent && t.parent !== t.id && byId.has(t.parent) ? t.parent : null);
  // Parents that lead back to a task are a loop: it's broken at its first task, which leaves its parent; the rest stay.
  const breaksLoop = (t: Task): boolean => {
    const loop = [t.id];
    for (let p = parentOf(t); p && !loop.includes(p); p = parentOf(byId.get(p)!)) loop.push(p);
    return parentOf(byId.get(loop.at(-1)!)!) === t.id && loop.every((id) => rank.get(t.id)! <= rank.get(id)!);
  };
  const insideOf = new Map<string, string | null>();
  for (const t of shown) insideOf.set(t.id, parentOf(t) && !breaksLoop(t) ? parentOf(t) : t.kind === "journey" ? null : NO_JOURNEY);
  const ids = [...byId.keys(), ...([...insideOf.values()].includes(NO_JOURNEY) ? [NO_JOURNEY] : [])];
  // The cards from the top level down to a task's own.
  const pathOf = (id: string): string[] => {
    const path = [id];
    for (let at = insideOf.get(id) ?? null; at; at = insideOf.get(at) ?? null) path.unshift(at);
    return path;
  };
  // A dependency, on the level where the two paths part: the card holding the task first waits on the one holding
  // what it's after. None between a card and what's inside it.
  const before = new Map<string, Set<string>>();
  for (const t of shown)
    for (const dep of waitsOn(t).filter((d) => byId.has(d))) {
      const [to, from] = [pathOf(t.id), pathOf(dep)];
      let i = 0;
      while (i < to.length && i < from.length && to[i] === from[i]) i++;
      if (i < to.length && i < from.length) before.set(to[i]!, (before.get(to[i]!) ?? new Set()).add(from[i]!));
    }
  const col = new Map<string, number>();
  const colOf = (id: string, seen = new Set<string>()): number => {
    const known = col.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const first = [...(before.get(id) ?? [])];
    const c = first.length ? 1 + Math.max(...first.map((b) => colOf(b, seen))) : 0;
    col.set(id, c);
    return c;
  };
  const order = (a: string, b: string) => (a === NO_JOURNEY ? 1 : b === NO_JOURNEY ? -1 : claimOrder(byId.get(a)!, byId.get(b)!));
  const onLevel = new Map<string, string[]>();
  for (const id of ids) onLevel.set(insideOf.get(id) ?? "", [...(onLevel.get(insideOf.get(id) ?? "") ?? []), id]);
  const cards: LevelCard[] = [];
  for (const members of onLevel.values()) {
    // A level tends to half again as many rows as columns (about 1.6:1 on a screen): a taller column wraps into columns
    // side by side, so twenty journeys with nothing between them aren't one strip too long to read.
    const most = Math.ceil(Math.sqrt(1.5 * members.length));
    let x = 0;
    for (const c of [...new Set(members.map((id) => colOf(id)))].sort((a, b) => a - b)) {
      const column = members.filter((id) => colOf(id) === c).sort(order);
      column.forEach((id, i) =>
        cards.push({ id, task: byId.get(id) ?? null, inside: insideOf.get(id) ?? null, col: x + Math.floor(i / most), row: i % most })
      );
      x += Math.ceil(column.length / most);
    }
  }
  return cards;
}

const CARD_W = 280;
const CARD_H = 88;
const CARD_COL = CARD_W + 80;
const CARD_ROW = CARD_H + 44;

// The kinds of card besides BetterDiagrams' own `task`, which the editor is told about (web/components/level-graph.tsx).
export const LEVEL_KINDS = {
  journey: "journey",
  none: "no-journey",
  unapproved: "not-approved",
  question: "question",
  blocked: "blocked",
  waiting: "waiting",
} as const;
// Only work a member may build is a `task`, so the editor's own reading of one (ready when nothing it waits on is
// open, its done check, the plan's progress) holds: work waiting for a decision, put to the operator or stopped is a
// card of its own kind, and so is approved work waiting on what the editor can't see as a task (below).
const KIND_OF: Record<Task["status"], string> = {
  approved: "task",
  building: "task",
  review: "task",
  done: "task",
  triage: LEVEL_KINDS.unapproved,
  proposed: LEVEL_KINDS.unapproved,
  researching: LEVEL_KINDS.unapproved,
  rejected: LEVEL_KINDS.unapproved,
  question: LEVEL_KINDS.question,
  blocked: LEVEL_KINDS.blocked,
};

// The graph by level as a BetterDiagrams document: a journey is a card its tasks are drilled into; a task a card of its
// status's kind (above), done once merged, in progress while it's built and in review, held by the member that
// claimed it; and a dependency an arrow from what comes first (dashed for what a blocked task waits on), drawn between
// the tasks themselves (the editor lifts it onto the cards that hold them on the levels above). `href` links each card
// to the task's own page.
export function levelDiagram(
  tasks: Task[],
  { title, all = false, href }: { title: string; all?: boolean; href?: (task: Task) => string }
): Record<string, unknown> {
  const cards = levels(tasks, { all });
  const nodeId = (id: string) => (id === NO_JOURNEY ? NO_JOURNEY : `t${id}`);
  // The editor holds a task back only for a task card before it that isn't done, where a6g holds it for anything it
  // comes after that isn't done (claimRefusal): a journey, work not approved or stopped, or what isn't drawn (rejected,
  // or gone). Approved work after any of those, or after work that waits so itself, is Waiting, not a task.
  const everyTask = new Map(tasks.map((t) => [t.id, t]));
  const drawn = new Set(cards.map((c) => c.id));
  const kinds = new Map<string, string>();
  const unseen = (t: Task): string[] =>
    t.after.filter((id) => {
      const dep = everyTask.get(id);
      return dep?.status !== "done" && (!dep || !drawn.has(id) || dep.kind === "journey" || kindOf(dep) !== "task");
    });
  const kindOf = (t: Task): string => {
    const known = kinds.get(t.id);
    if (known) return known;
    // A status this app doesn't know of can't be said to be ready.
    kinds.set(t.id, KIND_OF[t.status] ?? LEVEL_KINDS.waiting);
    if (t.status === "approved" && unseen(t).length) kinds.set(t.id, LEVEL_KINDS.waiting);
    return kinds.get(t.id)!;
  };
  const inside = (id: string) => cards.filter((c) => c.inside === id && c.task).map((c) => c.task!);
  const doneOf = (list: Task[]) => `${list.filter((k) => k.status === "done").length} of ${list.length} done`;
  const nodes = cards.map(({ id, task: t, inside: parent, col, row }) => {
    const at = { parentId: parent === null ? null : nodeId(parent), x: col * CARD_COL, y: row * CARD_ROW, w: CARD_W, h: CARD_H };
    if (!t) return { id: NO_JOURNEY, label: "Not in a journey", kind: LEVEL_KINDS.none, icon: "folder", description: doneOf(inside(NO_JOURNEY)), ...at };
    const common = {
      id: nodeId(id),
      label: label(`#${t.id} ${t.title}`, 60),
      ...(href ? { url: href(t) } : {}),
      ...(t.status === "rejected" ? { status: "retired" } : {}),
      ...at,
    };
    if (t.kind === "journey") {
      const kids = inside(t.id);
      const progress = !kids.length ? "no tasks yet" : t.status === "done" ? `${kids.length} task${kids.length === 1 ? "" : "s"}` : doneOf(kids);
      return {
        ...common,
        kind: LEVEL_KINDS.journey,
        icon: ICON.journey,
        description: `${journeyDue(t, tasks) ? "due its verification" : t.status} · ${progress}`,
      };
    }
    const kind = kindOf(t);
    const waits = kind === LEVEL_KINDS.waiting ? unseen(t) : [];
    return {
      ...common,
      kind,
      icon: ICON[t.kind] ?? "none",
      description: [
        t.kind,
        t.status,
        t.severity,
        t.priority === null ? null : `p${t.priority}`,
        waits.length ? `waits on ${waits.map((w) => `#${w}`).join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      ...(t.status === "done" ? { done: true } : {}),
      ...(t.status === "building" ? { stage: "in-progress" } : t.status === "review" ? { stage: "in-review" } : {}),
      ...(t.claim ? { assignees: [`${t.claim.role}@${t.claim.machine}`] } : {}),
    };
  });
  // Only between two tasks neither of which holds the other.
  const holds = new Map(cards.map((c) => [c.id, c.inside]));
  const within = (id: string, outer: string): boolean => {
    for (let at = holds.get(id) ?? null; at; at = holds.get(at) ?? null) if (at === outer) return true;
    return false;
  };
  let k = 0;
  const edges = cards.flatMap(({ id, task }) =>
    (task ? waitsOn(task) : [])
      .filter((dep) => holds.has(dep) && !within(id, dep) && !within(dep, id))
      .map((dep) => {
        const waiting = !task!.after.includes(dep);
        return {
          id: `e${++k}`,
          source: nodeId(dep),
          target: nodeId(id),
          label: waiting ? "waits" : "",
          style: waiting ? "dashed" : "solid",
          color: waiting ? "rose" : "slate",
        };
      })
  );
  return { version: 1, meta: { title: `${title}: task graph`, routing: "orthogonal" }, nodes, edges };
}
