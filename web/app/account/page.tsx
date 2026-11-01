import type { Metadata } from "next";
import { SubmitButton } from "../../components/submit-button.tsx";
import { Ago, Chip, Notice, type SearchParams } from "../../components/ui.tsx";
import { ACTION_LABEL, listAudit } from "../../server/audit.ts";
import { auth } from "../../server/auth.ts";
import { deviceOf } from "../../server/device.ts";
import { knownIps } from "../../server/known-ips.ts";
import { authHeaders, requireViewer } from "../../server/viewer.ts";
import { SignOutButton } from "../sign-out-button.tsx";
import { BackupCodes, Passkeys } from "./account-parts.tsx";
import { forgetIpAction, revokeOtherSessionsAction, revokeSessionAction, turnOffAuthenticatorAction } from "./actions.ts";
import { AuthenticatorSetup } from "./authenticator.tsx";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  const requestHeaders = await authHeaders();
  const [passkeys, sessions, addresses, activity] = await Promise.all([
    auth().api.listPasskeys({ headers: requestHeaders }),
    auth().api.listSessions({ headers: requestHeaders }),
    knownIps(viewer.userId),
    listAudit({ userId: viewer.userId, limit: 15 }),
  ]);
  const teams = Object.entries(viewer.teams);
  return (
    <>
      <h1>Account</h1>
      <p className="lede">
        {viewer.name} · {viewer.email}
        {viewer.admin ? " · admin" : ""}
      </p>
      <Notice searchParams={searchParams} />
      <div className="grid">
        <section className="panel" aria-labelledby="passkeys">
          <h2 id="passkeys">Passkeys</h2>
          <p className="hint">
            Sign in with your device instead of an email link.
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
              <p className="hint">
                Admins always sign in with one. Yours was set up by create-admin; running it again replaces it. Backup codes sign you in once each when the
                authenticator isn&apos;t at hand.
              </p>
              <BackupCodes password />
            </>
          ) : (
            <AuthenticatorSetup enabled={viewer.twoFactor}>
              <p className="hint">Every sign-in asks for its code too, whether by passkey or email link.</p>
              <BackupCodes password={false} />
              <form action={turnOffAuthenticatorAction} className="inline">
                <label>
                  A code from it, to turn it off
                  <input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} />
                </label>
                <SubmitButton className="danger">Turn it off</SubmitButton>
              </form>
            </AuthenticatorSetup>
          )}
        </section>
      </div>
      <section className="panel" aria-labelledby="sessions">
        <h2 id="sessions">Where you&apos;re signed in</h2>
        <ul className="plain rows">
          {sessions.map((s) => (
            <li key={s.id} className="head">
              <span className="title">{deviceOf(s.userAgent)}</span>
              <span className="muted small">
                {s.ipAddress ? `${s.ipAddress} · ` : ""}signed in <Ago at={new Date(s.createdAt).toISOString()} />
              </span>
              {s.id === viewer.sessionId ? (
                <Chip tone="ok">this one</Chip>
              ) : (
                <form action={revokeSessionAction}>
                  <input type="hidden" name="id" value={s.id} />
                  <SubmitButton className="danger">{`End the session on ${deviceOf(s.userAgent)}`}</SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
        <div className="inline">
          {sessions.length > 1 ? (
            <form action={revokeOtherSessionsAction}>
              <SubmitButton>End every other session</SubmitButton>
            </form>
          ) : null}
          <SignOutButton label="Sign out" className="button" />
        </div>
      </section>
      <div className="grid">
        <section className="panel" aria-labelledby="addresses">
          <h2 id="addresses">Your IP addresses</h2>
          <p className="hint">A sign-in from any other address asks you to confirm it by email first.</p>
          {addresses.length ? (
            <ul className="plain rows">
              {addresses.map((a) => (
                <li key={a.ip} className="head">
                  <code>{a.ip}</code>
                  <span className="muted small">
                    {a.via} · last used <Ago at={a.lastSeenAt.toISOString()} />
                  </span>
                  {a.ip === viewer.ip ? (
                    <Chip tone="ok">this one</Chip>
                  ) : (
                    <form action={forgetIpAction}>
                      <input type="hidden" name="ip" value={a.ip} />
                      <SubmitButton className="linkish">{`Forget ${a.ip}`}</SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">None yet.</p>
          )}
        </section>
        <section className="panel" aria-labelledby="activity">
          <h2 id="activity">Recent activity</h2>
          {activity.length ? (
            <ul className="plain rows small">
              {activity.map((e) => (
                <li key={e.id}>
                  <div className="head">
                    <span className="title">{ACTION_LABEL[e.action]}</span>
                    {e.outcome === "ok" ? null : <Chip tone="warn">{e.outcome}</Chip>}
                    <span className="muted">
                      <Ago at={e.at.toISOString()} />
                    </span>
                  </div>
                  <div className="muted">{[e.detail, e.ip, deviceOf(e.userAgent)].filter(Boolean).join(" · ")}</div>
                </li>
              ))}
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
