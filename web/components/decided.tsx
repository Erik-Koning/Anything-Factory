// One decision the team made in the operator's place, from server/decided.ts: the question, what it chose and what
// that follows from, what was weighed, how it's undone, its tasks, and why the operator wasn't asked; then the review,
// if there is one, and for those who review, the forms. The forms write through the team's server actions.
import Link from "next/link";
import type { ReactNode } from "react";
import { reviewAction } from "../app/t/[team]/actions.ts";
import { LIMITS } from "../server/access.ts";
import { type Decided, underAgreement } from "../server/decided.ts";
import { SubmitButton } from "./submit-button.tsx";
import { Ago, Chip } from "./ui.tsx";

// One review of a decision, with its words: agreeing may say why, overturning says what to do instead.
function Review({ team, id, verdict }: { team: string; id: string; verdict: "agreed" | "overturned" }) {
  const input = `${verdict}-${id}`;
  const overturn = verdict === "overturned";
  return (
    <form action={reviewAction}>
      <input type="hidden" name="team" value={team} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="verdict" value={verdict} />
      <label htmlFor={input}>{overturn ? "What to do instead" : "Note (optional)"}</label>
      <input id={input} name="note" required={overturn} maxLength={LIMITS.note} autoComplete="off" />
      <div>
        <SubmitButton className={overturn ? "reject" : "approve"}>{overturn ? `Overturn ${id}` : `Agree with ${id}`}</SubmitButton>
      </div>
    </form>
  );
}

export function DecidedItem({
  team,
  d,
  titles,
  review,
  agreement,
  folded = false,
}: {
  team: string;
  d: Decided;
  // The team's tasks' titles, by id, for the tasks a decision names.
  titles: ReadonlyMap<string, string>;
  // The viewer reviews (an admin, as the operator): "you" is them, and the forms are theirs.
  review: boolean;
  // The viewer may open the agreement.
  agreement: boolean;
  // The review's forms behind a line to open: for what was never flagged.
  folded?: boolean;
}) {
  const r = d.record;
  const base = `/t/${team}`;
  const who = review ? "You" : "The operator";
  const under = underAgreement(r.agreement);
  const overturned = d.review?.verdict === "overturned";
  const forms: ReactNode =
    !review || overturned ? null : d.review ? (
      <details className="more">
        <summary>{`Overturn ${r.id} after all`}</summary>
        <div className="verdicts">
          <Review team={team} id={r.id} verdict="overturned" />
        </div>
      </details>
    ) : folded ? (
      <details className="more">
        <summary>{`Review ${r.id}`}</summary>
        <div className="verdicts">
          <Review team={team} id={r.id} verdict="agreed" />
          <Review team={team} id={r.id} verdict="overturned" />
        </div>
      </details>
    ) : (
      <div className="verdicts">
        <Review team={team} id={r.id} verdict="agreed" />
        <Review team={team} id={r.id} verdict="overturned" />
      </div>
    );
  return (
    <li id={r.id} className="decided">
      <div className="head">
        <span className="id">{r.id}</span>
        <h3 className="title">{r.question}</h3>
        <Chip tone="">{r.topic}</Chip>
        {d.flagged ? <Chip tone="caution">flagged</Chip> : null}
        {d.review ? <Chip tone={overturned ? "warn" : "ok"}>{d.review.verdict}</Chip> : null}
      </div>
      <p className="small muted">
        Decided by the {r.by} <Ago at={r.at} /> · {r.stakes} stakes, {r.confidence} confidence
      </p>
      <dl className="raised ruling">
        <div className="chose">
          <dt>The team decided</dt>
          <dd>{r.decision}</dd>
        </div>
        <div className="because">
          <dt>Because</dt>
          <dd>{r.because}</dd>
        </div>
      </dl>
      <dl className="facts small">
        {r.options.length ? (
          <>
            <dt>Weighed</dt>
            <dd>
              <ul className="weighed">
                {r.options.map((option) => (
                  <li key={option}>{option}</li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {r.undo ? (
          <>
            <dt>To undo</dt>
            <dd>{r.undo}</dd>
          </>
        ) : null}
        {r.tasks.length ? (
          <>
            <dt>Tasks</dt>
            <dd>
              {r.tasks.map((id, i) => (
                <span key={id}>
                  {i ? ", " : ""}
                  <Link href={`${base}/tasks/${id}`}>
                    #{id}
                    {titles.has(id) ? ` ${titles.get(id)}` : ""}
                  </Link>
                </span>
              ))}
            </dd>
          </>
        ) : null}
        <dt>{review ? "Why you weren't asked" : "Why it wasn't asked"}</dt>
        <dd>
          {r.rule}, under {agreement ? <Link href={`${base}/agreement${r.agreement ? `#${r.agreement}` : ""}`}>{under}</Link> : under}
        </dd>
      </dl>
      {d.review ? (
        <div className={`answered ${d.review.verdict}`}>
          <p className="small muted">
            {who} {overturned ? "overturned it" : "agreed"}, <Ago at={d.review.at} />
          </p>
          {d.review.note ? <p className="text">{d.review.note}</p> : null}
        </div>
      ) : null}
      {d.review?.pending ? (
        <p className="small">
          <Chip tone="caution">waiting for the team&apos;s Mac</Chip>{" "}
          {overturned ? "It writes this onto the record and tells the planner within a minute." : "It writes this onto the record within a minute."}
        </p>
      ) : d.withPlanner ? (
        <p className="small">
          <Chip tone="caution">with the planner</Chip> It undoes this as {review ? "you" : "the operator"} said, and notes here what it did.
        </p>
      ) : null}
      {r.notes.length ? (
        <ul className="plain rows small noted">
          {r.notes.map((n) => (
            <li key={`${n.by}-${n.at}`}>
              <p className="muted">
                The {n.by}, <Ago at={n.at} />
              </p>
              <p className="text">{n.text}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {forms}
    </li>
  );
}
