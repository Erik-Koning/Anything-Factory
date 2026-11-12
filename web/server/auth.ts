// Accounts and sign-in (Better Auth, on the app's own database).
//
// Anyone may sign up, with an email address and a password of 12 characters or more. Nothing opens until the address
// is confirmed: the sign-up emails a link, good for an hour, and opening it confirms the address and signs the person
// in, once. A password sign-in before that is refused and sends the link again. A sign-up for an address that already
// has an account answers exactly as a new one does, in the same time, and tells the address's owner by email instead.
// What a sign-up may set is a name, an address, a password and the two choices below: never a role, a ban, a second
// factor or "confirmed". An admin can also invite someone to a team (admin/people): an account with no password, which
// signs in by link. A new account is on no team until an admin puts it on one.
//
// The two choices on the sign-up page, both on unless unticked, are kept on the account (authenticatorDue, ipCheck).
// They're read from the sign-up's body here, as the account is made, and changed afterwards only by the app's own
// server actions (account-choices.ts): no endpoint takes either.
//   - Two-factor authentication: the person sets up an authenticator app as soon as their address is confirmed
//     (/welcome), or puts it off there.
//   - Check new IP addresses: a sign-in from an address they haven't used asks them by email first (below).
// An account whose address is first proven by a sign-in link, not its confirmation link, loses the password it was
// signed up with (Better Auth's rule: whoever chose it hadn't proven the inbox) and has its IP check on.
//
// Everyone signs in with a passkey, a magic link by email, or their password when they have one. Admins sign in with
// two factors, by design:
//   - a password and an authenticator code (or one of their backup codes), enrolled by `npm run create-admin` on the
//     operator's own machine, so an admin account never exists without its authenticator; or
//   - a passkey whose authenticator verified the person (a PIN or biometrics: something they have and something they
//     know or are). A passkey that didn't verify them gives no second factor.
//   - never a link by email: no sign-in link is sent to an admin, and a session from one, or from a confirmation link,
//     is refused for an admin. Nobody becomes an admin by signing up.
// Anyone else may turn on an authenticator too (as they sign up, or from the account page); from then on their
// sessions need its code as well, whichever way they signed in.
// A forgotten password is set again from a link by email (password-reset.ts): the link signs nobody in, an account
// with an authenticator gives its code as well, so an admin's inbox alone changes nothing, and every session of the
// account ends. Asking answers the same for every address; the app's own page sets the password, never an endpoint here.
// Each session records whether it began with a second factor (session.secondFactor, set here as it's made and never
// by the client; a code entered later sets it, second-factor/actions.ts). Every page and server action checks it on
// the server (viewer.ts, access.ts), and over HTTP a session without it can only sign out or sign in again (the guard
// below), so it can't enrol a passkey or new backup codes to raise itself.
//
// Every session also records its IP address, as the CDN in front of the app reports it (CLIENT_IP_HEADER, trusted
// because the app refuses requests without the CDN's ORIGIN_SECRET, proxy.ts). A session used from an address its
// person hasn't confirmed can do nothing until they confirm it from an email (known-ips.ts); a sign-in link or a
// confirmation link confirms the address it's opened from. An admin's addresses are always checked; anyone else may
// turn the check off for their own account (access.ts checksIp). Sign-ups, sign-ins, failures, sign-outs and changes
// to passkeys and backup codes go to the audit log (audit.ts).
//
// Better Auth's own admin endpoints aren't served over HTTP at all: the app calls them from its server actions, after
// its own checks.
import { getIP } from "@better-auth/core/utils/ip";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin, magicLink, twoFactor } from "better-auth/plugins";
import { checksIp } from "./access.ts";
import { audit } from "./audit.ts";
import { ensureAuthIndexes } from "./auth-indexes.ts";
import { config } from "./config.ts";
import { mongo } from "./db.ts";
import { originAllowed } from "./origin-check.ts";
import { challenge, isKnownIp, rememberIp } from "./known-ips.ts";
import { sendMail } from "./mail.ts";

