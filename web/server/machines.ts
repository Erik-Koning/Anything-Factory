// Machines linked to people's accounts (lib/fleet.ts): the codes waiting for someone to approve them (machine_links)
// and the linked machines with their latest reports (machines), in the accounts database, beside the people they
// belong to. The task graphs, which agents read, never hold a link, a token or whose a machine is (Article 8).
//
// Each code is the device authorization grant's (RFC 8628): the CLI holds the device code, 32 random bytes kept here
// only as their hash, and polls with it; the person looks the user code up and approves it on the page. Every look-up
// and every decision counts, right or wrong, and nothing clears the count before it expires: LOOKS_PER_PERSON and
// LOOKS_PER_IP in 15 minutes (code-attempts.ts), so nobody finds someone else's waiting code by guessing. An address
// may ask for CODES_PER_IP codes in 15 minutes. A code works once, for LINK_MINUTES.
//
// Against a code someone else asked for being approved by a person who didn't (RFC 8628 section 5.4): the page shows
// the address and device that asked, and a code asked for from another address than the person's must be typed, not
// only clicked; a new link replaces an old one only when the CLI shows the old one's token; and the person is emailed
// whenever a machine is linked to their account.
//
// A machine's token is kept only as its hash too, and does nothing but report its machine and unlink it. Every
// ROTATE_DAYS a report is answered with a new one; the old one keeps working ROTATE_GRACE_HOURS for a CLI that missed
// the answer, and is a stolen one if it's used after the new one has been: the link ends (RFC 9700 section 4.14). So
// does a new one used after the old one came back unused and was given another in its place (orphanHashes). A
// token stops working when its machine is unlinked (from the Machines page, or by itself), when its person is banned
// or no longer may link machines (mayLinkMachines), or after IDLE_DAYS without a report. Each person has at most
// MAX_MACHINES.
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  IDLE_DAYS,
  LINK_MINUTES,
  type LinkError,
  MACHINE_TOKEN,
  MAX_MACHINES,
  type MachineProjects,
  type MachineReport,
  type MachineTeam,
  POLL_SECONDS,
  ROTATE_DAYS,
  ROTATE_GRACE_HOURS,
  USER_CODE_LENGTH,
  USER_CODE_LETTERS,
} from "../../lib/fleet.ts";
import { mayLinkMachines, type TeamRole } from "./access.ts";
import { audit } from "./audit.ts";
import { takeCodeAttempt } from "./code-attempts.ts";
import { config } from "./config.ts";
import { authDb } from "./db.ts";
import { deviceOf } from "./device.ts";
import { sendMail } from "./mail.ts";
import { membershipsOf } from "./people.ts";

export const LOOKS_PER_PERSON = 10;
export const LOOKS_PER_IP = 30;
export const CODES_PER_IP = 5;
// The soonest a machine may report again: the watchdog reports every five minutes.
export const REPORT_GAP_SECONDS = 20;

interface LinkDoc {
  // The device code's hash.
  _id: string;
  userCode: string;
  // The machine's name, as the CLI asked for it.
  name: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  // Seconds the CLI must leave between polls; five more after each slow_down.
  interval: number;
  polledAt: Date | null;
  status: "pending" | "approved" | "refused";
  // Who approved or refused it.
  userId: string | null;
  // The machine it replaces, when the CLI showed that one's token, and whose that is.
  replaces: { id: string; userId: string } | null;
}

