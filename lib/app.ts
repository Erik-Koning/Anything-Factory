// The web app this machine is linked to (a6g connect app, lib/fleet.ts). The Keychain holds the machine's token with
// the address it goes to, together, where the watchdog reads them without a prompt and the guard keeps agents from
// them; the address is checked again each time it's read, so the token never travels in the clear or anywhere else.
// ~/.a6g/app.json only says what the link is, for `a6g connect`. The token only reports this machine; the person's
// own sign-in never leaves their browser, and nothing here keeps their name or address. Nothing the app answers is
// acted on but a code, a token, or a refusal; its words are shown cleaned and cut short.
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  APP_PATHS,
  CLIENT_ID,
  DEVICE_GRANT,
  type LinkError,
  type LinkStart,
  type LinkToken,
  MACHINE_NAME,
  MACHINE_TOKEN,
  type MachineReport,
  normalUserCode,
  POLL_SECONDS,
  type ReportAnswer,
  shownUserCode,
  UNSHOWN,
} from "./fleet.ts";
import { forgetSecret, hasSecret, readSecret, storeSecret } from "./keychain.ts";
import { A6G_HOME, PACKAGE } from "./paths.ts";
import { readJson, writeJson } from "./util.ts";

export const APP_FILE = join(A6G_HOME, "app.json");
export const DEFAULT_APP = "https://app.a6gfactory.dev";
const KEYCHAIN = ["a6g-app", "link"] as const;
// The most of an answer the CLI reads, and of the app's words it shows.
const ANSWER_BYTES = 64 * 1024;
const SAID_CHARS = 200;

export interface AppSettings {
  url: string;
  machine: { id: string; name: string };
  linkedAt: string;
}
// What the Keychain holds: where the token goes, and the token.
export interface AppLink {
  url: string;
  token: string;
}

export const appSettings = (): AppSettings | null => readJson<AppSettings>(APP_FILE);
export const hasAppLink = (): boolean => hasSecret(...KEYCHAIN);

// The address as its origin: https, or http on this machine only (a development server), with nothing after the host.
// Null for anything else.
export function appUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "https:" || (url.protocol === "http:" && local) ? url.origin : null;
}

// The link in the Keychain, when it's one: an address appUrl allows, and a machine's token.
export function readAppLink(): AppLink | null {
  const stored = readSecret(...KEYCHAIN);
  if (!stored) return null;
  try {
    const { url, token } = JSON.parse(Buffer.from(stored, "base64url").toString("utf8")) as Partial<AppLink>;
    return typeof url === "string" && appUrl(url) === url && typeof token === "string" && MACHINE_TOKEN.test(token) ? { url, token } : null;
  } catch {
    return null;
  }
}
// Keeps the token for `url` (encoded, as the Keychain item's text takes only some characters): false when the Keychain
// wouldn't take it.
export const saveToken = (url: string, token: string): boolean =>
  appUrl(url) === url &&
  MACHINE_TOKEN.test(token) &&
  storeSecret(...KEYCHAIN, "Anything Factory: web app", Buffer.from(JSON.stringify({ url, token } satisfies AppLink)).toString("base64url"));
// Keeps a new link: false when the Keychain wouldn't take its token (then nothing is saved).
export function saveLink(url: string, link: LinkToken): boolean {
  if (!saveToken(url, link.access_token)) return false;
  writeJson(APP_FILE, { url, machine: link.machine, linkedAt: new Date().toISOString() } satisfies AppSettings);
  return true;
}
export function forgetLink(): void {
  forgetSecret(...KEYCHAIN);
  rmSync(APP_FILE, { force: true });
}

// The app's words, as the terminal and the log may show them: no control or format characters, and short.
export const cleaned = (text: string): string => {
  const plain = text.replace(new RegExp(UNSHOWN.source, "gu"), " ").replace(/\s+/g, " ").trim();
  return plain.length > SAID_CHARS ? `${plain.slice(0, SAID_CHARS - 1)}…` : plain;
};

type Answer<T> = { ok: true; body: T } | { ok: false; status: number; error: string | null; problem: string };

// One request to the app. `form` sends the body as a form, as RFC 8628's endpoints take it; otherwise JSON.
async function call<T>(
  base: string,
  path: string,
  {
    method = "POST",
    token,
    body,
    form = false,
  }: { method?: string; token?: string | null; body?: Record<string, string> | MachineReport; form?: boolean } = {}
): Promise<Answer<T>> {
  const host = new URL(base).host;
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": `a6g/${PACKAGE.version}`,
        ...(body === undefined ? {} : { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body) }),
      // A redirect could carry the token elsewhere: none is followed.
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
    return { ok: false, status: 0, error: null, problem: `${host} didn't answer (${cleaned(cause)})` };
  }
  const parsed = await readAnswer(response);
  if (response.ok) return { ok: true, body: parsed as T };
  const error = typeof parsed["error"] === "string" ? cleaned(parsed["error"]) : null;
  const said = typeof parsed["error_description"] === "string" ? cleaned(parsed["error_description"]) : error;
  return { ok: false, status: response.status, error, problem: `${host} answered ${response.status}${said ? `: ${said}` : ""}` };
}