// How long every answer that may send an email takes, sent or not (a sign-in link, a sign-up, a confirmation asked for
// again); the names of teams, as the factory makes them.
const SEND_TIME_MS = 1500;
const TEAM_NAME = /^[a-z][a-z0-9-]{0,30}$/;

export const isAdminRole = (role: unknown): boolean => typeof role === "string" && role.split(",").includes("admin");

// The paths whose new session began with a second factor (a passkey only when it verified the person).
const SECOND_FACTOR = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const PASSKEY_SIGN_IN = "/passkey/verify-authentication";
// A password sign-in for someone with an authenticator makes a session the two-factor plugin deletes at once, while
// it waits for the code: a placeholder, which nothing here records or asks about. The code's own session is the one.
const PASSWORD_SIGN_IN = "/sign-in/email";
// Signing up, the confirmation link it emails (which signs the person in), and asking for that link again.
const SIGN_UP = "/sign-up/email";
const VERIFY_EMAIL = "/verify-email";
const SEND_CONFIRMATION = "/send-verification-email";
// Where a confirmation link lands: on to the app when it signed the person in, the reason when it didn't.
const CONFIRMED_PAGE = "/sign-up/confirmed";
// Asking for a link to set a new password, and the page the link opens (password-reset.ts sets it from there).
const ASK_RESET = "/request-password-reset";
const RESET_PAGE = "/reset-password";
// The links that sign someone in by proving their inbox.
const EMAIL_LINK = new Set(["/magic-link/verify", VERIFY_EMAIL]);
// What an admin who can't get in is told, wherever an email says how they sign in.
const LOCKED_OUT =
  "Forgot your password? Set a new one from the sign-in page, with your authenticator's code. Without the authenticator, whoever runs this site can start your account afresh with npm run create-admin.";

// Whether a new IP address is checked for this account (access.ts checksIp): accounts from before the choice read as on.
function checksIpOf(user: object | null | undefined): boolean {
  const { role, ipCheck } = (user ?? {}) as { role?: unknown; ipCheck?: unknown };
  return checksIp({ admin: isAdminRole(role), ipCheck: ipCheck !== false });
}

// Why a request failed, for the audit log. A link's own endpoint answers with a redirect either way: only one that
// carries an error failed (null otherwise).
function failureOf(returned: APIError): string | null {
  if (returned.status !== "FOUND") return returned.message || String(returned.status);
  const to = new Headers(returned.headers as HeadersInit).get("location");
  return to ? new URL(to, "http://local").searchParams.get("error") : null;
}

// Each sign-up, and each confirmation asked for again, from the guard below to the audit after it: when it began, so
// its answer takes the same time whatever happened, and the account it made, if it made one.
const mailed = new WeakMap<Request, { started: number; created: { id: string; email: string } | null }>();
const settle = (started: number): Promise<void> => new Promise((done) => setTimeout(done, Math.max(0, SEND_TIME_MS - (Date.now() - started))));

// Whether a passkey assertion says the authenticator verified the person: the UV bit (0x04) of the flags byte that
// follows the 32-byte RP ID hash in authenticatorData. By the time a session is made, the passkey plugin has verified
// the signature over these bytes.
export function userVerified(response: unknown): boolean {
  const data = (response as { response?: { authenticatorData?: unknown } } | null)?.response?.authenticatorData;
  if (typeof data !== "string") return false;
  const bytes = Buffer.from(data, "base64url");
  return bytes.length > 32 && ((bytes[32] ?? 0) & 0x04) !== 0;
}

// How each path signs someone in, for the audit log.
const SIGN_IN_METHOD: Record<string, string> = {
  [PASSWORD_SIGN_IN]: "password",
  "/two-factor/verify-totp": "password and authenticator",
  "/two-factor/verify-backup-code": "password and backup code",
  [PASSKEY_SIGN_IN]: "passkey",
  "/magic-link/verify": "email link",
  [VERIFY_EMAIL]: "email confirmed",
};

// How a session someone ended was ended, for the audit log.
const SESSION_ENDED_BY: Record<string, string> = {
  "/sign-out": "signed out",
  "/revoke-session": "ended from the account page",
  "/revoke-other-sessions": "ended from another session's account page",
  "/revoke-sessions": "every session ended",
  "/admin/ban-user": "banned by an admin",
  "/admin/revoke-user-session": "ended by an admin",
  "/admin/revoke-user-sessions": "ended by an admin",
};

