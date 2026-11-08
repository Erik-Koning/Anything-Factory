import type { Metadata } from "next";
import Link from "next/link";
import { type MachineTeam, online } from "../../../lib/fleet.ts";
import { SubmitButton } from "../../components/submit-button.tsx";
import { Ago, Chip, Notice, type SearchParams } from "../../components/ui.tsx";
import { can, roleIn, type Viewer, visibleMachines } from "../../server/access.ts";
import { linkedMachines, type Machine, ownersOf } from "../../server/machines.ts";
import { requireViewer } from "../../server/viewer.ts";
import { unlinkMachineAction } from "./actions.ts";

export const metadata: Metadata = { title: "Machines" };

export default async function MachinesPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  const everyone = can(viewer, "machines:all");
  const now = Date.now();
  // Those reporting first, then by name.
  const machines = visibleMachines(viewer, await linkedMachines()).sort(
    (a, b) => Number(online(b, now)) - Number(online(a, now)) || a.name.localeCompare(b.name)
  );
  const owners = everyone ? await ownersOf(machines) : null;
  return (
    <>
      <h1>Machines</h1>
      <p className="lede">
        {everyone ? "Every machine linked to an account here, whose it is, and the teams each runs." : "Your machines, and the teams each runs."} A linked
        machine reports every five minutes while its watchdog runs.
      </p>
      <Notice searchParams={searchParams} />
      {machines.length ? (
        <ul className="cards">
          {machines.map((machine) => (
            <MachineCard
              key={machine.id}
              machine={machine}
              viewer={viewer}
              owner={owners ? (owners.get(machine.userId)?.email ?? "a removed account") : null}
              up={online(machine, now)}
            />
          ))}
        </ul>
      ) : (
        <p className="panel empty">{everyone ? "No machine is linked yet." : "None of your machines is linked yet."}</p>
      )}
      <p className="hint">
        To link one, run <code>a6g connect app</code> on it: it shows a code and opens <Link href="/machines/link">the page to approve it on</Link>.
      </p>
    </>
  );
}

function MachineCard({ machine, viewer, owner, up }: { machine: Machine; viewer: Viewer; owner: string | null; up: boolean }) {
  return (
    <li>
      <div className="head">
        <h2 className="title">{machine.name}</h2>
        <Chip tone={up ? "ok" : "caution"}>{up ? "reporting" : machine.at ? "not reporting" : "no report yet"}</Chip>
      </div>
      <dl className="facts small">
        {owner !== null ? (
          <>
            <dt>Owner</dt>
            <dd>{owner}</dd>
          </>
        ) : null}
        <dt>Last report</dt>
        <dd>
          <Ago at={machine.at} />
          {machine.lastIp ? ` from ${machine.lastIp}` : ""}
        </dd>
        <dt>Linked</dt>
        <dd>
          <Ago at={machine.linkedAt} />
        </dd>
        {machine.factory ? (
          <>
            <dt>Factory</dt>
            <dd>{machine.factory}</dd>
          </>
        ) : null}
      </dl>
      <h3 className="small">{up ? "Teams" : "Teams, at its last report"}</h3>
      {machine.teams.length ? (
        <ul className="plain rows small">
          {machine.teams.map((team) => (
            <TeamRow key={team.name} team={team} viewer={viewer} />
          ))}
        </ul>
      ) : (
        <p className="empty small">{machine.at ? "No team is registered on it." : "It hasn't reported yet."}</p>
      )}
      <form action={unlinkMachineAction}>
        <input type="hidden" name="id" value={machine.id} />
        <SubmitButton className="linkish">{`Unlink ${machine.name}`}</SubmitButton>
      </form>
    </li>
  );
}

function TeamRow({ team, viewer }: { team: MachineTeam; viewer: Viewer }) {
  const atWork = Object.entries(team.members).filter(([, n]) => n > 0);
  // Only a team whose tasks are in Mongo has pages here, and only for those who see it.
  const linked = team.store === "mongo" && roleIn(viewer, team.name) !== null;
  return (
    <li>
      <div className="head">
        <span className="title">{linked ? <Link href={`/t/${team.name}`}>{team.title || team.name}</Link> : team.title || team.name}</span>
        <Chip>{team.state}</Chip>
        <span className="muted">{team.part === "lead" ? "lead" : "worker"}</span>
      </div>
      <p className="muted">
        {team.part === "lead" ? `Planner ${team.planner ?? "not running"} · ` : ""}
        {atWork.length ? atWork.map(([role, n]) => `${n} ${role}${n === 1 ? "" : "s"}`).join(", ") : "nobody"} at work
        {team.store === "files" ? " · tasks in files, on this machine only" : ""}
      </p>
      <code className="path">{team.home}</code>
    </li>
  );
}
