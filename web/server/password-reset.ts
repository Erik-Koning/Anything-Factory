// A new password from a link by email, for someone who can't sign in with the one they have, or has none.
//
// Asking is Better Auth's own endpoint (/request-password-reset, auth.ts): it answers the same for every address, in
// the same time. The email goes to an address that has an account (never a banned one), once a minute, and its link
// opens the app's own page with a token that works once, for 30 minutes.
//
// Setting is only ever done here, from that page's server action: auth.ts refuses Better Auth's own endpoint over
// HTTP, so these rules can't be gone around.
//   - An account with an authenticator gives its code as well: an inbox alone never changes a password that a second
//     factor guards. Each try counts against the person's five (code-attempts.ts). An admin always has an
//     authenticator (create-admin); one without it can't use the link, and is told who can start the account afresh.
//   - The link signs nobody in. Every session of the account ends, and its address is told by email.
//   - An address the link proves for the first time is confirmed, with its IP check on, as a sign-in link leaves one
//     (auth.ts): whoever signed up with it hadn't proven the inbox, and their password goes with this one.
import { symmetricDecrypt } from "better-auth/crypto";
import { audit } from "./audit.ts";
import { auth, isAdminRole } from "./auth.ts";
import { CODE_TRIES, clearCodeAttempts, takeCodeAttempt } from "./code-attempts.ts";
import { config } from "./config.ts";
import { deviceOf } from "./device.ts";
import { sendMail } from "./mail.ts";
import { base32, codeMatches } from "./totp.ts";

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;
export const NO_AUTHENTICATOR =
  "This admin account has no authenticator, so a link by email can't change its password. Whoever runs this site can start it afresh with npm run create-admin.";
const GONE = "This link has expired or was used already. Ask for a new one.";

interface Account {
  id: string;
  email: string;
  role?: unknown;
  banned?: unknown;
  emailVerified?: boolean;
  twoFactorEnabled?: boolean | null;
}

// The account a link's token is for, while the link is good.
async function accountOf(token: string): Promise<Account | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const { internalAdapter } = await auth().$context;
  const pending = await internalAdapter.findVerificationValue(`reset-password:${token}`);
  if (!pending || pending.expiresAt < new Date()) return null;
  const user = (await internalAdapter.findUserById(pending.value)) as Account | null;
  return user && user.banned !== true ? user : null;
}

// What the page says before anything is typed: whose password it is, whether their authenticator's code is asked for
// too, and why the link can't be used when it can't. Null for a link that is old, used, or nobody's.
export async function readReset(token: string): Promise<{ email: string; needsCode: boolean; refused: string | null } | null> {
  const user = await accountOf(token);
  if (!user) return null;
  const needsCode = user.twoFactorEnabled === true;
  return { email: user.email, needsCode, refused: isAdminRole(user.role) && !needsCode ? NO_AUTHENTICATOR : null };
}

// Whether `code` is the one the person's authenticator shows. The key is Better Auth's own record of it (the
// two-factor plugin's, sealed with the app's secret), read here because its endpoints check a code only for a session
// or for a password's second step, and someone setting a new password has neither.
export async function authenticatorShows(userId: string, code: string, at = Date.now()): Promise<boolean> {
  const context = await auth().$context;
  const enrolled = await context.adapter.findOne<{ secret?: string | null; verified?: boolean | null }>({
    model: "twoFactor",
    where: [{ field: "userId", value: userId }],
  });
  if (!enrolled?.secret || enrolled.verified === false) return false;
  const secret = await symmetricDecrypt({ key: context.secretConfig, data: enrolled.secret });
  // As the plugin reads it: the secret's own characters are the key, unless it is marked as base32.
  return codeMatches(secret.startsWith("base32:") ? base32(secret.slice(7)) : Buffer.from(secret, "utf8"), code, at);
}

// `gone`: the link itself is no good any more, so the page offers a new one in place of the form.
export type ResetResult = { ok: true } | { ok: false; error: string; gone?: boolean };

export async function setNewPassword(
  { token, password, code }: { token: string; password: string; code: string },
  from: { ip: string | null; userAgent: string | null }
): Promise<ResetResult> {
  const user = await accountOf(token);
  if (!user) return { ok: false, error: GONE, gone: true };
  if (password.length < MIN_PASSWORD) return { ok: false, error: `Use at least ${MIN_PASSWORD} characters.` };
  if (password.length > MAX_PASSWORD) return { ok: false, error: `Keep it to ${MAX_PASSWORD} characters or fewer.` };
  const entry = { action: "password.reset" as const, userId: user.id, email: user.email, ...from };
  const guarded = user.twoFactorEnabled === true;
  if (guarded) {
    if (!/^\d{6}$/.test(code)) return { ok: false, error: "Enter the 6-digit code your authenticator shows." };
    // Counted before it is checked, so tries made at once can't each get a guess.
    if (!(await takeCodeAttempt(user.id))) {
      await audit({ ...entry, outcome: "refused", detail: `${CODE_TRIES} wrong codes; locked 15 minutes` });
      return { ok: false, error: `That's ${CODE_TRIES} wrong codes: wait 15 minutes, then try again.` };
    }
    if (!(await authenticatorShows(user.id, code))) {
      await audit({ ...entry, outcome: "failed", detail: "authenticator code" });
      return { ok: false, error: "That code isn't right. Codes change every 30 seconds." };
    }
    await clearCodeAttempts(user.id);
  } else if (isAdminRole(user.role)) {
    await audit({ ...entry, outcome: "refused", detail: "an admin with no authenticator" });
    return { ok: false, error: NO_AUTHENTICATOR };
  }
  try {
    // Better Auth's own: it takes the token, once, ends every session of the account, and stores the password's hash.
    await auth().api.resetPassword({ body: { newPassword: password, token } });
  } catch {
    return { ok: false, error: GONE, gone: true };
  }
  const proven = user.emailVerified !== true;
  if (proven) await (await auth().$context).internalAdapter.updateUser(user.id, { emailVerified: true, ipCheck: true });
  const how = [guarded ? "link and authenticator code" : "link", "every session ended", ...(proven ? ["address confirmed"] : [])];
  await audit({ ...entry, outcome: "ok", detail: how.join("; ") });
  // The password is changed whether or not this email goes.
  await tellChanged(user.email, from).catch((error: unknown) => console.error("[mail] the password-changed email didn't send", error));
  return { ok: true };
}

async function tellChanged(email: string, from: { ip: string | null; userAgent: string | null }): Promise<void> {
  const { baseURL } = config();
  const where = `${from.ip ?? "an address that couldn't be read"} (${deviceOf(from.userAgent)})`;
  const notYou = `Wasn't you? Set a new one at ${baseURL}/forgot-password and tell whoever runs this site.`;
  await sendMail({
    to: email,
    subject: "Your Anything Factory password was changed",
    text: `The password of your Anything Factory account was changed just now, from ${where}. Every session has ended.\n\nSign in with the new password: ${baseURL}/sign-in\n\n${notYou}`,
    link: `${baseURL}/sign-in`,
    heading: "Your password was changed",
    lines: [`It was changed just now, from ${where}.`, "Every session has ended: sign in with the new password."],
    button: "Sign in",
    foot: notYou,
  });
}
