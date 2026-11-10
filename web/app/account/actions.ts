"use server";
// One's own account: sessions (ended by id, so session tokens never reach the page), the IP addresses one has
// confirmed and whether new ones are checked, and an authenticator for anyone who isn't an admin (an admin's comes
// from create-admin and stays on, and an admin's addresses are always checked).
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { withNotice } from "../../components/ui.tsx";
import { pendingStep } from "../../server/access.ts";
import { hasPassword, setAuthenticatorDue, setIpCheck } from "../../server/account-choices.ts";
import { auth } from "../../server/auth.ts";
import { CODE_TRIES, clearCodeAttempts, takeCodeAttempt } from "../../server/code-attempts.ts";
import { config } from "../../server/config.ts";
import { deviceOf } from "../../server/device.ts";
import { forgetIp, rememberIp } from "../../server/known-ips.ts";
import { sendMail } from "../../server/mail.ts";
import { checkCode } from "../../server/step-up.ts";
import { authHeaders as headers, getViewer, record, STEP_PAGE } from "../../server/viewer.ts";

const BACK = "/account";
// How recent a sign-in must be to stop checking new IP addresses.
const FRESH_MINUTES = 10;

// The person, when their session owes nothing. `onboarding` also lets through someone who still owes the authenticator
// they asked for as they signed up: setting it up is that step (/welcome).
async function self(onboarding = false) {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step && !(onboarding && step === "set-up-authenticator")) redirect(STEP_PAGE[step]);
  return viewer;
}

export async function revokeSessionAction(form: FormData): Promise<void> {
  const viewer = await self();
  const id = form.get("id");
  const sessions = await auth().api.listSessions({ headers: await headers() });
  const target = sessions.find((s) => s.id === id);
  if (!target) redirect(withNotice(BACK, { error: "That session has ended already." }));
  if (target.id === viewer.sessionId) redirect(withNotice(BACK, { error: "That's this session: sign out instead." }));
  await auth().api.revokeSession({ body: { token: target.token }, headers: await headers() });
  redirect(withNotice(BACK, { ok: "That session has ended." }));
}

export async function revokeOtherSessionsAction(): Promise<void> {
  await self();
  await auth().api.revokeOtherSessions({ headers: await headers() });
  redirect(withNotice(BACK, { ok: "Every other session has ended." }));
}

// Forgets a confirmed address: the next session from it asks by email again. Not the one this request comes from.
export async function forgetIpAction(form: FormData): Promise<void> {
  const viewer = await self();
  const ip = String(form.get("ip") ?? "");
  if (ip === viewer.ip) redirect(withNotice(BACK, { error: "That's the address you're using now." }));
  if (!(await forgetIp(viewer.userId, ip))) redirect(withNotice(BACK, { error: "That address isn't on your list." }));
  await record(viewer, { action: "ip.forgotten", outcome: "ok", target: ip });
  redirect(withNotice(BACK, { ok: `${ip} is forgotten: a sign-in from it will ask by email again.` }));
}

