// What waits on the operator on one team, from server/inbox.ts: each question with its options and the team's
// recommendation, each blocked task with why, an answer form for either, and what the planner has yet to act on or
// settled lately. The pages pass the team's inbox in; the forms write through the team's server actions.
import Link from "next/link";
import type { Task } from "../../lib/tasks/model.ts";
import type { Inbox, Settled, Waiting } from "../server/inbox.ts";
import { AnswerForm } from "./answer-form.tsx";
import { LinkedText } from "./linked-text.tsx";
import { Ago, Chip, clip } from "./ui.tsx";
import { Verdict } from "./verdict.tsx";

// Whether the operator could approve it as it stands: the move table approves only scored work (model.ts), and a
// research question has nothing to build.
const approvable = (t: Task): boolean => t.kind !== "research" && Boolean(t.score || (t.kind !== "feature" && t.severity));

export function TeamInbox({ team, box, back, titles }: { team: string; box: Inbox; back: string; titles: ReadonlyMap<string, string> }) {
  const base = `/t/${team}`;
  const open = box.questions.length + box.blocked.length;
  return (
    <>
      {open === 0 && box.answered.length === 0 ? (
        <div className="panel empty">
          <p>Nothing is waiting on you here.</p>
          <p className="hint">
            When the planner or the approver needs a decision, or work is blocked, it shows up here.{" "}
            <Link href="/account/notifications">Notifications</Link> say how you hear about it.
          </p>
        </div>
      ) : null}
      {box.questions.length ? (
        <section className="panel" aria-labelledby={`${team}-questions`}>
          <h2 id={`${team}-questions`}>
            Questions for you <span className="muted">{box.questions.length}</span>
          </h2>
          <p className="hint">The team keeps going on everything else, and settles these once you answer.</p>
          <ul className="plain rows">
            {box.questions.map((w) => (
              <WaitingItem key={w.task.id} team={team} base={base} w={w} back={back} titles={titles} />
            ))}
          </ul>
        </section>
      ) : null}
      {box.blocked.length ? (
        <section className="panel" aria-labelledby={`${team}-blocked`}>
          <h2 id={`${team}-blocked`}>
            Blocked <span className="muted">{box.blocked.length}</span>
          </h2>
          <p className="hint">Stopped until something changes: say what will, approve it again, or drop it.</p>
          <ul className="plain rows">
            {box.blocked.map((w) => (
              <WaitingItem key={w.task.id} team={team} base={base} w={w} back={back} titles={titles} />
            ))}
          </ul>
        </section>
      ) : null}
      {box.answered.length ? (
        <section className="panel" aria-labelledby={`${team}-answered`}>
          <h2 id={`${team}-answered`}>
            Answered, with the planner <span className="muted">{box.answered.length}</span>
          </h2>
          <ul className="plain rows">
            {box.answered.map((w) => (
              <AnsweredItem key={w.task.id} team={team} base={base} w={w} back={back} titles={titles} />
            ))}
          </ul>
        </section>
      ) : null}
      {box.settled.length ? (
        <details className="panel settled">
          <summary>
            <h2 className="inline-heading">Settled this week</h2> <span className="muted">{box.settled.length}</span>
          </summary>
          <ul className="plain rows small">
            {box.settled.map((s) => (
              <SettledItem key={`${s.task.id}-${s.at}`} base={base} s={s} titles={titles} />
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function Heading({ base, task, journey }: { base: string; task: Task; journey: Task | null }) {
  return (
    <div className="head">
      <span className="id">#{task.id}</span>
      <h3 className="title">
        <Link href={`${base}/tasks/${task.id}`}>{task.title}</Link>
      </h3>
      <Chip tone="">{task.kind}</Chip>
      {task.severity ? <Chip tone={task.severity === "blocker" ? "warn" : ""}>{task.severity}</Chip> : null}
      {journey ? (
        <Link className="chip link" href={`${base}/tasks/${journey.id}`}>
          {journey.title}
        </Link>
      ) : null}
    </div>
  );
}

function WaitingItem({ team, base, w, back, titles }: { team: string; base: string; w: Waiting; back: string; titles: ReadonlyMap<string, string> }) {
  const t = w.task;
  const fromNote = w.question.by !== null;
  const others = t.notes.filter((n) => n.at !== w.question.at || n.by !== w.question.by);
  // The reason it moved is often the very note that asks: then once is enough.
  const why = w.why && !w.question.text.includes(w.why) ? w.why : null;
  const more = others.length ? `${others.length} more note${others.length === 1 ? "" : "s"}` : "";
  return (
    <li id={`task-${t.id}`} className="waiting">
      <Heading base={base} task={t} journey={w.journey} />
      <p className="small muted">
        {t.status === "question" ? "Asked" : "Blocked"} by the {w.askedBy} <Ago at={w.since} />
      </p>
      {why ? (
        <p className="why small">
          <b>{t.status === "question" ? "Why it's yours: " : "Why: "}</b>
          <LinkedText text={why} base={base} titles={titles} />
        </p>
      ) : null}
      <div className="ask">
        {fromNote ? (
          <p className="small muted">
            The {w.question.by} asks, <Ago at={w.question.at} />:
          </p>
        ) : null}
        {w.question.shown ? (
          <p className="text">
            <LinkedText text={clip(w.question.shown, 2400)} base={base} titles={titles} />
          </p>
        ) : null}
      </div>
      {w.holds.length || w.related.length ? (
        <dl className="facts small">
          {w.holds.length ? (
            <>
              <dt>Holds up</dt>
              <dd>
                {w.holds.map((h, i) => (
                  <span key={h.id}>
                    {i ? ", " : ""}
                    <Link href={`${base}/tasks/${h.id}`}>
                      #{h.id} {h.title}
                    </Link>
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          {w.related.length ? (
            <>
              <dt>Also waiting on you</dt>
              <dd>
                {w.related.map((r, i) => (
                  <span key={r.id}>
                    {i ? ", " : ""}
                    <a href={`#task-${r.id}`}>
                      #{r.id} {r.title}
                    </a>
                  </span>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {(fromNote && t.body) || others.length ? (
        <details className="more">
          <summary>{fromNote && t.body ? ["The task", more].filter(Boolean).join(", and ") : `Notes (${others.length})`}</summary>
          {fromNote && t.body ? (
            <p className="text small">
              <LinkedText text={clip(t.body, 2400)} base={base} titles={titles} />
            </p>
          ) : null}
          <ul className="plain rows small">
            {others.map((n) => (
              <li key={`${n.by}-${n.at}`}>
                <p className="muted">
                  {n.by}
                  {n.kind === "answer" ? " (answer)" : ""} · <Ago at={n.at} />
                </p>
                <p className="text">
                  <LinkedText text={n.text} base={base} titles={titles} />
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <AnswerForm team={team} id={t.id} back={back} choices={w.choices} recommendation={w.recommendation} />
      <details className="more">
        <summary>{`Or decide #${t.id} yourself`}</summary>
        <div className="verdicts">
          {approvable(t) ? (
            <Verdict
              team={team}
              id={t.id}
              decision="approve"
              label={t.status === "blocked" ? "Approve again" : "Approve"}
              field="Note (optional)"
              required={false}
              className="approve"
              back={back}
            />
          ) : null}
          <Verdict team={team} id={t.id} decision="reject" label="Reject" field="Why it's rejected" required className="reject" back={back} />
        </div>
        {approvable(t) ? null : (
          <p className="hint">
            {t.kind === "research"
              ? "A question has nothing to build: answer it, or reject it."
              : "It isn't scored yet, so it can't be approved: answer it instead."}
          </p>
        )}
      </details>
    </li>
  );
}

// Past this, an answer the planner hasn't acted on is worth a word: it may be busy, paused or stopped.
const SLOW_MS = 15 * 60_000;

function AnsweredItem({ team, base, w, back, titles }: { team: string; base: string; w: Waiting; back: string; titles: ReadonlyMap<string, string> }) {
  const last = w.answers.at(-1);
  const slow = last ? Date.now() - Date.parse(last.at) > SLOW_MS : false;
  return (
    <li id={`task-${w.task.id}`}>
      <Heading base={base} task={w.task} journey={w.journey} />
      {w.answers.map((a) => (
        <div key={a.at} className="answered">
          <p className="small muted">
            Your answer, <Ago at={a.at} />
          </p>
          <p className="text">
            <LinkedText text={a.text} base={base} titles={titles} />
          </p>
        </div>
      ))}
      <p className="small">
        {slow ? (
          <>
            <Chip tone="caution">not acted on yet</Chip> The planner hasn&apos;t moved #{w.task.id} on: it may be busy, or the team paused. Its overview
            says how it&apos;s running.
          </>
        ) : (
          <>
            <Chip tone="ok">sent</Chip> The planner gets it within a minute, records it and moves #{w.task.id} on.
          </>
        )}
      </p>
      <details className="more">
        <summary>Add to your answer</summary>
        <AnswerForm team={team} id={w.task.id} back={back} choices={[]} recommendation={null} adding />
      </details>
    </li>
  );
}

const OUTCOME: Record<string, string> = {
  approved: "approved",
  rejected: "rejected",
  proposed: "proposed again",
  triage: "back in triage",
  researching: "being researched",
  building: "being built",
  review: "in review",
  done: "done",
  blocked: "blocked",
  question: "asked again",
};

function SettledItem({ base, s, titles }: { base: string; s: Settled; titles: ReadonlyMap<string, string> }) {
  return (
    <li>
      <div className="head">
        <span className="id">#{s.task.id}</span>
        <Link className="title" href={`${base}/tasks/${s.task.id}`}>
          {s.task.title}
        </Link>
        <Chip>{s.task.status}</Chip>
      </div>
      <p className="muted">
        {OUTCOME[s.to] ?? s.to} by the {s.by} <Ago at={s.at} />
      </p>
      {s.answer ? (
        <p>
          <span className="muted">Your answer: </span>
          <LinkedText text={clip(s.answer.text, 400)} base={base} titles={titles} />
        </p>
      ) : null}
    </li>
  );
}
