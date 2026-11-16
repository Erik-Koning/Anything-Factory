// What the session in hand must still do before anything opens (server/access.ts pendingStep), for a page that waits
// on it: the confirm-sign-in page asks every few seconds and goes on by itself once the email's "Yes, it was me" is in.
// Signed out ("It wasn't me" ends every session), it says so, and where to go.
import { pendingStep } from "../../../../server/access.ts";
import { getViewer, STEP_PAGE } from "../../../../server/viewer.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const viewer = await getViewer();
  const step = viewer ? pendingStep(viewer) : null;
  const body = viewer ? { step, next: step ? STEP_PAGE[step] : "/" } : { step: "signed-out", next: "/sign-in" };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
