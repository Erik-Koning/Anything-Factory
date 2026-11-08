// What the machines' endpoints (app/api/machines/) share: answers that are never cached, OAuth's error shape (RFC 6749
// section 5.2, as RFC 8628 uses it), bodies read only as a form (RFC 8628's encoding) or JSON and only up to a size,
// and the machine a bearer token names. They take no cookie and set none: a browser's session can't reach them, and
// they can't reach one.
import { CLIENT_ID, type LinkError } from "../../lib/fleet.ts";
import { audit } from "./audit.ts";
import { clientIp } from "./auth.ts";
import { takeCodeAttempt } from "./code-attempts.ts";
import { config } from "./config.ts";
import { type Bearing, machineByToken } from "./machines.ts";
import { originAllowed } from "./origin-check.ts";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

export const answer = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  status === 204
    ? new Response(null, { status, headers: { ...NO_STORE, ...headers } })
    : Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

export const oauthError = (
  error: LinkError | "unsupported_grant_type" | "invalid_client" | "invalid_token" | "temporarily_unavailable",
  description: string,
  status = 400,
  headers: Record<string, string> = {}
): Response =>
  answer({ error, error_description: description }, status, { ...(status === 401 ? { "WWW-Authenticate": `Bearer error="${error}"` } : {}), ...headers });

// The request, when it came through the CDN (proxy.ts refuses any other already; this holds if it ever doesn't run).
export const fromCdn = (request: Request): boolean => originAllowed(request.headers, config().originSecret);
export const ipOf = (request: Request): string | null => clientIp(request.headers);

// The body, read up to `max` bytes: "too big" past that; null when it isn't JSON, or (with `form`) a form.
export async function readBody(request: Request, max: number, { form = false } = {}): Promise<Record<string, unknown> | null | "too big"> {
  const type = request.headers.get("content-type") ?? "";
  const json = /^application\/json\b/i.test(type);
  if (!json && !(form && /^application\/x-www-form-urlencoded\b/i.test(type))) return null;
  if (Number(request.headers.get("content-length") ?? 0) > max) return "too big";
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return "too big";
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!json) return Object.fromEntries(new URLSearchParams(text));
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const isCli = (body: Record<string, unknown>): boolean => body["client_id"] === CLIENT_ID;

// The request's bearer token (the scheme in any case, RFC 6750 section 2.1), or null.
export const bearerOf = (request: Request): string | null => /^bearer +([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;

// The machine the request's bearer token is for, or null. A token that looks like a machine's but isn't one now is
// audited, at most once per address in 15 minutes, so a flood can't fill the log.
export async function bearerMachine(request: Request): Promise<Bearing | null> {
  const token = bearerOf(request);
  if (!token) return null;
  const ip = ipOf(request);
  const found = await machineByToken(token, ip);
  if (!found && /^a6gm_/.test(token) && (await takeCodeAttempt(`machine-refused-token:${ip ?? "unknown"}`, new Date(), 1)))
    await audit({
      action: "machine.refused-token",
      outcome: "refused",
      userId: null,
      email: null,
      ip,
      userAgent: request.headers.get("user-agent"),
      detail: "a machine's token that isn't linked (unlinked, expired, replaced or made up); more from this address in 15 minutes go unrecorded",
    });
  return found;
}

export const unknownMachine = (): Response => oauthError("invalid_token", "This machine isn't linked: a6g connect app links it.", 401);