// Stops checking new IP addresses, for one's own account; never an admin's. It takes a sign-in from the last ten
// minutes, and a code from the authenticator when one is on, so a session left open somewhere can't quietly drop the
// check; and the person is told by email first, so if the email can't go the check stays.
export async function turnOffIpCheckAction(form: FormData): Promise<void> {
  const viewer = await self();
  if (viewer.admin) redirect(withNotice(BACK, { error: "An admin's IP addresses are always checked." }));
  if (!viewer.ipCheck) redirect(BACK);
  const requestHeaders = await headers();
  const current = await auth().api.getSession({ headers: requestHeaders });
  if (!current) redirect("/sign-in");
  if (Date.now() - new Date(current.session.createdAt).getTime() > FRESH_MINUTES * 60_000) {
    await record(viewer, { action: "ip-check.off", outcome: "refused", detail: `the sign-in is older than ${FRESH_MINUTES} minutes` });
    redirect(withNotice(BACK, { error: `Sign out and in again, then do this within ${FRESH_MINUTES} minutes. New IP addresses are still checked.` }));
  }
  if (viewer.twoFactor) {
    const wrong = await checkCode(viewer.userId, String(form.get("code") ?? "").replace(/\s+/g, ""), requestHeaders);
    if (wrong) {
      await record(viewer, { action: "ip-check.off", outcome: "failed", detail: wrong });
      redirect(withNotice(BACK, { error: `${wrong} New IP addresses are still checked.` }));
    }
  }
  const { baseURL } = config();
  await sendMail({
    to: viewer.email,
    subject: "New IP addresses are no longer checked on your Anything Factory account",
    text: `The check of new IP addresses was turned off for your Anything Factory account${viewer.ip ? `, from ${viewer.ip}` : ""} (${deviceOf(requestHeaders.get("user-agent"))}). From now on a sign-in from an address you haven't used isn't asked about by email.\n\nIf that wasn't you, sign in at ${baseURL}/account, turn the check back on there, and end every session you don't recognise.`,
    link: `${baseURL}/account`,
  });
  await setIpCheck(viewer.userId, false);
  await record(viewer, { action: "ip-check.off", outcome: "ok" });
  redirect(withNotice(BACK, { ok: "New IP addresses are no longer checked. We've emailed you that this was turned off." }));
}

// Checks new IP addresses again. The address it's turned on from is remembered as one of theirs, or the very next page
// would ask them to confirm it.
export async function turnOnIpCheckAction(): Promise<void> {
  const viewer = await self();
  await rememberIp(viewer.userId, viewer.ip, "check turned on");
  await setIpCheck(viewer.userId, true);
  await record(viewer, { action: "ip-check.on", outcome: "ok" });
  redirect(withNotice(BACK, { ok: "New IP addresses are checked again: a sign-in from one you haven't used asks you by email first." }));
}

export interface AuthenticatorState {
  stage: "idle" | "scan" | "done";
  error: string | null;
  // While scanning: the QR code (an SVG made here), the key to type instead, and the backup codes to show once it's on.
  qr: string | null;
  key: string | null;
  backupCodes: string[];
}

// A QR code for an authenticator's key: an SVG made here, never one a browser sent back.
const BASE32 = /^[A-Z2-7]{16,128}=*$/;
async function qrFor(key: string, email: string): Promise<string | null> {
  if (!BASE32.test(key)) return null;
  const uri = `otpauth://totp/${encodeURIComponent(`Anything Factory:${email}`)}?secret=${key}&issuer=Anything%20Factory`;
  return QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}
const codesOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((c): c is string => typeof c === "string" && /^[\w-]{4,40}$/.test(c)).slice(0, 20) : [];

