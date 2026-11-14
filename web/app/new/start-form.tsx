"use client";
import { type ReactNode, useActionState, useEffect, useRef, useState } from "react";
import { BRANCH_NAME, githubRepoOf, REPO_NAME, slugOf, START_LIMITS, START_TEAM } from "../../../lib/tasks/start.ts";
import { Command } from "../../components/command.tsx";
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
  // Whether its factory reads the newer choices (GitHub, the team's rules, waiting once set up), and the GitHub account
  // it clones, forks and makes repositories as (null: it isn't signed in).
  newer: boolean;
  github: string | null;
}

const PERIODS = [
  ["daily", "A day", "a day"],
  ["weekly", "A week", "a week"],
  ["total", "In all", "in all"],
] as const;

const LEVELS = [
  ["hands-on", "Hands-on", "It asks you about most choices it would otherwise make itself."],
  ["balanced", "Balanced", "It asks you about what's yours to say (the product, money, anything outside the repository) and decides the rest."],
  ["hands-off", "Hands-off", "It decides all it can and asks you only what it can't, writing down each call it made for you to review."],
] as const;

// One choice of a group: a radio, its name, and what it means, under it.
function Choice({ label, hint, ...input }: { label: ReactNode; hint: ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="check choice">
      <input type="radio" {...input} />
      <span>
        {label}
        <span className="hint">{hint}</span>
      </span>
    </label>
  );
}

