"use client";
import { useActionState, useRef, useState } from "react";
import { type AnswerFormState, answerAction } from "../app/t/[team]/actions.ts";
import { LIMITS } from "../server/access.ts";

export interface AnswerChoice {
  key: string;
  text: string;
  recommended: boolean;
}

const EMPTY: AnswerFormState = { error: null, pick: "", extra: "" };

// The answer to what waits on the operator: one of the options the question offers (the team's recommendation marked),
// or their own words; or, for one they answered already, more words.
export function AnswerForm({
  team,
  id,
  back,
  choices,
  recommendation,
  adding = false,
}: {
  team: string;
  id: string;
  back: string;
  choices: AnswerChoice[];
  recommendation: string | null;
  adding?: boolean;
}) {
  const [state, action, pending] = useActionState(answerAction, EMPTY);
  const [pick, setPick] = useState(state.pick);
  const words = useRef<HTMLTextAreaElement>(null);
  const offered = !adding && (choices.length > 0 || recommendation !== null);
  const recommendedChoice = choices.some((c) => c.recommended);
  const own = !offered || pick === "other";
  const choose = (key: string) => {
    setPick(key);
    if (key === "other") words.current?.focus();
  };
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
      {offered ? (
        <fieldset className="choices">
          <legend>Your answer to #{id}</legend>
          {choices.map((c) => (
            <label key={c.key} className="check choice">
              <input type="radio" name="pick" value={c.key} required defaultChecked={state.pick === c.key} onChange={() => choose(c.key)} />
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
                onChange={() => choose("recommended")}
              />
              <span>
                <b>Go with the recommendation:</b> {recommendation} <span className="chip ok">recommended</span>
              </span>
            </label>
          ) : null}
          <label className="check choice">
            <input type="radio" name="pick" value="other" required defaultChecked={state.pick === "other"} onChange={() => choose("other")} />
            <span>Something else: I&apos;ll say what below</span>
          </label>
        </fieldset>
      ) : null}
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
        placeholder={
          own ? "What you decided, and the principle behind it if there is one: the planner records both" : "A condition, a change to it, or why"
        }
      />
      <div className="inline">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Sending…" : adding ? `Add to the answer on #${id}` : `Send the answer on #${id}`}
        </button>
        <span className="hint">The planner gets it within a minute and moves #{id} on.</span>
      </div>
    </form>
  );
}
