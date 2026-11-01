import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { TaskCard } from "../../../../components/task-card.tsx";
import { Notice, type SearchParams } from "../../../../components/ui.tsx";
import { can } from "../../../../server/access.ts";
import { storeFor } from "../../../../server/factory.ts";
import { originsFor } from "../../../../server/origin.ts";
import { kanban } from "../../../../server/views.ts";
import { teamFor } from "../team.ts";
import { TaskForm } from "./task-form.tsx";

export const metadata: Metadata = { title: "Add a task" };

export default async function AddTaskPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  const admin = can(viewer, "tasks:add", team.name);
  if (!admin && !can(viewer, "tasks:suggest", team.name)) notFound();
  const [tasks, origins] = await Promise.all([storeFor(team.name).tasks.all(), originsFor(team.name, viewer)]);
  const journeys = tasks.filter((t) => t.kind === "journey" && t.status !== "done" && t.status !== "rejected").map((t) => ({ id: t.id, title: t.title }));
  const triage = kanban(tasks).columns.find((c) => c.lane === "triage")?.cards ?? [];
  return (
    <>
      <p className="small">
        <Link href={`/t/${team.name}/board`}>← Board</Link>
      </p>
      <Notice searchParams={searchParams} />
      <div className="grid">
        <section className="panel" aria-labelledby="new-task">
          <h2 id="new-task">{admin ? "Add a task" : "Suggest a task"}</h2>
          <TaskForm team={team.name} admin={admin} journeys={journeys} />
        </section>
        <section className="panel" aria-labelledby="triage">
          <h2 id="triage">
            Waiting for triage <span className="muted">{triage.length}</span>
          </h2>
          {triage.length ? (
            <ol className="plain lane-cards">
              {triage.slice(0, 12).map((card) => (
                <TaskCard key={card.task.id} base={`/t/${team.name}`} card={card} origin={origins.of(card.task)} />
              ))}
            </ol>
          ) : (
            <p className="empty">Nothing is waiting: the planner has triaged everything.</p>
          )}
          {triage.length > 12 ? (
            <p className="hint">
              and {triage.length - 12} more on the <Link href={`/t/${team.name}/board`}>board</Link>
            </p>
          ) : null}
        </section>
      </div>
    </>
  );
}
