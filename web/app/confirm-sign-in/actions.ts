"use server";
// Another confirmation email for the session in hand, at most one every ten minutes per address.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withNotice } from "../../components/ui.tsx";
import { pendingStep } from "../../server/access.ts";
import { challenge } from "../../server/known-ips.ts";
import { getViewer, STEP_PAGE } from "../../server/viewer.ts";

export async function resendAction(): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step !== "confirm-ip") redirect(step ? STEP_PAGE[step] : "/");
  const sent = await challenge({
    userId: viewer.userId,
    email: viewer.email,
    ip: viewer.ip,
    userAgent: (await headers()).get("user-agent"),
    sessionId: viewer.sessionId,
  });
  redirect(
    withNotice(
      "/confirm-sign-in",
      sent === "sent"
        ? { ok: `A new link is on its way to ${viewer.email}.` }
        : { error: "A link went out in the last ten minutes: look for it, in spam too." }
    )
  );
}
