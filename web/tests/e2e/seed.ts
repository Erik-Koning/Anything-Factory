// The end-to-end tests' world, made with the factory's own functions over the test database: two teams' published
// settings and status, a task graph with proposals, a question for the operator and blocked work, stakeholders'
// requests (one promoted, one rejected), the first admin (by create-admin's own code), a member and a contributor whose
// daily limit the tests reach, three machines linked to them as a6g connect app links one, with their reports, and
// what Shop's planner decided in the operator's place (Blog is published as an older factory version would publish it:
// it keeps no such log and reads no agreement).
import { type MachineReport, type MachineSubscription, USAGE_FIELDS, type UsageBucket } from "../../../lib/fleet.ts";
import { recordDecision } from "../../../lib/tasks/decisions.ts";
import { newTask, nowIso, priorityOf, type Score, type Task, withEvent } from "../../../lib/tasks/model.ts";
import { addRequest, stakeholderFor } from "../../../lib/tasks/requests.ts";
import { update } from "../../../lib/tasks/store.ts";
import type { TeamSettings } from "../../../lib/tasks/teams.ts";
import { auth } from "../../server/auth.ts";
import { createAdmin } from "../../server/bootstrap.ts";
import { storeFor } from "../../server/factory.ts";
import { rememberIp } from "../../server/known-ips.ts";
import { decideLink, machineByToken, recordReport, redeemLink, startLink } from "../../server/machines.ts";
import { setMembership } from "../../server/people.ts";
import { DEFAULT_IP } from "../../playwright.config.ts";

export interface World {
  admin: { email: string; password: string; totpURI: string; backupCodes: string[] };
  member: string;
  busy: string;
  proposals: { approve: string; reject: string; untouched: string };
  asks: { question: string; blocked: string };
  // What the team decided for the operator: two flagged calls to review, one only on the record, one agreed with.
  decisions: { agree: string; overturn: string; plain: string; agreed: string };
  requests: { promoted: string; rejected: string };
  // The member's machine's token, as its Keychain would hold it.
  studioToken: string;
}

const score = (size: Score["size"], why: string): Score => ({
  pain: 2,
  reach: 2,
  revenue: 1,
  wow: 1,
  distribution: 1,
  leverage: 2,
  urgency: 1,
  risk: 1,
  confidence: "asks",
  size,
  why,
});
const gate = (asked: string) => ({ asked, simplify: "nothing to delete: it's new", simplest: "one button" });

// `operator`: who the team works for, which a factory version that reads the working agreement publishes.
function settings(
  name: string,
  title: string,
  mode: TeamSettings["mode"],
  operator?: TeamSettings["operator"],
  repo?: TeamSettings["repo"]
): TeamSettings {
  return {
    name,
    title,
    mode,
    approval: { mode: "operator", maxSize: "M", findings: "planner" },
    roles: ["planner", "builder", "reviewer"],
    branch: "main",
    factory: "0.4.0",
    ...(operator ? { operator } : {}),
    ...(repo ? { repo } : {}),
    publishedAt: nowIso(),
  };
}

