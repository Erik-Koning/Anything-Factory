// Email: sign-in links, invitations, new-IP confirmations and notifications, through Resend (RESEND_API_KEY) or Amazon
// SES (SES_REGION and its key). Without either, on this machine only (MAIL_LOG), the message goes to the server's
// console instead, where a test can read the link.
//
// Every email has a text part, whole. Its HTML part says the same in fewer words where the sender gives them: a
// heading, a line or two, one button on the email's link, and a line of small print. No address is spelled out there:
// a link with a token in it is hundreds of characters nobody reads. An email without those shows its text as it is,
// each address in it a link under its own short name.
import type { SESv2Client } from "@aws-sdk/client-sesv2";
import { config } from "./config.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  // The one address the email is about: what its button opens, and what a test reads from the log.
  link: string;
  heading?: string;
  lines?: string[];
  button?: string;
  foot?: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

// The factory's own colours (app/globals.css), light and dark. Inline for every mail client; the dark ones by class,
// for the clients that read a style sheet.
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const GROUND = "#f0eee8";
const SURFACE = "#fdfcf9";
const RULE = "#dcd9d0";
const INK = "#17191b";
const INK_2 = "#3f4347";
const INK_3 = "#565a5c";
const SOLID = "#1f4bc6";
const DARK = `@media (prefers-color-scheme: dark) {
.a6g-ground { background: #131412 !important; }
.a6g-card { background: #1d1e1b !important; border-color: #33352f !important; }
.a6g-ink { color: #f1efe9 !important; }
.a6g-ink-2 { color: #cfccc4 !important; }
.a6g-ink-3 { color: #a5a29a !important; }
.a6g-link { color: #9db4ff !important; }
}`;

// An address as people say one: no scheme, nothing after the path.
const named = (url: string): string =>
  url
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "");

// A paragraph, its lines kept, and every address in it a link (the full stop that ends a sentence isn't part of one).
const linked = (paragraph: string): string =>
  escapeHtml(paragraph)
    .replace(/https?:\/\/[^\s<]+/g, (found) => {
      const url = found.replace(/[.,;:!?)]+$/, "");
      return `<a class="a6g-link" href="${url}" style="color:${SOLID}">${named(url)}</a>${found.slice(url.length)}`;
    })
    .replaceAll("\n", "<br>");

// The HTML part. `site` is the app's own address, named under the card.
export function htmlOf({ subject, text, link, heading, lines, button, foot }: Omit<Mail, "to">, site: string): string {
  const paragraphs = lines ?? text.split("\n\n");
  const body = paragraphs.map((p) => `<p class="a6g-ink-2" style="margin:0 0 14px;font:15px/1.6 ${SANS};color:${INK_2}">${linked(p)}</p>`).join("");
  const title = heading
    ? `<h1 class="a6g-ink" style="margin:0 0 12px;font:600 22px/1.3 ${SANS};letter-spacing:-0.01em;color:${INK}">${escapeHtml(heading)}</h1>`
    : "";
  // A cell with the colour behind the link, so the button is a button where padding on a link isn't drawn.
  const action = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px"><tr><td bgcolor="${SOLID}" style="border-radius:8px;background:${SOLID}"><a href="${escapeHtml(link)}" style="display:inline-block;padding:13px 24px;font:600 15px/1.2 ${SANS};color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(button)}</a></td></tr></table>`
    : "";
  const small = foot ? `<p class="a6g-ink-3" style="margin:16px 0 0;font:13px/1.55 ${SANS};color:${INK_3}">${linked(foot)}</p>` : "";
  // What an inbox shows beside the subject.
  const preview = escapeHtml((paragraphs[0] ?? "").replace(/https?:\/\/\S+/g, "").slice(0, 140));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>${DARK}</style>
</head>
<body class="a6g-ground" style="margin:0;padding:0;background:${GROUND}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preview}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="a6g-ground" style="background:${GROUND}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
<tr><td style="padding:0 2px 14px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td width="14" height="14" bgcolor="${SOLID}" style="width:14px;height:14px;border-radius:3px;background:${SOLID};font-size:0;line-height:0">&nbsp;</td>
<td class="a6g-ink" style="padding-left:9px;font:600 12px/1 ${MONO};letter-spacing:0.08em;text-transform:uppercase;color:${INK}">Anything Factory</td>
</tr></table></td></tr>
<tr><td class="a6g-card" style="padding:30px 28px 28px;background:${SURFACE};border:1px solid ${RULE};border-radius:12px">${title}${body}${action}${small}</td></tr>
<tr><td class="a6g-ink-3" style="padding:14px 2px 0;font:12px/1.5 ${SANS};color:${INK_3}">Sent by Anything Factory at <a class="a6g-ink-3" href="${escapeHtml(site)}" style="color:${INK_3}">${escapeHtml(named(site))}</a></td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

let ses: SESv2Client | null = null;

export async function sendMail(mail: Mail): Promise<void> {
  const settings = config();
  const { resendKey, mailFrom, mailLog } = settings;
  const { to, subject, text, link } = mail;
  const html = htmlOf(mail, settings.baseURL);
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
