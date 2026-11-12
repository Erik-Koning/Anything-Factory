// A forgotten password, end to end, on the same server and database as the other stories: asked for from the sign-in
// page, set from the emailed link, and for an account with an authenticator only with its code as well. It leaves the
// run's admin as it found them (their password is set back at the end), and each person comes from addresses of their
// own, so no other story's limits are met.
import { expect, type Page, test } from "@playwright/test";
import { totpCode } from "../../server/totp.ts";
import { closeDatabases, databases, mailsTo, newPage, nextLinkLike, signInAsAdmin, state } from "./helpers.ts";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await closeDatabases();
});

const PASSWORD = "a-password-for-these-tests";
const NEW_PASSWORD = "a-new-password-set-by-link";
const CONFIRM_EMAIL = /\/api\/auth\/verify-email\?token=/;
const RESET_LINK = /\/reset-password\?token=/;
const FAY = "fay@example.com";

// The page as it is, at a phone's width: nothing scrolls sideways.
async function fitsAPhone(page: Page, what: string): Promise<void> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: 360, height: 740 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, what).toBeLessThanOrEqual(0);
  await page.setViewportSize(size);
}

// Asks for a link on the page it's on, and gives back the link that was emailed.
async function askForALink(page: Page, email: string): Promise<string> {
  const seen = mailsTo(email).length;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText(`If ${email} has an account, a link to set a new password is on its way.`)).toBeVisible();
  return nextLinkLike(email, seen, RESET_LINK);
}

// A link an address may be sent only once a minute: lets the next go now.
async function letTheNextLinkGo(email: string): Promise<void> {
  const { accounts } = await databases();
  await accounts.collection<{ _id: string }>("magic_link_sends").deleteOne({ _id: `reset:${email}` });
}

