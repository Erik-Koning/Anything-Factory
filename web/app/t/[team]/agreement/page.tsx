import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { AgreementForm } from "../../../../components/agreement-form.tsx";
import { Ago, Chip, Notice, type SearchParams } from "../../../../components/ui.tsx";
import {
  CONFIDENCE_MEANS,
  contactWords,
  GRADES,
  type Grade,
  isReserved,
  LEVEL_MEANS,
  LEVELS,
  type Level,
  RESERVED,
  type Route,
  STAKES_MEAN,
  tableOf,
} from "../../../../../lib/tasks/agreement.ts";
import { calibrationHints, checkIns } from "../../../../../lib/tasks/decisions.ts";
import { can } from "../../../../server/access.ts";
import { agreementHistory, agreementPending, hintSays, messagesFields, readsAgreement, topicRows, toYou } from "../../../../server/decided.ts";
import { agreementOf } from "../../../../server/factory.ts";
import { askedBy } from "../../../../server/views.ts";
import { controlsFor, decisionsFor, tasksOf, teamFor } from "../team.ts";

export const metadata: Metadata = { title: "Agreement" };

const DAYS = 30;
// A level's table, as it's read: across, how sure the team is of what you'd choose, the surest first; down, what a
// wrong call would cost.
const ACROSS: readonly Grade[] = ["high", "medium", "low"];
const SURE: Record<Grade, string> = { high: "Sure", medium: "Likely", low: "Unsure" };
const COSTS: Record<Grade, string> = { low: "Low", medium: "Medium", high: "High" };
const DOES: Record<Route, string> = { ask: "asks", tell: "flags", decide: "decides" };

