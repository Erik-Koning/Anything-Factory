import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { Refresh } from "../components/refresh.tsx";
import { StartCard } from "../components/start-card.tsx";
import { TeamFolds } from "../components/team-folds.tsx";
import { Ago, Chip, Notice, QuietMark, type SearchParams } from "../components/ui.tsx";
import { machinesRunning, type MachineTeam, online } from "../../lib/fleet.ts";
import { can, roleIn, runsTeam } from "../server/access.ts";
import { allTeams, controlsOf, limitDollars, type Limits, limitsOf, retirements, type Spend, storeFor, type TeamDoc } from "../server/factory.ts";
import { waitingCount } from "../server/inbox.ts";
import { linkedMachines, type Machine, ownersOf } from "../server/machines.ts";
import { type Start, startOpen, starts } from "../server/starts.ts";
import { requireViewer } from "../server/viewer.ts";
import { dollars, merges, offSite, progress, proposals, quietSince } from "../server/views.ts";

export const metadata: Metadata = { title: "Teams" };

// The overview's seven counts (server/views.ts PROGRESS), in a word each: a row has less room than a page.
const LANES_SHORT = ["Triage", "To decide", "To build", "Building", "In review", "Blocked", "Done"];

// Every team the person follows, each a row that folds (components/team-folds.tsx): shut, it says how the team is; open,
// where its work stands and the ways in. Above them, for an admin: the projects their Macs are starting (app/new).
// Why a team a linked Mac runs isn't on this page: what the site reads is a team's store in MongoDB.
const unshownWhy = (store: MachineTeam["store"]): string =>
  store === "files"
    ? "its tasks are in files on that Mac (a6g task migrate --to mongo moves them here)"
    : store === "mongo"
      ? "not published yet (a6g register publishes it)"
      : "it keeps no task graph the site reads";