test("someone who forgot their password asks from the sign-in page, sets a new one from the email, and signs in with it", async ({ browser }) => {
  // Fay signs up and confirms her address, with no authenticator.
  const first = await newPage(browser, { ip: "203.0.113.71" });
  await first.page.goto("/sign-up");
  await first.page.getByLabel("Your name").fill("Fay Forgetful");
  await first.page.getByLabel("Email", { exact: true }).fill(FAY);
  await first.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await first.page.getByRole("checkbox", { name: "Two-factor authentication" }).uncheck();
  const seen = mailsTo(FAY).length;
  await first.page.getByRole("button", { name: "Create my account" }).click();
  await expect(first.page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await first.page.goto(await nextLinkLike(FAY, seen, CONFIRM_EMAIL));
  await expect(first.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();

  // On another browser she can't remember it: the sign-in page has the way.
  const { context, page } = await newPage(browser, { ip: "203.0.113.71" });
  await page.goto("/sign-in");
  await page.getByRole("region", { name: "With your password" }).getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
  await fitsAPhone(page, "/forgot-password");
  const link = await askForALink(page, FAY);

  // Asking changed nothing: her first browser is still signed in, and her password still works.
  await first.page.goto("/account");
  await expect(first.page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();

  // The link opens a page that asks; opening it sets nothing.
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  await expect(page.getByText(`For ${FAY}. Changing it ends every session of the account.`)).toBeVisible();
  await expect(page.getByLabel("6-digit code from your authenticator")).toHaveCount(0);
  await fitsAPhone(page, "/reset-password");
  await page.getByLabel("New password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Set my password" }).click();
  await expect(page).toHaveURL(/\/reset-password\/done$/);
  await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeVisible();
  await fitsAPhone(page, "/reset-password/done");

  // Nobody was signed in by it, every session ended, and the link is spent.
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
  await first.page.goto("/account");
  await expect(first.page).toHaveURL(/\/sign-in/);
  await first.context.close();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  await page.getByRole("link", { name: "Ask for a new link" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);

  // The old password is refused and the new one signs her in.
  await page.goto("/sign-in");
  const form = page.getByRole("region", { name: "With your password" });
  await form.getByLabel("Email").fill(FAY);
  await form.getByLabel("Password").fill(PASSWORD);
  await form.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await form.getByLabel("Password").fill(NEW_PASSWORD);
  await form.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();

  // It is on her account page and in the log, and she was told by email.
  await page.goto("/account");
  await expect(page.getByRole("region", { name: "Recent activity" }).getByText("Password set from a link")).toBeVisible();
  const { accounts } = await databases();
  const events = await accounts
    .collection("audit")
    .find({ email: FAY, action: { $in: ["password.reset-link", "password.reset"] } })
    .sort({ _id: 1 })
    .toArray();
  expect(events.map((e) => [e.action, e.outcome, e.ip, e.detail ?? null])).toEqual([
    ["password.reset-link", "ok", "203.0.113.71", null],
    ["password.reset", "ok", "203.0.113.71", "link; every session ended"],
  ]);
  expect(mailsTo(FAY).at(-1)).toBe(`${state().baseURL}/sign-in`);
  await context.close();
});

test("asking says the same for an address nobody has, and sends nothing", async ({ browser }) => {
  const { context, page } = await newPage(browser, { ip: "203.0.113.72" });
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("nobody-at-all@example.com");
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  expect(mailsTo("nobody-at-all@example.com")).toEqual([]);
  // A link that was never sent, or was cut short on the way, opens only the way to ask again.
  await page.goto("/reset-password?token=not-a-token-anyone-was-sent");
  await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  // Better Auth's own endpoint for setting a password isn't served: only the page sets one, after its checks.
  const direct = await page.request.post("/api/auth/reset-password", {
    data: { newPassword: NEW_PASSWORD, token: "x".repeat(24) },
    headers: { origin: state().baseURL },
  });
  expect(direct.status()).toBe(403);
  await context.close();
});

test("an admin's password takes the link and their authenticator's code; the inbox alone changes nothing", async ({ browser }) => {
  const { admin } = state();
  const { context, page } = await newPage(browser, { ip: "203.0.113.73" });
  const origin = { origin: state().baseURL };
  const signsIn = async (password: string): Promise<number> =>
    (await page.request.post("/api/auth/sign-in/email", { data: { email: admin.email, password }, headers: origin })).status();

  await page.goto("/forgot-password");
  const link = await askForALink(page, admin.email);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  const code = page.getByLabel("6-digit code from your authenticator");
  await expect(code).toBeVisible();
  await expect(page.getByText("This account has an authenticator, so changing its password takes a code from it as well as the link.")).toBeVisible();
  await fitsAPhone(page, "/reset-password, with a code");

  // A wrong code: said so, nothing changed, and what was typed is still there to try again.
  const now = [-30_000, 0, 30_000, 60_000].map((drift) => totpCode(admin.totpURI, Date.now() + drift));
  const wrong = ["000000", "111111", "222222", "333333", "444444"].find((digits) => !now.includes(digits)) ?? "555555";
  await page.getByLabel("New password").fill(NEW_PASSWORD);
  await code.fill(wrong);
  await page.getByRole("button", { name: "Set my password" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("That code isn't right. Codes change every 30 seconds.");
  await expect(page.getByLabel("New password")).toHaveValue(NEW_PASSWORD);
  expect(await signsIn(NEW_PASSWORD)).toBe(401);

  // The link and the code together set it: the password the run began with is refused.
  await code.fill(totpCode(admin.totpURI));
  await page.getByRole("button", { name: "Set my password" }).click();
  await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeVisible();
  expect(await signsIn(admin.password)).toBe(401);
  const { accounts } = await databases();
  const events = await accounts.collection("audit").find({ email: admin.email, action: "password.reset", ip: "203.0.113.73" }).sort({ _id: 1 }).toArray();
  expect(events.map((e) => [e.outcome, e.detail])).toEqual([
    ["failed", "authenticator code"],
    ["ok", "link and authenticator code; every session ended"],
  ]);

  // Set back the same way, for the stories after this one: and with it and a code the admin signs in.
  await letTheNextLinkGo(admin.email);
  await page.goto("/forgot-password");
  await page.goto(await askForALink(page, admin.email));
  await page.getByLabel("New password").fill(admin.password);
  await page.getByLabel("6-digit code from your authenticator").fill(totpCode(admin.totpURI));
  await page.getByRole("button", { name: "Set my password" }).click();
  await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeVisible();
  await context.close();
  // From an address of its own (the main story uses up the default one's sign-ins a minute): the password and the
  // code are taken, and the address, being new to the admin, waits to be confirmed by email like any other.
  const back = await newPage(browser, { ip: "203.0.113.74" });
  await signInAsAdmin(back.page, { confirm: true });
  await back.context.close();
});
