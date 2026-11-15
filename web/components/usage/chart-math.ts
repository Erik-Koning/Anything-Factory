// The trend chart's arithmetic (trend-chart.tsx): its scale, and the curve through its points.

// A scale from 0 past `peak` in `steps` steps of 1, 2, 5 or 10 times a power of ten.
export function niceScale(peak: number, steps = 4): { top: number; ticks: number[] } {
  if (!(peak > 0)) return { top: 1, ticks: [0, 0.25, 0.5, 0.75, 1].slice(0, steps + 1) };
  const raw = peak / steps;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  return { top: step * steps, ticks: Array.from({ length: steps + 1 }, (_, i) => step * i) };
}

// A monotone cubic through the points (Fritsch–Carlson): smooth, and never above or below the figures it joins.
export function monotonePath(points: [number, number][]): string {
  const n = points.length;
  if (!n) return "";
  if (n === 1) return `M${points[0]?.[0]},${points[0]?.[1]}`;
  const x = points.map((p) => p[0]);
  const y = points.map((p) => p[1]);
  const d = x.slice(1).map((xi, i) => ((y[i + 1] ?? 0) - (y[i] ?? 0)) / (xi - (x[i] ?? 0)));
  const m = y.map((_, i) => (i === 0 ? (d[0] ?? 0) : i === n - 1 ? (d[n - 2] ?? 0) : ((d[i - 1] ?? 0) + (d[i] ?? 0)) / 2));
  for (let i = 0; i < n - 1; i++) {
    const di = d[i] ?? 0;
    if (di === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] ?? 0) / di;
    const b = (m[i + 1] ?? 0) / di;
    if (a < 0) m[i] = 0;
    if (b < 0) m[i + 1] = 0;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * di;
      m[i + 1] = t * b * di;
    }
  }
  let path = `M${x[0]},${y[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (x[i + 1] ?? 0) - (x[i] ?? 0);
    path += ` C${(x[i] ?? 0) + h / 3},${(y[i] ?? 0) + ((m[i] ?? 0) * h) / 3} ${(x[i + 1] ?? 0) - h / 3},${(y[i + 1] ?? 0) - ((m[i + 1] ?? 0) * h) / 3} ${x[i + 1]},${y[i + 1]}`;
  }
  return path;
}