export default async function TeamsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  // Every team that published its settings, those taken off the site among them (server/factory.ts retirements).
  const [every, off] = await Promise.all([allTeams({ retired: true }), retirements()]);
  const teams = every.filter((team) => !offSite(team, off.get(team.name) ?? null) && roleIn(viewer, team.name) !== null);
  const offTeams = viewer.admin ? every.filter((team) => offSite(team, off.get(team.name) ?? null)) : [];
  // Only the machines that report a team whose board the viewer sees.
  const machines = await linkedMachines({ teams: teams.filter((team) => can(viewer, "team:board", team.name)).map((team) => team.name) });
  const owners = await ownersOf(machines);
  const rows = await Promise.all(teams.map(async (team) => ({ team, ...(await summary(team, can(viewer, "team:control", team.name))) })));
  const asking = rows.filter((c) => c.asks && can(viewer, "proposals:decide", c.team.name));
  const asks = asking.reduce((n, c) => n + c.asks, 0);
  const mayStart = can(viewer, "projects:start");
  const asked: Start[] = mayStart ? await starts(new Set(every.map((team) => team.name))) : [];
  // Each ask's Mac, to say whether it's there to pick the ask up: every linked one, not only those that run a team. An
  // admin's also say which teams they run that this page doesn't show.
  const linked = asked.length || viewer.admin ? await linkedMachines() : [];
  const published = new Set(every.map((team) => team.name));
  const unshown = viewer.admin
    ? linked.flatMap((machine) => machine.teams.filter((t) => t.part === "lead" && !published.has(t.name)).map((team) => ({ machine, team })))
    : [];
  const upOf = (id: string): boolean | null => {
    const machine = linked.find((m: Machine) => m.id === id);
    return machine ? online(machine) : null;
  };
  // What's open to start with, for someone who hasn't left their own: the teams with something waiting, else the first.
  const first = asking[0]?.team.name ?? rows[0]?.team.name;
  const openAtFirst = new Set(asking.length ? asking.map((c) => c.team.name) : first ? [first] : []);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Teams</h1>
          <p className="lede">{viewer.admin ? "Every team that has published its settings and is on the site." : "The teams you follow."}</p>
        </div>
        {mayStart ? (
          // A raised key, not the solid: the one fill on this page is what waits on the operator.
          <Link className="button" href="/new">
            Start a project
          </Link>
        ) : null}
      </div>
      <Notice searchParams={searchParams} />
      {asks ? (
        <div className="notice attention inline">
          <span>
            <b>{asks === 1 ? "One thing is" : `${asks} things are`} waiting on you</b>
            {asking.length > 1 ? `, from ${asking.length} teams` : `, from ${asking[0]?.team.title || asking[0]?.team.name}`}: questions to answer or work
            that&apos;s blocked.
          </span>
          <Link className="button primary" href="/inbox">
            See what&apos;s waiting
          </Link>
        </div>
      ) : null}
      {asked.length ? (
        <section className="starting" aria-labelledby="starting">
          <h2 id="starting">
            Being started <span className="muted">{asked.length}</span>
          </h2>
          <ul className="plain starts">
            {asked.map((start) => (
              <StartCard key={start.team} start={start} up={upOf(start.ask.machine)} />
            ))}
          </ul>
          {asked.some(startOpen) ? <Refresh every={10} /> : null}
        </section>
      ) : null}
      {rows.length ? (
        <TeamFolds count={rows.length}>
          <ul className="plain team-rows" aria-labelledby="all-teams">
            {rows.map(({ team, tasks, waiting, asks: teamAsks, cycles, lastMerge, limits }) => {
              const role = roleIn(viewer, team.name);
              const status = team.status;
              const atWork = status ? Object.entries(status.members).filter(([, n]) => n > 0) : [];
              const working = atWork.length ? atWork.map(([r, n]) => `${n} ${r}${n === 1 ? "" : "s"}`).join(", ") : "nobody";
              const decides = can(viewer, "proposals:decide", team.name);
              const board = can(viewer, "team:board", team.name);
              const control = can(viewer, "team:control", team.name);
              // Where it runs, for those who see who holds what on the board: the machines of its members and admins that
              // report it.
              const runsOn = board
                ? machinesRunning(
                    machines.filter((m) => runsTeam(owners.get(m.userId), team.name)),
                    team.name
                  )
                : null;
              const spend = control ? (status?.spend ?? null) : null;
              const title = team.title || team.name;
              const subs = control ? (status?.subscriptions?.use["*"] ?? null) : null;
              const quiet = quietSince(team);
              return (
                <li key={team.name} className="team-row">
                  <details className="team" id={team.name} open={openAtFirst.has(team.name)}>
                    <summary>
                      <span className="team-name">
                        <span className="title">{title}</span>
                        <Chip>{status?.state ?? "no status yet"}</Chip>
                        {quiet ? <QuietMark last={quiet.last} /> : null}
                      </span>
                      {/* The same four figures in the same places on every row, a dash where there's nothing to say. */}
                      <span className="glance">
                        <span className="glance-item waits">
                          {decides && teamAsks ? (
                            // The figure is a way to them too: a link in the fold's header goes where it says and leaves
                            // the fold be. Out of the tab order, so the header stays one key: the open row's foot has the
                            // same link for the keyboard.
                            <Link className="chip caution" href={`/t/${team.name}/inbox`} tabIndex={-1}>
                              {`${teamAsks} waiting on you`}
                            </Link>
                          ) : (
                            <span className="muted">nothing waiting</span>
                          )}
                        </span>
                        <span className="glance-item">
                          <b>{atWork.reduce((n, [, m]) => n + m, 0)}</b> at work
                        </span>
                        <span className="glance-item">
                          {spend ? (
                            <>
                              <b>{dollars(spend.today)}</b> today
                            </>
                          ) : control ? (
                            <span className="muted">not counted yet</span>
                          ) : null}
                        </span>
                        <span className="glance-item muted">
                          {lastMerge ? (
                            <>
                              merged <Ago at={lastMerge} />
                            </>
                          ) : (
                            "no merges yet"
                          )}
                        </span>
                      </span>
                    </summary>
                    <div className="team-body">
                      <section aria-label={`${title}: where the work stands`}>
                        <h3 className="small">Work</h3>
                        <ul className="counts mini">
                          {progress(tasks).map(({ label, count }, index) => (
                            <li key={label} className={count ? undefined : "none"} title={label}>
                              <b>{count}</b>
                              <span className="small muted">{LANES_SHORT[index] ?? label}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                      <div className="team-cols">
                        <section aria-label={`${title}: the team`}>
                          <h3 className="small">Team</h3>
                          <dl className="facts small">
                            <dt>Your role</dt>
                            <dd>{role}</dd>
                            <dt>Planner</dt>
                            <dd>{status?.planner ?? "not running"}</dd>
                            <dt>At work</dt>
                            <dd>{working}</dd>
                            {runsOn ? (
                              <>
                                <dt>Machines</dt>
                                <dd>
                                  {runsOn.length
                                    ? runsOn.map(({ machine, part }, i) => (
                                        <Fragment key={machine.id}>
                                          {i ? ", " : ""}
                                          {/* A machine and its mark stay on one line. */}
                                          <span className="runs-on">
                                            {machine.name} ({part})
                                            {online(machine) ? null : (
                                              <>
                                                {" "}
                                                <Chip tone="caution">not reporting</Chip>
                                              </>
                                            )}
                                          </span>
                                        </Fragment>
                                      ))
                                    : "none reports it"}
                                </dd>
                              </>
                            ) : null}
                            {subs ? (
                              <>
                                <dt>Subscriptions</dt>
                                <dd>{subs.length ? subs.join(", then ") : "its Mac's own login"}</dd>
                              </>
                            ) : null}
                            <dt>Aim</dt>
                            <dd>
                              {team.mode === "cycles"
                                ? `cycle ${cycles + 1}`
                                : status?.state === "complete"
                                  ? "finish line reached"
                                  : "working to its finish line"}
                            </dd>
                            <dt>Last merge</dt>
                            <dd>{lastMerge ? <Ago at={lastMerge} /> : "none yet"}</dd>
                            <dt>Updated</dt>
                            <dd>
                              <Ago at={status?.at} />
                            </dd>
                          </dl>
                        </section>
                        {control ? (
                          <section aria-label={`${title}: what it spent`}>
                            <h3 className="small">Spend</h3>
                            {spend ? (
                              <ul className="plain spent">
                                <Spent label="Today" spent={spend.today} cap={limits?.daily} limits={limits} spend={spend} />
                                <Spent label="This week" spent={spend.week} cap={limits?.weekly} limits={limits} spend={spend} />
                                <Spent
                                  label={spend.since ? "Since the budget began" : "In all"}
                                  spent={spend.total}
                                  cap={limits?.total}
                                  limits={limits}
                                  spend={spend}
                                />
                              </ul>
                            ) : (
                              <p className="muted small">Nothing counted yet.</p>
                            )}
                            <p className="small">
                              <Link href={`/t/${team.name}?open=budget#spend`}>{limits ? "Change the budget" : "Set a budget"}</Link>
                            </p>
                          </section>
                        ) : null}
                      </div>
                      {/* The team's pages this person may open, each a small key along the row's foot. */}
                      <p className="shortcuts">
                        {can(viewer, "tasks:add", team.name) ? (
                          <Link href={`/t/${team.name}/add`}>Add a task</Link>
                        ) : can(viewer, "tasks:suggest", team.name) ? (
                          <Link href={`/t/${team.name}/add`}>Suggest a task</Link>
                        ) : null}
                        {decides ? <Link href={`/t/${team.name}/inbox`}>Waiting on you{teamAsks ? ` (${teamAsks})` : ""}</Link> : null}
                        {board ? <Link href={`/t/${team.name}/board`}>Board</Link> : null}
                        <Link href={`/t/${team.name}/requests`}>Requests</Link>
                        {decides ? <Link href={`/t/${team.name}/proposals`}>Decisions{waiting ? ` (${waiting})` : ""}</Link> : null}
                        {control && status?.subscriptions ? <Link href={`/t/${team.name}#subscriptions`}>Subscriptions</Link> : null}
                      </p>
                    </div>
                  </details>
                  {/* The row's way in says where it goes: folding has its own words (components/team-folds.tsx). */}
                  <Link className="team-open" href={`/t/${team.name}`} aria-label={`${title}: overview`}>
                    Overview
                  </Link>
                </li>
              );
            })}
          </ul>
        </TeamFolds>
      ) : (
        <p className="panel empty">
          {viewer.admin
            ? offTeams.length
              ? "No team is on the site now: those taken off it are below."
              : "No team has published its settings yet: a6g register publishes a team whose tasks are in Mongo."
            : "You're on no team yet. An admin adds you to one; then it shows here."}
        </p>
      )}
      {unshown.length || offTeams.length ? (
        <div className="teams-foot small muted">
          {unshown.length ? (
            <p>
              Also on the linked Macs, not shown here:{" "}
              {unshown.map(({ machine, team }, i) => (
                <Fragment key={`${machine.id}:${team.name}`}>
                  {i ? "; " : ""}
                  <b>{team.title || team.name}</b> on {machine.name}: {unshownWhy(team.store)}
                </Fragment>
              ))}
              . <Link href="/machines">Machines</Link> lists what each runs.
            </p>
          ) : null}
          {offTeams.length ? (
            <p>
              Taken off the site:{" "}
              {offTeams.map((team, i) => (
                <Fragment key={team.name}>
                  {i ? ", " : ""}
                  <Link href={`/t/${team.name}`}>{team.title || team.name}</Link>
                </Fragment>
              ))}
              . Each one&apos;s overview puts it back.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

// A figure the team spent, against its limit when there is one: the bar fills towards it, and the share is said in
// words too (how full, and "near its limit" or "over its limit"), so the bar's colour isn't the only sign.
function Spent({
  label,
  spent,
  cap,
  limits,
  spend,
}: {
  label: string;
  spent: number;
  cap: number | null | undefined;
  limits: Limits | null;
  spend: Spend;
}) {
  const limit = cap && limits ? limitDollars(cap, limits, spend.subscriptionWeek) : null;
  const share = limit ? spent / limit : null;
  const state = share === null ? "" : share >= 1 ? "over" : share >= 0.8 ? "near" : "";
  return (
    <li>
      <span className="spent-line">
        <span>{label}</span>
        <span>
          <b>{dollars(spent)}</b>
          {limit ? <span className="muted"> of {dollars(limit)}</span> : null}
        </span>
      </span>
      {share !== null ? (
        <>
          <span className={`meter ${state}`.trim()} aria-hidden="true">
            <span style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
          </span>
          <span className={`spent-share ${state}`.trim()}>
            {Math.round(share * 100)}% of the limit{state === "over" ? ": over it" : state === "near" ? ": near it" : ""}
          </span>
        </>
      ) : (
        <span className="spent-share">no limit</span>
      )}
    </li>
  );
}

async function summary(team: TeamDoc, control: boolean) {
  const store = storeFor(team.name);
  const [tasks, cycles, controls] = await Promise.all([
    store.tasks.all(),
    team.mode === "cycles" ? store.cycles.all() : Promise.resolve([]),
    control ? controlsOf(team.name) : Promise.resolve([]),
  ]);
  return {
    tasks,
    waiting: proposals(tasks).length,
    asks: waitingCount(tasks),
    cycles: cycles.length,
    lastMerge: merges(tasks, 1)[0]?.at ?? null,
    limits: limitsOf(controls),
  };
}
