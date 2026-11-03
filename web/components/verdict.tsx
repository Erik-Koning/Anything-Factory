import { decideAction } from "../app/t/[team]/actions.ts";
import { LIMITS } from "../server/access.ts";
import { SubmitButton } from "./submit-button.tsx";

// One decision on a task, as the operator (approve, reject, research, escalate), with its note; back is the page to
// return to (the Decisions page, or the inbox it was made from).
export function Verdict(props: {
  team: string;
  id: string;
  decision: string;
  label: string;
  field: string;
  required: boolean;
  className?: string;
  back?: string;
}) {
  const { team, id, decision, label, field, required, className, back } = props;
  const input = `${decision}-${id}`;
  return (
    <form action={decideAction}>
      <input type="hidden" name="team" value={team} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" value={decision} />
      {back ? <input type="hidden" name="back" value={back} /> : null}
      <label htmlFor={input}>{field}</label>
      <input id={input} name="text" required={required} maxLength={LIMITS.note} autoComplete="off" />
      <div>
        <SubmitButton className={className}>{`${label} #${id}`}</SubmitButton>
      </div>
    </form>
  );
}
