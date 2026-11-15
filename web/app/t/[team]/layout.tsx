import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Tabs } from "../../../components/tabs.tsx";
import { type SwitchTo, TeamSwitcher } from "../../../components/team-switcher.tsx";
import Link from "next/link";
import { Ago, Chip, QuietMark } from "../../../components/ui.tsx";
import { can, roleIn, TEAM_PARAM, type Viewer } from "../../../server/access.ts";
import { allTeams, retiredOf } from "../../../server/factory.ts";
import { waitingCount } from "../../../server/inbox.ts";
import { offSite, quietSince } from "../../../server/views.ts";
import { toReview } from "../../../../lib/tasks/decisions.ts";
import { controlsFor, decisionsFor, tasksOf, teamFor } from "./team.ts";

// A team's pages, by what the person may do there: the first part of the path after /t/<team>, and what opens it.
// Adding a task has no tab: the board's button opens it.
const SECTIONS: [string, (viewer: Viewer, team: string) => boolean][] = [
  ["", () => true],
  ["inbox", (v, t) => can(v, "proposals:decide", t)],
  ["board", (v, t) => can(v, "team:board", t)],
  ["graph", (v, t) => can(v, "team:board", t)],
  ["requests", () => true],
  ["add", (v, t) => can(v, "tasks:add", t) || can(v, "tasks:suggest", t)],
  ["proposals", (v, t) => can(v, "proposals:decide", t)],
  ["decided", (v, t) => can(v, "decisions:read", t)],
  ["agreement", (v, t) => can(v, "team:control", t)],
];
const sectionsFor = (viewer: Viewer, team: string): string[] => SECTIONS.filter(([, open]) => open(viewer, team)).map(([s]) => s);

export default async function TeamLayout({ children, params }: { children: ReactNode; params: Promise<{ team: string }> }) {
  const { team: name } = await params;
  // What this layout and most of the team's pages read, started beside the session and the team's settings rather than
  // after them (each is read once per request); none of it is shown before teamFor says the person may see the team.
  const reads = TEAM_PARAM.test(name) ? Promise.all([tasksOf(name), decisionsFor(name), controlsFor(name), allTeams()]) : null;
  // Awaited below, unless teamFor turns the person away first.
  reads?.catch(() => {});
  const { viewer, team, role } = await teamFor(name);
  // teamFor turns away a name that isn't a team's, so the reads were started.
  const [tasks, decisions, controls, teams] = (await reads) ?? notFound();
  const base = `/t/${team.name}`;
  const open = sectionsFor(viewer, team.name);
  const waiting = open.includes("inbox") ? waitingCount(tasks) : 0;
  // What the team decided and flagged, for those who review it: how many they haven't yet.
  const reviews = can(viewer, "proposals:decide", team.name);
  const unreviewed = reviews && open.includes("decided") ? toReview(decisions, controls).length : 0;
  // Off the site: its pages still open from a link, and say so (components/site-panel.tsx puts it back).
  const retired = offSite(team, retiredOf(controls));
  const quiet = retired ? null : quietSince(team);
  const switchTo: SwitchTo[] = teams
    .filter((t) => roleIn(viewer, t.name) !== null)
    .map((t) => ({ name: t.name, title: t.title, state: t.status?.state ?? "no status yet", sections: sectionsFor(viewer, t.name) }));
  const LABELS: Record<string, string> = {
    "": "Overview",
    inbox: "Waiting on you",
    board: "Board",
    graph: "Graph",
    requests: "Requests",
    proposals: "Decisions",
    // Decided for the operator: whoever reviews it reads "for you"; a member reads the same log.
    decided: reviews ? "Decided for you" : "Decision log",
    agreement: "Agreement",
  };
  return (
    <>
      <div className="head team-head">
        <h1>{team.title || team.name}</h1>
        <Chip>{team.status?.state ?? "no status yet"}</Chip>
        {quiet ? <QuietMark last={quiet.last} /> : null}
        <span className="muted small">you: {role}</span>
        <TeamSwitcher current={team.name} teams={switchTo} />
      </div>
      {retired ? (
        <p className="notice attention off-site">
          <span>
            <b>Taken off the site</b> <Ago at={retired.at} />. It isn&apos;t on Teams or in Waiting on you, and nobody is emailed about it.
          </span>
          {can(viewer, "team:retire", team.name) ? (
            <Link className="button" href={`${base}#site`}>
              Put it back
            </Link>
          ) : null}
        </p>
      ) : null}
      <Tabs
        links={open
          .filter((s) => s !== "add")
          .map((s) => ({
            href: s ? `${base}/${s}` : base,
            label: LABELS[s] ?? s,
            exact: s === "",
            count: s === "inbox" ? waiting : s === "decided" ? unreviewed : 0,
            // A task's page and adding one are the board's.
            also: s === "board" ? [`${base}/tasks`, `${base}/add`] : [],
          }))}
      />
      {children}
    </>
  );
}
