// The app end to end, against a local MongoDB seeded with the factory's own functions (seed.ts): one story, in order.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { answersMessage, answersSince } from "../../../lib/tasks/answer.ts";
import { type Control, holdOf, holdReport, startingControl } from "../../../lib/tasks/controls.ts";
import { applyReview, noteDecision } from "../../../lib/tasks/decisions.ts";
import { newTask, type Task, withEvent } from "../../../lib/tasks/model.ts";
import { type MongoClientLike, storeOver } from "../../../lib/tasks/mongo.ts";
import { update } from "../../../lib/tasks/store.ts";
import { DEFAULT_IP, ORIGIN_SECRET } from "../../playwright.config.ts";
import {
  actionIdOn,
  closeDatabases,
  databases,
  errorOf,
  freshCode,
  mailsTo,
  newPage,
  nextLink,
  signInAsAdmin,
  signInByLink,
  signInWith,
  state,
} from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const CONTRIBUTOR = "casey@example.com";
let admin: { context: BrowserContext; page: Page };
let contributor: { context: BrowserContext; page: Page };
let member: { context: BrowserContext; page: Page };
// The member's session once their browser is closed, for a later look (sign-in links go at most once a minute).
let memberSession: Awaited<ReturnType<BrowserContext["storageState"]>>;
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
  await page.getByLabel("Email", { exact: true }).fill(state().admin.email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  // The same answer as for anyone. What's sent is a note that says how an admin signs in: its link is the sign-in page.
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText("An admin gets a note in place of the link")).toBeVisible();
  expect(await nextLink(state().admin.email, before)).toBe(`${state().baseURL}/sign-in`);
  await page.waitForTimeout(500);
  expect(mailsTo(state().admin.email).length).toBe(before + 1);
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

