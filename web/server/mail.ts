// Email: sign-in links, invitations, new-IP confirmations and notifications, through Resend (RESEND_API_KEY) or Amazon
// SES (SES_REGION and its key). Without either, on this machine only (MAIL_LOG), the message goes to the server's
// console instead, where a test can read the link.
import type { SESv2Client } from "@aws-sdk/client-sesv2";
import { config } from "./config.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  link: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

let ses: SESv2Client | null = null;

export async function sendMail({ to, subject, text, link }: Mail): Promise<void> {
  const settings = config();
  const { resendKey, mailFrom, mailLog } = settings;
  // Each paragraph as one, its lines kept, and every address in it a link (the main one and any other).
  const linked = (paragraph: string): string =>
    escapeHtml(paragraph)
      .replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
      .replaceAll("\n", "<br>");
  const html = `<div style="font:15px/1.5 system-ui,sans-serif;max-width:560px">${text
    .split("\n\n")
    .map((p) => `<p>${linked(p)}</p>`)
    .join("")}</div>`;
  if (resendKey) {
    const { Resend } = await import("resend");
    const { error } = await new Resend(resendKey).emails.send({ from: mailFrom, to, subject, text, html });
    if (error) throw new Error(`Resend refused the email: ${error.message}`);
    return;
  }
  if (settings.ses) {
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
    const { region, accessKeyId, secretAccessKey } = settings.ses;
    ses ??= new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: mailFrom,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
          },
        },
      })
    );
    return;
  }
  if (mailLog) {
    // One line a test can find: the address and the link.
    console.info(`[mail] to=${to} subject=${JSON.stringify(subject)} link=${link}`);
    return;
  }
  throw new Error("no email service: set RESEND_API_KEY or SES_REGION with its key (or MAIL_LOG=1 on this machine)");
}
