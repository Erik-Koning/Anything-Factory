// The CLI polls for its machine's token with the device code (RFC 8628 section 3.4): until the person approves or
// refuses the code on the Machines page, or it expires. The token is in the answer once, and never again.
import { DEVICE_GRANT, IDLE_DAYS } from "../../../../../lib/fleet.ts";
import { answer, fromCdn, ipOf, isCli, oauthError, readBody } from "../../../../server/machine-api.ts";
import { redeemLink } from "../../../../server/machines.ts";

export const dynamic = "force-dynamic";

const WHY = {
  authorization_pending: "Waiting for the person to approve the code.",
  slow_down: "Asking too often: wait five seconds more between polls.",
  access_denied: "The code was refused, or the person may not link another machine.",
  expired_token: "The code expired: ask for another.",
  invalid_request: "Send grant_type, client_id and device_code, as a form or JSON.",
  invalid_grant: "That isn't a code this app gave, or it was used already.",
} as const;

export async function POST(request: Request): Promise<Response> {
  if (!fromCdn(request)) return new Response("Not here.", { status: 403 });
  const body = await readBody(request, 1024, { form: true });
  if (body === "too big" || !body) return oauthError("invalid_request", WHY.invalid_request);
  if (!isCli(body)) return oauthError("invalid_client", "Only the a6g command line links machines.", 401);
  if (body["grant_type"] !== DEVICE_GRANT) return oauthError("unsupported_grant_type", `Only ${DEVICE_GRANT}.`);
  const deviceCode = body["device_code"];
  if (typeof deviceCode !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(deviceCode)) return oauthError("invalid_grant", WHY.invalid_grant);
  const result = await redeemLink(deviceCode, { ip: ipOf(request), userAgent: request.headers.get("user-agent") });
  if ("error" in result) return oauthError(result.error, WHY[result.error]);
  return answer({
    access_token: result.token,
    token_type: "Bearer",
    expires_in: IDLE_DAYS * 86_400,
    machine: { id: result.machine.id, name: result.machine.name },
    account: result.account,
  });
}
