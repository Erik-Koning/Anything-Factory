import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { online } from "../../../lib/fleet.ts";
import { Command } from "../../components/command.tsx";
import { Refresh } from "../../components/refresh.tsx";
import { MARKS } from "../../components/start-marks.ts";
import { Notice, param, type SearchParams } from "../../components/ui.tsx";
import { can } from "../../server/access.ts";
import { config } from "../../server/config.ts";
import { allTeams } from "../../server/factory.ts";
import { linkedMachines } from "../../server/machines.ts";
import { startFor, startingMachines, startOpen, starts } from "../../server/starts.ts";
import { requireViewer } from "../../server/viewer.ts";
import type { StartFormState } from "./actions.ts";
import { StartForm, type StartMachine } from "./start-form.tsx";

export const metadata: Metadata = { title: "Start a project" };

const EMPTY: StartFormState = {
  error: null,
  machine: "",
  repo: "new",
  create: "",
  existing: "",
  github: "",
  publish: "private",
  trusted: false,
  base: "",
  mode: "finish",
  approval: "operator",
  push: "pull-request",
  level: "balanced",
  hold: false,
  title: "",
  name: "",
  goal: "",
  technical: true,
  unit: "usd",
  daily: "",
  weekly: "",
  total: "",
  autoResume: false,
  use: [],
};

