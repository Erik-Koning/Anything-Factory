// The Limits view: a card for each window the subscriptions report (the five-hour session, the week, a model's own
// week, extra usage by the month). The card says how much of the pool is left and whether it's going faster than the
// window runs; its bar has a part for each subscription, as wide as its weight in the pool, filled with what's left of
// it. The used part is hatched where its reset will give it back, the line in the gap is where even use would be by
// now, and a dashed mark is where the factory's teams stop on it (a6g subscriptions limit). Pointing at a part, or
// focusing it, says the rest.
import type { ReactNode } from "react";
import { type Pace, paceOf, type Pool, type PoolPart } from "../../server/usage-view.ts";
import { Ago } from "../ui.tsx";
import { formatPercent, resetsIn, span } from "./format.ts";

const PACE: Record<Pace, { label: string; icon: ReactNode }> = {
  ahead: {
    label: "Ahead of pace: using it faster than the window runs",
    icon: (
      <>
        <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
        <polyline points="16 7 22 7 22 13" />
      </>
    ),
  },
  on: {
    label: "On pace with the window",
    icon: (
      <>
        <path d="m12 14 4-4" />
        <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      </>
    ),
  },
  under: {
    label: "Under pace: room left for the rest of the window",
    icon: (
      <>
        <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
        <polyline points="16 17 22 17 22 11" />
      </>
    ),
  },
};

function PaceMark({ pace }: { pace: Pace | null }) {
  if (!pace) return null;
  const { label, icon } = PACE[pace];
  return (
    <span className={`pace ${pace}`} title={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {icon}
      </svg>
      <span className="sr">{label}</span>
    </span>
  );
}

const money = (amount: number | null, currency: string | null): string =>
  amount === null ? "?" : new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);

function Part({ part, pool, now, many }: { part: PoolPart; pool: Pool; now: number; many: boolean }) {
  const left = Math.round(100 - part.used);
  const evenLeft = part.elapsed === null ? null : Math.round((1 - part.elapsed) * 100);
  const reset = resetsIn(part.resetsAt, now);
  const refills = part.resetsAt !== null && part.used > 0;
  const total = pool.parts.reduce((n, p) => n + p.weight, 0) || 1;
  const { sub } = part;
  const closed = sub.latest.closed;
  return (
    <span
      className={`pool-part c${sub.colour}${part.exhausted ? " spent" : ""}`}
      style={{ flexGrow: part.weight }}
      tabIndex={0}
      aria-label={`${sub.name}: ${left}% left${reset ? `, ${reset}` : ""}${part.limit !== null ? `, the teams stop at ${part.limit}% used` : ""}`}
    >
      <span className="pool-track" aria-hidden="true">
        <span className="pool-left" style={{ width: `${left}%` }} />
        {refills ? <span className="pool-used" style={{ left: `${left}%` }} /> : null}
        {evenLeft !== null ? <span className="pool-pace" style={{ left: `${evenLeft}%` }} /> : null}
        {part.limit !== null && part.limit < 100 ? <span className="pool-limit" style={{ left: `${100 - part.limit}%` }} /> : null}
        <span className="pool-text">
          {many ? <b>{sub.name}</b> : null}
          <span className="fig">{left}% left</span>
          {reset && part.resetsAt ? <span className="fig reset">↻ {span(Date.parse(part.resetsAt) - now)}</span> : null}
        </span>
      </span>
      <span className="pool-pop" aria-hidden="true">
        <b>{sub.name}</b>
        <dl>
          {sub.plan ? (
            <>
              <dt>Plan</dt>
              <dd>{sub.plan}</dd>
            </>
          ) : null}
          <dt>Left</dt>
          <dd className="fig">
            {part.amount ? `${money(part.amount.used, part.amount.currency)} of ${money(part.amount.cap, part.amount.currency)} used` : `${left}%`}
          </dd>
          {reset ? (
            <>
              <dt>Resets</dt>
              <dd>{reset.replace(/^resets /, "")}</dd>
            </>
          ) : null}
          {evenLeft !== null ? (
            <>
              <dt>Even pace</dt>
              <dd className="fig">{evenLeft}% left by now</dd>
            </>
          ) : null}
          {many && refills ? (
            <>
              <dt>Restores</dt>
              <dd className="fig">+{formatPercent((part.used * part.weight) / total / 100)} of the pool</dd>
            </>
          ) : null}
          {part.limit !== null ? (
            <>
              <dt>Teams stop</dt>
              <dd className="fig">at {part.limit}% used</dd>
            </>
          ) : null}
          {closed && (pool.kind === "weekly" || pool.kind === "session") ? (
            <>
              <dt>Closed</dt>
              <dd>{closed.why}</dd>
            </>
          ) : null}
          <dt>On</dt>
          <dd>{sub.machines.join(", ")}</dd>
        </dl>
      </span>
    </span>
  );
}