// Turning on an authenticator, in two steps: "start" makes its secret (Better Auth, unconfirmed until a code proves the
// app has it), "confirm" checks a code from the app, which turns it on. From the account page, or from /welcome by
// someone who asked for one as they signed up (turning it on is what they then owe, and settles it). An account with a
// password gives it to start (Better Auth asks it of anyone who has one); wrong ones count like wrong codes.
export async function authenticatorAction(previous: AuthenticatorState, form: FormData): Promise<AuthenticatorState> {
  const viewer = await self(true);
  const idle: AuthenticatorState = { stage: "idle", error: null, qr: null, key: null, backupCodes: [] };
  if (viewer.admin) return { ...idle, error: "An admin's authenticator comes from create-admin." };
  if (viewer.twoFactor) return { ...idle, stage: "done" };
  const requestHeaders = await headers();
  if (form.get("step") === "start") {
    const asked = await hasPassword(viewer.userId);
    const password = String(form.get("password") ?? "");
    if (asked && !password) return { ...idle, error: "Enter your password." };
    if (asked && !(await takeCodeAttempt(viewer.userId))) return { ...idle, error: `That's ${CODE_TRIES} wrong tries: wait 15 minutes, then try again.` };
    const made = await auth()
      .api.enableTwoFactor({ body: asked ? { password } : {}, headers: requestHeaders })
      .catch(() => null);
    if (!made) {
      await record(viewer, { action: "authenticator.on", outcome: "failed", detail: asked ? "password" : null });
      return { ...idle, error: asked ? "That password isn't right." : "The authenticator couldn't be set up; try again." };
    }
    if (asked) await clearCodeAttempts(viewer.userId);
    if (!("totpURI" in made) || !made.totpURI) return { ...idle, error: "The authenticator couldn't be set up; try again." };
    const qr = await QRCode.toString(made.totpURI, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { stage: "scan", error: null, qr, key: new URL(made.totpURI).searchParams.get("secret"), backupCodes: made.backupCodes ?? [] };
  }
  // What came back from the browser is only redrawn: the key as a QR code made here, the codes as text.
  const key = typeof previous.key === "string" ? previous.key : "";
  const scanning: AuthenticatorState = { stage: "scan", error: null, qr: await qrFor(key, viewer.email), key, backupCodes: codesOf(previous.backupCodes) };
  const wrong = await checkCode(viewer.userId, String(form.get("code") ?? "").replace(/\s+/g, ""), requestHeaders);
  if (wrong) return { ...scanning, error: wrong };
  if (viewer.authenticatorDue) await setAuthenticatorDue(viewer.userId, false);
  await record(viewer, { action: "authenticator.on", outcome: "ok" });
  return { stage: "done", error: null, qr: null, key: null, backupCodes: scanning.backupCodes };
}

// Turning it off takes a code from it (and the password of an account that has one), so a session left open somewhere
// can't quietly remove it.
export async function turnOffAuthenticatorAction(form: FormData): Promise<void> {
  const viewer = await self();
  if (viewer.admin) redirect(withNotice(BACK, { error: "An admin's authenticator stays on." }));
  const requestHeaders = await headers();
  const wrong = await checkCode(viewer.userId, String(form.get("code") ?? "").replace(/\s+/g, ""), requestHeaders);
  if (wrong) {
    await record(viewer, { action: "authenticator.off", outcome: "failed", detail: wrong });
    redirect(withNotice(BACK, { error: `${wrong} The authenticator is still on.` }));
  }
  const password = String(form.get("password") ?? "");
  const off = await auth()
    .api.disableTwoFactor({ body: (await hasPassword(viewer.userId)) ? { password } : {}, headers: requestHeaders })
    .then(
      () => true,
      () => false
    );
  if (!off) {
    await record(viewer, { action: "authenticator.off", outcome: "failed", detail: "password" });
    redirect(withNotice(BACK, { error: "That password isn't right. The authenticator is still on." }));
  }
  await record(viewer, { action: "authenticator.off", outcome: "ok" });
  redirect(withNotice(BACK, { ok: "The authenticator is off. Sign-ins no longer ask for its code." }));
}

export interface BackupCodesState {
  error: string | null;
  codes: string[];
}

// New backup codes, the old ones void: a current code first (and the password, which Better Auth asks of any account
// that has one: an admin's, or one that signed up), so a stolen session can't mint a way back in.
export async function backupCodesAction(_previous: BackupCodesState, form: FormData): Promise<BackupCodesState> {
  const viewer = await self();
  if (!viewer.twoFactor) return { error: "Turn on an authenticator first.", codes: [] };
  const requestHeaders = await headers();
  const wrong = await checkCode(viewer.userId, String(form.get("code") ?? "").replace(/\s+/g, ""), requestHeaders);
  if (wrong) return { error: wrong, codes: [] };
  const password = String(form.get("password") ?? "");
  try {
    const made = await auth().api.generateBackupCodes({ body: (await hasPassword(viewer.userId)) ? { password } : {}, headers: requestHeaders });
    await record(viewer, { action: "backup-codes.new", outcome: "ok" });
    return { error: null, codes: made.backupCodes };
  } catch {
    await record(viewer, { action: "backup-codes.new", outcome: "failed", detail: "password" });
    return { error: "That password isn't right.", codes: [] };
  }
}
