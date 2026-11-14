"use server";
// One's own notification settings, and a test email to see that they arrive.
import { redirect } from "next/navigation";
import { withNotice } from "../../../components/ui.tsx";
import { can, pendingStep, roleIn } from "../../../server/access.ts";
import { config } from "../../../server/config.ts";
import { AUDIENCE, EVENT_KINDS, type EventKind } from "../../../server/events.ts";
import { allTeams } from "../../../server/factory.ts";
import { sendMail } from "../../../server/mail.ts";
import {
  hourLabel,
  isMode,
  isTimeZone,
  kindsIn,
  type Mode,
  mutedAfter,
  prefsOr,
  savedPrefs,
  savePrefs,
  summaryOf,
  takeTestAllowance,
  testMail,
  widestRole,
} from "../../../server/notifications.ts";
import { getViewer, type Person, record, STEP_PAGE } from "../../../server/viewer.ts";

const BACK = "/account/notifications";
const TESTS_PER_HOUR = 3;

async function self(): Promise<Person> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step) redirect(STEP_PAGE[step]);
  return viewer;
}

// The teams the person follows, and the kinds of event they could hear of on any of them.
async function scopeOf(viewer: Person): Promise<{ teams: string[]; kinds: EventKind[] }> {
  const teams = (await allTeams()).filter((t) => roleIn(viewer, t.name) !== null).map((t) => t.name);
  return { teams, kinds: kindsIn((kind) => teams.some((team) => can(viewer, AUDIENCE[kind], team))) };
}

export async function saveNotificationsAction(form: FormData): Promise<void> {
  const viewer = await self();
  const { teams, kinds } = await scopeOf(viewer);
  const current = prefsOr(await savedPrefs(viewer.userId), viewer.userId, widestRole(viewer), config().notifyTimeZone);
  const modes = { ...current.modes };
  for (const kind of EVENT_KINDS) {
    if (!kinds.includes(kind)) continue;
    const chosen = form.get(`mode-${kind}`);
    if (!isMode(chosen)) redirect(withNotice(BACK, { error: "Choose how you hear of each kind of event." }));
    modes[kind] = chosen as Mode;
  }
  const hour = Number(form.get("hour"));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) redirect(withNotice(BACK, { error: "Choose the hour of your daily digest." }));
  const timeZone = form.get("timeZone");
  if (!isTimeZone(timeZone)) redirect(withNotice(BACK, { error: "Choose your time zone from the list." }));
  const heard = new Set(form.getAll("team").filter((value): value is string => typeof value === "string"));
  const next = {
    _id: viewer.userId,
    modes,
    reminder: teams.some((team) => can(viewer, "proposals:decide", team)) ? form.get("reminder") === "on" : current.reminder,
    digestHour: hour,
    timeZone,
    muted: mutedAfter(current.muted, teams, heard),
  };
  await savePrefs(next);
  await record(viewer, {
    action: "notifications.changed",
    outcome: "ok",
    detail: summaryOf({ ...next, updatedAt: new Date() }, kinds, hourLabel(hour)).join(" "),
  });
  redirect(withNotice(BACK, { ok: "Saved. From now on, this is what we email you." }));
}

export async function testNotificationAction(): Promise<void> {
  const viewer = await self();
  if (!(await takeTestAllowance(viewer.userId, TESTS_PER_HOUR)))
    redirect(withNotice(BACK, { error: `You've sent ${TESTS_PER_HOUR} test emails this hour, the most an hour; try again later.` }));
  const { kinds } = await scopeOf(viewer);
  const settings = config();
  const prefs = prefsOr(await savedPrefs(viewer.userId), viewer.userId, widestRole(viewer), settings.notifyTimeZone);
  let problem: string | null = null;
  try {
    await sendMail({ to: viewer.email, ...testMail(viewer.name || "there", summaryOf(prefs, kinds, hourLabel(prefs.digestHour)), settings.baseURL) });
  } catch (error) {
    problem = (error as Error).message;
  }
  await record(viewer, { action: "notifications.test", outcome: problem ? "failed" : "ok", detail: problem });
  redirect(
    withNotice(
      BACK,
      problem
        ? { error: `The test email couldn't be sent: ${problem}` }
        : { ok: "Test email sent to your sign-in address. If it isn't there in a few minutes, look in your spam folder." }
    )
  );
}