// What a session that still owes a second factor or an IP confirmation may do over HTTP: look at itself, sign out,
// sign in again.
const OPEN_WHILE_PENDING = new Set([
  "/get-session",
  "/sign-out",
  "/ok",
  "/error",
  "/passkey/generate-authenticate-options",
  PASSKEY_SIGN_IN,
  // A new sign-in link, opened in a browser whose session is waiting: it makes a new session, at the address it's opened.
  "/magic-link/verify",
  // Signing up needs no session, and its confirmation link makes one of its own.
  SIGN_UP,
  VERIFY_EMAIL,
  // Nor does asking for a link to set a new password: whatever session the browser holds, the email goes or doesn't.
  ASK_RESET,
]);
const openWhilePending = (path: string): boolean => OPEN_WHILE_PENDING.has(path) || path.startsWith("/sign-in/") || path.startsWith("/two-factor/verify-");
// Never over HTTP, for anyone: the admin plugin's endpoints (the app calls them from its own server actions); turning
// the authenticator on or off, reading its secret, and making new backup codes (the account page does them, each with
// a current code, so a stolen session can't copy or replace the second factor); and setting a new password from an
// emailed link, which the app's own page does after asking for the authenticator's code (password-reset.ts).
const SERVER_ONLY = (path: string): boolean =>
  path.startsWith("/admin/") ||
  path === "/reset-password" ||
  path.startsWith("/reset-password/") ||
  ["/two-factor/enable", "/two-factor/disable", "/two-factor/get-totp-uri", "/two-factor/generate-backup-codes"].includes(path);

