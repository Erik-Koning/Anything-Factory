import type { Metadata } from "next";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { ActionForm } from "../components/action-form.tsx";
import { Refresh } from "../components/refresh.tsx";
import { StartCard } from "../components/start-card.tsx";
import { SubmitButton } from "../components/submit-button.tsx";
import { TeamActions } from "../components/team-actions.tsx";
import { TeamFolds } from "../components/team-folds.tsx";
import { TeamRepo } from "../components/team-repo.tsx";
import { Ago, Chip, Notice, QuietMark, type SearchParams } from "../components/ui.tsx";
import { machinesRunning, type MachineTeam, online } from "../../lib/fleet.ts";
import { can, LIMITS, roleIn, runsTeam } from "../server/access.ts";
import {
  allTeams,
  controlsFor,
  limitDollars,
  type Limits,
  limitsOf,
  retirements,
  type Spend,
  storeFor,
  tasksFor,
  type TeamDoc,
} from "../server/factory.ts";
import { inbox, type Waiting, waitingCount } from "../server/inbox.ts";
import { linkedMachines, type Machine, ownersOf } from "../server/machines.ts";
import { type Start, startOpen, starts } from "../server/starts.ts";
import { requireViewer } from "../server/viewer.ts";
import { dollars, merges, offSite, progress, proposals, quietSince } from "../server/views.ts";
import { decideAction } from "./t/[team]/actions.ts";

export const metadata: Metadata = { title: "Teams" };

// The overview's seven counts (server/views.ts PROGRESS), in a word each: a row has less room than a page.
const LANES_SHORT = ["Triage", "To decide", "To build", "Building", "In review", "Blocked", "Done"];

// Every team the person follows, each a row that folds (components/team-folds.tsx): shut, it says how the team is; open,
// where its work stands and the ways in. Above them, for an admin: the projects their Macs are starting (app/new).
// Why a team a linked Mac runs isn't on this page: what the site reads is a team's store in MongoDB.
const unshownWhy = (store: MachineTeam["store"]): ReactNode =>
  store === "files" ? (
    <>
      keeps its tasks in files there (<code>a6g task migrate --to mongo</code> brings them here)
    </>
  ) : store === "mongo" ? (
    <>
      isn&apos;t published yet (<code>a6g register</code> publishes it)
    </>
  ) : (
    "keeps no task graph the site reads"
  );