export async function seed(): Promise<World> {
  const shop = storeFor("shop");
  await shop.publish(
    settings("shop", "Shop", "finish", { technical: true, designCheckIn: false }, { name: "acme/storefront", url: "https://github.com/acme/storefront" })
  );
  await shop.report({ state: "active", planner: "running", members: { builder: 1 }, at: nowIso() });
  const blog = storeFor("blog");
  await blog.publish(settings("blog", "Blog", "cycles"));
  await blog.report({ state: "idle", planner: null, members: {}, at: nowIso() });
  await blog.tasks.create(newTask({ team: "blog", title: "Write the launch post", kind: "chore", status: "approved", by: "planner" }));

  const add = (fields: Partial<Task> & Pick<Task, "title" | "kind" | "status">): Promise<Task> =>
    shop.tasks.create(newTask({ team: "shop", by: "planner", ...fields }));
  const journey = await add({ title: "Checkout", kind: "journey", status: "approved" });
  const merged = await add({ title: "Pay by card", kind: "feature", status: "done", parent: journey.id, score: score("M", "most orders") });
  await update(shop.tasks, merged.id, (t) =>
    withEvent({ ...t, sha: "a1b2c3d4e5" }, "merge-queue", "review → done: merged a6g/b2-pay-by-card", { from: "review", to: "done", sha: "a1b2c3d4e5" })
  );
  await add({
    title: "Save the card for next time",
    kind: "feature",
    status: "building",
    parent: journey.id,
    after: [merged.id],
    claim: { role: "builder", machine: "studio", worktree: "/w/b3", at: nowIso(), until: new Date(Date.now() + 3_600_000).toISOString() },
  });
  const toApprove = await add({
    title: "Export orders as CSV",
    kind: "feature",
    status: "proposed",
    gate: { ...gate("support, for refunds"), headline: "Let support send a customer their orders as a spreadsheet?" },
    score: score("S", "weekly refunds"),
  });
  const toReject = await add({
    title: "Dark mode for receipts",
    kind: "feature",
    status: "proposed",
    gate: gate("one customer"),
    score: score("M", "nice to have"),
  });
  const untouched = await add({ title: "Gift cards", kind: "feature", status: "proposed", gate: gate("sales"), score: score("L", "holiday season") });
  for (const t of [toApprove, toReject, untouched]) await update(shop.tasks, t.id, (x) => ({ ...x, priority: x.score ? priorityOf(x.score) : null }));
  await add({ title: "Totals round the wrong way", kind: "bug", status: "approved", severity: "major" });
  // What waits on the operator: a question the planner put to them, with its options, and work that's blocked.
  const question = await add({
    title: "Q: who sees a customer's past orders?",
    kind: "research",
    status: "proposed",
    body:
      "Customers can't see their past orders. Options: (a) keep them staff-only for now; (b) open them to signed-in customers; " +
      "(c) open them with the totals hidden. Recommendation: (b), behind the same sign-in as checkout. Until you answer, nothing changes.",
  });
  await update(shop.tasks, question.id, (t) =>
    withEvent({ ...t, status: "question" }, "planner", "proposed → question: who sees an order is the operator's", { from: "proposed", to: "question" })
  );
  const blocked = await add({ title: "Ship to Canada", kind: "feature", status: "approved", score: score("M", "a quarter of visitors") });
  // Raised to the operator: only they can lift it, so it carries the decision in a line, why, and what the team
  // recommends.
  await update(shop.tasks, blocked.id, (t) =>
    withEvent(
      {
        ...t,
        status: "blocked",
        ask: {
          reason: "needs the carrier's API key",
          recommendation: "add the key to the vault, then approve it again",
          headline: "Add the carrier's key so customers in Canada can order?",
          by: "planner",
          at: nowIso(),
        },
      },
      "planner",
      "approved → blocked: needs the carrier's API key",
      { from: "approved", to: "blocked" }
    )
  );

  // What the planner decided in the operator's place, as a6g decision record writes it under the default agreement:
  // two calls it flagged, one that only goes on the record, and one flagged that the operator agreed with already.
  const decide = (input: Parameters<typeof recordDecision>[2], call: Parameters<typeof recordDecision>[3]) =>
    recordDecision(shop, "shop", input, call, "planner");
  const guests = await decide(
    {
      question: "Do guests check out without an account?",
      decision: "Yes: guests check out, and are offered an account after they pay",
      because: "the direction puts a first order ahead of a sign-up",
      options: ["Require an account first", "Guest checkout, an account offered after"],
      undo: "revert the guest checkout's merge; nothing is kept for a guest",
      tasks: [merged.id],
    },
    { topic: "product", stakes: "high", confidence: "medium" }
  );
  const currencies = await decide(
    {
      question: "Which currencies at launch?",
      decision: "Canadian and US dollars only",
      because: "the brief names two markets to start with",
      options: ["Dollars only", "Dollars and euros"],
      undo: "add a currency to the price list; no order is priced yet",
    },
    // A product call: under the default agreement a change of scope would have been asked, not decided.
    { topic: "product", stakes: "medium", confidence: "low" }
  );
  const cart = await decide(
    {
      question: "What does the empty cart say?",
      decision: "“Your cart is empty”, and a link back to the shop",
      because: "the style guide asks for plain words",
    },
    { topic: "design", stakes: "low", confidence: "high" }
  );
  const photos = await decide(
    {
      question: "Keep order photos at full size?",
      decision: "No: each is resized to 1600 px as it's uploaded",
      because: "the direction caps what the shop costs to run",
      undo: "the originals aren't kept, so only new uploads change",
    },
    { topic: "cost", stakes: "high", confidence: "high" }
  );
  // Agreed with from the terminal, and written onto the record already (the control itself is long applied).
  await update(shop.decisions, photos.id, (d) =>
    withEvent({ ...d, review: { verdict: "agreed", note: "Good call.", by: "operator", at: nowIso(), control: "k0" } }, "operator", "agreed")
  );

  // Requests from a stakeholder the app has no account for (as a6g request add makes them).
  const grace = await stakeholderFor(shop, "shop", { name: "Grace Hopper", email: "grace@example.com", role: "customer" });
  const promoted = await addRequest(shop, "shop", {
    title: "Refund exports",
    body: "We redo refunds by hand every Friday.",
    from: grace.id,
    by: "operator",
  });
  await update(shop.requests, promoted.id, (r) =>
    withEvent({ ...r, status: "promoted", tasks: [toApprove.id] }, "planner", `new → promoted: task ${toApprove.id}`, { from: "new", to: "promoted" })
  );
  const rejected = await addRequest(shop, "shop", { title: "A fax integration", body: "", from: grace.id, by: "operator" });
  await update(shop.requests, rejected.id, (r) =>
    withEvent(
      { ...r, status: "rejected", notes: [...r.notes, { at: nowIso(), by: "planner", text: "rejected: nobody else has asked, and fax is going away" }] },
      "planner",
      "new → rejected: nobody else has asked, and fax is going away",
      { from: "new", to: "rejected" }
    )
  );

  const admin = await createAdmin({ email: "operator@example.com", name: "Olive Operator" });
  const people = [
    { email: "member@example.com", name: "Morgan Member", role: "member" as const, label: "sales" },
    { email: "busy@example.com", name: "Bea Busy", role: "contributor" as const, label: "customer" },
  ];
  const ids: Record<string, string> = {};
  for (const p of people) {
    const { user } = await auth().api.createUser({ body: { email: p.email, name: p.name, role: "user" } });
    await setMembership({ userId: user.id, name: user.name, email: user.email }, "shop", p.role, p.label);
    await rememberIp(user.id, DEFAULT_IP, "confirmed by email");
    ids[p.email] = user.id;
  }
  // Everyone the story starts with has confirmed the address the tests' browsers come from; a new one asks by email.
  const operator = await (await auth().$context).internalAdapter.findUserByEmail(admin.email);
  if (operator) await rememberIp(operator.user.id, DEFAULT_IP, "confirmed by email");

  // The member's machine, Shop's lead and the only home of a team whose tasks are in files; the operator's, a worker
  // of Shop's last heard from two hours ago; and one of a member of Blog's, whose report says it leads Shop as well (a
  // machine says where a team runs only when its person is one of the team's members or an admin).
  const link = async (userId: string | undefined, report: MachineReport, at = new Date()): Promise<string> => {
    // From an address of the seed's own, so the tests' own codes and looks start from none.
    const from = { ip: "192.0.2.10", userAgent: "a6g/0.4.0" };
    const started = await startLink({ ...from, name: report.name, replacing: null }, at);
    if (!userId || !started || typeof (await decideLink({ userId, ip: from.ip }, started.userCode, true, null, at)) !== "object")
      throw new Error(`couldn't link ${report.name}`);
    const linked = await redeemLink(started.deviceCode, from, at);
    if ("error" in linked) throw new Error(`couldn't link ${report.name}: ${linked.error}`);
    const bearing = await machineByToken(linked.token, from.ip, at);
    if (!bearing || !(await recordReport(bearing, report, from.ip, at))) throw new Error(`couldn't report ${report.name}`);
    return linked.token;
  };
  const team = { factory: "0.4.0", state: "active" as const, planner: null, members: {} };
  const shopLead = { ...team, name: "shop", title: "Shop", part: "lead" as const, store: "mongo" as const, planner: "running", members: { builder: 1 } };
  const studioToken = await link(ids["member@example.com"], {
    name: "studio",
    factory: "0.4.0",
    teams: [
      { ...shopLead, home: "/Users/morgan/code/shop-a6g" },
      { ...team, name: "notes", title: "Notes", part: "lead", store: "files", home: "/Users/morgan/code/notes-a6g", state: "paused" },
    ],
  });
  await link(
    operator?.user.id,
    {
      name: "attic",
      factory: "0.8.5",
      teams: [{ ...team, name: "shop", title: "Shop", part: "worker", store: "mongo", home: "/Users/olive/shop" }],
      // A version that starts projects, not told to yet.
      projects: null,
      subscriptions: subscriptionsSeen(new Date()),
    },
    new Date(Date.now() - 2 * 3_600_000)
  );
  // Someone on another team only, whose machine says it leads Shop.
  const { user: outsider } = await auth().api.createUser({ body: { email: "blake@example.com", name: "Blake Blog", role: "user" } });
  await setMembership({ userId: outsider.id, name: outsider.name, email: outsider.email }, "blog", "member", "writer");
  await link(outsider.id, { name: "kiosk", factory: "0.4.0", teams: [{ ...shopLead, home: "/Users/blake/shop" }] });
  return {
    admin,
    member: "member@example.com",
    busy: "busy@example.com",
    proposals: { approve: toApprove.id, reject: toReject.id, untouched: untouched.id },
    asks: { question: question.id, blocked: blocked.id },
    decisions: { agree: guests.id, overturn: currencies.id, plain: cart.id, agreed: photos.id },
    requests: { promoted: promoted.id, rejected: rejected.id },
    studioToken,
  };
}

