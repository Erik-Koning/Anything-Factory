// The app end to end, against a local MongoDB seeded with the factory's own functions (seed.ts): one story, in order.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type Control, holdOf, holdReport } from "../../../lib/tasks/controls.ts";
import type { Task } from "../../../lib/tasks/model.ts";
import { DEFAULT_IP, ORIGIN_SECRET } from "../../playwright.config.ts";
import { actionIdOn, closeDatabases, databases, errorOf, freshCode, mailsTo, newPage, nextLink, signInAsAdmin, signInByLink, state } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const CONTRIBUTOR = "casey@example.com";
let admin: { context: BrowserContext; page: Page };
let contributor: { context: BrowserContext; page: Page };
let member: { context: BrowserContext; page: Page };
// A lane of the board, by its name.
const lane = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test.afterAll(async () => {
  await closeDatabases();
});

test("an admin signs in with the password and the authenticator's code", async ({ browser }) => {
  admin = await newPage(browser);
  const { page } = admin;
  await signInAsAdmin(page);
  await expect(page.getByRole("link", { name: "Shop" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Blog" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "People" })).toBeVisible();
  // The session began with the second factor.
  const { accounts } = await databases();
  const user = await accounts.collection("user").findOne({ email: state().admin.email });
  const sessions = await accounts.collection("session").find({ userId: user?._id }).toArray();
  expect(sessions.map((s) => s.secondFactor)).toEqual([true]);
});

test("Better Auth's admin endpoints and enrolment aren't served over HTTP, even to an admin", async () => {
  const { page } = admin;
  for (const [method, path] of [
    ["GET", "/api/auth/admin/list-users"],
    ["POST", "/api/auth/admin/set-role"],
    ["POST", "/api/auth/two-factor/disable"],
  ] as const) {
    const response = await page.request.fetch(path, { method, data: method === "POST" ? {} : undefined, headers: { origin: state().baseURL } });
    expect(response.status(), path).toBe(403);
  }
});

test("an admin never gets a sign-in link by email", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  const before = mailsTo(state().admin.email).length;
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).first().fill(state().admin.email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  // The same answer as for anyone, and nothing sent.
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(mailsTo(state().admin.email).length).toBe(before);
  await context.close();
});

test("the admin invites a contributor", async () => {
  const { page } = admin;
  const seen = mailsTo(CONTRIBUTOR).length;
  await page.goto("/admin/people");
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Invite" }) });
  await form.getByLabel("Email", { exact: true }).fill(CONTRIBUTOR);
  await form.getByLabel("Name", { exact: true }).fill("Casey Contributor");
  await form.getByLabel("Team", { exact: true }).selectOption("shop");
  await form.getByLabel("Role", { exact: true }).selectOption("contributor");
  await form.getByLabel("What they are to the team's agents").fill("customer");
  await form.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("status")).toContainText(`Invited ${CONTRIBUTOR} to shop as a contributor`);
  await expect(page.getByText("Casey Contributor")).toBeVisible();
  await nextLink(CONTRIBUTOR, seen);

  // Their role, and their stakeholder record on the team, linked to the account (by the factory's stakeholderFor).
  const { graph, accounts } = await databases();
  const user = await accounts.collection("user").findOne({ email: CONTRIBUTOR });
  expect(user?.role).toBe("user");
  const userId = String(user?._id);
  expect(await accounts.collection("memberships").findOne({ userId, team: "shop" })).toMatchObject({ role: "contributor", label: "customer" });
  expect(await graph.collection("stakeholders").findOne({ team: "shop", userId })).toMatchObject({ email: CONTRIBUTOR, role: "customer" });
});

test("the contributor signs in by the invitation's link, sends a request, and sees only their own and the overview", async ({ browser }) => {
  contributor = await newPage(browser);
  const { page } = contributor;
  const invitation = mailsTo(CONTRIBUTOR).at(-1) ?? "";
  await page.goto(invitation);
  await expect(page).toHaveURL(/\/t\/shop$/);

  // The overview: status, progress and journeys, not the board, the graph or merges.
  await expect(page.getByRole("heading", { name: "Status" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Journeys" })).toBeVisible();
  await expect(page.getByText("Checkout")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Board" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Graph" })).toHaveCount(0);
  await expect(page.getByText("Export orders as CSV")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Decisions" })).toHaveCount(0);

  // Nobody else's requests.
  await page.getByRole("link", { name: "Requests" }).click();
  await expect(page.getByRole("heading", { name: "Your requests" })).toBeVisible();
  await expect(page.getByText("You haven't sent any yet.")).toBeVisible();
  await expect(page.getByText("Refund exports")).toHaveCount(0);

  await page.getByLabel("Title").fill("Invoices as PDF");
  await page.getByLabel("What you need, and why").fill("Our accountant asks for a PDF of each invoice.");
  await page.getByRole("button", { name: "Send the request" }).click();
  await expect(page.getByRole("status")).toContainText("Request sent");
  await expect(page.getByRole("heading", { name: "Invoices as PDF" })).toBeVisible();
  await expect(page.getByText("from you")).toBeVisible();

  await page.getByRole("link", { name: "← Requests" }).click();
  await expect(page.getByRole("link", { name: "Invoices as PDF" })).toBeVisible();
  await expect(page.locator("main li").filter({ has: page.locator(".id") })).toHaveCount(1);

  // The request carries the stakeholder's id and nothing that names them (Article 8).
  const { graph, accounts } = await databases();
  const request = await graph.collection("requests").findOne({ team: "shop", title: "Invoices as PDF" });
  const userId = String((await accounts.collection("user").findOne({ email: CONTRIBUTOR }))?._id);
  const stakeholder = await graph.collection("stakeholders").findOne({ team: "shop", userId });
  expect(request).toMatchObject({ from: stakeholder?.id, status: "new", history: [expect.objectContaining({ by: "stakeholder", what: "requested" })] });
  expect(JSON.stringify(request)).not.toMatch(/Casey|casey@example\.com/);

  // Others' requests, other teams and the admins' pages aren't there for them.
  for (const path of [`/t/shop/requests/${state().requests.promoted}`, "/t/blog", "/t/shop/proposals", "/admin/people"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Not found" }), path).toBeVisible();
  }
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Shop" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Blog" })).toHaveCount(0);
});

test("a member sees the board, the graph and every request, senders by role only", async ({ browser }) => {
  member = await newPage(browser);
  const { page } = member;
  await signInByLink(page, state().member);
  await page.goto("/t/shop");
  await expect(page.getByRole("img", { name: "The task graph" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent merges" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent merges" }).getByText("Pay by card")).toBeVisible();
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/\/t\/shop\/board$/);
  await expect(lane(page, "Proposed").getByRole("link", { name: "Export orders as CSV" })).toBeVisible();
  await expect(lane(page, "Building").getByText("builder on studio")).toBeVisible();
  await expect(lane(page, "Done").getByRole("link", { name: "Pay by card" })).toBeVisible();
  // Work the planner made of a request says who asked, by role.
  await expect(
    lane(page, "Proposed")
      .getByRole("listitem")
      .filter({ hasText: "Export orders as CSV" })
      .getByText(/^requested by customer/)
  ).toBeVisible();

  await page.goto("/t/shop/requests");
  await expect(page.getByRole("heading", { name: "All requests" })).toBeVisible();
  for (const title of ["Refund exports", "A fax integration", "Invoices as PDF"]) await expect(page.getByRole("link", { name: title })).toBeVisible();
  await expect(page.getByText("from customer").first()).toBeVisible();
  const html = await page.content();
  expect(html).not.toMatch(/Grace|grace@example\.com|Casey|casey@example\.com/);

  // A rejected request says why; a promoted one, the tasks it became.
  await page.getByRole("link", { name: "A fax integration" }).click();
  await expect(page.getByText("nobody else has asked, and fax is going away").first()).toBeVisible();
  await page.goto(`/t/shop/requests/${state().requests.promoted}`);
  await expect(page.getByText("Export orders as CSV")).toBeVisible();
  // No decisions for a member.
  await page.goto("/t/shop/proposals");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});

