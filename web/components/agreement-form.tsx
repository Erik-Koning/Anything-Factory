"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { CONTACT_EVERY, isReserved, LEVEL_MEANS, LEVELS, type Level, NOTES_MAX, type Topic, TOPIC_MEANS, TOPICS } from "../../lib/tasks/agreement.ts";
import { type AgreementFormState, agreementAction } from "../app/t/[team]/actions.ts";

const LEVEL_NAME: Record<Level, string> = { "hands-on": "Hands-on", balanced: "Balanced", "hands-off": "Hands-off" };
const named = (topic: Topic): string => `${topic.charAt(0).toUpperCase()}${topic.slice(1)}`;

// The working agreement, to change: the level, each topic the agreement may set, how often a message may reach the
// operator, their standing instructions, and a code from their authenticator. `never` are topics this team never
// asks its operator about whatever the agreement says (the platform and the stack, of one who isn't technical): said,
// not offered.
export function AgreementForm({ team, initial, never }: { team: string; initial: Omit<AgreementFormState, "error">; never: Topic[] }) {
  const [state, action, pending] = useActionState(agreementAction, { error: null, ...initial });
  const [length, setLength] = useState(state.notes.length);
  const alert = useRef<HTMLParagraphElement>(null);
  // After a refusal the form is made again, so focus goes to what went wrong rather than nowhere.
  useEffect(() => {
    if (state.error) alert.current?.focus();
  }, [state]);
  const topics = TOPICS.filter((topic) => !isReserved(topic) && !never.includes(topic));
  return (
    // Made again from each answer, so the lists keep what was chosen (React resets a form after its action).
    <form key={JSON.stringify(state)} action={action} className="stack agreement-form">
      {state.error ? (
        <p className="notice error" role="alert" tabIndex={-1} ref={alert}>
          {state.error}
        </p>
      ) : null}
      <input type="hidden" name="team" value={team} />
      <fieldset className="choices">
        <legend>How readily the team asks you</legend>
        {LEVELS.map((level) => (
          <label key={level} className="check choice">
            <input type="radio" name="level" value={level} required defaultChecked={state.level === level} />
            <span>
              <b>{LEVEL_NAME[level]}</b>
              <span className="hint">The team {LEVEL_MEANS[level]}.</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="choices topics">
        <legend>By topic</legend>
        <p className="hint">
          Whatever the level, a topic can be always asked, or never. Never is decided for you, and still flagged where the level would have asked.
        </p>
        {topics.map((topic) => (
          <div key={topic} className="topic">
            <label htmlFor={`topic-${topic}`}>
              {named(topic)}
              <span className="hint">{TOPIC_MEANS[topic]}</span>
            </label>
            <select id={`topic-${topic}`} name={`topic-${topic}`} defaultValue={state.topics[topic] ?? "follow"}>
              <option value="follow">Follows the level</option>
              <option value="ask">Always ask me</option>
              <option value="decide">Never ask me</option>
            </select>
          </div>
        ))}
        <p className="hint">
          Always yours, whatever this says: privacy and personal data, and the team&apos;s own rules (unlocking a policy, promoting to production, checking
          less).
          {never.includes("technical") ? " Never asked of you: the platform and the stack, since this team's operator isn't technical (team.json)." : ""}
        </p>
      </fieldset>
      <fieldset className="choices messages">
        <legend>How often a message may reach you</legend>
        <p className="hint">
          The planner&apos;s questions and reports by email. What waits on you is in the app the moment it&apos;s raised, whatever this says.
        </p>
        <label className="check choice">
          <input type="radio" name="messages" value="team" defaultChecked={state.messages === "team"} />
          <span>
            <b>As the team&apos;s own settings say</b>
            <span className="hint">
              What its <code>team.json</code> sets under <code>contact</code>: a digest every four hours, unless it says otherwise.
            </span>
          </span>
        </label>
        <label className="check choice">
          <input type="radio" name="messages" value="digest" defaultChecked={state.messages === "digest"} />
          <span>
            <b>A digest</b>
            <span className="hint">Everything open together, at most once per window. One urgent message may still go in between.</span>
          </span>
        </label>
        <div className="every">
          <label htmlFor="agreement-every">A digest&apos;s window, in hours</label>
          <input
            id="agreement-every"
            name="every"
            type="number"
            inputMode="decimal"
            min={CONTACT_EVERY.min / 60}
            max={CONTACT_EVERY.max / 60}
            // Any part of an hour: a window set from the terminal (20 minutes, say) must not fail the field's own check.
            step="any"
            defaultValue={state.every}
          />
          <span className="hint">At most one message every so many hours, from a quarter of an hour to a week.</span>
        </div>
        <label className="check choice">
          <input type="radio" name="messages" value="priority" defaultChecked={state.messages === "priority"} />
          <span>
            <b>Each as soon as it&apos;s needed</b>
            <span className="hint">A message goes when the planner sends it.</span>
          </span>
        </label>
      </fieldset>
      <label htmlFor="agreement-notes">
        Standing instructions (optional)
        <span className="hint">
          In your own words, for the planner: what to batch, what to check with you first, when you&apos;re away. It follows them as it follows your
          direction; they don&apos;t change what the team is allowed to do.
        </span>
      </label>
      <textarea
        id="agreement-notes"
        name="notes"
        rows={5}
        maxLength={NOTES_MAX}
        defaultValue={state.notes}
        onChange={(event) => setLength(event.target.value.length)}
        aria-describedby="agreement-notes-count"
        placeholder="I'm away until Monday: batch what can wait. Never add a dependency without asking."
      />
      <p id="agreement-notes-count" className="hint">
        {length.toLocaleString("en")} of {NOTES_MAX.toLocaleString("en")} characters
      </p>
      <label htmlFor="agreement-code">
        Code from your authenticator
        <input id="agreement-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
      </label>
      <div className="inline">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Saving…" : "Change the agreement"}
        </button>
        <span className="hint">The team follows it from now on; the planner is told within a minute.</span>
      </div>
    </form>
  );
}
