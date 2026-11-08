// A linked machine unlinks itself (a6g disconnect app), with its token: the token stops working, and the machine
// leaves its person's Machines page.
import { audit } from "../../../../server/audit.ts";
import { answer, bearerMachine, fromCdn, ipOf, unknownMachine } from "../../../../server/machine-api.ts";
import { unlinkMachine } from "../../../../server/machines.ts";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request): Promise<Response> {
  if (!fromCdn(request)) return new Response("Not here.", { status: 403 });
  const machine = (await bearerMachine(request))?.machine;
  if (!machine || !(await unlinkMachine(machine.id, machine.userId))) return unknownMachine();
  await audit({
    action: "machine.unlinked",
    outcome: "ok",
    userId: machine.userId,
    email: null,
    ip: ipOf(request),
    userAgent: request.headers.get("user-agent"),
    target: machine.name,
    detail: "by the machine (a6g disconnect app)",
  });
  return answer(null, 204);
}
