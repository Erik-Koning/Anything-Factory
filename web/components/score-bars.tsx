// A task's score drawn as bars, a row for each dimension: three steps filled to its 0–3, the figure, and what that
// figure means on that dimension (the anchors every scorer works to, lib/tasks/model.ts), so the case reads at a glance
// without knowing the scale. Every dimension counts for the work (risk is risk it removes), so longer is always more.
import { DIMENSIONS, type Score, SCORE_ANCHORS } from "../../lib/tasks/model.ts";

const STEPS = [1, 2, 3] as const;

export function ScoreBars({ score }: { score: Score }) {
  return (
    <ul className="score-bars" aria-label="Score by dimension, 0 to 3">
      {DIMENSIONS.map((d) => {
        const n = Math.min(3, Math.max(0, Math.round(score[d] ?? 0)));
        return (
          <li key={d}>
            <span className="name">{d}</span>
            <span className="steps" aria-hidden="true">
              {STEPS.map((step) => (
                <i key={step} className={step <= n ? "on" : undefined} />
              ))}
            </span>
            <b>
              {n}
              <span className="sr"> of 3:</span>
            </b>
            <span className="means">{SCORE_ANCHORS[d][n]}</span>
          </li>
        );
      })}
    </ul>
  );
}
