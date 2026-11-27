import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { LinkPending } from "../../components/link-pending.tsx";
import { formatCount, formatDay, formatNames, formatPercent, formatTokens, formatUsd } from "../../components/usage/format.ts";
import { LimitCard, LimitKey, SubscriptionFacts } from "../../components/usage/limits.tsx";
import { LocalHour } from "../../components/usage/local-hour.tsx";
import { ModelTable, type ModelRow } from "../../components/usage/model-table.tsx";
import { ShareBar } from "../../components/usage/share-bar.tsx";
import { TrendChart } from "../../components/usage/trend-chart.tsx";
import { ViewSelect } from "../../components/usage/view-select.tsx";
import { param, type SearchParams } from "../../components/ui.tsx";
import { visibleMachines } from "../../server/access.ts";
import { linkedMachines, machineSubscriptions } from "../../server/machines.ts";
import {
  costSegments,
  METRICS,
  type Metric,
  type Period,
  PERIODS,
  poolsOf,
  processed,
  ranked,
  type Sort,
  SORTS,
  sortedBy,
  speedSegments,
  subscriptionAs,
  subscriptionsOf,
  tokenSegments,
  type Totals,
  usageOf,
  valueOf,
} from "../../server/usage-view.ts";
import { requireViewer } from "../../server/viewer.ts";
import "./subscriptions.css";

export const metadata: Metadata = { title: "Subscriptions" };

// The Claude subscriptions on the machines the person sees (an admin, every linked machine's), each by the address it
// signs in with: how much of each one's limits is left, and what they used over a window, in dollars at the API's
// prices and in tokens, by subscription and by model. One subscription, or one of its names in a6g, can be chosen, and
// they're in order of use or of name. What's shown is in the address, so a view can be linked to and the back button
// goes back to the last one.
export default async function SubscriptionsPage({ searchParams }: { searchParams: SearchParams }) {
  const [viewer, linked, params] = await Promise.all([requireViewer(), linkedMachines(), searchParams]);
  const machines = visibleMachines(viewer, linked).sort((a, b) => a.name.localeCompare(b.name));
  const reported = await machineSubscriptions(machines.map((m) => m.id));
  const metric: Metric = METRICS.find((m) => m.value === param(params["view"]))?.value ?? "limits";
  const days: Period = PERIODS.find((p) => String(p.days) === param(params["period"]))?.days ?? 30;
  const by = param(params["by"]) === "period" ? "period" : "model";
  const sort: Sort = SORTS.find((s) => s.value === param(params["sort"]))?.value ?? "used";
  const onMachine = machines.find((m) => m.name === param(params["machine"]) && reported.has(m.id))?.name ?? null;
  const reporting = machines.filter((m) => reported.has(m.id));
  const now = new Date();
  const reports = reporting
    .filter((m) => !onMachine || m.name === onMachine)
    .map((m) => ({ machine: { id: m.id, name: m.name }, subscriptions: reported.get(m.id) ?? [] }));
  const all = sortedBy(subscriptionsOf(reports), sort, metric, days, now);
  const chosen = all.find((s) => s.key === param(params["sub"])) ?? null;
  // One of its names in a6g, when it goes by more than one.
  const as = chosen && chosen.names.length > 1 ? (chosen.names.find((n) => n === param(params["as"])) ?? null) : null;
  const subs = chosen ? [as ? subscriptionAs(reports, chosen, as) : chosen] : all;
  const href = (change: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const current: Record<string, string | null> = {
      view: metric === "limits" ? null : metric,
      period: days === 30 ? null : String(days),
      by: by === "model" ? null : by,
      sort: sort === "used" ? null : sort,
      machine: onMachine,
      sub: chosen?.key ?? null,
      as,
    };
    for (const [key, value] of Object.entries({ ...current, ...change })) if (value) next.set(key, value);
    const query = next.toString();
    return `/subscriptions${query ? `?${query}` : ""}`;
  };

  const periods = PERIODS.map((p) => ({ label: p.label, href: href({ period: p.days === 30 ? null : String(p.days) }), on: p.days === days }));
  const views = METRICS.map((m) => ({ label: m.label, href: href({ view: m.value === "limits" ? null : m.value }), on: m.value === metric }));
  const sorts = SORTS.map((s) => ({ label: s.label, href: href({ sort: s.value === "used" ? null : s.value }), on: s.value === sort }));
  const accounts = all.map((s) => ({
    key: s.key,
    label: s.name,
    colour: s.colour,
    href: href({ sub: s.key, as: null }),
    on: chosen?.key === s.key && !as,
    names:
      s.names.length > 1
        ? s.names.map((n) => ({ key: n, label: n, of: s.name, href: href({ sub: s.key, as: n }), on: chosen?.key === s.key && as === n }))
        : [],
  }));
  return (
    <>
      <h1>Subscriptions</h1>
      <p className="lede">
        The Claude subscriptions on {viewer.admin ? "every linked machine" : "your machines"}, each by the address it signs in with: what&apos;s left of
        their limits, and what they&apos;ve used.
      </p>
      {!machines.length ? (
        <p className="panel empty">
          {viewer.admin ? "No machine is linked yet." : "None of your machines is linked yet."} <Link href="/machines">Machines</Link> says how to link
          one.
        </p>
      ) : !reporting.length ? (
        <p className="panel empty">
          None of {viewer.admin ? "the linked machines" : "your machines"} reports its subscriptions yet: that takes the factory from this version on. Run{" "}
          <code>a6g self-install</code> from the latest factory on the machine, and its subscriptions show here within five minutes.
        </p>
      ) : (
        <>
          <div className="usage-bar">
            <Filters
              label="Machine"
              all={{ label: "All machines", href: href({ machine: null, sub: null, as: null }), on: onMachine === null }}
              options={reporting.map((m) => ({
                key: m.id,
                label: m.name,
                href: href({ machine: m.name, sub: null, as: null }),
                on: onMachine === m.name,
                names: [],
              }))}
            />
            <Filters
              label="Subscription"
              all={{ label: "All subscriptions", href: href({ sub: null, as: null }), on: chosen === null }}
              options={accounts}
            />
            <span className="spacer" />
            {all.length > 1 ? <Toggle label="Sort" items={sorts} wide /> : null}
            {metric !== "limits" ? <Toggle label="Period" items={periods} wide /> : null}
            <Toggle label="Show" items={views} wide />
            {all.length > 1 ? <ViewSelect label="Sort" items={sorts} /> : null}
            {metric !== "limits" ? <ViewSelect label="Period" items={periods} /> : null}
            <ViewSelect label="Show" items={views} />
          </div>
          {as && chosen ? (
            <p className="small muted usage-as">
              Only what {as} used. It&apos;s the same Claude account as {formatNames(chosen.names.filter((n) => n !== as))}
              {chosen.email ? `, ${chosen.email}` : ""}: they share its limits.
            </p>
          ) : null}
          {metric === "limits" ? (
            <LimitsView subs={subs} now={now} />
          ) : (
            <UsageView subs={subs} metric={metric} days={days} by={by} now={now} href={href} />
          )}
        </>
      )}
    </>
  );
}

