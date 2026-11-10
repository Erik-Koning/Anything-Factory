"use client";
// Turning on an authenticator: the password first for an account that has one, a QR code to scan (or a key to type), a
// code from the app to prove it, then the backup codes, shown once. It stays mounted once the authenticator is on (the
// page re-renders in the same round trip), so the codes stay on screen until they're put away; then it shows what the
// page gives it for an authenticator that's on. On the account page, and at /welcome for someone who asked for one as
// they signed up: there the codes are put away by going on to `next`.
import { type ReactNode, useActionState, useEffect, useRef, useState } from "react";
import { type AuthenticatorState, authenticatorAction } from "./actions.ts";

const IDLE: AuthenticatorState = { stage: "idle", error: null, qr: null, key: null, backupCodes: [] };

export function AuthenticatorSetup({
  enabled,
  password,
  next,
  children,
}: {
  enabled: boolean;
  // The account has a password, asked for before the key is made.
  password: boolean;
  // Where "Continue" leads once the codes are kept; without it they're put away in place.
  next?: string;
  children: ReactNode;
}) {
  const [state, action, pending] = useActionState(authenticatorAction, IDLE);
  const [kept, setKept] = useState(false);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.error) alert.current?.focus();
  }, [state]);
  const problem = state.error ? (
    <p className="notice error" role="alert" tabIndex={-1} ref={alert}>
      {state.error}
    </p>
  ) : null;
  if (state.stage === "done" && !kept)
    return (
      <div className="notice ok" role="status">
        <p>Your authenticator is on. From now on every sign-in also asks for its code.</p>
        {state.backupCodes.length ? (
          <>
            <p>Your backup codes: keep them somewhere safe. Each works once, when the authenticator isn&apos;t at hand.</p>
            <div className="codes">
              {state.backupCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
          </>
        ) : null}
        <p>
          {next ? (
            <a className="button primary" href={next}>
              Continue
            </a>
          ) : (
            <button type="button" onClick={() => setKept(true)}>
              I&apos;ve kept them
            </button>
          )}
        </p>
      </div>
    );
  if (enabled) return <>{children}</>;
  if (state.stage === "scan")
    return (
      <form action={action} className="stack">
        {problem}
        <input type="hidden" name="step" value="confirm" />
        <p>Scan this with your authenticator app (1Password, Google Authenticator, Authy…), then enter the code it shows.</p>
        {/* The QR code is an SVG the server made from the app's own otpauth link. */}
        <div className="qr" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: state.qr ?? "" }} />
        <p className="hint">
          Can&apos;t scan it? Type this key instead: <code className="key">{state.key}</code>
        </p>
        <label>
          6-digit code
          <input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} />
        </label>
        <div>
          <button type="submit" className="primary" disabled={pending}>
            {pending ? "Checking…" : "Turn it on"}
          </button>
        </div>
      </form>
    );
  return (
    <form action={action} className="stack">
      {problem}
      <p className="hint">A second factor: every sign-in then also asks for a code from an app on your phone.</p>
      <input type="hidden" name="step" value="start" />
      {password ? (
        <label>
          Your password
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
      ) : null}
      <div>
        {/* On the way in (/welcome) this is the page's one step; on the account page, one thing among several. */}
        <button type="submit" className={next ? "primary" : undefined} disabled={pending}>
          {pending ? "Setting up…" : "Set up an authenticator"}
        </button>
      </div>
    </form>
  );
}