// What the marks in a limit bar mean, once above the cards.
export function LimitKey() {
  return (
    <ul className="limit-key" aria-label="How to read the bars">
      <li>
        <span className="key-left" aria-hidden="true" /> left
      </li>
      <li>
        <span className="key-used" aria-hidden="true" /> used, back when it resets
      </li>
      <li>
        <span className="key-pace" aria-hidden="true" /> even pace by now
      </li>
      <li>
        <span className="key-limit" aria-hidden="true" /> where the teams stop
      </li>
    </ul>
  );
}

export function LimitCard({ pool, now }: { pool: Pool; now: number }) {
  const left = Math.round(100 - pool.used);
  const many = pool.parts.length > 1;
  // The pool's pace: its used share against how far its parts' windows have run, weighted alike.
  const timed = pool.parts.filter((p) => p.elapsed !== null);
  const weight = timed.reduce((n, p) => n + p.weight, 0);
  const elapsed = weight ? timed.reduce((n, p) => n + (p.elapsed ?? 0) * p.weight, 0) / weight : null;
  const exhausted = pool.parts.every((p) => p.exhausted);
  const only = pool.parts[0];
  return (
    <li className={`limit-card${exhausted ? " spent" : ""}`}>
      <div className="limit-head">
        <h3>{pool.label}</h3>
        <p className="limit-left">
          <b className="fig">{left}%</b> left <PaceMark pace={paceOf(pool.used, elapsed)} />
        </p>
        <p className="small muted">
          {exhausted
            ? `Used up, ${resetsIn(only?.resetsAt ?? null, now) ?? "until it resets"}`
            : many && pool.next
              ? `↻ +${formatPercent(pool.next.restores / 100)} from ${pool.next.part.sub.name}, ${resetsIn(pool.next.part.resetsAt, now)?.replace(/^resets /, "") ?? ""}`
              : only?.amount
                ? `${money(only.amount.used, only.amount.currency)} of ${money(only.amount.cap, only.amount.currency)} this month`
                : (resetsIn(only?.resetsAt ?? null, now) ?? "")}
        </p>
      </div>
      <div className="pool">
        {pool.parts.map((part) => (
          <Part key={part.sub.key} part={part} pool={pool} now={now} many={many} />
        ))}
      </div>
      {many ? (
        // On a phone the parts are too narrow for their names: they're said here instead.
        <ul className="pool-legend" aria-hidden="true">
          {pool.parts.map((part) => (
            <li key={part.sub.key}>
              <span className={`swatch c${part.sub.colour}`} />
              {part.sub.name} <span className="fig">{Math.round(100 - part.used)}% left</span>
              {part.resetsAt ? <span className="muted">↻ {span(Math.max(0, Date.parse(part.resetsAt) - now))}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// The subscriptions themselves, below the cards: each one's plan, machines, the teams on it now, whether it's closed to
// them, and how fresh its reading is.
export function SubscriptionFacts({ subs }: { subs: import("../../server/usage-view.ts").Subscription[] }) {
  return (
    <ul className="sub-facts">
      {subs.map((s) => (
        <li key={s.key}>
          <span className={`swatch c${s.colour}`} aria-hidden="true" />
          <div>
            <p>
              <b>{s.name}</b>
              {s.plan ? <span className="muted"> · {s.plan}</span> : null}
              <span className="muted"> · on {s.machines.join(", ")}</span>
            </p>
            {s.latest.closed ? <p className="small warn-text">Closed to the teams: {s.latest.closed.why}.</p> : null}
            <p className="small muted">
              {s.teams.length
                ? `Runs ${s.teams.map((t) => `${t.team} (${t.roles.length === 1 ? t.roles[0] : `${t.roles.length} roles`})`).join(", ")}`
                : "No team runs on it now"}
              {s.latest.week ? ` · a week of it is about $${Math.round(s.latest.week).toLocaleString("en-US")} API-equivalent` : ""}
            </p>
            <p className="small muted">
              {s.latest.at ? (
                <>
                  Limits read <Ago at={s.latest.at} />
                </>
              ) : (
                "Limits not read yet"
              )}
              {s.counted ? (
                <>
                  {" "}
                  · usage counted <Ago at={s.counted} />
                </>
              ) : null}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
