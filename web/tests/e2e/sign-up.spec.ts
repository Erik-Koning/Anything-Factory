// Signing up end to end, after the main story and the security one on the same server and database: the sign-up page
// and its two choices, the emailed confirmation, the authenticator set up on the way in (or put off), the IP check
// turned off and on from the account page, and an admin adding someone who signed up to a team. Each person comes from
// addresses of their own, so the limit on sign-ups (three a minute from one address) is never met.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { closeDatabases, databases, freshCode, mailsTo, newPage, nextLink, nextLinkLike, signInAsAdmin, signInWith, state } from "./helpers.ts";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await closeDatabases();
});

const PASSWORD = "a-password-for-these-tests";
const CONFIRM_EMAIL = /\/api\/auth\/verify-email\?token=/;
const CONFIRM_ADDRESS = /\/sign-in\/confirm\?token=/;
const SAM = "sam@example.com";
const LEE = "lee@example.com";
const UMA = "uma@example.com";
// Sam's authenticator, once set up, and Uma's session, for the tests after theirs.
let samsAuthenticator = "";
let umasSession: Awaited<ReturnType<BrowserContext["storageState"]>>;

// Fills in the sign-up page it's on and sends it.
async function signUp(page: Page, name: string, email: string): Promise<void> {
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
}

async function signInWithPassword(page: Page, email: string): Promise<void> {
  await page.goto("/sign-in");
  await signInWith(page, "Password");
  const form = page.getByRole("group", { name: "With your password" });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(PASSWORD);
  await form.getByRole("button", { name: "Continue" }).click();
}

// The page as it is, at a phone's width: nothing scrolls sideways.
async function fitsAPhone(page: Page, what: string): Promise<void> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: 360, height: 740 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, what).toBeLessThanOrEqual(0);
  await page.setViewportSize(size);
}

