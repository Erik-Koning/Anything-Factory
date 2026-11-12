"use client";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { authClient, problemOf } from "../auth-client.ts";
import { lastFirstName } from "../first-name.ts";
import { TeamAtWork } from "./team-at-work.tsx";

type Step = "choose" | "sent" | "code";
type Method = "link" | "password" | "passkey";

// The ways in, in the toggle's order: its word there, the heading over what it takes, what to know, and its button.
const METHODS: { id: Method; label: string; title: string; about: string; go: string }[] = [
  {
    id: "link",
    label: "Email link",
    title: "With a link by email",
    about: "Admins never get a link by email: they sign in with a passkey, or a password and their authenticator's code.",
    go: "Email me a link",
  },
  {
    id: "password",
    label: "Password",
    title: "With your password",
    about: "If you signed up with one. Your authenticator's code comes next when you have one.",
    go: "Continue",
  },
  {
    id: "passkey",
    label: "Passkey",
    title: "With a passkey",
    about: "Your device's fingerprint, face or PIN. Add one from your account page once you're in.",
    go: "Sign in with a passkey",
  },
];

// The sign-in page under the top bar: a team at work drawn on the sheet, what the page is asking at the foot of it,
// and a bar along the bottom with the way in on its left and what that way takes on its right. `problem` is what the
// page was opened with (a link that didn't work), said until the next try.
export function SignInForm({ next, problem: opened }: { next: string; problem: string | null }) {
  const [step, setStep] = useState<Step>("choose");
  const [method, setMethod] = useState<Method>("link");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(opened);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState(false);
  // Whoever signed in last in this browser, greeted by their first name: only the browser knows it (first-name.ts),
  // so the greeting comes once the page is up.
  const [name, setName] = useState<string | null>(null);
  useEffect(() => setName(lastFirstName()), []);
  const how = METHODS.find(({ id }) => id === method) ?? METHODS[0]!;
  const done = () => window.location.assign(next);
  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That didn't work; try again.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void attempt(async () => {
      if (step === "code") {
        const { error } = backup
          ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
          : await authClient.twoFactor.verifyTotp({ code: code.trim() });
        if (error) throw new Error(problemOf(error, "That code isn't right."));
        return done();
      }
      if (method === "passkey") {
        const result = await authClient.signIn.passkey();
        if (result?.error) throw new Error(problemOf(result.error, "No passkey signed you in."));
        return done();
      }
      if (method === "link") {
        const { error } = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: next, errorCallbackURL: "/sign-in" });
        if (error) throw new Error(problemOf(error, "That didn't send; try again."));
        return setStep("sent");
      }
      const { data: result, error } = await authClient.signIn.email({ email: email.trim(), password });
      // The password was right, the address not confirmed yet: the link has been sent again, unless one went in
      // the last minute (server/auth.ts).
      if (error?.code === "EMAIL_NOT_VERIFIED") throw new Error("Confirm your email first: we've sent you a link. It works once, for an hour.");
      if (error) throw new Error(problemOf(error, "That email and password don't match."));
      if (result && "twoFactorRedirect" in result && result.twoFactorRedirect) return setStep("code");
      done();
    });
  };

  return (
    <div className="sign-in">
      <TeamAtWork />
      <div className="sign-in-context">
        <div className="sign-in-what" aria-live="polite">
          {step === "sent" ? (
            <>
              <h1>Check your email</h1>
              <p className="lede">If that address has an account, a sign-in link is on its way. It works once, for 15 minutes.</p>
            </>
          ) : step === "code" ? (
            <>
              <h1 id="sign-in-how">{backup ? "A backup code" : "Your authenticator's code"}</h1>
              <p className="lede">
                {backup
                  ? "One of the codes you kept when you set up your authenticator. Each works once."
                  : "The six digits your authenticator app shows now."}
              </p>
            </>
          ) : (
            <>
              <h1 className={name ? "greeting named" : "greeting"}>
                <span aria-hidden={name ? true : undefined}>Sign in</span>
                {name ? <span>Welcome back, {name}</span> : null}
              </h1>
              <p className="lede">Use the address you were invited with or signed up with.</p>
              <p className="lede">
                No account yet? <Link href="/sign-up">Create one</Link>
              </p>
            </>
          )}
        </div>
        <div className="sign-in-how">
          <div aria-live="polite">
            {step === "sent" ? (
              <p className="hint">
                An admin gets a note in place of the link: admins sign in with a passkey, or a password and their authenticator&apos;s code.
              </p>
            ) : step === "choose" ? (
              <div key={method} className="sign-in-swap">
                <h2 id="sign-in-how">{how.title}</h2>
                <p className="hint">{how.about}</p>
                {method === "password" ? (
                  <p className="hint">
                    <Link href="/forgot-password">Forgot your password?</Link>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          {problem ? (
            <p className="notice error" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      </div>
      <form className="sign-in-bar" onSubmit={submit}>
        {step === "sent" ? (
          <div className="sign-in-bar-inner">
            <p className="sign-in-readout">
              <span>Link for</span> {email.trim()}
            </p>
            <button type="button" className="quiet" onClick={() => setStep("choose")}>
              Use another way
            </button>
          </div>
        ) : (
          <div className="sign-in-bar-inner">
            {step === "code" ? (
              <fieldset>
                <legend className="sr">The code is from</legend>
                <div className="segmented">
                  {[false, true].map((kind) => (
                    <label key={String(kind)}>
                      <input
                        type="radio"
                        name="kind"
                        checked={backup === kind}
                        onChange={() => {
                          setBackup(kind);
                          setCode("");
                        }}
                      />
                      <span>{kind ? "Backup code" : "Authenticator"}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <fieldset>
                <legend className="sr">Sign in with</legend>
                <div className="segmented">
                  {METHODS.map(({ id, label }) => (
                    <label key={id}>
                      <input
                        type="radio"
                        name="method"
                        checked={method === id}
                        onChange={() => {
                          setMethod(id);
                          setPassword("");
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="sign-in-fields" role="group" aria-labelledby="sign-in-how">
              {step === "code" ? (
                <label key="code">
                  <span>{backup ? "Backup code" : "6-digit code"}</span>
                  <input
                    name="code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode={backup ? "text" : "numeric"}
                    pattern={backup ? undefined : "[0-9]{6}"}
                    maxLength={backup ? 32 : 6}
                  />
                </label>
              ) : (
                // Both fields stay in the bar, so that one the chosen way doesn't take can close up and open again:
                // closed, it's out of reach and out of the form.
                <>
                  <label key="email" className={method === "passkey" ? "off" : undefined} inert={method === "passkey"}>
                    <span>Email</span>
                    <input
                      name="email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                      disabled={method === "passkey"}
                      autoComplete={method === "password" ? "username" : "email"}
                    />
                  </label>
                  <label key="password" className={method === "password" ? undefined : "off"} inert={method !== "password"}>
                    <span>Password</span>
                    <input
                      name="password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      disabled={method !== "password"}
                      autoComplete="current-password"
                    />
                  </label>
                </>
              )}
              <button type="submit" className="primary" disabled={busy}>
                {step === "code" ? (
                  "Verify"
                ) : (
                  <span className="sign-in-go">
                    {METHODS.map(({ id, go }) => (
                      <span key={id} className={id === method ? undefined : "off"} aria-hidden={id === method ? undefined : true}>
                        {go}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
