// Which Claude subscriptions a team runs on, on its overview (admins only): the subscriptions on the team's Mac with
// how much of each one's week is used, the order the team takes them in and whose order that is, what each role runs on
// now, and the form that changes the order (a control the Mac applies within a minute, lib/steer.ts). A team whose Mac
// doesn't report its subscriptions is told where they're chosen instead.
import { Fragment } from "react";
import type { Control, TeamDoc } from "../server/factory.ts";
import { askedBy } from "../server/views.ts";
import { Refresh } from "./refresh.tsx";
import { usedWords } from "./subscription-words.ts";
import { SubscriptionsForm } from "./subscriptions-form.tsx";
import { Ago, Chip } from "./ui.tsx";

const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const plural = (role: string): string => (role === "planner" ? "planner" : `${role}s`);
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((name, i) => name === b[i]);
// "the planner, builders and reviewers".
const listed = (names: string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

export function SubscriptionsPanel({ team, controls, open = false }: { team: TeamDoc; controls: Control[]; open?: boolean }) {
  const reported = team.status?.subscriptions ?? null;
  if (!reported)
    return (
      <section className="panel" id="subscriptions" aria-labelledby="subscriptions-h">
        <h2 id="subscriptions-h">Subscriptions</h2>
        <p className="small muted">
          Which Claude subscriptions this team runs on is chosen on its Mac for now (<code>a6g subscriptions use {team.name} …</code>): the factory version
          it runs doesn&apos;t take that from here yet.
        </p>
      </section>
    );
  const list = reported.use["*"] ?? [];
  const own = Object.entries(reported.use).filter(([role, subs]) => role !== "*" && subs.length);
  // The roles that follow the team's list: all of them, less those with a list of their own.
  const followers = team.roles.filter((role) => !own.some(([name]) => name === role));
  // Asked for here, and not yet what the Mac reports: it applies a control within a minute.
  const asked = controls.findLast((c) => c.kind === "subscriptions" && c.subscriptions);
  const pending =
    asked?.subscriptions && !same(reported.use[asked.subscriptions.role ?? "*"] ?? [], asked.subscriptions.use) && asked.at > (team.status?.at ?? "")
      ? asked
      : null;
  const place = (name: string): number => list.indexOf(name);
  const ordered = [...reported.available].sort((a, b) => (place(a.name) < 0 ? 99 : place(a.name)) - (place(b.name) < 0 ? 99 : place(b.name)));
  const roles = Object.entries(reported.roles);
  return (
    <section className="panel" id="subscriptions" aria-labelledby="subscriptions-h">
      <h2 id="subscriptions-h">Subscriptions</h2>
      <p className="small muted">
        The Claude subscriptions on the team&apos;s Mac. The team takes them in order and moves to the next when one closes: used up, or at a limit set for
        it on that Mac with <code>a6g subscriptions limit</code>.
      </p>
      {pending?.subscriptions ? (
        <p className="notice" role="status">
          Asked <Ago at={pending.at} /> by {askedBy(pending.by)}:{" "}
          {pending.subscriptions.use.length ? pending.subscriptions.use.join(", then ") : "the list cleared"}
          {pending.subscriptions.role ? ` for the ${plural(pending.subscriptions.role)}` : ""}. The team&apos;s Mac applies it within a minute.
          <Refresh every={10} forMinutes={5} />
        </p>
      ) : null}
      <h3 className="small">
        {list.length ? (own.length ? `The order for the ${listed(followers.map(plural))}` : "The order every role takes them in") : "On the team's Mac"}
      </h3>
      <ol className="plain subs">
        {ordered.map((sub) => {
          const at = place(sub.name);
          const state = sub.percent === null ? "" : sub.percent >= 100 ? "over" : sub.percent >= 80 ? "near" : "";
          // A week that's used up says so already: any other reason for being closed is said in its own words.
          const why = sub.closed && (sub.percent ?? 0) < 100 ? sub.closed : null;
          return (
            <li key={sub.name} className={at < 0 ? "unused" : undefined}>
              <span className="place" aria-hidden="true">
                {at < 0 ? "" : at + 1}
              </span>
              <span className="sub">
                <span className="head">
                  <b className="code">{sub.name}</b>
                  {sub.closed ? <Chip tone="warn">closed</Chip> : at < 0 ? <Chip>not in its order</Chip> : at === 0 ? <Chip tone="ok">first</Chip> : null}
                </span>
                <span className={`meter ${state}`.trim()} aria-hidden="true">
                  <span style={{ width: `${Math.min(100, sub.percent ?? 0)}%` }} />
                </span>
                <span className="small muted">
                  {usedWords(sub).replace(/^u/, "U")}
                  {why ? ` · ${why}` : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {!list.length ? (
        <p className="small">
          No list yet, so the team runs on its Mac&apos;s own login, which nothing watches: it carries on until that login is used up. Choose one below to
          have it watched.
        </p>
      ) : null}
      {own.map(([role, subs]) => (
        <p className="small" key={role}>
          The {plural(role)} have an order of their own: <b>{subs.join(", then ")}</b>.
        </p>
      ))}
      {roles.length ? (
        <>
          <h3 className="small">What each role runs on now</h3>
          <dl className="facts small">
            {roles.map(([role, on]) => {
              const wait = reported.waiting[role];
              const moving = Object.hasOwn(reported.moving, role) ? reported.moving[role] : undefined;
              return (
                <Fragment key={role}>
                  <dt>{plural(role)}</dt>
                  <dd>
                    {wait ? (
                      <>
                        <Chip tone="warn">waiting</Chip> {wait.why}
                        {wait.until ? ` (until ${day.format(new Date(wait.until))})` : ""}
                      </>
                    ) : (
                      <>
                        <b>{on ?? "the Mac's own login"}</b>
                        {moving !== undefined ? `, moving to ${moving ?? "the Mac's own login"} once nothing of it is at work` : ""}
                      </>
                    )}
                  </dd>
                </Fragment>
              );
            })}
          </dl>
        </>
      ) : null}
      <details open={open}>
        <summary>Change the order</summary>
        <SubscriptionsForm team={team.name} roles={team.roles} options={reported.available} use={reported.use} />
      </details>
    </section>
  );
}
