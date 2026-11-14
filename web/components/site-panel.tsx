// Whether the team is on the site, on its overview (admins only): a team no Mac runs can be taken off, and one that's
// off put back, each with an authenticator code. One a Mac still runs comes off when it's unregistered there, which
// stops it too: taking it off here would leave it running unseen.
import { siteAction } from "../app/t/[team]/actions.ts";
import { LIMITS } from "../server/access.ts";
import type { Control, TeamDoc } from "../server/factory.ts";
import { askedBy, quietSince } from "../server/views.ts";
import { Command } from "./command.tsx";
import { SubmitButton } from "./submit-button.tsx";
import { CodeField } from "./team-controls.tsx";
import { Ago } from "./ui.tsx";

// `expanded`: the form to take it off, reopened after a refusal.
export function SitePanel({ team, retired, expanded = false }: { team: TeamDoc; retired: Control | null; expanded?: boolean }) {
  const quiet = quietSince(team);
  return (
    <section className="panel" id="site" aria-labelledby="site-heading">
      <h2 id="site-heading">On the site</h2>
      {retired ? (
        <div className="stack">
          <p>
            Taken off the site <Ago at={retired.at} />, by {askedBy(retired.by)}
            {retired.note ? <> (“{retired.note}”)</> : null}. It isn&apos;t on Teams or in Waiting on you, and nobody is emailed about it. Its tasks and
            history are as they were.
          </p>
          <form action={siteAction} className="stack">
            <input type="hidden" name="team" value={team.name} />
            <input type="hidden" name="kind" value="restore" />
            <CodeField id="restore-code" />
            <div>
              <SubmitButton className="primary">Put it back on the site</SubmitButton>
            </div>
          </form>
        </div>
      ) : quiet ? (
        <div className="stack">
          <p>
            {quiet.last ? (
              <>
                No Mac runs it now: it was last heard from <Ago at={quiet.last} />.
              </>
            ) : (
              "No Mac has run it since it was published."
            )}{" "}
            Taking it off the site leaves it out of Teams, Waiting on you and the emails; its tasks, history and name stay, and you can put it back here.
          </p>
          <details open={expanded}>
            <summary>Take it off the site</summary>
            <form action={siteAction} className="stack">
              <input type="hidden" name="team" value={team.name} />
              <input type="hidden" name="kind" value="retire" />
              <label htmlFor="retire-note">
                Why (optional, for the record)
                <textarea id="retire-note" name="note" rows={2} maxLength={LIMITS.note} />
              </label>
              <CodeField id="retire-code" />
              <div>
                <SubmitButton className="danger">Take it off the site</SubmitButton>
              </div>
            </form>
          </details>
        </div>
      ) : (
        <div className="stack">
          <p className="small">
            {team.status?.at ? (
              <>
                A Mac runs it: it last reported <Ago at={team.status.at} />.
              </>
            ) : (
              "It was published less than 15 minutes ago, so a Mac may be starting it."
            )}{" "}
            To take it off the site, unregister it on that Mac, which stops it there too (its files stay):
          </p>
          <Command>{`a6g unregister ${team.name}`}</Command>
        </div>
      )}
    </section>
  );
}
