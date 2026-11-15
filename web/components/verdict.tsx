import { decideAction } from "../app/t/[team]/actions.ts";
import { LIMITS } from "../server/access.ts";
import { ActionForm } from "./action-form.tsx";
import { SubmitButton } from "./submit-button.tsx";

// One decision on a task, as the operator (approve, reject, research, escalate), with its note, made in place: the page
// refreshes and a toast says what happened. `seen` is the task's version as the page shows it: a task the team changed
// since is shown again, not decided unread. `back` is kept for the pages that pass it.
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
    <ActionForm action={decideAction}>
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
    </ActionForm>
  );
}
