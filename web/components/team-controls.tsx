// Where the operator's controls stand, a row of the overview's How it runs (admins only): what was asked that its Mac
// hasn't applied yet, a pause under way or in force (with its report), and what came of each action (a planner or
// environment restart, an upgrade, a wake). The buttons themselves are beside the team's name (components/team-actions.tsx).
import { type ActionState, actionsOf, type Control, describeHold, type HoldState, type TeamDoc } from "../server/factory.ts";
import { actionSaid, askedBy, controlSaid, controlsView } from "../server/views.ts";
import { LocalMoment } from "./local-moment.tsx";
import { Ago, Chip } from "./ui.tsx";

export function CodeField({ id }: { id: string }) {
  return (
    <label htmlFor={id}>
      Code from your authenticator
      <input id={id} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
    </label>
  );
}

const OUTCOME_TONE: Record<ActionState["outcome"], string> = { asked: "caution", started: "caution", waiting: "caution", done: "ok", failed: "warn" };

// When a pause asked to end at the usage limit's reset does, as the team's Mac last said: the moment, and the limit it
// waits on (or, when no subscription was closed to the team, the one nearest its end).
function EndsAtReset({ hold }: { hold: HoldState }) {
  const reset = hold.reset;
  if (!reset) return <>It resumes by itself when its usage limit resets; its Mac says when within a minute.</>;
  if (!reset.at) return <>It was asked to resume when its usage limit resets, but {reset.why}. Resume it yourself, or it waits for a reading that says.</>;
  return (
    <>
      It resumes by itself <LocalMoment at={reset.at} />,{" "}
      {reset.guess ? `when the limit nearest its end resets (${reset.why} when its Mac worked that out)` : `when its usage limit resets (${reset.why})`}.
      Resume it to start sooner.
    </>
  );
}

// Whether the controls have anything to say: one asked, a pause under way or in force, or an action's outcome. With
// none of those the part would hold only where the buttons are, so the overview leaves its panel out.
export function controlsToSay(team: TeamDoc, controls: Control[]): boolean {
  const status = team.status;
  const { pending, recent } = controlsView(status, controls);
  const held = status?.state === "paused" || (status?.state === "pausing" && Boolean(status.hold));
  return pending !== null || held || recent.length > 0 || actionsOf(controls).length > 0;
}

export function TeamControls({ team, controls }: { team: TeamDoc; controls: Control[] }) {
  const status = team.status;
  const hold = status?.hold ?? null;
  const { pending, recent } = controlsView(status, controls);
  const pausing = status?.state === "pausing" && hold !== null;
  const paused = status?.state === "paused";
  const actions = actionsOf(controls).slice(0, 6);
  return (
    <section className="part" aria-labelledby="controls">
      <h3 id="controls">Controls</h3>
      <div className="part-body">
        <p className="small muted">Stop, pause and resume are beside the team&apos;s name; restarting, upgrading, waking and deleting it, under ⋯.</p>
        {pending ? (
          <p className="small">
            <Chip tone="caution">waiting for the team&apos;s Mac</Chip> {controlSaid(pending)} <Ago at={pending.at} />; it applies within a minute.
          </p>
        ) : null}

        {pausing && hold ? (
          <div className="stack">
            <p>
              Pausing after {describeHold(hold)}, asked <Ago at={hold.since} />. Nothing else is claimed; once this is merged the team pauses and you get a
              report.
              {hold.until === "reset" ? (
                <>
                  {" "}
                  <EndsAtReset hold={hold} />
                </>
              ) : null}
            </p>
            {hold.left.length ? (
              <>
                <p className="small muted">Still going:</p>
                <ul className="small">
                  {hold.left.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {hold.stuck.length ? (
              <>
                <p className="small muted">Can&apos;t move without you (it pauses anyway):</p>
                <ul className="small">
                  {hold.stuck.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}

        {paused ? (
          <div className="stack">
            <p>
              Paused
              {hold?.settledAt ? (
                <>
                  {" "}
                  <Ago at={hold.settledAt} />
                </>
              ) : null}
              . {hold?.until === "reset" ? <EndsAtReset hold={hold} /> : "Work stays stopped until you resume it."}
            </p>
            {hold?.report ? (
              <details open>
                <summary>Where the team stands</summary>
                <pre className="report">{hold.report}</pre>
              </details>
            ) : null}
          </div>
        ) : null}

        {actions.length ? (
          <ul className="plain rows small actions-done">
            {actions.map((s) => (
              <li key={s.control.id}>
                <div className="head">
                  <span>{actionSaid(s.control)}</span>
                  <Chip tone={OUTCOME_TONE[s.outcome]}>{s.outcome}</Chip>
                  <span className="muted">
                    {askedBy(s.control.by)} · <Ago at={s.at} />
                  </span>
                </div>
                {s.said ? <p className="said">{s.said}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {recent.length ? (
          <details>
            <summary>Recent</summary>
            <ul className="plain rows small">
              {recent.map((c) => (
                <li key={c.id}>
                  {controlSaid(c)} · {askedBy(c.by)} · <Ago at={c.at} />
                  {c.note ? <span className="muted"> · “{c.note}”</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}
