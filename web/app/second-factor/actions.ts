"use server";
// A second factor for the session in hand: an authenticator's code or a backup code, checked by Better Auth against
// the person's own authenticator, then recorded on the session (secondFactor), as a sign-in with one would have. Five
// wrong codes (for the person, from anywhere) end the session and lock codes for 15 minutes (code-attempts.ts).
import { redirect } from "next/navigation";
import { pendingStep } from "../../server/access.ts";
import { auth } from "../../server/auth.ts";
import { CODE_TRIES, clearCodeAttempts, takeCodeAttempt } from "../../server/code-attempts.ts";
import { authHeaders as headers, getViewer, record, STEP_PAGE } from "../../server/viewer.ts";

export interface StepUpState {
  error: string | null;
  backup: boolean;
}

export async function stepUpAction(_previous: StepUpState, form: FormData): Promise<StepUpState> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step !== "second-factor") redirect(step ? STEP_PAGE[step] : "/");
  const backup = form.get("kind") === "backup";
  const code = String(form.get("code") ?? "").replace(/[\s-]+/g, "");
  if (!code) return { error: backup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator.", backup };
  const requestHeaders = await headers();
  const current = await auth().api.getSession({ headers: requestHeaders });
  if (!current) redirect("/sign-in");
  const how = backup ? "backup code" : "authenticator code";
  if (!(await takeCodeAttempt(viewer.userId))) {
    await record(viewer, {
      action: "second-factor",
      outcome: "refused",
      detail: `${how}: ${CODE_TRIES} wrong codes; locked 15 minutes, the session ended`,
    });
    await (await auth().$context).internalAdapter.deleteSession(current.session.token);
    redirect("/sign-in");
  }
  try {
    if (backup) await auth().api.verifyBackupCode({ body: { code }, headers: requestHeaders });
    else await auth().api.verifyTOTP({ body: { code }, headers: requestHeaders });
  } catch {
    await record(viewer, { action: "second-factor", outcome: "failed", detail: how });
    return { error: backup ? "That backup code isn't right, or it's been used." : "That code isn't right. Codes change every 30 seconds.", backup };
  }
  await clearCodeAttempts(viewer.userId);
  await (await auth().$context).internalAdapter.updateSession(current.session.token, { secondFactor: true });
  await record(viewer, { action: "second-factor", outcome: "ok", detail: how });
  redirect("/");
}