// The answer's JSON object, read up to ANSWER_BYTES; {} for anything else.
async function readAnswer(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader || response.status === 204) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ANSWER_BYTES) {
      await reader.cancel();
      return {};
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Asks the app for a code for this machine, its user code as the person sees it (BCDF-GHJK). With `replacing`, the
// token of this machine's link so far, the new link replaces that one. The page to approve it on must be the app's own.
export async function startLink(base: string, name: string, replacing: string | null): Promise<{ link: LinkStart } | { problem: string }> {
  if (!MACHINE_NAME.test(name)) return { problem: `${name} isn't a machine name` };
  const answer = await call<LinkStart>(base, APP_PATHS.link, { body: { client_id: CLIENT_ID, name }, form: true, token: replacing });
  if (!answer.ok) return { problem: answer.problem };
  const link = answer.body;
  const code = normalUserCode(String(link.user_code));
  const sameApp = (uri: unknown): boolean => typeof uri === "string" && uri.startsWith(`${base}${APP_PATHS.approve}`) && !UNSHOWN.test(uri);
  if (
    typeof link.device_code !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(link.device_code) ||
    !code ||
    !sameApp(link.verification_uri) ||
    !sameApp(link.verification_uri_complete) ||
    !Number.isInteger(link.expires_in) ||
    !Number.isInteger(link.interval)
  )
    return { problem: `${new URL(base).host} didn't answer as the web app does` };
  return { link: { ...link, user_code: shownUserCode(code) } };
}

export type LinkOutcome = { token: LinkToken } | { refused: true } | { expired: true } | { problem: string };

// Asks every `interval` seconds (five more after each slow_down) until the person approves or refuses, or the code
// expires. `wait` is setTimeout's, for the tests.
export async function awaitLink(
  base: string,
  link: LinkStart,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<LinkOutcome> {
  let interval = Math.min(Math.max(link.interval, 1), 60);
  const until = Date.now() + Math.min(link.expires_in, 3600) * 1000;
  while (Date.now() < until) {
    await wait(interval * 1000);
    const answer = await call<LinkToken>(base, APP_PATHS.token, {
      body: { grant_type: DEVICE_GRANT, device_code: link.device_code, client_id: CLIENT_ID },
      form: true,
    });
    if (answer.ok) {
      const { access_token, machine, account } = answer.body;
      if (!MACHINE_TOKEN.test(String(access_token)) || typeof machine?.id !== "string" || !MACHINE_NAME.test(String(machine?.name)))
        return { problem: `${new URL(base).host} answered with something that isn't a machine's token` };
      return {
        token: {
          access_token,
          token_type: "Bearer",
          expires_in: Number(answer.body.expires_in) || 0,
          machine: { id: cleaned(machine.id), name: machine.name },
          account: cleaned(String(account ?? "")),
        },
      };
    }
    const error = answer.error as LinkError | null;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") interval += POLL_SECONDS;
    else if (error === "access_denied") return { refused: true };
    else if (error === "expired_token" || error === "invalid_grant") return { expired: true };
    else if (answer.status === 0 || answer.status >= 500) continue;
    else return { problem: answer.problem };
  }
  return { expired: true };
}

export type ReportOutcome =
  | { ok: true; token: string | null }
  // `unlinked`: the app no longer knows the token (an OAuth invalid_token, not any 401 on the way).
  | { ok: false; unlinked: boolean; problem: string };

// Sends the report with the machine's token. When the app answers with the token's successor, it's kept here before
// anything else, and returned.
export async function sendReport(link: AppLink, report: MachineReport): Promise<ReportOutcome> {
  const answer = await call<ReportAnswer>(link.url, APP_PATHS.report, { token: link.token, body: report });
  if (!answer.ok) return { ok: false, unlinked: answer.status === 401 && answer.error === "invalid_token", problem: answer.problem };
  const next = answer.body.access_token;
  if (next === undefined) return { ok: true, token: null };
  if (typeof next !== "string" || !MACHINE_TOKEN.test(next))
    return { ok: false, unlinked: false, problem: "the app answered with a token that isn't one" };
  if (!saveToken(link.url, next))
    return { ok: false, unlinked: false, problem: "the app sent this machine's next token, but the Keychain wouldn't take it" };
  return { ok: true, token: next };
}

// Unlinks this machine on the app: null when it's done (or the app had forgotten it already).
export async function unlinkSelf(link: AppLink): Promise<string | null> {
  const answer = await call(link.url, APP_PATHS.self, { method: "DELETE", token: link.token });
  return answer.ok || (answer.status === 401 && answer.error === "invalid_token") ? null : answer.problem;
}
