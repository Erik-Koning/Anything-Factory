import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Chip, clip, Notice, type SearchParams } from "../../../../components/ui.tsx";
import { Verdict } from "../../../../components/verdict.tsx";
import { DIMENSIONS } from "../../../../../lib/tasks/model.ts";
import { can } from "../../../../server/access.ts";
import type { Task } from "../../../../server/factory.ts";
import { originsFor } from "../../../../server/origin.ts";
import { proposals } from "../../../../server/views.ts";
import { readAhead, tasksOf, teamFor } from "../team.ts";

export const metadata: Metadata = { title: "Decisions" };

const HEADINGS: Record<string, string> = {
  question: "Escalated to you",
  proposed: "Proposed",
  researching: "Being researched",
  triage: "In triage",
};

export default async function ProposalsPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  readAhead(name);
  const { viewer, team } = await teamFor(name);
  if (!can(viewer, "proposals:decide", team.name)) notFound();
  const [tasks, origins] = await Promise.all([tasksOf(team.name), originsFor(team.name, viewer)]);
  // Triage is the planner's to sort; an admin may decide one too (it's down, or it's spam), by the same rules.
  const waiting = [...proposals(tasks), ...tasks.filter((t) => t.status === "triage" && t.kind !== "journey" && t.kind !== "design")];
  const groups = Object.keys(HEADINGS)
    .map((status) => ({ status, tasks: waiting.filter((t) => t.status === status) }))
    .filter((g) => g.tasks.length);
  const approval = team.approval;
  return (
    <>
      <Notice searchParams={searchParams} />
      <p className="lede small">
        You decide as the operator, by the same rules as <code>a6g task approve</code>.{" "}
        {approval
          ? approval.mode === "operator"
            ? "This team's proposals all wait for you."
            : approval.mode === "full"
              ? "This team's approver decides on its own; what it escalates comes to you."
              : `This team's approver decides up to size ${approval.maxSize}; larger ones and what it escalates come to you.`
          : ""}
      </p>
      {groups.length ? (
        groups.map((g) => (
          <section key={g.status} className="panel" aria-labelledby={`h-${g.status}`}>
            <h2 id={`h-${g.status}`}>
              {HEADINGS[g.status]} <span className="muted">{g.tasks.length}</span>
            </h2>
            {g.status === "triage" ? (
              <p className="hint">The planner sorts these. Decide one yourself only when it can&apos;t wait for the planner.</p>
            ) : null}
            <ul className="plain rows">
              {g.tasks.map((t) => (
                <Proposal key={t.id} team={team.name} task={t} origin={origins.of(t, true)} />
              ))}
            </ul>
          </section>
        ))
      ) : (
        <div className="panel empty">
          <p>Nothing is waiting for a decision.</p>
          <p className="hint">
            The planner&apos;s proposals come here when they&apos;re yours to approve. What else needs you is in{" "}
            <Link href={`/t/${team.name}/inbox`}>Waiting on you</Link>.
          </p>
        </div>
      )}
    </>
  );
}

// What the move table asks before the operator approves (lib/tasks/model.ts, scored): new work is scored first; a finding
// with a severity needn't be. Said beside the key, which is shown but can't be pressed, rather than refused after.
const needsScore = (t: Task): boolean => t.kind !== "journey" && !t.score && (t.kind === "feature" || !t.severity);

// One proposal: what it is and why on the left, the decision on the right (one above the other on a narrow screen). Each
// field stands over the key it goes with, and no key here is the solid: a page of proposals has no one commit.
function Proposal({ team, task: t, origin }: { team: string; task: Task; origin: string }) {
  const last = t.notes.at(-1);
  return (
    <li id={`task-${t.id}`} className="to-decide">
      <div className="head">
        <span className="id">#{t.id}</span>
        <h3 className="title">
          <Link href={`/t/${team}/tasks/${t.id}`}>{t.title}</Link>
        </h3>
        <Chip>{t.status}</Chip>
        <Chip tone="">{t.kind}</Chip>
        {t.severity ? <Chip tone="">{t.severity}</Chip> : null}
        {t.priority !== null ? <Chip tone="">{`p${t.priority}`}</Chip> : null}
      </div>
      <div className="about">
        <p className="small muted">{origin}</p>
        {t.gate ? (
          <dl className="facts small">
            <dt>Who asked, why</dt>
            <dd>{t.gate.asked}</dd>
            <dt>Delete or simplify</dt>
            <dd>{t.gate.simplify}</dd>
            <dt>Simplest version</dt>
            <dd>{t.gate.simplest}</dd>
          </dl>
        ) : (
          <p className="small muted">No gate yet.</p>
        )}
        {t.score ? (
          <>
            <p className="small">
              <b>Score:</b> {t.score.why}{" "}
              <span className="muted">
                (confidence {t.score.confidence}, size {t.score.size})
              </span>
            </p>
            <ul className="score" aria-label="Score by dimension, 0 to 3">
              {DIMENSIONS.map((d) => (
                <li key={d}>
                  <span>{d}</span> <b>{t.score?.[d] ?? 0}</b>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="small muted">Not scored yet.</p>
        )}
        {t.body ? <p className="text small">{clip(t.body, 900)}</p> : null}
        {t.request ? (
          <p className="small">
            From request <Link href={`/t/${team}/requests/${t.request}`}>{t.request}</Link>
          </p>
        ) : null}
        {last ? (
          <p className="small muted">
            {last.by}: {clip(last.text, 400)}
          </p>
        ) : null}
      </div>
      <div className="decide">
        <div className="verdicts">
          {needsScore(t) ? (
            <div className="unapprovable">
              <button type="button" disabled aria-describedby={`unscored-${t.id}`}>{`Approve #${t.id}`}</button>
              <p id={`unscored-${t.id}`} className="hint">
                It needs a score before it can be approved: the planner scores it first.
              </p>
            </div>
          ) : (
            <Verdict team={team} id={t.id} seen={t.version} decision="approve" label="Approve" field="Note (optional)" required={false} />
          )}
          <Verdict team={team} id={t.id} seen={t.version} decision="reject" label="Reject" field="Why it's rejected" required className="reject" />
        </div>
        {/* A proposal is one of question, proposed and researching, so one of these is always open to it. */}
        <details className="more">
          <summary>{`Research or escalate #${t.id} instead`}</summary>
          <div className="verdicts">
            {t.status !== "researching" ? (
              <Verdict team={team} id={t.id} seen={t.version} decision="research" label="Research it" field="What to find out" required />
            ) : null}
            {t.status !== "question" ? (
              <Verdict team={team} id={t.id} seen={t.version} decision="escalate" label="Escalate" field="What has to be decided" required />
            ) : null}
          </div>
        </details>
      </div>
    </li>
  );
}
