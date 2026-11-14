// The factory's own task code, over the app's MongoClient: the same store, move table and decisions as the a6g CLI.
// The app keeps no rules of its own about tasks or requests; it only reads, and writes through these.
//
// Only these modules of ../lib/tasks are imported: mongo.ts (storeOver), store.ts (update), model.ts, requests.ts,
// decide.ts, answer.ts, add.ts, teams.ts, graph.ts, controls.ts, agreement.ts, decisions.ts, spend.ts and start.ts.
// Never files.ts, ops.ts, machines.ts, migrate.ts or mongoUri.ts, and never openStore (the Keychain, the run folder and
// child processes are the CLI's).
import { addTask, type TaskInput } from "../../lib/tasks/add.ts";
import { agreementChanges, agreementFrom, sameAgreement } from "../../lib/tasks/agreement.ts";
import { answer } from "../../lib/tasks/answer.ts";
import {
  agreementControl,
  agreementOf,
  budgetControl,
  type Control,
  type HoldScope,
  type Limits,
  limitsOf,
  pauseControl,
  restoreControl,
  resumeControl,
  retireControl,
  retiredOf,
  startControl,
  subscriptionsControl,
} from "../../lib/tasks/controls.ts";
import type { StartAsk } from "../../lib/tasks/start.ts";
import { type DecisionRecord, requestReview } from "../../lib/tasks/decisions.ts";
import type { UsageDay } from "../../lib/tasks/spend.ts";
import { type Decision, decide } from "../../lib/tasks/decide.ts";
import { type FeatureRequest, OPERATOR, Refused, type Stakeholder, type Task } from "../../lib/tasks/model.ts";
import { type MongoClientLike, storeOver } from "../../lib/tasks/mongo.ts";
import { addRequest, stakeholderFor } from "../../lib/tasks/requests.ts";
import { type Store, update } from "../../lib/tasks/store.ts";
import type { TeamDoc } from "../../lib/tasks/teams.ts";
import { config } from "./config.ts";
import { graphDb, mongo } from "./db.ts";
import { offSite, quietSince } from "./views.ts";

export { Refused };
export type { Cycle, FeatureRequest, Stakeholder, Task } from "../../lib/tasks/model.ts";
export type { TeamDoc, TeamSubscriptions } from "../../lib/tasks/teams.ts";
export type { Control, HoldScope, HoldState, Limits, StartState } from "../../lib/tasks/controls.ts";
export type { StartAsk } from "../../lib/tasks/start.ts";
export { agreementOf, describeHold, isHoldScope, journeysUnderWay, limitsOf, retiredOf } from "../../lib/tasks/controls.ts";
export type { Agreement } from "../../lib/tasks/agreement.ts";
export type { DecisionRecord } from "../../lib/tasks/decisions.ts";
export { limitDollars, percentOf, spendByWork, type Spend, type UsageDay } from "../../lib/tasks/spend.ts";

const stores = new Map<string, Store>();

// A team's store, one per team for the life of the process (never closed: closing would close the shared client).
export function storeFor(team: string): Store {
  let store = stores.get(team);
  if (!store) {
    store = storeOver(mongo() as unknown as MongoClientLike, { name: team, tasks: { store: "mongo", database: config().a6gDatabase, lead: null } });
    stores.set(team, store);
  }
  return store;
}

// Every team that has published its settings (a6g register writes them; the lead's watchdog its status), but those
// taken off the site (retirements), unless `retired`: those are only for what keeps a team's name taken.
export async function allTeams({ retired = false }: { retired?: boolean } = {}): Promise<TeamDoc[]> {
  const [rows, off] = await Promise.all([
    graphDb().collection<{ _id: string }>("teams").find({}).sort({ _id: 1 }).toArray(),
    retired ? Promise.resolve(new Map<string, Control>()) : retirements(),
  ]);
  return rows
    .map(({ _id, ...doc }) => ({ status: null, name: _id, title: _id, ...doc }) as unknown as TeamDoc)
    .filter((team) => !offSite(team, off.get(team.name) ?? null));
}

