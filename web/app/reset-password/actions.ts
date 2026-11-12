"use server";
// Sets a new password by the link's token: the email it came in is the proof, with the authenticator's code where the
// account has one (server/password-reset.ts has the rules). It needs no session and makes none: the person signs in
// with the new password afterwards.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../../server/auth.ts";
import { setNewPassword } from "../../server/password-reset.ts";

export interface ResetState {
  error: string | null;
  // The link itself is no good any more: the page offers a new one in place of the form.
  gone: boolean;
}

export async function setPasswordAction(form: FormData): Promise<ResetState> {
  const requestHeaders = await headers();
  const result = await setNewPassword(
    {
      token: String(form.get("token") ?? ""),
      password: String(form.get("password") ?? ""),
      code: String(form.get("code") ?? "").replace(/[\s-]+/g, ""),
    },
    { ip: clientIp(requestHeaders), userAgent: requestHeaders.get("user-agent") }
  );
  if (!result.ok) return { error: result.error, gone: result.gone === true };
  redirect("/reset-password/done");
}