interface Choice {
  key: string;
  label: string;
  href: string;
  on: boolean;
}

// A row of links that narrows the page to one machine or one subscription, a subscription's names in a6g joined to it
// when it goes by more than one; nothing when there's only one to choose.
function Filters({
  label,
  all,
  options,
}: {
  label: string;
  all: Omit<Choice, "key">;
  options: (Choice & { colour?: number; names: (Choice & { of: string })[] })[];
}) {
  if (options.reduce((n, o) => n + 1 + o.names.length, 0) < 2) return null;
  const link = (c: Omit<Choice, "key">, colour?: number, of?: string) => (
    <Link href={c.href} aria-current={c.on ? "true" : undefined}>
      <LinkPending />
      {colour !== undefined ? <span className={`swatch c${colour}`} aria-hidden="true" /> : null}
      <span className="usage-filter-label">{c.label}</span>
      {of ? <span className="sr"> ({of})</span> : null}
    </Link>
  );
  return (
    <nav className="usage-filter" aria-label={label}>
      {link(all)}
      {options.map((o) =>
        o.names.length ? (
          <span key={o.key} className="usage-filter-group">
            {link(o, o.colour)}
            {o.names.map((n) => (
              <Fragment key={n.key}>{link(n, undefined, n.of)}</Fragment>
            ))}
          </span>
        ) : (
          <Fragment key={o.key}>{link(o, o.colour)}</Fragment>
        )
      )}
    </nav>
  );
}

