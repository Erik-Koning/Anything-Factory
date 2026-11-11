import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DecidedItem } from "../../../../components/decided.tsx";
import { Notice, param, type SearchParams } from "../../../../components/ui.tsx";
import { checkIns } from "../../../../../lib/tasks/decisions.ts";
import { can } from "../../../../server/access.ts";
import { type Decided, decidedLog, readsAgreement } from "../../../../server/decided.ts";
import { controlsFor, decisionsFor, tasksOf, teamFor } from "../team.ts";

// One page for two readers: an admin's tab calls it Decided for you; a member reads the same log, decided for someone else.
export const metadata: Metadata = { title: "Decision log" };

// How many of what stands are shown until the rest is asked for.
const SHOWN = 30;
const DAYS = 30;

// The decision log: every question the team answered in the operator's place, with what it chose, why, and why it
// didn't ask. What's flagged and not reviewed comes first; an admin agrees with one or overturns it.
export default async function DecidedPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  if (!can(viewer, "decisions:read", team.name)) notFound();
  const review = can(viewer, "proposals:decide", team.name);
  const agreement = can(viewer, "team:control", team.name);
  const everything = param((await searchParams)["all"]) === "yes";
  const [decisions, controls, tasks] = await Promise.all([decisionsFor(team.name), controlsFor(team.name), tasksOf(team.name)]);
  const log = decidedLog(decisions, controls);
  const stats = checkIns(decisions, tasks, controls, new Date(Date.now() - DAYS * 86_400_000).toISOString());
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const standing = everything ? log.standing : log.standing.slice(0, SHOWN);
  const base = `/t/${team.name}`;
  const item = (d: Decided, folded = false) => (
    <DecidedItem key={d.record.id} team={team.name} d={d} titles={titles} review={review} agreement={agreement} folded={folded} />
  );
  return (
    <>
      <Notice searchParams={searchParams} />
      <p className="lede small">
        {review ? (
          <>
            Questions the team would otherwise have brought to you, and answered itself under your{" "}
            {agreement ? <Link href={`${base}/agreement`}>working agreement</Link> : "working agreement"}. Each says what it chose, what that follows from,
            and why you weren&apos;t asked. The flagged ones are the calls it thought you&apos;d want to see: agree, or overturn one and the planner undoes
            it.
          </>
        ) : (
          <>
            Questions the team answered itself instead of bringing them to the operator, under the operator&apos;s working agreement. Each says what it
            chose, what that follows from, and why it wasn&apos;t asked. The operator reviews the flagged ones.
          </>
        )}
      </p>
      {readsAgreement(team) ? null : (
        <p className="notice">
          This team&apos;s factory version doesn&apos;t keep a decision log yet. Once it&apos;s upgraded (<code>a6g upgrade {team.name}</code>, then{" "}
          <code>a6g rotate {team.name}</code>), what its planner decides in the operator&apos;s place shows up here.
        </p>
      )}
      {decisions.length ? (
        <section className="panel" aria-labelledby="check-ins">
          <h2 id="check-ins">The last {DAYS} days</h2>
          <ul className="counts">
            <li>
              <b>{stats.toReview}</b>
              <span className="small muted">To review now</span>
            </li>
            <li>
              <b>{stats.decided}</b>
              <span className="small muted">Decided by the team</span>
            </li>
            <li>
              <b>{stats.flagged}</b>
              <span className="small muted">Of those, flagged</span>
            </li>
            <li>
              <b>{stats.overturned}</b>
              <span className="small muted">Overturned</span>
            </li>
            <li>
              <b>{stats.asked}</b>
              <span className="small muted">Asked instead</span>
            </li>
          </ul>
        </section>
      ) : null}
      {log.toReview.length ? (
        <section className="panel" aria-labelledby="to-review">
          <h2 id="to-review">
            To review <span className="muted">{log.toReview.length}</span>
          </h2>
          <p className="hint">
            {review
              ? "The team went ahead on these, and thought you'd want to see them. Nothing waits on your review."
              : "The team went ahead on these, and flagged them for the operator. Nothing waits on the review."}
          </p>
          <ul className="plain rows">{log.toReview.map((d) => item(d))}</ul>
        </section>
      ) : null}
      {log.standing.length ? (
        <section className="panel" aria-labelledby="standing">
          <h2 id="standing">
            On the record <span className="muted">{log.standing.length}</span>
          </h2>
          <p className="hint">What stands: agreed with, or never flagged. Newest first.</p>
          <ul className="plain rows">{standing.map((d) => item(d, true))}</ul>
          {log.standing.length > standing.length ? (
            <p className="small">
              Showing the newest {standing.length}. <Link href={`${base}/decided?all=yes`}>Show all {log.standing.length}</Link>
            </p>
          ) : null}
        </section>
      ) : null}
      {log.overturned.length ? (
        <section className="panel" aria-labelledby="overturned">
          <h2 id="overturned">
            Overturned <span className="muted">{log.overturned.length}</span>
          </h2>
          <p className="hint">{review ? "What you said to do instead, and what the planner did about it." : "What the operator said to do instead."}</p>
          <ul className="plain rows">{log.overturned.map((d) => item(d))}</ul>
        </section>
      ) : null}
      {decisions.length === 0 && readsAgreement(team) ? (
        <div className="panel empty">
          <p>{review ? "Nothing has been decided for you yet." : "Nothing has been decided for the operator yet."}</p>
          <p className="hint">
            When the planner answers a question itself instead of bringing it to {review ? "you" : "the operator"}, it records it here: what it chose, why,
            and why it didn&apos;t ask.
          </p>
        </div>
      ) : null}
    </>
  );
}