// An admin asks one of their own Macs to start a team (docs/plans/run-from-the-site.md). The form shows only for a Mac
// whose operator said at its terminal that it starts projects; until then the page says how.
export default async function StartPage({ searchParams }: { searchParams: SearchParams }) {
  // The machines and the names taken (every team that published its settings: those taken off the site keep theirs),
  // read beside the session.
  const [viewer, all, teams] = await Promise.all([requireViewer(), linkedMachines(), allTeams({ retired: true })]);
  if (!can(viewer, "projects:start")) notFound();
  const linked = all.filter((machine) => machine.userId === viewer.userId);
  const now = Date.now();
  const machines: StartMachine[] = startingMachines(linked, viewer.userId)
    .sort((a, b) => Number(online(b, now)) - Number(online(a, now)) || a.name.localeCompare(b.name))
    .map((machine) => ({
      id: machine.id,
      name: machine.name,
      up: online(machine, now),
      dir: machine.projects?.dir ?? "",
      repos: machine.projects?.repos ?? [],
      subscriptions: machine.projects?.subscriptions ?? [],
      teams: machine.teams.map((team) => team.name),
      // Whether it reads an ask's newer choices (its report says which GitHub account it uses, or none), and which.
      newer: machine.projects?.github !== undefined,
      github: machine.projects?.github ?? null,
    }));
  // Asked again after one stopped: the form opens with what that one said.
  const again = param((await searchParams)["again"]);
  // Names taken: those teams', and the asks open.
  const [started, before] = await Promise.all([starts(new Set(teams.map((team) => team.name))), again ? startFor(again) : Promise.resolve(null)]);
  const open = started.filter(startOpen);
  const taken = [...teams.map((team) => team.name), ...open.map((start) => start.team)];
  const initial: StartFormState =
    before && !startOpen(before)
      ? {
          ...EMPTY,
          machine: before.ask.machine,
          repo: "github" in before.ask.repo ? "github" : "existing" in before.ask.repo ? "existing" : before.ask.repo.publish ? "new-github" : "new",
          create: "create" in before.ask.repo ? before.ask.repo.create : "",
          existing: "existing" in before.ask.repo ? before.ask.repo.existing : "",
          github: "github" in before.ask.repo ? before.ask.repo.github : "",
          publish: "create" in before.ask.repo && before.ask.repo.publish === "public" ? "public" : "private",
          // Trusting someone's code is said again each time, never carried over.
          trusted: false,
          base: before.ask.base ?? "",
          mode: before.ask.mode ?? "finish",
          approval: before.ask.approval ?? "operator",
          push: before.ask.push ?? "none",
          level: before.ask.level ?? "balanced",
          hold: before.ask.hold ?? false,
          title: before.ask.title,
          name: before.team,
          goal: before.ask.goal,
          technical: before.ask.technical,
          unit: before.ask.limits?.unit ?? "usd",
          daily: String(before.ask.limits?.daily ?? ""),
          weekly: String(before.ask.limits?.weekly ?? ""),
          total: String(before.ask.limits?.total ?? ""),
          autoResume: before.ask.limits?.autoResume ?? false,
          use: before.ask.use,
        }
      : EMPTY;
  return (
    <>
      <p className="small">
        <Link href="/">← Teams</Link>
      </p>
      <h1>Start a project</h1>
      <p className="lede">
        Say what to build and where. One of your Macs makes the team, proves its setup and starts it; you answer what it asks from{" "}
        <Link href="/inbox">Waiting on you</Link>.
      </p>
      <Notice searchParams={searchParams} />
      {machines.length ? (
        <div className="start-layout">
          <StartForm machines={machines} taken={taken} initial={initial} />
          <aside className="panel next-steps" aria-labelledby="what-happens">
            <h2 id="what-happens">What happens next</h2>
            {/* The same six steps, in the same words, as the marks on a project being started (components/start-marks.ts). */}
            <ol className="plain timeline">
              {MARKS.map(({ step, label, will }) => (
                <li key={step}>
                  <span>
                    <b>{label}.</b> {will}
                  </span>
                </li>
              ))}
            </ol>
            <p className="hint">Each step shows on the Teams page as it goes. One that stops says why, and what to run on the Mac.</p>
          </aside>
        </div>
      ) : (
        // Until a Mac starts projects there's no form: what the operator does next comes first, said as an action,
        // then the commands in order; why it's done at the Mac and not here is under its own heading.
        <section className="panel how" aria-labelledby="no-mac">
          <p className="how-state">
            {linked.length ? "None of your Macs starts projects yet" : "No Mac is linked to your account yet"}, so there&apos;s no form here yet.
          </p>
          <h2 id="no-mac">{linked.length ? "Turn it on at one of your Macs" : "Link a Mac, then turn it on there"}</h2>
          <p>
            Run these in a terminal on the Mac that should start projects. The form to say what to build shows here by itself once that Mac reports, within
            five minutes.
          </p>
          <ol className="setup">
            <li>
              <span>Check its factory version knows how. This prints whether the Mac starts projects, and in which folder.</span>
              <Command>a6g projects</Command>
              <details className="how-update">
                <summary>It doesn&apos;t know the command?</summary>
                <p>
                  Update the factory first. Run this in the folder you installed it from on that Mac (your clone of Anything Factory), and nowhere else:
                </p>
                <Command>git pull && npm install && node bin/a6g.ts self-install</Command>
              </details>
            </li>
            {linked.length ? null : (
              <li>
                <span>Link it to your account. It shows a code, which you approve here.</span>
                <Command>{`a6g connect app --url ${config().baseURL}`}</Command>
              </li>
            )}
            <li>
              <span>Connect it to the task database, where a project started from here keeps its tasks.</span>
              <Command>a6g connect mongo</Command>
            </li>
            <li>
              <span>
                Name the folder it may start projects in. It uses repositories in that folder, or makes new ones there, and touches nothing outside it.
              </span>
              <Command>a6g connect app --projects ~/code</Command>
            </li>
          </ol>
          {linked.length ? (
            <p className="small">
              <Link href="/machines">See your Macs</Link> and what each one reports.
            </p>
          ) : null}
          <details>
            <summary>Why it&apos;s turned on at the Mac</summary>
            <p className="small">
              A Mac starts projects from here only once you&apos;ve said so at its own terminal. It can&apos;t be turned on from this page, so nobody who
              gets into your account can start work on your Mac without having been at it.
            </p>
          </details>
          <Refresh every={20} forMinutes={20} />
        </section>
      )}
    </>
  );
}
