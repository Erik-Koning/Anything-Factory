import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "../../../components/submit-button.tsx";
import { Ago, Notice, type SearchParams } from "../../../components/ui.tsx";
import { can, roleIn } from "../../../server/access.ts";
import { config } from "../../../server/config.ts";
import { AUDIENCE } from "../../../server/events.ts";
import { allTeams } from "../../../server/factory.ts";
import {
  hourLabel,
  KIND_TEXT,
  kindsIn,
  MODE_LABEL,
  MODES,
  nextDigest,
  prefsOr,
  savedPrefs,
  timeZones,
  widestRole,
} from "../../../server/notifications.ts";
import { deliveryOf } from "../../../server/notifier.ts";
import { requireViewer } from "../../../server/viewer.ts";
import { saveNotificationsAction, testNotificationAction } from "./actions.ts";
import { TimeZoneSelect } from "./time-zone-select.tsx";

export const metadata: Metadata = { title: "Notifications" };

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// What the person is emailed about and when, for each kind of event they could see in the app; their digest's hour;
// the teams they hear about; and whether email reaches them (a test email, the last one sent, what's waiting to go).
export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  const settings = config();
  const teams = (await allTeams()).filter((t) => roleIn(viewer, t.name) !== null);
  const kinds = kindsIn((kind) => teams.some((t) => can(viewer, AUDIENCE[kind], t.name)));
  const [saved, delivery] = await Promise.all([savedPrefs(viewer.userId), deliveryOf(viewer.userId)]);
  const role = widestRole(viewer);
  const prefs = prefsOr(saved, viewer.userId, role, settings.notifyTimeZone);
  const decides = teams.some((t) => can(viewer, "proposals:decide", t.name));
  const next = nextDigest(new Date(), prefs.timeZone, prefs.digestHour);
  const nextText = new Intl.DateTimeFormat("en-CA", {
    timeZone: prefs.timeZone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(next);
  const mail = settings.resendKey || settings.ses ? "sent" : settings.mailLog ? "console" : "none";
  return (
    <>
      <p className="small">
        <Link href="/account">← Account</Link>
      </p>
      <h1>Notifications</h1>
      <p className="lede">
        What we email you, and when. Everything also shows in the app
        {decides ? (
          <>
            : what needs you is under <Link href="/inbox">Waiting on you</Link>
          </>
        ) : null}
        .
      </p>
      <Notice searchParams={searchParams} />
      {settings.notifyEverySeconds === 0 ? (
        <p className="notice error">
          Notifications are turned off on this server (NOTIFY_EVERY_SECONDS=0): nothing is emailed until whoever runs it turns them on.
        </p>
      ) : mail === "none" ? (
        <p className="notice error">This server has no email service set up, so nothing can be emailed yet: whoever runs it sets RESEND_API_KEY or SES.</p>
      ) : mail === "console" ? (
        <p className="notice">On this machine, emails go to the server&apos;s console instead of being sent.</p>
      ) : null}
      {kinds.length ? (
        <form action={saveNotificationsAction} className="stack">
          <section className="panel" aria-labelledby="what">
            <h2 id="what">What to email you about</h2>
            <p className="hint">
              {saved
                ? `Saved ${saved.updatedAt.toISOString().slice(0, 10)}.`
                : `These are the defaults for ${role === "admin" ? "an admin" : `a ${role}`}; save them to make them yours.`}
            </p>
            <ul className="plain rows modes">
              {kinds.map((kind) => (
                <li key={kind}>
                  <fieldset className="mode">
                    <legend>
                      <b>{KIND_TEXT[kind].label}</b>
                      <span className="hint">{KIND_TEXT[kind].hint}</span>
                    </legend>
                    <div className="segmented">
                      {MODES.map((mode) => (
                        <label key={mode}>
                          <input type="radio" name={`mode-${kind}`} value={mode} defaultChecked={prefs.modes[kind] === mode} required />
                          <span>{MODE_LABEL[mode]}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel stack" aria-labelledby="digest">
            <h2 id="digest">Your daily digest</h2>
            <p className="hint">One email a day with everything set to “In the daily digest”, and none on a day with nothing in it.</p>
            <div className="inline digest-time">
              <label>
                At
                <select name="hour" defaultValue={String(prefs.digestHour)}>
                  {HOURS.map((hour) => (
                    <option key={hour} value={hour}>
                      {hourLabel(hour)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Time zone
                <TimeZoneSelect name="timeZone" value={prefs.timeZone} zones={timeZones()} detect={!saved} />
              </label>
            </div>
            {decides ? (
              <label className="check">
                <input type="checkbox" name="reminder" defaultChecked={prefs.reminder} />
                <span>Also list what still waits on you, and the team&apos;s calls you haven&apos;t reviewed, each day until they&apos;re settled</span>
              </label>
            ) : null}
            <p className="hint">The next one: {nextText}, if there&apos;s anything to say.</p>
          </section>
          <section className="panel" aria-labelledby="teams">
            <h2 id="teams">Teams</h2>
            <fieldset className="choices">
              <legend>Email me about</legend>
              {teams.map((t) => (
                <label key={t.name} className="check">
                  <input type="checkbox" name="team" value={t.name} defaultChecked={!prefs.muted.includes(t.name)} />
                  <span>{t.title || t.name}</span>
                </label>
              ))}
            </fieldset>
          </section>
          <div>
            <SubmitButton className="primary">Save notifications</SubmitButton>
          </div>
        </form>
      ) : (
        <p className="panel empty">You don&apos;t follow a team yet, so there&apos;s nothing to email you about.</p>
      )}
      <section className="panel" aria-labelledby="delivery">
        <h2 id="delivery">Delivery</h2>
        <dl className="facts small">
          <dt>Emails go to</dt>
          <dd>{viewer.email}, your sign-in address</dd>
          <dt>Last email</dt>
          <dd>
            <Ago at={delivery.lastSent?.toISOString()} />
          </dd>
          <dt>Waiting to go</dt>
          <dd>{delivery.waiting ? `${delivery.waiting}, at once or in your next digest` : "nothing"}</dd>
          {delivery.failing ? (
            <>
              <dt>Last problem</dt>
              <dd>{delivery.failing}</dd>
            </>
          ) : null}
        </dl>
        <form action={testNotificationAction} className="inline">
          <SubmitButton>Send me a test email</SubmitButton>
          <span className="hint">It says what you&apos;ll get, so you can see that it arrives and isn&apos;t taken for spam.</span>
        </form>
      </section>
    </>
  );
}
