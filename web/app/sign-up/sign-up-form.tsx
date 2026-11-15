"use client";
import Link from "next/link";
import { useState } from "react";
import { authClient, problemOf } from "../auth-client.ts";

const MIN_PASSWORD = 12;

// The sign-up form, and what it says once sent. The answer is the same whether or not the address had an account
// already (server/auth.ts), so this says only that an email is on its way.
export function SignUpForm() {
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (sent)
    return (
      <section className="panel" aria-live="polite">
        <h2>Check your email</h2>
        <p>
          We&apos;ve sent an email to {sent}. Open its link to confirm the address: it works once, for an hour, and signs you in. If that address has an
          account already, the email says so instead.
        </p>
        <p className="hint">
          Nothing after a few minutes? <Link href="/sign-in">Sign in</Link> with your email and password and we&apos;ll send a new link.
        </p>
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
          const data = new FormData(event.currentTarget);
          const email = String(data.get("email") ?? "").trim();
          setBusy(true);
          setProblem(null);
          void authClient
            .$fetch("/sign-up/email", {
              method: "POST",
              body: {
                name: String(data.get("name") ?? "").trim(),
                email,
                password: String(data.get("password") ?? ""),
              },
            })
            .then(
              ({ error }) => (error ? setProblem(problemOf(error, "That didn't work; try again.")) : setSent(email)),
              () => setProblem("That didn't work; try again.")
            )
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Your name
          <input name="name" required maxLength={120} autoComplete="name" />
        </label>
        <label>
          Email
          <input name="email" type="email" required maxLength={254} autoComplete="email" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            minLength={MIN_PASSWORD}
            maxLength={128}
            autoComplete="new-password"
            aria-describedby="password-hint"
          />
        </label>
        <p className="hint" id="password-hint">
          At least {MIN_PASSWORD} characters.
        </p>
        {/* Stated, not chosen: both are on for every new account (server/auth.ts), and the account page turns one off. */}
        <div className="protections">
          <p className="protections-title" id="protections">
            Keeping your account safe
          </p>
          <ul aria-labelledby="protections">
            <li>
              <b>Two-factor authentication</b>
              <span className="hint">
                An authenticator app on your phone, set up as soon as your email is confirmed. Every sign-in then asks for its code too.
              </span>
            </li>
            <li>
              <b>Check new IP addresses</b>
              <span className="hint">A sign-in from an address you haven&apos;t used asks you by email first.</span>
            </li>
          </ul>
          <p className="hint">Both are on for every new account. You can turn either off from your account page once your email is confirmed.</p>
        </div>
        <div>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Creating it…" : "Create my account"}
          </button>
        </div>
      </form>
    </section>
  );
}
