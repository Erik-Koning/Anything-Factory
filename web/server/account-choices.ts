// The two protections every sign-up starts with, kept on the account (auth.ts): whether its authenticator is still
// due (set up at /welcome, or put off there), and whether a sign-in from an IP address the person hasn't used asks
// them by email first. Changed only from here, by the app's own server actions after their checks, for someone signed
// in to a confirmed account: no endpoint of Better Auth's takes either, and no sign-up can.
import { auth } from "./auth.ts";

const adapter = async () => (await auth().$context).internalAdapter;

export async function setAuthenticatorDue(userId: string, due: boolean): Promise<void> {
  await (await adapter()).updateUser(userId, { authenticatorDue: due });
}

export async function setIpCheck(userId: string, on: boolean): Promise<void> {
  await (await adapter()).updateUser(userId, { ipCheck: on });
}

// Whether the account has a password (it signed up with one, or create-admin gave it one). Better Auth then asks for
// it before an authenticator is turned on or off or new backup codes are made; an invited account has none to ask for.
export async function hasPassword(userId: string): Promise<boolean> {
  return Boolean((await (await adapter()).findCredentialAccount(userId))?.password);
}
