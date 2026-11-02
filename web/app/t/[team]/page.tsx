import type { Metadata } from "next";
import Link from "next/link";
import { TaskGraph } from "../../../components/task-graph.tsx";
import { SpendPanel } from "../../../components/spend-panel.tsx";
import { TeamControls } from "../../../components/team-controls.tsx";
import { Ago, Chip, Notice, type SearchParams } from "../../../components/ui.tsx";
import { can } from "../../../server/access.ts";
import { controlsOf, limitsOf, storeFor, usageOf } from "../../../server/factory.ts";
import { journeys, merges, progress } from "../../../server/views.ts";
import { teamFor } from "./team.ts";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  const store = storeFor(team.name);
  const control = can(viewer, "team:control", team.name);
  const [tasks, cycles, controls] = await Promise.all([
    store.tasks.all(),
    team.mode === "cycles" ? store.cycles.all() : Promise.resolve([]),
    control ? controlsOf(team.name) : Promise.resolve([]),
  ]);
  const limits = limitsOf(controls);
  // Every day counted since the budget began (or ever), and at least the chart's last 14.
  const from = limits ? [limits.since.slice(0, 10), new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10)].sort()[0] : undefined;
  const usage = control ? await usageOf(team.name, from ?? "0000-00-00") : [];
  const status = team.status;
  const atWork = status ? Object.entries(status.members).filter(([, n]) => n > 0) : [];
  const details = can(viewer, "team:board", team.name);
  const shownJourneys = journeys(tasks);
  return (
    <>
      <Notice searchParams={searchParams} />
      <div className="grid">
        <section className="panel" aria-labelledby="status">
          <h2 id="status">Status</h2>
          <dl className="facts">
            <dt>State</dt>
            <dd>
              <Chip>{status?.state ?? "no status yet"}</Chip>
            </dd>
            <dt>Planner</dt>
            <dd>{status?.planner ?? "not running"}</dd>
            <dt>At work</dt>
            <dd>{atWork.length ? atWork.map(([role, n]) => `${n} ${role}${n === 1 ? "" : "s"}`).join(", ") : "nobody"}</dd>
            <dt>Aim</dt>
            <dd>{team.mode === "cycles" ? `cycles: cycle ${cycles.length + 1}${cycles.length ? `, ${cycles.length} closed` : ""}` : "its finish line"}</dd>
            <dt>Updated</dt>
            <dd>
              <Ago at={status?.at} />
            </dd>
          </dl>
        </section>
        <section className="panel" aria-labelledby="progress">
          <h2 id="progress">Progress</h2>
          <ul className="counts">
            {progress(tasks).map(({ label, count }) => (
              <li key={label}>
                <b>{count}</b>
                <span className="small muted">{label}</span>
              </li>
            ))}
          </ul>
          {details ? (
            <p className="small">
              <Link href={`/t/${team.name}/board`}>Open the board →</Link>
            </p>
          ) : null}
        </section>
      </div>

      {control ? <TeamControls team={team} controls={controls} tasks={tasks} /> : null}
      {control ? <SpendPanel team={team.name} spend={team.status?.spend ?? null} usage={usage} limits={limits} tasks={tasks} /> : null}

      <section className="panel" aria-labelledby="journeys">
        <h2 id="journeys">Journeys</h2>
        {shownJourneys.length ? (
          <ul className="plain rows">
            {shownJourneys.map((j) => (
              <li key={j.id}>
                <div className="head">
                  <span className="id">#{j.id}</span>
                  {details ? (
                    <Link className="title" href={`/t/${team.name}/tasks/${j.id}`}>
                      {j.title}
                    </Link>
                  ) : (
                    <span className="title">{j.title}</span>
                  )}
                  <Chip>{j.status}</Chip>
                  {j.due ? <Chip tone="caution">due its verification</Chip> : null}
                </div>
                <p className="small muted">
                  {j.done} of {j.total} task{j.total === 1 ? "" : "s"} done
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No journeys yet.</p>
        )}
      </section>

      {details ? (
        <>
          <section className="panel" aria-labelledby="graph">
            <h2 id="graph">Graph</h2>
            <TaskGraph tasks={tasks} />
          </section>
          <section className="panel" aria-labelledby="merges">
            <h2 id="merges">Recent merges</h2>
            {merges(tasks).length ? (
              <ul className="plain rows">
                {merges(tasks).map(({ task, at }) => (
                  <li key={task.id}>
                    <span className="id">#{task.id}</span> <Link href={`/t/${team.name}/tasks/${task.id}`}>{task.title}</Link>{" "}
                    <span className="muted small">
                      · <Ago at={at} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">Nothing merged yet.</p>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