// The form that asks a Mac to start a project, in the order the Mac goes: what to build, where its code comes from,
// how the team works with you, what it may spend, and when it starts. The short name and a new repository's folder
// follow the title until one of them is typed in; what was typed comes back with a refusal; and the last panel says
// the whole ask back before it's sent, since leaving something blank is a choice too.
export function StartForm({ machines, taken, initial }: { machines: StartMachine[]; taken: string[]; initial: StartFormState }) {
  const [state, action, pending] = useActionState(startProjectAction, initial);
  const [machineId, setMachineId] = useState(state.machine || machines[0]?.id || "");
  const machine = machines.find((m) => m.id === machineId) ?? machines[0];
  const [repo, setRepo] = useState<StartFormState["repo"]>(state.repo);
  const [title, setTitle] = useState(state.title);
  const [name, setName] = useState(state.name);
  const [create, setCreate] = useState(state.create);
  // Typed in by hand: it no longer follows the title.
  const [ownName, setOwnName] = useState(state.name !== "" && state.name !== slugOf(state.title));
  const [ownCreate, setOwnCreate] = useState(state.create !== "" && state.create !== state.name);
  const [existing, setExisting] = useState(state.existing);
  const [github, setGithub] = useState(state.github);
  const [base, setBase] = useState(state.base);
  const [trusted, setTrusted] = useState(state.trusted);
  const [technical, setTechnical] = useState(state.technical);
  const [mode, setMode] = useState(state.mode);
  const [approval, setApproval] = useState(state.approval);
  const [level, setLevel] = useState(state.level);
  // What it may do on GitHub follows where the code comes from until it's chosen: nothing for a repository already on
  // the Mac (its origin may be anywhere), a pull request for one on GitHub.
  const [push, setPush] = useState(state.push);
  const [ownPush, setOwnPush] = useState(state.push !== (state.repo === "existing" ? "none" : "pull-request"));
  const [hold, setHold] = useState(state.hold);
  const [publish, setPublish] = useState(state.publish);
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
  // A Mac on an older factory, or one not signed in to GitHub, can't take what it doesn't read: what the form says of
  // its aim and of waiting holds only where it's sent.
  const source: StartFormState["repo"] = !machine.newer && (repo === "github" || repo === "new-github") ? "new" : repo;
  const aim = machine.newer ? mode : "finish";
  const waitsForMe = machine.newer && hold;
  const makes = source === "new" || source === "new-github";
  const login = machine.github;
  const named = source === "github" ? githubRepoOf(github) : null;
  const theirs = named !== null && named.owner.toLowerCase() !== (login ?? "").toLowerCase();
  // The fork the Mac makes when its account can't push to someone else's repository.
  const fork = named && theirs && login ? `${login}/${named.name}` : null;
  const nameTaken = name !== "" && (taken.includes(name) || machine.teams.includes(name));
  const nameWrong = name !== "" && !START_TEAM.test(name);
  const createTaken = makes && create !== "" && machine.repos.includes(create);
  const createWrong = makes && create !== "" && !REPO_NAME.test(create);
  const githubThere = named !== null && machine.repos.includes(named.name);
  const folder = makes ? create : source === "existing" ? existing || machine.repos[0] || "" : (named?.name ?? "");
  const canBase = machine.newer && (source === "existing" || source === "github");
  const baseWrong = canBase && base !== "" && !BRANCH_NAME.test(base);
  const onGithub = source === "github" || source === "new-github";
  const pushes: StartFormState["push"] = source === "new" ? "none" : ownPush ? push : source === "existing" ? "none" : "pull-request";
  // The branch its pull requests go into: a name, or the repository's default in words.
  const into = canBase && base ? <code>{base}</code> : source === "github" || source === "existing" ? "its default branch" : <code>main</code>;
  // The repository on GitHub the team pushes to.
  const target =
    source === "github" && named ? (
      fork ? (
        <>
          <code>{named.full}</code>, or the fork <code>{fork}</code>
        </>
      ) : (
        <code>{named.full}</code>
      )
    ) : source === "new-github" && login && folder ? (
      <code>{`${login}/${folder}`}</code>
    ) : (
      "its origin"
    );
  const sign = unit === "subscription" ? "%" : "$";
  // What the form still needs before it can be sent, each with the field it means: the key waits for these, and says so.
  const missing: [string, string][] = [];
  if (!title.trim()) missing.push(["a title", "start-title"]);
  if (!name || nameTaken || nameWrong) missing.push([name ? "another short name" : "a short name", "start-name"]);
  if (!length) missing.push([aim === "cycles" ? "what it should work toward" : "what should exist when the team is done", "start-goal"]);
  if (source === "github") {
    if (!named || githubThere) missing.push([named ? "another GitHub repository" : "a GitHub repository", "start-github"]);
    else if (theirs && !trusted) missing.push(["your word that you trust its code", "start-trusted"]);
  } else if (makes ? !create || createTaken || createWrong : !folder)
    missing.push([source === "existing" ? "a repository" : create ? "another folder" : "a folder", "start-folder"]);
  if (onGithub && !login) missing.push([`${machine.name} signed in to GitHub`, "repo-github"]);
  if (baseWrong) missing.push(["a branch's name for the base", "start-base"]);
  const ready = missing.length === 0;
  const known = machine.subscriptions.map((sub) => sub.name);
  const chosen = use.filter((sub) => known.includes(sub));
  const limits = PERIODS.flatMap(([key, , words]) => {
    const value = amounts[key].trim().replace(/^\$/, "").replace(/%$/, "");
    return value && Number(value) > 0 ? [`${sign === "$" ? "$" : ""}${value}${sign === "%" ? "%" : ""} ${words}`] : [];
  });
  const path = (folderName: string) => <code>{`${machine.dir}/${folderName}`}</code>;
  const update = (
    <>
      To do either, update it: in its Anything Factory checkout, run
      <Command>git pull && npm install && node bin/a6g.ts self-install</Command>
      <span className="then">This form offers the rest once {machine.name} reports the new version.</span>
    </>
  );
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
        {/* Its aim first: it says what the brief below is. */}
        {machine.newer ? (
          <fieldset className="choices pair">
            <legend>Its aim</legend>
            <Choice
              name="mode"
              value="finish"
              checked={mode === "finish"}
              onChange={() => setMode("finish")}
              label="A finish line"
              hint="It builds what you write below, checks it holds, tells you it's done, and stops."
            />
            <Choice
              name="mode"
              value="cycles"
              checked={mode === "cycles"}
              onChange={() => setMode("cycles")}
              label="In cycles"
              hint="It keeps improving toward what you write below, a cycle at a time with a report each, and rests when nothing's left."
            />
          </fieldset>
        ) : null}
        <div className="field">
          <label htmlFor="start-goal">{aim === "cycles" ? "What it should work toward" : "What should exist when the team is done"}</label>
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
          {machine.newer ? null : <span className="chip caution">older factory</span>}
          <span className="muted">
            starts projects in <code>{machine.dir}</code>
            {machine.newer ? (
              login ? (
                <>
                  , on GitHub as <b className="code">{login}</b>
                </>
              ) : (
                ", not signed in to GitHub"
              )
            ) : null}
          </span>
        </p>
        {machine.up ? null : (
          <p className="hint">
            {machine.name} hasn't reported for a quarter of an hour. The ask waits for it for a day; nothing starts until it's on with its watchdog
            running.
          </p>
        )}
        {machine.newer ? null : (
          <div className="older stack">
            <p className="hint">
              {machine.name} runs an older factory, so it can&apos;t start from GitHub or take the team&apos;s rules from this form. {update}
            </p>
          </div>
        )}
        <fieldset className="choices" id="repo-github">
          <legend>Where the code comes from</legend>
          <Choice
            name="repo"
            value="new"
            checked={source === "new"}
            onChange={() => setRepo("new")}
            label="A new repository, on this Mac"
            hint="The Mac makes it, with a README that holds the title and what you wrote above."
          />
          {machine.newer ? (
            <Choice
              name="repo"
              value="new-github"
              checked={source === "new-github"}
              onChange={() => setRepo("new-github")}
              disabled={!login}
              label="A new repository, on GitHub too"
              hint={
                login ? (
                  <>
                    Made the same way, then created under <span className="code">{login}</span> on GitHub and pushed there.
                  </>
                ) : (
                  `Needs ${machine.name} signed in to GitHub (gh auth login).`
                )
              }
            />
          ) : null}
          <Choice
            name="repo"
            value="existing"
            checked={source === "existing"}
            onChange={() => setRepo("existing")}
            disabled={!machine.repos.length}
            label="One already on this Mac"
            hint={
              machine.repos.length ? (
                <>
                  {machine.repos.length} in <code>{machine.dir}</code> with no team yet. The team works in a checkout of its own, beside it.
                </>
              ) : (
                <>
                  None in <code>{machine.dir}</code> without a team.
                </>
              )
            }
          />
          {machine.newer ? (
            <Choice
              name="repo"
              value="github"
              checked={source === "github"}
              onChange={() => setRepo("github")}
              disabled={!login}
              label="One on GitHub"
              hint={
                login ? (
                  <>
                    By owner/name or its address, fetched as <span className="code">{login}</span>.
                  </>
                ) : (
                  `Needs ${machine.name} signed in to GitHub (gh auth login).`
                )
              }
            />
          ) : null}
        </fieldset>
        {source === "github" ? (
          <div className="field">
            <label htmlFor="start-github">Repository on GitHub</label>
            <input
              id="start-github"
              name="github"
              required
              maxLength={200}
              value={github}
              onChange={(event) => {
                setGithub(event.target.value);
                // The tick was for the repository named then.
                setTrusted(false);
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="code"
              aria-describedby="github-hint"
              aria-invalid={(github !== "" && !named) || githubThere}
            />
            <p id="github-hint" className={(github !== "" && !named) || githubThere ? "hint wrong" : "hint paths"}>
              {github !== "" && !named ? (
                "As owner/name, like octocat/hello-world, or its address on github.com."
              ) : githubThere ? (
                `${machine.name} has ${named?.name} in its folder already: choose it under "One already on this Mac".`
              ) : named ? (
                <>
                  {fork ? (
                    <>
                      Not <span className="code">{login}</span>&apos;s. When {machine.name} picks this up it asks GitHub: if{" "}
                      <span className="code">{login}</span> can push to it, it&apos;s cloned; if not, it&apos;s forked to <code>{fork}</code> first and the
                      fork is cloned.
                    </>
                  ) : (
                    <>{login}&apos;s own: cloned.</>
                  )}{" "}
                  Into {path(named.name)}; the team works in {path(`${named.name}-a6g`)}.
                </>
              ) : (
                "As owner/name, or paste its address."
              )}
            </p>
          </div>
        ) : (
          <div className="field">
            {makes ? (
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
                    {makes ? "Makes" : "Uses"} {path(folder)}
                    {source === "new-github" && login ? (
                      <>
                        {" "}
                        and <code>{`${login}/${folder}`}</code> on GitHub
                      </>
                    ) : null}
                    ; the team works in {path(`${folder}-a6g`)}.
                  </>
                ) : (
                  <>
                    It&apos;s made in <code>{machine.dir}</code>, named after the short name until you type one, with the team&apos;s checkout beside it.
                  </>
                )}
              </p>
            )}
          </div>
        )}
        {source === "new-github" ? (
          <fieldset className="choices">
            <legend>Who can see it on GitHub</legend>
            <div className="segments" role="radiogroup" aria-label="Who can see it on GitHub">
              <label>
                <input type="radio" name="publish" value="private" checked={publish === "private"} onChange={() => setPublish("private")} />
                <span>Private</span>
              </label>
              <label>
                <input type="radio" name="publish" value="public" checked={publish === "public"} onChange={() => setPublish("public")} />
                <span>Public</span>
              </label>
            </div>
            <p className="hint">
              {publish === "public"
                ? "Anyone: its code, and the README with what you wrote above."
                : `Only ${login ?? "its owner"} and whoever ${login ?? "they"} adds.`}
            </p>
          </fieldset>
        ) : null}
        {source === "github" && named && theirs ? (
          <label className={`check trust ids${trusted ? "" : " needed"}`} id="start-trusted">
            <input type="checkbox" name="trusted" value="yes" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
            <span>
              I trust the code in <code>{named.full}</code> to run on <code>{machine.name}</code>
              {trusted ? null : <span className="needed-word">needed to start</span>}
              <span className="hint">Setting the team up installs its packages and runs its scripts and tests there.</span>
            </span>
          </label>
        ) : null}
        {canBase ? (
          <div className="field">
            <label htmlFor="start-base">
              <span>
                Base branch <span className="optional">optional</span>
              </span>
            </label>
            <input
              id="start-base"
              name="base"
              maxLength={100}
              value={base}
              onChange={(event) => setBase(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="code"
              aria-describedby="base-hint"
              aria-invalid={baseWrong}
            />
            <p id="base-hint" className={baseWrong ? "hint wrong" : "hint"}>
              {baseWrong
                ? "A branch's name, like main or develop."
                : "Where the team's work starts from, and its pull requests go into. Blank: the repository's default branch."}
            </p>
          </div>
        ) : null}
      </section>

      <section className="panel step how" aria-labelledby="step-how">
        <h2 id="step-how">
          <span className="num" aria-hidden="true">
            3
          </span>
          How it works with you
        </h2>
        <fieldset className="choices pair">
          <legend>Who chooses the platform and the stack</legend>
          <Choice
            name="technical"
            value="yes"
            checked={technical}
            onChange={() => setTechnical(true)}
            label="I approve them first"
            hint="The team builds the skeleton and its checks, proposes what it's built on, and builds no feature until you've agreed."
          />
          <Choice
            name="technical"
            value="no"
            checked={!technical}
            onChange={() => setTechnical(false)}
            label="The team chooses"
            hint="It picks the safer option each time and never asks you about either. It asks you about the product only."
          />
        </fieldset>
        {machine.newer ? (
          <>
            <fieldset className="choices pair">
              <legend>Who approves new work</legend>
              <Choice
                name="approval"
                value="operator"
                checked={approval === "operator"}
                onChange={() => setApproval("operator")}
                label="I do"
                hint="Every piece of work the planner proposes waits for you in Decisions."
              />
              <Choice
                name="approval"
                value="thresholds"
                checked={approval === "thresholds"}
                onChange={() => setApproval("thresholds")}
                label="The team's approver, up to a medium task"
                hint="An approver joins the team and approves what's small or medium; anything larger comes to you."
              />
            </fieldset>
            <fieldset className="choices">
              <legend>How readily it asks you</legend>
              <div className="segments" role="radiogroup" aria-label="How readily it asks you">
                {LEVELS.map(([value, label]) => (
                  <label key={value}>
                    <input type="radio" name="level" value={value} checked={level === value} onChange={() => setLevel(value)} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <p className="hint">{LEVELS.find(([value]) => value === level)?.[2]} You can change it from the team&apos;s Agreement page.</p>
            </fieldset>
            {source === "new" ? (
              <input type="hidden" name="push" value="none" />
            ) : (
              <fieldset className="choices">
                <legend>What it may do on GitHub</legend>
                {(
                  [
                    ["none", "Nothing", <>Its work stays on {machine.name}. You see it on the board, and merge it yourself.</>],
                    [
                      "branch",
                      "Push its branch",
                      <>
                        Its integration branch, <code>a6g/next</code>, and only that, at most every six hours.
                      </>,
                    ],
                    [
                      "pull-request",
                      "Push its branch and open a pull request",
                      <>
                        Into {into}, for you to merge.{fork ? " On a fork, both go to the fork, never the original." : ""}
                      </>,
                    ],
                  ] as const
                ).map(([value, label, hint]) => (
                  <Choice
                    key={value}
                    name="push"
                    value={value}
                    checked={pushes === value}
                    onChange={() => {
                      setPush(value);
                      setOwnPush(true);
                    }}
                    label={label}
                    hint={hint}
                  />
                ))}
                {source === "existing" && pushes !== "none" ? (
                  <p className="hint">
                    The repository needs an origin remote{pushes === "pull-request" ? " on GitHub" : ""}; the Mac stops and says so if it hasn&apos;t.
                  </p>
                ) : null}
              </fieldset>
            )}
          </>
        ) : (
          <p className="hint">
            The rest is settled by the setup agent until {machine.name} is updated: a finish line, you approving each piece of work, asking you: balanced,
            and nothing pushed.
          </p>
        )}
      </section>

      <section className="panel step" aria-labelledby="step-spend">
        <h2 id="step-spend">
          <span className="num" aria-hidden="true">
            4
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
            5
          </span>
          Start it
        </h2>
        {machine.newer ? (
          <fieldset className="choices pair">
            <legend>When it starts</legend>
            <Choice
              name="hold"
              value="no"
              checked={!hold}
              onChange={() => setHold(false)}
              label="As soon as it's set up"
              hint="Its planner starts once the setup passes its check."
            />
            <Choice
              name="hold"
              value="yes"
              checked={hold}
              onChange={() => setHold(true)}
              label="Set it up, then wait for me"
              hint="Set up and checked, then paused: nothing runs or spends until you resume it from its overview."
            />
          </fieldset>
        ) : null}
        {/* The ask, said back: what's blank is a choice too. */}
        <dl className="facts recap ids">
          <dt>Team</dt>
          <dd>{name ? <span className="code">{name}</span> : <span className="muted">not named yet</span>}</dd>
          <dt>Runs on</dt>
          <dd>
            <span className="code">{machine.name}</span>
          </dd>
          <dt>Repository</dt>
          <dd>
            {source === "github" ? (
              named ? (
                fork ? (
                  <>
                    <code>{named.full}</code>, cloned if {login} can push to it, or forked to <code>{fork}</code> (the Mac checks), into {path(named.name)}
                  </>
                ) : (
                  <>
                    <code>{named.full}</code>, cloned into {path(named.name)}
                  </>
                )
              ) : (
                <span className="muted">not named yet</span>
              )
            ) : folder ? (
              <>
                {path(folder)}
                {source === "new" ? (
                  ", new, on the Mac only"
                ) : source === "new-github" ? (
                  <>
                    , new, and <code>{`${login}/${folder}`}</code> on GitHub ({publish})
                  </>
                ) : (
                  ""
                )}
              </>
            ) : (
              <span className="muted">not named yet</span>
            )}
          </dd>
          <dt>Decides</dt>
          <dd>
            {technical ? "you approve the stack first" : "it chooses the stack"}
            {machine.newer
              ? `; ${approval === "operator" ? "you approve each piece of work" : "its approver approves up to medium, you the rest"}; asks you: ${LEVELS.find(([value]) => value === level)?.[1].toLowerCase()}`
              : ""}
          </dd>
          {machine.newer ? (
            <>
              <dt>Aim</dt>
              <dd>{aim === "cycles" ? "in cycles" : "a finish line"}</dd>
              <dt>On GitHub</dt>
              <dd>
                {pushes === "none" ? (
                  "nothing: its work stays on the Mac"
                ) : (
                  <>
                    pushes <code>a6g/next</code> to {target}
                    {pushes === "pull-request" ? (
                      <>, with a pull request into {typeof into === "string" ? "that repository's default branch" : into}</>
                    ) : null}
                  </>
                )}
              </dd>
            </>
          ) : null}
          <dt>Budget</dt>
          <dd>{limits.length ? limits.join(", ") : <b>none: it spends without a limit</b>}</dd>
          <dt>Subscriptions</dt>
          <dd>{chosen.length ? chosen.join(", then ") : `${machine.name}'s own login`}</dd>
        </dl>
        <p className="small">
          {machine.name} picks this up within five minutes and {waitsForMe ? "sets it up, then waits for you" : "runs it from then on"}.
        </p>
        <div>
          <h3 className="small">It won&apos;t</h3>
          <ul className="hint tight ids">
            <li>
              touch anything outside <code>{machine.dir}</code>
              {source === "github" && named ? (
                <>
                  , or anything on GitHub but <code>{named.full}</code>
                  {fork ? (
                    <>
                      {" "}
                      and <code>{fork}</code>
                    </>
                  ) : null}
                </>
              ) : source === "new-github" && login && folder ? (
                <>
                  , or anything on GitHub but <code>{`${login}/${folder}`}</code>
                </>
              ) : null}
            </li>
            <li>{pushes === "none" ? "push anything anywhere" : "push anything but its own branch, or merge into yours"}</li>
            <li>
              {source === "new-github" && publish === "public"
                ? "deploy or pay for anything: a new team's rules deny both (the new repository itself is public, as you chose)"
                : "deploy, publish or pay for anything: a new team's rules deny all three"}
            </li>
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
              {pending ? "Asking…" : waitsForMe ? "Set up the project" : "Start the project"}
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
