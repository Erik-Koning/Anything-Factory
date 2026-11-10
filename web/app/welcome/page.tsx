import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SubmitButton } from "../../components/submit-button.tsx";
import { pendingStep } from "../../server/access.ts";
import { hasPassword } from "../../server/account-choices.ts";
import { getViewer, STEP_PAGE } from "../../server/viewer.ts";
import { AuthenticatorSetup } from "../account/authenticator.tsx";
import { SignOutButton } from "../sign-out-button.tsx";
import { laterAction } from "./actions.ts";

export const metadata: Metadata = { title: "Set up two-factor authentication" };

// Where someone who chose two-factor authentication as they signed up lands once their email is confirmed: nothing
// else opens until the authenticator is on, or they say they'll do it later. The setup is the account page's own. It
// stays here once the authenticator is on, so the backup codes can be kept before going on.
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
          : "You chose two-factor authentication as you signed up, so the next step is an authenticator app on your phone: every sign-in then asks for its code too."}
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
      {viewer.twoFactor ? null : (
        <form action={laterAction} className="stack">
          <div>
            <SubmitButton>Set it up later</SubmitButton>
          </div>
          <p className="hint">You can turn it on from your account page whenever you like.</p>
        </form>
      )}
      <p>
        <SignOutButton label="Sign out instead" className="linkish" />
      </p>
    </div>
  );
}
