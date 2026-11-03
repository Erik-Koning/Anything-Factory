// A task as a card on the board: what it is, where it came from, and what its column says about it (who holds it,
// what it waits for, when it merged). Server-only, like ui.tsx.
import Link from "next/link";
import type { Card } from "../server/views.ts";
import { Ago, Chip } from "./ui.tsx";

export function TaskCard({
  base,
  card,
  origin,
  journey,
}: {
  base: string;
  card: Card;
  origin: string;
  journey?: { id: string; title: string } | undefined;
}) {
  const { task: t, lapsed, waits, since } = card;
  return (
    <li className={`card status-${t.status}${lapsed ? " lapsed" : ""}`}>
      <Link className="card-title" href={`${base}/tasks/${t.id}`}>
        <span className="id">#{t.id}</span> {t.title}
      </Link>
      <div className="chips">
        {t.status === "question" ? <Chip tone="warn">escalated</Chip> : null}
        {t.status === "researching" ? <Chip tone="caution">researching</Chip> : null}
        <Chip tone="">{t.kind}</Chip>
        {t.severity ? <Chip tone={t.severity === "blocker" ? "warn" : ""}>{t.severity}</Chip> : null}
        {t.priority !== null ? <Chip tone="">{`p${t.priority}`}</Chip> : null}
      </div>
      {t.status === "building" && t.claim ? (
        <p className="meta">
          <span className="claim">
            {t.claim.role} on {t.claim.machine}
          </span>{" "}
          · {lapsed ? <Chip tone="warn">lease ran out</Chip> : <Lease until={t.claim.until} />}
        </p>
      ) : null}
      {t.status === "review" ? (
        <p className="meta">
          {t.branch ? (
            <code className="branch" title={`${t.branch}${t.sha ? ` @ ${t.sha}` : ""}`}>
              {t.branch}
            </code>
          ) : (
            "no branch"
          )}
          {t.sha ? <span className="muted">{` @ ${t.sha.slice(0, 7)}`}</span> : null}
          {t.rounds ? ` · ${t.rounds} round${t.rounds === 1 ? "" : "s"} of changes` : ""}
        </p>
      ) : null}
      {waits.length && t.status !== "done" ? (
        <p className="meta">
          waits for{" "}
          {waits.map((w, i) => (
            <span key={w.id}>
              {i ? ", " : ""}
              <Link href={`${base}/tasks/${w.id}`}>#{w.id}</Link> ({w.status})
            </span>
          ))}
        </p>
      ) : null}
      {journey ? (
        <p className="meta">
          in <Link href={`${base}/tasks/${journey.id}`}>{journey.title}</Link>
        </p>
      ) : null}
      <p className="meta">
        {origin} · {t.status === "done" ? "done " : t.status === "building" ? "claimed " : ""}
        <Ago at={t.status === "triage" ? t.createdAt : since} />
      </p>
    </li>
  );
}

// How long a member's claim lasts: its heartbeats renew it; once it runs out, the watchdog hands the task back.
function Lease({ until }: { until: string }) {
  const minutes = Math.max(1, Math.round((Date.parse(until) - Date.now()) / 60_000));
  return <span title={new Date(until).toUTCString()}>lease {minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} left</span>;
}