function makeAuth() {
  const { baseURL, secret, authDatabase } = config();
  const client = mongo();
  void ensureAuthIndexes(client.db(authDatabase));
  return betterAuth({
    appName: "Anything Factory",
    baseURL,
    basePath: "/api/auth",
    secret,
    database: mongodbAdapter(client.db(authDatabase), { client }),
    // Anyone signs up; nobody is signed in before their address is confirmed.
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      requireEmailVerification: true,
      autoSignIn: false,
      onExistingUserSignUp: async ({ user }) => tellKnown(user),
      // A forgotten password: a link by email, good once, for 30 minutes. Using it ends every session of the account.
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => sendReset(user, token),
    },
    // Only a digest of a password link's token is kept, as with a sign-in link's: whoever reads the database can't
    // use one. (The key is the start of the name Better Auth files the token under.)
    verification: { storeIdentifier: { default: "plain", overrides: { "reset-password:": "hashed" } } },
    // The confirmation: emailed as someone signs up, and again when they try their password before confirming. Its
    // link works for an hour and signs them in the once.
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, token }) => sendConfirmation(user, token),
    },
    // The two choices made on the sign-up page. Not input: no endpoint's body sets them (the hook below reads the
    // sign-up's own two keys), and the app's server actions change them (account-choices.ts).
    user: {
      additionalFields: {
        authenticatorDue: { type: "boolean", required: false, defaultValue: false, input: false },
        ipCheck: { type: "boolean", required: false, defaultValue: true, input: false },
      },
    },
    // The viewer's address, from the one header the CDN sets (and nobody else can, proxy.ts): sessions record it, rate
    // limits count by it, and the new-IP check compares it. IPv6 by its /64.
    advanced: { ipAddress: { ipAddressHeaders: [config().ipHeader], ipv6Subnet: 64 } },
    session: {
      additionalFields: { secondFactor: { type: "boolean", required: false, defaultValue: false, input: false } },
    },
    // Kept in the database, so the limits hold across serverless instances.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        [SIGN_UP]: { window: 60, max: 3 },
        [SEND_CONFIRMATION]: { window: 60, max: 3 },
        [ASK_RESET]: { window: 60, max: 3 },
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-in/magic-link": { window: 60, max: 5 },
        "/two-factor/*": { window: 60, max: 5 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // The sign-up page's two choices, on unless its box was unticked. Only a sign-up's: an account an admin
          // invites, or create-admin makes, has the defaults (the IP check on, no authenticator due).
          before: async (user, ctx) => {
            if (ctx?.path !== SIGN_UP) return;
            const body = (ctx.body ?? {}) as { setUpAuthenticator?: unknown; checkNewIps?: unknown };
            return { data: { ...user, authenticatorDue: body.setUpAuthenticator !== false, ipCheck: body.checkNewIps !== false } };
          },
          after: async (user, ctx) => {
            const mark = ctx?.request ? mailed.get(ctx.request) : undefined;
            if (mark && ctx?.path === SIGN_UP) mark.created = { id: user.id, email: user.email };
          },
        },
        update: {
          // An address first proven by a sign-in link, not its confirmation link: whoever signed up with it hadn't
          // proven the inbox, so their choice to leave new IP addresses unchecked goes with their password.
          before: async (changes, ctx) => {
            if (ctx?.path === "/magic-link/verify" && changes.emailVerified === true) return { data: { ...changes, ipCheck: true } };
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const path = ctx?.path ?? "";
            if (EMAIL_LINK.has(path)) {
              const user = await ctx?.context.internalAdapter.findUserById(session.userId);
              // Admins never sign in by a link, a confirmation's included: no session from one.
              if (isAdminRole((user as { role?: unknown } | null)?.role)) return false;
            }
            const secondFactor = SECOND_FACTOR.has(path) || (path === PASSKEY_SIGN_IN && userVerified((ctx?.body as { response?: unknown })?.response));
            return { data: { ...session, secondFactor } };
          },
          // A new session from an address its person hasn't confirmed: they're asked by email, unless they've turned
          // the check off (never an admin). An email link's own session, a sign-in link's or a confirmation's,
          // confirms where it was opened. Only sessions made by a request over HTTP: the ones the app's own
          // server code makes (create-admin's, the one Better Auth swaps in when an authenticator is turned on, from a
          // session already at a confirmed address) are asked about where they're used, like any other.
          after: async (session, ctx) => {
            if (!ctx?.request) return;
            const ip = (session as { ipAddress?: string | null }).ipAddress || null;
            if (EMAIL_LINK.has(ctx.path)) return rememberIp(session.userId, ip, "email link");
            if (await isKnownIp(session.userId, ip)) return;
            const user = await ctx.context.internalAdapter.findUserById(session.userId);
            if (!checksIpOf(user)) return;
            if ((user as { twoFactorEnabled?: boolean } | null)?.twoFactorEnabled && ctx.path === PASSWORD_SIGN_IN) return;
            if (user)
              await challenge({
                userId: user.id,
                email: user.email,
                ip,
                userAgent: (session as { userAgent?: string | null }).userAgent ?? null,
                sessionId: session.id,
              });
          },
        },
        // Sessions someone ended: signing out, ending one or the others from the account page, a ban. Not the ones
        // Better Auth swaps or clears itself, nor create-admin's; "it wasn't me" records its own (ip.denied).
        delete: {
          after: async (session, ctx) => {
            const how = ctx?.path ? SESSION_ENDED_BY[ctx.path] : undefined;
            if (!ctx || !how) return;
            const user = await ctx.context.internalAdapter.findUserById(session.userId).catch(() => null);
            const from = ctx.request?.headers ?? ctx.headers;
            await audit({
              action: ctx.path === "/sign-out" ? "sign-out" : "session.ended",
              outcome: "ok",
              userId: session.userId,
              email: user?.email ?? null,
              ip: from ? getIP(from, ctx.context.options) : null,
              userAgent: from?.get("user-agent") ?? null,
              sessionId: session.id,
              detail: how,
            });
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Only requests over HTTP: the app's own server code calls the API after its own checks.
        if (!ctx.request) return;
        // Through the CDN only, here as well as in proxy.ts, so the viewer-IP header can't come from anyone else.
        if (!originAllowed(ctx.request.headers, config().originSecret)) throw new APIError("FORBIDDEN", { message: "Not here." });
        if (SERVER_ONLY(ctx.path)) throw new APIError("FORBIDDEN", { message: "Not available." });
        // No device is trusted to skip the second factor: every sign-in asks for it.
        if ((ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice)
          throw new APIError("BAD_REQUEST", { message: "Devices aren't trusted here." });
        // A session never checks codes over HTTP (the second-factor page does, counting each try, code-attempts.ts):
        // only a password's second step, which has no session yet, uses Better Auth's verify endpoints.
        if (ctx.path.startsWith("/two-factor/") && (await getSessionFromCtx(ctx)))
          throw new APIError("FORBIDDEN", { message: "Enter your code on the second-factor page." });
        // A person's or a passkey's name is shown to the admin: short, whatever the endpoint lets through.
        const name = (ctx.body as { name?: unknown } | undefined)?.name;
        if (typeof name === "string" && name.length > 120) throw new APIError("BAD_REQUEST", { message: "Keep the name under 120 characters." });
        if (ctx.path === SIGN_UP && (typeof name !== "string" || !name.trim())) throw new APIError("BAD_REQUEST", { message: "Tell us your name." });
        if (ctx.path === SIGN_UP || ctx.path === SEND_CONFIRMATION || ctx.path === ASK_RESET)
          mailed.set(ctx.request, { started: Date.now(), created: null });
        if (openWhilePending(ctx.path)) return;
        const current = await getSessionFromCtx(ctx);
        if (current && (isAdminRole(current.user.role) || current.user.twoFactorEnabled === true) && current.session.secondFactor !== true)
          throw new APIError("FORBIDDEN", { message: "Enter your authenticator's code first." });
        if (current && checksIpOf(current.user) && !(await isKnownIp(current.user.id, getIP(ctx.request, ctx.context.options))))
          throw new APIError("FORBIDDEN", { message: "Confirm this sign-in from the email we sent first." });
        // A new passkey for an admin needs a sign-in from the last ten minutes, so a stolen session can't make itself last.
        if (current && isAdminRole(current.user.role) && ctx.path.startsWith("/passkey/generate-register-options"))
          if (Date.now() - new Date(current.session.createdAt).getTime() > 10 * 60_000)
            throw new APIError("FORBIDDEN", { message: "Sign in again, then add the passkey within ten minutes." });
      }),
      // The audit log, for what's done over HTTP; the app's server actions record their own.
      after: createAuthMiddleware(async (ctx) => {
        if (!ctx.request) return;
        const returned = ctx.context.returned;
        // Better Auth's own test: what's wrong with a body's shape is thrown as its router's error, not as APIError here.
        const failed = isAPIError(returned);
        const fresh = ctx.context.newSession;
        const from = { ip: getIP(ctx.request, ctx.context.options), userAgent: ctx.request.headers.get("user-agent") };
        const body = (ctx.body ?? {}) as { email?: unknown; name?: unknown };
        const typed = typeof body.email === "string" ? body.email : null;
        const method = SIGN_IN_METHOD[ctx.path];
        // The placeholder session of a password that still needs its code: the code's step records the sign-in.
        if (ctx.path === PASSWORD_SIGN_IN && fresh?.user.twoFactorEnabled) return;
        if (method && fresh) {
          const verified = ctx.path === PASSKEY_SIGN_IN && (fresh.session as { secondFactor?: boolean }).secondFactor === true;
          await audit({
            action: "sign-in",
            outcome: "ok",
            userId: fresh.user.id,
            email: fresh.user.email,
            ...from,
            sessionId: fresh.session.id,
            detail: verified ? `${method}, verified with a PIN or biometrics` : method,
          });
        } else if (method && failed) {
          // A link opened again after it worked only sends its person on: nothing failed, nothing to record.
          const why = failureOf(returned);
          if (why === null) return;
          const pending = ctx.path.startsWith("/two-factor/") ? await twoFactorUser(ctx) : null;
          await audit({
            action: "sign-in",
            outcome: "failed",
            userId: pending?.id ?? null,
            email: pending?.email ?? typed,
            ...from,
            detail: `${method}: ${why}`,
          });
        } else if (ctx.path === SIGN_UP || ctx.path === SEND_CONFIRMATION) {
          const mark = mailed.get(ctx.request);
          if (ctx.path === SIGN_UP) {
            // The log says which it was (a new account, or an address that has one); the answer never does.
            const known =
              failed || mark?.created ? null : ((await ctx.context.internalAdapter.findUserByEmail((typed ?? "").toLowerCase()))?.user ?? null);
            await audit({
              action: "sign-up",
              outcome: failed ? "failed" : mark?.created ? "ok" : "refused",
              userId: mark?.created?.id ?? known?.id ?? null,
              email: mark?.created?.email ?? typed,
              ...from,
              detail: failed ? returned.message || String(returned.status) : mark?.created ? null : "the address already has an account",
            });
          }
          // What was wrong with what was typed is said at once: it's the same whoever has the address. Anything else
          // takes the same time and says the same thing, whether an account was made, one was there, or an email went.
          if (failed) return;
          if (mark) await settle(mark.started);
          return ctx.json({ status: true });
        } else if (ctx.path === "/sign-in/magic-link") {
          // Asked for: whether one went is the sender's to know (sendLink), not the log's to say to whoever reads it.
          await audit({ action: "sign-in-link", outcome: failed ? "failed" : "ok", userId: null, email: typed, ...from });
        } else if (ctx.path === ASK_RESET) {
          // Asked for, like a sign-in link: whether one went is the sender's to know (sendReset). An address that was
          // mistyped is told so at once; every other answer takes the same time and says the same thing.
          await audit({ action: "password.reset-link", outcome: failed ? "failed" : "ok", userId: null, email: typed, ...from });
          if (failed) return;
          const mark = mailed.get(ctx.request);
          if (mark) await settle(mark.started);
          return ctx.json({ status: true });
        } else if (!failed && ["/passkey/verify-registration", "/passkey/delete-passkey", "/two-factor/generate-backup-codes"].includes(ctx.path)) {
          const current = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null));
          await audit({
            action:
              ctx.path === "/passkey/verify-registration"
                ? "passkey.added"
                : ctx.path === "/passkey/delete-passkey"
                  ? "passkey.removed"
                  : "backup-codes.new",
            outcome: "ok",
            userId: current?.user.id ?? null,
            email: current?.user.email ?? null,
            ...from,
            sessionId: current?.session.id ?? null,
            target: typeof body.name === "string" ? body.name : null,
          });
        }
      }),
    },
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      // Passwordless: members turn one on without a password they don't have. Turning it on or off is never over HTTP
      // (the guard above); the account page's server actions do it, the latter only with a current code.
      twoFactor({ issuer: "Anything Factory", allowPasswordless: true, backupCodeOptions: { amount: 10, length: 10 } }),
      passkey({ rpID: new URL(baseURL).hostname, rpName: "Anything Factory", origin: baseURL }),
      magicLink({
        disableSignUp: true,
        expiresIn: 15 * 60,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url, metadata }, ctx) => {
          // Every answer takes the same time, so it doesn't say whether the address has an account.
          const started = Date.now();
          try {
            await sendLink(email, url, metadata, ctx);
          } finally {
            await settle(started);
          }
        },
      }),
      // Last, so cookies set by auth.api calls in server actions reach the browser.
      nextCookies(),
    ],
  });

  // At most one email of a kind to an address a minute: `key` names the kind and the address.
  async function mayMail(key: string): Promise<boolean> {
    const sends = client.db(authDatabase).collection<{ _id: string; at: Date }>("magic_link_sends");
    const renewed = await sends.findOneAndUpdate({ _id: key, at: { $lt: new Date(Date.now() - 60_000) } }, { $set: { at: new Date() } }).catch(() => null);
    if (renewed) return true;
    return sends.insertOne({ _id: key, at: new Date() }).then(
      () => true,
      () => false
    );
  }

  // The confirmation a sign-up waits on. Only for an account that signed up (it has a password): an invited person
  // signs in by link, and an admin is confirmed as create-admin makes them. Its link is the app's own, whatever the
  // request asked to be sent back to.
  async function sendConfirmation(user: { id: string; email: string; role?: unknown; banned?: unknown }, token: string): Promise<void> {
    if (user.banned === true || isAdminRole(user.role)) return;
    const credential = await (await auth().$context).internalAdapter.findCredentialAccount(user.id);
    if (!credential?.password) return;
    if (!(await mayMail(`confirm:${user.email.toLowerCase()}`))) return;
    const url = `${baseURL}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(CONFIRMED_PAGE)}`;
    await sendMail({
      to: user.email,
      subject: "Confirm your email for Anything Factory",
      text: `Confirm your email to finish creating your Anything Factory account:\n\n${url}\n\nThe link works once, for an hour, and signs you in. If you didn't sign up, ignore this email.`,
      link: url,
      heading: "Confirm your email",
      lines: ["One step left to finish creating your account."],
      button: "Confirm email",
      foot: "The link works once, for an hour, and signs you in. Didn't sign up? Ignore this email.",
    });
  }

  // The link to set a new password, for an account whose address asked: nobody banned gets one, nor anyone a second
  // within a minute. It opens the app's own page, whatever the request asked to be sent back to, and signs nobody in.
  async function sendReset(user: { email: string; banned?: unknown; twoFactorEnabled?: unknown }, token: string): Promise<void> {
    if (user.banned === true) return;
    if (!(await mayMail(`reset:${user.email.toLowerCase()}`))) return;
    const url = `${baseURL}${RESET_PAGE}?token=${encodeURIComponent(token)}`;
    const code = user.twoFactorEnabled === true ? " You'll be asked for your authenticator's code too." : "";
    await sendMail({
      to: user.email,
      subject: "Set a new Anything Factory password",
      text: `Set a new password for your Anything Factory account:\n\n${url}\n\nThe link works once, for 30 minutes.${code} If you didn't ask for it, ignore this email: your password stays as it is.`,
      link: url,
      heading: "Set a new password",
      lines: [`Here's the link you asked for.${code}`],
      button: "Set a new password",
      foot: "It works once, for 30 minutes. Didn't ask for it? Ignore this email: nothing changes.",
    });
  }

  // A sign-up for an address that has an account changes nothing and answers like any other; the address's owner is
  // told here, with how that account signs in. An unconfirmed sign-up shares its minute with the confirmation it was
  // just sent.
  async function tellKnown(user: { id: string; email: string; emailVerified?: boolean; banned?: unknown; role?: unknown }): Promise<void> {
    if (user.banned === true) return;
    if (!(await mayMail(`${user.emailVerified ? "known" : "confirm"}:${user.email.toLowerCase()}`))) return;
    const admin = isAdminRole(user.role);
    // Only an account that signed up and never confirmed has a confirmation to wait on: an invited one has no password.
    const unconfirmed = !admin && !user.emailVerified && Boolean((await (await auth().$context).internalAdapter.findCredentialAccount(user.id))?.password);
    const how = admin
      ? "Admin accounts sign in with a password and an authenticator code, or a passkey."
      : unconfirmed
        ? "Its email was never confirmed: sign in with your password and we'll send a new confirmation link."
        : "Sign in the way you usually do, or ask for a sign-in link there.";
    const notYou = "Wasn't you? Ignore this email.";
    await sendMail({
      to: user.email,
      subject: "You already have an Anything Factory account",
      text: `Someone tried to sign up to Anything Factory with this address. It already has an account, so nothing was changed.\n\nSign in: ${baseURL}/sign-in\n\n${how}${admin ? ` ${LOCKED_OUT}` : ""}\n\n${notYou}`,
      link: `${baseURL}/sign-in`,
      heading: "You already have an account",
      lines: ["Someone tried to sign up with this address. Nothing was changed.", how],
      button: "Sign in",
      foot: admin ? `${LOCKED_OUT} ${notYou}` : notYou,
    });
  }

  // Nobody unknown gets an email, nor a banned person, nor an admin a link, nor anyone a second within a minute. Only
  // the app's own invite (a server call, never a request over HTTP) makes it an invitation, naming a real team.
  async function sendLink(
    email: string,
    url: string,
    metadata: Record<string, unknown> | undefined,
    ctx: { request?: Request; context: { internalAdapter: { findUserByEmail(email: string): Promise<{ user: unknown } | null> } } } | undefined
  ): Promise<void> {
    const found = await ctx?.context.internalAdapter.findUserByEmail(email);
    const user = found?.user as { role?: unknown; banned?: unknown } | undefined;
    if (!user || user.banned === true) return;
    // An admin who asks gets a note in place of the link: the page answers the same for every address, so without it
    // nothing would say why no link came. It goes to their inbox only, once a minute, and opens nothing but the page.
    if (isAdminRole(user.role)) {
      if (!ctx?.request || !(await mayMail(`admin:${email.toLowerCase()}`))) return;
      const how = "Admin accounts sign in with a password and an authenticator code, or a passkey.";
      const notYou = "Didn't ask for a link? Ignore this email.";
      await sendMail({
        to: email,
        subject: "No sign-in link for admins on Anything Factory",
        text: `A sign-in link was asked for this address, and none was sent. ${how}\n\nSign in: ${baseURL}/sign-in\n\n${LOCKED_OUT}\n\n${notYou}`,
        link: `${baseURL}/sign-in`,
        heading: "No sign-in link for admins",
        lines: ["A sign-in link was asked for this address, and none was sent.", how],
        button: "Sign in",
        foot: `${LOCKED_OUT} ${notYou}`,
      });
      return;
    }
    if (!(await mayMail(email.toLowerCase()))) return;
    const team = metadata?.["team"];
    const invitation = !ctx?.request && typeof team === "string" && TEAM_NAME.test(team) ? team : null;
    await sendMail(
      invitation
        ? {
            to: email,
            subject: `You're invited to follow ${invitation} on Anything Factory`,
            text: `You've been invited to follow the team ${invitation} on Anything Factory: send it requests and see how they're going.\n\nAccept and sign in: ${url}\n\nThe link works once, for 15 minutes. Later, sign in at ${baseURL}/sign-in with this address.`,
            link: url,
            heading: `You're invited to follow ${invitation}`,
            lines: ["Send the team requests and see how they're going."],
            button: "Accept and sign in",
            foot: `The link works once, for 15 minutes. Later, sign in with this address at ${baseURL}/sign-in`,
          }
        : {
            to: email,
            subject: "Your Anything Factory sign-in link",
            text: `Sign in to Anything Factory:\n\n${url}\n\nThe link works once, for 15 minutes. If you didn't ask for it, ignore this email.`,
            link: url,
            heading: "Sign in to Anything Factory",
            lines: ["Here's the link you asked for."],
            button: "Sign in",
            foot: "It works once, for 15 minutes. Didn't ask for it? Ignore this email.",
          }
    );
  }
}

