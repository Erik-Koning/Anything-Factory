// The asks to start a team (lib/tasks/start.ts) as the pages show them: each one's newest ask and where the machine it
// names has got with it. An ask is a control under the new team's name, by the admin who made it; the machine answers
// with one control per step. The page that asks is app/new; the Teams page shows them until the team has published its
// settings, and for a fortnight after one stopped, so its reason can be read.
import { type Control, startOf, type StartState } from "../../lib/tasks/controls.ts";
import { START_TEAM, startEnded } from "../../lib/tasks/start.ts";
import { graphDb } from "./db.ts";
import type { Machine } from "./machines.ts";

export interface Start extends StartState {
  team: string;
}

// How long one that ended (or was dropped) stays on the Teams page, and how many may be open on one person's machines.
export const SHOWN_DAYS = 14;
export const OPEN_STARTS = 3;
export const STARTS_A_DAY = 10;

const numbered = (id: string): number => Number(/^k(\d+)$/.exec(id)?.[1] ?? 0);

// Every ask that still says something: under way, waiting, or ended within SHOWN_DAYS. `published` are the teams
// that have their own card by now; one of those that started is left to it. Newest first.
export async function starts(published: ReadonlySet<string>, now = Date.now()): Promise<Start[]> {
  const rows = await graphDb()
    .collection("controls")
    .find({ kind: { $in: ["start", "starting"] } })
    .toArray();
  const byTeam = new Map<string, Control[]>();
  for (const { _id: _ignored, ...doc } of rows) {
    const control = doc as unknown as Control;
    if (!START_TEAM.test(control.team)) continue;
    byTeam.set(control.team, [...(byTeam.get(control.team) ?? []), control]);
  }
  const found: Start[] = [];
  for (const [team, controls] of byTeam) {
    const state = startOf(
      controls.sort((a, b) => numbered(a.id) - numbered(b.id)),
      now
    );
    if (!state) continue;
    if (state.step === "started" && published.has(team)) continue;
    const over = state.step === "expired" || startEnded(state.step);
    if (over && now - Date.parse(state.at) > SHOWN_DAYS * 86_400_000) continue;
    found.push({ ...state, team });
  }
  return found.sort((a, b) => b.asked.localeCompare(a.asked));
}

// Whether an ask is still open: waiting for its machine, or being carried out.
export const startOpen = (start: Pick<Start, "step">): boolean => start.step !== "expired" && !startEnded(start.step);

// The machines of `userId`'s that start projects: linked to their own account, and offering to (their operator said so
// at the machine's terminal, and its last report still says it).
export const startingMachines = (machines: readonly Machine[], userId: string): Machine[] =>
  machines.filter((machine) => machine.userId === userId && machine.projects !== null);

// The one team's ask, with where it stands; null when there's none, or it was withdrawn.
export async function startFor(team: string, now = Date.now()): Promise<Start | null> {
  if (!START_TEAM.test(team)) return null;
  const rows = await graphDb()
    .collection("controls")
    .find({ team, kind: { $in: ["start", "starting"] } })
    .toArray();
  const controls = rows.map(({ _id: _ignored, ...doc }) => doc as unknown as Control).sort((a, b) => numbered(a.id) - numbered(b.id));
  const state = startOf(controls, now);
  return state ? { ...state, team } : null;
}