// A machine's card on the Machines page.
const card = (page: Page, name: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });

// What a6g connect app sends (lib/app.ts): through the CDN like any request, from `ip`, with no cookie; a form for
// RFC 8628's endpoints, JSON for a report.
async function cli(
  path: string,
  {
    method = "POST",
    form,
    body,
    token,
    ip = DEFAULT_IP,
  }: { method?: string; form?: Record<string, string>; body?: unknown; token?: string; ip?: string } = {}
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${state().baseURL}${path}`, {
    method,
    headers: {
      "x-a6g-origin": ORIGIN_SECRET,
      "x-a6g-viewer-ip": ip,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {}
  return { status: response.status, body: parsed, headers: response.headers };
}
const CLIENT = { client_id: "a6g-cli" };
const poll = (deviceCode: unknown) =>
  cli("/api/machines/token", { form: { ...CLIENT, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: String(deviceCode) } });
const shop = {
  name: "shop",
  title: "Shop",
  part: "worker",
  store: "mongo",
  home: "~/shop",
  factory: "0.4.0",
  state: "active",
  planner: null,
  members: {},
};
const reportOf = (name: string, members: Record<string, number> = {}) => ({ name, factory: "0.4.0", teams: [{ ...shop, members }] });
// Lets a machine report again at once, as if 20 seconds had passed; with `rotate`, as if its token were a week old.
async function later(name: string, { rotate = false } = {}): Promise<void> {
  const { accounts } = await databases();
  await accounts
    .collection("machines")
    .updateOne({ name }, { $set: { at: new Date(Date.now() - 60_000), ...(rotate ? { issuedAt: new Date(Date.now() - 8 * 86_400_000) } : {}) } });
}
// The subjects of the emails to `to` so far.
const subjectsTo = (to: string): string[] =>
  readFileSync(state().log, "utf8")
    .split("\n")
    .flatMap((line) => {
      const match = /\[mail\] to=(\S+) subject=(".*?") link=/.exec(line);
      return match && match[1] === to ? [JSON.parse(match[2] ?? '""') as string] : [];
    });

// A machine linked the way a6g connect app links it, approved by the person on `page`: its token. The CLI asks from
// `ip`; `token` is the link it had, which the new one replaces.
async function linkMachine(page: Page, name: string, { ip = DEFAULT_IP, token }: { ip?: string; token?: string } = {}): Promise<string> {
  const start = await cli("/api/machines/link", { form: { ...CLIENT, name }, ip, ...(token ? { token } : {}) });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  await page.goto(String(start.body["verification_uri_complete"]).replace(state().baseURL, ""));
  await page.getByRole("button", { name: "Look it up" }).click();
  if (ip !== DEFAULT_IP) await page.getByLabel("Type the code your terminal shows, to approve it").fill(String(start.body["user_code"]));
  await page.getByRole("button", { name: `Link ${name} to my account` }).click();
  await expect(page.getByText(`${name} is linked to your account.`)).toBeVisible();
  await page.waitForTimeout(5_000);
  const linked = await poll(start.body["device_code"]);
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);
  return String(linked.body["access_token"]);
}

test("a person sees the machines linked to their account and the teams each runs; the admin sees every machine and whose it is", async () => {
  const { page } = member;
  await page.goto("/machines");
  const studio = card(page, "studio");
  await expect(studio.getByText("reporting", { exact: true })).toBeVisible();
  await expect(studio.getByRole("link", { name: "Shop" })).toBeVisible();
  // A team whose tasks are in files has no pages here: named, not linked.
  await expect(studio.getByText("Notes", { exact: true })).toBeVisible();
  await expect(studio.getByRole("link", { name: "Notes" })).toHaveCount(0);
  await expect(studio.getByText("/Users/morgan/code/shop-a6g")).toBeVisible();
  for (const other of ["attic", "kiosk"]) await expect(page.getByRole("heading", { name: other })).toHaveCount(0);
  await expect(page.getByText("Owner", { exact: true })).toHaveCount(0);
  // Each team's card says where it runs, its lead first: its members' and admins' machines, not the contributor's that
  // says it leads Shop too.
  await page.goto("/");
  await expect(page.getByRole("listitem").filter({ hasText: "Shop" }).getByText("studio (lead), attic (worker, not reporting)")).toBeVisible();
  await expect(page.getByText(/kiosk/)).toHaveCount(0);

  await admin.page.goto("/machines");
  await expect(card(admin.page, "attic").getByText("not reporting", { exact: true })).toBeVisible();
  await expect(card(admin.page, "attic").getByText(state().admin.email)).toBeVisible();
  await expect(card(admin.page, "studio").getByText("member@example.com")).toBeVisible();
  await expect(card(admin.page, "kiosk").getByText("blake@example.com")).toBeVisible();

  // A contributor has linked none, and isn't told where the team runs.
  await contributor.page.goto("/machines");
  await expect(contributor.page.getByText("None of your machines is linked yet.")).toBeVisible();
  await contributor.page.goto("/");
  await expect(contributor.page.locator("dt", { hasText: "Machines" })).toHaveCount(0);

  // Nothing about machines is in the task graphs, which the teams' agents read.
  const { graph } = await databases();
  expect(await graph.collection("machines").countDocuments()).toBe(0);
});

test("a member links a machine from its terminal: a code they look up and check, a token that only reports it", async () => {
  const { page } = member;
  const { accounts } = await databases();
  const emails = subjectsTo(state().member).length;
  // The CLI asks for a code (RFC 8628, as a form), and polls while it waits.
  const start = await cli("/api/machines/link", { form: { ...CLIENT, name: "laptop" } });
  expect(start.status).toBe(200);
  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = start.body;
  expect(user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  expect(verification_uri).toBe(`${state().baseURL}/machines/link`);
  expect(verification_uri_complete).toBe(`${String(verification_uri)}?code=${String(user_code)}`);
  expect([expires_in, interval]).toEqual([600, 5]);
  expect((await poll(device_code)).body["error"]).toBe("authorization_pending");
  const polled = Date.now();
  // The device code is kept only as its hash.
  expect(await accounts.collection("machine_links").countDocuments({ _id: device_code as never })).toBe(0);

  // The page the terminal opens only fills in the code: nothing is looked up, or counted, until the person asks.
  await page.goto(String(verification_uri_complete).replace(state().baseURL, ""));
  await expect(page.getByLabel("Code", { exact: true })).toHaveValue(String(user_code));
  await expect(page.getByText("laptop", { exact: true })).toHaveCount(0);
  await page.getByLabel("Code", { exact: true }).fill("BBBB-BBBB");
  await page.getByRole("button", { name: "Look it up" }).click();
  await expect(page.getByText("No machine is waiting for that code.")).toBeVisible();
  await page.getByLabel("Code", { exact: true }).fill(String(user_code));
  await page.getByRole("button", { name: "Look it up" }).click();
  await expect(page.getByText(String(user_code), { exact: true })).toBeVisible();
  await expect(page.getByText("laptop", { exact: true })).toBeVisible();
  await expect(page.getByText(/from 198\.51\.100\.7, the address you're on now/)).toBeVisible();
  // Asked for from the person's own address, it's approved by checking it.
  await expect(page.getByLabel("Type the code your terminal shows, to approve it")).toHaveCount(0);
  await page.getByRole("button", { name: "Link laptop to my account" }).click();
  await expect(page.getByText("laptop is linked to your account.")).toBeVisible();
  // A code works once.
  await page.goto("/machines/link");
  await page.getByLabel("Code", { exact: true }).fill(String(user_code));
  await page.getByRole("button", { name: "Look it up" }).click();
  await expect(page.getByText("No machine is waiting for that code.")).toBeVisible();

  // The CLI's next poll, no sooner than the interval, gets the token, once, never to be cached, with the account masked.
  await page.waitForTimeout(Math.max(0, polled + Number(interval) * 1000 - Date.now()));
  const linked = await poll(device_code);
  expect(linked.status).toBe(200);
  expect(linked.body).toMatchObject({ token_type: "Bearer", machine: { name: "laptop" }, account: "m•••@example.com" });
  expect(linked.headers.get("cache-control")).toMatch(/\bno-store\b/);
  const token = String(linked.body["access_token"]);
  expect(token).toMatch(/^a6gm_[A-Za-z0-9_-]{43}$/);
  expect((await poll(device_code)).body["error"]).toBe("invalid_grant");
  // Kept only as its hash; the person is emailed; the token's issue is audited, with where it went.
  expect(JSON.stringify(await accounts.collection("machines").findOne({ name: "laptop" }))).not.toContain(token.slice(5));
  expect(subjectsTo(state().member).slice(emails)).toEqual(["A machine, laptop, was linked to your Anything Factory account"]);
  expect(await accounts.collection("audit").countDocuments({ action: "machine.token", target: "laptop", ip: DEFAULT_IP })).toBe(1);

  // It reports with its token, and nothing reports without one; a report that isn't one is refused whole.
  const report = reportOf("laptop", { builder: 2 });
  expect((await cli("/api/machines/report", { body: report })).status).toBe(401);
  expect((await cli("/api/machines/report", { body: report, token: `a6gm_${"A".repeat(43)}` })).status).toBe(401);
  expect((await cli("/api/machines/report", { body: { ...report, teams: [{ ...shop, home: "shop" }] }, token })).status).toBe(400);
  expect((await cli("/api/machines/report", { body: { ...report, name: "renamed" }, token })).status).toBe(204);
  expect((await cli("/api/machines/report", { body: report, token })).status).toBe(429);
  // The token is no session: no page knows it.
  expect((await cli("/machines", { method: "GET", token })).status).toBe(307);

  await page.goto("/machines");
  // A report doesn't rename its machine: it keeps the name the person approved.
  const laptop = card(page, "laptop");
  await expect(laptop.getByText("reporting", { exact: true })).toBeVisible();
  await expect(laptop.getByText("2 builders at work")).toBeVisible();
  await expect(laptop.getByText(/just now from 198\.51\.100\.7/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "renamed" })).toHaveCount(0);

  // a6g disconnect app: the machine unlinks itself with its token, and the token is done.
  expect((await cli("/api/machines/self", { method: "DELETE", token })).status).toBe(204);
  expect((await cli("/api/machines/self", { method: "DELETE", token })).status).toBe(401);
  await page.goto("/machines");
  await expect(card(page, "laptop")).toHaveCount(0);
});

test("a code asked for from elsewhere must be typed; linking again replaces only with the old token; a refused code links nothing", async () => {
  const { page } = admin;
  const { accounts } = await databases();
  // From another address: a warning, and the code must be typed, right, to approve it.
  const desk = await cli("/api/machines/link", { form: { ...CLIENT, name: "desk" }, ip: "203.0.113.50" });
  await page.goto(String(desk.body["verification_uri_complete"]).replace(state().baseURL, ""));
  await page.getByRole("button", { name: "Look it up" }).click();
  await expect(page.getByText("This code was asked for from 203.0.113.50, not from the address you're on.")).toBeVisible();
  await page.getByRole("button", { name: "Link desk to my account" }).click();
  await expect(page.getByText("Type the code your terminal shows, to approve a machine that asked from another address.")).toBeVisible();
  // (Each answer comes back before the next try: the form empties its fields as an answer comes.)
  await expect(page.getByRole("button", { name: "Link desk to my account" })).toBeEnabled();
  await page.getByLabel("Type the code your terminal shows, to approve it").fill("BBBB-BBBB");
  await page.getByRole("button", { name: "Link desk to my account" }).click();
  await expect(page.getByText("Type the code your terminal shows, to approve a machine that asked from another address.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Link desk to my account" })).toBeEnabled();
  await page.getByLabel("Type the code your terminal shows, to approve it").fill(String(desk.body["user_code"]).toLowerCase());
  await page.getByRole("button", { name: "Link desk to my account" }).click();
  await expect(page.getByText("desk is linked to your account.")).toBeVisible();
  await page.waitForTimeout(5_000);
  const first = String((await poll(desk.body["device_code"])).body["access_token"]);
  expect((await accounts.collection("audit").findOne({ action: "machine.linked", target: "desk" }))?.["detail"]).toMatch(
    /another address than the person's/
  );

  // Linked again with its old token: the new link replaces it, and the old token is done.
  const second = await linkMachine(page, "desk", { ip: "203.0.113.50", token: first });
  expect(await accounts.collection("machines").countDocuments({ name: "desk" })).toBe(1);
  expect((await cli("/api/machines/report", { body: reportOf("desk"), token: first })).status).toBe(401);
  // Linked again without it (as a stranger's machine named after it would be): a second desk, not a replacement.
  await linkMachine(page, "desk", { ip: "203.0.113.50" });
  expect(await accounts.collection("machines").countDocuments({ name: "desk" })).toBe(2);
  expect((await cli("/api/machines/report", { body: reportOf("desk"), token: second })).status).toBe(204);
  await page.goto("/machines");
  for (const _ of [1, 2]) {
    await card(page, "desk").first().getByRole("button", { name: "Unlink desk" }).click();
    await expect(page.getByText("desk is unlinked")).toBeVisible();
  }
  expect((await cli("/api/machines/report", { body: reportOf("desk"), token: second })).status).toBe(401);

  // Refused: the CLI is told, and nothing is linked.
  const spare = await cli("/api/machines/link", { form: { ...CLIENT, name: "spare" } });
  await page.goto(`/machines/link?code=${String(spare.body["user_code"])}`);
  await page.getByRole("button", { name: "Look it up" }).click();
  await page.getByRole("button", { name: "Refuse" }).click();
  await expect(page.getByText("Refused: spare isn't linked")).toBeVisible();
  expect((await poll(spare.body["device_code"])).body["error"]).toBe("access_denied");
});

test("a machine's token is replaced each week; the old one used after the new one ends the link", async () => {
  const { accounts } = await databases();
  const old = state().studioToken;
  await later("studio", { rotate: true });
  const rotated = await cli("/api/machines/report", { body: reportOf("studio"), token: old });
  expect(rotated.status).toBe(200);
  const next = String(rotated.body["access_token"]);
  expect(next).toMatch(/^a6gm_/);
  // A CLI that missed the answer still has the old one, for a day: it gets another, and the one it missed is done.
  await later("studio");
  const again = await cli("/api/machines/report", { body: reportOf("studio"), token: old });
  expect(again.status).toBe(200);
  const newest = String(again.body["access_token"]);
  await later("studio");
  expect((await cli("/api/machines/report", { body: reportOf("studio"), token: next })).status).toBe(401);
  await later("studio");
  expect((await cli("/api/machines/report", { body: reportOf("studio"), token: newest })).status).toBe(204);
  // Once the newest has been used, the old one is a copy someone kept: the link ends, and it's audited.
  await later("studio");
  expect((await cli("/api/machines/report", { body: reportOf("studio"), token: old })).status).toBe(401);
  expect(await accounts.collection("machines").countDocuments({ name: "studio" })).toBe(0);
  expect((await cli("/api/machines/report", { body: reportOf("studio"), token: newest })).status).toBe(401);
  expect((await accounts.collection("audit").findOne({ action: "machine.unlinked", target: "studio" }))?.["detail"]).toMatch(/a replaced token was used/);
});

test("nobody finds a code by guessing, contributors link nothing, and an address gets only a few codes", async () => {
  const { page } = member;
  const waiting = await cli("/api/machines/link", { form: { ...CLIENT, name: "guessed" }, ip: "198.51.100.88" });
  // Every look counts, right or wrong, and nothing clears the count: then not even the right code shows.
  await page.goto("/machines/link");
  for (let n = 0; n < 10; n++) {
    await page.getByLabel("Code", { exact: true }).fill(`BBBB-BBB${"BCDFGHJKLM"[n] ?? "B"}`);
    await page.getByRole("button", { name: "Look it up" }).click();
    if (await page.getByText(/looks at codes in 15 minutes/).isVisible()) break;
  }
  await page.getByLabel("Code", { exact: true }).fill(String(waiting.body["user_code"]));
  await page.getByRole("button", { name: "Look it up" }).click();
  await expect(page.getByText("That's 10 looks at codes in 15 minutes: wait, then try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Link guessed/ })).toHaveCount(0);

  await contributor.page.goto("/machines/link");
  await expect(contributor.page.getByText("Only a team's members and admins link machines")).toBeVisible();

  // An address asks for five codes in 15 minutes; a request that isn't the CLI's, or names no machine, gets none.
  const statuses: number[] = [];
  for (let n = 0; n < 6; n++) statuses.push((await cli("/api/machines/link", { form: { ...CLIENT, name: `box-${n}` }, ip: "198.51.100.77" })).status);
  expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  expect((await cli("/api/machines/link", { form: { name: "laptop" }, ip: "198.51.100.78" })).status).toBe(401);
  expect((await cli("/api/machines/link", { form: { ...CLIENT, name: "../etc" }, ip: "198.51.100.78" })).status).toBe(400);

  // Each is in the audit log, a made-up token too (once per address).
  const events = await (
    await databases()
  ).accounts
    .collection("audit")
    .find({ action: { $regex: "^machine\\." } })
    .toArray();
  expect(events.map((e) => `${String(e["action"])} ${String(e["outcome"])} ${String(e["target"] ?? "")}`)).toEqual(
    expect.arrayContaining([
      "machine.linked ok laptop",
      "machine.token ok laptop",
      "machine.unlinked ok laptop",
      "machine.linked ok desk",
      "machine.refused ok spare",
      "machine.unlinked ok studio",
      "machine.refused-token refused ",
      "machine.linked failed ",
    ])
  );
});

test("a member follows the work on the board, and suggests a task, which goes to triage as theirs", async () => {
  const { page } = member;
  await page.goto("/t/shop/board");
  const building = lane(page, "Building");
  await expect(building.getByRole("link", { name: "Save the card for next time" })).toBeVisible();
  await expect(building.getByText("builder on studio")).toBeVisible();
  await expect(building.getByText(/lease \d+ min left/)).toBeVisible();
  // The team's own work says which role added it.
  await expect(building.getByText(/^by the planner/)).toBeVisible();
  await expect(lane(page, "Approved").getByRole("link", { name: "Totals round the wrong way" })).toBeVisible();
  // A member suggests; only an admin adds. Shop is the only team they're on, so there's nothing to switch to.
  await expect(page.getByRole("link", { name: "Add a task" })).toHaveCount(0);
  await expect(page.getByText("Switch team")).toHaveCount(0);

  await page.getByRole("link", { name: "Suggest a task" }).click();
  await expect(page.getByRole("heading", { name: "Suggest a task" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Journey/ })).toHaveCount(0);
  // How bad it is, asked only of a bug or a UX problem.
  await expect(page.getByLabel(/How bad/)).toHaveCount(0);
  await page.getByLabel("Kind").selectOption("ux");
  await expect(page.getByLabel("How bad it is")).toBeVisible();
  await page.getByLabel("Title").fill("Search orders by email");
  await page.getByLabel("Kind").selectOption("feature");
  await page.getByLabel("What's needed, and why").fill("Support looks up a customer's orders by email several times a day.");
  await page.getByRole("button", { name: "Suggest the task" }).click();
  await expect(page.getByRole("status")).toContainText("The planner triages it.");
  await expect(page.getByRole("heading", { name: "Search orders by email" })).toBeVisible();
  await expect(page.getByText(/^suggested by you/)).toBeVisible();
  // A task's page is the board's.
  await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("added as triage, from the web app by you")).toBeVisible();

  // In triage, by "stakeholder", from their stakeholder record: an id, never a name (Article 8).
  const { graph, accounts } = await databases();
  const userId = String((await accounts.collection("user").findOne({ email: state().member }))?._id);
  const stakeholder = await graph.collection("stakeholders").findOne({ team: "shop", userId });
  const suggested = await graph.collection("tasks").findOne({ team: "shop", title: "Search orders by email" });
  expect(suggested).toMatchObject({ status: "triage", kind: "feature", by: "stakeholder", from: stakeholder?.id, approval: null });
  expect(JSON.stringify(suggested)).not.toMatch(/Morgan|member@example\.com/);
  // On the board, as theirs.
  await page.goto("/t/shop/board");
  const card = lane(page, "Triage").getByRole("listitem").filter({ hasText: "Search orders by email" });
  await expect(card.getByText(/^suggested by you/)).toBeVisible();

  // A suggestion whose form was changed to say it's approved, under a journey, after other work, is still only a
  // suggestion.
  await page.goto("/t/shop/add");
  await page.locator("main form").evaluate((form) => {
    for (const [name, value] of [
      ["approved", "yes"],
      ["parent", "1"],
      ["after", "2"],
    ]) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name ?? "";
      input.value = value ?? "";
      form.appendChild(input);
    }
  });
  await page.getByLabel("Title").fill("Free shipping, approved");
  await page.getByLabel("What's needed, and why").fill("Every order should ship free from now on, please.");
  await page.getByRole("button", { name: "Suggest the task" }).click();
  await expect(page.getByRole("status")).toContainText("The planner triages it.");
  expect(await graph.collection("tasks").findOne({ team: "shop", title: "Free shipping, approved" })).toMatchObject({
    status: "triage",
    approval: null,
    parent: null,
    after: [],
  });
  await member.context.close();
});

test("the admin approves one proposal with a note and rejects another with a reason", async ({ browser }) => {
  // A second sign-in, with a backup code this time.
  const fresh = await newPage(browser);
  await signInAsAdmin(fresh.page, { backupCode: state().admin.backupCodes[0] ?? "" });
  await fresh.context.close();

  const { page } = admin;
  const { approve, reject } = state().proposals;
  await page.goto("/t/shop/proposals");
  await expect(page.getByRole("heading", { name: "Proposed" })).toBeVisible();

  await page
    .getByLabel("Note (optional)")
    .and(page.locator(`#approve-${approve}`))
    .fill("Ship it before the holidays");
  await page.getByRole("button", { name: `Approve #${approve}` }).click();
  await expect(page.getByRole("status")).toContainText(`#${approve} approved.`);

  await page.locator(`#reject-${reject}`).fill("Not this quarter");
  await page.getByRole("button", { name: `Reject #${reject}` }).click();
  await expect(page.getByRole("status")).toContainText(`#${reject} rejected.`);

  // Exactly what a6g task approve and reject write, as the operator.
  const { graph } = await databases();
  const approved = await graph.collection("tasks").findOne({ _id: `shop:${approve}` as never });
  expect(approved).toMatchObject({ status: "approved", approval: { by: "operator", note: "Ship it before the holidays" } });
  expect(approved?.history.at(-1)).toMatchObject({
    by: "operator",
    from: "proposed",
    to: "approved",
    what: "proposed → approved: Ship it before the holidays",
  });
  const rejected = await graph.collection("tasks").findOne({ _id: `shop:${reject}` as never });
  expect(rejected).toMatchObject({ status: "rejected", approval: null });
  expect(rejected?.notes.at(-1)).toMatchObject({ by: "operator", text: "Not this quarter" });

  // A decision the move table refuses comes back in its words.
  await page.goto("/t/shop/proposals");
  await expect(page.getByRole("button", { name: `Approve #${approve}` })).toHaveCount(0);
});

