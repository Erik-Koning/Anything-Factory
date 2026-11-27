import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ScoreBars } from "../../../../../components/score-bars.tsx";
import { Ago, Chip, Notice, type SearchParams } from "../../../../../components/ui.tsx";
import { awaitsStream, journeyDue, streamLabel } from "../../../../../../lib/tasks/model.ts";
import { can, TASK_ID } from "../../../../../server/access.ts";
import { storeFor, tasksFor } from "../../../../../server/factory.ts";
import { waitsOnOperator } from "../../../../../../lib/tasks/answer.ts";
import { originsFor } from "../../../../../server/origin.ts";
import { PROPOSALS } from "../../../../../server/views.ts";
import { teamFor } from "../../team.ts";

export const metadata: Metadata = { title: "Task" };

// One task, as a6g task show prints it: what it is, where it stands, who holds it, and its history.
export default async function TaskPage({ params, searchParams }: { params: Promise<{ team: string; id: string }>; searchParams: SearchParams }) {
  const { team: name, id } = await params;
  const { viewer, team } = await teamFor(name);
  if (!can(viewer, "team:board", team.name) || !TASK_ID.test(id)) notFound();
  const store = storeFor(team.name);
  const [task, tasks, origins] = await Promise.all([store.tasks.get(id), tasksFor(team.name), originsFor(team.name, viewer)]);
  if (!task) notFound();
  const admin = can(viewer, "proposals:decide", team.name);
  const decide = admin && (PROPOSALS.includes(task.status) || task.status === "triage") && task.kind !== "journey" && task.kind !== "design";
  const answer = admin && waitsOnOperator(task);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const base = `/t/${team.name}`;
  const ref = (tid: string) => (
    <Link href={`${base}/tasks/${tid}`}>
      #{tid} {byId.get(tid)?.title ?? "(gone)"}
    </Link>
  );
  const children = task.kind === "journey" ? tasks.filter((t) => t.parent === task.id) : [];
  const dependents = tasks.filter((t) => t.after.includes(task.id));
  const placed = Boolean(
    task.parent || task.after.length || dependents.length || task.request || task.claim || task.branch || task.area || task.files.length || task.approval
  );
  return (
    <>
      <p className="small">
        <Link className="way" href={`${base}/board`}>
          ← Board
        </Link>
        {task.status === "rejected" ? null : (
          <>
            {" "}
            · <Link href={`${base}/graph?at=${task.id}`}>In the graph</Link>
          </>
        )}
      </p>
      <Notice searchParams={searchParams} />
      <article className="panel" aria-labelledby="task-title">
        {/* The id inside the heading, so a long title wraps after it rather than leaving it on a line of its own. */}
        <div className="head">
          <h2 id="task-title" className="title">
            <span className="id">#{task.id}</span> {task.title}
          </h2>
          <Chip>{task.status}</Chip>
          <Chip tone="">{task.kind}</Chip>
          {task.severity ? <Chip tone={task.severity === "blocker" ? "warn" : ""}>{task.severity}</Chip> : null}
          {task.priority !== null ? <Chip tone="">{`priority ${task.priority}`}</Chip> : null}
          {journeyDue(task, tasks) ? <Chip tone="caution">due its verification</Chip> : null}
          {task.stream ? <Chip tone={awaitsStream(task) ? "caution" : ""}>{streamLabel(task)}</Chip> : null}
        </div>
        <p className="small muted">
          {origins.of(task, true)} · added <Ago at={task.createdAt} /> · updated <Ago at={task.updatedAt} />
        </p>
        {/* A thinking stream: why the work is worth one, then the concept once it's in. Its record stays on the team's machine. */}
        {task.stream ? (
          <p className="small">
            {awaitsStream(task) ? "Held for a thinking stream: nobody builds it until its concept is settled. " : "Built from a thinking stream. "}
            {task.stream.move ?? task.stream.why}
          </p>
        ) : null}
        {task.body ? <p className="text">{task.body}</p> : <p className="empty">No description.</p>}
        {answer || decide ? (
          <p className="inline">
            {answer ? (
              <Link className="button primary" href={`${base}/inbox#task-${task.id}`}>
                Answer #{task.id}
              </Link>
            ) : null}
            {decide ? (
              <Link className={answer ? "button" : "button primary"} href={`${base}/proposals#task-${task.id}`}>
                Decide on #{task.id}
              </Link>
            ) : null}
          </p>
        ) : null}
      </article>

      <div className="grid uneven">
        <section className="panel" aria-labelledby="where">
          <h2 id="where">Where it stands</h2>
          <dl className="facts small brief">
            {/* A task on its own: the three things it might have been placed by, each said as none. */}
            {placed || children.length ? null : (
              <>
                <dt>Journey</dt>
                <dd className="muted">none</dd>
                <dt>Comes after</dt>
                <dd className="muted">no other task</dd>
                <dt>Held by</dt>
                <dd className="muted">nobody yet</dd>
              </>
            )}
            {task.parent ? (
              <>
                <dt>Journey</dt>
                <dd>{ref(task.parent)}</dd>
              </>
            ) : null}
            {task.after.length ? (
              <>
                <dt>Comes after</dt>
                <dd>
                  {task.after.map((tid, i) => (
                    <span key={tid}>
                      {i ? ", " : ""}
                      {ref(tid)} {byId.get(tid) ? <Chip>{byId.get(tid)?.status ?? ""}</Chip> : null}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
            {dependents.length ? (
              <>
                <dt>Before</dt>
                <dd>
                  {dependents.map((t, i) => (
                    <span key={t.id}>
                      {i ? ", " : ""}
                      {ref(t.id)}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
            {task.request ? (
              <>
                <dt>Request</dt>
                <dd>
                  <Link href={`${base}/requests/${task.request}`}>{task.request}</Link>
                </dd>
              </>
            ) : null}
            {task.claim ? (
              <>
                <dt>Held by</dt>
                <dd>
                  the {task.claim.role} on {task.claim.machine}, since <Ago at={task.claim.at} />
                </dd>
              </>
            ) : null}
            {task.branch ? (
              <>
                <dt>Branch</dt>
                <dd>
                  <code>{`${task.branch}${task.sha ? ` @ ${task.sha.slice(0, 9)}` : ""}`}</code>
                </dd>
              </>
            ) : null}
            {task.rounds ? (
              <>
                <dt>Review</dt>
                <dd>{`${task.rounds} round${task.rounds === 1 ? "" : "s"} of changes`}</dd>
              </>
            ) : null}
            {task.risk ? (
              <>
                <dt>Risk</dt>
                <dd>{task.risk}</dd>
              </>
            ) : null}
            {task.area || task.files.length ? (
              <>
                <dt>Lands in</dt>
                <dd>{[task.area, ...task.files].filter(Boolean).join(", ")}</dd>
              </>
            ) : null}
            {task.approval ? (
              <>
                <dt>Approved</dt>
                <dd>
                  by the {task.approval.by}, <Ago at={task.approval.at} />
                  {task.approval.note ? `: ${task.approval.note}` : ""}
                </dd>
              </>
            ) : null}
          </dl>
          {children.length ? (
            <>
              <h3>Its tasks</h3>
              <ul className="plain small">
                {children.map((t) => (
                  <li key={t.id}>
                    {ref(t.id)} <Chip>{t.status}</Chip>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <section className="panel" aria-labelledby="case">
          <h2 id="case">The case for it</h2>
          {task.gate?.headline ? (
            <p>
              <b>Asks you:</b> {task.gate.headline}
            </p>
          ) : null}
          {task.gate ? (
            <dl className="facts small">
              <dt>Who asked, why</dt>
              <dd>{task.gate.asked}</dd>
              <dt>Delete or simplify</dt>
              <dd>{task.gate.simplify}</dd>
              <dt>Simplest version</dt>
              <dd>{task.gate.simplest}</dd>
            </dl>
          ) : task.score ? (
            <p className="small muted">Who asked for it, what could be dropped or made simpler, and its simplest version aren&apos;t written yet.</p>
          ) : (
            // Neither yet: one line for both, saying what the planner writes.
            <p className="small muted">
              Not made yet. The planner writes who asked for it and why, what could be dropped or made simpler, and its simplest version, then scores it.
            </p>
          )}
          {task.score ? (
            <>
              <p className="small">
                <b>Score:</b> {task.score.why}{" "}
                <span className="muted">
                  (confidence {task.score.confidence}, size {task.score.size})
                </span>
              </p>
              <ScoreBars score={task.score} />
            </>
          ) : task.gate ? (
            <p className="small muted">Not scored yet.</p>
          ) : null}
        </section>
      </div>

      <section className="panel" aria-labelledby="notes">
        <h2 id="notes">Notes and history</h2>
        {task.notes.length ? (
          <ul className="plain rows">
            {task.notes.map((n, i) => (
              <li key={`n${i}`}>
                <p className="small muted">
                  {n.by}
                  {n.kind === "answer" ? " (answer)" : ""} · <Ago at={n.at} />
                </p>
                <p className="text">{n.text}</p>
              </li>
            ))}
          </ul>
        ) : null}
        <details open={!task.notes.length}>
          <summary>History</summary>
          <ul className="plain small">
            {task.history
              .slice(-30)
              .reverse()
              .map((e, i) => (
                <li key={`h${i}`}>
                  <Ago at={e.at} /> · {e.by}: {origins.history(e.what)}
                </li>
              ))}
          </ul>
        </details>
      </section>
    </>
  );
}