// Segmented links: the view or the window shown, the current one pressed in. `wide`: on a phone a menu takes its place.
function Toggle({ label, items, wide = false }: { label: string; items: { label: string; href: string; on: boolean }[]; wide?: boolean }) {
  return (
    <nav className={`usage-toggle${wide ? " wide-only" : ""}`} aria-label={label}>
      {items.map((item) => (
        <Link key={item.label} href={item.href} aria-current={item.on ? "true" : undefined} scroll={false}>
          <LinkPending />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function LimitsView({ subs, now }: { subs: ReturnType<typeof subscriptionsOf>; now: Date }) {
  const pools = poolsOf(subs, now);
  return (
    <>
      {pools.length ? <LimitKey /> : null}
      {pools.length ? (
        <ul className="limit-cards">
          {pools.map((pool) => (
            <LimitCard key={pool.label} pool={pool} now={now.getTime()} />
          ))}
        </ul>
      ) : (
        <p className="panel empty">No subscription here has its limits read yet: its machine reads them every quarter hour.</p>
      )}
      <section className="panel" aria-labelledby="subs-h">
        <h2 id="subs-h">{subs.length === 1 ? "The subscription" : "The subscriptions"}</h2>
        <SubscriptionFacts subs={subs} />
        <p className="hint">
          Where the teams stop on a subscription is set on its machine with <code>a6g subscriptions limit</code>. Teams move to their next subscription at
          a limit, and wait when none is open.
        </p>
      </section>
    </>
  );
}

function UsageView({
  subs,
  metric,
  days,
  by,
  now,
  href,
}: {
  subs: ReturnType<typeof subscriptionsOf>;
  metric: Exclude<Metric, "limits">;
  days: Period;
  by: "model" | "period";
  now: Date;
  href: (change: Record<string, string | null>) => string;
}) {
  const usage = usageOf(subs, days, now);
  const format = metric === "cost" ? formatUsd : formatTokens;
  const total = valueOf(usage.totals, metric);
  // In the page's order, as the chart and the table are.
  const series = usage.series;
  const unpricedShare = usage.totals.requests ? usage.totals.unpriced / usage.totals.requests : 0;
  const unit = usage.hourly ? "hour" : "day";
  const heading = `${usage.hourly ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "processed tokens"}`;
  const window =
    usage.hourly || !usage.periods.length ? "the last 24 hours" : `${formatDay(usage.periods[0] ?? "")} to ${formatDay(usage.periods.at(-1) ?? "")}`;
  const models: ModelRow[] = ranked(usage.models, metric).map((m) => {
    const seriesIn = m.totals.cost === 0 && m.totals.unpriced > 0 ? "tokens" : "cost";
    return {
      model: m.model,
      totals: m.totals,
      seriesIn,
      series: m.bySub.map((p) => ({ name: p.sub.name, colour: p.sub.colour, values: p.byPeriod.map((t) => valueOf(t, seriesIn)) })),
    };
  });
  return (
    <>
      <section className="panel usage-overview" aria-labelledby="usage-h">
        <div className="usage-side">
          <h2 id="usage-h" className="sr">
            {metric === "cost" ? "Cost" : "Tokens"}, {window}
          </h2>
          <p className="usage-headline fig">{format(total)}</p>
          <p className="small muted">
            {formatCount(usage.sessions)} {usage.sessions === 1 ? "session" : "sessions"}
            {metric === "cost" ? " · API-equivalent" : ""} · {window}
          </p>
          {metric === "cost" && unpricedShare > 0 ? (
            <p className="small muted">Leaves out {formatPercent(unpricedShare)} of requests: on a model with no price yet.</p>
          ) : null}
          <ol className="usage-series">
            {series.map((s) => {
              const v = valueOf(s.totals, metric);
              return (
                <li key={s.sub.key}>
                  <span className={`swatch c${s.sub.colour}`} aria-hidden="true" />
                  <span className="usage-series-name">
                    <b>{s.sub.name}</b>
                    <span className="small muted">
                      {formatCount(s.sessions)} {s.sessions === 1 ? "session" : "sessions"}
                      {s.sub.email ? ` · ${s.sub.names.join(", ")} in a6g` : ""}
                    </span>
                  </span>
                  <span className="fig">{format(v)}</span>
                  <span className="small muted usage-series-share">
                    {total ? formatPercent(v / total) : "0%"} of {metric === "cost" ? "cost" : "tokens"} ·{" "}
                    {metric === "cost" ? `${formatTokens(processed(s.totals))} tokens` : formatUsd(s.totals.cost)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="usage-main">
          <h3>{heading}</h3>
          <TrendChart
            periods={usage.periods}
            hourly={usage.hourly}
            metric={metric}
            now={now.getTime()}
            label={`${heading}, ${window}, by subscription`}
            series={usage.series.map((s) => ({ name: s.sub.name, colour: s.sub.colour, values: s.byPeriod.map((t) => valueOf(t, metric)) }))}
          />
        </div>
      </section>
      <section className="panel" aria-labelledby="totals-h">
        <h2 id="totals-h">Totals</h2>
        <ul className="usage-stats">
          <Stat label="Processed tokens" value={formatTokens(processed(usage.totals))} />
          <Stat label="Cached input" value={formatTokens(usage.totals.cacheRead)} />
          <Stat label="Uncached input" value={formatTokens(usage.totals.input)} />
          <Stat label="Output" value={formatTokens(usage.totals.output)} />
          <Stat label="Cache savings" value={formatUsd(usage.totals.saved)} />
        </ul>
        <p className="hint">
          Every session on the machine counts, yours too, at the Claude API&apos;s prices: on a subscription that&apos;s how fast it uses its limits.
        </p>
        {processed(usage.totals) > 0 ? (
          metric === "tokens" ? (
            <ShareBar title="Tokens by type" segments={tokenSegments(usage.totals)} format={formatTokens} />
          ) : (
            <>
              <ShareBar title="Cost by type" segments={costSegments(usage.totals)} format={formatUsd} />
              {usage.totals.fast > 0 ? (
                <ShareBar
                  title="Cost by speed"
                  segments={speedSegments(usage.totals)}
                  format={formatUsd}
                  aside={`Premium ${formatUsd(usage.totals.fast)}`}
                />
              ) : null}
            </>
          )
        ) : null}
      </section>
      <section className="panel" aria-labelledby="breakdown-h">
        <div className="usage-section-head">
          <h2 id="breakdown-h">Breakdown</h2>
          <Toggle
            label="Breakdown by"
            items={[
              { label: "Model", href: href({ by: null }), on: by === "model" },
              { label: usage.hourly ? "Hour" : "Day", href: href({ by: "period" }), on: by === "period" },
            ]}
          />
        </div>
        {by === "model" ? (
          <ModelTable rows={models} metric={metric} periods={usage.periods} hourly={usage.hourly} now={now.getTime()} />
        ) : (
          <PeriodTable usage={usage} unit={unit} now={now.getTime()} />
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <li>
      <span>{label}</span>
      <b className="fig">{value}</b>
    </li>
  );
}

// Each hour or day with use, newest first: each subscription's cost, their total, and the tokens.
function PeriodTable({ usage, unit, now }: { usage: ReturnType<typeof usageOf>; unit: "hour" | "day"; now: number }) {
  const rows = usage.periods
    .map((period, i) => ({ period, parts: usage.series.map((s) => s.byPeriod[i] as Totals) }))
    .filter((r) => r.parts.some((t) => t.requests > 0))
    .reverse();
  if (!rows.length) return <p className="empty">Nothing used in this window.</p>;
  const label = (period: string) => (unit === "hour" ? <LocalHour hour={period} now={now} /> : formatDay(period));
  return (
    <div className="table-scroll">
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">{unit === "hour" ? "Hour" : "Day"}</th>
            {usage.series.map((s) => (
              <th scope="col" className="fig" key={s.sub.key}>
                <span className={`swatch c${s.sub.colour}`} aria-hidden="true" /> {s.sub.name}
              </th>
            ))}
            <th scope="col" className="fig">
              Total
            </th>
            <th scope="col" className="fig">
              Tokens
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.period}>
              <th scope="row">{label(r.period)}</th>
              {r.parts.map((t, i) => (
                <td className="fig" key={usage.series[i]?.sub.key}>
                  {formatUsd(t.cost)}
                </td>
              ))}
              <td className="fig">{formatUsd(r.parts.reduce((n, t) => n + t.cost, 0))}</td>
              <td className="fig">{formatTokens(r.parts.reduce((n, t) => n + processed(t), 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