test("a contributor calling an admin's server action directly is refused, and nothing changes", async () => {
  const { untouched } = state().proposals;
  const decide = await actionIdOn(admin.page, "/t/shop/proposals");
  const invite = await actionIdOn(admin.page, "/admin/people");
  const { graph, accounts } = await databases();
  const before = await graph.collection("tasks").findOne({ _id: `shop:${untouched}` as never });

  const response = await contributor.page.request.post("/t/shop/proposals", {
    multipart: { [decide]: "", team: "shop", id: untouched, decision: "approve", text: "sneaky" },
    headers: { origin: state().baseURL },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(errorOf(response)).toContain("You can't do that here.");
  const after = await graph.collection("tasks").findOne({ _id: `shop:${untouched}` as never });
  expect(after).toMatchObject({ status: "proposed", approval: null, version: before?.version });

  const invited = await contributor.page.request.post("/admin/people", {
    multipart: { [invite]: "", email: "mallory@example.com", name: "Mallory", team: "shop", role: "member", label: "" },
    headers: { origin: state().baseURL },
    maxRedirects: 0,
  });
  expect(errorOf(invited)).toContain("You can't do that here.");
  expect(await accounts.collection("user").findOne({ email: "mallory@example.com" })).toBeNull();
});

test("the admin adds a proposal, and a task approved under a journey after another", async () => {
  const { page } = admin;
  const { graph } = await databases();
  const journey = await graph.collection("tasks").findOne({ team: "shop", title: "Checkout" });
  const paid = await graph.collection("tasks").findOne({ team: "shop", title: "Pay by card" });

  await page.goto("/t/shop/add");
  await expect(page.getByRole("heading", { name: "Add a task" })).toBeVisible();
  await page.getByLabel("Title").fill("A receipt by email");
  await page.getByLabel("Description").fill("Send the receipt once the payment goes through.");
  await page.getByRole("button", { name: "Add the task" }).click();
  await expect(page.getByRole("status")).toContainText("added, proposed.");
  // Added as the operator, and by whom: the admin's own stakeholder record, as on their requests.
  const adminStakeholder = await graph.collection("stakeholders").findOne({ team: "shop", email: state().admin.email });
  expect(adminStakeholder).toMatchObject({ role: "operator" });
  const receipt = await graph.collection("tasks").findOne({ team: "shop", title: "A receipt by email" });
  expect(receipt).toMatchObject({ status: "proposed", by: "operator", from: adminStakeholder?.id, approval: null });
  expect(receipt?.history[0]).toMatchObject({ by: "operator", what: `added as proposed, from the web app by stakeholder ${adminStakeholder?.id}` });

  await page.goto("/t/shop/add");
  await page.getByLabel("Title").fill("Refund from the order page");
  await page.getByRole("combobox", { name: /^Journey/ }).selectOption({ label: `#${journey?.id} Checkout` });
  await page.getByLabel("Comes after (task numbers)").fill(`#${paid?.id}, 999`);
  await page.getByLabel(/Approve it now/).check();
  await page.getByRole("button", { name: "Add the task" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("There's no task #999 on this team.");
  // What was typed is still there.
  await expect(page.getByLabel("Title")).toHaveValue("Refund from the order page");
  await page.getByLabel("Comes after (task numbers)").fill(`#${paid?.id}`);
  // Approved as it's added, it goes straight to the builders: it takes a code from the authenticator.
  await page.getByRole("button", { name: "Add the task" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Enter the 6-digit code the app shows.");
  await page.getByLabel(/Approve it now/).check();
  await page.getByLabel("Code from your authenticator, to approve it now").fill(await freshCode(page, state().admin.totpURI));
  await page.getByRole("button", { name: "Add the task" }).click();
  await expect(page.getByRole("status")).toContainText("added, approved.");
  await expect(page.getByRole("region", { name: "Where it stands" }).getByRole("link", { name: `#${journey?.id} Checkout` })).toBeVisible();
  await expect(page.getByRole("region", { name: "Where it stands" }).getByRole("link", { name: `#${paid?.id} Pay by card` })).toBeVisible();
  // Exactly what a6g task add --approved writes, as the operator.
  expect(await graph.collection("tasks").findOne({ team: "shop", title: "Refund from the order page" })).toMatchObject({
    status: "approved",
    by: "operator",
    parent: journey?.id,
    after: [paid?.id],
    approval: { by: "operator", note: "added approved by the operator" },
  });
  await page.goto("/t/shop/board");
  const refund = lane(page, "Approved").getByRole("listitem").filter({ hasText: "Refund from the order page" });
  // Their own, to them.
  await expect(refund.getByText(/^added by you/)).toBeVisible();
  await expect(refund.getByText("in Checkout")).toBeVisible();

  // To an admin, who asked for work is a name.
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Export orders as CSV" })
      .getByText(/^requested by Grace Hopper/)
  ).toBeVisible();
  // The member's suggestion, as the admin sees it: by name, in its history too.
  const suggestion = lane(page, "Triage").getByRole("listitem").filter({ hasText: "Search orders by email" });
  await expect(suggestion.getByText(/^suggested by Morgan Member/)).toBeVisible();
  await suggestion.getByRole("link", { name: "Search orders by email" }).click();
  await expect(page.getByText("suggested by Morgan Member <member@example.com> (sales)")).toBeVisible();
  await expect(page.getByText("added as triage, from the web app by Morgan Member")).toBeVisible();

  // A proposal's page leads to where it's decided.
  const receiptId = String(receipt?.id);
  await page.goto(`/t/shop/tasks/${receiptId}`);
  await page.getByRole("link", { name: `Decide on #${receiptId}` }).click();
  await expect(page).toHaveURL(new RegExp(`/t/shop/proposals#task-${receiptId}$`));
  await expect(page.getByRole("button", { name: `Approve #${receiptId}` })).toBeVisible();

  // Triage waits for the planner, but an admin can decide one that can't wait.
  await page.goto("/t/shop/proposals");
  await expect(page.getByRole("heading", { name: /^In triage/ })).toBeVisible();
  const triaged = String((await graph.collection("tasks").findOne({ team: "shop", title: "Search orders by email" }))?.id);
  await expect(page.getByRole("button", { name: `Reject #${triaged}` })).toBeVisible();
  await page.goto(`/t/shop/tasks/${triaged}`);
  await expect(page.getByRole("link", { name: `Decide on #${triaged}` })).toBeVisible();

  // Everything done, and what was turned down, on request.
  await page.goto("/t/shop/board");
  await lane(page, "Done").getByRole("link", { name: "show them" }).click();
  await expect(page).toHaveURL(/\/t\/shop\/board\?done=all$/);
  await expect(lane(page, "Rejected").getByRole("link", { name: "Dark mode for receipts" })).toBeVisible();
});

test("a contributor neither sees the work nor adds to it, by page or by calling the action", async () => {
  const { page } = contributor;
  for (const path of ["/t/shop/board", "/t/shop/add", "/t/shop/tasks/1"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Not found" }), path).toBeVisible();
  }
  await page.goto("/t/shop");
  await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Suggest a task" })).toHaveCount(0);
  // The add form's own fields, as the admin's page has them, posted as a browser without scripts would post them: the
  // admin's adds a task, the contributor's adds nothing.
  await admin.page.goto("/t/shop/add");
  const hidden = await admin.page
    .locator("main form input[type=hidden]")
    .evaluateAll((inputs) => inputs.map((input) => [(input as HTMLInputElement).name, (input as HTMLInputElement).value]));
  const post = (as: Page, title: string) =>
    as.request.post("/t/shop/add", {
      multipart: { ...Object.fromEntries(hidden), team: "shop", title, kind: "feature", body: "This should reach the graph only from an admin." },
      headers: { origin: state().baseURL },
    });
  await post(admin.page, "An admin's task, posted");
  await post(page, "Sneaky task");
  const { graph } = await databases();
  expect(await graph.collection("tasks").findOne({ team: "shop", title: "An admin's task, posted" })).toMatchObject({
    status: "proposed",
    by: "operator",
  });
  expect(await graph.collection("tasks").findOne({ team: "shop", title: "Sneaky task" })).toBeNull();
});

test("the admin pauses the team after the work under way, reads where it stands, and resumes it with feedback", async () => {
  const { page } = admin;
  const { graph, accounts } = await databases();
  const controls = async (): Promise<Control[]> =>
    (await graph.collection("controls").find({ team: "shop" }).sort({ _id: 1 }).toArray()).map(({ _id, ...c }) => c as unknown as Control);
  const tasks = async (): Promise<Task[]> =>
    (await graph.collection("tasks").find({ team: "shop" }).toArray()).map(({ _id, ...t }) => t as unknown as Task);
  // The lead's watchdog isn't running here: the test reports what it would, from the same functions.
  const report = (status: Record<string, unknown>) =>
    graph
      .collection("teams")
      .updateOne({ _id: "shop" as never }, { $set: { status: { members: {}, planner: "running", at: new Date().toISOString(), ...status } } });
  const panel = page.getByRole("region", { name: "Pause and resume" });

  await page.goto("/t/shop");
  await expect(panel.getByText("After the work under way")).toBeVisible();
  // A wrong code changes nothing.
  await panel.getByLabel("Code from your authenticator").first().fill("000000");
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("That code isn't right");
  expect(await controls()).toEqual([]);

  await panel.getByLabel("Note (optional, for the record and the report)").fill("Let me check the board");
  await panel
    .getByLabel("Code from your authenticator")
    .first()
    .fill(await freshCode(page, state().admin.totpURI));
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Asked to pause after the work under way");
  await expect(panel.getByText("waiting for the team's Mac")).toBeVisible();
  const [pause] = await controls();
  const building = (await tasks()).filter((t) => t.status === "building").map((t) => t.id);
  expect(pause).toMatchObject({ kind: "pause", scope: "tasks", tasks: building, note: "Let me check the board", by: expect.stringMatching(/^web:s\d+$/) });

  // The watchdog applies it: pausing, with what's left.
  const hold = holdOf(await controls());
  if (!hold) throw new Error("no hold");
  await report({ state: "pausing", hold: { ...hold, settledAt: null, left: [`#${building[0]} being built`], stuck: [], report: null } });
  await page.reload();
  await expect(panel.getByText(/Pausing after the work under way/)).toBeVisible();
  await expect(panel.getByText(`#${building[0]} being built`)).toBeVisible();
  await expect(panel.getByText("waiting for the team's Mac")).toHaveCount(0);
  await expect(panel.getByText("Pause now instead")).toBeVisible();

  // It settles: paused, and the report says where the team stands.
  const settledAt = new Date().toISOString();
  await report({ state: "paused", hold: { ...hold, settledAt, left: [], stuck: [], report: holdReport(hold, await tasks(), []) } });
  await page.reload();
  await expect(panel.getByText("Where the team stands")).toBeVisible();
  await expect(panel.locator("pre.report")).toContainText("Paused after the work under way");
  await expect(panel.locator("pre.report")).toContainText('("Let me check the board")');

  await panel.getByLabel("Feedback for the planner (optional)").fill("Looks right. Carry on with checkout.");
  await panel.getByLabel("Code from your authenticator").fill(await freshCode(page, state().admin.totpURI));
  await panel.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("status")).toContainText("Asked to resume");
  expect((await controls()).map((c) => [c.kind, c.note])).toEqual([
    ["pause", "Let me check the board"],
    ["resume", "Looks right. Carry on with checkout."],
  ]);
  const audit = await accounts
    .collection("audit")
    .find({ team: "shop", action: { $in: ["team.paused", "team.resumed"] } })
    .sort({ at: 1 })
    .toArray();
  expect(audit.map((e) => [e.action, e.outcome])).toEqual([
    ["team.paused", "refused"],
    ["team.paused", "ok"],
    ["team.resumed", "ok"],
  ]);

  // A contributor posting the same action is refused, and nothing is recorded.
  // Read as the page loads: React drops the fields a browser without scripts posts once it hydrates.
  await page.goto("/t/shop");
  const action = await panel.locator('input[name^="$ACTION_ID_"]').first().getAttribute("name");
  const refused = await contributor.page.request.post("/t/shop", {
    multipart: { [action ?? ""]: "", team: "shop", kind: "pause", scope: "now", code: "123456" },
    headers: { origin: state().baseURL },
    maxRedirects: 0,
  });
  expect(errorOf(refused)).toContain("You can't do that here.");
  expect(await controls()).toHaveLength(2);
  await report({ state: "active", hold: null });
});

test("the admin sees what the team spent: today, this week and in all against the budget, each day, and the costliest work", async () => {
  const { page } = admin;
  const { graph } = await databases();
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toLocaleDateString("sv-SE");
  const tasks = (await graph.collection("tasks").find({ team: "shop" }).toArray()) as unknown as Task[];
  const journey = tasks.find((t) => t.kind === "journey");
  const child = tasks.find((t) => t.parent === journey?.id);
  const row = (role: string, task: string | null, cost: number) => ({
    role,
    model: "claude-opus-5-5",
    task,
    requests: 3,
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    cost,
    unpriced: 0,
  });
  const usage = [
    { day: day(9), machine: "studio", rows: [row("planner", null, 4.5)] },
    { day: day(1), machine: "studio", rows: [row("builder", child?.id ?? null, 12.25), row("planner", null, 3)] },
    { day: day(0), machine: "studio", rows: [row("builder", child?.id ?? null, 6)] },
    { day: day(0), machine: "worker", rows: [row("reviewer", child?.id ?? null, 2)] },
  ];
  for (const u of usage)
    await graph
      .collection("usage")
      .updateOne({ _id: `shop:${u.day}:${u.machine}` as never }, { $set: { team: "shop", updatedAt: new Date().toISOString(), ...u } }, { upsert: true });
  await graph.collection("controls").insertOne({
    _id: "shop:k900" as never,
    team: "shop",
    id: "k900",
    version: 1,
    kind: "budget",
    by: "operator",
    at: new Date().toISOString(),
    note: "",
    scope: null,
    tasks: [],
    journeys: [],
    limits: { daily: 10, weekly: null, total: 100, since: new Date(Date.now() - 30 * 86_400_000).toISOString() },
  });
  await graph
    .collection("teams")
    .updateOne(
      { _id: "shop" as never },
      { $set: { "status.spend": { day: day(0), today: 8, week: 21.25, total: 27.75, since: day(30), unpriced: 0, at: new Date().toISOString() } } }
    );

  await page.goto("/t/shop");
  const panel = page.getByRole("region", { name: "Spend" });
  const tiles = panel.locator(".tiles li");
  await expect(tiles.nth(0)).toContainText("Today$8.00");
  await expect(tiles.nth(0)).toContainText("of $10 a day · near the budget");
  await expect(tiles.nth(1)).toContainText("This week$21");
  const since = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day(30)}T12:00:00Z`));
  await expect(tiles.nth(2)).toContainText(`Since ${since}$28`);
  await expect(panel.locator(".chart .columns li")).toHaveCount(14);
  await expect(panel.locator(".chart")).toContainText("daily budget $10");
  // The tallest day is labelled; each day's value is in its tooltip and the table.
  await expect(panel.locator(".chart .value")).toHaveText("$15");
  await panel.getByText("Each day, as a table").click();
  await expect(panel.locator("table.figures tbody tr")).toHaveCount(14);
  await expect(panel.locator("table.figures tbody tr").last()).toContainText("$8.00");
  await expect(panel.locator(".ranked").first()).toContainText(`#${journey?.id} ${journey?.title}`);
  await expect(panel.locator(".ranked").first().locator("li").first()).toContainText("$20");
  await panel.locator(".chart .columns li").nth(12).focus();
  await expect(panel.locator(".chart .columns li").nth(12).locator(".tip")).toBeVisible();
  await panel.screenshot({ path: "test-results/spend-panel.png" });

  await graph.collection("controls").deleteOne({ _id: "shop:k900" as never });
});

test("the admin sets the budget with a code; a limit left blank is none", async () => {
  const { page } = admin;
  const { graph, accounts } = await databases();
  await page.goto("/t/shop");
  const panel = page.getByRole("region", { name: "Spend" });
  await panel.getByText("Set a budget").click();
  await panel.getByLabel("A day", { exact: true }).fill("12");
  await panel.getByLabel("In all", { exact: true }).fill("$300");
  await panel.getByLabel(/start it again when the next one starts/).check();
  await panel.getByLabel("Code from your authenticator").fill(await freshCode(page, state().admin.totpURI));
  await panel.getByRole("button", { name: "Set the budget" }).click();
  await expect(page.getByRole("status")).toContainText("The budget is $12 a day, none a week, $300 in all.");
  const budget = await graph.collection("controls").findOne({ team: "shop", kind: "budget" }, { sort: { _id: -1 } });
  expect(budget).toMatchObject({ by: expect.stringMatching(/^web:s\d+$/), limits: { daily: 12, weekly: null, total: 300, autoResume: true } });
  expect(await accounts.collection("audit").findOne({ team: "shop", action: "team.budget", outcome: "ok" })).toMatchObject({
    detail: "$12 a day, none a week, $300 in all",
  });
  // The tiles measure against it at once.
  await expect(panel.locator(".tiles li").first()).toContainText("of $12 a day");
  await graph.collection("controls").deleteMany({ team: "shop", kind: "budget" });
});

test("the admin switches between teams, staying on the same page", async () => {
  const { page } = admin;
  await page.goto("/");
  await expect(page.getByRole("listitem").filter({ hasText: "Shop" }).getByRole("link", { name: "Board" })).toBeVisible();
  await page.goto("/t/shop/board");
  // It closes like a menu: on Escape, and on a click elsewhere.
  await page.getByText("Switch team").click();
  await expect(page.getByRole("link", { name: /^Blog/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: /^Blog/ })).toBeHidden();
  await page.getByText("Switch team").click();
  await page.getByRole("heading", { name: "Shop", level: 1 }).click();
  await expect(page.getByRole("link", { name: /^Blog/ })).toBeHidden();
  await page.getByText("Switch team").click();
  await page.getByRole("link", { name: /^Blog/ }).click();
  await expect(page).toHaveURL(/\/t\/blog\/board$/);
  await expect(page.getByRole("heading", { name: "Blog", level: 1 })).toBeVisible();
  await expect(lane(page, "Approved").getByRole("link", { name: "Write the launch post" })).toBeVisible();
  // From one task's page, to the other team's list: ids are a team's own.
  await page.goto("/t/blog/tasks/1");
  await page.getByText("Switch team").click();
  await page.getByRole("link", { name: /^Shop/ }).click();
  await expect(page).toHaveURL(/\/t\/shop\/board$/);
});

test("an admin session without its second factor is refused every admin page and action", async ({ browser }) => {
  // The admin adds a passkey, on an authenticator that can verify them (a PIN or biometrics).
  const { page } = admin;
  const cdp = await admin.context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const KEY = {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  } as const;
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: KEY });
  await page.goto("/account");
  await page.getByLabel("Name it").fill("Test key");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("button", { name: "Remove Test key" })).toBeVisible();
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials).toHaveLength(1);

  // The same passkey, from a browser that asks the authenticator not to verify the person (a client the server can't
  // trust to ask): the assertion has no UV flag, so the session has no second factor.
  const unverified = await newPage(browser);
  const cdp2 = await unverified.context.newCDPSession(unverified.page);
  await cdp2.send("WebAuthn.enable");
  const second = await cdp2.send("WebAuthn.addVirtualAuthenticator", { options: KEY });
  await cdp2.send("WebAuthn.addCredential", { authenticatorId: second.authenticatorId, credential: credentials[0]! });
  await unverified.page.route("**/api/auth/passkey/generate-authenticate-options*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), userVerification: "discouraged" } });
  });
  await unverified.page.goto("/sign-in");
  await unverified.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(unverified.page).toHaveURL(/\/second-factor$/);
  await expect(unverified.page.getByRole("heading", { name: "Enter your authenticator's code" })).toBeVisible();
  for (const path of ["/", "/machines", "/machines/link", "/t/shop/proposals", "/admin/people", "/account"]) {
    await unverified.page.goto(path);
    await expect(unverified.page, path).toHaveURL(/\/second-factor$/);
  }

  // Its server actions are refused, and nothing changes.
  const { untouched } = state().proposals;
  const decide = await actionIdOn(page, "/t/shop/proposals");
  const { graph } = await databases();
  const response = await unverified.page.request.post("/t/shop/proposals", {
    multipart: { [decide]: "", team: "shop", id: untouched, decision: "approve", text: "" },
    headers: { origin: state().baseURL },
    maxRedirects: 0,
  });
  expect(errorOf(response)).toContain("Enter your authenticator's code first.");
  expect(await graph.collection("tasks").findOne({ _id: `shop:${untouched}` as never })).toMatchObject({ status: "proposed", approval: null });
  // Nor can it raise itself: no new passkeys or backup codes over HTTP.
  for (const [method, path] of [
    ["GET", "/api/auth/passkey/generate-register-options"],
    ["POST", "/api/auth/two-factor/generate-backup-codes"],
  ] as const) {
    const refused = await unverified.page.request.fetch(path, {
      method,
      data: method === "POST" ? { password: "x" } : undefined,
      headers: { origin: state().baseURL },
    });
    expect(refused.status(), path).toBe(403);
  }
  // The passkey as it is now, its signature counter past the one the server has seen (an older one reads as a clone).
  const [used] = (await cdp2.send("WebAuthn.getCredentials", { authenticatorId: second.authenticatorId })).credentials;
  await unverified.context.close();

  // When the authenticator verifies them, the passkey is a second factor.
  const verified = await newPage(browser);
  const cdp3 = await verified.context.newCDPSession(verified.page);
  await cdp3.send("WebAuthn.enable");
  const third = await cdp3.send("WebAuthn.addVirtualAuthenticator", { options: KEY });
  await cdp3.send("WebAuthn.addCredential", { authenticatorId: third.authenticatorId, credential: used! });
  await verified.page.goto("/sign-in");
  await verified.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(verified.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  await verified.page.goto("/t/shop/proposals");
  await expect(verified.page.getByRole("heading", { name: "Proposed" })).toBeVisible();
  await verified.context.close();
});