const numbered = (id: string): number => Number(/^k(\d+)$/.exec(id)?.[1] ?? 0);

// The teams taken off the site, each with the control that took it off: the newest of a team's retires and restores is
// a retire (lib/tasks/controls.ts). An admin (from the overview) or the team's lead (a6g unregister) takes one off; an
// admin or a6g register puts it back. A report from its lead since puts it back too (views.ts offSite): the pages ask
// that of each team with its state.
export async function retirements(): Promise<Map<string, Control>> {
  const rows = await graphDb()
    .collection("controls")
    .find({ kind: { $in: ["retire", "restore"] } })
    .toArray();
  const byTeam = new Map<string, Control[]>();
  for (const { _id: _ignored, ...doc } of rows) {
    const control = doc as unknown as Control;
    byTeam.set(control.team, [...(byTeam.get(control.team) ?? []), control]);
  }
  const off = new Map<string, Control>();
  for (const [team, controls] of byTeam) {
    const retired = retiredOf(controls.sort((a, b) => numbered(a.id) - numbered(b.id)));
    if (retired) off.set(team, retired);
  }
  return off;
}

export const teamDoc = (team: string): Promise<TeamDoc | null> => storeFor(team).team();

// The person's stakeholder record on `team`: the one linked to their account, or the one with their email (made when
// new, by the factory's stakeholderFor), linked to it. Names and emails live here and in the accounts only.
export async function stakeholderOf(team: string, person: { userId: string; name: string; email: string }, role: string): Promise<Stakeholder> {
  const store = storeFor(team);
  const linked = (await store.stakeholders.all()).find((s) => s.userId === person.userId);
  if (linked) return linked;
  const found = await stakeholderFor(store, team, { name: person.name, email: person.email, role });
  if (found.userId === person.userId) return found;
  return update(store.stakeholders, found.id, (s) => ({ ...s, userId: person.userId }));
}

// The stakeholder linked to an account on `team`, without making one.
export async function linkedStakeholder(team: string, userId: string): Promise<Stakeholder | null> {
  return (await storeFor(team).stakeholders.all()).find((s) => s.userId === userId) ?? null;
}

// An account leaves a team: its stakeholder stays (the requests name it), no longer linked.
export async function unlinkStakeholder(team: string, userId: string): Promise<void> {
  const linked = await linkedStakeholder(team, userId);
  if (linked) await update(storeFor(team).stakeholders, linked.id, (s) => ({ ...s, userId: null }));
}

// A request from the web: from the person's stakeholder, by "operator" for an admin and "stakeholder" otherwise. The
// request carries ids and roles only.
export function sendRequest(
  team: string,
  { title, body, from, admin }: { title: string; body: string; from: string; admin: boolean }
): Promise<FeatureRequest> {
  return addRequest(storeFor(team), team, { title: title.trim(), body: body.trim(), from, by: admin ? OPERATOR : "stakeholder" });
}

// An admin's decision, as the operator, with the team's approval rules from its published settings.
export async function decideAsOperator(team: string, id: string, decision: Decision, text: string): Promise<Task> {
  const settings = await teamDoc(team);
  if (!settings?.approval) throw new Refused(`${team} hasn't published its approval rules (a6g register publishes them)`);
  return decide(storeFor(team), id, decision, { who: OPERATOR, approval: settings.approval, text: text.trim() });
}

// An admin's answer to what waits on them (a question, or blocked work), as the operator: a note marked as the answer,
// which the lead's watchdog passes to the planner within a minute.
// `recommended`: the answer is the team's recommendation as it stood, with no words of the operator's (`text` empty):
// the factory writes the recommendation's and marks the note so (the hints on the working agreement count those).
// `seen`: that recommendation as the page showed it, which the factory holds the answer to.
export const answerAsOperator = (team: string, id: string, text: string, recommended = false, seen?: string): Promise<Task> =>
  answer(storeFor(team), id, { who: OPERATOR, text, recommended, seen: recommended ? seen : undefined });

