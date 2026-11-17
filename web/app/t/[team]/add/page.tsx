import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { TaskCard } from "../../../../components/task-card.tsx";
import { Notice, type SearchParams } from "../../../../components/ui.tsx";
import { can } from "../../../../server/access.ts";
import { originsFor } from "../../../../server/origin.ts";
import { kanban } from "../../../../server/views.ts";
import { readAhead, tasksOf, teamFor } from "../team.ts";
import { TaskForm } from "./task-form.tsx";

export const metadata: Metadata = { title: "Add a task" };

export default async function AddTaskPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  readAhead(name);
  const { viewer, team } = await teamFor(name);
  const admin = can(viewer, "tasks:add", team.name);
  if (!admin && !can(viewer, "tasks:suggest", team.name)) notFound();
  const [tasks, origins] = await Promise.all([tasksOf(team.name), originsFor(team.name, viewer)]);
  const journeys = tasks.filter((t) => t.kind === "journey" && t.status !== "done" && t.status !== "rejected").map((t) => ({ id: t.id, title: t.title }));
  const triage = kanban(tasks).columns.find((c) => c.lane === "triage")?.cards ?? [];
  return (
    <>
      <p className="small">
        <Link className="way" href={`/t/${team.name}/board`}>
          ← Board
        </Link>
      </p>
      <Notice searchParams={searchParams} />
      <div className="add-layout">
        <section className="panel" aria-labelledby="new-task">
          <h2 id="new-task">{admin ? "Add a task" : "Suggest a task"}</h2>
          <TaskForm team={team.name} admin={admin} journeys={journeys} />
        </section>
        {/* Beside the form: what happens to the task once it's in, then what already waits for the planner to sort. */}
        <aside className="panel add-side" aria-labelledby="what-happens">
          <h2 id="what-happens">What happens to it</h2>
          <ol className="plain timeline">
            {admin ? (
              <>
                <li>
                  <span>It goes in as your proposal, unless you approve it now.</span>
                </li>
                <li>
                  <span>The planner scores it; the approver or you decide on it, in Decisions.</span>
                </li>
                <li>
                  <span>Approved, a member builds it once what it comes after is done.</span>
                </li>
              </>
            ) : (
              <>
                <li>
                  <span>It waits for triage, below.</span>
                </li>
                <li>
                  <span>The planner reads it, then proposes it, folds it into other work or turns it down.</span>
                </li>
                <li>
                  <span>A proposal is decided on, then built. Its page says how it&apos;s going.</span>
                </li>
              </>
            )}
          </ol>
          <section className="triage" aria-labelledby="triage">
            <h3 id="triage">
              Waiting for triage <span className="count">{triage.length}</span>
            </h3>
            {triage.length ? (
              <ol className="plain lane-cards">
                {triage.slice(0, 12).map((card) => (
                  <TaskCard key={card.task.id} base={`/t/${team.name}`} card={card} origin={origins.of(card.task)} />
                ))}
              </ol>
            ) : (
              <p className="small muted">Nothing: the planner has sorted every suggestion and finding.</p>
            )}
            {triage.length > 12 ? (
              <p className="hint">
                and {triage.length - 12} more on the <Link href={`/t/${team.name}/board`}>board</Link>
              </p>
            ) : null}
          </section>
        </aside>
      </div>
    </>
  );
}
