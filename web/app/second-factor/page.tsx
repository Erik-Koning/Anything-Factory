import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { pendingStep } from "../../server/access.ts";
import { getViewer, STEP_PAGE } from "../../server/viewer.ts";
import { SignOutButton } from "../sign-out-button.tsx";
import { StepUpForm } from "./step-up-form.tsx";

export const metadata: Metadata = { title: "Second factor needed" };

// Where a session without its second factor lands (an admin's, or anyone's who turned on an authenticator, after a
// sign-in by an email link or a passkey that didn't check it was them): nothing else opens until the code is entered.
export default async function SecondFactorPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step !== "second-factor") redirect(step ? STEP_PAGE[step] : "/");
  return (
    <div className="narrow stack">
      <h1>Enter your authenticator&apos;s code</h1>
      <p>
        {viewer.admin
          ? "You're an admin, so every session needs a second factor, and this one began without it."
          : "You've turned on an authenticator, so every session needs its code as well."}{" "}
        Enter the code it shows now, or one of your backup codes.
      </p>
      {viewer.twoFactor ? (
        <StepUpForm />
      ) : (
        <p className="notice error">This admin account has no authenticator. Run create-admin again on the operator&apos;s machine.</p>
      )}
      <p>
        <SignOutButton label="Sign out instead" className="linkish" />
      </p>
      {viewer.admin ? <p className="hint">Lost the authenticator and the backup codes? Run create-admin again on the operator&apos;s machine.</p> : null}
    </div>
  );
}
