// The team a page under /t/<team> is about, for someone who may see it; otherwise not found (whether it exists or
// not, so nobody learns of teams they don't follow).
import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { roleIn, TEAM_PARAM, type TeamRole } from "../../../server/access.ts";
import { controlsFor, decisionsFor, tasksFor, teamDoc, type TeamDoc } from "../../../server/factory.ts";
import { type Person, requireViewer } from "../../../server/viewer.ts";

// The team's settings are read beside the session, not after it, and shown only once the person may see them.
export const teamFor = cache(async (name: string): Promise<{ viewer: Person; team: TeamDoc; role: "admin" | TeamRole }> => {
  if (!TEAM_PARAM.test(name)) {
    await requireViewer();
    notFound();
  }
  const [viewer, team] = await Promise.all([requireViewer(), teamDoc(name)]);
  const role = roleIn(viewer, name);
  if (!role) notFound();
  if (!team) notFound();
  return { viewer, team, role };
});

// A team's tasks, the operator's controls (their reviews and agreements among them) and what the team decided for the
// operator, read once per request: the layout's tab counts and the page share them.
export { controlsFor, decisionsFor, tasksFor as tasksOf } from "../../../server/factory.ts";

// What a page shows of the team, started beside the session and the team's settings rather than after them (on a click
// from one of the team's pages to another the layout isn't rendered again, so its reads don't start them): the tasks,
// and its decisions or controls as asked. Each is still read once per request, and none of it is shown before teamFor
// says the person may see the team.
export function readAhead(name: string, ...also: ("decisions" | "controls")[]): void {
  if (!TEAM_PARAM.test(name)) return;
  tasksFor(name).catch(() => {});
  if (also.includes("decisions")) decisionsFor(name).catch(() => {});
  if (also.includes("controls")) controlsFor(name).catch(() => {});
}
