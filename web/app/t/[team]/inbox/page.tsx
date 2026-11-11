import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TeamInbox } from "../../../../components/inbox.tsx";
import { Notice, type SearchParams } from "../../../../components/ui.tsx";
import { can } from "../../../../server/access.ts";
import { inbox } from "../../../../server/inbox.ts";
import { tasksOf, teamFor } from "../team.ts";

export const metadata: Metadata = { title: "Waiting on you" };

// What waits on the operator on this team: questions to answer, blocked work, and what the planner has yet to act on.
export default async function TeamInboxPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  if (!can(viewer, "proposals:decide", team.name)) notFound();
  const tasks = await tasksOf(team.name);
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  return (
    <>
      <Notice searchParams={searchParams} />
      <p className="lede small">
        You answer as the operator. The planner gets each answer within a minute, records it in its decisions and moves the task on. Proposals to approve
        are on <Link href={`/t/${team.name}/proposals`}>Decisions</Link>; how you hear about new ones is in{" "}
        <Link href="/account/notifications">Notifications</Link>.
      </p>
      <TeamInbox team={team.name} box={inbox(tasks)} back={`/t/${team.name}/inbox`} titles={titles} agreement={can(viewer, "team:control", team.name)} />
    </>
  );
}
