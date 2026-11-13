"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { REPO_NAME, slugOf, START_LIMITS, START_TEAM } from "../../../lib/tasks/start.ts";
import { SubscriptionOrder } from "../../components/subscription-order.tsx";
import { startProjectAction, type StartFormState } from "./actions.ts";

// A Mac of the person's own that starts projects, as its last report said.
export interface StartMachine {
  id: string;
  name: string;
  up: boolean;
  dir: string;
  repos: string[];
  subscriptions: { name: string; percent: number | null }[];
  // The teams it runs already, by name: a new one can't take one of theirs.
  teams: string[];
}

const PERIODS = [
  ["daily", "A day", "a day"],
  ["weekly", "A week", "a week"],
  ["total", "In all", "in all"],
] as const;

// The form that asks a Mac to start a project. The short name and the new repository's folder follow the title until
// one of them is typed in; what was typed comes back with a refusal; and the last panel says the whole ask back before
// it's sent, the budget and the subscriptions too, since leaving either blank is a choice.
export function StartForm({ machines, taken, initial }: { machines: StartMachine[]; taken: string[]; initial: StartFormState }) {
  const [state, action, pending] = useActionState(startProjectAction, initial);
  const [machineId, setMachineId] = useState(state.machine || machines[0]?.id || "");
  const machine = machines.find((m) => m.id === machineId) ?? machines[0];
  const [repo, setRepo] = useState<"new" | "existing">(state.repo);
  const [title, setTitle] = useState(state.title);
  const [name, setName] = useState(state.name);
  const [create, setCreate] = useState(state.create);
  // Typed in by hand: it no longer follows the title.
  const [ownName, setOwnName] = useState(state.name !== "" && state.name !== slugOf(state.title));
  const [ownCreate, setOwnCreate] = useState(state.create !== "" && state.create !== state.name);
  const [existing, setExisting] = useState(state.existing);
  const [length, setLength] = useState(state.goal.length);
  const [unit, setUnit] = useState(state.unit);
  const [amounts, setAmounts] = useState({ daily: state.daily, weekly: state.weekly, total: state.total });
  const [use, setUse] = useState(state.use);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.error) alert.current?.focus();
  }, [state]);
  if (!machine) return null;

  const typedTitle = (value: string) => {
    setTitle(value);
    const slug = slugOf(value);
    if (!ownName) setName(slug);
    if (!ownCreate) setCreate(ownName ? name : slug);
  };
  const typedName = (value: string) => {
    setName(value);
    setOwnName(true);
    if (!ownCreate) setCreate(value);
  };
  const nameTaken = name !== "" && (taken.includes(name) || machine.teams.includes(name));
  const nameWrong = name !== "" && !START_TEAM.test(name);
  const createTaken = repo === "new" && create !== "" && machine.repos.includes(create);
  const createWrong = repo === "new" && create !== "" && !REPO_NAME.test(create);
  const folder = repo === "new" ? create : existing || machine.repos[0] || "";
  const sign = unit === "subscription" ? "%" : "$";
  // What the form still needs before it can be sent, each with the field it means: the key waits for these, and says so.
  const missing: [string, string][] = [];
  if (!title.trim()) missing.push(["a title", "start-title"]);
  if (!name || nameTaken || nameWrong) missing.push([name ? "another short name" : "a short name", "start-name"]);
  if (!length) missing.push(["what should exist when the team is done", "start-goal"]);
  if (repo === "new" ? !create || createTaken || createWrong : !folder)
    missing.push([repo === "existing" ? "a repository" : create ? "another folder" : "a folder", "start-folder"]);
  const ready = missing.length === 0;
  const known = machine.subscriptions.map((sub) => sub.name);
  const chosen = use.filter((sub) => known.includes(sub));
  const limits = PERIODS.flatMap(([key, , words]) => {
    const value = amounts[key].trim().replace(/^\$/, "").replace(/%$/, "");
    return value && Number(value) > 0 ? [`${sign === "$" ? "$" : ""}${value}${sign === "%" ? "%" : ""} ${words}`] : [];
  });
  return (
    // Made again from each answer, so what wasn't typed into state keeps what was sent (React resets a form after its
    // action).
    <form key={JSON.stringify(state)} action={action} className="start stack">
      {state.error ? (
        <p className="notice error" role="alert" tabIndex={-1} ref={alert}>
          {state.error}
        </p>
      ) : null}

      <section className="panel step" aria-labelledby="step-what">
        <h2 id="step-what">
          <span className="num" aria-hidden="true">
            1
          </span>
          What to build
        </h2>
        {/* A field's hint sits beside its label, not in it: the label stays the field's name, the hint what's read after.
            An example is in the hint, never in the field, where it would read as typed. */}
        <div className="field">
          <label htmlFor="start-title">Title</label>
          <input
            id="start-title"
            name="title"
            required
            maxLength={START_LIMITS.title}
            value={title}
            onChange={(event) => typedTitle(event.target.value)}
            autoComplete="off"
            aria-describedby="title-hint"
          />
          <p id="title-hint" className="hint">
            What you call it, such as "Shop redesign".
          </p>
        </div>
        <div className="field">
          <label htmlFor="start-name">Short name</label>
          <input
            id="start-name"
            name="name"
            required
            maxLength={31}
            value={name}
            onChange={(event) => typedName(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="code"
            aria-describedby="name-hint"
            aria-invalid={nameTaken || nameWrong}
          />
          <p id="name-hint" className={nameTaken || nameWrong ? "hint wrong" : "hint"}>
            {nameTaken
              ? `There's a team named ${name} already.`
              : nameWrong
                ? "Lowercase letters, digits and dashes, starting with a letter."
                : "The team's name in links and commands, made from the title until you type one. It can't be changed later."}
          </p>
        </div>
        <div className="field">
          <label htmlFor="start-goal">What should exist when the team is done</label>
          <textarea
            id="start-goal"
            name="goal"
            required
            rows={9}
            maxLength={START_LIMITS.goal}
            defaultValue={state.goal}
            onChange={(event) => setLength(event.target.value.length)}
            placeholder={"Who it's for, what they can do with it, and what done looks like. A sentence is enough; a spec is welcome."}
            aria-describedby="goal-hint"
          />
          <p id="goal-hint" className="hint">
            <span className="count">
              {length.toLocaleString("en-GB")} of {START_LIMITS.goal.toLocaleString("en-GB")}
            </span>
            In your words: it goes into the team's brief as written. Whatever it leaves open, the team decides and writes down.
          </p>
        </div>
        <fieldset className="choices">
          <legend>Who chooses the platform and the stack</legend>
          <label className="check choice">
            <input type="radio" name="technical" value="yes" defaultChecked={state.technical} />
            <span>
              I approve them first
              <span className="hint">
                The team builds the skeleton and its checks, proposes what it's built on, and builds no feature until you've agreed.
              </span>
            </span>
          </label>
          <label className="check choice">
            <input type="radio" name="technical" value="no" defaultChecked={!state.technical} />
            <span>
              The team chooses
              <span className="hint">It picks the safer option each time and never asks you about either. It asks you about the product only.</span>
            </span>
          </label>
        </fieldset>
      </section>

      <section className="panel step" aria-labelledby="step-where">
        <h2 id="step-where">
          <span className="num" aria-hidden="true">
            2
          </span>
          Where it runs
        </h2>
        {machines.length > 1 ? (
          <label>
            Mac
            <select name="machine" value={machine.id} onChange={(event) => setMachineId(event.target.value)}>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.up ? "" : " (not reporting)"}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="machine" value={machine.id} />
        )}
        <p className="where">
          <b className="code">{machine.name}</b>
          <span className={`chip ${machine.up ? "ok" : "caution"}`}>{machine.up ? "reporting" : "not reporting"}</span>
          <span className="muted">
            starts projects in <code>{machine.dir}</code>
          </span>
        </p>
        {machine.up ? null : (
          <p className="hint">
            {machine.name} hasn't reported for a quarter of an hour. The ask waits for it for a day; nothing starts until it's on with its watchdog
            running.
          </p>
        )}
        <fieldset className="choices">
          <legend>Repository</legend>
          <label className="check choice">
            <input type="radio" name="repo" value="new" checked={repo === "new"} onChange={() => setRepo("new")} />
            <span>
              A new one
              <span className="hint">The Mac makes it, with a README that holds the title and what you wrote above.</span>
            </span>
          </label>
          <label className="check choice">
            <input
              type="radio"
              name="repo"
              value="existing"
              checked={repo === "existing"}
              onChange={() => setRepo("existing")}
              disabled={!machine.repos.length}
            />
            <span>
              One that's there already
              <span className="hint">
                {machine.repos.length
                  ? `${machine.repos.length} in ${machine.dir} with no team yet. The team works in a checkout of its own, beside it.`
                  : `None in ${machine.dir} without a team.`}
              </span>
            </span>
          </label>
        </fieldset>
        <div className="field">
          {repo === "new" ? (
            <>
              <label htmlFor="start-folder">Folder</label>
              <input
                id="start-folder"
                name="create"
                required
                maxLength={64}
                value={create}
                onChange={(event) => {
                  setCreate(event.target.value);
                  setOwnCreate(true);
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="code"
                aria-describedby="folder-hint"
                aria-invalid={createTaken || createWrong}
              />
            </>
          ) : (
            <>
              <label htmlFor="start-folder">Repository</label>
              <select
                id="start-folder"
                name="existing"
                value={folder}
                onChange={(event) => setExisting(event.target.value)}
                aria-describedby="folder-hint"
              >
                {machine.repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </>
          )}
          {createTaken || createWrong ? (
            <p id="folder-hint" className="hint wrong">
              {createTaken
                ? `${machine.name} has a repository named ${create} already: choose it instead, or name this one differently.`
                : "Letters, digits, dots, dashes and underscores."}
            </p>
          ) : (
            <p id="folder-hint" className="hint paths">
              {folder ? (
                <>
                  {repo === "new" ? "Makes" : "Uses"} <code>{`${machine.dir}/${folder}`}</code>; the team works in{" "}
                  <code>{`${machine.dir}/${folder}-a6g`}</code>.
                </>
              ) : (
                `It's made in ${machine.dir}, named after the short name until you type one, with the team's checkout beside it.`
              )}
            </p>
          )}
        </div>
      </section>

      <section className="panel step" aria-labelledby="step-spend">
        <h2 id="step-spend">
          <span className="num" aria-hidden="true">
            3
          </span>
          What it may spend
        </h2>
        <fieldset className="choices budget">
          <legend>
            Budget <span className="optional">optional</span>
          </legend>
          <p className="hint">
            Leave a limit blank for none. At four fifths of one you get an email; at the limit the team pauses after the work under way. You can change it
            from the team's page at any time.
          </p>
          <div className="segments" role="radiogroup" aria-label="The budget is in">
            <label>
              <input type="radio" name="unit" value="usd" checked={unit === "usd"} onChange={() => setUnit("usd")} />
              <span>Dollars</span>
            </label>
            <label>
              <input type="radio" name="unit" value="subscription" checked={unit === "subscription"} onChange={() => setUnit("subscription")} />
              <span>Percent of a subscription's week</span>
            </label>
          </div>
          <div className="inline amounts">
            {PERIODS.map(([key, label]) => (
              <label key={key} htmlFor={`start-${key}`}>
                {label}
                <span className="amount">
                  {sign === "$" ? <span aria-hidden="true">$</span> : null}
                  <input
                    id={`start-${key}`}
                    name={key}
                    inputMode="decimal"
                    value={amounts[key]}
                    onChange={(event) => setAmounts({ ...amounts, [key]: event.target.value })}
                    autoComplete="off"
                    aria-label={`${label}, in ${sign === "$" ? "dollars" : "percent of a subscription's week"}`}
                  />
                  {sign === "%" ? <span aria-hidden="true">%</span> : null}
                </span>
              </label>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" name="autoResume" value="yes" defaultChecked={state.autoResume} />
            <span>When the budget paused the team for a day or a week, start it again when the next one starts</span>
          </label>
        </fieldset>
        <fieldset className="choices">
          <legend>
            Claude subscriptions, in order <span className="optional">optional</span>
          </legend>
          <p className="hint">The team starts on the first and moves down the list when one is used up.</p>
          <SubscriptionOrder
            key={machine.id}
            options={machine.subscriptions}
            initial={state.use}
            empty={`it runs on ${machine.name}'s own login`}
            onChange={setUse}
          />
        </fieldset>
      </section>

      <section className="panel step commit" aria-labelledby="step-start">
        <h2 id="step-start">
          <span className="num" aria-hidden="true">
            4
          </span>
          Start it
        </h2>
        {/* The ask, said back: what's blank is a choice too. */}
        <dl className="facts recap">
          <dt>Team</dt>
          <dd>{name ? <span className="code">{name}</span> : <span className="muted">not named yet</span>}</dd>
          <dt>Runs on</dt>
          <dd>
            {machine.name}, {repo === "new" ? "in a new repository" : "in"} {folder ? <span className="code">{`${machine.dir}/${folder}`}</span> : "…"}
          </dd>
          <dt>Budget</dt>
          <dd>{limits.length ? limits.join(", ") : <b>none: it spends without a limit</b>}</dd>
          <dt>Subscriptions</dt>
          <dd>{chosen.length ? chosen.join(", then ") : `${machine.name}'s own login`}</dd>
        </dl>
        <p className="small">{machine.name} picks this up within five minutes and runs agents on your subscription from then on.</p>
        <div>
          <h3 className="small">It won&apos;t</h3>
          <ul className="hint tight">
            <li>
              touch anything outside <code>{machine.dir}</code>
            </li>
            <li>deploy, publish or pay for anything: a new team&apos;s rules deny all three</li>
            <li>start a second project on {machine.name} until this one is up</li>
          </ul>
        </div>
        {/* The code, and the key that sends it, side by side. */}
        <div className="field">
          <label htmlFor="start-code">
            <span>
              Code from your authenticator <span className="optional">6 digits</span>
            </span>
          </label>
          <div className="code-row">
            <input
              id="start-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              required
              className="code six"
            />
            <button type="submit" className="primary" disabled={pending || !ready} aria-describedby={ready ? undefined : "start-missing"}>
              {pending ? "Asking…" : "Start the project"}
            </button>
          </div>
          {/* A key that waits says what for, each part a way to the field it means. */}
          {ready ? null : (
            <p className="hint" id="start-missing">
              Needs{" "}
              {missing.map(([words, field], index) => (
                <span key={field}>
                  {index ? (index === missing.length - 1 ? " and " : ", ") : ""}
                  <a href={`#${field}`}>{words}</a>
                </span>
              ))}
              .
            </p>
          )}
        </div>
      </section>
    </form>
  );
}
