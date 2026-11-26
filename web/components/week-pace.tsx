// How far the subscriptions a team spends on are through their week, for its admins (the overview's Status and the
// Settings page's Budget): how much is used, when it resets, and when at the week's pace so far it would be used up,
// so a budget can be set before the week runs out rather than found after. One login under two names is one week:
// the team's Mac reports each name it spends on.
import type { Spend } from "../server/factory.ts";
import { usedUpAt } from "../server/usage-view.ts";
import { Chip } from "./ui.tsx";
import { span } from "./usage/format.ts";

export function WeekPace({ subscriptions }: { subscriptions: NonNullable<Spend["subscriptions"]> }) {
  const now = Date.now();
  return (
    <ul className="plain week-pace">
      {subscriptions.map((s) => {
        const left = Date.parse(s.resetsAt) - now;
        const out = usedUpAt(s.percent, s.resetsAt, now);
        return (
          <li key={s.account}>
            {s.account === "default" ? "Your subscription" : s.account}: <b>{s.percent}%</b> of its week used
            {left > 0 ? `, resets in ${span(left)}` : ""}
            {s.percent >= 100 ? (
              <>
                {" "}
                <Chip tone="warn">used up</Chip>
              </>
            ) : typeof out === "number" ? (
              <>
                {" "}
                <Chip tone="caution">at this pace, used up in {span(out - now)}</Chip>
              </>
            ) : out === "lasts" ? (
              <span className="muted"> · at this pace it lasts the week</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