// A task from the web, through the factory's addTask: an admin's as the operator (a proposal, or approved as it's
// added), anyone else's by "stakeholder", which goes to triage for the planner. Either way it records who it came from,
// by their stakeholder id, never their name (Article 8).
export function addTaskFromWeb(team: string, input: Omit<TaskInput, "from">, { admin, from }: { admin: boolean; from: string }): Promise<Task> {
  const fields: TaskInput = { ...input, title: input.title.trim(), body: input.body?.trim() ?? "", from };
  return admin ? addTask(storeFor(team), team, fields, OPERATOR) : addTask(storeFor(team), team, { ...fields, approved: false }, "stakeholder");
}

// The operator's controls on `team`, oldest first: what was asked for, and when (the lead's watchdog applies each within
// a minute, and reports where the team stands in its status).
export const controlsOf = (team: string): Promise<Control[]> => storeFor(team).controls.all();

// A pause from the web, by an admin's stakeholder id: its scope fixed against the graph as it is now (controls.ts).
export async function pauseFromWeb(team: string, ask: { scope: HoldScope; journeys: string[]; note: string; from: string }): Promise<Control> {
  const store = storeFor(team);
  // On the web the journeys are ticked, those under way to start with: none ticked is a mistake, not "the default".
  if (ask.scope === "journeys" && !ask.journeys.length) throw new Refused("Tick the journeys to finish before the team pauses.");
  const journeys = ask.scope === "journeys" ? ask.journeys : undefined;
  return store.controls.create(pauseControl(await store.tasks.all(), team, { scope: ask.scope, journeys, by: `web:${ask.from}`, note: ask.note }));
}

// A resume from the web; the note goes to the planner as the operator's feedback.
export const resumeFromWeb = (team: string, { note, from }: { note: string; from: string }): Promise<Control> =>
  storeFor(team).controls.create(resumeControl(team, `web:${from}`, note));

// What the team used, day by day and machine by machine, from `from` (YYYY-MM-DD) on (lib/usage.ts publishes it).
export const usageOf = (team: string, from: string): Promise<UsageDay[]> => storeFor(team).usage.since(from);

// A budget from the web, by an admin's stakeholder id: each limit in dollars, or null for none (all null clears it). The
// total keeps counting from when the budget began, unless `restart`. The team's limits on one subscription (a6g budget
// --account, which the form doesn't show) stay while the unit does, and go with a cleared budget.
export async function budgetFromWeb(
  team: string,
  ask: {
    daily: number | null;
    weekly: number | null;
    total: number | null;
    unit: "usd" | "subscription";
    autoResume: boolean;
    restart: boolean;
    from: string;
  }
): Promise<Control> {
  const store = storeFor(team);
  const current = limitsOf(await store.controls.all());
  const { daily, weekly, total } = ask;
  const kept = current?.accounts && Object.keys(current.accounts).length && (current.unit ?? "usd") === ask.unit ? current.accounts : null;
  const limits: Limits | null =
    daily === null && weekly === null && total === null
      ? null
      : {
          daily,
          weekly,
          total,
          unit: ask.unit,
          autoResume: ask.autoResume,
          since: ask.restart || !current ? new Date().toISOString() : current.since,
          ...(kept ? { accounts: kept } : {}),
        };
  return store.controls.create(budgetControl(team, `web:${ask.from}`, limits));
}

// What the team decided in the operator's place, oldest first (lib/tasks/decisions.ts). The app only reads these: the
// planner records them with a6g decision record, and the lead's watchdog writes each review onto its record.
export const decisionsOf = (team: string): Promise<DecisionRecord[]> => storeFor(team).decisions.all();

// An admin's review of one of them, as the operator, by their stakeholder id: a control, like a pause, which the lead's
// watchdog writes onto the record, passing an overturn to the planner within a minute.
export const reviewFromWeb = (team: string, ask: { id: string; verdict: string; note: string; from: string }): Promise<Control> =>
  requestReview(storeFor(team), team, { id: ask.id, verdict: ask.verdict, note: ask.note, by: `web:${ask.from}` });

