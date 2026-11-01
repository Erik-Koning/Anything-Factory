"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { type StepUpState, stepUpAction } from "./actions.ts";

export function StepUpForm() {
  const [state, action, pending] = useActionState<StepUpState, FormData>(stepUpAction, { error: null, backup: false });
  const [backup, setBackup] = useState(state.backup);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.error) alert.current?.focus();
  }, [state]);
  return (
    <form action={action} className="stack">
      {state.error ? (
        <p className="notice error" role="alert" tabIndex={-1} ref={alert}>
          {state.error}
        </p>
      ) : null}
      <input type="hidden" name="kind" value={backup ? "backup" : "code"} />
      <label>
        {backup ? "Backup code" : "6-digit code"}
        <input
          key={backup ? "backup" : "code"}
          name="code"
          required
          autoFocus
          autoComplete="one-time-code"
          inputMode={backup ? "text" : "numeric"}
          maxLength={backup ? 24 : 6}
          pattern={backup ? undefined : "[0-9]{6}"}
        />
      </label>
      <div className="inline">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Checking…" : "Continue"}
        </button>
        <button type="button" className="linkish" onClick={() => setBackup(!backup)}>
          {backup ? "Use the authenticator instead" : "Use a backup code instead"}
        </button>
      </div>
    </form>
  );
}
