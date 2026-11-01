import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TaskCard } from "../../../../components/task-card.tsx";
import { Ago, Notice, param, type SearchParams } from "../../../../components/ui.tsx";
import { can } from "../../../../server/access.ts";
import { storeFor } from "../../../../server/factory.ts";
import { originsFor } from "../../../../server/origin.ts";
import { kanban } from "../../../../server/views.ts";
import { teamFor } from "../team.ts";

export const metadata: Metadata = { title: "Board" };

// The team's work as a board: a column per step, left to right, each card saying who it came from and what its column
// says about it. It shows; the moves stay the team's (claims, reviews, the merge queue) and the Decisions page's.
export default async function BoardPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  if (!can(viewer, "team:board", team.name)) notFound();
  const [tasks, origins] = await Promise.all([storeFor(team.name).tasks.all(), originsFor(team.name, viewer)]);
  const journeys = new Map(tasks.filter((t) => t.kind === "journey").map((t) => [t.id, { id: t.id, title: t.title }]));
  // ?done=all shows every done task, and a lane of the rejected ones.
  const everything = param((await searchParams)["done"]) === "all";
  const { columns, rejected } = kanban(tasks, { doneLimit: everything ? Infinity : 8, rejected: everything });
  const empty = !rejected && columns.every((c) => !c.cards.length && !c.more);
  const base = `/t/${team.name}`;
  const adds = can(viewer, "tasks:add", team.name) ? "Add a task" : can(viewer, "tasks:suggest", team.name) ? "Suggest a task" : null;
  const atWork = team.status ? Object.entries(team.status.members).filter(([, n]) => n > 0) : [];
  return (
    <>
      <Notice searchParams={searchParams} />
      <div className="board-bar">
        <p className="lede small">
          {atWork.length ? `At work: ${atWork.map(([role, n]) => `${n} ${role}${n === 1 ? "" : "s"}`).join(", ")}. ` : "Nobody is at work. "}
          Planner: {team.status?.planner ?? "not running"}. Updated <Ago at={team.status?.at} />.
        </p>
        {adds ? (
          <Link className="button primary" href={`${base}/add`}>
            <span aria-hidden="true">+ </span>
            {adds}
          </Link>
        ) : null}
      </div>
      {empty ? (
        <p className="panel empty">
          No tasks yet. The planner adds work as it plans{adds ? `, and you can ${adds === "Add a task" ? "add" : "suggest"} some now` : ""}.
        </p>
      ) : (
        <div className="kanban" role="region" aria-label="The board (scrolls sideways)" tabIndex={0}>
          {columns.map((c) => (
            <section key={c.lane} className={`lane lane-${c.lane}`} aria-label={c.label}>
              <header>
                <h2>
                  {c.label} <span className="count">{c.cards.length + c.more}</span>
                </h2>
                <p className="hint">{c.hint}</p>
              </header>
              {c.cards.length ? (
                <ol className="plain">
                  {c.cards.map((card) => (
                    <TaskCard
                      key={card.task.id}
                      base={base}
                      card={card}
                      origin={origins.of(card.task)}
                      journey={card.task.parent ? journeys.get(card.task.parent) : undefined}
                    />
                  ))}
                </ol>
              ) : (
                <p className="empty small">Nothing here.</p>
              )}
              {c.lane === "done" && (c.more || rejected) ? (
                <p className="hint">
                  {[c.more ? `${c.more} more done` : null, rejected ? `${rejected} rejected` : null].filter(Boolean).join(", ")}:{" "}
                  <Link href={`${base}/board?done=all`}>show them</Link>
                </p>
              ) : null}
              {c.lane === "rejected" ? (
                <p className="hint">
                  <Link href={`${base}/board`}>Show only the newest done</Link>
                </p>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
