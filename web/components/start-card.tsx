// An ask to start a team (lib/tasks/start.ts), on the Teams page: what was asked, of which Mac, how far it has got,
// and, when it stopped, why, what to do about it and the command to run. Withdrawn while it waits; asked again or
// cleared once it has ended.
import Link from "next/link";
import { withdrawStartAction } from "../app/new/actions.ts";
import { GITHUB_REPO, repoOf, STEP_WORDS } from "../../lib/tasks/start.ts";
import type { Start } from "../server/starts.ts";
import { Command } from "./command.tsx";
import { MARKS } from "./start-marks.ts";
import { SubmitButton } from "./submit-button.tsx";
import { Ago, Chip } from "./ui.tsx";

// A mark's state in a sign as well as a colour, for anyone who can't tell the two bars apart.
const SIGN = { done: "✓", now: "▸", stopped: "✕", held: "‖", todo: "" } as const;

// A note the Mac wrote, its repositories as names (owner/name), each a link to it on GitHub.
function NoteText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\b[A-Za-z0-9-]+\/[A-Za-z0-9._-]+[A-Za-z0-9_-])/).map((part, index) =>
        GITHUB_REPO.test(part) ? (
          <a key={index} className="code" href={`https://github.com/${part}`} rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        )
      )}
    </>
  );
}

export function StartCard({ start, up }: { start: Start; up: boolean | null }) {
  const { ask, step, team } = start;
  const ended = step === "failed" || step === "refused" || step === "expired";
  const { name: folder, create } = repoOf(ask);
  // Set up and paused, as asked: its last mark waits for the operator instead of saying it started.
  const waits = step === "started" && ask.hold === true;
  const at = waits ? MARKS.length - 1 : MARKS.findIndex((mark) => mark.step === (step === "failed" ? start.stoppedAt : step));
  const mark = (index: number): keyof typeof SIGN =>
    waits
      ? index < at
        ? "done"
        : "held"
      : step === "started"
        ? "done"
        : at < 0
          ? "todo"
          : index < at
            ? "done"
            : index > at
              ? "todo"
              : step === "failed"
                ? "stopped"
                : "now";
  const chip =
    step === "waiting"
      ? { text: "waiting for the Mac", tone: "caution" }
      : step === "expired"
        ? { text: "not picked up", tone: "warn" }
        : step === "failed"
          ? { text: "stopped", tone: "warn" }
          : step === "refused"
            ? { text: "refused", tone: "warn" }
            : step === "started"
              ? { text: waits ? "set up, waiting for you" : "started", tone: waits ? "caution" : "ok" }
              : { text: STEP_WORDS[step].toLowerCase(), tone: "ok" };
  const current = at >= 0 ? MARKS[at] : undefined;
  return (
    <li className={`start-card${ended ? " ended" : waits ? " held" : ""}`} id={`start-${team}`}>
      <div className="head">
        <h3 className="title">{ask.title}</h3>
        <Chip tone={chip.tone}>{chip.text}</Chip>
      </div>
      <p className="muted small where">
        <span className="code">{team}</span> on <b>{ask.machineName}</b>,{" "}
        {"github" in ask.repo ? (
          <>
            from GitHub <span className="code">{ask.repo.github}</span>
          </>
        ) : (
          <>
            {create ? ("publish" in ask.repo && ask.repo.publish ? "in a new repository, on GitHub too," : "in a new repository") : "in"}{" "}
            <span className="code">{folder}</span>
          </>
        )}
        {step === "waiting" ? null : (
          <>
            {" "}
            · asked <Ago at={start.asked} />
          </>
        )}
      </p>
      <ol className="marks" aria-label={`How far ${ask.title} has got`}>
        {MARKS.map(({ step: name, label }, index) => {
          const state = mark(index);
          return (
            <li key={name} className={state} aria-current={state === "now" ? "step" : undefined}>
              <span className="dot" aria-hidden="true" />
              <span className="mark-name">
                {SIGN[state] ? (
                  <span className="sign" aria-hidden="true">
                    {SIGN[state]}{" "}
                  </span>
                ) : null}
                {state === "held" ? "Waiting" : label}
                <span className="sr">
                  {state === "done"
                    ? ", done"
                    : state === "stopped"
                      ? ", stopped here"
                      : state === "now"
                        ? ", under way"
                        : state === "held"
                          ? ", for you"
                          : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {/* On a phone the marks are bars alone: the step they've reached is said once, under them. */}
      {current && (step !== "started" || waits) ? (
        <p className="marks-now" aria-hidden="true">
          {SIGN[mark(at)]} Step {at + 1} of {MARKS.length}: {waits ? "Waiting for you" : current.label}
        </p>
      ) : null}
      {step === "waiting" ? (
        <p className="small">
          Asked <Ago at={start.asked} />. {ask.machineName} looks every five minutes.
          {up === false ? ` It isn't reporting now, so nothing starts until it's on with its watchdog running.` : ""}
          {up === null ? ` It isn't linked to your account any more, so it won't see this.` : ""}
        </p>
      ) : step === "expired" ? (
        <>
          <p className="notice error">{ask.machineName} didn&apos;t pick it up within a day, so it was dropped.</p>
          <p className="small">Check it&apos;s on and still starts projects. On {ask.machineName}:</p>
          <Command>a6g projects</Command>
        </>
      ) : step === "started" ? (
        waits ? (
          <div className="start-actions">
            <span className="small">Set up and checked, and paused as you asked: nothing runs or spends until you resume it.</span>
            <Link className="button s" href={`/t/${team}`}>
              Open to resume
            </Link>
          </div>
        ) : (
          <p className="small">The team is started. Its row shows below once it has published its settings, at its next run.</p>
        )
      ) : ended ? (
        <>
          {/* Why, in a sentence; then what the command that failed said, in its own words and its own face. */}
          <p className="notice error">
            {start.problem ?? "It stopped, and didn't say why."}
            {start.said ? <span className="said">{start.said}</span> : null}
          </p>
          {start.fix ? <p className="small">{start.fix}</p> : null}
          {start.command ? <Command>{start.command}</Command> : null}
        </>
      ) : (
        <p className="small">
          {current?.doing}{" "}
          <span className="muted">
            This step began <Ago at={start.at} />.
          </span>
        </p>
      )}
      {/* What the Mac's steps did that you should know: the repository cloned or forked, made on GitHub. */}
      {start.notes.filter((note) => !waits || !note.startsWith("Set up, and waiting")).length ? (
        <ul className="plain notes small">
          {start.notes
            .filter((note) => !waits || !note.startsWith("Set up, and waiting"))
            .map((note, index) => (
              <li key={index}>
                <NoteText text={note} />
              </li>
            ))}
        </ul>
      ) : null}
      {step === "waiting" || ended ? (
        <div className="start-actions">
          {ended ? (
            <Link className="button s" href={`/new?again=${team}`}>
              Ask again
            </Link>
          ) : null}
          <form action={withdrawStartAction}>
            <input type="hidden" name="team" value={team} />
            <SubmitButton className="quiet s" label={`${ended ? "Clear" : "Withdraw"} ${ask.title}`}>
              {ended ? "Clear" : "Withdraw"}
            </SubmitButton>
          </form>
          {/* The ways out, and how they differ. */}
          {ended ? (
            <span className="hint">
              {start.command && step === "failed" ? "Or ask again" : "Ask again"} to have {ask.machineName} start over, with the form as you left it. Clear
              only removes this card.
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
