"use server";
import { redirect } from "next/navigation";
import { pendingStep } from "../../server/access.ts";
import { setAuthenticatorDue } from "../../server/account-choices.ts";
import { getViewer, record, STEP_PAGE } from "../../server/viewer.ts";

// "Set it up later": the authenticator asked for at sign-up is no longer due. It can be turned on from the account
// page whenever they like.
export async function laterAction(): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step !== "set-up-authenticator") redirect(step ? STEP_PAGE[step] : "/");
  await setAuthenticatorDue(viewer.userId, false);
  await record(viewer, { action: "authenticator.later", outcome: "ok" });
  redirect("/");
}