test("a member opens the graph by level: the journeys first, a journey's tasks inside it, and back out", async () => {
  const { page } = member;
  await page.goto("/t/shop");
  await page.getByRole("link", { name: "Graph", exact: true }).click();
  await expect(page).toHaveURL(/\/t\/shop\/graph$/);
  const graph = page.locator(".level-graph");
  // The top level (C1): the journey, and a card for the work in none; no task of its own.
  const checkout = graph.locator(".react-flow__node").filter({ hasText: "Checkout" });
  await expect(checkout).toBeVisible();
  await expect(checkout.getByText("Journey")).toBeVisible();
  await expect(graph.getByText("C2 · Containers")).toHaveCount(0);
  await expect(checkout.getByText("approved · 1 of 2 done")).toBeVisible();
  await expect(graph.locator(".react-flow__node").filter({ hasText: "Not in a journey" })).toBeVisible();
  await expect(graph.getByText("Pay by card")).toHaveCount(0);
  // A level down (C2): the journey's tasks, in the order they're built, and the level in the address.
  await checkout.dblclick();
  await expect(graph.getByText("C2 · Containers")).toBeVisible();
  await expect(graph.locator(".react-flow__node").filter({ hasText: "Pay by card" })).toBeVisible();
  const saving = graph.locator(".react-flow__node").filter({ hasText: "Save the card for next time" });
  await expect(saving).toBeVisible();
  await expect(saving.getByText("feature · building")).toBeVisible();
  await expect(page).toHaveURL(/\/t\/shop\/graph\?at=\d+$/);
  const at = new URL(page.url()).searchParams.get("at");
  // Coming back to the page opens the same level, though it was opened at the top, and so does a reload; the
  // breadcrumbs come back out.
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/\/t\/shop\/board$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/t/shop/graph\\?at=${at}$`));
  await expect(graph.getByText("C2 · Containers")).toBeVisible();
  await expect(saving).toBeVisible();
  await page.reload();
  await expect(graph.getByText("C2 · Containers")).toBeVisible();
  await expect(saving).toBeVisible();
  await graph.getByRole("navigation", { name: "Diagram level" }).getByRole("button", { name: "Shop: task graph" }).click();
  const loose = graph.locator(".react-flow__node").filter({ hasText: "Not in a journey" });
  await expect(loose).toBeVisible();
  await expect(graph.getByText("C2 · Containers")).toHaveCount(0);
  await expect(page).toHaveURL(/\/t\/shop\/graph$/);
  // The work in no journey: only what a member may build is a task; the rest says what it waits for.
  await loose.dblclick();
  await expect(page).toHaveURL(/\/t\/shop\/graph\?at=none$/);
  const card = (title: string) => graph.locator(".react-flow__node").filter({ hasText: title });
  await expect(card("Totals round the wrong way").getByText("Task", { exact: true })).toBeVisible();
  await expect(card("Export orders as CSV").getByText("Not approved", { exact: true })).toBeVisible();
  await expect(card("who sees a customer's past orders?").getByText("Question", { exact: true })).toBeVisible();
  await expect(card("Ship to Canada").getByText("Blocked", { exact: true })).toBeVisible();
  // The journey's page links to its level.
  await page.goto(`/t/shop/tasks/${at}`);
  await page.getByRole("link", { name: "In the graph" }).click();
  await expect(graph.getByText("Save the card for next time")).toBeVisible();
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
  // Each team's row says where it runs, its lead first: its members' and admins' machines, not the contributor's that
  // says it leads Shop too. One that isn't reporting is marked, not only said.
  await page.goto("/");
  const runsOn = page.locator("#shop").locator("dd", { hasText: "studio (lead)" });
  await expect(runsOn).toContainText("studio (lead), attic (worker)");
  await expect(runsOn.getByText("not reporting", { exact: true })).toBeVisible();
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
  // A CLI that missed the answer still has the old one, for a day: it gets another (the one it missed, used later, would
  // end the link: tests/integration/machines.test.ts).
  await later("studio");
  const again = await cli("/api/machines/report", { body: reportOf("studio"), token: old });
  expect(again.status).toBe(200);
  const newest = String(again.body["access_token"]);
  expect(newest).not.toBe(next);
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
  memberSession = await member.context.storageState();
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

test("the admin sees what waits on them and answers a question with one of its options, as the operator", async () => {
  const { page } = admin;
  const { question } = state().asks;
  // On Teams, the row's figure goes to them, and leaves the row as it was.
  await page.goto("/");
  const shop = page.locator("details#shop");
  const open = await shop.evaluate((row) => (row as HTMLDetailsElement).open);
  const figure = shop.locator("summary a", { hasText: "2 waiting on you" });
  await expect(figure).toHaveAttribute("href", "/t/shop/inbox");
  await figure.click();
  await expect(page).toHaveURL(/\/t\/shop\/inbox$/);
  await page.goBack();
  await expect(page.locator("details#shop")).toHaveJSProperty("open", open);
  await page.goto("/t/shop");
  // Every page says how much waits; the overview asks for an answer.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Waiting on you/ })).toContainText("2");
  await expect(page.getByText("2 things are waiting on you.")).toBeVisible();
  await page.getByRole("link", { name: "Answer them" }).click();
  await expect(page).toHaveURL(/\/t\/shop\/inbox$/);
  await expect(page.getByRole("navigation", { name: "Team" }).getByRole("link", { name: /Waiting on you/ })).toHaveAttribute("aria-current", "page");

  // The question as the planner put it: why it's the operator's, what the team recommends, its options.
  const item = page.locator(`#task-${question}`);
  await expect(item.getByText("who sees an order is the operator's")).toBeVisible();
  await expect(item.getByRole("definition").filter({ hasText: "(b), behind the same sign-in as checkout." })).toBeVisible();
  await expect(item.getByRole("radio")).toHaveCount(4);
  await expect(item.locator("label", { hasText: "(b) open them to signed-in customers" }).getByText("recommended")).toBeVisible();
  // A research question has nothing to approve: answer it, or reject it.
  await item.getByText(`Or decide #${question} yourself`).click();
  await expect(item.getByRole("button", { name: `Approve #${question}` })).toHaveCount(0);
  await expect(item.getByRole("button", { name: `Reject #${question}` })).toBeVisible();
  // Something else needs words; an option doesn't.
  await item.getByRole("radio", { name: /^Something else/ }).check();
  await expect(item.getByLabel("Your answer", { exact: true })).toHaveAttribute("required", "");
  await item.getByRole("radio", { name: /^\(b\) open them to signed-in customers/ }).check();
  await item.getByLabel("Anything to add (optional)").fill("Show the totals too.");
  await item.getByRole("button", { name: `Send the answer on #${question}` }).click();
  await expect(page.getByRole("status")).toContainText(`Answer sent on #${question}.`);

  // It waits on the planner now, not on the admin.
  const answered = page.getByRole("region", { name: /^Answered, with the planner/ });
  await expect(answered.getByText("Show the totals too.")).toBeVisible();
  await expect(answered.getByText("sent", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Questions for you/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Team" }).getByRole("link", { name: /Waiting on you/ })).toContainText("1");

  // In the graph: the operator's note, marked as the answer, and the task where it was, for the planner to move on.
  const { graph, accounts } = await databases();
  const task = (await graph.collection("tasks").findOne({ _id: `shop:${question}` as never })) as unknown as Task;
  expect(task).toMatchObject({ status: "question" });
  expect(task.notes.at(-1)).toMatchObject({ by: "operator", kind: "answer", text: "(b) open them to signed-in customers.\n\nShow the totals too." });
  // The recommended option with a condition added is the operator's own answer, not the recommendation as it stood.
  expect(task.notes.at(-1)).not.toHaveProperty("took");
  expect(task.history.at(-1)).toMatchObject({ by: "operator", what: "answered: (b) open them to signed-in customers. Show the totals too." });
  // What the lead's watchdog passes to the planner.
  expect(answersMessage(answersSince([task], "2000-01-01T00:00:00.000Z"))).toContain(
    `1. #${question} "Q: who sees a customer's past orders?" (question): (b)`
  );
  const logged = await accounts.collection("audit").findOne({ action: "task.answered", outcome: "ok" });
  expect(logged).toMatchObject({ team: "shop", target: `#${question} Q: who sees a customer's past orders?` });
});

test("the admin approves blocked work again from the inbox, and comes back to it", async () => {
  const { page } = admin;
  const { blocked } = state().asks;
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Waiting on you", level: 1 })).toBeVisible();
  await expect(page.getByText("1 waiting for your answer.")).toBeVisible();
  const item = page.locator(`#task-${blocked}`);
  // Why it's the operator's, and what the team recommends, always.
  await expect(item.getByText("needs the carrier's API key")).toBeVisible();
  await expect(item.getByRole("definition").filter({ hasText: "add the key to the vault, then approve it again" })).toBeVisible();
  await item.getByText(`Or decide #${blocked} yourself`).click();
  await item.locator(`#approve-${blocked}`).fill("The key is in the vault now");
  await item.getByRole("button", { name: `Approve again #${blocked}` }).click();
  await expect(page).toHaveURL(/\/inbox\?/);
  await expect(page.getByRole("status")).toContainText(`#${blocked} approved.`);
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Waiting on you", exact: true })).toBeVisible();
  const { graph } = await databases();
  expect(await graph.collection("tasks").findOne({ _id: `shop:${blocked}` as never })).toMatchObject({
    status: "approved",
    approval: { by: "operator", note: "The key is in the vault now" },
  });
});

test("only an admin sees what waits on the operator", async ({ browser }) => {
  const { context, page } = await newPage(browser, { storageState: memberSession });
  await page.goto("/t/shop");
  await expect(page.getByRole("navigation", { name: "Team" }).getByRole("link", { name: /Waiting on you/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Waiting on you/ })).toHaveCount(0);
  for (const path of ["/t/shop/inbox", "/inbox"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
  }
  await context.close();
});

test("the admin chooses what they're emailed, and a test email shows it reaches them", async () => {
  const { page } = admin;
  await page.goto("/account");
  await page.getByRole("link", { name: "Change what we email you" }).click();
  await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
  await expect(page.getByText("These are the defaults for an admin")).toBeVisible();
  await expect(page.getByRole("group", { name: /^Questions for you/ }).getByRole("radio", { name: "At once" })).toBeChecked();
  await expect(page.getByRole("group", { name: /^Work merged/ }).getByRole("radio", { name: "In the daily digest" })).toBeChecked();
  // What the team decided in their place and flagged: in the digest, until they say otherwise.
  await expect(page.getByRole("group", { name: /^Decided for you/ }).getByRole("radio", { name: "In the daily digest" })).toBeChecked();
  // This admin wants no email about merges, and their digest at 7 in Toronto.
  await page
    .getByRole("group", { name: /^Work merged/ })
    .getByText("Don't email")
    .click();
  await page.getByRole("combobox", { name: /^At/ }).selectOption("7");
  await page.getByRole("combobox", { name: /^Time zone/ }).selectOption("America/Toronto");
  await page.getByRole("button", { name: "Save notifications" }).click();
  await expect(page.getByRole("status")).toContainText("Saved.");
  await expect(page.getByRole("group", { name: /^Work merged/ }).getByRole("radio", { name: "Don't email" })).toBeChecked();
  const { accounts } = await databases();
  const user = await accounts.collection("user").findOne({ email: state().admin.email });
  expect(await accounts.collection("notification_prefs").findOne({ _id: String(user?._id) as never })).toMatchObject({
    digestHour: 7,
    timeZone: "America/Toronto",
    reminder: true,
    muted: [],
    modes: { question: "now", blocked: "digest", merged: "off" },
  });
  expect((await accounts.collection("notification_prefs").findOne({ _id: String(user?._id) as never }))?.modes).toMatchObject({ decided: "digest" });

  const seen = mailsTo(state().admin.email).length;
  await page.getByRole("button", { name: "Send me a test email" }).click();
  await expect(page.getByRole("status")).toContainText("Test email sent to your sign-in address.");
  expect(await nextLink(state().admin.email, seen)).toBe(`${state().baseURL}/account/notifications`);
});

test("the notifier emails the admin a new question at once, once, and never the member", async () => {
  // The server's notifier is off in these tests: they run it here, as the server would every minute.
  const { notifyOnce } = await import("../../server/notifier.ts");
  const { storeFor } = await import("../../server/factory.ts");
  const sent: string[] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => void sent.push(args.join(" "));
  try {
    // The first look at a team is no news, whatever happened before it.
    await notifyOnce();
    const mails = () => sent.filter((line) => line.startsWith("[mail]") && line.includes("[Shop]"));
    expect(mails()).toEqual([]);

    const shop = storeFor("shop");
    const asked = await shop.tasks.create(
      newTask({ team: "shop", title: "Q: refunds by card or credit?", kind: "research", status: "proposed", by: "planner" })
    );
    await update(shop.tasks, asked.id, (t) =>
      withEvent({ ...t, status: "question" }, "planner", "proposed → question: money is the operator's", { from: "proposed", to: "question" })
    );
    await notifyOnce();
    expect(mails()).toEqual([
      `[mail] to=${state().admin.email} subject="[Shop] Question for you: #${asked.id} Q: refunds by card or credit?" link=${state().baseURL}/t/shop/inbox#task-${asked.id}`,
    ]);
    // Read again, it isn't news again.
    await notifyOnce();
    expect(mails()).toHaveLength(1);
    expect(mails().some((line) => line.includes(state().member))).toBe(false);
  } finally {
    console.info = info;
    await (await import("../../server/db.ts")).closeMongo();
  }
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
  for (const path of ["/t/shop/board", "/t/shop/graph", "/t/shop/add", "/t/shop/tasks/1"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Not found" }), path).toBeVisible();
  }
  await page.goto("/t/shop");
  await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Graph", exact: true })).toHaveCount(0);
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
  // Closed until asked for: a stop control doesn't greet every visit.
  await expect(panel.getByText("After the work under way")).toBeHidden();
  await panel.getByText("Pause the team").click();
  await expect(panel.getByText("After the work under way")).toBeVisible();
  // A wrong code changes nothing.
  await panel.getByLabel("Code from your authenticator").first().fill("000000");
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("That code isn't right");
  expect(await controls()).toEqual([]);
  // The refused form is open again, to correct.
  await expect(panel.getByText("After the work under way")).toBeVisible();

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
  await graph.collection("teams").updateOne(
    { _id: "shop" as never },
    {
      $set: {
        "status.spend": {
          day: day(0),
          today: 8,
          week: 21.25,
          total: 27.75,
          since: day(30),
          unpriced: 0,
          at: new Date().toISOString(),
          subscriptionWeek: 1000,
          subscriptions: [{ account: "default", percent: 52, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }],
        },
      },
    }
  );

  await page.goto("/t/shop");
  const panel = page.getByRole("region", { name: "Spend" });
  const tiles = panel.locator(".tiles li");
  await expect(tiles.nth(0)).toContainText("Today$8.00");
  await expect(tiles.nth(0)).toContainText("of $10 a day · near the budget");
  await expect(tiles.nth(1)).toContainText("This week$21");
  // With the subscription measured ($1,000 a week here), each figure's share of it, and what its own report says.
  await expect(tiles.nth(1)).toContainText("2.1% of a subscription's week");
  await expect(panel.getByText(/Your subscription: 52% of this week used/)).toBeVisible();
  await expect(panel.getByText(/one subscription's week is about \$1,000 API-equivalent/)).toBeVisible();
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

  // As a share of a subscription's week, over 100% too: one and a half subscriptions' worth in all.
  await panel.getByText("Change the budget").first().click();
  await panel.getByLabel(/Percent of a subscription's week/).check();
  await panel.getByLabel("A day", { exact: true }).fill("");
  await panel.getByLabel("A week", { exact: true }).fill("60");
  await panel.getByLabel("In all", { exact: true }).fill("150%");
  await panel.getByLabel("Code from your authenticator").fill(await freshCode(page, state().admin.totpURI));
  await panel.getByRole("button", { name: "Change the budget" }).click();
  await expect(page.getByRole("status")).toContainText("The budget is none a day, 60% a week, 150% in all of a subscription's week.");
  const shares = await graph.collection("controls").findOne({ team: "shop", kind: "budget" }, { sort: { _id: -1 } });
  expect(shares).toMatchObject({ limits: { daily: null, weekly: 60, total: 150, unit: "subscription" } });
  // 21.25 of a $1,000 week is 2.1% of 60%; 27.75 is 2.8% of 150%.
  await expect(panel.locator(".tiles li").nth(1)).toContainText("2.1%");
  await expect(panel.locator(".tiles li").nth(1)).toContainText("of 60% a week");
  await expect(panel.locator(".tiles li").nth(2)).toContainText("of 150% in all");
  await graph.collection("controls").deleteMany({ team: "shop", kind: "budget" });
});

// The operator's controls of one kind on Shop, oldest first, as the store keeps them.
async function shopControls(kind: Control["kind"]): Promise<Control[]> {
  const { graph } = await databases();
  return (await graph.collection("controls").find({ team: "shop", kind }).sort({ _id: 1 }).toArray()).map(({ _id, ...c }) => c as unknown as Control);
}

test("a member reads what the team decided for the operator, and reviews none of it", async ({ browser }) => {
  const { context, page } = await newPage(browser, { storageState: memberSession });
  const { decisions } = state();
  await page.goto("/t/shop");
  const tabs = page.getByRole("navigation", { name: "Team" });
  // The same log under a name that fits who reads it, with no count of what's to review, and no agreement.
  await expect(tabs.getByRole("link", { name: /Decided for you/ })).toHaveCount(0);
  await expect(tabs.getByRole("link", { name: "Agreement" })).toHaveCount(0);
  await expect(tabs.getByRole("link", { name: "Decision log" })).toHaveText("Decision log");
  await tabs.getByRole("link", { name: "Decision log" }).click();
  await expect(page).toHaveURL(/\/t\/shop\/decided$/);

  const flagged = page.getByRole("region", { name: /^To review/ });
  const item = flagged.locator(`#${decisions.agree}`);
  await expect(item.getByRole("heading", { name: "Do guests check out without an account?" })).toBeVisible();
  await expect(item.getByText("Yes: guests check out, and are offered an account after they pay")).toBeVisible();
  await expect(item.getByText("the direction puts a first order ahead of a sign-up")).toBeVisible();
  await expect(item.getByText("flagged", { exact: true })).toBeVisible();
  await expect(item.getByText("Require an account first")).toBeVisible();
  await expect(item.getByRole("link", { name: /Pay by card$/ })).toBeVisible();
  // Why the operator wasn't asked: the rule, and the agreement in force then (theirs to open, not a member's).
  await expect(item.getByText("balanced: high stakes with medium confidence is decided and flagged, under the default agreement")).toBeVisible();
  await expect(item.getByRole("link", { name: /agreement/ })).toHaveCount(0);
  const standing = page.getByRole("region", { name: /^On the record/ });
  await expect(standing.getByRole("heading", { name: "What does the empty cart say?" })).toBeVisible();
  await expect(standing.locator(`#${decisions.agreed}`).getByText(/^The operator agreed/)).toBeVisible();
  await expect(standing.locator(`#${decisions.agreed}`).getByText("Good call.")).toBeVisible();
  // Nothing to review with, on the page or by calling the action.
  await expect(page.getByRole("button", { name: /^(Agree with|Overturn) / })).toHaveCount(0);
  await expect(page.getByText(/^Review d\d/)).toHaveCount(0);
  const review = await actionIdOn(admin.page, "/t/shop/decided");
  const refused = await page.request.post("/t/shop/decided", {
    multipart: { [review]: "", team: "shop", id: decisions.agree, verdict: "agreed", note: "" },
    headers: { origin: state().baseURL },
    maxRedirects: 0,
  });
  expect(errorOf(refused)).toContain("You can't do that here.");
  expect(await shopControls("review")).toEqual([]);
  expect((await page.goto("/t/shop/agreement"))?.status()).toBe(404);
  await context.close();
});

test("the admin reviews what the team decided for them: agrees with one call, and overturns another with what to do instead", async () => {
  const { page } = admin;
  const { decisions } = state();
  const { graph, accounts } = await databases();
  await page.goto("/t/shop");
  const tab = page.getByRole("navigation", { name: "Team" }).getByRole("link", { name: /Decided for you/ });
  await expect(tab).toContainText("2");
  await tab.click();
  await expect(page).toHaveURL(/\/t\/shop\/decided$/);
  await expect(tab).toHaveAttribute("aria-current", "page");
  const toReview = page.getByRole("region", { name: /^To review/ });
  const standing = page.getByRole("region", { name: /^On the record/ });
  const first = toReview.locator(`#${decisions.agree}`);
  await expect(first.getByText("Why you weren't asked")).toBeVisible();
  await expect(first.getByRole("link", { name: "the default agreement" })).toHaveAttribute("href", "/t/shop/agreement");
  // What was never flagged keeps its review behind a line to open.
  await expect(standing.locator(`#${decisions.plain}`).getByRole("button", { name: `Agree with ${decisions.plain}` })).toBeHidden();

  await first.getByRole("button", { name: `Agree with ${decisions.agree}` }).click();
  await expect(page.getByRole("status")).toContainText(`Agreed with ${decisions.agree}.`);
  // A control, as a pause is, by the admin's stakeholder id; the app writes nothing onto the record itself.
  expect(await shopControls("review")).toMatchObject([
    { kind: "review", by: expect.stringMatching(/^web:s\d+$/), review: { decision: decisions.agree, verdict: "agreed", note: "" } },
  ]);
  expect(await graph.collection("decisions").findOne({ _id: `shop:${decisions.agree}` as never })).toMatchObject({ review: null, version: 1 });
  const agreed = standing.locator(`#${decisions.agree}`);
  await expect(agreed.getByText(/^You agreed/)).toBeVisible();
  await expect(agreed.getByText("waiting for the team's Mac")).toBeVisible();
  await expect(agreed.getByText(`Overturn ${decisions.agree} after all`)).toBeVisible();
  await expect(tab).toContainText("1");

  // An overturn says what to do instead.
  const second = toReview.locator(`#${decisions.overturn}`);
  await expect(second.getByLabel("What to do instead")).toHaveAttribute("required", "");
  await second.getByLabel("What to do instead").fill("Add euros too: the first customers are in Ireland.");
  await second.getByRole("button", { name: `Overturn ${decisions.overturn}` }).click();
  await expect(page.getByRole("status")).toContainText(`Overturned ${decisions.overturn}.`);
  const overturned = page.getByRole("region", { name: /^Overturned/ }).locator(`#${decisions.overturn}`);
  await expect(overturned.getByText("Add euros too: the first customers are in Ireland.")).toBeVisible();
  await expect(overturned.getByText("waiting for the team's Mac")).toBeVisible();
  await expect(overturned.getByRole("button")).toHaveCount(0);
  await expect(toReview).toHaveCount(0);
  await expect(tab).toHaveText("Decided for you");
  const asked = await shopControls("review");
  expect(asked.at(-1)).toMatchObject({
    review: { decision: decisions.overturn, verdict: "overturned", note: "Add euros too: the first customers are in Ireland." },
  });

  // The lead's watchdog isn't running here: the test applies the reviews as it would, with the factory's own code.
  const shop = storeOver({ db: () => graph, close: async () => {} } as unknown as MongoClientLike, {
    name: "shop",
    tasks: { store: "mongo", database: state().a6gDatabase, lead: null },
  });
  for (const control of asked) expect((await applyReview(shop, control))?.applied).toBe(true);
  await page.reload();
  await expect(agreed.getByText("waiting for the team's Mac")).toHaveCount(0);
  await expect(overturned.getByText("waiting for the team's Mac")).toHaveCount(0);
  // It's the planner's to undo, until it notes what it did.
  await expect(overturned.getByText("with the planner")).toBeVisible();
  await noteDecision(shop, decisions.overturn, { who: "planner", text: "The price list takes euros now; nothing was priced in dollars only." });
  await page.reload();
  await expect(overturned.getByText("with the planner")).toHaveCount(0);
  await expect(overturned.getByText("The price list takes euros now; nothing was priced in dollars only.")).toBeVisible();

  const audit = await accounts.collection("audit").find({ team: "shop", action: "decision.reviewed" }).sort({ at: 1 }).toArray();
  expect(audit.map((e) => [e.outcome, e.target, e.detail])).toEqual([
    ["refused", decisions.agree, "agreed: You can't do that here."],
    ["ok", `${decisions.agree} Do guests check out without an account?`, "agreed"],
    ["ok", `${decisions.overturn} Which currencies at launch?`, "overturned: Add euros too: the first customers are in Ireland."],
  ]);
});

test("the admin changes the working agreement with a code: the level, a topic and standing instructions", async () => {
  const { page } = admin;
  const { accounts } = await databases();
  await page.goto("/t/shop/decided");
  await page.getByRole("navigation", { name: "Team" }).getByRole("link", { name: "Agreement" }).click();
  await expect(page).toHaveURL(/\/t\/shop\/agreement$/);
  const inForce = page.getByRole("region", { name: "In force" });
  await expect(inForce.getByText("balanced", { exact: true })).toBeVisible();
  await expect(inForce.getByText("Nobody has changed it: this is the default, which asks about a change of scope.")).toBeVisible();
  await expect(inForce.getByText("scope", { exact: true })).toBeVisible();
  // Each level's table, the one in force marked: balanced asks in one case of nine, hands-off in none.
  const levels = page.getByRole("region", { name: "What each level does with a question" });
  await expect(levels.getByRole("table")).toHaveCount(3);
  await expect(levels.getByRole("table", { name: /balanced/ }).getByText("in force")).toBeVisible();
  await expect(levels.getByRole("table", { name: /balanced/ }).getByRole("cell", { name: "asks", exact: true })).toHaveCount(1);
  await expect(levels.getByRole("table", { name: /hands-off/ }).getByRole("cell", { name: "asks", exact: true })).toHaveCount(0);
  // How the check-ins went: what the last test reviewed.
  const went = page.getByRole("region", { name: "The last 30 days" });
  await expect(went.getByRole("listitem").filter({ hasText: "Decided for you" })).toContainText("4");
  await expect(went.getByRole("listitem").filter({ hasText: "Overturned" })).toContainText("1");

  const form = page.getByRole("region", { name: "Change it" });
  await form.getByRole("radio", { name: /^Hands-on/ }).check();
  // A change of scope is asked until the operator says otherwise: the form starts there.
  await expect(form.getByLabel(/^Scope/)).toHaveValue("ask");
  await form.getByLabel(/^Design/).selectOption("decide");
  await form.getByLabel(/^Standing instructions/).fill("Away until Monday: batch what can wait.");
  // What's always the operator's isn't offered.
  await expect(form.getByLabel(/^Privacy/)).toHaveCount(0);
  // A wrong code changes nothing, and what was chosen and typed is still there.
  await form.getByLabel("Code from your authenticator").fill("000000");
  await form.getByRole("button", { name: "Change the agreement" }).click();
  await expect(form.getByRole("alert")).toContainText("That code isn't right");
  expect(await shopControls("agreement")).toEqual([]);
  await expect(form.getByRole("radio", { name: /^Hands-on/ })).toBeChecked();
  await expect(form.getByLabel(/^Scope/)).toHaveValue("ask");
  await expect(form.getByLabel(/^Design/)).toHaveValue("decide");
  await expect(form.getByLabel(/^Standing instructions/)).toHaveValue("Away until Monday: batch what can wait.");

  await form.getByLabel("Code from your authenticator").fill(await freshCode(page, state().admin.totpURI));
  await form.getByRole("button", { name: "Change the agreement" }).click();
  const changes = "level balanced → hands-on; design: never asked; standing instructions added";
  await expect(page.getByRole("status")).toContainText(`The agreement changed: ${changes}.`);
  const [made] = await shopControls("agreement");
  expect(made).toMatchObject({
    kind: "agreement",
    by: expect.stringMatching(/^web:s\d+$/),
    agreement: { level: "hands-on", topics: { scope: "ask", design: "decide" }, notes: "Away until Monday: batch what can wait." },
  });
  // In force from the moment it's recorded; the planner hears once the team's Mac has it.
  await expect(inForce.getByText("hands-on", { exact: true })).toBeVisible();
  await expect(inForce.getByText("scope", { exact: true })).toBeVisible();
  await expect(inForce.getByText("design", { exact: true })).toBeVisible();
  await expect(inForce.getByText("Away until Monday: batch what can wait.")).toBeVisible();
  await expect(inForce.getByText("waiting for the team's Mac")).toBeVisible();
  await expect(levels.getByRole("table", { name: /hands-on/ }).getByText("in force")).toBeVisible();
  const versions = page.getByRole("region", { name: /^Every version/ });
  await expect(versions.getByText(changes)).toBeVisible();
  await expect(versions.getByText("an admin, here")).toBeVisible();
  // The form starts from the agreement as it now is, and the same again is refused before a code is spent on it.
  await expect(form.getByRole("radio", { name: /^Hands-on/ })).toBeChecked();
  await expect(form.getByLabel(/^Scope/)).toHaveValue("ask");
  await form.getByLabel("Code from your authenticator").fill("000000");
  await form.getByRole("button", { name: "Change the agreement" }).click();
  await expect(form.getByRole("alert")).toContainText("Nothing changed");

  // The form's own fields, as a browser without scripts would post them: a contributor's change nothing.
  await page.goto("/t/shop/agreement");
  const hidden = await form
    .locator("form input[type=hidden]")
    .evaluateAll((inputs) => inputs.map((input) => [(input as HTMLInputElement).name, (input as HTMLInputElement).value]));
  await contributor.page.request.post("/t/shop/agreement", {
    multipart: { ...Object.fromEntries(hidden), team: "shop", level: "hands-off", notes: "Ask nothing.", code: "123456" },
    headers: { origin: state().baseURL },
  });
  expect(await shopControls("agreement")).toHaveLength(1);
  const audit = await accounts.collection("audit").find({ team: "shop", action: "team.agreement" }).sort({ at: 1 }).toArray();
  expect(audit.map((e) => [e.outcome, e.target, e.detail])).toEqual([
    ["refused", null, "That code isn't right. Check the app's clock, and use the code it shows now."],
    ["ok", made?.id, changes],
    ["refused", null, "Nothing changed: the agreement says that already."],
    ["refused", null, "You can't do that here."],
  ]);
});

test("a question says which rule of the agreement made it the operator's; a team on an older factory says it reads none", async () => {
  const { page } = admin;
  const { graph } = await databases();
  const [agreement] = await shopControls("agreement");
  // As the planner raises one now: judged, and routed by the agreement in force.
  const at = new Date().toISOString();
  const asked = newTask({
    team: "shop",
    title: "Q: sell outside the two launch markets?",
    kind: "research",
    status: "question",
    by: "planner",
    ask: {
      reason: "it changes who the shop serves",
      recommendation: "not yet: one more market at a time, once the first two pay their way",
      by: "planner",
      at,
      topic: "scope",
      stakes: "medium",
      confidence: "low",
      rule: "the agreement always asks about scope",
      agreement: agreement?.id ?? null,
    },
  });
  await graph.collection("tasks").insertOne({ _id: "shop:900" as never, ...asked, id: "900", version: 1 });
  try {
    await page.goto("/t/shop/inbox");
    const item = page.locator("#task-900");
    await expect(item.getByText("Asked because: the agreement always asks about scope (scope: medium stakes, low confidence).")).toBeVisible();
    await expect(item.getByRole("link", { name: "Change what the team asks you" })).toHaveAttribute("href", "/t/shop/agreement");
    // A question from before the agreement says nothing of the kind.
    await expect(page.getByText(/^Asked because/)).toHaveCount(1);
  } finally {
    await graph.collection("tasks").deleteOne({ _id: "shop:900" as never });
  }

  // Blog was published by a factory version from before the agreement: nothing to set, and no log to read.
  await page.goto("/t/blog/agreement");
  await expect(page.getByText("This team's factory version doesn't read the agreement yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change the agreement" })).toHaveCount(0);
  await page.goto("/t/blog/decided");
  await expect(page.getByText("This team's factory version doesn't keep a decision log yet.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Team" }).getByRole("link", { name: "Decided for you" })).toHaveText("Decided for you");
});

test("the admin sets how often a message may reach them; answers that take the recommendation say so, and the hints come from those", async () => {
  const { page } = admin;
  const { graph } = await databases();
  await page.goto("/t/shop/agreement");
  const inForce = page.getByRole("region", { name: "In force" });
  await expect(inForce.getByText("as the team's own settings say")).toBeVisible();
  // Nothing points anywhere yet: one overturned call isn't a pattern.
  const hints = page.getByRole("region", { name: /^What your reviews and answers suggest/ });
  await expect(hints).toHaveCount(0);

  // A digest, at most once every two hours, in place of the team's own setting.
  const form = page.getByRole("region", { name: "Change it" });
  await expect(form.getByRole("radio", { name: /^As the team's own settings say/ })).toBeChecked();
  await form.getByRole("radio", { name: /^A digest/ }).check();
  const every = form.getByLabel("A digest's window, in hours");
  await expect(every).toHaveAttribute("min", "0.25");
  await expect(every).toHaveAttribute("max", "168");
  await every.fill("2");
  await form.getByLabel("Code from your authenticator").fill(await freshCode(page, state().admin.totpURI));
  await form.getByRole("button", { name: "Change the agreement" }).click();
  await expect(page.getByRole("status")).toContainText("The agreement changed: messages: a digest, at most one every 2 h.");
  const made = (await shopControls("agreement")).at(-1);
  // The rest of the agreement is as it was.
  expect(made).toMatchObject({
    kind: "agreement",
    by: expect.stringMatching(/^web:s\d+$/),
    agreement: {
      level: "hands-on",
      topics: { scope: "ask", design: "decide" },
      notes: "Away until Monday: batch what can wait.",
      contact: { mode: "digest", everyMin: 120 },
    },
  });
  await expect(inForce.getByText("a digest, at most one every 2 h")).toBeVisible();
  await expect(form.getByRole("radio", { name: /^A digest/ })).toBeChecked();
  await expect(every).toHaveValue("2");

  // Three questions about cost, as the planner raises them under that agreement (the hints count only what happened
  // since it was set). The operator took the team's recommendation on two already; an approver's escalation waits
  // beside them.
  const at = new Date().toISOString();
  const question = (id: string, title: string, fields: Partial<Task>) => ({
    _id: `shop:${id}` as never,
    ...newTask({ team: "shop", title, kind: "research", status: "question", by: "planner", ...fields }),
    id,
    version: 1,
  });
  const cost = (plan: string) => ({
    reason: `what the ${plan} costs each month is the operator's`,
    recommendation: "(a) the smaller plan, until the shop outgrows it",
    by: "planner",
    at,
    topic: "cost" as const,
    stakes: "high" as const,
    confidence: "low" as const,
    rule: "hands-on: high stakes with low confidence is asked",
    agreement: made?.id ?? null,
  });
  const took = { at, by: "operator", text: "Go with your recommendation: (a) the smaller plan, until the shop outgrows it", kind: "answer" as const };
  await graph.collection("tasks").insertMany([
    question("901", "Q: which search plan?", { ask: cost("search plan"), notes: [{ ...took, took: "recommendation", topic: "cost" }] }),
    question("902", "Q: which email plan?", { ask: cost("email plan"), notes: [{ ...took, took: "recommendation", topic: "cost" }] }),
    question("903", "Q: which image plan?", {
      ask: cost("image plan"),
      body: "Images are resized by a service. Options: (a) the smaller plan, 20 dollars a month; (b) the larger one, 80 dollars a month.",
    }),
    question("904", "A loyalty scheme", {
      kind: "feature",
      ask: {
        reason: "larger than the approver may approve",
        recommendation: "build it after checkout is done",
        by: "approver",
        at,
        rule: "the approval rules: size L is over this team's M (team.json approval)",
      },
    }),
  ]);
  try {
    await page.goto("/t/shop/inbox");
    // An escalation says the approval rule that sent it up: the team's own setting, so nothing here changes it.
    const escalated = page.locator("#task-904");
    await expect(escalated.getByText("Asked because: the approval rules: size L is over this team's M (team.json approval).")).toBeVisible();
    await expect(escalated.getByRole("link", { name: "Change what the team asks you" })).toHaveCount(0);
    // The third: the option the recommendation names, with nothing added, is the recommendation as it stood, and is
    // recorded in the recommendation's own words.
    const item = page.locator("#task-903");
    await expect(item.getByRole("link", { name: "Change what the team asks you" })).toBeVisible();
    await item.getByRole("radio", { name: /^\(a\) the smaller plan, 20 dollars a month/ }).check();
    await item.getByRole("button", { name: "Send the answer on #903" }).click();
    await expect(page.getByRole("status")).toContainText("Answer sent on #903.");
    const answered = (await graph.collection("tasks").findOne({ _id: "shop:903" as never })) as unknown as Task;
    expect(answered.notes.at(-1)).toMatchObject({
      by: "operator",
      kind: "answer",
      text: "Go with your recommendation: (a) the smaller plan, until the shop outgrows it",
      took: "recommendation",
      topic: "cost",
    });

    // Three of three: the agreement's page says what that suggests, and changes nothing itself.
    await page.goto("/t/shop/agreement");
    await expect(hints.getByText("since it was last changed, and at most the last 30 days")).toBeVisible();
    await expect(hints.getByText("You took the team's recommendation, as it stood, on all 3 cost questions it asked.")).toBeVisible();
    await expect(hints.getByText("Never ask about Cost")).toBeVisible();
    await expect(hints.getByText("a6g agreement shop --never cost")).toBeVisible();
    await expect(hints.getByRole("link", { name: "below" })).toHaveAttribute("href", "#change");
    await expect(form.getByLabel(/^Cost/)).toHaveValue("follow");
    expect(await shopControls("agreement")).toHaveLength(2);
  } finally {
    await graph.collection("tasks").deleteMany({ _id: { $in: ["shop:901", "shop:902", "shop:903", "shop:904"] as never[] } });
  }
  await page.goto("/t/shop/agreement");
  await expect(hints).toHaveCount(0);
});

test("an answer or a decision on a task the team changed after the page was loaded comes back with the task as it stands", async () => {
  const { page } = admin;
  const { graph } = await databases();
  const tasks = graph.collection("tasks");
  const at = new Date().toISOString();
  const doc = (id: string, fields: Parameters<typeof newTask>[0]) => ({ _id: `shop:${id}` as never, ...newTask(fields), id, version: 1 });
  const stored = async (id: string): Promise<Task> => (await tasks.findOne({ _id: `shop:${id}` as never })) as unknown as Task;
  await tasks.insertMany([
    doc("911", {
      team: "shop",
      title: "Q: which courier?",
      kind: "research",
      status: "question",
      by: "planner",
      body: "Parcels need a courier. Options: (a) the national post, slower and cheaper; (b) a courier, the next day.",
      ask: { reason: "what delivery costs is the operator's", recommendation: "(a) the national post, slower and cheaper", by: "planner", at },
    }),
    doc("912", { team: "shop", title: "Gift wrapping", kind: "feature", status: "proposed", by: "planner", body: "Wrap an order for a small fee." }),
  ]);
  try {
    await page.goto("/t/shop/inbox");
    const item = page.locator("#task-911");
    const post = item.getByRole("radio", { name: /^\(a\) the national post, slower and cheaper/ });
    await expect(post).toBeVisible();
    // The planner learns something and puts the question the other way round, while the page is open.
    const changed = new Date().toISOString();
    await tasks.updateOne({ _id: "shop:911" as never }, {
      $set: { "ask.recommendation": "(b) the national post, now that it delivers the next day", "ask.at": changed, updatedAt: changed },
      $push: {
        notes: {
          at: changed,
          by: "planner",
          text: "The post now delivers the next day. Options: (a) a courier, at twice the price; (b) the national post. Recommendation: (b) the national post.",
        },
      },
      $inc: { version: 1 },
    } as never);
    // (a) on this page is the post; on the task it's the courier now. The answer isn't recorded against either.
    await post.check();
    await item.getByRole("button", { name: "Send the answer on #911" }).click();
    await expect(item.getByRole("alert")).toContainText(
      "The team changed #911 after this page was loaded. It's shown as it stands now: read it again, then answer."
    );
    expect((await stored("911")).notes.filter((n) => n.by === "operator")).toHaveLength(0);
    const courier = item.getByRole("radio", { name: /^\(a\) a courier, at twice the price/ });
    await expect(courier).toBeVisible();
    await expect(courier).not.toBeChecked();
    await courier.check();
    await item.getByRole("button", { name: "Send the answer on #911" }).click();
    await expect(page.getByRole("status")).toContainText("Answer sent on #911.");
    expect((await stored("911")).notes.at(-1)).toMatchObject({ by: "operator", kind: "answer", text: "(a) a courier, at twice the price." });

    // A proposal the planner edits while the Decisions page is open: the decision is on what was read.
    await page.goto("/t/shop/proposals");
    await expect(page.getByRole("button", { name: "Reject #912" })).toBeVisible();
    await tasks.updateOne({ _id: "shop:912" as never }, { $set: { body: "Wrap every order, at no charge.", updatedAt: changed }, $inc: { version: 1 } });
    await page.locator("#reject-912").fill("Not this quarter");
    await page.getByRole("button", { name: "Reject #912" }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText(
      "#912 changed after this page was loaded. It's shown as it stands now: read it again, then decide."
    );
    expect(await stored("912")).toMatchObject({ status: "proposed" });
    await page.locator("#reject-912").fill("Not this quarter");
    await page.getByRole("button", { name: "Reject #912" }).click();
    await expect(page.getByRole("status")).toContainText("#912 rejected.");
    expect(await stored("912")).toMatchObject({ status: "rejected" });
  } finally {
    await tasks.deleteMany({ _id: { $in: ["shop:911", "shop:912"] as never[] } });
  }
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

// Running the factory from the app (docs/plans/run-from-the-site.md): the Teams page that folds, a team's
// subscriptions, and asking a Mac to start a project.

test("the Teams page folds: its key goes to the team, and what's left open is kept, one at a time or all", async () => {
  const { page } = admin;
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("a6g.teams.open");
    localStorage.removeItem("a6g.teams.one");
  });
  await page.reload();
  const shop = page.locator("details#shop");
  const blog = page.locator("details#blog");
  await expect(page.getByRole("heading", { name: /^All teams/ })).toBeVisible();
  // A shut row still says how the team is; an open one shows where its work stands and the ways in.
  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(shop).toHaveJSProperty("open", false);
  await expect(shop.locator("summary")).toContainText("at work");
  await expect(shop.getByRole("link", { name: "Board" })).toBeHidden();
  await shop.locator("summary").click();
  await expect(shop.getByRole("link", { name: "Board" })).toBeVisible();
  await expect(shop.getByRole("link", { name: "Add a task" })).toHaveAttribute("href", "/t/shop/add");
  await expect(shop.locator(".counts li")).toHaveCount(7);
  // Folding has its own words; the row's key says where it goes.
  await expect(page.getByRole("link", { name: "Shop: overview" })).toHaveAttribute("href", "/t/shop");

  // Kept in this browser.
  await page.reload();
  await expect(page.locator("details#shop")).toHaveJSProperty("open", true);
  await expect(page.locator("details#blog")).toHaveJSProperty("open", false);

  // One at a time: opening one shuts the other; all can't be opened while it holds.
  const one = page.getByRole("button", { name: "One at a time" });
  await one.click();
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Expand all" })).toBeDisabled();
  await blog.locator("summary").click();
  await expect(blog).toHaveJSProperty("open", true);
  await expect(shop).toHaveJSProperty("open", false);
  // A link that names a team opens that one.
  await page.goto("/#shop");
  await expect(page.locator("details#shop")).toHaveJSProperty("open", true);
  await expect(page.locator("details#blog")).toHaveJSProperty("open", false);
  await one.click();
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.locator("details.team[open]")).toHaveCount(2);
  await page.evaluate(() => {
    localStorage.removeItem("a6g.teams.open");
    localStorage.removeItem("a6g.teams.one");
  });
});

test("a team no Mac runs is marked and its answers wait; the admin takes it off the site with a code and puts it back; Teams names the Macs' teams it doesn't show", async () => {
  test.setTimeout(150_000);
  const { page } = admin;
  const { graph, accounts } = await databases();
  const teams = graph.collection<{ _id: string; status?: { at: string } }>("teams");
  const was = { blog: (await teams.findOne({ _id: "blog" }))?.status?.at, shop: (await teams.findOne({ _id: "shop" }))?.status?.at };
  // The admin's Mac also leads a team whose tasks are in files.
  const machines = accounts.collection<{ _id: string; teams?: unknown[] }>("machines");
  const atticTeams = (await machines.findOne({ name: "attic" }))?.teams ?? [];
  const notes = {
    name: "notes",
    title: "Notes",
    part: "lead",
    store: "files",
    factory: "0.8.1",
    state: "paused",
    planner: null,
    members: {},
    home: "~/code/notes-a6g",
  };
  await machines.updateOne({ name: "attic" }, { $set: { teams: [...atticTeams, notes] } });
  // Blog's Mac last reported two hours ago; Shop's just now.
  await teams.updateOne({ _id: "blog" }, { $set: { "status.at": new Date(Date.now() - 2 * 3_600_000).toISOString() } });
  await teams.updateOne({ _id: "shop" }, { $set: { "status.at": new Date().toISOString() } });
  try {
    await page.goto("/");
    await expect(page.locator("details#blog summary")).toContainText("no Mac runs it");
    await expect(page.locator("details#shop summary")).not.toContainText("no Mac runs it");
    // A team a linked Mac runs with its tasks in files is named under the rows, and why it isn't one.
    await expect(page.locator(".teams-foot")).toContainText(
      "Notes on attic: its tasks are in files on that Mac (a6g task migrate --to mongo moves them here)"
    );
    await page.goto("/t/blog/inbox");
    await expect(page.locator(".team-head")).toContainText("no Mac runs it");
    await expect(page.getByText(/^No Mac runs this team now \(last heard from .*\): an answer waits until one does\.$/)).toBeVisible();

    // Shop's Mac runs it: its overview says to unregister it there, and has no form.
    await page.goto("/t/shop");
    const panel = page.getByRole("region", { name: "On the site" });
    await expect(panel).toContainText("A Mac runs it: it last reported just now.");
    await expect(panel.getByText("a6g unregister shop")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Take it off the site" })).toHaveCount(0);

    // Blog comes off with a note and a code.
    await page.goto("/t/blog");
    await expect(panel).toContainText("No Mac runs it now: it was last heard from 2 h ago.");
    await panel.locator("summary", { hasText: "Take it off the site" }).click();
    await panel.getByLabel("Why (optional, for the record)").fill("A trial that's over");
    await panel.getByLabel("Code from your authenticator").fill(await freshCode(page, state().admin.totpURI));
    await panel.getByRole("button", { name: "Take it off the site" }).click();
    await expect(page.getByRole("status")).toContainText("Taken off the site.");
    await expect(page.locator(".notice.off-site")).toContainText("Taken off the site");
    await expect(panel).toContainText("by an admin, here (“A trial that's over”)");
    // Off every list: Teams (named at the foot instead), Waiting on you, the switcher.
    await page.goto("/");
    await expect(page.locator("details#blog")).toHaveCount(0);
    await expect(page.locator(".teams-foot")).toContainText("Taken off the site: Blog. Each one's overview puts it back.");
    await page.goto("/inbox");
    await expect(page.getByRole("heading", { name: "Waiting on you", level: 1 })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Blog");
    const recorded = await graph
      .collection("controls")
      .find({ team: "blog", kind: { $in: ["retire", "restore"] } })
      .toArray();
    expect(recorded.map((c) => [c.kind, c.by.startsWith("web:"), c.note])).toEqual([["retire", true, "A trial that's over"]]);
    expect(await accounts.collection("audit").findOne({ team: "blog", action: "team.retired", outcome: "ok" })).toMatchObject({
      detail: "A trial that's over",
    });

    // And back on, from its overview.
    await page.goto("/t/blog");
    await panel.getByLabel("Code from your authenticator").fill(await freshCode(page, state().admin.totpURI));
    await panel.getByRole("button", { name: "Put it back on the site" }).click();
    await expect(page.getByRole("status")).toContainText("Back on the site");
    await expect(page.locator(".notice.off-site")).toHaveCount(0);
    await page.goto("/");
    await expect(page.locator("details#blog")).toHaveCount(1);
    await expect(page.locator(".teams-foot")).not.toContainText("Taken off the site");
  } finally {
    for (const team of ["blog", "shop"] as const) await teams.updateOne({ _id: team }, { $set: { "status.at": was[team] ?? new Date().toISOString() } });
    await machines.updateOne({ name: "attic" }, { $set: { teams: atticTeams } });
  }
});

test("the admin chooses a team's subscriptions with a code, from what its Mac reports; an older team is told where they're chosen", async () => {
  const { page } = admin;
  const { graph, accounts } = await databases();
  // A team whose Mac doesn't report its subscriptions has no form.
  await page.goto("/t/shop");
  const panel = page.getByRole("region", { name: "Subscriptions" });
  await expect(panel).toContainText("chosen on its Mac for now");
  await expect(panel.getByText("Change the order")).toHaveCount(0);

  // Its lead reports them: two on its list (one used up), one not, and the reviewers with an order of their own.
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
  await graph.collection<{ _id: string }>("teams").updateOne(
    { _id: "shop" },
    {
      $set: {
        "status.subscriptions": {
          available: [
            { name: "default", percent: 41, resetsAt: soon, closed: null },
            { name: "work", percent: 100, resetsAt: soon, closed: "work has used its week" },
            { name: "spare", percent: null, resetsAt: null, closed: null },
          ],
          use: { "*": ["work", "default"], reviewer: ["default"] },
          roles: { planner: "default", builder: "default", reviewer: "default" },
          moving: {},
          waiting: {},
        },
      },
    }
  );
  await page.reload();
  await expect(panel.getByRole("heading", { name: "The order for the planner and builders" })).toBeVisible();
  const listed = panel.locator("ol.subs > li");
  await expect(listed).toHaveCount(3);
  await expect(listed.nth(0)).toContainText("work");
  await expect(listed.nth(0)).toContainText("closed");
  await expect(listed.nth(0)).toContainText("100% of its week used · opens again");
  await expect(listed.nth(2)).toContainText("not in its order");
  await expect(panel).toContainText("The reviewers have an order of their own: default.");

  // The form starts from the order in force, and says what changing it leaves alone.
  await panel.getByText("Change the order").click();
  await expect(panel.getByLabel("Whose order")).toContainText("The planner and builders");
  await expect(panel).toContainText("The reviewers keep their own order (default).");
  await panel.getByRole("button", { name: "Move default up" }).click();
  await panel.getByRole("button", { name: "Add spare to the list" }).click();
  // A wrong code changes nothing, and the form is there again.
  await panel.getByLabel(/Code from your authenticator/).fill("000000");
  await panel.getByRole("button", { name: "Save this order" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await shopControls("subscriptions")).toHaveLength(0);
  await expect(panel.getByRole("button", { name: "Save this order" })).toBeVisible();

  await panel.getByRole("button", { name: "Move default up" }).click();
  await panel.getByRole("button", { name: "Add spare to the list" }).click();
  await panel.getByLabel(/Code from your authenticator/).fill(await freshCode(page, state().admin.totpURI));
  await panel.getByRole("button", { name: "Save this order" }).click();
  await expect(page.getByRole("status").first()).toContainText("The team runs on default, then work, then spare.");
  // The newest by when it was asked: ids sort as text, so k10 comes before k9.
  const newest = () => graph.collection("controls").findOne({ team: "shop", kind: "subscriptions" }, { sort: { at: -1 } });
  expect(await newest()).toMatchObject({
    by: expect.stringMatching(/^web:s\d+$/),
    subscriptions: { role: null, use: ["default", "work", "spare"] },
  });
  expect(await accounts.collection("audit").findOne({ team: "shop", action: "team.subscriptions", outcome: "ok" })).toMatchObject({
    detail: "The team runs on default, then work, then spare",
  });
  // Until the Mac says it has it, the panel says what was asked.
  await expect(panel).toContainText("default, then work, then spare. The team's Mac applies it within a minute.");

  // One role's own order: cleared, they follow the team's again.
  await panel.getByText("Change the order").click();
  await panel.getByLabel("Whose order").selectOption("reviewer");
  await expect(panel).toContainText("This replaces the reviewers' own order.");
  await panel.getByRole("button", { name: "Take default off the list" }).click();
  await panel.getByLabel(/Code from your authenticator/).fill(await freshCode(page, state().admin.totpURI));
  await panel.getByRole("button", { name: "Save this order" }).click();
  await expect(page.getByRole("status").first()).toContainText("The reviewers follow the team's list.");
  expect(await newest()).toMatchObject({ subscriptions: { role: "reviewer", use: [] } });

  // Blog is published as an older factory version publishes: its subscriptions are chosen on its Mac.
  await page.goto("/t/blog");
  await expect(page.getByRole("region", { name: "Subscriptions" })).toContainText("a6g subscriptions use blog");
  await graph.collection("controls").deleteMany({ team: "shop", kind: "subscriptions" });
  await graph.collection<{ _id: string }>("teams").updateOne({ _id: "shop" }, { $unset: { "status.subscriptions": "" } });
});

test("the admin asks a Mac of theirs to start a project: each step as the Mac says it, one that stopped with its command, and taking an ask back", async ({
  browser,
}) => {
  const { page } = admin;
  const { graph, accounts } = await databases();
  // A field of the form by its own name, whole: "Title" is also a word in a choice's hint.
  const field = (name: string) => page.getByRole("textbox", { name, exact: true });
  // No Mac of theirs starts projects until it's said at its terminal: the page says how.
  await page.goto("/new");
  await expect(page.getByRole("heading", { name: "None of your Macs starts projects yet" })).toBeVisible();
  await expect(page.getByText("a6g connect app --projects ~/code")).toBeVisible();

  // Their Mac reports that it does, with what it offers.
  const attic = await accounts.collection<{ _id: string }>("machines").findOne({ name: "attic" });
  expect(attic).toBeTruthy();
  const offers = { dir: "~/code", repos: ["blog-engine"], subscriptions: [{ name: "default", percent: 41 }] };
  await accounts
    .collection<{ _id: string }>("machines")
    .updateOne({ _id: attic?._id ?? "" }, { $set: { projects: offers, projectsKnown: true, at: new Date(), lastSeenAt: new Date() } });
  await page.goto("/machines");
  await expect(card(page, "attic")).toContainText("yes, in ~/code · 1 repository with no team");

  await page.goto("/");
  await page.getByRole("link", { name: "Start a project" }).click();
  await expect(page).toHaveURL(/\/new$/);
  // The key waits for the form; a name that's taken is said as it's typed.
  const send = page.getByRole("button", { name: "Start the project" });
  await expect(send).toBeDisabled();
  await expect(page.locator("#start-missing")).toHaveText("Needs a title, a short name, what should exist when the team is done and a folder.");
  await field("Title").fill("Shop");
  await expect(field("Short name")).toHaveValue("shop");
  await expect(page.getByText("There's a team named shop already.")).toBeVisible();
  // The short name and the new repository's folder follow the title until one is typed.
  await field("Title").fill("Shop two");
  await expect(field("Short name")).toHaveValue("shop-two");
  await expect(field("Folder")).toHaveValue("shop-two");
  await expect(page.getByText("~/code/shop-two-a6g")).toBeVisible();
  await field("What should exist when the team is done").fill("A shop that takes orders.\n\nIt ships to Canada.");
  // What's blank is said back as a choice.
  const recap = page.locator("dl.recap");
  await expect(recap).toContainText("none: it spends without a limit");
  await expect(recap).toContainText("attic's own login");
  await field("A day, in dollars").fill("20");
  await page.getByRole("button", { name: "Add default to the list" }).click();
  await expect(recap).toContainText("$20 a day");
  await expect(recap).toContainText("shop-two");
  await expect(send).toBeEnabled();
  await expect(page.locator("#start-missing")).toHaveCount(0);
  // A wrong code keeps what was typed.
  await page.getByRole("textbox", { name: /Code from your authenticator/ }).fill("000000");
  await send.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(field("What should exist when the team is done")).toHaveValue("A shop that takes orders.\n\nIt ships to Canada.");
  await expect(field("Title")).toHaveValue("Shop two");
  expect(await graph.collection("controls").countDocuments({ team: "shop-two" })).toBe(0);

  await page.getByRole("textbox", { name: /Code from your authenticator/ }).fill(await freshCode(page, state().admin.totpURI));
  await send.click();
  await expect(page).toHaveURL(/\/\?ok=/);
  await expect(page.getByRole("status").first()).toContainText("Asked attic to start Shop two.");
  const asked = await graph.collection("controls").findOne({ team: "shop-two", kind: "start" });
  expect(asked).toMatchObject({
    id: "k1",
    by: expect.stringMatching(/^web:s\d+$/),
    start: {
      machine: attic?._id,
      machineName: "attic",
      title: "Shop two",
      repo: { create: "shop-two" },
      goal: "A shop that takes orders.\n\nIt ships to Canada.",
      technical: true,
      limits: { daily: 20, weekly: null, total: null, unit: "usd" },
      use: ["default"],
    },
  });
  expect(await accounts.collection("audit").findOne({ team: "shop-two", action: "project.asked", outcome: "ok" })).toBeTruthy();
  const starting = page.locator("#start-shop-two");
  await expect(starting.getByRole("heading", { name: "Shop two" })).toBeVisible();
  await expect(starting).toContainText("waiting for the Mac");
  await expect(starting).toContainText("attic looks every five minutes.");
  // The same name can't be asked for twice.
  await page.goto("/new");
  await field("Title").fill("Shop two");
  await expect(page.getByText("There's a team named shop-two already.")).toBeVisible();

  // The Mac says each step (lib/commands/projects.ts): the card follows.
  const mac = storeOver({ db: () => graph, close: async () => {} } as unknown as MongoClientLike, {
    name: "shop-two",
    tasks: { store: "mongo", database: state().a6gDatabase, lead: null },
  });
  for (const step of ["picked-up", "repository", "draft", "setup"] as const)
    await mac.controls.create(startingControl("shop-two", "attic", { of: "k1", step, problem: null }));
  await page.goto("/");
  await expect(starting).toContainText("setting the team up");
  await expect(starting).toContainText("A setup agent is finishing the team's rules.");
  await expect(starting.locator("ol.marks li.done")).toHaveCount(3);
  await expect(starting.locator("ol.marks li.now")).toContainText("Setup");
  // Under way, it can't be withdrawn.
  await expect(starting.getByRole("button", { name: /Withdraw/ })).toHaveCount(0);

  // It stops: why, what the failing command said, what to do, and the command to run, each on its own.
  await mac.controls.create(
    startingControl("shop-two", "attic", {
      of: "k1",
      step: "failed",
      stoppedAt: "check",
      problem: "The setup didn't pass its check.",
      said: "gate.sh: typecheck failed",
      fix: "To finish the setup yourself, on attic:",
      command: "a6g init ~/code/shop-two --name shop-two",
    })
  );
  await page.reload();
  await expect(starting).toContainText("stopped");
  await expect(starting.locator("ol.marks li.stopped")).toContainText("Check");
  await expect(starting.locator(".notice.error")).toContainText("The setup didn't pass its check.");
  await expect(starting.locator(".notice.error .said")).toHaveText("gate.sh: typecheck failed");
  await expect(starting).toContainText("To finish the setup yourself, on attic:");
  await expect(starting.locator(".command code")).toHaveText("a6g init ~/code/shop-two --name shop-two");
  // Asked again, the form opens with what that one said.
  await starting.getByRole("link", { name: "Ask again" }).click();
  await expect(page).toHaveURL(/\/new\?again=shop-two$/);
  await expect(field("Title")).toHaveValue("Shop two");
  await expect(field("Short name")).toHaveValue("shop-two");
  await expect(field("What should exist when the team is done")).toHaveValue("A shop that takes orders.\n\nIt ships to Canada.");
  await expect(field("A day, in dollars")).toHaveValue("20");
  // Cleared, it's gone from the page: a start with nothing in it.
  await page.goto("/");
  await starting.getByRole("button", { name: "Clear Shop two" }).click();
  await expect(page.getByRole("status").first()).toContainText("Cleared Shop two from this page.");
  await expect(page.locator("#start-shop-two")).toHaveCount(0);
  expect(await graph.collection("controls").findOne({ team: "shop-two", kind: "start" }, { sort: { at: -1 } })).toMatchObject({ start: null });

  // One the Mac hasn't picked up is taken back; an existing repository is chosen from the Mac's own.
  await page.goto("/new");
  await field("Title").fill("Blog engine");
  await field("What should exist when the team is done").fill("Posts, tags and a feed.");
  await page.getByText("One that's there already").click();
  await expect(page.getByRole("combobox", { name: "Repository" })).toHaveValue("blog-engine");
  await page.getByText("The team chooses").click();
  await page.getByRole("textbox", { name: /Code from your authenticator/ }).fill(await freshCode(page, state().admin.totpURI));
  await page.getByRole("button", { name: "Start the project" }).click();
  await expect(page.getByRole("status").first()).toContainText("Asked attic to start Blog engine.");
  expect(await graph.collection("controls").findOne({ team: "blog-engine", kind: "start" })).toMatchObject({
    start: { repo: { existing: "blog-engine" }, technical: false, limits: null, use: [] },
  });
  // The new pages fit a phone's width, with a project being started on them.
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of ["/", "/new", "/machines"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first(), path).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), path).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.locator("#start-blog-engine").getByRole("button", { name: "Withdraw Blog engine" }).click();
  await expect(page.getByRole("status").first()).toContainText("Withdrawn: attic won't start Blog engine.");
  await expect(page.getByRole("heading", { name: /^Being started/ })).toHaveCount(0);
  expect(await accounts.collection("audit").countDocuments({ action: "project.withdrawn", outcome: "ok" })).toBe(2);

  // Only an admin asks: a member has no such page, and no key to it.
  const other = await newPage(browser, { storageState: memberSession });
  await other.page.goto("/");
  await expect(other.page.getByRole("link", { name: "Start a project" })).toHaveCount(0);
  await other.page.goto("/new");
  await expect(other.page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await other.context.close();

  // As it was: the Mac starts no projects, and nothing of these two is left.
  await accounts.collection<{ _id: string }>("machines").updateOne({ _id: attic?._id ?? "" }, { $unset: { projects: "", projectsKnown: "" } });
  for (const name of ["controls", "stakeholders"]) await graph.collection(name).deleteMany({ team: { $in: ["shop-two", "blog-engine"] } });
  await graph
    .collection<{ _id: string }>("counters")
    .deleteMany({ _id: { $in: ["shop-two:controls", "shop-two:stakeholders", "blog-engine:controls", "blog-engine:stakeholders"] } });
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
  await signInWith(unverified.page, "Passkey");
  await unverified.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(unverified.page).toHaveURL(/\/second-factor$/);
  await expect(unverified.page.getByRole("heading", { name: "Enter your authenticator's code" })).toBeVisible();
  for (const path of ["/", "/machines", "/machines/link", "/t/shop/proposals", "/t/shop/decided", "/t/shop/agreement", "/admin/people", "/account"]) {
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
  await signInWith(verified.page, "Passkey");
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
    "/t/shop/graph",
    "/t/shop/add",
    "/t/shop/tasks/1",
    "/t/shop/requests",
    "/t/shop/proposals",
    "/t/shop/decided",
    "/t/shop/agreement",
    "/t/shop/inbox",
    "/inbox",
    "/admin/people",
    "/admin/audit",
    "/machines",
    "/machines/link",
    "/account",
    "/account/notifications",
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
