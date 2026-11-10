// The design check-in: how a new project's foundation reaches the operator before features are built on it. On a team
// whose operator asked for one (team.json operator.designCheckIn), register files a `design` task. While it's open,
// only scaffold and test-infra work is claimed (model.ts claimRefusal). The planner raises it as a question once the
// skeleton has merged with its design record; the operator's answer settles it, or sends it back with what to change.
import type { Team } from "../config.ts";
import { addTask } from "./add.ts";
import { MERGE } from "./model.ts";
import type { Store } from "./store.ts";

// Where a repository's design record goes when it keeps none already.
export const DESIGN_RECORD = "docs/architecture.md";

const TITLE = "Design check-in: the operator agrees the foundation";
const BODY = `The operator asked to agree this project's foundation before features are built on it (team.json operator.designCheckIn). While this task is open, only scaffold and test-infra work is claimed.

Planner, this is yours to carry:

1. Leave it here until the skeleton and the harness have merged and the design record (${DESIGN_RECORD}, or where the repository keeps one) says what was chosen, why, what else was weighed, what it costs to run and how hard each choice is to change later.
2. Then raise it: a6g task status <this task> question --reason "…" --recommend "…". In the reason, say in a few lines what now runs end to end, name each choice that would be costly to change (the stack, the architecture, the data store, how clients or devices reach it, where it's hosted and what that costs a month), give the record's path, and offer the options: (a) agreed as built (b) change something, saying what. Recommend one.
3. When the answer agrees, close it (a6g task status <this task> done) and feature work starts. When it asks for a change, take it back (a6g task status <this task> triage), have the change made as scaffold work, and raise it again.`;

// Files the team's design check-in when its operator asked for one and the graph has none (open or settled: it's asked
// once). Resolves to the new task's id, or null.
export async function fileDesignCheckIn(store: Store, team: Team): Promise<string | null> {
  if (!team.operator.designCheckIn) return null;
  if ((await store.tasks.all()).some((t) => t.kind === "design")) return null;
  return (await addTask(store, team.name, { title: TITLE, kind: "design", body: BODY }, MERGE)).id;
}