// The operator's two Claude subscriptions as the attic reports them (lib/subscriptions.ts subscriptionsReport): a month
// of days and a day of hours on two models, one of them with no price, the week of one used up; the first goes by two
// names in a6g, default and work (two folders signed in to the one account).
function subscriptionsSeen(now: Date): MachineSubscription[] {
  const bucket = (at: string, model: string, scale: number, priced = true): UsageBucket => {
    const f: Record<(typeof USAGE_FIELDS)[number], number> = {
      requests: Math.round(40 * scale),
      input: Math.round(9_000 * scale),
      output: Math.round(160_000 * scale),
      cacheRead: Math.round(4_800_000 * scale),
      cacheWrite: Math.round(210_000 * scale),
      cost: 0,
      costInput: priced ? 0.04 * scale : 0,
      costOutput: priced ? 3.2 * scale : 0,
      costCacheRead: priced ? 0.96 * scale : 0,
      costCacheWrite: priced ? 1.05 * scale : 0,
      fast: priced && model.includes("opus") ? 0.4 * scale : 0,
      saved: priced ? 18 * scale : 0,
      unpriced: priced ? 0 : Math.round(40 * scale),
    };
    f.cost = Math.round((f.costInput + f.costOutput + f.costCacheRead + f.costCacheWrite) * 1e4) / 1e4;
    for (const k of ["costInput", "costOutput", "costCacheRead", "costCacheWrite", "fast", "saved"] as const) f[k] = Math.round(f[k] * 1e4) / 1e4;
    return [at, model, ...USAGE_FIELDS.map((k) => f[k])];
  };
  const day = (ago: number) => new Date(now.getTime() - ago * 86_400_000).toISOString().slice(0, 10);
  const hour = (ago: number) => new Date(now.getTime() - ago * 3_600_000).toISOString().slice(0, 13);
  const wave = (i: number, phase: number) => Math.max(0.05, 0.6 + 0.5 * Math.sin(i / 2.3 + phase) + (i % 7 === 5 ? -0.4 : 0));
  const usage = (phase: number, weight: number) => ({
    days: Array.from({ length: 30 }, (_, i) => [
      bucket(day(i), "claude-opus-5-5", weight * wave(i, phase) * 2),
      bucket(day(i), "claude-fable-5-1", weight * wave(i, phase + 1)),
      ...(i < 6 ? [bucket(day(i), "claude-fable-5-2", weight * 0.5, false)] : []),
    ]).flat(),
    hours: Array.from({ length: 25 }, (_, i) => [bucket(hour(i), "claude-opus-5-5", weight * wave(i, phase) * 0.12)]).flat(),
  });
  const read = new Date(now.getTime() - 20 * 60_000).toISOString();
  const readBefore = new Date(now.getTime() - 35 * 60_000).toISOString();
  const later = (ms: number) => new Date(now.getTime() + ms).toISOString();
  return [
    {
      name: "default",
      login: "0f1e2d3c4b5a6978",
      email: "operator@example.com",
      plan: "Max",
      at: read,
      weekly: { percent: 64, resetsAt: later(2.4 * 86_400_000) },
      session: { percent: 35, resetsAt: later(2.2 * 3_600_000) },
      models: [{ model: "Fable", percent: 41, resetsAt: later(2.4 * 86_400_000) }],
      extra: { enabled: true, limit: 50, used: 12.5, currency: "USD" },
      week: 1480,
      limits: { weekly: 85, session: null },
      closed: null,
      teams: [{ team: "shop", roles: ["builder", "reviewer"] }],
      today: day(0),
      ...usage(0, 1),
      sessions: [12, 61, 240, 410],
      counted: read,
    },
    {
      name: "refdocs",
      login: "8796a5b4c3d2e1f0",
      email: "refdocs@example.com",
      plan: "Max",
      at: read,
      weekly: { percent: 100, resetsAt: later(0.6 * 86_400_000) },
      session: { percent: 0, resetsAt: later(4 * 3_600_000) },
      models: [{ model: "Fable", percent: 88, resetsAt: later(0.6 * 86_400_000) }],
      extra: { enabled: false, limit: null, used: null, currency: null },
      week: 1720,
      limits: { weekly: null, session: null },
      closed: { why: "refdocs has used its week", until: later(0.6 * 86_400_000), exhausted: true },
      teams: [{ team: "shop", roles: ["planner"] }],
      today: day(0),
      ...usage(1.7, 0.7),
      sessions: [5, 33, 130, 220],
      counted: read,
    },
    {
      name: "work",
      login: "0f1e2d3c4b5a6978",
      email: "operator@example.com",
      plan: "Max",
      at: readBefore,
      weekly: { percent: 63, resetsAt: later(2.4 * 86_400_000) },
      session: { percent: 34, resetsAt: later(2.2 * 3_600_000) },
      models: [{ model: "Fable", percent: 41, resetsAt: later(2.4 * 86_400_000) }],
      extra: { enabled: true, limit: 50, used: 12.5, currency: "USD" },
      week: 1480,
      limits: { weekly: null, session: null },
      closed: null,
      teams: [{ team: "blog", roles: ["builder"] }],
      today: day(0),
      ...usage(3.1, 0.3),
      sessions: [2, 9, 30, 50],
      counted: readBefore,
    },
  ];
}
