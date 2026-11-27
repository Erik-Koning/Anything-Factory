// How the Subscriptions page writes its figures, on the server and in the browser alike: dollars to the cent, tokens
// in K, M and B, shares to a tenth of a percent, and how long until a window resets.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const formatUsd = (dollars: number): string => usd.format(dollars);
export const formatCount = (n: number): string => count.format(n);
// A subscription's names in a6g, as a sentence says them: "default", "default and refdocs".
const names = new Intl.ListFormat("en-US", { type: "conjunction" });
export const formatNames = (list: readonly string[]): string => names.format(list);

// 999 as it is; above that in K, M, B or T with the unit chosen after rounding (999,999 is "1M"), three figures at most,
// and no trailing zeros: "250K", "12.5K", "1.25M".
const UNITS = ["", "K", "M", "B", "T"] as const;
export function formatTokens(n: number): string {
  if (Math.abs(n) < 1000) return formatCount(Math.round(n));
  let unit = Math.min(UNITS.length - 1, Math.floor(Math.log10(Math.abs(n)) / 3));
  const digits = (v: number) => (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
  let value = n / 1000 ** unit;
  let shown = Number(value.toFixed(digits(value)));
  if (Math.abs(shown) >= 1000 && unit < UNITS.length - 1) {
    unit += 1;
    value = n / 1000 ** unit;
    shown = Number(value.toFixed(digits(value)));
  }
  return `${shown}${UNITS[unit]}`;
}

// A share of 1 as a percent to a tenth; one too small to show is "<0.1%".
export function formatPercent(share: number): string {
  if (share > 0 && share < 0.001) return "<0.1%";
  return `${Number((share * 100).toFixed(1))}%`;
}

// How long until `resetsAt`: "resets in 2d 4h", "in 3h 12m", "in 40m"; "resets momentarily" under a minute, and "resets
// now" once it's past.
export function resetsIn(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (ms <= 0) return "resets now";
  if (ms < 60_000) return "resets momentarily";
  return `resets in ${span(ms)}`;
}
export function span(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

// A day ("2026-11-15") as "Nov 15", and a UTC hour ("2026-11-15T14") as its hour in `timeZone`: "3 PM".
const dayShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const formatDay = (day: string): string => dayShort.format(new Date(`${day}T12:00:00Z`));
export const hourStart = (hour: string): Date => new Date(`${hour}:00:00Z`);
export function formatHour(hour: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone }).format(hourStart(hour));
}
// An hour as a tooltip names it: "3 PM today", "3 PM yesterday", "Nov 12, 3 PM".
export function hourLabel(hour: string, timeZone: string, now: number): string {
  const day = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const at = hourStart(hour);
  const time = formatHour(hour, timeZone);
  if (day(at) === day(new Date(now))) return `${time} today`;
  if (day(at) === day(new Date(now - 86_400_000))) return `${time} yesterday`;
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(at)}, ${time}`;
}
