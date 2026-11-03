import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LevelGraph } from "../../../../components/level-graph.tsx";
import { param, type SearchParams } from "../../../../components/ui.tsx";
import { levelDiagram, NO_JOURNEY } from "../../../../../lib/tasks/graph.ts";
import { can, TASK_ID } from "../../../../server/access.ts";
import { storeFor } from "../../../../server/factory.ts";
import { teamFor } from "../team.ts";

export const metadata: Metadata = { title: "Graph" };

// The task graph by level (lib/tasks/graph.ts): the journeys, each one's tasks a level down, and what's inside those
// further down. ?at=<id> opens the level inside that card, or the one a task is on.
export default async function GraphPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  if (!can(viewer, "team:board", team.name)) notFound();
  const tasks = await storeFor(team.name).tasks.all();
  const asked = param((await searchParams)["at"]);
  return (
    <section className="panel" aria-labelledby="graph">
      <h2 id="graph">Graph</h2>
      <p className="small muted">
        The journeys, with each one&apos;s tasks a level down. Double-click a card to open it; the breadcrumbs or Esc come back out, and ↗ opens a
        task&apos;s page.
      </p>
      <LevelGraph
        diagram={levelDiagram(tasks, { title: team.title || team.name, href: (t) => `/t/${team.name}/tasks/${t.id}` })}
        at={asked === NO_JOURNEY ? NO_JOURNEY : TASK_ID.test(asked) ? `t${asked}` : null}
        filename={`${team.name}-task-graph`}
      />
    </section>
  );
}
