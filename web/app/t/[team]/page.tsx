import type { Metadata } from "next";
import Link from "next/link";
import { TaskGraph } from "../../../components/task-graph.tsx";
import { SpendPanel } from "../../../components/spend-panel.tsx";
import { SitePanel } from "../../../components/site-panel.tsx";
import { SubscriptionsPanel } from "../../../components/subscriptions-panel.tsx";
import { TeamControls } from "../../../components/team-controls.tsx";
import { Ago, Chip, Notice, param, type SearchParams } from "../../../components/ui.tsx";
import { can } from "../../../server/access.ts";
import { limitsOf, retiredOf, storeFor, usageOf } from "../../../server/factory.ts";
import { waitingCount } from "../../../server/inbox.ts";
import { journeys, merges, offSite, progress } from "../../../server/views.ts";
import { controlsFor, readAhead, tasksOf, teamFor } from "./team.ts";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  readAhead(name, "controls");
  // Which form a refused control reopens (actions.ts).
  const open = param((await searchParams)["open"]);
  const { viewer, team } = await teamFor(name);
  const control = can(viewer, "team:control", team.name);
  const [tasks, cycles, controls] = await Promise.all([
    tasksOf(team.name),
    team.mode === "cycles" ? storeFor(team.name).cycles.all() : Promise.resolve([]),
    control ? controlsFor(team.name) : Promise.resolve([]),
  ]);
  const limits = limitsOf(controls);
  // Every day counted since the budget began (or ever), and at least the chart's last 14.
  const from = limits ? [limits.since.slice(0, 10), new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10)].sort()[0] : undefined;
  const usage = control ? await usageOf(team.name, from ?? "0000-00-00") : [];
  const status = team.status;
  const atWork = status ? Object.entries(status.members).filter(([, n]) => n > 0) : [];
  const details = can(viewer, "team:board", team.name);
  const shownJourneys = journeys(tasks);
  const waiting = can(viewer, "proposals:decide", team.name) ? waitingCount(tasks) : 0;
  const retire = can(viewer, "team:retire", team.name);
  // What wakes an idle or finished team: new work, from whoever may give it some.
  const adds = can(viewer, "tasks:add", team.name) ? "add a task" : can(viewer, "tasks:suggest", team.name) ? "suggest a task" : null;
  const asks = can(viewer, "requests:send", team.name);
  const wake =
    adds || asks ? (
      <>
        {adds ? <Link href={`/t/${team.name}/add`}>{adds.replace(/^./, (c) => c.toUpperCase())}</Link> : null}
        {adds && asks ? " or " : null}
        {asks ? <Link href={`/t/${team.name}/requests`}>{adds ? "send a request" : "Send a request"}</Link> : null}.
      </>
    ) : null;
  // A journey's title opens its page for those who may see the board.
  const journeysPanel = (
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
        <p className="empty">
          No journeys yet. The planner groups work into journeys as it plans, each one verified once its tasks are done
          {can(viewer, "tasks:add", team.name) ? (
            <>
              ; you can <Link href={`/t/${team.name}/add`}>add one</Link> too
            </>
          ) : null}
          .
        </p>
      )}
    </section>
  );
  return (
    <>
      <Notice searchParams={searchParams} />
      {waiting ? (
        <div className="notice attention inline">
          <span>
            <b>{waiting === 1 ? "One thing is" : `${waiting} things are`} waiting on you.</b> The team goes on with everything else, and settles{" "}
            {waiting === 1 ? "it" : "them"} once you answer.
          </span>
          <Link className="button primary" href={`/t/${team.name}/inbox`}>
            {waiting === 1 ? "Answer it" : "Answer them"}
          </Link>
        </div>
      ) : null}
      <div className="grid lead">
        <section className="panel" aria-labelledby="status">
          <h2 id="status">Status</h2>
          {/* Its state is the chip beside its name; a team with nothing to do says what starts it again. */}
          {status?.state === "idle" ? (
            <p className="small state-note">
              <b>Idle:</b> it has built what it had, and waits for new work to wake it. {wake}
            </p>
          ) : status?.state === "complete" ? (
            <p className="small state-note">
              <b>Complete:</b> its finish line holds, and it checks it nightly; new work starts it again. {wake}
            </p>
          ) : null}
          <dl className="facts brief">
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

      {/* The work: its journeys and what merged lately, beside the graph, which takes the width its drawing needs. */}
      {details ? (
        <div className="work">
          <div className="work-side">
            {journeysPanel}
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
                <p className="empty">
                  Nothing merged yet. Work shows here once it&apos;s built, reviewed and merged; the <Link href={`/t/${team.name}/board`}>board</Link> has
                  what&apos;s under way.
                </p>
              )}
            </section>
          </div>
          <section className="panel" aria-labelledby="graph">
            <h2 id="graph">Graph</h2>
            <TaskGraph tasks={tasks} />
            <p className="small">
              <Link href={`/t/${team.name}/graph`}>Open it by level →</Link>
            </p>
          </section>
        </div>
      ) : (
        journeysPanel
      )}

      {/* Under the work, for its admins: how the team runs (a row each for its controls, its subscriptions and its place
          on the site), then what it spent. */}
      {control || retire ? (
        <section className="panel runs" aria-labelledby="runs">
          <h2 id="runs">How it runs</h2>
          {control ? <TeamControls team={team} controls={controls} /> : null}
          {control ? <SubscriptionsPanel team={team} controls={controls} open={open === "subscriptions"} /> : null}
          {retire ? <SitePanel team={team} retired={offSite(team, retiredOf(controls))} expanded={open === "site"} /> : null}
        </section>
      ) : null}
      {control ? (
        <SpendPanel team={team.name} spend={team.status?.spend ?? null} usage={usage} limits={limits} tasks={tasks} open={open === "budget"} />
      ) : null}
    </>
  );
}
