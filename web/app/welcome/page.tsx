import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SubmitButton } from "../../components/submit-button.tsx";
import { AUTHENTICATOR_GRACE_DAYS, mayPutOffAuthenticator, pendingStep } from "../../server/access.ts";
import { hasPassword } from "../../server/account-choices.ts";
import { getViewer, STEP_PAGE } from "../../server/viewer.ts";
import { AuthenticatorSetup } from "../account/authenticator.tsx";
import { SignOutButton } from "../sign-out-button.tsx";
import { laterAction } from "./actions.ts";

export const metadata: Metadata = { title: "Set up two-factor authentication" };

// Where someone who signed up lands once their email is confirmed, two-factor authentication being on for every new
// account: nothing else opens until the authenticator is on, or they say they'll do it later. The setup is the account
// page's own. It stays here once the authenticator is on, so the backup codes can be kept before going on.
export default async function WelcomePage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step && step !== "set-up-authenticator") redirect(STEP_PAGE[step]);
  if (viewer.admin || (!step && !viewer.twoFactor)) redirect("/");
  const password = await hasPassword(viewer.userId);
  return (
    <div className="narrow stack">
      <h1>Set up two-factor authentication</h1>
      <p>
        Welcome{viewer.name ? `, ${viewer.name}` : ""}. Your email is confirmed.{" "}
        {viewer.twoFactor
          ? "Your authenticator is on too: keep its backup codes somewhere safe, then go on."
          : "Two-factor authentication is on for every new account, so the next step is an authenticator app on your phone: every sign-in then asks for its code too."}
      </p>
      <section className="panel" aria-labelledby="authenticator">
        <h2 id="authenticator">Authenticator</h2>
        <AuthenticatorSetup enabled={viewer.twoFactor} password={password} next="/">
          <p className="notice ok" role="status">
            Your authenticator is on. Every sign-in asks for its code too.
          </p>
          <p>
            <a className="button primary" href="/">
              Continue
            </a>
          </p>
        </AuthenticatorSetup>
      </section>
      {viewer.twoFactor || !mayPutOffAuthenticator(viewer.signedUpAt) ? null : (
        <form action={laterAction} className="stack">
          <div>
            <SubmitButton>Set it up later</SubmitButton>
          </div>
          <p className="hint">
            We&apos;ll ask again the next time you sign in. Set it up by{" "}
            {new Date(Date.parse(viewer.signedUpAt ?? "") + AUTHENTICATOR_GRACE_DAYS * 86_400_000).toLocaleDateString("en-CA", {
              month: "long",
              day: "numeric",
            })}
            : after that, signing in asks for it before anything else. It can&apos;t be turned off once it&apos;s on.
          </p>
        </form>
      )}
      <p>
        <SignOutButton label="Sign out instead" className="linkish" />
      </p>
    </div>
  );
}
