import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Ago, Chip, Notice, type SearchParams } from "../../../../../components/ui.tsx";
import { can, canSeeRequest, REQUEST_ID, senderLabel } from "../../../../../server/access.ts";
import { linkedStakeholder, storeFor, tasksFor } from "../../../../../server/factory.ts";
import { rejectionOf, requestState } from "../../../../../server/views.ts";
import { teamFor } from "../../team.ts";

export const metadata: Metadata = { title: "Request" };

export default async function RequestPage({ params, searchParams }: { params: Promise<{ team: string; id: string }>; searchParams: SearchParams }) {
  const { team: name, id } = await params;
  const { viewer, team } = await teamFor(name);
  if (!REQUEST_ID.test(id)) notFound();
  const store = storeFor(team.name);
  const [request, own] = await Promise.all([store.requests.get(id), linkedStakeholder(team.name, viewer.userId)]);
  const ownId = own?.id ?? null;
  // Someone else's request is as missing as one that isn't there.
  if (!request || !canSeeRequest(viewer, team.name, request, ownId)) notFound();
  const [sender, tasks] = await Promise.all([request.from ? store.stakeholders.get(request.from) : null, tasksFor(team.name)]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const became = request.tasks.map((tid) => ({ id: tid, task: byId.get(tid) ?? null }));
  const rejection = rejectionOf(request);
  return (
    <>
      <p className="small">
        <Link href={`/t/${team.name}/requests`}>← Requests</Link>
      </p>
      <Notice searchParams={searchParams} />
      <article className="panel" aria-labelledby="request-title">
        {/* The id inside the heading, so a long title wraps after it rather than leaving it on a line of its own. */}
        <div className="head">
          <h2 id="request-title" className="title">
            <span className="id">{request.id}</span> {request.title}
          </h2>
          <Chip>{requestState(request, byId)}</Chip>
        </div>
        <p className="small muted">
          from {senderLabel(viewer, team.name, sender, ownId)} · sent <Ago at={request.createdAt} /> · updated <Ago at={request.updatedAt} />
        </p>
        {request.body ? <p className="text">{request.body}</p> : <p className="empty">No description.</p>}
        {/* Why the planner turned it down, under what was asked. */}
        {rejection ? (
          <section className="turned-down" aria-labelledby="rejected">
            <h3 id="rejected">Why it was turned down</h3>
            <p className="text">{rejection}</p>
          </section>
        ) : null}
      </article>

      <div className="grid uneven">
        {/* A request turned down became nothing: its notes and history have the room. */}
        {rejection && !became.length ? null : (
          <section className="panel" aria-labelledby="tasks">
            <h2 id="tasks">The tasks it became</h2>
            {became.length ? (
              <ul className="plain rows">
                {became.map(({ id: tid, task }) => (
                  <li key={tid} className="head">
                    <span className="id">#{tid}</span>
                    {task && can(viewer, "team:board", team.name) ? (
                      <Link href={`/t/${team.name}/tasks/${tid}`}>{task.title}</Link>
                    ) : (
                      <span>{task?.title ?? "(gone)"}</span>
                    )}
                    {task ? <Chip>{task.status}</Chip> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">{request.status === "rejected" ? "None." : "None yet: the planner turns a request into tasks once it's researched."}</p>
            )}
          </section>
        )}
        <section className="panel" aria-labelledby="notes">
          <h2 id="notes">Notes and history</h2>
          {request.notes.length ? (
            <ul className="plain rows">
              {request.notes.map((n, i) => (
                <li key={`n${i}`}>
                  <p className="small muted">
                    {n.by} · <Ago at={n.at} />
                  </p>
                  <p className="text">{n.text}</p>
                </li>
              ))}
            </ul>
          ) : null}
          {/* Open when there are no notes above it: then it's all the panel holds. */}
          <details open={!request.notes.length}>
            <summary>History</summary>
            <ul className="plain small">
              {request.history.map((e, i) => (
                <li key={`h${i}`}>
                  <Ago at={e.at} /> · {e.by}: {e.what}
                </li>
              ))}
            </ul>
          </details>
        </section>
      </div>
    </>
  );
}
