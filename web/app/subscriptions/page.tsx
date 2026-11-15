import type { Metadata } from "next";
import Link from "next/link";
import { LinkPending } from "../../components/link-pending.tsx";
import { formatCount, formatDay, formatPercent, formatTokens, formatUsd } from "../../components/usage/format.ts";
import { LimitCard, SubscriptionFacts } from "../../components/usage/limits.tsx";
import { LocalHour } from "../../components/usage/local-hour.tsx";
import { ModelTable, type ModelRow } from "../../components/usage/model-table.tsx";
import { ShareBar } from "../../components/usage/share-bar.tsx";
import { TrendChart } from "../../components/usage/trend-chart.tsx";
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
  speedSegments,
  subscriptionsOf,
  tokenSegments,
  type Totals,
  usageOf,
  valueOf,
} from "../../server/usage-view.ts";
import { requireViewer } from "../../server/viewer.ts";
import "./subscriptions.css";

export const metadata: Metadata = { title: "Subscriptions" };

// The Claude subscriptions on the machines the person sees (an admin, every linked machine's): how much of each one's
// limits is left, and what they used over a window, in dollars at the API's prices and in tokens, by subscription and
// by model. What's shown is in the address, so a view can be linked to and the back button goes back to the last one.
export default async function SubscriptionsPage({ searchParams }: { searchParams: SearchParams }) {
  const [viewer, linked, params] = await Promise.all([requireViewer(), linkedMachines(), searchParams]);
  const machines = visibleMachines(viewer, linked).sort((a, b) => a.name.localeCompare(b.name));
  const reported = await machineSubscriptions(machines.map((m) => m.id));
  const metric: Metric = METRICS.find((m) => m.value === param(params["view"]))?.value ?? "limits";
  const days: Period = PERIODS.find((p) => String(p.days) === param(params["period"]))?.days ?? 30;
  const by = param(params["by"]) === "period" ? "period" : "model";
  const onMachine = machines.find((m) => m.name === param(params["machine"]) && reported.has(m.id))?.name ?? null;
  const reporting = machines.filter((m) => reported.has(m.id));
  const all = subscriptionsOf(
    reporting
      .filter((m) => !onMachine || m.name === onMachine)
      .map((m) => ({ machine: { id: m.id, name: m.name }, subscriptions: reported.get(m.id) ?? [] }))
  );
  const chosen = all.find((s) => s.key === param(params["sub"])) ?? null;
  const subs = chosen ? [chosen] : all;
  const now = new Date();
  const href = (change: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const current: Record<string, string | null> = {
      view: metric === "limits" ? null : metric,
      period: days === 30 ? null : String(days),
      by: by === "model" ? null : by,
      machine: onMachine,
      sub: chosen?.key ?? null,
    };
    for (const [key, value] of Object.entries({ ...current, ...change })) if (value) next.set(key, value);
    const query = next.toString();
    return `/subscriptions${query ? `?${query}` : ""}`;
  };

  return (
    <>
      <h1>Subscriptions</h1>
      <p className="lede">
        {viewer.admin ? "The Claude subscriptions on every linked machine" : "The Claude subscriptions on your machines"}: how much of each one&apos;s
        limits is left, and what they used, every session on the machine counted (yours too), at the Claude API&apos;s prices.
      </p>
      {!machines.length ? (
        <p className="panel empty">
          No machine is linked yet. <Link href="/machines">Machines</Link> says how to link one.
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
              all="All machines"
              current={onMachine}
              options={reporting.length > 1 ? reporting.map((m) => ({ value: m.name, label: m.name })) : []}
              href={(value) => href({ machine: value, sub: null })}
            />
            <Filters
              label="Subscription"
              all="All subscriptions"
              current={chosen?.key ?? null}
              options={all.length > 1 ? all.map((s) => ({ value: s.key, label: s.name, colour: s.colour })) : []}
              href={(value) => href({ sub: value })}
            />
            <span className="spacer" />
            {metric !== "limits" ? (
              <Toggle
                label="Period"
                items={PERIODS.map((p) => ({ label: p.label, href: href({ period: p.days === 30 ? null : String(p.days) }), on: p.days === days }))}
              />
            ) : null}
            <Toggle
              label="Show"
              items={METRICS.map((m) => ({ label: m.label, href: href({ view: m.value === "limits" ? null : m.value }), on: m.value === metric }))}
            />
          </div>
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

// A row of links that narrows the page to one machine or one subscription; nothing when there's only one to choose.
function Filters({
  label,
  all,
  current,
  options,
  href,
}: {
  label: string;
  all: string;
  current: string | null;
  options: { value: string; label: string; colour?: number }[];
  href: (value: string | null) => string;
}) {
  if (!options.length) return null;
  return (
    <nav className="usage-filter" aria-label={label}>
      <Link href={href(null)} aria-current={current === null ? "true" : undefined}>
        <LinkPending />
        {all}
      </Link>
      {options.map((o) => (
        <Link key={o.value} href={href(o.value)} aria-current={current === o.value ? "true" : undefined}>
          <LinkPending />
          {o.colour !== undefined ? <span className={`swatch c${o.colour}`} aria-hidden="true" /> : null}
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

// Segmented links: the view or the window shown, the current one pressed in.
function Toggle({ label, items }: { label: string; items: { label: string; href: string; on: boolean }[] }) {
  return (
    <nav className="usage-toggle" aria-label={label}>
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
          The line in each bar is where even use would be by now; a dashed mark is where the factory&apos;s teams stop on that subscription, set on its
          machine with <code>a6g subscriptions limit</code>. Teams move to their next subscription at a limit, and wait when none is open.
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
  const series = ranked(usage.series, metric);
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
