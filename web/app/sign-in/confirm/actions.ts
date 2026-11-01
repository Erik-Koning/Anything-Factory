"use server";
// The answer to "was this you?", by the link's token alone: the email it came in is the proof, so it needs no session
// (the link may be opened on a phone that isn't signed in). A button, not the link itself, answers, so a mail scanner
// that opens links answers nothing.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../../../server/auth.ts";
import { answerChallenge } from "../../../server/known-ips.ts";

export async function answerAction(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  const answer = form.get("answer") === "denied" ? "denied" : "confirmed";
  const requestHeaders = await headers();
  const answered = await answerChallenge(token, answer, { ip: clientIp(requestHeaders), userAgent: requestHeaders.get("user-agent") });
  redirect(`/sign-in/confirm/done?result=${answered ? (answer === "confirmed" ? "yes" : "no") : "gone"}`);
}