test("anyone creates an account: both choices ticked, the email confirmed, the authenticator set up on the way in", async ({ browser }) => {
  const { context, page } = await newPage(browser, { ip: "203.0.113.61" });
  await page.goto("/sign-in");
  await fitsAPhone(page, "/sign-in");
  await page.getByRole("link", { name: "Create one" }).click();
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Two-factor authentication" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Check new IP addresses" })).toBeChecked();
  await fitsAPhone(page, "/sign-up");
  const seen = mailsTo(SAM).length;
  await signUp(page, "Sam Signup", SAM);
  await expect(page.getByText(`We've sent an email to ${SAM}.`)).toBeVisible();

  // Nothing is open yet, and the password alone doesn't sign in: it says to confirm the address.
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
  await signInWithPassword(page, SAM);
  await expect(page.locator("main").getByRole("alert")).toContainText("Confirm your email first");
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);

  // The emailed link signs in, and the authenticator they chose comes first: nothing else opens.
  await page.goto(await nextLinkLike(SAM, seen, CONFIRM_EMAIL));
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole("heading", { name: "Set up two-factor authentication" })).toBeVisible();
  for (const path of ["/", "/account", "/machines"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/welcome$/);
  }

  // The account has a password, so setting up starts with it.
  const setup = page.getByRole("region", { name: "Authenticator" });
  await setup.getByLabel("Your password").fill("not-the-password");
  await setup.getByRole("button", { name: "Set up an authenticator" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("That password isn't right.");
  await setup.getByLabel("Your password").fill(PASSWORD);
  await setup.getByRole("button", { name: "Set up an authenticator" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  await fitsAPhone(page, "/welcome, the QR code");
  samsAuthenticator = `otpauth://totp/A6G?secret=${(await page.locator("code.key").textContent()) ?? ""}`;
  await page.getByLabel("6-digit code").fill(await freshCode(page, samsAuthenticator));
  await page.getByRole("button", { name: "Turn it on" }).click();
  await expect(page.getByRole("status")).toContainText("Your authenticator is on");
  await expect(page.locator(".codes span")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Set it up later" })).toHaveCount(0);
  await fitsAPhone(page, "/welcome, the backup codes");

  // On to Teams: none yet, until an admin adds them to one.
  await page.getByRole("link", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  await expect(page.getByText("You're on no team yet.")).toBeVisible();
  await page.goto("/welcome");
  await expect(page.getByRole("status")).toContainText("Your authenticator is on");

  const { accounts } = await databases();
  const user = await accounts.collection("user").findOne({ email: SAM });
  expect(user).toMatchObject({ name: "Sam Signup", role: "user", emailVerified: true, twoFactorEnabled: true, authenticatorDue: false, ipCheck: true });
  // The address the link was opened from is theirs.
  expect(await accounts.collection("known_ips").findOne({ userId: String(user?._id), ip: "203.0.113.61" })).toMatchObject({ via: "email link" });
  const events = await accounts.collection("audit").find({ email: SAM }).sort({ _id: 1 }).toArray();
  expect(events.map((e) => [e.action, e.outcome])).toEqual([
    ["sign-up", "ok"],
    ["sign-in", "failed"],
    ["sign-in", "ok"],
    ["authenticator.on", "failed"],
    ["authenticator.on", "ok"],
  ]);
  expect(events[2]?.detail).toBe("email confirmed");
  await context.close();
});

test("from then on the password asks for the authenticator's code; new backup codes and turning it off take the password too", async ({ browser }) => {
  // Three codes, each a new one: up to half a minute's wait apiece.
  test.setTimeout(180_000);
  const { context, page } = await newPage(browser, { ip: "203.0.113.61" });
  await signInWithPassword(page, SAM);
  await expect(page.getByRole("heading", { name: "Your authenticator's code" })).toBeVisible();
  await page.getByLabel("6-digit code").fill(await freshCode(page, samsAuthenticator));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();

  await page.goto("/account");
  const authenticator = page.getByRole("region", { name: "Authenticator" });
  await expect(authenticator.getByText("on", { exact: true })).toBeVisible();
  await authenticator.getByLabel("Your password").fill(PASSWORD);
  await authenticator.getByLabel("A code from your authenticator").fill(await freshCode(page, samsAuthenticator));
  await authenticator.getByRole("button", { name: "Make new backup codes" }).click();
  await expect(authenticator.locator(".codes span")).toHaveCount(10);

  await authenticator.getByLabel("Password, to turn it off").fill(PASSWORD);
  await authenticator.getByLabel("A code from it, to turn it off").fill(await freshCode(page, samsAuthenticator));
  await authenticator.getByRole("button", { name: "Turn it off" }).click();
  await expect(page.getByRole("status")).toContainText("The authenticator is off.");
  await expect(authenticator.getByText("off", { exact: true })).toBeVisible();
  // Off by their own choice: nothing is due again.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  const { accounts } = await databases();
  expect(await accounts.collection("user").findOne({ email: SAM })).toMatchObject({ twoFactorEnabled: false, authenticatorDue: false });
  await context.close();
});

test("the authenticator can wait: “Set it up later” goes on to Teams; the account page turns the IP check off and on", async ({ browser }) => {
  const home = await newPage(browser, { ip: "203.0.113.62" });
  await home.page.goto("/sign-up");
  const seen = mailsTo(LEE).length;
  await signUp(home.page, "Lee Later", LEE);
  await home.page.goto(await nextLinkLike(LEE, seen, CONFIRM_EMAIL));
  await expect(home.page).toHaveURL(/\/welcome$/);
  await home.page.getByRole("button", { name: "Set it up later" }).click();
  await expect(home.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  const { accounts } = await databases();
  const users = accounts.collection("user");
  const user = await users.findOne({ email: LEE });
  expect(user).toMatchObject({ authenticatorDue: false, ipCheck: true });
  expect(user?.twoFactorEnabled ?? false).toBe(false);
  expect(await accounts.collection("audit").findOne({ email: LEE, action: "authenticator.later" })).toMatchObject({ outcome: "ok", ip: "203.0.113.62" });
  // Nothing is owed any more; the account page offers the authenticator whenever they like.
  await home.page.goto("/welcome");
  await expect(home.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  await home.page.goto("/account");
  await expect(home.page.getByRole("region", { name: "Authenticator" }).getByRole("button", { name: "Set up an authenticator" })).toBeVisible();
  await expect(home.page.getByRole("region", { name: "Recent activity" }).getByText("Authenticator put off at sign-up")).toBeVisible();

  // The IP check, on as they signed up. A sign-in older than ten minutes doesn't turn it off.
  const addresses = home.page.getByRole("region", { name: "Your IP addresses" });
  await expect(addresses.getByText("new ones are checked")).toBeVisible();
  const sessions = accounts.collection("session");
  expect((await sessions.updateOne({ userId: user?._id }, { $set: { createdAt: new Date(Date.now() - 11 * 60_000) } })).modifiedCount).toBe(1);
  await addresses.getByText("Turn the check off").click();
  await addresses.getByRole("button", { name: "Stop checking new addresses" }).click();
  await expect(home.page.locator("main").getByRole("alert")).toContainText("Sign out and in again, then do this within 10 minutes.");
  await expect(addresses.getByText("new ones are checked")).toBeVisible();
  expect((await users.findOne({ email: LEE }))?.ipCheck).toBe(true);

  // A fresh one does, and they're emailed that it was turned off.
  await sessions.updateOne({ userId: user?._id }, { $set: { createdAt: new Date() } });
  const before = mailsTo(LEE).length;
  await addresses.getByText("Turn the check off").click();
  await addresses.getByRole("button", { name: "Stop checking new addresses" }).click();
  await expect(home.page.getByRole("status")).toContainText("New IP addresses are no longer checked.");
  await expect(addresses.getByText("new ones aren't checked")).toBeVisible();
  expect(await nextLink(LEE, before)).toBe(`${state().baseURL}/account`);
  expect((await users.findOne({ email: LEE }))?.ipCheck).toBe(false);
  const turnedOff = await accounts.collection("audit").find({ email: LEE, action: "ip-check.off" }).sort({ _id: 1 }).toArray();
  expect(turnedOff.map((e) => e.outcome)).toEqual(["refused", "ok"]);

  // The same session from somewhere new opens at once, where it would have waited for an email.
  const away = await newPage(browser, { ip: "192.0.2.62", storageState: await home.context.storageState() });
  await away.page.goto("/account");
  await expect(away.page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  expect(mailsTo(LEE).length).toBe(before + 1);
  // Turned on again from there: that address is theirs, and the next new one waits for them.
  await away.page.getByRole("button", { name: "Check new addresses again" }).click();
  await expect(away.page.getByRole("status")).toContainText("New IP addresses are checked again");
  expect(await accounts.collection("known_ips").findOne({ userId: String(user?._id), ip: "192.0.2.62" })).toMatchObject({ via: "check turned on" });
  const elsewhere = await newPage(browser, { ip: "192.0.2.63", storageState: await away.context.storageState() });
  await elsewhere.page.goto("/account");
  await expect(elsewhere.page).toHaveURL(/\/confirm-sign-in$/);
  await nextLinkLike(LEE, before + 1, CONFIRM_ADDRESS);
  for (const { context } of [home, away, elsewhere]) await context.close();
});

test("with both boxes unticked, the confirmed email goes straight to Teams and no new address is asked about", async ({ browser }) => {
  const first = await newPage(browser, { ip: "203.0.113.63" });
  await first.page.goto("/sign-up");
  await first.page.getByRole("checkbox", { name: "Two-factor authentication" }).uncheck();
  await first.page.getByRole("checkbox", { name: "Check new IP addresses" }).uncheck();
  const seen = mailsTo(UMA).length;
  await signUp(first.page, "Uma Unticked", UMA);
  const link = await nextLinkLike(UMA, seen, CONFIRM_EMAIL);
  await first.page.goto(link);
  await expect(first.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  const { accounts } = await databases();
  expect(await accounts.collection("user").findOne({ email: UMA })).toMatchObject({ emailVerified: true, authenticatorDue: false, ipCheck: false });
  umasSession = await first.context.storageState();

  // The link confirms once: opened again, somewhere else, it signs nobody in.
  const second = await newPage(browser, { ip: "203.0.113.64" });
  await second.page.goto(link);
  await expect(second.page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();
  await expect(second.page.getByText("That link has done its work")).toBeVisible();
  // The password signs in from there, an address never used, with nothing to confirm and no email about it.
  await signInWithPassword(second.page, UMA);
  await expect(second.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  await second.page.goto("/account");
  await expect(second.page.getByRole("region", { name: "Your IP addresses" }).getByText("new ones aren't checked")).toBeVisible();
  await expect(second.page.getByRole("region", { name: "Authenticator" }).getByText("off", { exact: true })).toBeVisible();
  expect(mailsTo(UMA).length).toBe(seen + 1);
  for (const { context } of [first, second]) await context.close();
});

test("an admin sees who signed up, on no team, and adds them to one by inviting the same address", async ({ browser }) => {
  // The admin, from an address of this test's own, confirmed from the email as any new one is.
  const { admin } = state();
  const { context, page } = await newPage(browser, { ip: "203.0.113.65" });
  const asked = mailsTo(admin.email).length;
  await signInAsAdmin(page, { confirm: true });
  await page.goto(await nextLinkLike(admin.email, asked, CONFIRM_ADDRESS));
  await page.getByRole("button", { name: "Yes, it was me" }).click();
  await expect(page.getByRole("heading", { name: "Confirmed" })).toBeVisible();

  await page.goto("/admin/people");
  const row = page.getByRole("region", { name: "Everyone" }).locator("li.person").filter({ hasText: UMA });
  await expect(row.getByText("Uma Unticked")).toBeVisible();
  await expect(row.getByText("On no team.")).toBeVisible();
  const mails = mailsTo(UMA).length;
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Invite" }) });
  await form.getByLabel("Email", { exact: true }).fill(UMA);
  await form.getByLabel("Name", { exact: true }).fill("Uma");
  await form.getByLabel("Team", { exact: true }).selectOption("shop");
  await form.getByLabel("Role", { exact: true }).selectOption("member");
  await form.getByLabel("What they are to the team's agents").fill("support");
  await form.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("status")).toContainText(`${UMA} is now a member of shop.`);
  await expect(row.getByText("shop", { exact: true })).toBeVisible();
  await expect(row.getByText("On no team.")).toHaveCount(0);
  // The account is the one they made: its name and password stand, and no sign-in link goes out for it.
  const { accounts } = await databases();
  const user = await accounts.collection("user").findOne({ email: UMA });
  expect(user?.name).toBe("Uma Unticked");
  expect(await accounts.collection("memberships").findOne({ userId: String(user?._id), team: "shop" })).toMatchObject({
    role: "member",
    label: "support",
  });
  expect(mailsTo(UMA).length).toBe(mails);
  await context.close();

  // Their Teams page has it now.
  const theirs = await newPage(browser, { ip: "203.0.113.63", storageState: umasSession });
  await theirs.page.goto("/");
  await expect(theirs.page.getByRole("link", { name: "Shop" })).toBeVisible();
  await expect(theirs.page.getByText("You're on no team yet.")).toHaveCount(0);
  await theirs.context.close();
});