interface MachineDoc {
  _id: string;
  userId: string;
  // As approved: a report doesn't rename it.
  name: string;
  linkedAt: Date;
  // Where the CLI asked for its code from.
  linkedFrom: string | null;
  // The token's hash, when it was issued, and whether a request has come with it yet.
  tokenHash: string;
  issuedAt: Date;
  seen: boolean;
  // The token before it, while it still works for a CLI that missed the new one.
  previousHash: string | null;
  previousUntil: Date | null;
  // Tokens issued and replaced before anything used them (the previous one came back meanwhile): one of these used
  // later means two holders, and ends the link. The last few; absent on machines linked before there were any.
  orphanHashes?: string[];
  // Its last report, or its link: the idle expiry counts from here.
  lastSeenAt: Date;
  lastIp: string | null;
  factory: string | null;
  teams: MachineTeam[];
  // What it offers to start, as its last report said (lib/fleet.ts): absent or null when it starts no projects.
  projects?: MachineProjects | null;
  // Whether that report said anything of projects at all: a factory version that can start them says so, on or off.
  projectsKnown?: boolean;
  // When it last reported; null until its first report.
  at: Date | null;
}

// A machine as the pages see it: never its token's hash.
export interface Machine {
  id: string;
  userId: string;
  name: string;
  linkedAt: string;
  lastIp: string | null;
  factory: string | null;
  teams: MachineTeam[];
  // The folder it starts projects in, its repositories and its subscriptions, or null when it starts none; and
  // whether its factory version could (its operator says so at its terminal, a6g connect app --projects).
  projects: MachineProjects | null;
  canStart: boolean;
  at: string | null;
}

// A code waiting for its person, as the page shows it.
export interface WaitingLink {
  userCode: string;
  name: string;
  ip: string | null;
  device: string;
  createdAt: string;
  // It replaces one of this person's machines (named), rather than adding one.
  replaces: string | null;
}

const links = () => authDb().collection<LinkDoc>("machine_links");
const machines = () => authDb().collection<MachineDoc>("machines");

let indexed: Promise<unknown> | null = null;
export function ensureIndexes(): Promise<unknown> {
  indexed ??= Promise.all([
    links().createIndex({ userCode: 1 }, { unique: true }),
    links().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    machines().createIndex({ tokenHash: 1 }, { unique: true }),
    machines().createIndex({ previousHash: 1 }, { sparse: true }),
    machines().createIndex({ orphanHashes: 1 }, { sparse: true }),
    machines().createIndex({ userId: 1 }),
    machines().createIndex({ "teams.name": 1 }),
    machines().createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: IDLE_DAYS * 86_400 }),
  ]).catch((error: unknown) => {
    // The app's database user may lack createIndex: the code below checks every expiry itself.
    console.warn("machines: indexes not made:", (error as Error).message);
  });
  return indexed;
}

const hash = (secret: string): string => createHash("sha256").update(secret).digest("hex");
const duplicate = (error: unknown): boolean => (error as { code?: number })?.code === 11000;
const newToken = (): string => `a6gm_${randomBytes(32).toString("base64url")}`;
const VIEW = { projection: { tokenHash: 0, previousHash: 0, orphanHashes: 0 } } as const;
// Replaced tokens kept for spotting a second holder: at most this many, and none ever dropped. The old token coming
// back once more ends the link instead (a CLI misses an answer now and then; a copy can come back every 20 seconds).
const ORPHANS_KEPT = 10;
const view = (doc: Omit<MachineDoc, "tokenHash" | "previousHash"> & Partial<MachineDoc>): Machine => ({
  id: doc._id,
  userId: doc.userId,
  name: doc.name,
  linkedAt: doc.linkedAt.toISOString(),
  lastIp: doc.lastIp,
  factory: doc.factory,
  teams: doc.teams,
  projects: doc.projects ?? null,
  canStart: doc.projectsKnown === true || Boolean(doc.projects),
  at: doc.at ? doc.at.toISOString() : null,
});
const idleSince = (now: Date): Date => new Date(now.getTime() - IDLE_DAYS * 86_400_000);
const waiting = (doc: LinkDoc, replaces: string | null): WaitingLink => ({
  userCode: doc.userCode,
  name: doc.name,
  ip: doc.ip,
  device: deviceOf(doc.userAgent),
  createdAt: doc.createdAt.toISOString(),
  replaces,
});
// "m•••@example.com": enough for the person at the terminal to see which account, not enough to give it away.
export const maskEmail = (email: string): string => email.replace(/^(.)[^@]*@/, "$1•••@");

