import type { Metadata } from "next";
import Link from "next/link";
import { type MachineSubscription, type MachineTeam, online } from "../../../lib/fleet.ts";
import { Command } from "../../components/command.tsx";
import { SubmitButton } from "../../components/submit-button.tsx";
import { Ago, Chip, Notice, type SearchParams } from "../../components/ui.tsx";
import { can, roleIn, type Viewer, visibleMachines } from "../../server/access.ts";
import { allTeams, retirements } from "../../server/factory.ts";
import { linkedMachines, type Machine, machineSubscriptions, ownersOf } from "../../server/machines.ts";
import { requireViewer } from "../../server/viewer.ts";
import { offSite } from "../../server/views.ts";
import { unlinkMachineAction } from "./actions.ts";
import { ActionForm } from "../../components/action-form.tsx";

export const metadata: Metadata = { title: "Machines" };

export default async function MachinesPage({ searchParams }: { searchParams: SearchParams }) {
  // The machines, and the teams taken off the site (a Mac that reports one since puts it back: views.ts offSite), read
  // beside the session and shown only as the person may see them.
  const [viewer, linked, every, retired] = await Promise.all([requireViewer(), linkedMachines(), allTeams({ retired: true }), retirements()]);
  const everyone = can(viewer, "machines:all");
  const now = Date.now();
  // Those reporting first, then by name.
  const machines = visibleMachines(viewer, linked).sort((a, b) => Number(online(b, now)) - Number(online(a, now)) || a.name.localeCompare(b.name));
  const [owners, subscriptions] = await Promise.all([everyone ? ownersOf(machines) : null, machineSubscriptions(machines.map((m) => m.id))]);
  const off = new Set(every.filter((team) => offSite(team, retired.get(team.name) ?? null)).map((team) => team.name));
  return (
    <>
      <h1>Machines</h1>
      <p className="lede">
        {everyone ? "Every machine linked to an account here, whose it is, and the teams each runs." : "Your machines, and the teams each runs."} A linked
        machine reports every five minutes while its watchdog runs.
      </p>
      <Notice searchParams={searchParams} />
      {machines.length ? (
        <ul className="cards machines">
          {machines.map((machine) => (
            <MachineCard
              key={machine.id}
              machine={machine}
              viewer={viewer}
              owner={owners ? (owners.get(machine.userId)?.email ?? "a removed account") : null}
              up={online(machine, now)}
              off={off}
              subscriptions={subscriptions.get(machine.id) ?? null}
            />
          ))}
        </ul>
      ) : (
        <div className="panel empty">
          <p>{everyone ? "No machine is linked yet." : "None of your machines is linked yet."}</p>
          <p className="hint">
            Run <code>a6g connect app</code> on one to link it: it shows a code and opens <Link href="/machines/link">the page to approve it on</Link>.
          </p>
        </div>
      )}
      {/* How a Mac is linked, and how one comes to start projects, each command a block of its own: the Starts projects
          fact links here. */}
      <div className="panel how-projects">
        <section aria-labelledby="how-link">
          <h2 id="how-link">Linking a machine</h2>
          <p className="hint">
            Run this on it: it shows a code and opens <Link href="/machines/link">the page to approve it on</Link>.
          </p>
          <Command>a6g connect app</Command>
        </section>
        <section id="start-projects" aria-labelledby="how-projects">
          <h2 id="how-projects">Starting projects from here</h2>
          <p className="hint">
            A linked Mac starts the projects you ask for on{" "}
            <Link className="nowrap" href="/new">
              Start a project
            </Link>{" "}
            once you&apos;ve turned that on at its own terminal. It can&apos;t be turned on from here, and it holds for the one folder you name:
          </p>
          <Command>a6g connect app --projects ~/code</Command>
          <p className="hint">A Mac that needs a newer factory: update it first, in the folder you installed the factory from on that Mac.</p>
          <Command>git pull && npm install && node bin/a6g.ts self-install</Command>
        </section>
      </div>
    </>
  );
}

