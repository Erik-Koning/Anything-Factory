"use client";
// A subscription's usage over the window, one smoothed line and a faint area each, drawn over one another rather than
// stacked (as T3 Code draws them): the scale is the busiest one's, in four clean steps. Pointing at the chart, or
// moving along it with the arrow keys once it has focus, shows each one's figure for that hour or day and their total.
// A table with the same figures is there for a screen reader.
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { monotonePath, niceScale } from "./chart-math.ts";
import { formatDay, formatHour, formatTokens, formatUsd, hourLabel } from "./format.ts";

export interface TrendSeries {
  name: string;
  colour: number;
  values: number[];
}

const W = 960;
const H = 260;

export function TrendChart({
  periods,
  hourly,
  series,
  metric,
  now,
  label,
}: {
  periods: string[];
  hourly: boolean;
  series: TrendSeries[];
  metric: "cost" | "tokens";
  now: number;
  label: string;
}) {
  const id = useId();
  const plot = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<number | null>(null);
  // Hours are written in the browser's own zone, once it's known (the server's is UTC).
  const [zone, setZone] = useState("UTC");
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  const format = metric === "cost" ? formatUsd : formatTokens;
  const shown = series.filter((s) => s.values.some((v) => v > 0));
  const peak = Math.max(0, ...shown.flatMap((s) => s.values));
  const { top, ticks } = niceScale(peak);
  const n = periods.length;
  const xOf = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const yOf = (v: number) => H - (v / top) * H;
  // The busiest drawn first, so the quieter ones lie on top of it.
  const total = (s: TrendSeries) => s.values.reduce((a, b) => a + b, 0);
  const drawn = [...shown].sort((a, b) => total(b) - total(a));
  const periodName = (i: number) => {
    const p = periods[i] ?? "";
    return hourly ? hourLabel(p, zone, now) : formatDay(p);
  };
  const axisName = (i: number) => {
    const p = periods[i] ?? "";
    return (hourly ? formatHour(p, zone) : formatDay(p)).toUpperCase();
  };
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const box = plot.current?.getBoundingClientRect();
    if (!box || !n) return;
    setAt(Math.round(clampTo(((e.clientX - box.left) / box.width) * (n - 1), 0, n - 1)));
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n }[e.key];
    if (step === undefined || !n) return;
    e.preventDefault();
    setAt((was) => clampTo((was ?? (step > 0 ? -1 : n)) + step, 0, n - 1));
  };
  const tip = at === null ? null : { left: `${(xOf(at) / W) * 100}%`, rows: shown.map((s) => ({ s, v: s.values[at] ?? 0 })) };
  return (
    <figure className="trend" aria-labelledby={`${id}-cap`}>
      <figcaption id={`${id}-cap`} className="sr">
        {label}
      </figcaption>
      <div className="trend-body">
        <div className="trend-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>
              {t === 0 ? "0" : format(t)}
            </span>
          ))}
        </div>
        <div
          className="trend-plot"
          ref={plot}
          tabIndex={0}
          role="group"
          aria-roledescription="chart"
          aria-label={`${label}: use the left and right arrow keys to read each ${hourly ? "hour" : "day"}`}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setAt(null)}
          onKeyDown={keys}
          onBlur={() => setAt(null)}
        >
          {ticks.map((t) => (
            <span key={t} className="trend-grid" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden="true" />
          ))}
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {drawn.map((s) => {
              const points = s.values.map((v, i): [number, number] => [xOf(i), yOf(v)]);
              const line = monotonePath(points);
              return (
                <g key={s.name} className={`series c${s.colour}`}>
                  <path className="area" d={`${line} L${xOf(n - 1)},${H} L${xOf(0)},${H} Z`} />
                  <path className="line" d={line} />
                </g>
              );
            })}
            {at !== null ? <line className="cursor" x1={xOf(at)} x2={xOf(at)} y1={0} y2={H} /> : null}
          </svg>
          {at !== null
            ? shown.map((s) => (
                <span
                  key={s.name}
                  className={`trend-dot c${s.colour}`}
                  style={{ left: `${(xOf(at) / W) * 100}%`, bottom: `${((s.values[at] ?? 0) / top) * 100}%` }}
                  aria-hidden="true"
                />
              ))
            : null}
          {tip ? (
            <div className={`trend-tip${at !== null && at > n / 2 ? " left" : ""}`} style={{ left: tip.left }} aria-live="polite">
              <b>{periodName(at ?? 0)}</b>
              <ul>
                {tip.rows.map(({ s, v }) => (
                  <li key={s.name}>
                    <span className={`swatch c${s.colour}`} aria-hidden="true" />
                    <span>{s.name}</span>
                    <span className="fig">{format(v)}</span>
                  </li>
                ))}
              </ul>
              {tip.rows.length > 1 ? (
                <p>
                  <span>Total</span>
                  <span className="fig">{format(tip.rows.reduce((sum, r) => sum + r.v, 0))}</span>
                </p>
              ) : null}
            </div>
          ) : null}
          {!shown.length ? <p className="trend-empty">Nothing used in this window.</p> : null}
        </div>
      </div>
      <div className="trend-x" aria-hidden="true">
        {n ? (
          <>
            <span>{axisName(0)}</span>
            {n > 2 ? <span>{axisName(Math.floor((n - 1) / 2))}</span> : null}
            {n > 1 ? <span>{axisName(n - 1)}</span> : null}
          </>
        ) : null}
      </div>
      <table className="sr">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{hourly ? "Hour" : "Day"}</th>
            {shown.map((s) => (
              <th scope="col" key={s.name}>
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p, i) => (
            <tr key={p}>
              <th scope="row">{periodName(i)}</th>
              {shown.map((s) => (
                <td key={s.name}>{format(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

const clampTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
