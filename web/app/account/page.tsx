import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "../../components/submit-button.tsx";
import { Ago, Chip, Notice, type SearchParams } from "../../components/ui.tsx";
import { AUTHENTICATOR_GRACE_DAYS, checksIp, SESSION_DAYS } from "../../server/access.ts";
import { hasPassword } from "../../server/account-choices.ts";
import { ACTION_LABEL, listAudit } from "../../server/audit.ts";
import { auth } from "../../server/auth.ts";
import { deviceOf } from "../../server/device.ts";
import { knownIps } from "../../server/known-ips.ts";
import { authHeaders, requireViewer } from "../../server/viewer.ts";
import { SignOutButton } from "../sign-out-button.tsx";
import { BackupCodes, Passkeys } from "./account-parts.tsx";
import { forgetIpAction, keepDeviceAction, revokeOtherSessionsAction, revokeSessionAction, turnOffIpCheckAction, turnOnIpCheckAction } from "./actions.ts";
import { AuthenticatorSetup } from "./authenticator.tsx";
import { ActionForm } from "../../components/action-form.tsx";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  const requestHeaders = await authHeaders();
  const [passkeys, sessions, addresses, activity, password] = await Promise.all([
    auth().api.listPasskeys({ headers: requestHeaders }),
    auth().api.listSessions({ headers: requestHeaders }),
    knownIps(viewer.userId),
    listAudit({ userId: viewer.userId, limit: 15 }),
    // Someone who signed up has a password, and Better Auth asks for it wherever the authenticator changes.
    hasPassword(viewer.userId),
  ]);
  const teams = Object.entries(viewer.teams);
  const checked = checksIp(viewer);
  return (
    <>
      <h1>Account</h1>
      <p className="lede">
        {viewer.name} · {viewer.email}
        {viewer.admin ? " · admin" : ""}
      </p>
      <Notice searchParams={searchParams} />
      <section className="panel" aria-labelledby="notifications">
        <div className="head">
          <h2 id="notifications" className="title">
            Notifications
          </h2>
          <Link className="button" href="/account/notifications">
            Change what we email you
          </Link>
        </div>
        <p className="hint">
          {viewer.admin ? "Questions for you, blocked work, journeys done and your requests" : "Journeys done, blocked work and your requests"}: at once,
          in a daily digest, or not at all. A test email shows they reach you.
        </p>
      </section>
      <div className="grid">
        <section className="panel" aria-labelledby="passkeys">
          <h2 id="passkeys">Passkeys</h2>
          <p className="hint">
            Sign in with your device instead of an email link{password && !viewer.admin ? " or your password" : ""}.
            {viewer.admin ? " As an admin, a passkey counts once it checks it's you (PIN, fingerprint or face)." : ""}
          </p>
          <Passkeys passkeys={passkeys.map((p) => ({ id: p.id, name: p.name || "Passkey", createdAt: new Date(p.createdAt).toISOString() }))} />
        </section>
        <section className="panel" aria-labelledby="authenticator">
          <h2 id="authenticator">Authenticator</h2>
          <p>
            <Chip tone={viewer.twoFactor ? "ok" : viewer.admin ? "warn" : ""}>{viewer.twoFactor ? "on" : "off"}</Chip>
          </p>
          {viewer.admin ? (
            <>
              <p className="hint">Admins always sign in with one. Yours was set up by create-admin; running it again replaces it.</p>
              <BackupCodes password />
            </>
          ) : (
            <>
              {/* Once on, it stays on: two-factor authentication can't be turned off (auth.ts). */}
              <AuthenticatorSetup enabled={viewer.twoFactor} password={password}>
                <p className="hint">Every sign-in asks for its code too, however you sign in. It stays on: it can&apos;t be turned off.</p>
                <BackupCodes password={password} />
              </AuthenticatorSetup>
              {!viewer.twoFactor && viewer.authenticatorDue && viewer.signedUpAt ? (
                <p className="hint">
                  Two-factor authentication is on for every new account: set it up by{" "}
                  {new Date(Date.parse(viewer.signedUpAt) + AUTHENTICATOR_GRACE_DAYS * 86_400_000).toLocaleDateString("en-CA", {
                    month: "long",
                    day: "numeric",
                  })}
                  . After that, signing in asks for it before anything else.
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
      <section className="panel" aria-labelledby="sessions">
        <h2 id="sessions">Where you&apos;re signed in</h2>
        {/* This device, kept signed in or not: 90 days of use and no new-network check, or the usual week. */}
        <div className="sub-form" role="group" aria-labelledby="this-device">
          <h3 id="this-device">This device</h3>
          <p className="hint">
            {viewer.kept
              ? `Kept signed in: it stays signed in for ${SESSION_DAYS.kept} days of use, and a new network doesn't ask you again.`
              : `Signed out after ${SESSION_DAYS.usual} days unused, and asked by email when it's on a new network. Keep it signed in on a device only you use.`}
          </p>
          <ActionForm action={keepDeviceAction} className="inline">
            <input type="hidden" name="keep" value={viewer.kept ? "no" : "yes"} />
            <SubmitButton className={viewer.kept ? undefined : "primary"}>
              {viewer.kept ? "Stop keeping it signed in" : "Keep this device signed in"}
            </SubmitButton>
          </ActionForm>
        </div>
        <ul className="plain rows">
          {sessions.map((s) => (
            <li key={s.id} className="head">
              <span className="title">{deviceOf(s.userAgent)}</span>
              <span className="muted small">
                {s.ipAddress ? (
                  <>
                    <span className="ip">{s.ipAddress}</span> ·{" "}
                  </>
                ) : null}
                signed in <Ago at={new Date(s.createdAt).toISOString()} />
              </span>
              {(s as { kept?: boolean }).kept ? <Chip>kept signed in</Chip> : null}
              {s.id === viewer.sessionId ? (
                <Chip tone="ok">this one</Chip>
              ) : (
                <ActionForm action={revokeSessionAction}>
                  <input type="hidden" name="id" value={s.id} />
                  <SubmitButton className="danger">{`End the session on ${deviceOf(s.userAgent)}`}</SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        <div className="inline">
          {sessions.length > 1 ? (
            <ActionForm action={revokeOtherSessionsAction}>
              <SubmitButton>End every other session</SubmitButton>
            </ActionForm>
          ) : null}
          <SignOutButton label="Sign out" className="button" />
        </div>
      </section>
      <div className="grid">
        <section className="panel" aria-labelledby="addresses">
          <h2 id="addresses">Your IP addresses</h2>
          <p>
            <Chip tone={checked ? "ok" : "warn"}>{checked ? "new ones are checked" : "new ones aren't checked"}</Chip>
          </p>
          <p className="hint">
            {checked
              ? "A sign-in from any other address asks you to confirm it by email first. On a device kept signed in, a new network doesn't ask again."
              : "A sign-in from an address you haven't used goes ahead without asking you. The ones here are those you confirmed before."}
          </p>
          {addresses.length ? (
            <ul className="plain rows">
              {addresses.map((a) => (
                <li key={a.ip} className="head">
                  <span className="title ip">{a.ip}</span>
                  <span className="muted small">
                    {a.via} · last used <Ago at={a.lastSeenAt.toISOString()} />
                  </span>
                  {a.ip === viewer.ip ? (
                    <Chip tone="ok">this one</Chip>
                  ) : (
                    <ActionForm action={forgetIpAction}>
                      <input type="hidden" name="ip" value={a.ip} />
                      <SubmitButton className="quiet s">{`Forget ${a.ip}`}</SubmitButton>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">None yet.</p>
          )}
          {viewer.ipCheck ? (
            <details>
              <summary>Turn the check off</summary>
              <ActionForm action={turnOffIpCheckAction} className="stack">
                <p className="hint">
                  Then a sign-in from anywhere goes ahead without an email to you. It takes{" "}
                  {viewer.twoFactor ? "a code from your authenticator" : "a sign-in from the last ten minutes"}, and we email you that it was turned off.
                </p>
                {viewer.twoFactor ? (
                  <label>
                    Authenticator code, to stop checking
                    <input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} />
                  </label>
                ) : null}
                <div>
                  <SubmitButton className="danger">Stop checking new addresses</SubmitButton>
                </div>
              </ActionForm>
            </details>
          ) : (
            <ActionForm action={turnOnIpCheckAction}>
              <SubmitButton>Check new addresses again</SubmitButton>
            </ActionForm>
          )}
        </section>
        <section className="panel" aria-labelledby="activity">
          <h2 id="activity">Recent activity</h2>
          {activity.length ? (
            // A line each, when first: what the audit log keeps of it, in short (Audit has the whole of it, for an admin).
            <ul className="plain rows small activity">
              {activity.map((e) => {
                const device = deviceOf(e.userAgent);
                return (
                  <li key={e.id}>
                    <span className="muted">
                      <Ago at={e.at.toISOString()} />
                    </span>
                    <span>
                      <span className="title">{ACTION_LABEL[e.action]}</span>
                      {e.outcome === "ok" ? null : (
                        <>
                          {" "}
                          <Chip tone="warn">{e.outcome}</Chip>
                        </>
                      )}
                      <span className="muted">
                        {e.detail ? ` · ${e.detail}` : ""}
                        {e.ip ? (
                          <>
                            {" · "}
                            <span className="ip">{e.ip}</span>
                          </>
                        ) : null}
                        {device ? ` · ${device}` : ""}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="empty">Nothing yet.</p>
          )}
          {teams.length ? <p className="hint">Your teams: {teams.map(([team, role]) => `${team} (${role})`).join(", ")}.</p> : null}
        </section>
      </div>
    </>
  );
}
