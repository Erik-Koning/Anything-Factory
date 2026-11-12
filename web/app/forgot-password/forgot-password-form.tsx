"use client";
import { useState } from "react";
import { authClient, problemOf } from "../auth-client.ts";

// The form, and what it says once sent. The answer is the same whether or not the address has an account
// (server/auth.ts), so this says only that an email is on its way if it does.
export function ForgotPasswordForm() {
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (sent)
    return (
      <section className="panel" aria-live="polite">
        <h2>Check your email</h2>
        <p>If {sent} has an account, a link to set a new password is on its way. It works once, for 30 minutes.</p>
        <p className="hint">
          An account with an authenticator is asked for its code as well. Nothing after a few minutes? Check the address and ask again.
        </p>
        <button type="button" className="linkish" onClick={() => setSent(null)}>
          Use another address
        </button>
      </section>
    );

  return (
    <section className="panel">
      {problem ? (
        <p className="notice error" role="alert">
          {problem}
        </p>
      ) : null}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
          setBusy(true);
          setProblem(null);
          void authClient
            .$fetch("/request-password-reset", { method: "POST", body: { email } })
            .then(
              ({ error }) => (error ? setProblem(problemOf(error, "That didn't send; try again.")) : setSent(email)),
              () => setProblem("That didn't send; try again.")
            )
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Email
          <input name="email" type="email" required maxLength={254} autoComplete="email" autoFocus />
        </label>
        <div>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Sending…" : "Email me a link"}
          </button>
        </div>
      </form>
    </section>
  );
}
