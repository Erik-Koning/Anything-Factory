// What a team has spent, on its overview (admins only): today, this week and in all (against the budget when there is
// one), each of the last 14 days, and the journeys and tasks that cost the most. API-equivalent dollars: what the
// tokens would cost on the Claude API, which on a subscription says how much of its limits the team takes.
import Link from "next/link";
import { budgetAction } from "../app/t/[team]/actions.ts";
import { type Limits, limitDollars, percentOf, spendByWork, type Spend, type Task, type UsageDay } from "../server/factory.ts";
import { axis, dailySpend, dollars } from "../server/views.ts";
import { SubmitButton } from "./submit-button.tsx";
import { Ago } from "./ui.tsx";

const DAYS = 14;
const longDay = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const shortMonth = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const at = (day: string) => new Date(`${day}T12:00:00Z`);

// A figure, against its limit when there is one. A budget in shares of a subscription shows shares (and dollars beside
// them); one in dollars, dollars (and, once the subscription is measured, its share of a subscription's week).
function Tile(props: { label: string; spent: number; limit: number | null | undefined; per: string; unit: "usd" | "subscription"; week: number | null }) {
  const { label, spent, limit, per, unit, week } = props;
  const shares = unit === "subscription" && week !== null;
  const cap = limit ? limitDollars(limit, { unit }, week) : null;
  const share = cap ? spent / cap : 0;
  const state = share >= 1 ? "over" : share >= 0.8 ? "near" : "ok";
  return (
    <li>
      <span className="small muted">{label}</span>
      <b>{shares && week ? `${percentOf(spent, week)}%` : dollars(spent)}</b>
      {week ? (
        <span className="small muted">{shares ? `${dollars(spent)} API-equivalent` : `${percentOf(spent, week)}% of a subscription's week`}</span>
      ) : null}
      {limit && cap ? (
        <>
          <span className={`meter ${state}`} aria-hidden="true">
            <span style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
          </span>
          <span className="small muted">
            of {unit === "subscription" ? `${limit}%` : dollars(limit)} {per}
            {state === "over" ? " · over the budget" : state === "near" ? " · near the budget" : ""}
          </span>
        </>
      ) : limit ? (
        <span className="small muted">
          budget {limit}% {per}: not checked until the subscription is measured
        </span>
      ) : null}
    </li>
  );
}

// A column per day, in HTML so its text stays at its size at any width and its tooltip sits above the other columns.
// The axis has clean steps; the daily budget is a line on it, not a second axis; only the tallest day is labelled.
function DailyChart({ days, daily }: { days: { day: string; cost: number }[]; daily: number | null }) {
  const { top, ticks } = axis(Math.max(...days.map((d) => d.cost), daily ?? 0));
  const pct = (v: number) => `${(v / top) * 100}%`;
  const tallest = days.reduce((best, d, i) => (d.cost > (days[best]?.cost ?? 0) ? i : best), 0);
  return (
    <figure className="chart">
      <div className="plot">
        <div aria-hidden="true">
          {ticks.map((t) => (
            <div key={t} className="gridline" style={{ bottom: pct(t) }}>
              <span>{t === 0 ? "$0" : dollars(t)}</span>
            </div>
          ))}
          {daily ? (
            <div className="limit" style={{ bottom: pct(daily) }}>
              <span>daily budget {dollars(daily)}</span>
            </div>
          ) : null}
        </div>
        <ol className="columns" aria-label={`Spend each day for the last ${days.length} days`}>
          {days.map((d, i) => (
            // Each column takes focus, so its value shows without a mouse too.
            <li key={d.day} tabIndex={0} aria-label={`${longDay.format(at(d.day))}: ${dollars(d.cost)}`}>
              {d.cost > 0 ? <span className="bar" style={{ height: pct(d.cost) }} /> : null}
              {i === tallest && d.cost > 0 ? (
                <span className="value" style={{ bottom: pct(d.cost) }} aria-hidden="true">
                  {dollars(d.cost)}
                </span>
              ) : null}
              <span className="tip" aria-hidden="true">
                <b>{dollars(d.cost)}</b> {longDay.format(at(d.day))}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="days" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.day}>
            {i === 0 || d.day.endsWith("-01") ? `${shortMonth.format(at(d.day))} ${Number(d.day.slice(8))}` : Number(d.day.slice(8))}
          </span>
        ))}
      </div>
    </figure>
  );
}

