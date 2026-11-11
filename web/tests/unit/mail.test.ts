// How an email looks (server/mail.ts): a heading, a line or two, one button and small print where the sender gives
// them, and never a spelled-out address with a token in it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlOf } from "../../server/mail.ts";

const SITE = "https://a6g.example.com";
const LINK = `${SITE}/api/auth/verify-email?token=${"x".repeat(240)}&callbackURL=%2Fsign-up%2Fconfirmed`;
// What a person reads: the tags gone, the entities back.
const words = (html: string): string =>
  html
    .replace(/<style>[\s\S]*?<\/style>|<title>[\s\S]*?<\/title>/g, "")
    .replace(/<\/?a\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

test("an email with a heading, a line, a button and small print says only that, and its link is the button's alone", () => {
  const html = htmlOf(
    {
      subject: "Confirm your email for Anything Factory",
      text: `Confirm your email to finish creating your Anything Factory account:\n\n${LINK}\n\nThe link works once, for an hour.`,
      link: LINK,
      heading: "Confirm your email",
      lines: ["One step left to finish creating your account."],
      button: "Confirm email",
      foot: "The link works once, for an hour. Didn't sign up? Ignore this email.",
    },
    SITE
  );
  assert.equal(
    words(html),
    // The line comes twice: once hidden, for the inbox's preview.
    "One step left to finish creating your account. Anything Factory Confirm your email One step left to finish creating your account. Confirm email The link works once, for an hour. Didn't sign up? Ignore this email. Sent by Anything Factory at a6g.example.com"
  );
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] ?? "").replaceAll("&amp;", "&"));
  assert.deepEqual(hrefs, [LINK, SITE]);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
});

test("an email with only its text shows it whole, each address a link under a short name, a sentence's full stop left outside", () => {
  const html = htmlOf(
    {
      subject: "[shop] A question for you",
      text: `Refunds by card or credit?\n\nAnswer it: ${SITE}/t/shop/inbox?task=12&from=mail\n\nChange what you're told at ${SITE}/account/notifications.`,
      link: `${SITE}/t/shop/inbox?task=12&from=mail`,
    },
    SITE
  );
  assert.match(
    words(html),
    /Anything Factory Refunds by card or credit\? Answer it: a6g\.example\.com\/t\/shop\/inbox Change what you're told at a6g\.example\.com\/account\/notifications\. Sent by/
  );
  assert.match(html, /href="https:\/\/a6g\.example\.com\/t\/shop\/inbox\?task=12&amp;from=mail"/);
  assert.match(html, /href="https:\/\/a6g\.example\.com\/account\/notifications"[^>]*>a6g\.example\.com\/account\/notifications<\/a>\./);
  assert.doesNotMatch(html, /<h1/);
  assert.doesNotMatch(html, /<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px/);
});

test("what a person typed can't become markup", () => {
  const html = htmlOf(
    {
      subject: "<b>Hi</b>",
      text: "x",
      link: `${SITE}/"><script>alert(1)</script>`,
      heading: "<img src=x>",
      lines: ['<a href="https://evil.example">here</a>'],
      button: "<i>Go</i>",
      foot: "<u>no</u>",
    },
    SITE
  );
  assert.doesNotMatch(html, /<script|<img|<b>|<i>|<u>|href="https:\/\/evil\.example"/);
  assert.match(html, /&lt;img src=x&gt;/);
});