function MachineCard({
  machine,
  viewer,
  owner,
  up,
  off,
  subscriptions,
}: {
  machine: Machine;
  viewer: Viewer;
  owner: string | null;
  up: boolean;
  off: ReadonlySet<string>;
  // What it reports of its Claude subscriptions, from a factory version that does.
  subscriptions: MachineSubscription[] | null;
}) {
  // Only its own person asks it to start a project, or turns that on at its terminal.
  const mine = machine.userId === viewer.userId;
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
          {machine.lastIp ? (
            <>
              {" "}
              from <span className="ip">{machine.lastIp}</span>
            </>
          ) : null}
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
        {subscriptions?.length ? (
          <>
            <dt>Subscriptions</dt>
            <dd>
              {subscriptions.map((s) => `${s.name}${s.weekly ? ` (${Math.round(100 - s.weekly.percent)}% of its week left)` : ""}`).join(", ")} ·{" "}
              <Link className="nowrap" href={`/subscriptions?machine=${encodeURIComponent(machine.name)}`}>
                Limits and usage
              </Link>
            </dd>
          </>
        ) : null}
        <dt>Starts projects</dt>
        <dd>
          {machine.projects ? (
            <>
              yes, in <code className="path">{machine.projects.dir}</code> ·{" "}
              {machine.projects.repos.length
                ? `${machine.projects.repos.length} repositor${machine.projects.repos.length === 1 ? "y" : "ies"} with no team`
                : "no repository without a team"}
              {mine && can(viewer, "projects:start") ? (
                <>
                  {" "}
                  <span className="nowrap">
                    ·{" "}
                    <Link className="nowrap" href="/new">
                      Start one
                    </Link>
                  </span>
                </>
              ) : null}
              {/* The GitHub account it clones, forks and makes repositories as; an older factory doesn't say. */}
              {machine.projects.github !== undefined ? (
                <span className="github-as small muted">
                  {machine.projects.github ? (
                    <>
                      On GitHub as <b>{machine.projects.github}</b>
                    </>
                  ) : (
                    <>
                      Not signed in to GitHub: on it, <code>gh auth login</code>
                    </>
                  )}
                </span>
              ) : null}
            </>
          ) : machine.canStart ? (
            <span className="muted">
              no: not turned on
              {mine ? (
                <>
                  {" "}
                  <span className="nowrap">
                    ·{" "}
                    <Link className="nowrap" href="#start-projects">
                      How to turn it on
                    </Link>
                  </span>
                </>
              ) : null}
            </span>
          ) : (
            // How to update it is the same on every Mac: said on each, whoever's it is.
            <span className="muted">
              no: needs a newer factory{" "}
              <span className="nowrap">
                ·{" "}
                <Link className="nowrap" href="#start-projects">
                  How to update it
                </Link>
              </span>
            </span>
          )}
        </dd>
      </dl>
      <h3 className="small">{up ? "Teams" : "Teams, at its last report"}</h3>
      {machine.teams.length ? (
        <ul className="plain rows small">
          {machine.teams.map((team) => (
            <TeamRow key={team.name} team={team} viewer={viewer} off={off.has(team.name)} />
          ))}
        </ul>
      ) : (
        <p className="empty small">{machine.at ? "No team is registered on it." : "It hasn't reported yet."}</p>
      )}
      <ActionForm action={unlinkMachineAction}>
        <input type="hidden" name="id" value={machine.id} />
        <SubmitButton className="quiet danger s">{`Unlink ${machine.name}`}</SubmitButton>
      </ActionForm>
    </li>
  );
}

function TeamRow({ team, viewer, off }: { team: MachineTeam; viewer: Viewer; off: boolean }) {
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
        {off ? " · taken off the site" : ""}
      </p>
      <code className="path">{team.home}</code>
    </li>
  );
}
