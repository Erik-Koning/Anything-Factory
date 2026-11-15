"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { type AnswerFormState, answerAction } from "../app/t/[team]/actions.ts";
import { LIMITS } from "../server/access.ts";
import { toast } from "./toaster.tsx";

export interface AnswerChoice {
  key: string;
  text: string;
  recommended: boolean;
}

const EMPTY: AnswerFormState = { error: null, pick: "", extra: "" };

// The answer to what waits on the operator: one of the options the question offers (the team's recommendation marked),
// or their own words; or, for one they answered already, more words.
// `shown` is the question as this form was drawn (server/inbox.ts shownAs): the action sends an answer to one the
// team changed since back here, with the question as it stands.
export function AnswerForm({
  team,
  id,
  back,
  choices,
  recommendation,
  shown,
  adding = false,
  waits = false,
}: {
  team: string;
  id: string;
  back: string;
  choices: AnswerChoice[];
  recommendation: string | null;
  shown?: string;
  adding?: boolean;
  // No Mac runs the team now (server/views.ts quietSince): the answer waits for one.
  waits?: boolean;
}) {
  // Said in a toast once it's sent: the question leaves the page as it refreshes, this form with it.
  const [state, action, pending] = useActionState(async (previous: AnswerFormState, form: FormData) => {
    const next = await answerAction(previous, form);
    if (next.ok) toast(next.ok);
    return next;
  }, EMPTY);
  const [pick, setPick] = useState(state.pick);
  const [typed, setTyped] = useState(state.extra.trim() !== "");
  // Words beside a chosen option are a line to open: the options are the answer, and most need nothing added.
  const [noting, setNoting] = useState(false);
  const words = useRef<HTMLTextAreaElement>(null);
  const offered = !adding && (choices.length > 0 || recommendation !== null);
  const recommendedChoice = choices.some((c) => c.recommended);
  const own = !offered || pick === "other";
  // The key takes the solid once there's an answer to send: a page of questions has one solid, on the one being
  // answered, not one under each.
  const ready = own ? typed : pick !== "";
  const writing = own || noting || typed;
  useEffect(() => {
    if (pick === "other" || noting) words.current?.focus();
  }, [pick, noting]);
  const field = `answer-${id}${adding ? "-more" : ""}`;
  return (
    <form action={action} className="answer stack">
      {state.error ? (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      ) : null}
      <input type="hidden" name="team" value={team} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="back" value={back} />
      {shown ? <input type="hidden" name="shown" value={shown} /> : null}
      {offered ? (
        <fieldset className="choices">
          <legend>Your answer to #{id}</legend>
          {choices.map((c) => (
            <label key={c.key} className="check choice">
              <input type="radio" name="pick" value={c.key} required defaultChecked={state.pick === c.key} onChange={() => setPick(c.key)} />
              <span>
                <b>({c.key})</b> {c.text}
                {c.recommended ? (
                  <>
                    {" "}
                    <span className="chip ok">recommended</span>
                  </>
                ) : null}
              </span>
            </label>
          ))}
          {recommendation && !recommendedChoice ? (
            <label className="check choice">
              <input
                type="radio"
                name="pick"
                value="recommended"
                required
                defaultChecked={state.pick === "recommended"}
                onChange={() => setPick("recommended")}
              />
              <span>
                <b>Go with the recommendation:</b> {recommendation} <span className="chip ok">recommended</span>
              </span>
            </label>
          ) : null}
          <label className="check choice">
            <input type="radio" name="pick" value="other" required defaultChecked={state.pick === "other"} onChange={() => setPick("other")} />
            <span>Something else: I&apos;ll say what below</span>
          </label>
        </fieldset>
      ) : null}
      {writing ? (
        <>
          <label htmlFor={field}>
            {offered ? (own ? "Your answer" : "Anything to add (optional)") : adding ? `Add to your answer on #${id}` : `Your answer to #${id}`}
          </label>
          <textarea
            id={field}
            ref={words}
            name="extra"
            rows={offered && !own ? 2 : 4}
            maxLength={LIMITS.note}
            required={own}
            defaultValue={state.extra}
            onChange={(event) => setTyped(event.target.value.trim() !== "")}
            placeholder={
              own ? "What you decided, and the principle behind it if there is one: the planner records both" : "A condition, a change to it, or why"
            }
          />
        </>
      ) : (
        <button type="button" className="linkish add-note" onClick={() => setNoting(true)}>
          Add a note
        </button>
      )}
      <div className="inline">
        {/* While it's on its way, the question it answers fades (data-pending, globals.css). */}
        <button type="submit" className={ready ? "primary" : undefined} disabled={pending} data-pending={pending || undefined}>
          {pending ? "Sending…" : adding ? `Add to the answer on #${id}` : `Send the answer on #${id}`}
        </button>
        <span className="hint">
          {waits ? "It reaches the planner once a Mac runs the team again." : `The planner gets it within a minute and moves #${id} on.`}
        </span>
      </div>
    </form>
  );
}
