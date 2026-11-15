"use client";
// The models used in the window, biggest first by what's shown (cost or tokens): each one's share, with a bar against
// the biggest, and a row that opens the model's own figures: what it cost per million tokens, how much of its prompts came
// from the cache, its use over the window by subscription, and what its tokens and dollars went on.
import { useRef, useState } from "react";
import { cacheHit, costSegments, perMillion, processed, speedSegments, tokenSegments, type Totals } from "../../server/usage-view.ts";
import { formatPercent, formatTokens, formatUsd } from "./format.ts";
import { ShareBar } from "./share-bar.tsx";
import { TrendChart, type TrendSeries } from "./trend-chart.tsx";

export interface ModelRow {
  model: string;
  totals: Totals;
  // Its use over the window, a line per subscription, in dollars (or tokens when none of it has a price).
  series: TrendSeries[];
  seriesIn: "cost" | "tokens";
}

export function ModelTable({
  rows,
  metric,
  periods,
  hourly,
  now,
}: {
  rows: ModelRow[];
  metric: "cost" | "tokens";
  periods: string[];
  hourly: boolean;
  now: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState<ModelRow | null>(null);
  const value = (t: Totals) => (metric === "cost" ? t.cost : processed(t));
  const peak = Math.max(0, ...rows.map((r) => value(r.totals)));
  const sum = rows.reduce((n, r) => n + value(r.totals), 0);
  const allCost = rows.reduce((n, r) => n + r.totals.cost, 0);
  const show = (row: ModelRow) => {
    setOpen(row);
    dialog.current?.showModal();
  };
  const unpricedOnly = (t: Totals) => t.cost === 0 && t.unpriced > 0;
  if (!rows.length) return <p className="empty">Nothing used in this window.</p>;
  return (
    <>
      <table className="figures models">
        <thead>
          <tr>
            <th scope="col" className="rank">
              #
            </th>
            <th scope="col">Model</th>
            <th scope="col" className="fig">
              Cost
            </th>
            <th scope="col" className="fig share-col">
              Share
            </th>
            <th scope="col" className="fig">
              Tokens
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const v = value(row.totals);
            return (
              <tr key={row.model}>
                <td className="rank fig">{i + 1}</td>
                <td>
                  <button type="button" className="linkish model-open code" onClick={() => show(row)} aria-haspopup="dialog">
                    {row.model}
                  </button>
                </td>
                <td className="fig">{unpricedOnly(row.totals) ? <span className="muted">Unpriced</span> : formatUsd(row.totals.cost)}</td>
                <td className="fig share-col">
                  {metric === "cost" && unpricedOnly(row.totals) ? null : (
                    <span className="share-cell">
                      <span className="mini-bar" aria-hidden="true">
                        <span style={{ width: `max(3px, ${peak ? (v / peak) * 100 : 0}%)` }} />
                      </span>
                      {sum ? formatPercent(v / sum) : ""}
                    </span>
                  )}
                </td>
                <td className="fig">{formatTokens(processed(row.totals))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <dialog ref={dialog} className="model-dialog" aria-labelledby="model-dialog-title" onClose={() => setOpen(null)}>
        {open ? (
          <>
            <div className="dialog-head">
              <div>
                <h2 id="model-dialog-title" className="code">
                  {open.model}
                </h2>
                <p className="small muted">
                  {allCost > 0 && open.totals.cost > 0 ? `${formatPercent(open.totals.cost / allCost)} of the cost` : "No price known for it"}
                </p>
              </div>
              <form method="dialog">
                <button type="submit" className="button" aria-label="Close">
                  Close
                </button>
              </form>
            </div>
            <ul className="usage-stats">
              <li>
                <span>Cost</span>
                <b className="fig">{unpricedOnly(open.totals) ? "Unpriced" : formatUsd(open.totals.cost)}</b>
              </li>
              <li>
                <span>Tokens</span>
                <b className="fig">{formatTokens(processed(open.totals))}</b>
              </li>
              {perMillion(open.totals) !== null ? (
                <li>
                  <span>Per 1M tokens</span>
                  <b className="fig">{formatUsd(perMillion(open.totals) ?? 0)}</b>
                </li>
              ) : null}
              {cacheHit(open.totals) !== null ? (
                <li>
                  <span>Cache hit</span>
                  <b className="fig">{formatPercent(cacheHit(open.totals) ?? 0)}</b>
                </li>
              ) : null}
            </ul>
            <TrendChart
              periods={periods}
              hourly={hourly}
              series={open.series}
              metric={open.seriesIn}
              now={now}
              label={`${open.model}: ${open.seriesIn === "cost" ? "cost" : "processed tokens"} each ${hourly ? "hour" : "day"}`}
            />
            <ShareBar title="Cost by type" segments={costSegments(open.totals)} format={formatUsd} />
            <ShareBar title="Tokens by type" segments={tokenSegments(open.totals)} format={formatTokens} />
            {open.totals.fast > 0 ? (
              <ShareBar title="Cost by speed" segments={speedSegments(open.totals)} format={formatUsd} aside={`Premium ${formatUsd(open.totals.fast)}`} />
            ) : null}
            {open.totals.unpriced ? (
              <p className="small muted">
                {open.totals.unpriced} {open.totals.unpriced === 1 ? "request" : "requests"} on it had no known price, so{" "}
                {open.totals.unpriced === 1 ? "it isn't" : "they aren't"} in the cost. The factory&apos;s price list is <code>lib/prices.ts</code>.
              </p>
            ) : null}
          </>
        ) : null}
      </dialog>
    </>
  );
}
