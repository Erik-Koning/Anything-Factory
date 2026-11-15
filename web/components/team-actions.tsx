// What an admin can do to a team, beside its name on every one of its pages: stop it or pause it (or resume it), and
// behind ⋯ the less used: restart its planner or its environment, upgrade its factory, wake it, delete it. Each press
// completes at once, says so in a toast, and the team's Mac applies it within a minute; the overview's Controls panel
// shows how each went. Only deleting asks for more: the team's name, typed, and a code from the authenticator.
import { controlAction, teamAction } from "../app/t/[team]/actions.ts";
import { LIMITS } from "../server/access.ts";
import { ACTION_WORDS, actionsOf, type Control, holdOf, journeysUnderWay, type Task, type TeamAction, type TeamDoc } from "../server/factory.ts";
import { controlsView } from "../server/views.ts";
import { ActionForm } from "./action-form.tsx";
import { CloseDialog, Dialog, MoreMenu, OpenDialog } from "./overlays.tsx";
import { SubmitButton } from "./submit-button.tsx";
import { CodeField } from "./team-controls.tsx";
import { Chip } from "./ui.tsx";

// The actions behind ⋯ that run at once, in the order the menu lists them.
const AT_ONCE: TeamAction[] = ["rotate", "env", "upgrade", "wake"];

// A press that sends one thing: the team, and the hidden fields that say what.
function Press({
  action,
  team,
  fields,
  className,
  children,
  disabled = false,
}: {
  action: (form: FormData) => Promise<{ ok?: string; error?: string }>;
  team: string;
  fields: Record<string, string>;
  className?: string;
  children: string;
  disabled?: boolean;
}) {
  return (
    <ActionForm action={action}>
      <input type="hidden" name="team" value={team} />
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {disabled ? (
        <button type="button" className={className} disabled aria-disabled>
          {children}
        </button>
      ) : (
        <SubmitButton className={className}>{children}</SubmitButton>
      )}
    </ActionForm>
  );
}

export function TeamActions({ team, controls, tasks, mayDelete }: { team: TeamDoc; controls: Control[]; tasks: Task[]; mayDelete: boolean }) {
  const name = team.name;
  const title = team.title || team.name;
  const dialog = (what: string) => `${name}-${what}`;
  // As asked, not only as the Mac last reported: a stop shows Resume the moment it's pressed.
  const held = holdOf(controls);
  const { pending } = controlsView(team.status, controls);
  // An action of a kind already asked, and not yet done, isn't offered again until it is.
  const busy = new Set(
    actionsOf(controls)
      .filter((s) => s.outcome === "asked" || s.outcome === "started" || s.outcome === "waiting")
      .map((s) => s.action)
  );
  const open = tasks.filter((t) => t.kind === "journey" && t.status !== "done" && t.status !== "rejected");
  const underWay = new Set(journeysUnderWay(tasks).map((j) => j.id));
  return (
    <div className="team-actions">
      {pending ? (
        <Chip tone="caution">{pending.kind === "resume" ? "resuming…" : pending.scope === "now" || !pending.scope ? "stopping…" : "pausing…"}</Chip>
      ) : null}
      {held ? (
        <>
          <Press action={controlAction} team={name} fields={{ kind: "resume" }} className="primary s">
            Resume
          </Press>
          {/* Pausing after the work under way: it can still be stopped at once. */}
          {held.scope !== "now" ? (
            <Press action={controlAction} team={name} fields={{ kind: "stop" }} className="danger s">
              Stop now
            </Press>
          ) : null}
        </>
      ) : (
        <>
          <Press action={controlAction} team={name} fields={{ kind: "stop" }} className="danger s">
            Stop
          </Press>
          <OpenDialog target={dialog("pause")} className="s">
            Pause…
          </OpenDialog>
        </>
      )}
      <MoreMenu label={`More for ${title}`}>
        {held ? (
          <OpenDialog target={dialog("resume")} className="menu-item">
            Resume with a note…
          </OpenDialog>
        ) : null}
        {AT_ONCE.map((action) => (
          <Press key={action} action={teamAction} team={name} fields={{ action }} className="menu-item" disabled={busy.has(action)}>
            {busy.has(action) ? `${ACTION_WORDS[action].button} (asked)` : ACTION_WORDS[action].button}
          </Press>
        ))}
        {mayDelete ? (
          <>
            <hr />
            <OpenDialog target={dialog("delete")} className="menu-item danger">
              Delete the team…
            </OpenDialog>
          </>
        ) : null}
      </MoreMenu>

      {held ? null : (
        <Dialog id={dialog("pause")} title={`Pause ${title}`}>
          <ActionForm action={controlAction} className="stack">
            <input type="hidden" name="team" value={name} />
            <input type="hidden" name="kind" value="pause" />
            <fieldset className="choices">
              <legend>When does it stop?</legend>
              <label className="check">
                <input type="radio" name="scope" value="tasks" defaultChecked />
                <span>After the work under way: what&apos;s being built or reviewed finishes and merges; nothing new starts.</span>
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
              <label className="check">
                <input type="radio" name="scope" value="now" />
                <span>Now: nothing starts or merges; members finish their current turn. (Stop does this.)</span>
              </label>
            </fieldset>
            <label htmlFor={dialog("pause-note")}>
              Note (optional, for the record and the report)
              <textarea id={dialog("pause-note")} name="note" rows={2} maxLength={LIMITS.note} />
            </label>
            <div className="inline">
              <SubmitButton className="danger">Pause</SubmitButton>
              <CloseDialog className="quiet">Cancel</CloseDialog>
            </div>
          </ActionForm>
        </Dialog>
      )}

      {held ? (
        <Dialog id={dialog("resume")} title={`Resume ${title}`}>
          <ActionForm action={controlAction} className="stack">
            <input type="hidden" name="team" value={name} />
            <input type="hidden" name="kind" value="resume" />
            <label htmlFor={dialog("resume-note")}>
              Feedback for the planner
              <textarea id={dialog("resume-note")} name="note" rows={3} maxLength={LIMITS.note} required />
            </label>
            <div className="inline">
              <SubmitButton className="primary">Resume</SubmitButton>
              <CloseDialog className="quiet">Cancel</CloseDialog>
            </div>
          </ActionForm>
        </Dialog>
      ) : null}

      {mayDelete ? (
        <Dialog id={dialog("delete")} title={`Delete ${title}`}>
          <ActionForm action={teamAction} className="stack">
            <input type="hidden" name="team" value={name} />
            <input type="hidden" name="action" value="unregister" />
            <p>
              It stops now and leaves Teams and Waiting on you at once. Within a minute its Mac takes it off: its agents and its place in the watchdog go.
              Its checkout, branch, run folder, tasks and history are kept, and <code>a6g register</code> on its Mac brings it back.
            </p>
            <label htmlFor={dialog("delete-name")}>
              Type <b>{name}</b> to confirm
              <input id={dialog("delete-name")} name="confirm" required autoComplete="off" spellCheck={false} />
            </label>
            <CodeField id={dialog("delete-code")} />
            <div className="inline">
              <SubmitButton className="danger">Delete the team</SubmitButton>
              <CloseDialog className="quiet">Cancel</CloseDialog>
            </div>
          </ActionForm>
        </Dialog>
      ) : null}
    </div>
  );
}