test(`a person sends at most 20 requests a day`, async ({ browser }) => {
  const { context, page } = await newPage(browser);
  await signInByLink(page, state().busy);
  for (let n = 1; n <= 20; n++) {
    await page.goto("/t/shop/requests");
    await page.getByLabel("Title").fill(`Idea ${n}`);
    await page.getByRole("button", { name: "Send the request" }).click();
    await expect(page.getByRole("status")).toContainText("Request sent");
  }
  await page.goto("/t/shop/requests");
  await page.getByLabel("Title").fill("Idea 21");
  await page.getByLabel("What you need, and why").fill("Kept when it's refused.");
  await page.getByRole("button", { name: "Send the request" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("You've sent 20 requests and suggestions today");
  // What was typed is still there.
  await expect(page.getByLabel("Title")).toHaveValue("Idea 21");
  await expect(page.getByLabel("What you need, and why")).toHaveValue("Kept when it's refused.");
  const { graph } = await databases();
  expect(await graph.collection("requests").countDocuments({ team: "shop", title: /^Idea / })).toBe(20);
  await context.close();
});

test("pages fit a phone's width without scrolling sideways", async ({ browser }) => {
  const { context, page } = await newPage(browser, { storageState: await admin.context.storageState() });
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of [
    "/",
    "/t/shop",
    "/t/shop/board",
    "/t/shop/add",
    "/t/shop/tasks/1",
    "/t/shop/requests",
    "/t/shop/proposals",
    "/admin/people",
    "/admin/audit",
    "/machines",
    "/machines/link",
    "/account",
  ]) {
    await page.goto(path);
    // The page itself, not a refusal.
    await expect(page.getByRole("heading", { level: 1 }).first(), path).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await context.close();
});

test("password sign-in attempts are rate limited (Better Auth's limits, kept in the database)", async ({ request }) => {
  const statuses: number[] = [];
  for (let n = 0; n < 7; n++) {
    const response = await request.post("/api/auth/sign-in/email", {
      data: { email: state().admin.email, password: "not the password" },
      headers: { origin: state().baseURL },
    });
    statuses.push(response.status());
  }
  expect(statuses.at(-1), statuses.join(" ")).toBe(429);
  const { accounts } = await databases();
  expect(await accounts.collection("rateLimit").countDocuments()).toBeGreaterThan(0);
});

test("only the app makes an invitation: a stranger's text never reaches an email, and links go at most once a minute", async ({ request }) => {
  const to = "member@example.com";
  const subjects = () =>
    readFileSync(state().log, "utf8")
      .split("\n")
      .flatMap((line) => (line.includes(`[mail] to=${to} `) ? [/subject=(".*?") link=/.exec(line)?.[1] ?? ""] : []));
  // Sent a link earlier in this run: the cooldown is cleared, so this one goes.
  await (await databases()).accounts.collection("magic_link_sends").deleteMany({ _id: to as never });
  const before = subjects().length;
  const ask = () =>
    request.post("/api/auth/sign-in/magic-link", {
      data: { email: to, metadata: { team: "ACME. URGENT: re-verify at https://evil.example/a6g" } },
      headers: { origin: state().baseURL },
    });
  expect((await ask()).status()).toBe(200);
  await expect.poll(() => subjects().length).toBe(before + 1);
  expect(subjects().at(-1)).toBe(JSON.stringify("Your Anything Factory sign-in link"));
  expect((await ask()).status(), "the same answer").toBe(200);
  await new Promise((done) => setTimeout(done, 1000));
  expect(subjects().length, "no second link within a minute").toBe(before + 1);
});

test("a notice is shown only as the app wrote it", async () => {
  // The admin's session from the start of the story; a forged ?error= shows nothing, the app's own notice shows.
  await admin.page.goto("/t/shop/proposals?error=Your%20session%20expired%2C%20sign%20in%20at%20evil.example");
  await expect(admin.page.getByText("evil.example")).toHaveCount(0);
  await expect(admin.page.getByRole("heading", { level: 1 })).toBeVisible();
});