// Whose a machine is: their address, whether they're an admin or banned, and their roles per team.
interface Owner {
  email: string;
  admin: boolean;
  banned: boolean;
  teams: Record<string, TeamRole>;
}
async function ownersById(userIds: readonly string[]): Promise<Map<string, Owner>> {
  // Lazily, as auth.ts reaches the modules this one is used beside.
  const { auth, isAdminRole } = await import("./auth.ts");
  const context = await auth().$context;
  const ids = [...new Set(userIds)];
  const roles = await membershipsOf(ids);
  const owners = new Map<string, Owner>();
  for (const userId of ids) {
    const user = (await context.internalAdapter.findUserById(userId)) as { email: string; role?: string | null; banned?: boolean | null } | null;
    if (!user) continue;
    const teams: Record<string, TeamRole> = {};
    for (const m of roles) if (m.userId === userId) teams[m.team] = m.role;
    owners.set(userId, { email: user.email, admin: isAdminRole(user.role), banned: user.banned === true, teams });
  }
  return owners;
}
// The person, while they may have machines: not banned, and an admin or a team's member.
async function standing(userId: string): Promise<Owner | null> {
  const owner = (await ownersById([userId])).get(userId);
  return owner && !owner.banned && mayLinkMachines(owner) ? owner : null;
}
// Unlinks every machine of `userId`'s when they may no longer have any (a ban, a role changed, removed from a team):
// how many.
export const unlinkIfNotAllowed = async (userId: string): Promise<number> => ((await standing(userId)) ? 0 : unlinkAllOf(userId));

// --- Codes --------------------------------------------------------------------------------------------------------

// A new code for the machine `name`, asked for from `ip`; null when that address has asked for CODES_PER_IP in 15
// minutes. `replacing` is the token of the link the CLI had, when it had one: the new link replaces that machine.
export async function startLink(
  { name, ip, userAgent, replacing }: { name: string; ip: string | null; userAgent: string | null; replacing: string | null },
  now = new Date()
): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number } | null> {
  await ensureIndexes();
  if (!(await takeCodeAttempt(`machine-codes:${ip ?? "unknown"}`, now, CODES_PER_IP))) return null;
  const old = replacing ? await machineByToken(replacing, ip, now) : null;
  const replaces = old ? { id: old.machine.id, userId: old.machine.userId } : null;
  for (let tries = 0; tries < 5; tries++) {
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = Array.from({ length: USER_CODE_LENGTH }, () => USER_CODE_LETTERS[randomInt(USER_CODE_LETTERS.length)]).join("");
    try {
      await links().insertOne({
        _id: hash(deviceCode),
        userCode,
        name,
        ip,
        userAgent: userAgent?.slice(0, 300) ?? null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + LINK_MINUTES * 60_000),
        interval: POLL_SECONDS,
        polledAt: null,
        status: "pending",
        userId: null,
        replaces,
      });
      return { deviceCode, userCode, expiresIn: LINK_MINUTES * 60, interval: POLL_SECONDS };
    } catch (error) {
      // That user code is taken (waiting, or not yet expired away): another.
      if (!duplicate(error)) throw error;
    }
  }
  throw new Error("no free code to give");
}

// Takes one look for `userId` from `ip`: false when either has none left.
const takeLook = async (userId: string, ip: string | null, now: Date): Promise<boolean> =>
  (await takeCodeAttempt(`machine-looks:${userId}`, now, LOOKS_PER_PERSON)) &&
  (await takeCodeAttempt(`machine-looks-ip:${ip ?? "unknown"}`, now, LOOKS_PER_IP));

const replacedName = async (doc: LinkDoc, userId: string): Promise<string | null> =>
  doc.replaces?.userId === userId ? ((await machines().findOne({ _id: doc.replaces.id }, VIEW))?.name ?? null) : null;