export function SpendPanel({
  team,
  spend,
  usage,
  limits,
  tasks,
  open = false,
}: {
  team: string;
  spend: Spend | null;
  usage: UsageDay[];
  limits: Limits | null;
  tasks: Task[];
  // The budget form, reopened after a refusal.
  open?: boolean;
}) {
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const unit = limits?.unit ?? "usd";
  const week = spend?.subscriptionWeek ?? null;
  const last = spend?.day ?? usage.at(-1)?.day ?? null;
  const days = last ? dailySpend(usage, last, DAYS) : [];
  // The costliest work since the budget began, as the totals count it.
  const since = spend?.since ?? null;
  const work = spendByWork(since ? usage.filter((d) => d.day >= since) : usage, tasks);
  return (
    <section className="panel" aria-labelledby="spend">
      <h2 id="spend">Spend</h2>
      <p className="small muted">
        What the team's tokens would cost on the Claude API. On a subscription nothing is billed per token, but this is how fast the team uses its limits.
        {spend ? (
          <>
            {" "}
            Counted by the team's Mac <Ago at={spend.at} />.
          </>
        ) : null}
      </p>
      {!spend && !usage.length ? (
        <p className="empty">Nothing counted yet: the team's Mac counts what it uses every five minutes.</p>
      ) : (
        <>
          {spend ? (
            <ul className="counts tiles">
              <Tile label="Today" spent={spend.today} limit={limits?.daily} per="a day" unit={unit} week={week} />
              <Tile label="This week" spent={spend.week} limit={limits?.weekly} per="a week" unit={unit} week={week} />
              <Tile
                label={spend.since ? `Since ${dayMonth.format(at(spend.since))}` : "In all"}
                spent={spend.total}
                limit={limits?.total}
                per="in all"
                unit={unit}
                week={week}
              />
            </ul>
          ) : null}
          {spend?.unpriced ? (
            <p className="small muted">{spend.unpriced} requests used a model with no price yet, so they aren't in these figures.</p>
          ) : null}
          {spend?.subscriptions?.length ? (
            <p className="small muted">
              {spend.subscriptions
                .map(
                  (s) =>
                    `${s.account === "default" ? "Your subscription" : s.account}: ${s.percent}% of this week used, resets ${longDay.format(new Date(s.resetsAt))}`
                )
                .join(" · ")}
              {week ? ` · one subscription's week is about ${dollars(week)} API-equivalent` : ""}
            </p>
          ) : null}
          {Object.keys(spend?.accounts ?? {}).length > 1 || Object.keys(limits?.accounts ?? {}).length ? (
            <p className="small muted">
              This week by subscription:{" "}
              {Object.entries(spend?.accounts ?? {})
                .map(([name, spent]) => {
                  const own = limits?.accounts?.[name]?.weekly;
                  const share = spent.subscriptionWeek ? ` (${percentOf(spent.week, spent.subscriptionWeek)}% of its week)` : "";
                  return `${name === "default" ? "your subscription" : name} ${dollars(spent.week)}${share}${own ? ` of its ${unit === "subscription" ? `${own}%` : dollars(own)} limit` : ""}`;
                })
                .join(" · ")}
              . At a limit on one, the team moves to its next subscription.
            </p>
          ) : null}
          {days.length ? <DailyChart days={days} daily={limits?.daily ? limitDollars(limits.daily, limits, week) : null} /> : null}
          {days.length ? (
            <details>
              <summary>Each day, as a table</summary>
              <table className="figures">
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.day}>
                      <td>{longDay.format(at(d.day))}</td>
                      <td>{dollars(d.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
          <div className="grid">
            <div>
              <h3>Journeys</h3>
              {work.journeys.length ? (
                <ol className="plain ranked small">
                  {work.journeys.slice(0, 6).map((j) => (
                    <li key={j.id ?? "none"}>
                      {j.id ? (
                        <Link href={`/t/${team}/tasks/${j.id}`}>{`#${j.id} ${titles.get(j.id) ?? ""}`}</Link>
                      ) : (
                        <span>Planning, and work on no task</span>
                      )}
                      <span className="amount">{dollars(j.cost)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="empty small">None yet.</p>
              )}
            </div>
            <div>
              <h3>Tasks</h3>
              {work.tasks.length ? (
                <ol className="plain ranked small">
                  {work.tasks.slice(0, 8).map((t) => (
                    <li key={t.id}>
                      <Link href={`/t/${team}/tasks/${t.id}`}>{`#${t.id} ${titles.get(t.id) ?? ""}`}</Link>
                      <span className="amount">{dollars(t.cost)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="empty small">None yet.</p>
              )}
            </div>
          </div>
        </>
      )}
      <details open={open}>
        <summary>{limits ? "Change the budget" : "Set a budget"}</summary>
        <form action={budgetAction} className="stack">
          <input type="hidden" name="team" value={team} />
          <fieldset className="choices">
            <legend>In</legend>
            <label className="check">
              <input type="radio" name="unit" value="subscription" defaultChecked={unit === "subscription"} />
              <span>
                Percent of a subscription's week: 60 is three fifths of one subscription's weekly limit, 150 one and a half subscriptions'
                {week ? ` (one is about ${dollars(week)} API-equivalent now)` : " (checked once the subscription has been measured)"}
              </span>
            </label>
            <label className="check">
              <input type="radio" name="unit" value="usd" defaultChecked={unit === "usd"} />
              <span>Dollars, API-equivalent</span>
            </label>
          </fieldset>
          <p className="hint">
            Blank for no limit. At four fifths of a limit you get an email; at the limit the team pauses after the work under way; a tenth past it, now.
          </p>
          <div className="inline">
            <label htmlFor="budget-daily">
              A day
              <input id="budget-daily" name="daily" inputMode="decimal" defaultValue={limits?.daily ?? ""} autoComplete="off" />
            </label>
            <label htmlFor="budget-weekly">
              A week
              <input id="budget-weekly" name="weekly" inputMode="decimal" defaultValue={limits?.weekly ?? ""} autoComplete="off" />
            </label>
            <label htmlFor="budget-total">
              In all
              <input id="budget-total" name="total" inputMode="decimal" defaultValue={limits?.total ?? ""} autoComplete="off" />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" name="autoResume" value="yes" defaultChecked={limits?.autoResume ?? false} />
            <span>When the budget paused the team for a day or a week, start it again when the next one starts</span>
          </label>
          {limits ? (
            <label className="check">
              <input type="checkbox" name="restart" value="yes" />
              <span>Count "in all" from now (it's counted since {dayMonth.format(new Date(limits.since))})</span>
            </label>
          ) : null}
          <label htmlFor="budget-code">
            Code from your authenticator
            <input id="budget-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
          </label>
          <div>
            <SubmitButton>{limits ? "Change the budget" : "Set the budget"}</SubmitButton>
          </div>
        </form>
      </details>
    </section>
  );
}
