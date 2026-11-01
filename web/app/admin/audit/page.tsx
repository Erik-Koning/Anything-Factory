import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Ago, Chip, param, type SearchParams } from "../../../components/ui.tsx";
import { can } from "../../../server/access.ts";
import { ACTION_LABEL, AUDIT_ACTIONS, isAuditAction, listAudit, OUTCOMES, type Outcome } from "../../../server/audit.ts";
import { config } from "../../../server/config.ts";
import { deviceOf } from "../../../server/device.ts";
import { requireViewer } from "../../../server/viewer.ts";

export const metadata: Metadata = { title: "Audit log" };

const PAGE = 50;
const isOutcome = (value: string): value is Outcome => (OUTCOMES as readonly string[]).includes(value);

// The audit log, for admins: every sign-in, second factor, new IP address and change made from the app, newest first,
// filtered by what, how it went, who and where.
export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  if (!can(viewer, "audit:read")) notFound();
  const params = await searchParams;
  const filters = {
    action: param(params["action"]),
    outcome: param(params["outcome"]),
    email: param(params["email"]).slice(0, 254),
    ip: param(params["ip"]).slice(0, 64),
  };
  const events = await listAudit({
    action: isAuditAction(filters.action) ? filters.action : null,
    outcome: isOutcome(filters.outcome) ? filters.outcome : null,
    email: filters.email || null,
    ip: filters.ip || null,
    before: param(params["before"]) || null,
    limit: PAGE,
  });
  const kept = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
  const older = events.length === PAGE ? `/admin/audit?${new URLSearchParams({ ...kept, before: events.at(-1)?.id ?? "" })}` : null;
  return (
    <>
      <h1>Audit log</h1>
      <p className="lede">
        Every sign-in, second factor, new IP address and change made in this app, newest first. Each is kept {config().auditDays} days and never changed.
      </p>
      <form className="panel filters" method="get" aria-label="Filter the log">
        <label>
          What
          <select name="action" defaultValue={filters.action}>
            <option value="">Everything</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          How it went
          <select name="outcome" defaultValue={filters.outcome}>
            <option value="">Any</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label>
          Who (email)
          <input name="email" type="email" defaultValue={filters.email} autoComplete="off" />
        </label>
        <label>
          IP address
          <input name="ip" defaultValue={filters.ip} autoComplete="off" />
        </label>
        <div className="inline">
          <button type="submit" className="primary">
            Filter
          </button>
          {Object.keys(kept).length ? <Link href="/admin/audit">Clear</Link> : null}
        </div>
      </form>
      <section className="panel" aria-labelledby="events">
        <h2 id="events">Events</h2>
        {events.length ? (
          <ol className="plain rows audit">
            {events.map((e) => (
              <li key={e.id}>
                <span className="when small muted">
                  <Ago at={e.at.toISOString()} />
                </span>
                <div>
                  <div className="head">
                    <span className="title">{ACTION_LABEL[e.action]}</span>
                    <Chip tone={e.outcome === "ok" ? "ok" : "warn"}>{e.outcome}</Chip>
                    {e.team ? <Chip tone="">{e.team}</Chip> : null}
                  </div>
                  <div className="small">
                    {e.email ? (
                      <Link href={`/admin/audit?${new URLSearchParams({ email: e.email })}`}>{e.email}</Link>
                    ) : (
                      <span className="muted">nobody known</span>
                    )}
                    {e.target ? ` → ${e.target}` : ""}
                    {e.detail ? <span className="muted"> · {e.detail}</span> : null}
                  </div>
                  <div className="small muted">
                    {e.ip ? <Link href={`/admin/audit?${new URLSearchParams({ ip: e.ip })}`}>{e.ip}</Link> : "no address"} · {deviceOf(e.userAgent)}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty">Nothing matches.</p>
        )}
        {older ? (
          <p>
            <Link href={older}>Older events →</Link>
          </p>
        ) : null}
      </section>
    </>
  );
}