// The code `userCode` while it waits, as `userId` (from `ip`) looks it up: "tries" when they've none left.
export async function lookUpLink(userId: string, ip: string | null, userCode: string, now = new Date()): Promise<WaitingLink | null | "tries"> {
  if (!(await takeLook(userId, ip, now))) return "tries";
  const doc = await links().findOne({ userCode, status: "pending", expiresAt: { $gt: now } });
  return doc ? waiting(doc, await replacedName(doc, userId)) : null;
}

export type Decision = WaitingLink | null | "tries" | "type the code" | "too many";

// Approves or refuses the waiting code for `userId`, once. A code asked for from another address than `ip` is
// approved only with `typed`, the code as the person typed it. Counts as a look.
export async function decideLink(
  { userId, ip }: { userId: string; ip: string | null },
  userCode: string,
  approve: boolean,
  typed: string | null,
  now = new Date()
): Promise<Decision> {
  if (!(await takeLook(userId, ip, now))) return "tries";
  const open = { userCode, status: "pending" as const, expiresAt: { $gt: now } };
  const doc = await links().findOne(open);
  if (!doc) return null;
  const replaces = await replacedName(doc, userId);
  if (approve) {
    // An unknown address is never the same one.
    if ((doc.ip === null || doc.ip !== ip) && typed !== userCode) return "type the code";
    if (!replaces && (await machines().countDocuments({ userId, lastSeenAt: { $gt: idleSince(now) } })) >= MAX_MACHINES) return "too many";
  }
  const decided = await links().findOneAndUpdate({ ...open, _id: doc._id }, { $set: { status: approve ? "approved" : "refused", userId } });
  return decided ? waiting(decided, replaces) : null;
}

// What a poll gets for its code (RFC 8628 section 3.5), "approved" when the token is due. Pure.
export function pollAnswer(link: Pick<LinkDoc, "status" | "expiresAt" | "polledAt" | "interval"> | null, now: Date): LinkError | "approved" {
  if (!link) return "invalid_grant";
  if (link.expiresAt <= now) return "expired_token";
  if (link.status === "refused") return "access_denied";
  // Half a second's grace, for the clocks on the way.
  if (link.polledAt && now.getTime() - link.polledAt.getTime() < link.interval * 1000 - 500) return "slow_down";
  return link.status === "pending" ? "authorization_pending" : "approved";
}

