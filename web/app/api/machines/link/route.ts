// A machine asks for a code to be linked with (a6g connect app; RFC 8628 section 3.1): the client's id and its name,
// and the token of its link so far when it has one (Authorization), which the new link then replaces. Anyone may ask,
// so each address may ask for only a few codes (machines.ts).
import { APP_PATHS, MACHINE_NAME, shownUserCode } from "../../../../../lib/fleet.ts";
import { config } from "../../../../server/config.ts";
import { answer, bearerOf, fromCdn, ipOf, isCli, oauthError, readBody } from "../../../../server/machine-api.ts";
import { startLink } from "../../../../server/machines.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!fromCdn(request)) return new Response("Not here.", { status: 403 });
  const body = await readBody(request, 1024, { form: true });
  if (body === "too big" || !body) return oauthError("invalid_request", "Send client_id and the machine's name, as a form or JSON.");
  if (!isCli(body)) return oauthError("invalid_client", "Only the a6g command line links machines.", 401);
  const name = body["name"];
  if (typeof name !== "string" || !MACHINE_NAME.test(name))
    return oauthError("invalid_request", "A machine's name: lowercase letters, digits and dashes.");
  const started = await startLink({ name, ip: ipOf(request), userAgent: request.headers.get("user-agent"), replacing: bearerOf(request) });
  if (!started) return oauthError("temporarily_unavailable", "Too many codes from this address: wait 15 minutes.", 429, { "Retry-After": "900" });
  const page = `${config().baseURL}${APP_PATHS.approve}`;
  const code = shownUserCode(started.userCode);
  return answer({
    device_code: started.deviceCode,
    user_code: code,
    verification_uri: page,
    verification_uri_complete: `${page}?code=${code}`,
    expires_in: started.expiresIn,
    interval: started.interval,
  });
}
