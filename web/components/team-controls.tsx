// The operator's pause and resume, on a team's overview (admins only): where the team stands as its Mac last reported,
// what was asked since, and the forms. A pause stops the team now, or once the work or journeys under way are merged;
// a resume starts it again and takes the operator's feedback to the planner. Each asks for an authenticator code.
import { controlAction } from "../app/t/[team]/actions.ts";
import { LIMITS } from "../server/access.ts";
import { type Control, describeHold, journeysUnderWay, type Task, type TeamDoc } from "../server/factory.ts";
import { askedBy, controlSaid, controlsView } from "../server/views.ts";
import { SubmitButton } from "./submit-button.tsx";
import { Ago, Chip } from "./ui.tsx";

export function CodeField({ id }: { id: string }) {
  return (
    <label htmlFor={id}>
      Code from your authenticator
      <input id={id} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
    </label>
  );
}

// `expanded`: the pause form, reopened after a refusal.
export function TeamControls({ team, controls, tasks, expanded = false }: { team: TeamDoc; controls: Control[]; tasks: Task[]; expanded?: boolean }) {
  const status = team.status;
  const hold = status?.hold ?? null;
  const { pending, recent } = controlsView(status, controls);
  const pausing = status?.state === "pausing" && hold !== null;
  const paused = status?.state === "paused";
  const open = tasks.filter((t) => t.kind === "journey" && t.status !== "done" && t.status !== "rejected");
  const underWay = new Set(journeysUnderWay(tasks).map((j) => j.id));
  return (
    <section className="panel" aria-labelledby="controls">
      <h2 id="controls">Pause and resume</h2>
      {pending ? (
        <p className="small">
          <Chip tone="caution">waiting for the team's Mac</Chip> {controlSaid(pending)} <Ago at={pending.at} />; it applies within a minute.
        </p>
      ) : null}

      {pausing && hold ? (
        <div className="stack">
          <p>
            Pausing after {describeHold(hold)}, asked <Ago at={hold.since} />. Nothing else is claimed; once this is merged the team pauses and you get a
            report.
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
              <p className="small muted">Can't move without you (it pauses anyway):</p>
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
            . Work stays stopped until you resume it.
          </p>
          {hold?.report ? (
            <details open>
              <summary>Where the team stands</summary>
              <pre className="report">{hold.report}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {paused || pausing ? (
        <form action={controlAction} className="stack">
          <input type="hidden" name="team" value={team.name} />
          <input type="hidden" name="kind" value="resume" />
          <label htmlFor="resume-note">
            Feedback for the planner (optional)
            <textarea id="resume-note" name="note" rows={3} maxLength={LIMITS.note} />
          </label>
          <CodeField id="resume-code" />
          <div>
            <SubmitButton className="primary">Resume</SubmitButton>
          </div>
        </form>
      ) : null}

      {!paused ? (
        <details open={expanded}>
          <summary>{pausing ? "Pause now instead" : "Pause the team"}</summary>
          <form action={controlAction} className="stack">
            <input type="hidden" name="team" value={team.name} />
            <input type="hidden" name="kind" value="pause" />
            <fieldset className="choices">
              <legend>When does it stop?</legend>
              {pausing ? null : (
                <>
                  <label className="check">
                    <input type="radio" name="scope" value="tasks" defaultChecked />
                    <span>After the work under way: what's being built or reviewed finishes and merges; nothing new starts.</span>
                  </label>
                  <label className="check">
                    <input type="radio" name="scope" value="journeys" disabled={!open.length} />
                    <span>After these journeys are done, their verification and polish included:</span>
                  </label>
                  {open.length ? (
                    <div className="choices nested">
                      {open.map((j) => (
                        <label key={j.id} className="check">
                          <input type="checkbox" name="journey" value={j.id} defaultChecked={underWay.has(j.id)} />
                          <span>
                            #{j.id} {j.title}
                            {underWay.has(j.id) ? null : <span className="muted"> (not begun)</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
              <label className="check">
                <input type="radio" name="scope" value="now" defaultChecked={pausing} />
                <span>Now: nothing starts or merges; members finish their current turn.</span>
              </label>
            </fieldset>
            <label htmlFor="pause-note">
              Note (optional, for the record and the report)
              <textarea id="pause-note" name="note" rows={2} maxLength={LIMITS.note} />
            </label>
            <CodeField id="pause-code" />
            <div>
              <SubmitButton className="danger">{pausing ? "Pause now" : "Pause"}</SubmitButton>
            </div>
          </form>
        </details>
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
    </section>
  );
}
