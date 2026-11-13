"use client";
import { useState } from "react";
import { type SubscriptionOption, usedWords } from "./subscription-words.ts";

export type { SubscriptionOption };

// The subscriptions a team runs on, in order: those chosen first, each with its place, then the rest to add. The form
// gets one `name` field per chosen subscription, in order. A team moves down the list when one closes, so the order is
// the choice. `onChange` hears each change, for a page that says the choice back before it's sent.
export function SubscriptionOrder({
  options,
  initial,
  name = "use",
  empty,
  onChange,
}: {
  options: SubscriptionOption[];
  initial: string[];
  name?: string;
  // What an empty list means here ("this Mac's own login", "the team's list").
  empty: string;
  onChange?: (chosen: string[]) => void;
}) {
  const known = options.map((o) => o.name);
  const [chosen, setList] = useState(() => initial.filter((n) => known.includes(n)));
  const setChosen = (next: string[]) => {
    setList(next);
    onChange?.(next);
  };
  const byName = new Map(options.map((o) => [o.name, o]));
  const rest = options.filter((o) => !chosen.includes(o.name));
  const move = (index: number, by: number) => {
    const next = [...chosen];
    const [item] = next.splice(index, 1);
    if (item !== undefined) next.splice(index + by, 0, item);
    setChosen(next);
  };
  return (
    <div className="order">
      {chosen.map((sub) => (
        <input key={sub} type="hidden" name={name} value={sub} />
      ))}
      {chosen.length ? (
        <ol className="order-list">
          {chosen.map((sub, index) => {
            const option = byName.get(sub);
            return (
              <li key={sub}>
                <span className="place" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="sub">
                  <span className="head">
                    <b>{sub}</b>
                    {option?.closed ? <span className="chip warn">closed</span> : null}
                  </span>
                  <span className="muted">
                    {index === 0 ? "first" : "when the ones above are closed"} · {usedWords(option)}
                  </span>
                </span>
                <span className="order-keys">
                  <button type="button" className="quiet s" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${sub} up`}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="quiet s"
                    onClick={() => move(index, 1)}
                    disabled={index === chosen.length - 1}
                    aria-label={`Move ${sub} down`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="quiet s"
                    onClick={() => setChosen(chosen.filter((n) => n !== sub))}
                    aria-label={`Take ${sub} off the list`}
                  >
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="order-empty">None chosen: {empty}.</p>
      )}
      {rest.length ? (
        <ul className="order-rest">
          {rest.map((option) => (
            <li key={option.name}>
              <span className="sub">
                <span className="head">
                  <b>{option.name}</b>
                  {option.closed ? <span className="chip warn">closed</span> : null}
                </span>
                <span className="muted">{usedWords(option)}</span>
              </span>
              <button type="button" className="quiet s" onClick={() => setChosen([...chosen, option.name])} aria-label={`Add ${option.name} to the list`}>
                Add
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
