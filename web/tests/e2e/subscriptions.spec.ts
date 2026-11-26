// The Subscriptions tab, after the main story, on the seed's machines: the operator's attic reports two subscriptions
// (one used up for the week), the other under two names in a6g; the member has no machine linked by then.
import { expect, test } from "@playwright/test";
import { closeDatabases, databases, signInAsAdmin, signInByLink, state } from "./helpers.ts";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await closeDatabases();
});

test("an admin sees each window's pool left, with each subscription's part, and the subscriptions themselves, by their addresses", async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Subscriptions" }).click();
  await expect(page.getByRole("heading", { name: "Subscriptions", exact: true })).toBeVisible();
  for (const window of ["Session", "Weekly", "Weekly · Fable", "Monthly extra usage"])
    await expect(page.getByRole("heading", { name: window, exact: true })).toBeVisible();
  // Each part says what's left of it, when it resets and where the teams stop.
  await expect(page.getByLabel(/^operator@example\.com: 36% left, resets in 2d \d+h, the teams stop at 85% used$/)).toBeVisible();
  await expect(page.getByLabel(/^refdocs@example\.com: 0% left/).first()).toBeVisible();
  await expect(page.getByText("Closed to the teams: refdocs has used its week.")).toBeVisible();
  await expect(page.getByText("$12.50 of $50.00 this month")).toBeVisible();
  // The account under two names says so.
  const facts = page.locator(".sub-facts > li");
  await expect(facts.filter({ hasText: "operator@example.com" })).toContainText("default and work in a6g");
  await expect(page.getByText("default and work are one Claude account: they share its limits, and each counts what it used.")).toBeVisible();

  // Most used first, or by name.
  const sort = page.getByRole("navigation", { name: "Sort" });
  await expect(sort.getByRole("link", { name: "Most used" })).toHaveAttribute("aria-current", "true");
  await expect(facts.first()).toContainText("refdocs@example.com");
  await sort.getByRole("link", { name: "A–Z" }).click();
  await expect(page).toHaveURL(/sort=name/);
  await expect(facts.first()).toContainText("operator@example.com");

  // One of an account's names: what it used, its teams and its limits, the sort kept.
  const chooser = page.getByRole("navigation", { name: "Subscription" });
  for (const name of ["All subscriptions", "operator@example.com", "default (operator@example.com)", "work (operator@example.com)", "refdocs@example.com"])
    await expect(chooser.getByRole("link", { name, exact: true })).toBeVisible();
  await chooser.getByRole("link", { name: "work (operator@example.com)", exact: true }).click();
  await expect(page).toHaveURL(/as=work/);
  await expect(page).toHaveURL(/sort=name/);
  await expect(chooser.getByRole("link", { name: "work (operator@example.com)", exact: true })).toHaveAttribute("aria-current", "true");
  await expect(page.getByText("Only what work used. It's the same Claude account as default, operator@example.com: they share its limits.")).toBeVisible();
  await expect(facts).toHaveCount(1);
  await expect(facts).toContainText("work in a6g");
  await expect(facts).toContainText("Runs blog (builder)");
  await chooser.getByRole("link", { name: "All subscriptions" }).click();
  await expect(facts).toHaveCount(2);
});

test("the page fits a phone's width, its choices and all", async ({ page }) => {
  await signInAsAdmin(page);
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of ["/subscriptions", "/subscriptions?view=cost", "/subscriptions?view=cost&sort=name"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Subscriptions", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), path).toBeLessThanOrEqual(0);
  }
});

test("cost over the window: by subscription, a chart read with the keyboard, totals, and a model's own figures", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/subscriptions");
  await page.getByRole("navigation", { name: "Show" }).getByRole("link", { name: "Cost" }).click();
  await expect(page).toHaveURL(/view=cost/);
  await expect(page.getByRole("heading", { name: "Daily cost" })).toBeVisible();
  await expect(page.getByText(/^\$[\d,]+\.\d\d$/).first()).toBeVisible();
  await expect(page.getByText("Leaves out", { exact: false })).toBeVisible();
  for (const stat of ["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"])
    await expect(page.getByText(stat, { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Cost by type" })).toBeVisible();
  await expect(page.getByText(/^Premium \$/)).toBeVisible();

  // The chart, from the keyboard: the last day, each subscription's figure and their total.
  const chart = page.getByRole("group", { name: /^Daily cost/ });
  await chart.focus();
  await page.keyboard.press("End");
  const tip = page.locator(".trend-tip");
  await expect(tip).toContainText("operator@example.com");
  await expect(tip).toContainText("refdocs@example.com");
  await expect(tip).toContainText("Total");

  // The model with no price says so; a model opens its own figures, and closes again.
  const unpriced = page.getByRole("row", { name: /claude-fable-5-2/ });
  await expect(unpriced).toContainText("Unpriced");
  await page.getByRole("button", { name: "claude-opus-5-5" }).click();
  const dialog = page.getByRole("dialog", { name: "claude-opus-5-5" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Per 1M tokens")).toBeVisible();
  await expect(dialog.getByText("Cache hit")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  // By day, newest first; then one subscription alone; then tokens over the last 24 hours, by hour.
  await page.getByRole("navigation", { name: "Breakdown by" }).getByRole("link", { name: "Day" }).click();
  await expect(page.getByRole("columnheader", { name: "Total" })).toBeVisible();
  await page.getByRole("navigation", { name: "Subscription" }).getByRole("link", { name: "refdocs@example.com", exact: true }).click();
  await expect(page).toHaveURL(/sub=/);
  await expect(page.locator(".usage-series li")).toHaveCount(1);
  // Each choice once the page before it is in: a link's address carries what's shown.
  await page.getByRole("navigation", { name: "Show" }).getByRole("link", { name: "Tokens" }).click();
  await expect(page.getByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
  await page.getByRole("navigation", { name: "Period" }).getByRole("link", { name: "Past 24h" }).click();
  await expect(page.getByRole("heading", { name: "Hourly processed tokens" })).toBeVisible();
  await expect(page).toHaveURL(/period=1/);
});

test("someone with no machine reporting its subscriptions is told how they come to show", async ({ page }) => {
  // The main story sent the member a link a moment ago: the one-a-minute limit is cleared.
  await (await databases()).accounts.collection("magic_link_sends").deleteMany({ _id: state().member as never });
  await signInByLink(page, state().member);
  await page.goto("/subscriptions");
  // The member's studio was unlinked in the main story; while it was linked, its older factory reported none.
  await expect(page.getByText("None of your machines is linked yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Machines" }).last()).toHaveAttribute("href", "/machines");
});
