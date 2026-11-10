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
// Read by the operator as much as by the planner (the web app's inbox and its emails show a task's text): what the
// task is and how it ends. How the planner carries it is in its own rules (plugin/agents/planner.md).
const BODY = `The operator asked to agree this project's foundation before features are built on it (team.json operator.designCheckIn). While this task is open, only scaffold and test-infra work is claimed.

The planner raises it as a question once the skeleton and the harness have merged and the design record (${DESIGN_RECORD}, or where the repository keeps one) says what was chosen, why, what else was weighed, what it costs to run and how hard each choice is to change later. The operator answers in words: agreed, and features start; or what to change, which the team makes as scaffold work before asking again.`;

// Files the team's design check-in when its operator asked for one and the graph has none (open or settled: it's asked
// once). Resolves to the new task's id, or null.
export async function fileDesignCheckIn(store: Store, team: Team): Promise<string | null> {
  if (!team.operator.designCheckIn) return null;
  if ((await store.tasks.all()).some((t) => t.kind === "design")) return null;
  return (await addTask(store, team.name, { title: TITLE, kind: "design", body: BODY }, MERGE)).id;
}
