import type { ReactNode } from "react";
import { Tabs } from "../../../components/tabs.tsx";
import { type SwitchTo, TeamSwitcher } from "../../../components/team-switcher.tsx";
import { Chip } from "../../../components/ui.tsx";
import { can, roleIn, type Viewer } from "../../../server/access.ts";
import { allTeams } from "../../../server/factory.ts";
import { teamFor } from "./team.ts";

// A team's pages, by what the person may do there: the first part of the path after /t/<team>, and what opens it.
// Adding a task has no tab: the board's button opens it.
const SECTIONS: [string, (viewer: Viewer, team: string) => boolean][] = [
  ["", () => true],
  ["board", (v, t) => can(v, "team:board", t)],
  ["requests", () => true],
  ["add", (v, t) => can(v, "tasks:add", t) || can(v, "tasks:suggest", t)],
  ["proposals", (v, t) => can(v, "proposals:decide", t)],
];
const sectionsFor = (viewer: Viewer, team: string): string[] => SECTIONS.filter(([, open]) => open(viewer, team)).map(([s]) => s);

export default async function TeamLayout({ children, params }: { children: ReactNode; params: Promise<{ team: string }> }) {
  const { team: name } = await params;
  const { viewer, team, role } = await teamFor(name);
  const base = `/t/${team.name}`;
  const open = sectionsFor(viewer, team.name);
  const switchTo: SwitchTo[] = (await allTeams())
    .filter((t) => roleIn(viewer, t.name) !== null)
    .map((t) => ({ name: t.name, title: t.title, state: t.status?.state ?? "no status yet", sections: sectionsFor(viewer, t.name) }));
  const LABELS: Record<string, string> = {
    "": "Overview",
    board: "Board",
    requests: "Requests",
    proposals: "Decisions",
  };
  return (
    <>
      <div className="head">
        <h1>{team.title || team.name}</h1>
        <Chip>{team.status?.state ?? "no status yet"}</Chip>
        <span className="muted small">you: {role}</span>
        <TeamSwitcher current={team.name} teams={switchTo} />
      </div>
      <Tabs
        links={open
          .filter((s) => s !== "add")
          .map((s) => ({
            href: s ? `${base}/${s}` : base,
            label: LABELS[s] ?? s,
            exact: s === "",
            // A task's page and adding one are the board's.
            also: s === "board" ? [`${base}/tasks`, `${base}/add`] : [],
          }))}
      />
      {children}
    </>
  );
}
