import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SitePanel } from "../../../../components/site-panel.tsx";
import { BudgetForm, SpendTiles } from "../../../../components/spend-panel.tsx";
import { SubscriptionsPanel } from "../../../../components/subscriptions-panel.tsx";
import { Ago, Chip, Notice, param, type SearchParams } from "../../../../components/ui.tsx";
import { WeekPace } from "../../../../components/week-pace.tsx";
import { LEVEL_MEANS } from "../../../../../lib/tasks/agreement.ts";
import { can } from "../../../../server/access.ts";
import { readsAgreement } from "../../../../server/decided.ts";
import { agreementOf, limitsOf, retiredOf } from "../../../../server/factory.ts";
import { askedBy, offSite } from "../../../../server/views.ts";
import { controlsFor, readAhead, teamFor } from "../team.ts";

export const metadata: Metadata = { title: "Settings" };

// How a team runs, in one place for its admins, from the key beside its name or the Settings tab: what it may spend
// (the budget, beside what it has spent and how far its subscriptions are through their week), the subscriptions it
// runs on, how readily it asks (the working agreement, whose own page this opens), and whether it's on the site.
// Stopping, pausing and the rest stay beside its name, on every one of its pages.
export default async function SettingsPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  readAhead(name, "controls");
  // Which form a refused control reopens.
  const open = param((await searchParams)["open"]);
  const { viewer, team } = await teamFor(name);
  const control = can(viewer, "team:control", team.name);
  const retire = can(viewer, "team:retire", team.name);
  if (!control && !retire) notFound();
  const controls = await controlsFor(team.name);
  const limits = limitsOf(controls);
  const spend = team.status?.spend ?? null;
  const { agreement, control: agreed } = agreementOf(controls);
  const base = `/t/${team.name}`;
  return (
    <>
      <Notice searchParams={searchParams} />
      <p className="lede small">
        How the team runs: what it may spend, the subscriptions it runs on, how readily it asks you, and whether it&apos;s on the site. Stop, pause and the
        rest are beside its name.
      </p>
      {control ? (
        <section className="panel" id="budget" aria-labelledby="budget-h">
          <h2 id="budget-h">Budget</h2>
          <p className="small muted">
            What the team may spend, in what its tokens would cost on the Claude API or in shares of a subscription&apos;s week. Teams on one Claude
            account share its week: a budget for each keeps one from using up the others&apos;.
          </p>
          {spend ? (
            <SpendTiles spend={spend} limits={limits} />
          ) : (
            <p className="empty small">Nothing counted yet: the team&apos;s Mac counts what it uses every five minutes.</p>
          )}
          {spend?.subscriptions?.length ? <WeekPace subscriptions={spend.subscriptions} /> : null}
          <BudgetForm team={team.name} limits={limits} week={spend?.subscriptionWeek ?? null} />
          <p className="small">
            <Link className="way" href={`${base}#spend`}>
              Each day&apos;s spend, and the work that cost the most →
            </Link>
          </p>
        </section>
      ) : null}
      <section className="panel runs" aria-labelledby="runs">
        <h2 id="runs">How it runs</h2>
        {control ? <SubscriptionsPanel team={team} controls={controls} open={open === "subscriptions"} /> : null}
        {control ? (
          <section className="part" id="agreement" aria-labelledby="agreement-h">
            <h3 id="agreement-h">Working agreement</h3>
            <div className="part-body">
              {readsAgreement(team) ? (
                <p className="small">
                  <Chip tone="">{agreement.level}</Chip> The team {LEVEL_MEANS[agreement.level]}.{" "}
                  {agreed ? (
                    <>
                      Set by {askedBy(agreed.by)}, <Ago at={agreed.at} />.
                    </>
                  ) : (
                    <span className="muted">The default: nobody has changed it.</span>
                  )}
                </p>
              ) : (
                <p className="small muted">This team&apos;s factory version doesn&apos;t read the agreement yet.</p>
              )}
              <p className="small">
                <Link className="way" href={`${base}/agreement`}>
                  {readsAgreement(team) ? "What it asks you, how it has gone, and the form that changes it →" : "How it works, and how to upgrade →"}
                </Link>
              </p>
            </div>
          </section>
        ) : null}
        {retire ? <SitePanel team={team} retired={offSite(team, retiredOf(controls))} expanded={open === "site"} /> : null}
      </section>
    </>
  );
}
