"use server";
import { redirect } from "next/navigation";
import { pendingStep } from "../../server/access.ts";
import { putOffAuthenticator } from "../../server/account-choices.ts";
import { getViewer, record, STEP_PAGE } from "../../server/viewer.ts";

// "Set it up later": the authenticator every sign-up starts with is put off for this sign-in, and the next one asks
// again. It stays on until the person turns it off on their account page (the owner's rule: a protection every
// sign-up starts with is turned off only there).
export async function laterAction(): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step !== "set-up-authenticator") redirect(step ? STEP_PAGE[step] : "/");
  await putOffAuthenticator(viewer.userId, viewer.sessionId);
  await record(viewer, { action: "authenticator.later", outcome: "ok" });
  redirect("/");
}
