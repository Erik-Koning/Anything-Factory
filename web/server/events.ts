// What happened on a team that someone may want to hear about, worked out from its graph's history (never stored):
// a question for the operator, a call the team made in their place and flagged, work that's blocked, a merge, a
// journey done, a request taken up or turned down, the team stopping or finishing. Pure: the notifier (notifier.ts)
// reads it, and the unit tests prove it. Each event has an id of its own, made from what it is and when, so it's
// emailed to a person once however often it's read.
import { type DecisionRecord, flagged } from "../../lib/tasks/decisions.ts";
import { MERGE, OPERATOR, type FeatureRequest, type Task } from "../../lib/tasks/model.ts";
import type { TeamState } from "../../lib/tasks/teams.ts";
import type { Ability } from "./access.ts";

export const EVENT_KINDS = ["question", "decided", "blocked", "journey", "team", "merged", "request"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// Who may hear of each kind: what they'd need to see it in the app.
export const AUDIENCE: Record<EventKind, Ability> = {
  question: "proposals:decide",
  // A call the team made in the operator's place and flagged: for those who review it.
  decided: "proposals:decide",
  blocked: "team:board",
  journey: "team:overview",
  team: "team:overview",
  merged: "team:board",
  // And only the request's sender (its stakeholder's account).
  request: "requests:send",
};

export interface TeamEvent {
  id: string;
  kind: EventKind;
  team: string;
  at: string;
  // One line for a subject or a digest, and a few for the body: the team's own words, clipped.
  title: string;
  detail: string;
  // The app's page for it (a path).
  path: string;
  // A request's sender, by stakeholder id: only they hear of it.
  to?: string | null;
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
// A move's reason, from its history line ("question → approved: why").
const reasonOf = (what: string): string => /^\S+ → \S+: (.+)$/s.exec(what)?.[1] ?? "";

// What an email says of something raised to the operator: why it's theirs and what the team recommends (the task's
// ask, or the move's reason from before asks), then the task.
function raisedDetail(t: Task, moved: string): string {
  const reason = t.ask?.reason.trim() || moved;
  const recommendation = t.ask?.recommendation.trim();
  return [reason ? `Why it's yours: ${reason}` : "", recommendation ? `The team recommends: ${recommendation}` : "", t.body].filter(Boolean).join("\n\n");
}

// What an email says of a call the team made for the operator: what it chose, what that follows from, and how it's
// undone, a paragraph each, as its record on the Decided for you page has them.
const decidedDetail = (d: DecisionRecord): string =>
  [`The team decided: ${clip(d.decision, 320)}`, `Because: ${clip(d.because, 240)}`, d.undo ? `To undo it: ${clip(d.undo, 140)}` : ""]
    .filter(Boolean)
    .join("\n\n");

// The events in `tasks`, `requests` and `decisions` from `since` (ISO) on, oldest first.
export function eventsOf(team: string, tasks: Task[], requests: FeatureRequest[], since: string, decisions: DecisionRecord[] = []): TeamEvent[] {
  const base = `/t/${team}`;
  const events: TeamEvent[] = [];
  // Decided in the operator's place, and flagged for them: once, when it's recorded.
  for (const d of decisions) {
    if (d.at < since || !flagged(d)) continue;
    events.push({
      id: `decided:${d.id}:${Date.parse(d.at)}`,
      kind: "decided",
      team,
      at: d.at,
      title: clip(d.question, 160),
      detail: decidedDetail(d),
      path: `${base}/decided#${d.id}`,
    });
  }
  for (const t of tasks) {
    for (const e of t.history) {
      if (e.at < since || (!e.to && !e.what.startsWith("raised to the operator:"))) continue;
      const stamp = Date.parse(e.at);
      if (t.kind === "journey") {
        if (e.to === "done")
          events.push({ id: `journey:${t.id}:${stamp}`, kind: "journey", team, at: e.at, title: `Journey done: ${t.title}`, detail: "", path: base });
        continue;
      }
      // The operator's own moves aren't news to them.
      // Raised to the operator: a question, a block with the team's reason and recommendation, or an ask added later.
      // The operator's own moves aren't news to them.
      const raised =
        e.to === "question" || (e.to === "blocked" && t.status === "blocked" && Boolean(t.ask)) || e.what.startsWith("raised to the operator:");
      if (raised && e.by !== OPERATOR)
        events.push({
          id: `question:${t.id}:${stamp}`,
          kind: "question",
          team,
          at: e.at,
          title: `#${t.id} ${t.title}`,
          detail: clip(raisedDetail(t, reasonOf(e.what) || e.what.replace(/^raised to the operator: /, "")), 700),
          path: `${base}/inbox#task-${t.id}`,
        });
      else if (e.to === "blocked" && e.by !== OPERATOR)
        events.push({
          id: `blocked:${t.id}:${stamp}`,
          kind: "blocked",
          team,
          at: e.at,
          title: `#${t.id} ${t.title}`,
          detail: clip(reasonOf(e.what) || "No reason given.", 400),
          path: `${base}/tasks/${t.id}`,
        });
      else if (e.to === "done" && e.by === MERGE)
        events.push({
          id: `merged:${t.id}:${stamp}`,
          kind: "merged",
          team,
          at: e.at,
          title: `#${t.id} ${t.title}`,
          detail: "",
          path: `${base}/tasks/${t.id}`,
        });
    }
  }
  for (const r of requests) {
    for (const e of r.history) {
      if (e.at < since || (e.to !== "promoted" && e.to !== "rejected")) continue;
      const rejected = e.to === "rejected";
      events.push({
        id: `request:${r.id}:${Date.parse(e.at)}`,
        kind: "request",
        team,
        at: e.at,
        title: `Your request "${clip(r.title, 120)}" was ${rejected ? "turned down" : "taken up"}`,
        detail: rejected ? clip(reasonOf(e.what), 400) : "The planner made it into work for the team; its page follows it until it's built.",
        path: `${base}/requests/${r.id}`,
        to: r.from,
      });
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

// The team stopping or finishing, from its reported state and the one the notifier saw last (null the first time,
// when nothing is news yet).
export function stateEvent(team: string, title: string, state: TeamState | null, last: string | null): TeamEvent | null {
  if (!state || last === null || state.state === last) return null;
  const said = state.state === "paused" ? "paused" : state.state === "complete" ? "reached its finish line" : null;
  if (!said) return null;
  return {
    id: `team:${team}:${state.state}:${Date.parse(state.at)}`,
    kind: "team",
    team,
    at: state.at,
    title: `${title} ${said}`,
    detail: state.state === "paused" ? (state.hold?.report ? clip(state.hold.report, 600) : "Nothing starts or merges until it's resumed.") : "",
    path: `/t/${team}`,
  };
}
