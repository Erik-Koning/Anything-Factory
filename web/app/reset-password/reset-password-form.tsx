"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { type ResetState, setPasswordAction } from "./actions.ts";

const MIN_PASSWORD = 12;

// The new password, and the authenticator's code when the account has one. Sent by hand, not as the form's own
// action, so what was typed stays in place when the code turns out wrong.
export function ResetPasswordForm({ token, email, needsCode }: { token: string; email: string; needsCode: boolean }) {
  const [state, setState] = useState<ResetState>({ error: null, gone: false });
  const [pending, start] = useTransition();
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.error) alert.current?.focus();
  }, [state]);

  if (state.gone)
    return (
      <section className="panel stack">
        <p className="notice error" role="alert" tabIndex={-1} ref={alert}>
          {state.error}
        </p>
        <p>
          <Link href="/forgot-password">Ask for a new link</Link>
        </p>
      </section>
    );

  return (
    <section className="panel">
      {state.error ? (
        <p className="notice error" role="alert" tabIndex={-1} ref={alert}>
          {state.error}
        </p>
      ) : null}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          start(async () => {
            // On success the action sends the browser on, and nothing comes back.
            const result = await setPasswordAction(data);
            if (result) setState(result);
          });
        }}
      >
        <input type="hidden" name="token" value={token} />
        {/* For a password manager: which account the new password belongs to. */}
        <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
        <label>
          New password
          <input
            name="password"
            type="password"
            required
            autoFocus
            minLength={MIN_PASSWORD}
            maxLength={128}
            autoComplete="new-password"
            aria-describedby="password-hint"
          />
        </label>
        <p className="hint" id="password-hint">
          At least {MIN_PASSWORD} characters.
        </p>
        {needsCode ? (
          <>
            <label>
              6-digit code from your authenticator
              <input name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" aria-describedby="code-hint" />
            </label>
            <p className="hint" id="code-hint">
              This account has an authenticator, so changing its password takes a code from it as well as the link.
            </p>
          </>
        ) : null}
        <div>
          <button type="submit" className="primary" disabled={pending}>
            {pending ? "Setting it…" : "Set my password"}
          </button>
        </div>
      </form>
    </section>
  );
}
