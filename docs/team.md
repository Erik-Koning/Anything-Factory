# `.a6g/team.json` reference

A team's rules, in its checkout. Every part of the factory reads this file through one loader (`lib/config.ts`),
which fills in the defaults below and refuses a file with problems (`a6g check` lists them): a value of the wrong
type, a duration it can't read, a pattern that isn't a valid regular expression. An unknown key, at any level (a
typo such as `watchdog.tickevery`, or a `$comment`), is only a warning, and is ignored: saving one into a running
team's rules doesn't stop it. Agents can't change the file; the guard reads the team checkout's copy, never a
branch's. Editors can validate it with `schema/team.schema.json` (the `$schema` key), which checks the same things,
except what needs two keys at once (an integration branch that's protected, two pages with the same id), and flags
unknown keys where the loader only warns.

Durations are written `45m`, `6h`, `2d` (spaces around them are fine), or as a number of minutes. A command the
team may leave out (`finish`, `afterMerge`, `gate.full`, `environment.script`, …) is none when it's `null` or `""`.

## A minimal team

```json
{
  "$schema": "https://raw.githubusercontent.com/Erik-Koning/Anything-Factory/main/schema/team.schema.json",
  "name": "shop-redesign",
  "owner": "you@example.com",
  "branch": "a6g/next",
  "roles": { "planner": {}, "builder": { "limit": 2 }, "reviewer": { "limit": 1 } },
  "gate": { "full": ".a6g/adapters/gate.sh", "quick": ".a6g/adapters/gate.sh --quick" },
  "finish": "pnpm test"
}
```

## Keys

**Identity**

| Key       | Default                    | Meaning                                                                                                                                                                              |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`    | (required)                 | Lowercase letters, digits and dashes, up to 31 characters. Names the team in `a6g` commands, T3 instances (`a6g-<name>-<role>`) and `~/.a6g/runs/<name>`                             |
| `title`   | `name`                     | Shown in T3 Code, emails (`[<title>] …`) and prompts; `""` is the name too                                                                                                           |
| `owner`   | none                       | The operator's email: the only address the planner may write to                                                                                                                      |
| `factory` | the version `a6g init` ran | The Anything Factory version the team runs (`a6g versions`); `"dev"` for a linked source checkout. `a6g upgrade` moves it. Without one, the team runs whichever version registers it |

**Branches**

| Key                 | Default                                 | Meaning                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `branch`            | (required)                              | The integration branch, never one of `protectedBranches`. It changes only through `a6g merge` and the planner's own commits of its lane. The team's checkout stays on it, and `.a6g/` is committed there (`a6g check` says so) |
| `base`              | `"main"`                                | What the integration branch started from; page checks compare against it unless `pages.base` says otherwise                                                                                                                    |
| `protectedBranches` | `["main","master","production","prod"]` | Never pushed to or merged into by the team. `[]` protects none                                                                                                                                                                 |
| `push`              | `null`                                  | `null` (or `false`) means nothing leaves the machine. Otherwise `{"remote": "origin", "branch": <branch>, "every": "6h"}`: only the planner pushes, only that branch, at most that often                                       |
| `push.pullRequest`  | none                                    | `true` (into `base`) or a branch: after a push, the planner's `a6g pr` opens a pull request into it, or updates the open one, for you to merge. Needs a GitHub remote and `gh`; the `github` policy stays denied               |
| `branchPrefix`      | `"a6g"`                                 | Builders' default branch pattern `^<prefix>/b\d+-` (the number is the ticket); testers' `^<prefix>/t-`                                                                                                                         |

**The team**

| Key                      | Default                                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board`                  | `"tasks"`                                  | `"tasks"` (or `"files"`, the same): the factory's task graph (`a6g task`), kept by the team's `tasks` store. `{"github": {"label": "a6g"}}`: GitHub issues with that label and `<label>:triage\|ready\|building\|review\|blocked\|question\|proposal`; the issues the planner opens also carry `A6G-Planner`, as its email subjects do (`[A6G-Planner] [<title>] …`), so you can filter what the team sends                                                                                               |
| `model`                  | each role's own default                    | The model for every role that names none of its own (`roles.<role>.model`): see [Models](#models)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `operator.technical`     | `true`                                     | Whether you have a view on the platform, the stack and the architecture. `false`: the team never asks you about them. It chooses itself, the safer way each time (managed, mainstream, little to run, a cost with a ceiling), records each choice with its reason, and asks you only what the product should do, what it may cost, and what needs an account or a key of yours. The setup agent sets it from how you write and what you name, without asking; `a6g init --non-technical` says it outright |
| `operator.designCheckIn` | `false`; `true` in a new project's draft   | The team builds the foundation (the skeleton and the browser harness), writes the design down (`docs/architecture.md`: each choice, why, what else was weighed, what it costs to run, how it's changed later), then asks you to agree it, and builds no feature until you have: see [The design check-in](#the-design-check-in). Only with `operator.technical` true and a scaffolder on the team                                                                                                         |
| `roles`                  | planner, builder, reviewer                 | Which roles the team has, and each one's settings. See below                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `review.required`        | `["builder"]`, and `"scaffolder"` with one | Roles whose branches need a reviewer's approval of the exact commit                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `review.removedPattern`  | assertions, with a tester or scaffolder    | A regex; a branch that removes a line matching it needs a review whatever its role. A team with a tester gets one that finds assertions: `expect(…)`, `assert(…)` and `assert.equal(…)`, Python's `assert`, Rust's `assert!(…)`, xUnit's `assertEqual(…)` and `assertThat(…)`, `x.should.…`, and matchers such as `.toBe(…)` and `.toHaveURL(…)`; not `.toString(…)`, nor a helper such as `assertMainBranch(…)`. `null` turns it off                                                                     |
| `review.maxRounds`       | `3`                                        | Rounds of rework a task gets after review asks for changes; the next request for changes blocks it for the planner to split or decide                                                                                                                                                                                                                                                                                                                                                                     |
| `polishRounds`           | `1`                                        | Rounds of minor fixes per page or journey before the last audit (Article 9)                                                                                                                                                                                                                                                                                                                                                                                                                               |

**The task graph**

| Key                  | Default                                                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`               | `"finish"`                                                             | `"finish"`: work until the finish line holds, then stop. `"cycles"`: keep building toward the direction, cycle after cycle (`a6g cycle close`), resting when nothing is left until a request or a task arrives                                                                                                                                                                                                                                                                              |
| `tasks.store`        | `"files"`                                                              | `"files"`: one JSON document per task in the run folder (`~/.a6g/runs/<team>/tasks/`). `"mongo"`: in MongoDB, shared by the team's machines (`a6g connect mongo` on each)                                                                                                                                                                                                                                                                                                                   |
| `tasks.database`     | `"a6g"`                                                                | The Mongo database; documents carry the team's name, so teams can share one                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tasks.lead`         | none                                                                   | With Mongo: the always-on machine (its name from `a6g connect mongo --machine`) that runs the planner, the reviews and the merge queue; a machine name (lowercase letters, digits, dashes). It pushes the integration branch after every merge, whatever `push.every` says. Other machines register with `a6g register --worker` and run builders only. Name exactly one lead. Needs `push`: code moves through the remote. Run `a6g register` again on each machine after changing `tasks` |
| `priorities.weights` | pain 3; reach, revenue, wow, leverage 2; distribution, urgency, risk 1 | How the planner's 0–3 scores are weighed into a task's priority                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `approval.mode`      | `"thresholds"`                                                         | Who approves the planner's proposals: `"operator"` (you, with `a6g task approve` or `a6g serve`), `"thresholds"` (the approver up to `maxSize`; larger work escalated to you. A journey only groups tasks, so it needs no approval of its own), `"full"` (the approver alone). Without an approver role, every approval is yours                                                                                                                                                            |
| `approval.maxSize`   | `"M"`                                                                  | The largest size the approver approves in thresholds mode: `S`, `M`, `L` or `XL`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `approval.findings`  | `"planner"`                                                            | Who approves the bug, UX and test findings other members file: `"planner"` (they aren't its own), or `"approver"`, with the proposals                                                                                                                                                                                                                                                                                                                                                       |
| `critical`           | `[]`                                                                   | Regexes over paths whose changes get the full review whatever their size; `a6g blast` and the task's record name the ones a change reaches                                                                                                                                                                                                                                                                                                                                                  |

**Checks and environment**

| Key                       | Default                       | Meaning                                                                                                                                                            |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gate.full`               | none                          | The checks CI runs. The merge queue runs it on every merged result                                                                                                 |
| `gate.quick`              | `gate.full`                   | What a builder or tester must pass before it may stop. `null` is `gate.full` too; `""` is none                                                                     |
| `gate.concurrency`        | `2`                           | How many gates run at once, across all worktrees (at least 1)                                                                                                      |
| `environment.script`      | none                          | The team's environment (`up`, `down`, `restart`, `reset`, `status`), run by `a6g env` from the team's checkout                                                     |
| `environment.health`      | `[]`                          | `http://` or `https://` URLs the watchdog checks; `any:<url>` accepts any HTTP answer. When one is down, it tells the planner                                      |
| `environment.needsDocker` | `false`                       | The watchdog starts Docker when it isn't running                                                                                                                   |
| `afterMerge`              | none                          | Run after each merge, under the app lock, with `BEFORE`, `AFTER` and `A6G_LIGHT`. Lines starting with `after:`, `journeys:` or `pages:` go into the merge's report |
| `finish`                  | none                          | The finish line: a command that exits 0 only when the work is done                                                                                                 |
| `progress`                | `finish` with `done`→`status` | Where the work stands, for `a6g progress`. `null` is the default too; `""` is none                                                                                 |
| `pages`                   | none                          | For `a6g pages` (see below); required when `finish` runs `a6g pages done`                                                                                          |
| `worktreeSetup`           | none                          | Run by T3 Code in every new member worktree (install dependencies)                                                                                                 |

**Rules**

| Key             | Default                                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policies`      | all outward denied; `secrets` and `dependencies` allowed | Unlock (or deny) a policy: `{"deploy": "allow", "dependencies": "deny"}`. The policies: `deploy`, `cloud`, `hosted-data`, `publish`, `github`, `messages`, `network`, `payments`, `secrets`, `dependencies` (`lib/policies.ts`)                                                                                                                                                                                                                                                                            |
| `never`         | `[]`                                                     | The team's own command rules: `{"rule": "<regex>", "reason": "<what the agent is told>", "example": "<a command it must refuse>"}`. `a6g check` tests each example. A rule is matched against one command at a time (wrappers such as `env`, `npx` and `pnpm --filter … exec` unwrapped), free text included: what `echo` writes, commit messages and issue bodies (the policies' rules for commands leave that text out; their rules for live keys, hosted databases' addresses and webhooks read it too) |
| `commandOwners` | `[]`                                                     | Commands only some roles run: `{"rule": "<regex>", "roles": ["ux-specialist"], "reason": "…"}`. The roles are role names                                                                                                                                                                                                                                                                                                                                                                                   |
| `protect`       | `[]`                                                     | Regexes over paths (from the checkout's root) written by the team's scripts only, such as a test runner's results                                                                                                                                                                                                                                                                                                                                                                                          |

**Context and isolation**

| Key               | Default                                                                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs`            | `[".a6g/brief.md", ".a6g/notes.md"]`                                                    | What every member reads first. `CLAUDE.md` is always in context                                                                                                                                                                                                                                                                                                                                                                                                               |
| `context`         | `[]`                                                                                    | `{"title": "Journeys", "command": "…"}`: commands whose output the planner sees at every session start (kept short)                                                                                                                                                                                                                                                                                                                                                           |
| `vars`            | `{}`                                                                                    | Extra environment variables for every member, as text: a number or `true`/`false` is turned into text, with a warning. `${home}` and `${run}` are replaced with the checkout and run folder. Names can't start with `A6G_`, which the factory sets, or be `CLAUDE_PROJECT_DIR`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT` or `CLAUDE_ENV_FILE`, which say where a member runs; Claude Code's tuning variables, such as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, are the team's to set |
| `isolation`       | `"strict"`                                                                              | `"strict"`: members load only the project's settings (`--setting-sources project`), not your personal skills, plugins or hooks, and members other than the planner see only T3 Code's tools (`--strict-mcp-config`). `"user"` loads your user settings too                                                                                                                                                                                                                    |
| `watchdog`        | `{"tickEvery": "10m", "stuckAfter": "45m", "pruneAfter": "1h", "doneTickEvery": "24h"}` | How often an idle planner is ticked, when silence counts as stuck, when finished members' worktrees are removed (only clean ones of completed members; an interrupted, failed or cancelled member's are kept a week, and any with work in them stay), and the nightly tick once complete                                                                                                                                                                                      |
| `contact`         | `{"mode": "digest", "every": "4h"}`                                                     | How often the planner's messages reach the operator. `"digest"`: at most one message per `every`, with every open question in it; a subject starting `Urgent:` goes at once, one per `every`; `Done` always goes. `"priority"`: each message goes as soon as the planner sends it. The guard holds the planner's own email to it; the watchdog holds its outbox (`a6g register` again to pass a change to the watchdog)                                                       |
| `startPrompt`     | a standard one                                                                          | The planner's first message                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `t3ProjectId`     | assigned by register                                                                    | Only to reuse an existing T3 Code project; `null` until register assigns one                                                                                                                                                                                                                                                                                                                                                                                                  |
| `legacyInstances` | `{}`                                                                                    | `{"<old instance id>": "<role>"}`, so metrics and limits count members started on instances from before a migration                                                                                                                                                                                                                                                                                                                                                           |

## Roles

Each entry in `roles` takes:

| Key         | Meaning                                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`     | At most this many at once (not for the planner). The guard counts them live in T3 Code                                                                                                                                                                           |
| `write`     | Regexes over paths the role may write, or `"*"` for anything. The factory's own files (`.a6g/`, `.claude/settings*.json`, `.claude/hooks/`, `.claude/agents/`) stay closed unless a rule names the path itself, like the planner's default `^\.a6g/lessons\.md$` |
| `deny`      | Regexes the role may never write, even inside `write`                                                                                                                                                                                                            |
| `branch`    | The role's branch pattern (builders, testers and the scaffolder)                                                                                                                                                                                                 |
| `mcp`       | Outside tools the role may call. The planner has the Gmail tools by default; the guard lets email go only to `owner`                                                                                                                                             |
| `readOnly`  | Changes nothing in the checkout, not even its git state. The default for reviewer, security-reviewer, ux-specialist and innovator                                                                                                                                |
| `compactAt` | (planner) T3 Code compacts the planner's context at this many tokens (default 160000)                                                                                                                                                                            |
| `model`     | The model the role runs on: `fable`, `opus`, `sonnet` or `haiku`, or a model id. See [Models](#models)                                                                                                                                                           |
| `minQueue`  | (innovator) The planner starts the innovator whenever fewer than this many ideas (features not yet started) are queued (default 5; 0 leaves it to the planner)                                                                                                   |

The roles are planner, builder, tester, scaffolder, reviewer, security-reviewer, ux-specialist, innovator and approver
(the reviewer, the security reviewer, the UX specialist, the innovator and the approver are read-only). The security
reviewer reads a branch for what it lets someone do that they shouldn't; a team with one merges some branches only
once it has passed them (`security`, below). The scaffolder owns the means of checking: it sets up and
keeps the test harness and its manifest (`.a6g/harness.json`, which only its lane names), makes a repository's
skeleton, and claims `scaffold` and `test-infra` tasks (and `test` ones where the team has no tester). Its branches are
`a6g/s<id>-…`, and a team with one has `review.required` default to `["builder", "scaffolder"]`. Their prompts are in the factory
(`plugin/agents/<role>.md`). What one team adds for a role goes in `.a6g/roles/<role>.md`, which is compiled into
that role's prompt.

### The design check-in

A new project's first choices (where it runs, its shape, what it's built on) cost the most to change later, and a
team that builds features before you've seen them has made them for you. With `operator.designCheckIn`, `a6g register`
files one `design` task. While it's open, only `scaffold` and `test-infra` tasks are claimed: the scaffolder builds
the skeleton and the harness and writes the design record, and the planner plans. Then the planner raises the task
as a question, with the design in a few lines and what it recommends, and you answer in the web app, with
`a6g task answer <id> "…"`, or by replying to its message where your replies reach the team (`a6g connect email`):
agreed, or what to change. Agreed, it's done and features start. Changes go back to the scaffolder, and the planner
asks again. Only your answer settles it: the approver doesn't decide it, and the planner can't close one you haven't
answered on the task (a reply it reads for itself in Gmail isn't one: it asks you to answer there).
`a6g task status <id> done` (or `rejected`, for none) from you ends it at any time. It's answered, never approved or rejected: `a6g task approve` and `a6g task reject` refuse it, from you too
(a rejected check-in is one you want none of, so a Reject beside the question would have started the features), and
`a6g serve` shows it with what was asked and a box for your answer.

Waiting costs little: once the foundation is merged and the question is with you, the watchdog ticks the planner
hourly rather than every `watchdog.tickEvery`, and your answer reaches it within a minute whenever it comes.

`a6g init` drafts the check-in where nothing is built yet (only documents, pictures and dot-files). It's never held
with an operator who isn't technical: that team makes the same record, and goes on.

### The working agreement

How readily the team asks you isn't in `team.json`: it's the working agreement, which you set with `a6g agreement
<team>` or on the web app and change while the team runs (the
[README](../README.md#what-it-asks-you-and-what-it-decides-for-you) has the levels and the topics). It's kept in the
team's store, every version of it, and holds from the moment it's recorded. Two settings here bear on it: with
`operator.technical` false, `technical` questions are never asked whatever the agreement says; and `contact` still
sets how often a message may reach you, whatever it asks. The design check-in is its own gate: the agreement doesn't
route it.

### Models

Each role runs on one model. Left out, the roles that decide what gets built and on what run on Fable, and the roles
that build it and check it on Opus:

| Role                                                                  | Default            |
| --------------------------------------------------------------------- | ------------------ |
| planner, innovator, scaffolder                                        | `claude-fable-5-1` |
| builder, tester, reviewer, security-reviewer, ux-specialist, approver | `claude-opus-5-5`  |

A wrong plan or a wrong foundation costs every task built on it, so the dearer model goes where a mistake travels
furthest; most of a team's tokens go to building and checking, which stay on Opus. To change it:

```json
{
  "model": "opus",
  "roles": {
    "planner": { "model": "fable" },
    "builder": { "limit": 2, "model": "claude-sonnet-5-5" }
  }
}
```

- `roles.<role>.model` is that role's model.
- `model` is the model of every role that names none of its own. A team that sets it, and nothing per role, runs
  every role on it.
- `fable`, `opus`, `sonnet` and `haiku` mean the newest model of the family this version of the factory knows
  (`lib/models.ts`), so they move when you upgrade; a model id is used as written.

`a6g register` records each role's model and prints them, and `a6g check` shows them in its summary. The planner's
rules carry a table with each member's model, which it passes to T3 Code as `target.model`; the guard refuses a
member started on any other, or on none. A change takes effect at the next `a6g register`: members started after
it run on the new model, and the planner at its next `a6g rotate`.

What a model costs is in `lib/prices.ts`: Fable is 2.5 times Opus per token, and a Claude subscription counts it
against a weekly limit of its own (`a6g subscriptions` shows it). A model the price table doesn't know still runs,
with a warning, and its tokens count for nothing in `a6g usage` or a budget.

## `pages`

What `a6g pages` checks, and how: the operator's pages, and the settings that could loosen a check (the app's address,
console messages to ignore, the smallest touch target). The team's harness manifest (`.a6g/harness.json`, below) adds
its own pages; `list` may be left out when it does, and `a6g pages` refuses to call nothing done. For a finish line
that's a set of pages, `"finish": "a6g pages done"`.

```json
"pages": {
  "appUrl": "http://localhost:3200",
  "base": "main",
  "content": ["src/app/(concept)/", "src/components/concept/"],
  "allowedChanges": ["^src/app/\\(concept\\)/", "^src/components/concept/"],
  "list": [
    { "id": "landing", "path": "/concept", "title": "Landing", "exclude": ["settings/"] },
    { "id": "settings", "path": "/concept/settings" }
  ],
  "viewports": [{ "id": "desktop", "width": 1440, "height": 900 }],
  "schemes": ["light", "dark"],
  "ignoreConsole": ["/api/auth/get-session"],
  "settleMs": 1500,
  "minTarget": 44
}
```

- **What a page's result depends on:** the files under `content`, minus its own `exclude`, so a change to one
  page doesn't make another's verdict stale.
- **A page:** `id` (letters, digits, `_` and `-`: it names the page's results, screenshots and UX verdict), `path`
  (from `/`), an optional `title`, `exclude`, `as` (the harness's sign-in it's seen with) and `mask` (CSS selectors
  painted over in its screenshots).
- **What a page is excused:** `ignore` (CSS selectors for what every check inside the page leaves out: sideways
  scrolling, axe, touch targets, clipped text and focus) and `schemes` (the colour schemes this page has, in place of
  `pages.schemes`: `["light"]` for a page with no dark variant, which then isn't checked dark, or held to looking
  different there). Only the operator says either: the manifest can't, so to excuse one of the manifest's pages, list
  it here under the same id (with its `path`, `as` and `mask`).

  ```json
  { "id": "orders", "path": "/orders", "as": "staff", "ignore": ["#chat-widget", ".legacy-table"], "schemes": ["light"] }
  ```

- **What's checked:** the HTTP status, that the page ended at the path it was asked for (one that lands on the sign-in
  page says so, and isn't checked as if it were the page), uncaught and console errors, sideways scrolling, axe's
  WCAG A/AA violations, touch targets under `minTarget` on phones (default 24, WCAG 2.2 AA; only what a finger can
  reach, and links in a sentence excepted), text cut off by the box that clips it (text wholly outside it, or with an
  ellipsis or a line clamp, is hidden on purpose), and controls whose focus can't be seen (on the first viewport and
  scheme: each of the first 40 stops is compared, pixel by pixel, focused and not, and the run says how many it walked
  of how many the page has). All in the factory's own Chromium, under the page's own content security policy, once
  the page has been scrolled to the bottom and back so what loads late is there. Screenshots are taken with
  animations off, before the focus walk.
- **Signed in:** a page with `as` is seen with that sign-in, made again by the manifest's `auth` project when its
  saved state is missing or more than 12 hours old. A sign-in that fails fails its pages (an old state is never used
  in its place), and `a6g check` and `a6g pages run` refuse an `as` that names no state.
- **`allowedChanges`:** where the branch may differ from `base` (`pages.base`, else the team's `base`). Anything
  else keeps the finish line from holding.
- **Defaults:** viewports are 1440, 1024 and 390 (the phone at device scale 2); schemes are light and dark
  (`no-preference` is the third).

## `harness`

`"harness": { "journeys": "required" }`: a journey is done only while its specs pass, and `a6g finish` (so
`a6g complete`) needs `a6g e2e done`: the suite passed at the integration branch's head, and every journey has a test
tagged `@journey-<id>` that passed. `"optional"` turns both off. Left out (the default), journeys are required once
the team has a suite (the manifest's `e2e`), so a team with a tester and no harness yet closes its journeys as before.

`"lane": ["^tools/e2e/", "^docker-compose\\.test\\.yml$"]`: more paths (regular expressions) that count as test and
harness files. A scaffolder's `test` and `test-infra` branches change only those: tests and their folders (fixtures,
mocks, seeds), test runners' configuration, the suite's set-up files, `.env.test`, its CI workflow, lockfiles,
`.gitignore`, the manifest, and in a `package.json` its `devDependencies` and test scripts (`test`, `e2e:ui`,
`db:seed`). A folder under an app's own routes (`app/`, `pages/`, `routes/`) isn't a test folder, whatever it's
called. A pattern that matches a `package.json` allows all of it. Its `scaffold` branches change what its lane allows.
On a team with the task graph, a scaffolder's branch merges only for its own approved, open task, since that task's
kind decides which of the two it is.

## `security`

Two things: which branches wait for the security reviewer, and the package audit.

### The security reviewer

A team has one when `roles` lists it (`"security-reviewer": { "limit": 1 }`); `a6g init` drafts it for a repository
with sign-in, payments or an API of its own. A team without the role is asked for nothing here. With it, the merge
queue merges these branches only once the security reviewer has passed their tip
(`a6g verdict security <branch> pass --sha <tip>`, which only that role records):

- **One that changes a security path.** The factory's own list goes by a path's words: sign-in and sessions (`auth`,
  `login`, `session`, `password`, `token` pairs like `accessToken`, `oauth`, `jwt`…), permissions (`permission`,
  `role`, `policy`, `guard`, `middleware`, `acl`, `rls`…), money and callers from outside (`payment`, `billing`,
  `checkout`, `stripe`, `invoice`, `refund`, `subscription`, `webhook`) and the data's shape (`migration`), plus every
  `.sql` file and rules file (`.rules`, `.rules.json`). A word is matched whole, in any case and through camelCase
  (`useAuth.ts`, `AuthProvider.tsx`, `api/stripe/webhook.ts`), so `author.ts` and `lesson.ts` aren't on it; tests and
  documents never are.
- **One matching `security.paths`:** your own regexes, which add to that list and match a path as written (tests
  too). An API's own routes belong here (`"paths": ["^app/api/", "^server/routes/"]`): the factory's list leaves
  them out, since not every route decides who sees what. `"builtIn": false` turns the factory's list off and leaves
  only yours.
- **One a reviewer sent on:** `a6g verdict review <branch> approve --security`, for a change that decides who can do
  what in a file no path names. It stays sent for the branch's later rounds.
- **One the security reviewer has judged before.** A branch it sent back with `issues` merges only once it passes,
  whatever the next round changes.

A rebased branch keeps its pass the way it keeps its review: `a6g merge <branch> --rebased-from <the commit passed>`
merges it when `git range-diff` shows the same change. `issues` sends the task back to its builder with the note,
like a review's changes, and counts as a round. The task records why it's the security reviewer's
(`a6g task show <id>`: "needs the security reviewer: it changes …"), `a6g blast` lists the security paths a change
touches, and the planner's context marks each task waiting for one. `a6g check` warns when `security.paths` or
`builtIn` is set on a team with no security reviewer, since nothing then waits for anyone.

Once a cycle, and before a finish line, the planner also starts the security reviewer with no branch, to sweep who
can reach which page and which record across the whole app; what it finds is filed as tasks. That one is the
planner's habit, not a rule: nothing refuses a cycle that skipped it.

### The package audit

`"security": { "audit": false }` turns off the package audit. Left out (the default), the check after merges runs the
package manager's own audit of what ships, beside each lockfile the repository tracks: `npm audit --omit=dev` for a
`package-lock.json`, `pnpm audit --prod` for a `pnpm-lock.yaml`. It runs when a lockfile isn't the one last audited,
and once a week when it is, since advisories arrive for packages that didn't change.

- **What's filed:** one `chore` task per package with an advisory of its own at high or critical, severity major. It
  names the advisories, whether the package is the app's own dependency or comes with another, and what moves the
  app off it. At most five are open at once, the worst first; the rest are filed as those close.
- **Quiet when you've answered:** a rejected finding stays quiet until a new advisory at high or critical names the
  package.
- **What it sends:** the audit asks the registry the install already uses, so the names and versions of the packages
  go to it. Nothing else does.
- **It never fails a merge.** A registry that can't be reached, a manager that isn't installed, or a report that
  can't be read is a line in the check's log (`a6g status`), and the audit is tried again at the next check. A
  `yarn.lock` or `bun.lock` gets one line saying it isn't audited.

## The harness manifest: `.a6g/harness.json`

The team's own means of checking, written by its scaffolder (the only lane that names it), reviewed and merged like
code, and read from the team's checkout. It only adds to the operator's checks and holds no command: the factory runs
the repository's own Playwright with the configuration it names.

```json
{
  "e2e": { "config": "playwright.config.ts", "timeoutMin": 20 },
  "auth": { "project": "auth", "states": { "staff": "e2e/.auth/staff.json", "member": "e2e/.auth/member.json" } },
  "pages": [
    { "id": "account", "path": "/account", "as": "member", "refuses": ["signed-out"] },
    { "id": "admin", "path": "/admin", "as": "staff", "refuses": ["member", "signed-out"], "mask": ["[data-live]"] }
  ],
  "schemes": { "dark": { "htmlClass": "dark" } }
}
```

- **`e2e`:** the suite's Playwright configuration, and how long a whole run may take (default 20 minutes). The
  factory runs `playwright test --config <it>` with the JSON report written outside the checkout, `PLAYWRIGHT_BASE_URL`
  set to the team's app and an `A6G_NAMESPACE` for the run's data. That Playwright needs its own version's browser on
  the machine (`npx playwright install chromium`, which the scaffolder runs); a run whose tests find none counts as
  not run, and says so.
- **`auth`:** the Playwright project in that configuration that signs in and saves each state; pages and specs use
  them by name.
- **`pages`:** pages to check beside the operator's (an id the operator listed stays theirs).
- **`refuses`,** on a page: the sign-in states, and `signed-out`, that must not be served it. `a6g pages` asks for the
  page as each of them, once, and it has to be refused: sent to another path, or answered 401, 403 or 404. A page
  served to one of them fails, and the check after merges files it as a blocker. A session the app has ended is sent
  to sign in wherever it goes, which looks like a refusal, so one counts only from a sign-in the same run showed to
  be live: a page seen as that state lands signed in and is refused signed out (the manifest doesn't load unless
  some page is seen as each state a page refuses). Where nothing shows that, the refusal is "not checked", which
  fails. An app that refuses in place, with a 200 at the same address, can't be told from one that serves the page:
  that's proved by a test.
- **`@access`:** with two or more sign-in states and a suite that ran, a suite with no test tagged `@access` is a gap
  the factory files once, like a journey with no spec: a test that signs in as one user and is refused another's
  records, by their address and through the API. A page check sees where a page ends, not whose data an address gives.
- **`schemes`:** how the app switches to a colour scheme when it doesn't follow the browser's setting: a class on
  `<html>`, `localStorage` entries, or a cookie. A page that looks the same in both fails its check.
- **Checking less is the operator's call.** The merge queue lists the suite (`playwright test --list`) before a
  branch and with it merged, and refuses one that leaves fewer tests that run (in all, or for a journey), or a suite
  that no longer lists. It also refuses a branch that removes a page, the suite or a sign-in from the manifest, takes a
  state out of a page's `refuses`, or changes the suite's configuration there, and one that adds a skip, `.only`,
  expected failure or filter to the suite's files (a listing can't see one inside a test). All unless the operator
  allowed that exact commit:
  `a6g harness allow <branch> --sha <commit> --why "…"`. Where the suite can't be listed in the merge's worktree,
  before the gate or after it, the merge says so and goes on. The check after merges measures the same from what ran:
  a run with fewer tests than the check before it, or more told to skip or to fail, is a finding unless a commit
  between them was allowed.
- **Nobody makes their own proof.** On a team with a tester or a scaffolder, a builder's branch that changes a file
  holding a journey's tests (one that names an `@journey-` tag, or that the listing shows a tagged test in) doesn't
  merge, allowed or not: a flow that changes gets a test task with it.

## The `.a6g/` folder

| Path                    | Who writes it          | What it is                                                                                                                                                                                         |
| ----------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team.json`             | the operator           | The rules                                                                                                                                                                                          |
| `brief.md`              | the operator           | The direction, as long or short as the project needs                                                                                                                                               |
| `direction.md`          | the operator           | Standing direction: what the product is for, who it serves, what wins when goals conflict. The planner derives its product decisions from it. Compiled into every member's prompt                  |
| `notes.md`              | the operator           | What any member needs to know: the environment, commands, conventions, traps                                                                                                                       |
| `rubric.md`, `style.md` | the operator           | Taste: the UX rubric and style guide (listed in `docs`)                                                                                                                                            |
| `roles/<role>.md`       | the operator           | Additions to one role's prompt                                                                                                                                                                     |
| `decisions.md`          | the planner            | The product calls it made from the direction (`a6g decision record` writes each line), and the operator's answers with the principle behind each. Compiled into every member's prompt              |
| `lessons.md`            | the planner            | Durable lessons, compiled into every member's prompt                                                                                                                                               |
| `adapters/`             | the operator           | `env.sh`, `gate.sh`, `after-merge.sh`, and the team's own finish checker if it has one. `a6g check` parses its shell scripts and checks they're committed, and skips dotfiles and editors' backups |
| `.gitignore`            | the factory            | Ignores `run/`                                                                                                                                                                                     |
| `run/`                  | the factory's commands | State, locks, the merge worktree, screenshots, scratch, and a 0.3 files board (imported into the task graph the first time a command opens it)                                                     |

## The task graph's files

With `tasks.store` `"files"`, the run folder (`~/.a6g/runs/<team>/`, outside the checkout, where the watchdog can read
it) holds `tasks/<n>.json`, `requests/r<n>.json`, `cycles/c<n>.json`, `controls/k<n>.json` (your pauses, resumes,
budgets, working agreements and reviews of decisions) and `decisions/d<n>.json` (the decision log): one document each,
written only by the factory's commands (the guard refuses agents the run folder). `a6g task graph` writes
`task-graph.json` there, a BetterDiagrams document to open with `npx @mosphere/better-diagrams`. Stakeholders' names
and addresses are kept beside it, in `~/.a6g/runs/<team>.private/stakeholders/`, which the guard refuses every agent. The plan behind it
is `docs/plans/task-graph.md`.