// A new working agreement from the web, whole, by an admin's stakeholder id: the one in force from the moment it's
// recorded (the commands that ask the operator or decide for them read the newest), told to the planner within a
// minute. Resolves to the control and what changed, in words; one that changes nothing is refused.
export async function agreementFromWeb(
  team: string,
  ask: { level: unknown; topics: unknown; notes: unknown; contact?: unknown; from: string }
): Promise<{ control: Control; changes: string[] }> {
  const store = storeFor(team);
  const made = agreementFrom(ask);
  if ("problem" in made) throw new Refused(made.problem);
  const { agreement: current } = agreementOf(await store.controls.all());
  if (sameAgreement(current, made)) throw new Refused("Nothing changed: the agreement says that already.");
  return { control: await store.controls.create(agreementControl(team, `web:${ask.from}`, made)), changes: agreementChanges(current, made) };
}

// The team's subscriptions from the web, by an admin's stakeholder id: every role's list, or one role's own, in order
// (an empty list clears it). Only what the team's lead last reported it has may be named, and only by a team whose
// lead reads the control (it reports its subscriptions when it does): the lead's watchdog writes the list and moves the
// roles within a minute. One that changes nothing is refused.
export async function subscriptionsFromWeb(team: string, ask: { role: string | null; use: string[]; from: string }): Promise<Control> {
  const doc = await teamDoc(team);
  const reported = doc?.status?.subscriptions;
  if (!doc || !reported) throw new Refused("This team's Mac doesn't take its subscriptions from here yet: it needs a newer factory version.");
  if (ask.role !== null && !doc.roles.includes(ask.role)) throw new Refused(`The team has no ${ask.role}.`);
  const known = reported.available.map((a) => a.name);
  const use = [...new Set(ask.use)];
  const unknown = use.filter((name) => !known.includes(name));
  if (unknown.length) throw new Refused(`The team's Mac has no subscription named ${unknown.join(", ")}.`);
  const current = reported.use[ask.role ?? "*"] ?? [];
  if (current.length === use.length && current.every((name, i) => name === use[i]))
    throw new Refused(use.length ? "Nothing changed: it runs on those already, in that order." : "Nothing changed: there's no list to clear.");
  return storeFor(team).controls.create(subscriptionsControl(team, `web:${ask.from}`, { role: ask.role, use }));
}

// An admin takes the team off the site, by their stakeholder id, with a note for the record: only once no Mac runs it
// (views.ts quietSince), since one that still did would carry on unseen. Its tasks, history and name stay.
export async function retireFromWeb(team: string, { note, from }: { note: string; from: string }, now = Date.now()): Promise<Control> {
  const doc = await teamDoc(team);
  if (!doc) throw new Refused("No such team.");
  const store = storeFor(team);
  if (offSite(doc, retiredOf(await store.controls.all()))) throw new Refused("It's off the site already.");
  if (!quietSince(doc, now)) {
    const at = doc.status?.at;
    throw new Refused(
      at
        ? `A Mac runs ${doc.title || team}: it reported ${Math.max(1, Math.round((now - Date.parse(at)) / 60_000))} min ago. Unregister it on that Mac (a6g unregister ${team}), which takes it off the site too.`
        : `${doc.title || team} was published less than 15 minutes ago, so a Mac may be starting it. Unregister it on that Mac (a6g unregister ${team}), or wait.`
    );
  }
  return store.controls.create(retireControl(team, `web:${from}`, note));
}

// An admin puts a team that's off the site back on it.
export async function restoreFromWeb(team: string, { from }: { from: string }): Promise<Control> {
  const doc = await teamDoc(team);
  if (!doc) throw new Refused("No such team.");
  const store = storeFor(team);
  if (!offSite(doc, retiredOf(await store.controls.all()))) throw new Refused("It's on the site already.");
  return store.controls.create(restoreControl(team, `web:${from}`));
}

// An ask to start the team `team` (lib/tasks/start.ts), by an admin's stakeholder id on it; null withdraws the one
// before it. A control under the new team's name, where the machine it names reads it.
export const startFromWeb = (team: string, ask: StartAsk | null, from: string): Promise<Control> =>
  storeFor(team).controls.create(startControl(team, `web:${from}`, ask));
