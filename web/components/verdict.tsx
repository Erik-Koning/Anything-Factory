import { decideAction } from "../app/t/[team]/actions.ts";
import { LIMITS } from "../server/access.ts";
import { SubmitButton } from "./submit-button.tsx";

// One decision on a task, as the operator (approve, reject, research, escalate), with its note; back is the page to
// return to (the Decisions page, or the inbox it was made from). `seen` is the task's version as the page shows it: a
// task the team changed since is shown again, not decided unread.
export function Verdict(props: {
  team: string;
  id: string;
  decision: string;
  label: string;
  field: string;
  required: boolean;
  className?: string;
  back?: string;
  seen?: number;
}) {
  const { team, id, decision, label, field, required, className, back, seen } = props;
  const input = `${decision}-${id}`;
  return (
    <form action={decideAction}>
      <input type="hidden" name="team" value={team} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" value={decision} />
      {back ? <input type="hidden" name="back" value={back} /> : null}
      {seen === undefined ? null : <input type="hidden" name="seen" value={seen} />}
      <label htmlFor={input}>{field}</label>
      <input id={input} name="text" required={required} maxLength={LIMITS.note} autoComplete="off" />
      <div>
        <SubmitButton className={className}>{`${label} #${id}`}</SubmitButton>
      </div>
    </form>
  );
}
