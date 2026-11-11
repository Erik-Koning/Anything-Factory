// The operator's reviews of what the team decided for them (lib/tasks/decisions.ts), applied by the lead's watchdog
// each run, and by a6g at once: each review control is written onto its decision's record, once, and the decisions
// they overturned go to the planner in one message. Marked in the run folder beside the other controls (lib/holds.ts),
// so a review is applied once whatever order they reach the store in. A record already written but never told (the
// store answered, T3 Code didn't) isn't lost: the planner's context names every overturned decision it hasn't noted.
import { applied, markApplied, type Tell, whoAsked } from "./holds.ts";
import type { Control } from "./tasks/controls.ts";
import { applyReview, type DecisionRecord, overturnedMessage } from "./tasks/decisions.ts";
import type { Store } from "./tasks/store.ts";

export async function applyReviews(run: string, store: Store, controls: Control[]): Promise<{ log: string[]; tell: Tell[] }> {
  const done = applied(run);
  const fresh = controls.filter((c) => c.kind === "review" && !done(c.id));
  const log: string[] = [];
  const overturned: DecisionRecord[] = [];
  const now: string[] = [];
  for (const control of fresh) {
    let result: Awaited<ReturnType<typeof applyReview>>;
    try {
      result = await applyReview(store, control);
    } catch (error) {
      // Left unmarked, for the next run; the ones written this run are still marked and told.
      log.push(`couldn't write a review (${control.id}) onto ${control.review?.decision ?? "its decision"}: ${(error as Error).message.split("\n")[0]}`);
      continue;
    }
    now.push(control.id);
    if (!result) {
      log.push(`a review (${control.id}) names a decision that isn't there (${control.review?.decision ?? "none"}): left`);
      continue;
    }
    if (!result.applied) continue;
    const verdict = result.record.review?.verdict;
    log.push(`${whoAsked(control.by)} ${verdict === "overturned" ? "overturned" : "agreed with"} ${result.record.id}`);
    if (verdict === "overturned") overturned.push(result.record);
  }
  if (now.length) markApplied(run, now);
  // It asks for work, so a paused team's planner hears once it's resumed.
  return { log, tell: overturned.length ? [{ text: overturnedMessage(overturned), wake: true, keep: true }] : [] };
}
