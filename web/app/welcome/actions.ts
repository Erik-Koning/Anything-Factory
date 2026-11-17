"use server";
import { redirect } from "next/navigation";
import { mayPutOffAuthenticator, pendingStep } from "../../server/access.ts";
import { putOffAuthenticator } from "../../server/account-choices.ts";
import { getViewer, record, STEP_PAGE } from "../../server/viewer.ts";

// "Set it up later": the authenticator every sign-up starts with is put off for this sign-in, and the next one asks
// again; only in the account's first days (access.ts AUTHENTICATOR_GRACE_DAYS), since two-factor authentication can't
// be turned off, only set up a little later.
export async function laterAction(): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step !== "set-up-authenticator") redirect(step ? STEP_PAGE[step] : "/");
  if (!mayPutOffAuthenticator(viewer.signedUpAt)) redirect("/welcome");
  await putOffAuthenticator(viewer.userId, viewer.sessionId);
  await record(viewer, { action: "authenticator.later", outcome: "ok" });
  redirect("/");
}