function Matrix({ level, inForce }: { level: Level; inForce: boolean }) {
  const table = tableOf(level);
  return (
    <div className={inForce ? "matrix-box in-force" : "matrix-box"}>
      <table className="figures matrix">
        <caption>
          <span className="title">{level}</span> {inForce ? <Chip tone="ok">in force</Chip> : null}
        </caption>
        <thead>
          <tr>
            <th scope="col">Stakes</th>
            {ACROSS.map((confidence) => (
              <th key={confidence} scope="col">
                {SURE[confidence]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {GRADES.map((stakes) => (
            <tr key={stakes}>
              <th scope="row">{COSTS[stakes]}</th>
              {ACROSS.map((confidence) => (
                <td key={confidence} data-route={table[stakes][confidence]}>
                  {DOES[table[stakes][confidence]]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The working agreement: how readily the team brings a question to the operator. What's in force, how the check-ins
// have gone, what each level does with a question, the form that changes it (with an authenticator code), and every
// earlier version. Admins only.
export default async function AgreementPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  if (!can(viewer, "team:control", team.name)) notFound();
  const [controls, decisions, tasks] = await Promise.all([controlsFor(team.name), decisionsFor(team.name), tasksOf(team.name)]);
  const { agreement, control } = agreementOf(controls);
  const reads = readsAgreement(team);
  const operator = team.operator ?? { technical: true };
  const rows = topicRows(agreement, operator);
  const asked = rows.filter((row) => !row.locked && row.setting === "ask").map((row) => row.topic);
  const never = rows.filter((row) => row.locked === "never" || (!row.locked && row.setting === "decide")).map((row) => row.topic);
  const history = agreementHistory(controls);
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const stats = checkIns(decisions, tasks, controls, since);
  // What the operator's own reviews and answers under the agreement in force suggest about it (since it was last
  // changed, within that time); nothing is changed for them.
  const hints = reads ? calibrationHints(decisions, tasks, controls, agreement, since, operator) : [];
  const base = `/t/${team.name}`;
  return (
    <>
      <Notice searchParams={searchParams} />
      <p className="lede small">
        How readily the team brings a question to you. By what a wrong call would cost and how sure it is of what you&apos;d choose, it asks you, decides
        and flags the call for your review, or decides and records it. Change it whenever the check-ins are too many, too few or about the wrong things.
      </p>
      <p className="lede small">
        It routes judgments, so two things stay as they are at every level. What only you know or hold (a key, an account, a fact about your business)
        still comes to you, as blocked work in Waiting on you. Who approves the planner&apos;s proposals is the team&apos;s own setting (
        <code>approval</code> in its <code>team.json</code>). How often a message may reach you can be set here too, in place of the team&apos;s own.
      </p>
      {reads ? null : (
        <p className="notice">
          This team&apos;s factory version doesn&apos;t read the agreement yet, and keeps no decision log. Upgrade it (<code>a6g upgrade {team.name}</code>
          , then <code>a6g rotate {team.name}</code>) and it can be set here.
        </p>
      )}
      <div className="grid">
        <section className="panel" aria-labelledby="in-force">
          <h2 id="in-force">In force</h2>
          <dl className="facts">
            <dt>Level</dt>
            <dd>
              <Chip tone="">{agreement.level}</Chip> <span className="small">The team {LEVEL_MEANS[agreement.level]}.</span>
            </dd>
            <dt>Always asked</dt>
            <dd>{asked.length ? asked.join(", ") : <span className="muted">nothing beyond what&apos;s always yours</span>}</dd>
            <dt>Never asked</dt>
            <dd>{never.length ? never.join(", ") : <span className="muted">nothing</span>}</dd>
            <dt>Always yours</dt>
            <dd>{RESERVED.join(", ")}</dd>
            <dt>Messages</dt>
            <dd>{agreement.contact ? contactWords(agreement.contact) : <span className="muted">as the team&apos;s own settings say</span>}</dd>
            <dt>Set</dt>
            <dd>
              {control ? (
                <>
                  by {askedBy(control.by)}, <Ago at={control.at} /> <span className="id">({control.id})</span>
                </>
              ) : (
                <span className="muted">Nobody has changed it: this is the default, which asks about a change of scope.</span>
              )}
            </dd>
          </dl>
          {agreementPending(team.status, control) ? (
            <p className="small">
              <Chip tone="caution">waiting for the team&apos;s Mac</Chip> Questions and decisions follow it already; the planner is told within a minute.
            </p>
          ) : null}
          <h3>Standing instructions</h3>
          {agreement.notes ? <p className="text instructions">{agreement.notes}</p> : <p className="muted small">None.</p>}
        </section>
        <section className="panel" aria-labelledby="check-ins">
          <h2 id="check-ins">The last {DAYS} days</h2>
          <ul className="counts">
            <li>
              <b>{stats.asked}</b>
              <span className="small muted">Asked of you</span>
            </li>
            <li>
              <b>{stats.decided}</b>
              <span className="small muted">Decided for you</span>
            </li>
            <li>
              <b>{stats.flagged}</b>
              <span className="small muted">Of those, flagged</span>
            </li>
            <li>
              <b>{stats.overturned}</b>
              <span className="small muted">Overturned</span>
            </li>
          </ul>
          <p className="small">
            {stats.toReview ? `${stats.toReview} flagged ${stats.toReview === 1 ? "call waits" : "calls wait"} for your review. ` : ""}
            <Link href={`${base}/decided`}>Read what was decided →</Link>
          </p>
        </section>
      </div>

      {hints.length ? (
        <section className="panel" aria-labelledby="hints">
          <h2 id="hints">
            What your reviews and answers suggest <span className="muted">{hints.length}</span>
          </h2>
          <p className="hint">
            From what you reviewed and answered under the agreement in force: since it was last changed, and at most the last {DAYS} days. Nothing changes
            until you change it <a href="#change">below</a>.
          </p>
          <ul className="plain rows hints">
            {hints.map((hint) => (
              <li key={`${hint.topic ?? "level"}-${hint.set}`}>
                <p>{hint.why}</p>
                <p className="suggests">
                  <b>{hintSays(hint)}</b>
                  <span className="muted small">
                    {" "}
                    · in the terminal:{" "}
                    <code>
                      a6g agreement {team.name} {hint.flag}
                    </code>
                  </span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="levels">
        <h2 id="levels">What each level does with a question</h2>
        <p className="hint">
          Down, what a wrong call would cost; across, how sure the team is of what you&apos;d choose. <b>asks</b>: you&apos;re asked, and the work it
          blocks waits. <b>flags</b>: the team decides, and puts the call in front of you to review. <b>decides</b>: the team decides, on the record.
        </p>
        <div className="matrices">
          {LEVELS.map((level) => (
            <Matrix key={level} level={level} inForce={level === agreement.level} />
          ))}
        </div>
        <div className="grid">
          <dl className="facts small">
            {GRADES.map((stakes) => (
              <Fragment key={stakes}>
                <dt>{COSTS[stakes]} stakes</dt>
                <dd>{toYou(STAKES_MEAN[stakes])}</dd>
              </Fragment>
            ))}
          </dl>
          <dl className="facts small">
            {ACROSS.map((confidence) => (
              <Fragment key={confidence}>
                <dt>{SURE[confidence]}</dt>
                <dd>{toYou(CONFIDENCE_MEANS[confidence])}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </section>

      {reads ? (
        <section className="panel" aria-labelledby="change">
          <h2 id="change">Change it</h2>
          <AgreementForm
            // Made again once a change is in force, so it starts from the agreement as it now is.
            key={control?.id ?? "default"}
            team={team.name}
            initial={{
              level: agreement.level,
              topics: Object.fromEntries(rows.filter((row) => !isReserved(row.topic)).map((row) => [row.topic, row.setting])),
              notes: agreement.notes,
              ...messagesFields(agreement.contact),
            }}
            never={rows.filter((row) => row.locked === "never").map((row) => row.topic)}
          />
        </section>
      ) : null}

      {history.length ? (
        <section className="panel" aria-labelledby="versions">
          <h2 id="versions">
            Every version <span className="muted">{history.length}</span>
          </h2>
          <p className="hint">Each change is kept, with who made it. A decision names the version it was made under.</p>
          <ul className="plain rows">
            {history.map((version) => (
              <li key={version.control.id} id={version.control.id}>
                <div className="head">
                  <span className="id">{version.control.id}</span>
                  <span className="title">{version.changes.length ? version.changes.join("; ") : "set again, unchanged"}</span>
                  <Chip tone="">{version.agreement.level}</Chip>
                  {version.current ? <Chip tone="ok">in force</Chip> : null}
                </div>
                <p className="small muted">
                  {askedBy(version.control.by)} · <Ago at={version.control.at} />
                </p>
                {version.agreement.notes ? (
                  <details className="more">
                    <summary>Its standing instructions</summary>
                    <p className="text small">{version.agreement.notes}</p>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