// The CLI's poll, from `ip` with `userAgent`: an error to answer with, or the machine's new token (shown to the CLI
// once, kept here only as its hash) with the account it's linked to, masked. The person is emailed, and it's audited.
export async function redeemLink(
  deviceCode: string,
  { ip, userAgent }: { ip: string | null; userAgent: string | null },
  now = new Date()
): Promise<{ error: LinkError } | { token: string; machine: Machine; account: string }> {
  const id = hash(deviceCode);
  const link = await links().findOne({ _id: id });
  const answer = pollAnswer(link, now);
  if (answer !== "approved") {
    if (link && answer === "slow_down") await links().updateOne({ _id: id }, { $set: { polledAt: now }, $inc: { interval: POLL_SECONDS } });
    else if (link && answer === "access_denied") await links().deleteOne({ _id: id });
    else if (link) await links().updateOne({ _id: id }, { $set: { polledAt: now } });
    return { error: answer };
  }
  // Once: the first poll to take it.
  const taken = await links().findOneAndDelete({ _id: id, status: "approved" });
  if (!taken?.userId) return { error: "expired_token" };
  const owner = await standing(taken.userId);
  if (!owner) return { error: "access_denied" };
  const replaced =
    taken.replaces?.userId === taken.userId ? (await machines().deleteOne({ _id: taken.replaces.id, userId: taken.userId })).deletedCount : 0;
  if (!replaced && (await machines().countDocuments({ userId: taken.userId, lastSeenAt: { $gt: idleSince(now) } })) >= MAX_MACHINES)
    return { error: "access_denied" };
  const token = newToken();
  const doc: MachineDoc = {
    _id: `m${randomBytes(12).toString("hex")}`,
    userId: taken.userId,
    name: taken.name,
    linkedAt: now,
    linkedFrom: taken.ip,
    tokenHash: hash(token),
    issuedAt: now,
    seen: false,
    previousHash: null,
    previousUntil: null,
    lastSeenAt: now,
    lastIp: ip,
    factory: null,
    teams: [],
    at: null,
  };
  await machines().insertOne(doc);
  await audit({
    action: "machine.token",
    outcome: "ok",
    userId: taken.userId,
    email: owner.email,
    ip,
    userAgent,
    target: taken.name,
    detail: `code asked for from ${taken.ip ?? "an unknown address"}${replaced ? `; replaces the machine linked before` : ""}`,
  });
  await sendMail({
    to: owner.email,
    subject: `A machine, ${taken.name}, was linked to your Anything Factory account`,
    text: `The machine ${taken.name} was linked to your Anything Factory account at ${now.toUTCString()}: its code was asked for from ${taken.ip ?? "an unknown address"}, and its token went to ${ip ?? "an unknown address"}. It can report the teams it runs to your account, nothing else.\n\nIf you didn't run a6g connect app on it yourself just now, unlink it at once: ${config().baseURL}/machines\n\nThen tell your admin.`,
    link: `${config().baseURL}/machines`,
  }).catch((error: unknown) => console.error("machines: the new-link email didn't go:", (error as Error).message));
  return { token, machine: view(doc), account: maskEmail(owner.email) };
}

// --- Linked machines ----------------------------------------------------------------------------------------------

// What a request's token says: its machine, whether it's the newest token ("current") or the one before it in its
// grace while the newest hasn't been used ("previous"), and whether it's due for replacing. For the endpoints only:
// the hash never reaches a page.
export interface Bearing {
  machine: Machine;
  which: "current" | "previous";
  due: boolean;
  currentHash: string;
}

// The machine a token is for, while it's linked and its person may have it. An old token used after its successor,
// or a successor used after the old one came back and was given another, ends the link: it was stolen, or copied.
// Null otherwise. `ip` is the request's, for the audit log.
export async function machineByToken(token: string, ip: string | null, now = new Date()): Promise<Bearing | null> {
  if (!MACHINE_TOKEN.test(token)) return null;
  const tokenHash = hash(token);
  const doc = await machines().findOne({ $or: [{ tokenHash }, { previousHash: tokenHash }, { orphanHashes: tokenHash }] });
  if (!doc) return null;
  if (doc.tokenHash !== tokenHash && doc.previousHash !== tokenHash) {
    await endLink(doc, ip, "a token replaced before it was used came back: two machines held this link, so it ended");
    return null;
  }
  const quiet = doc.lastSeenAt <= idleSince(now);
  const owner = quiet ? null : await standing(doc.userId);
  if (!owner) {
    // Quiet too long, or its person may no longer have it: the link ends here, whether or not anything else ended it.
    await endLink(doc, ip, quiet ? `no report in ${IDLE_DAYS} days, so the link ended` : "its person may no longer link machines, so the link ended");
    return null;
  }
  const due = doc.issuedAt.getTime() <= now.getTime() - ROTATE_DAYS * 86_400_000;
  if (doc.tokenHash === tokenHash) {
    if (!doc.seen) await machines().updateOne({ _id: doc._id, tokenHash }, { $set: { seen: true } });
    return { machine: view(doc), which: "current", due, currentHash: doc.tokenHash };
  }
  if (!doc.seen && doc.previousUntil && doc.previousUntil > now) {
    if ((doc.orphanHashes?.length ?? 0) < ORPHANS_KEPT) return { machine: view(doc), which: "previous", due: true, currentHash: doc.tokenHash };
    await endLink(doc, ip, `a replaced token came back once more after ${ORPHANS_KEPT} of its successors went unused, so the link ended`);
    return null;
  }
  if (doc.seen) await endLink(doc, ip, "a replaced token was used after its successor: it was copied, so the link ended");
  return null;
}

