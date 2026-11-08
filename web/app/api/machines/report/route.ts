// A linked machine's report (lib/fleet.ts), with its token: kept as the machine's latest, for the Machines page. The
// report is rebuilt from the fields it may have, and refused whole when one is wrong or it's too big. When the token is
// due for replacing, the answer carries the new one (200); otherwise there's nothing to say (204).
import { parseReport, REPORT_LIMITS } from "../../../../../lib/fleet.ts";
import { answer, bearerMachine, fromCdn, ipOf, oauthError, readBody, unknownMachine } from "../../../../server/machine-api.ts";
import { recordReport, REPORT_GAP_SECONDS } from "../../../../server/machines.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!fromCdn(request)) return new Response("Not here.", { status: 403 });
  const bearing = await bearerMachine(request);
  if (!bearing) return unknownMachine();
  const body = await readBody(request, REPORT_LIMITS.bytes);
  if (body === "too big") return oauthError("invalid_request", `A report is at most ${REPORT_LIMITS.bytes / 1024} KB.`, 413);
  const report = parseReport(body);
  if (!report) return oauthError("invalid_request", "That isn't a machine's report.");
  const kept = await recordReport(bearing, report, ipOf(request));
  if (!kept) return oauthError("slow_down", `Report at most every ${REPORT_GAP_SECONDS} seconds.`, 429, { "Retry-After": String(REPORT_GAP_SECONDS) });
  return kept.token ? answer({ access_token: kept.token }) : answer(null, 204);
}
