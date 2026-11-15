// A total split by kind: one thin bar, a part for each kind as wide as its share (at least a sliver), its figure and share
// on pointing or focus, and a legend below. Kinds with nothing in them aren't drawn.
import type { Segment } from "../../server/usage-view.ts";
import { formatPercent } from "./format.ts";

export function ShareBar({ title, segments, format, aside }: { title: string; segments: Segment[]; format: (n: number) => string; aside?: string }) {
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((n, s) => n + s.value, 0);
  if (!total) return null;
  return (
    <div className="share">
      <div className="share-head">
        <h3>{title}</h3>
        {aside ? <span className="small muted fig">{aside}</span> : null}
      </div>
      <div className="share-bar" role="list" aria-label={title}>
        {shown.map((s) => (
          <span
            key={s.key}
            role="listitem"
            tabIndex={0}
            className={`share-part k-${s.key}`}
            style={{ flexGrow: s.value }}
            aria-label={`${s.label}: ${format(s.value)}, ${formatPercent(s.value / total)}`}
          >
            <span className="share-tip" aria-hidden="true">
              {s.label} · <b>{format(s.value)}</b> · {formatPercent(s.value / total)}
            </span>
          </span>
        ))}
      </div>
      <ul className="share-legend" aria-hidden="true">
        {shown.map((s) => (
          <li key={s.key}>
            <span className={`swatch k-${s.key}`} />
            {s.label} <span className="fig">{format(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