// Ends a link when a token's use shows it must (copied, quiet too long, its person no longer allowed), on the audit
// log; nothing when something else ended it first.
async function endLink(doc: MachineDoc, ip: string | null, detail: string): Promise<void> {
  if (!(await machines().deleteOne({ _id: doc._id })).deletedCount) return;
  const owner = await standing(doc.userId);
  await audit({
    action: "machine.unlinked",
    outcome: "ok",
    userId: doc.userId,
    email: owner?.email ?? null,
    ip,
    userAgent: null,
    target: doc.name,
    detail,
  });
}

// Keeps the machine's report (not its name: that stays as approved): false when it reported less than
// REPORT_GAP_SECONDS ago, or its token changed meanwhile. With the token it came with due for replacing, the new one,
// which only this answer carries; the one it came with keeps working ROTATE_GRACE_HOURS, until the new one is used.
export async function recordReport(
  bearing: Bearing,
  report: MachineReport,
  ip: string | null,
  now = new Date()
): Promise<false | { token: string | null }> {
  const token = bearing.due ? newToken() : null;
  // What it offers to start goes with each report: a machine whose operator took that back says nothing of it.
  const set: Partial<MachineDoc> = {
    factory: report.factory,
    teams: report.teams,
    projects: report.projects ?? null,
    projectsKnown: report.projects !== undefined,
    at: now,
    lastSeenAt: now,
    lastIp: ip,
  };
  if (token) Object.assign(set, { tokenHash: hash(token), issuedAt: now, seen: false });
  if (token && bearing.which === "current")
    Object.assign(set, { previousHash: bearing.currentHash, previousUntil: new Date(now.getTime() + ROTATE_GRACE_HOURS * 3_600_000) });
  const { matchedCount } = await machines().updateOne(
    {
      _id: bearing.machine.id,
      tokenHash: bearing.currentHash,
      $or: [{ at: null }, { at: { $lte: new Date(now.getTime() - REPORT_GAP_SECONDS * 1000) } }],
    },
    {
      $set: set,
      // The previous token came back while its successor was unused: that successor is replaced, and remembered.
      ...(token && bearing.which === "previous" ? { $push: { orphanHashes: bearing.currentHash } } : {}),
    }
  );
  return matchedCount === 1 ? { token } : false;
}

// Every linked machine (those quiet for IDLE_DAYS left out, whether or not MongoDB has removed them yet), by name; or
// only those that report one of `teams`.
export async function linkedMachines({ teams }: { teams?: readonly string[] } = {}, now = new Date()): Promise<Machine[]> {
  const docs = await machines()
    .find({ lastSeenAt: { $gt: idleSince(now) }, ...(teams ? { "teams.name": { $in: [...teams] } } : {}) }, VIEW)
    .sort({ name: 1 })
    .toArray();
  return docs.map(view);
}

// Unlinks the machine `id`: only `userId`'s, or anyone's with null (an admin). The machine as it was, or null.
export async function unlinkMachine(id: string, userId: string | null): Promise<Machine | null> {
  if (!/^m[0-9a-f]{24}$/.test(id)) return null;
  const doc = await machines().findOneAndDelete(userId === null ? { _id: id } : { _id: id, userId }, VIEW);
  return doc ? view(doc) : null;
}

// Unlinks every machine of a person's (a ban): how many there were.
export async function unlinkAllOf(userId: string): Promise<number> {
  await links().deleteMany({ userId });
  return (await machines().deleteMany({ userId })).deletedCount;
}

// Who owns each of `list`: their address, whether they're an admin or banned, and their roles per team.
export const ownersOf = (list: readonly Machine[]): Promise<Map<string, Owner>> => ownersById(list.map((m) => m.userId));
