import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LevelGraph } from "../../../../components/level-graph.tsx";
import { levelDiagram } from "../../../../../lib/tasks/graph.ts";
import { can } from "../../../../server/access.ts";
import { tasksOf, teamFor } from "../team.ts";

export const metadata: Metadata = { title: "Graph" };

// The task graph by level (lib/tasks/graph.ts): the journeys, each one's tasks a level down, and what's inside those
// further down. ?at=<id> opens the level inside that card, or the one a task is on (components/level-graph.tsx).
export default async function GraphPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  if (!can(viewer, "team:board", team.name)) notFound();
  const tasks = await tasksOf(team.name);
  return (
    <section className="panel" aria-labelledby="graph">
      <h2 id="graph">Graph</h2>
      {tasks.some((t) => t.status !== "rejected") ? (
        <>
          <p className="small muted">
            The journeys, with each one&apos;s tasks a level down. Open a card with a double-click or its ⊞ count; the breadcrumbs or Esc come back out,
            and ↗ opens a task&apos;s page. Task cards are work a member can take once what comes before is done; the other kinds say what they wait for.
          </p>
          <LevelGraph
            diagram={levelDiagram(tasks, { title: team.title || team.name, href: (t) => `/t/${team.name}/tasks/${t.id}` })}
            filename={`${team.name}-task-graph`}
          />
        </>
      ) : (
        <p className="empty">No tasks yet.</p>
      )}
    </section>
  );
}