export default async function TeamsPage({ searchParams }: { searchParams: SearchParams }) {
  // Every team that published its settings, those taken off the site among them (server/factory.ts retirements), and
  // every linked machine: read beside the session, and shown only as the person may see them.
  const [viewer, every, off, all] = await Promise.all([requireViewer(), allTeams({ retired: true }), retirements(), linkedMachines()]);
  const teams = every.filter((team) => !offSite(team, off.get(team.name) ?? null) && roleIn(viewer, team.name) !== null);
  const offTeams = viewer.admin ? every.filter((team) => offSite(team, off.get(team.name) ?? null)) : [];
  // Only the machines that report a team whose board the viewer sees.
  const boards = new Set(teams.filter((team) => can(viewer, "team:board", team.name)).map((team) => team.name));
  const machines = all.filter((machine) => machine.teams.some((t) => boards.has(t.name)));
  const mayStart = can(viewer, "projects:start");
  const [owners, rows, asked] = await Promise.all([
    ownersOf(machines),
    Promise.all(teams.map(async (team) => ({ team, ...(await summary(team, can(viewer, "team:control", team.name))) }))),
    mayStart ? starts(new Set(every.map((team) => team.name))) : Promise.resolve([] as Start[]),
  ]);
  const asking = rows.filter((c) => c.asks && can(viewer, "proposals:decide", c.team.name));
  const asks = asking.reduce((n, c) => n + c.asks, 0);
  // Each ask's Mac, to say whether it's there to pick the ask up: every linked one, not only those that run a team. An
  // admin's also say which teams they run that this page doesn't show.
  const linked = asked.length || viewer.admin ? all : [];
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
            {rows.map(({ team, tasks, waiting, asks: teamAsks, waits, controls, cycles, lastMerge, limits }) => {
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
                        {/* Which repository, under the name: named here, linked in the fold's Team facts. */}
                        <TeamRepo repo={team.repo} link={false} />
                      </span>
                      {/* The same four figures in the same places on every row, each saying what it counts, so a row
                          needs no column headings. */}
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
                            <span className="muted">nothing waiting on you</span>
                          )}
                        </span>
                        <span className="glance-item">
                          <b>{atWork.reduce((n, [, m]) => n + m, 0)}</b> at work
                        </span>
                        <span className="glance-item">
                          {spend ? (
                            <>
                              <b>{dollars(spend.today)}</b> spent today
                            </>
                          ) : control ? (
                            <span className="muted">spend not counted yet</span>
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
                      {/* What waits on the operator, each settled from here or on Waiting on you; the team's own keys
                          (stop, pause, resume, and the rest under ⋯) beside the heading, as beside its name on its pages. */}
                      {decides && waits.length ? (
                        <section aria-label={`${title}: waiting on you`}>
                          <div className="team-body-head">
                            <h3 className="small">Waiting on you</h3>
                            {control ? (
                              <TeamActions team={team} controls={controls} tasks={tasks} mayDelete={can(viewer, "team:retire", team.name)} />
                            ) : null}
                          </div>
                          <ul className="plain waits">
                            {waits.slice(0, WAITS_SHOWN).map((w) => (
                              <WaitingRow key={w.task.id} team={team.name} w={w} />
                            ))}
                          </ul>
                          {waits.length > WAITS_SHOWN ? (
                            <p className="small">
                              <Link href={`/t/${team.name}/inbox`}>{`All ${waits.length} on Waiting on you`}</Link>
                            </p>
                          ) : null}
                        </section>
                      ) : null}
                      <section aria-label={`${title}: where the work stands`}>
                        <div className="team-body-head">
                          <h3 className="small">Work</h3>
                          {control && !(decides && waits.length) ? (
                            <TeamActions team={team} controls={controls} tasks={tasks} mayDelete={can(viewer, "team:retire", team.name)} />
                          ) : null}
                        </div>
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
                            {team.repo ? (
                              <>
                                <dt>Repository</dt>
                                <dd>
                                  <TeamRepo repo={team.repo} branch={team.branch} />
                                </dd>
                              </>
                            ) : null}
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
                      {/* The team's pages this person may open, each a small quiet key along the row's foot; the one
                          with something waiting on the operator carries the same light as the row's figure. What's to
                          decide is named as its count above is. */}
                      <p className="shortcuts">
                        {can(viewer, "tasks:add", team.name) ? (
                          <Link href={`/t/${team.name}/add`}>Add a task</Link>
                        ) : can(viewer, "tasks:suggest", team.name) ? (
                          <Link href={`/t/${team.name}/add`}>Suggest a task</Link>
                        ) : null}
                        {decides ? (
                          <Link className={teamAsks ? "attention" : undefined} href={`/t/${team.name}/inbox`}>
                            Waiting on you{teamAsks ? ` (${teamAsks})` : ""}
                          </Link>
                        ) : null}
                        {board ? <Link href={`/t/${team.name}/board`}>Board</Link> : null}
                        <Link href={`/t/${team.name}/requests`}>Requests</Link>
                        {decides ? <Link href={`/t/${team.name}/proposals`}>To decide{waiting ? ` (${waiting})` : ""}</Link> : null}
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
              Not shown:{" "}
              {unshown.map(({ machine, team }, i) => (
                <Fragment key={`${machine.id}:${team.name}`}>
                  {i ? "; " : ""}
                  <b>{team.title || team.name}</b> on {machine.name} {unshownWhy(team.store)}
                </Fragment>
              ))}
              . <Link href="/machines">Machines</Link> lists what each Mac runs.
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

// At most this many waiting things on a row; the rest are on the team's Waiting on you.
const WAITS_SHOWN = 5;

// One thing waiting on the operator, on its team's row: what it is and how long it's waited; Answer goes to it on
// Waiting on you, where its question and choices are; Discard rejects it from here, with words the team reads, once
// it's opened (so one press can't do it). A design check-in is only ever answered (lib/tasks/model.ts).
function WaitingRow({ team, w }: { team: string; w: Waiting }) {
  const t = w.task;
  const field = `discard-${team}-${t.id}`;
  return (
    <li className="wait-row">
      <span className="wait-what">
        {/* The decision in a line when the team gave one, else the task's title. */}
        <span className="id">#{t.id}</span> <Link href={`/t/${team}/tasks/${t.id}`}>{w.headline ?? t.title}</Link> <Chip>{t.status}</Chip>{" "}
        <span className="muted small nowrap">
          waiting <Ago at={w.since} />
        </span>
      </span>
      <span className="wait-do">
        <Link className="button s" href={`/t/${team}/inbox#task-${t.id}`}>
          Answer
        </Link>
        {t.kind === "design" ? null : (
          <details className="discard">
            <summary>Discard…</summary>
            <ActionForm action={decideAction} className="discard-form">
              <input type="hidden" name="team" value={team} />
              <input type="hidden" name="id" value={t.id} />
              <input type="hidden" name="decision" value="reject" />
              <input type="hidden" name="seen" value={t.version} />
              <label htmlFor={field}>Why, for the team</label>
              <input id={field} name="text" required maxLength={LIMITS.note} defaultValue="Not needed now." autoComplete="off" />
              <SubmitButton className="reject s">{`Discard #${t.id}`}</SubmitButton>
            </ActionForm>
          </details>
        )}
      </span>
    </li>
  );
}

async function summary(team: TeamDoc, control: boolean) {
  const [tasks, cycles, controls] = await Promise.all([
    tasksFor(team.name),
    team.mode === "cycles" ? storeFor(team.name).cycles.all() : Promise.resolve([]),
    control ? controlsFor(team.name) : Promise.resolve([]),
  ]);
  const { questions, blocked } = inbox(tasks);
  return {
    tasks,
    controls,
    waiting: proposals(tasks).length,
    asks: waitingCount(tasks),
    // What waits on the operator now, longest waiting first: the questions, then blocked work.
    waits: [...questions, ...blocked],
    cycles: cycles.length,
    lastMerge: merges(tasks, 1)[0]?.at ?? null,
    limits: limitsOf(controls),
  };
}