// Who a sign-in's second step is for: the person the two-factor cookie names, while it's still good.
async function twoFactorUser(ctx: {
  context: {
    createAuthCookie(name: string): { name: string };
    secret: string;
    internalAdapter: {
      findVerificationValue(id: string): Promise<{ value: string } | null>;
      findUserById(id: string): Promise<{ id: string; email: string } | null>;
    };
  };
  getSignedCookie(name: string, secret: string): Promise<string | null | false>;
}): Promise<{ id: string; email: string } | null> {
  try {
    const signed = await ctx.getSignedCookie(ctx.context.createAuthCookie("two_factor").name, ctx.context.secret);
    if (!signed) return null;
    const pending = await ctx.context.internalAdapter.findVerificationValue(signed);
    return pending ? await ctx.context.internalAdapter.findUserById(pending.value) : null;
  } catch {
    return null;
  }
}

export type Auth = ReturnType<typeof makeAuth>;

const cache = globalThis as typeof globalThis & { a6gWebAuth?: Auth };
export function auth(): Auth {
  cache.a6gWebAuth ??= makeAuth();
  return cache.a6gWebAuth;
}

// The viewer's IP address for a request, exactly as sessions and rate limits read it.
export const clientIp = (headers: Headers): string | null => getIP(headers, auth().options);
