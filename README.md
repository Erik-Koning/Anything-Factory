# Anything Factory

Anything Factory provisions a software engineering team of Claude Code agents in any code repository, fast. You give
as much direction as the project needs. A planner then runs builders, a reviewer, an approver, a UX specialist,
testers and an innovator, until a checkable finish line holds or, for open-ended work, cycle after cycle. The team
contacts you only when the work is done or a cycle closes, or when a decision would change the outcome a lot.

It's built on [T3 Code](https://github.com/pingdotgg/t3code), which runs the agents' threads, gives each one its own
worktree, and wakes the planner when a member finishes. Claude Code is each agent. Anything Factory adds the roles, the
rules that hold them (enforced by hooks and scripts, not just prompts), the merge queue, the finish line, a
watchdog that keeps teams alive, and measurement. [CONSTITUTION.md](CONSTITUTION.md) is its purpose, principles and
the articles every agent works under.

## Quick start

```bash
git clone https://github.com/Erik-Koning/Anything-Factory && cd Anything-Factory
npm install && node bin/a6g.ts self-install     # installs ~/.a6g and links `a6g` into ~/.local/bin (keep that on PATH)
a6g doctor                                       # tools, T3 Code's version and contract, the watchdog

a6g init ~/code/my-app                           # detect, make the team's checkout, then interview you
```

`init` does the following:

1. Detects what it can about the repository: its scripts, what CI runs, its tests and UI, and every way it can
   reach outside the machine (deploy targets, hosted databases, publishing, payments).
2. Makes the team's own checkout beside yours (`~/code/my-app-a6g`, on a new branch `a6g/next`).
3. Writes a draft `.a6g/`, pinned to the factory version that wrote it.
4. Opens the **setup agent**. It asks you only what it couldn't detect: the goal, how done is proven, the team,
   a budget, branches, the board, data, contact, taste, and which policies to unlock. The budget goes into the
   brief as guidance for the planner; nothing enforces it, so watch `a6g metrics` and pause the team when it's
   spent. It finishes `.a6g/`, commits it on the integration branch (members' worktrees are made from it), and
   proves it with `a6g check --run`. If you say so, it registers and starts the team.

`a6g init --no-interview` writes the draft only, and prints the same steps for you to do by hand.

To watch a team:

```bash
a6g teams                  # every team on this Mac, its version, and whether it's active, pausing, paused or complete
a6g status                 # each team: planner, members running, its environment, what it spent, what's drained
a6g metrics --team my-app  # agents, runs, model requests, tokens and time per role
a6g pause my-app           # and a6g resume my-app; a6g rotate my-app for a fresh planner
```

What a team spends is counted from its agents' Claude transcripts each watchdog run: tokens by day, role, model and
task, priced at the API-equivalent rate (`lib/prices.ts`; on a subscription, how fast it uses your limits). `a6g status`
shows today, this week and in all; the web app adds each day and the costliest journeys and tasks.

To hold a team to a budget: `a6g budget my-app --daily 40 --weekly 200 --total 1500` (dollars, API-equivalent; a limit
left out keeps its value, 0 removes it; `a6g budget my-app` shows them). Or as shares of a Claude subscription:
`a6g budget my-app --weekly 60% --total 300%`, where 100% is one subscription's weekly limit and more is more than one
subscription's worth. The watchdog reads each subscription's usage every quarter hour, from Claude Code's own usage
report (`claude -p /usage`, a local command that uses nothing), and with what the Mac used that week, every session's,
works out what one subscription's week comes to in API-equivalent dollars; `a6g subscriptions` shows it. Until there's
a reading with 5% of the week used, a budget in shares isn't checked, and says so. At 80% of a limit you're warned, once
per day, week or budget; at 100% the team pauses after the work under way, with the report; at 110% it pauses now.
Resume it and the budget leaves that limit alone for the rest of its day or week (for the total, until you change the
budget): you chose to carry on. With `--auto-resume`, a team only the daily or weekly budget paused starts again when
the next day or week does. `a6g start` never lifts a pause; `a6g resume` does. With the task graph out of reach,
`a6g pause` still stops the team on this machine, and on a worker machine pause and resume are that machine's alone.

### Teams on several subscriptions

Each subscription is a Claude Code login in a config folder of its own (`CLAUDE_CONFIG_DIR`, as Claude Code's docs say
for several accounts); this Mac's own login (`~/.claude`) is `default`. A team's roles run on one through T3 Code's own
setting for it (each instance's `homePath`), so the factory never touches the login itself:

```bash
CLAUDE_CONFIG_DIR=~/.claude-b claude auth login        # sign the second subscription in, once
a6g subscriptions add b --config-dir ~/.claude-b
a6g subscriptions use app default,b                     # app runs on default, and on b when default closes
a6g subscriptions use site b,default                    # site the other way round
a6g subscriptions use app b --role builder              # or one role on a list of its own
a6g subscriptions limit default --weekly 85%            # keep 15% of default's week for yourself
a6g subscriptions limit all --weekly 170%               # the two weeks added up
a6g budget site --account b --weekly 40%                # site may take 40% of b's week, then it moves to default
```

A subscription closes at your limit for it, at the limit across all of them, once its week or five hours are used up
(until it resets), or for one team at that team's own budget on it (`a6g budget --account`, in the budget's unit). The
watchdog reads each one every quarter hour, every five minutes when one is near a limit, and keeps every role on the
first open subscription in its list. A role moves only when nothing of it is at work, since T3 Code would resume a
session under the new login, where it isn't: a member role once its members at work finish (none of it starts in
between, which is soon: each does one task), and the planner once it's idle with no member running, when its thread
is retired and a fresh one starts on the new subscription at the next run. A role goes back up its list once the
earlier subscription is five points under its limits. A role none is open to waits: the guard starts none of its
members, a waiting planner gets no ticks and keeps its messages for when it can work, the roles still open carry on,
and it picks up by itself when one opens. You're told of every move and wait; `a6g subscriptions` shows each one's usage, limits and
the teams on it, and `a6g status` each team's. A team's spend is counted on the subscription each request ran on, and
a budget in percent counts each against that subscription's own week.

The choice is each machine's: name the same login the same on every Mac, and a worker runs its builders on its own
list. The limits read each subscription's own usage, so they hold wherever it's used; what a week comes to in dollars
counts what the reading Mac used, so for a subscription used on two Macs it's an underestimate.

To stop a team gracefully, let what it's doing finish first: `a6g pause my-app --after tasks` lets the work under way
(being built, in review, sent back for changes) finish and merge while nothing new is claimed; `--after journeys` lets
the journeys under way (or `--journeys 3,7`) finish, their verification and polish included. Once nothing in it can
move, the team pauses and you get a report (email, and the web app): what was done, each journey, what waits for you.
It stays paused until `a6g resume my-app --note "…"`, whose note goes to the planner as your feedback. The web app's
team page does the same for admins, each time with an authenticator code; the watchdog applies it within a minute.

You can also watch a team in the T3 Code window: one planner thread, with a child thread per member.

To get a team's work as a pull request, give `push` in `team.json` a `pullRequest`:
`{"remote": "origin", "branch": "a6g/next", "every": "6h", "pullRequest": true}`. At the finish line and when a
cycle closes, the planner pushes and runs `a6g pr`, which opens a pull request into `base` or updates the open one,
with what's in it, the calls the planner made and what's left. Merging it is how you promote the work; the team never
merges into `base` itself. If you open that pull request yourself (no `[A6G-Planner]` in its title), your title and
description stay yours, and the planner comments instead. The factory runs `gh` for it, so the `github` policy stays
denied.

To hear from your teams away from this Mac, and answer them:

```bash
a6g connect email          # your address and your own Resend API key (free); it sends a test email first
a6g connect whatsapp       # or as well: from your WhatsApp Business number, through Meta's Cloud API
```

With email connected, planners write to you through the watchdog, under `[A6G-Planner] [<team title>]` like
everything else they send. It also emails you when a planner is waiting for your answer, looks stuck or can't start,
or T3 Code is down (each at most every 6 hours). With a full-access key and your Resend receiving address, a reply
goes to that team's planner; the watchdog passes on only mail from your address that its domain signed or that
passes DMARC. The key stays in the macOS Keychain. The guard refuses agents the commands that read or change it, but
any code running as you can reach it, so give the key no more access than you use: sending access only, unless you
want replies. `a6g connect` shows what's connected, and `a6g disconnect email` turns it off. Without email
connected, a planner emails you through the claude.ai Gmail connector, when it has one.

To hear when this Mac stops (it's off, asleep or at the login screen after a restart, the watchdog stopped, or T3 Code
won't start), which nothing on the Mac can tell you:

```bash
a6g connect heartbeat https://hc-ping.com/<uuid>   # a check at healthchecks.io (free) or any service like it
```

The watchdog pings it at the end of every run in which T3 Code answers, so give the check a period of 5 minutes and a
grace of 15. When the pings stop, the service alerts you. Give each Mac its own check: one that two Macs ping alerts
you only when both stop. A ping says the Mac and its watchdog are running, not that every team is well; a team's own
trouble is in its log and its planner's messages. `a6g disconnect heartbeat` turns it off.

WhatsApp is one way. A business may message you first only with a template Meta has approved, so
`a6g connect whatsapp` adds a utility template, `a6g_update`, to your WhatsApp Business account, and every message
goes through it (Meta charges each one at its utility rate); a planner's messages are about "A6G-Planner · <team
title>". Your replies on WhatsApp don't reach the teams: they arrive at the number's webhook, which belongs to
whatever else uses the number.

## How it works

```
 you ◀── email (the operator only) ──────────────────────────────────────┐
                                                                         │
 launchd ─ watchdog (every 5 min, every team) ─── tick ───▶ PLANNER (a T3 Code thread)
            restarts T3, Docker · stuck? · prunes worktrees              │ delegate_task (the guard counts the limits)
                                                                         ▼
          builders and testers (own worktrees) · reviewer · UX specialist · innovator
                    │ a branch                     │ a6g verdict … @ the exact commit
                    ▼                              ▼
   a6g merge --queue: lane ✓ · approval of this commit ✓ · full gate on the merged result ✓
   → fast-forward the integration branch → close tickets → rebuild and recheck → wake the planner
                                                                         │
                           the finish line (a command that exits 0) ─────┘
```

Each team member is a T3 Code thread running Claude Code, launched like this:

```
claude --agent a6g:<role>                                 the role's prompt, from the factory's plugin
       --plugin-dir ~/.a6g/versions/<v>/plugin            the hooks: guard, stop gate, context, heartbeat
       --append-system-prompt-file ~/.a6g/runs/<team>/prompts/<role>.md
                                                          the constitution's articles + the team's rules
       --setting-sources project [--strict-mcp-config]    none of your personal skills, plugins or connectors
```

The appended prompt is **compiled**, never written by hand. It combines:

- the constitution's articles;
- the team's rules, rendered from `team.json`: lanes, limits, commands, board, policies and documents;
- the operator's direction (`direction.md`), which the planner derives product decisions from;
- the operator's notes for the role;
- the planner's decisions (`decisions.md`) and lessons.

The prose therefore can't disagree with what the guard enforces. When a source changes, the next session
recompiles it.

**The guard** runs before every tool call. It enforces:

- each role's lane;
- the policies (below);
- protected branches and the push cadence;
- who records verdicts and who merges;
- members per role, counted live from T3 Code's database;
- which outside tools each role may use; the planner may email only you.

**The stop gate** keeps a builder or tester from finishing with uncommitted work, a misnamed branch, or a failing
quick gate. **The merge queue** (`a6g merge`) is the only way into the integration branch.

## Checks that hold

A team's work is checked by scripts as well as by agents, and the checks are run again after merges, so what was done
stays done.

- **Page checks from day one.** The factory carries its own Playwright and Chromium (`a6g self-install` downloads it).
  `a6g pages` loads each page at desktop, laptop and phone, light and dark, signed in where it needs to be. It checks
  the HTTP status, errors in the console, sideways scrolling, axe's WCAG A/AA violations, touch targets under
  `pages.minTarget` on phones, text clipped by its box and controls with no visible focus, and takes screenshots with
  animations off. When the UX specialist passes a page, its screenshots are kept, and later checks say which pages
  look different since.
- **The scaffolder** (`plugin/agents/scaffolder.md`) owns the means of checking: Playwright in the repository, a
  sign-in for each kind of user, test data kept apart per run (`A6G_NAMESPACE`), stand-ins for outside services,
  stable screenshots, and the harness manifest (`.a6g/harness.json`) that tells the factory the pages, sign-ins, colour
  schemes and suite. It claims `scaffold` work (an empty repository's skeleton, a new app or package) and `test-infra`
  work, and specs where the team has no tester. Setup drafts one for any app.
- **Journeys as specs.** A journey's specs are Playwright tests tagged `@journey-<id>`, written by a tester or the
  scaffolder, never by who built it (the merge queue refuses a builder's branch that touches one). A journey is done
  only on a run of the suite that holds all its merges and where they passed, and `a6g finish` needs the whole suite
  passing at the head (`harness.journeys`). `a6g complete` marks the work complete only when the finish line holds.
- **After merges.** Every queued merge, however it ends, runs the check that's due, and the last of a burst runs it
  once for the newest commit, holding the merge and app locks so nothing moves under it. It asks the app first: an app
  that's down is one blocker finding, nothing else is checked, and the check stays due. Then every page and the whole
  suite, with one retry. What newly fails becomes a finding, naming the merges since it last passed. So does a suite
  that didn't run, and one that checks less than it did at the check before (fewer tests, or more told to skip or to
  fail) unless you allowed the commit. A test that passes only on its retry is filed as flaky, journeys without specs
  are filed, journeys whose tests now pass are closed, and the planner is woken. Rejecting a finding quiets that
  failure, not that page: a different failure, or the same one after a pass, is filed again.
- **Checking less is your call.** A branch that removes a page or the suite from the manifest, skips, filters or
  retries a test, or leaves fewer tests merges only once you allow that exact commit:
  `a6g harness allow <branch> --sha <commit> --why "…"`.
- **One environment, used one run at a time.** Runs against the team's app (`a6g pages`, `a6g e2e`, and a member's own
  `a6g env use -- <command>`) hold its lock, so a merge doesn't restart it under them. `a6g env use` waits
  `--wait-min` minutes for it (8 unless said), and ends a command that holds it past `--max-min` (30 unless said, 120
  at most) with everything it started, so a run that hangs doesn't keep merges waiting.

```bash
a6g pages status                     # each page: its checks, its UX verdict, and whether it looks different
a6g e2e status                       # which journeys have specs, and how the last run went
a6g harness check                    # does the manifest load
```

## The task graph

Every piece of work is a task: one document each, with a status, who holds it on which machine, and a history of who
moved it. `a6g task list` shows the open ones; `a6g task graph` writes them as a BetterDiagrams document (a band per
journey, columns by dependency) to open with `npx @mosphere/better-diagrams`.

```
 stakeholders ─ a6g request ─▶ REQUESTS ─ planner: research, gate, score ─┐
 members ─ a6g task add (findings) ─▶ triage ─ planner ──────────────────▶ proposed
                                                  approver, or you (team.json approval) ▼
                                       approved ─ a6g task claim ─▶ building ─ a6g task submit ─▶ review
                                                  reviewer (the review skill, a risk) ─▶ merge queue ─▶ done
                                                  a journey's tasks all done: due its verification ─ polish ─▶ done
```

- **Proposals.** The planner passes new work through a gate (who asked and why, what could be deleted or simplified
  instead, the simplest version) and scores it 0–3 on pain, reach, revenue, wow, distribution, leverage, urgency and
  risk, with a confidence and a size. The command computes the priority from your weights (`priorities`).
- **Approval.** The planner never approves its own proposals. With `approval.mode` `"thresholds"` (the default, when
  the team has an approver; without one, every approval is yours) the approver approves work up to
  `approval.maxSize` and escalates larger work and changes of scope to you; `"operator"` keeps
  every proposal yours; `"full"` gives the approver all of it, scope included. Privacy, policy unlocks, promotion and
  rule changes stay yours whatever the mode. The bug, UX and test findings other members file are the planner's to
  approve (`approval.findings`, `"approver"` to send them with the proposals), since they aren't its own. Work made
  of a stakeholder's words (a feature request, a suggestion from the web app) is yours to approve whatever the mode
  (`approval.stakeholders`, `"screened"` to let the approver approve what the planner screened clear, never what it
  screened risky). Every move of a task, by whom and from where, is one table in `lib/tasks/model.ts`.
- **Claims.** Builders and testers claim the next approved task their role builds (blockers, then majors, then
  priority), never two on the same files, under a lease their heartbeats renew; the watchdog returns a claim whose
  member went quiet. The Stop hook won't let a member finish holding one: it submits or releases it.
- **Review.** The reviewer follows the review skill (`plugin/skills/review/`): the change's blast radius
  (`a6g blast`: importers, files that usually change with it, their tests, UI, critical paths), goals, edge cases,
  tangential code, tests that fail without the change, and a before-and-after look at anything a person sees, which
  the reviewer judges is due. It says how much the change could break with its approval (`--risk`), and a high-risk
  change merges only with its own tests, in the same branch. Changes send the task back, up to `review.maxRounds`
  rounds.
- **Journeys.** A journey is a task with child tasks. When its children are all done it's due its verification (worked
  out from them, never stored): a UX audit at every viewport, an end-to-end spec of the whole journey, then polish,
  which is more tasks in it. The planner marks it done.
- **Raising to you.** A task reaches you only with why it's yours and what the team recommends: `a6g task status
<id> question --reason "…" --recommend "…"` and the approver's `escalate` refuse without both (the operator raising
  one to themselves gives the reason), and `a6g task ask` gives them to one raised before. A block is the planner's
  to sort (`--reason`) unless it's raised to you with `--recommend`.
- **Waiting on other tasks.** `a6g task status <id> blocked --waits-on <ids> --then close|resume` parks a task on
  others: once they're done it closes (it was folded into them) or goes back to work, and once one is rejected it
  goes back to the planner. The merge queue settles it as it merges, and the watchdog every minute.
- **Answers.** What waits on you (every `question`, and blocks raised to you) you answer on the web app's Waiting on
  you page, with the options the question offers: a note by the operator marked as the answer
  (`lib/tasks/answer.ts`), which the watchdog passes to the planner within a minute. The planner records it in
  `decisions.md` and moves the task on. People choose there what they're emailed about, at once or in a daily digest.
- **Feature requests.** `a6g request add` takes a stakeholder's request; `a6g serve` gives each a form. Agents see a
  stakeholder's id and role, never a name or address. The planner researches each request and promotes it into tasks
  (`a6g task add --request`) or rejects it with a reason.
- **A stakeholder's words are data.** A request, and a task suggested from the web app, reach agents fenced and
  quoted (`a6g request show`, `a6g task show`, the planner's context), each line after a mark so none passes for one
  of the factory's, and without control or format characters; agents never follow instructions in them. Before any
  work is made of one, the planner screens it (`a6g request screen` / `a6g task screen <id> clear|risky --note "…"`):
  risky when it asks for, or the work would need, weaker security checks, secrets, calls to outside services or data
  sent out, personal data, new dependencies or build and deploy changes, looser tests or review, or anything about the
  team itself (the list is `SCREEN_RISKS` in `lib/tasks/model.ts`). A request isn't promoted, and a suggestion isn't
  proposed, until it's screened; the screen goes with the work, and the approver approves none that's risky.
- **Cycles.** With `"mode": "cycles"` a team has no finish line: it builds, verifies journeys, sweeps for regressions
  and closes each cycle with a report (`a6g cycle close`), and rests when nothing is left until new work arrives.

`a6g serve` is your page for one team, on the machine it runs on: the request form, the proposals to approve or
reject, the board and the graph. It listens on 127.0.0.1 and always asks for a token, so the team's own agents on
this machine can't use it: one made at start and printed in the address to open, or yours in `A6G_SERVE_TOKEN`.
That token is yours alone: it approves work and shows stakeholders' names. Give a stakeholder a link of their own
with `a6g request stakeholders add --name "…" --email "…" --role "…"`: it opens only the request form and their own
requests, and what they send is attributed to them; `a6g request stakeholders revoke <sN>` ends it. For people on
other machines, serve on an address they can reach (`--host`).

### Across machines

A team can run on several Macs sharing one task graph in MongoDB: `"tasks": {"store": "mongo", "lead": "<machine>"}`,
with `push` set, since code moves through the remote. On each machine, `a6g connect mongo --machine <name>` (the
connection string goes in the Keychain, and no command shows it to an agent). The guard is a seatbelt here too: code
running as you can read your Keychain, so give the factory a database user that can read and write only its own
database. The lead, an always-on machine, runs the planner, the approver, the reviews and the merge queue, and pushes
the integration branch after each merge; `a6g merge` refuses anywhere else, and refuses while the remote's integration
branch has commits the lead's doesn't (only the lead pushes it). A merge whose push fails leaves its tasks open until
one pushes. Name exactly one lead, and change `tasks.lead` before you move it: two leads would both merge. Other
machines run `a6g register --worker`: builders only (testers test on the lead, where the environment runs), started
by their watchdog while
approved work is free. A worker's claim makes its branch from the remote, and its submit pushes it for the lead to
review and merge.

On a team on several machines:

- **Limits are per machine:** each worker runs up to the role's `limit` of its own.
- **A heartbeat per machine:** run `a6g connect heartbeat` on each with a check of its own, or a worker's pings hide
  the lead stopping.
- **The pull request** (`push.pullRequest`) moves with every merge, since the lead pushes the integration branch;
  `push.branch` stays the integration branch.
- **Builders on a worker** use their own previews: the team's shared environment runs on the lead (only the planner
  starts it).
- **After changing `tasks` in `team.json`,** run `a6g register` again on each machine, as for `contact`.
- **A team that started on one machine** moves its graph with `a6g task migrate --to mongo` (`--dry-run` first): every
  task, request, stakeholder and cycle keeps its id, and the file store is marked so nothing writes to it again.

**Which machine runs what.** `a6g teams` lists the teams registered on this Mac. To see every Mac and what it runs on
the web app, link each one to your account there with `a6g connect app` (the first time, it asks what to call the
machine: team members see the name). It shows a code and opens the app's page for it, where you sign in as usual, look
the code up, check it, the machine and the address it asked from, and approve; a code asked for from another address
than yours must be typed, not only clicked, and you get an email whenever a machine is linked. The Mac then keeps a
token in the Keychain, with the address it goes to, that does one thing: report this machine (OAuth's device
authorization grant, RFC 8628). It isn't a sign-in, can't read anything or act as you, and is replaced every week (an
old one used after its successor ends the link, as does a new one turning up after the old one was given another). At
the end of every full watchdog run it reports every team registered on it, those whose tasks are in files too: lead or
worker, where the team stands, who's at work, and its checkout (as `~/…` under your home folder). **Machines** on the
web app shows you your machines, and an admin every machine and whose it is; a team's card on **Teams** names the
machines its members and admins run it on. A machine not heard from for 15 minutes shows as not reporting. Admins and
the members of a team link machines, ten each. Unlink one from its card or with `a6g disconnect app`; one that reports
nothing for 30 days, or whose person is banned or no longer on a team as a member, is unlinked too. Linking a Mac
again replaces its old link only because the CLI shows the old token: a machine someone else names after yours is a
second one, never yours replaced. `a6g connect app --test` reports now; `--url` names a deployment of the app other
than `https://app.anythingfactory.dev` (https, or http://localhost for one on this Mac), which the Mac keeps until
it's linked elsewhere, and `--machine` the Mac's name.

## The two places you edit

| Where                                                  | What                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The factory** (this repository)                      | Everything generic: the [constitution](CONSTITUTION.md), the role prompts (`plugin/agents/`), the hooks (`plugin/hooks/`), the policies (`lib/policies.ts`), the engine (`lib/`), the setup agent and the starter files (`templates/`)                                                               |
| **The team's `.a6g/`** (in the repository it works on) | Everything about one repository: `team.json` (the rules, [reference](docs/team.md)), `brief.md`, `direction.md`, `notes.md`, an optional rubric and style guide, `roles/<role>.md` additions, the planner's `decisions.md` and `lessons.md`, and `adapters/` (`env.sh`, `gate.sh`, `after-merge.sh`) |

Everything else is generated from these two, and nothing in it is edited by hand:

- the compiled prompts;
- T3 Code's provider instances;
- the registry in `~/.a6g/teams/`;
- the watchdog's launchd job.

## Policies

Local and reversible work is allowed. Outward-facing and irreversible actions are denied until you unlock them in
`team.json` (`"policies": {"deploy": "allow"}`):

| Policy         | Denied by default                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy`       | Hosting and app-store CLIs (Vercel, Netlify, Fly, Wrangler, SST, SAM, Firebase, Convex, EAS, …), and package scripts or turbo/nx tasks named deploy, release or publish                                                                                                                                                                                                                                           |
| `cloud`        | aws, gcloud, az, terraform, pulumi, kubectl, helm, …                                                                                                                                                                                                                                                                                                                                                              |
| `hosted-data`  | Linking, pushing, migrating or dumping hosted databases (Supabase, Prisma migrate deploy, PlanetScale, Neon, Turso, …)                                                                                                                                                                                                                                                                                            |
| `publish`      | npm, pnpm, yarn, lerna, cargo, gem and twine publishing; docker, podman and buildah push (including docker image and compose push)                                                                                                                                                                                                                                                                                |
| `github`       | gh beyond issues, labels, search and reading PRs and runs (no workflows, API, PRs, releases or settings). The planner's own pull request goes through `a6g pr` instead                                                                                                                                                                                                                                            |
| `messages`     | mail, Slack or Discord webhooks, SMS and email APIs from the shell. The planner emails only you, through its email tool                                                                                                                                                                                                                                                                                           |
| `network`      | Reaching other hosts from the shell (curl, wget, httpie, nc, ssh, scp, rsync, …): only this machine (localhost, its containers) and the hosts `team.json` lists in `hosts` (`"api.example.com"`, `"*.example.com"`). Claude's own web tools still read pages and search, but a URL can't carry much: https, short, nothing encoded                                                                                |
| `payments`     | The Stripe CLI and live payment keys                                                                                                                                                                                                                                                                                                                                                                              |
| `secrets`      | (allowed by default) storing a secret through a secret manager with the value on standard input, never in the command: `openssl rand -hex 32 \| npx sst secret set AuthSecret`, and the same form for `vercel env add`, `gh secret set`, `doppler secrets set --silent` and `gcloud secrets versions add --data-file=-`. For the team's own stage or a preview; a store for production goes the way a deploy does |
| `dependencies` | (allowed by default) adding packages                                                                                                                                                                                                                                                                                                                                                                              |

Never unlocked: reading secrets and env files, a secret's value written in a command (an argument, `--body`, a
literal piped in) and commands that print stored values (`sst secret list`, `vercel env pull`, `gcloud secrets
versions access`), the machine's services, force pushes and rewritten history, protected branches, and the
factory's own files. A team adds its own rules in `never`, each with an example command that
`a6g check` proves is refused.

## Commands

`a6g help` lists them all.

| For                                                    | Commands                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The operator**                                       | `doctor`, `init`, `check`, `register` (alias `sync`), `start`, `pause`, `resume`, `rotate`, `status`, `teams`, `metrics`, `prompt`, `upgrade`, `unregister`, `watchdog`, `connect`, `disconnect`, `serve`, `self-install`, `versions`, `harness allow` |
| **Team members** (the guard decides who may run which) | `merge`, `verdict`, `log`, `lock`, `drain`, `gate`, `env`, `finish`, `complete`, `progress`, `pages`, `e2e`, `harness check`, `pr`, `task`, `request`, `cycle`, `blast`                                                                                |

## T3 Code and Claude Code

T3 Code is a dependency, not a fork:

- Everything that depends on its internals is in one file, `lib/t3.ts`: its data paths, the tables and columns
  the factory reads, the CLI commands it runs, the settings it writes, and the planner's tool names.
- `package.json` declares the T3 Code versions this release supports (`"a6g": {"t3code": ">=0.1.4 <0.2.0"}`), and
  the Claude Code versions it's tested with.
- `a6g doctor` and `a6g register` check the installed T3 Code against that range and against what the adapter
  reads (its contract).

When T3 Code updates (`t3 update`), run `a6g doctor`:

- **In range, contract holds:** nothing to do.
- **Otherwise:** adjust `lib/t3.ts`, widen the range, and release a new factory version.

## Versions

- **Releases:** `a6g self-install` installs this checkout's version into `~/.a6g/versions/<version>` and makes it
  current. An installed release doesn't change under a running team. An older version than the current one is only
  added, for teams to pin (`--force` makes it current): the launcher is shared, and an older one doesn't know the
  newer releases. An install that was interrupted is put right by the next one.
- **Pins:** each team pins one release in `team.json` (`"factory": "0.5.0"`; `a6g init` writes the version that
  drafted it), and its agents run that release. A team without a pin runs whichever version registers it.
- **Upgrading:** `a6g upgrade <team> [version]` registers the team with the target version first, and moves the pin
  only once that worked (`--force` registers even when T3 Code doesn't meet the contract). A running planner keeps
  its old prompt until `a6g rotate <team>`.
- **Development:** `self-install --link` adds `versions/dev`, pointing at this checkout, for teams that should pick
  up changes immediately.
- **Which code runs:** the installed `a6g` hands a team's commands to the version the team pins. A source checkout
  (`node bin/a6g.ts …`) never hands over: it runs its own code, whatever the team pins.

## Repository layout

```
CONSTITUTION.md        the purpose, principles and the articles every agent works under
bin/a6g.ts             the CLI
lib/                   config, policies, prompts, the T3 Code adapter, locks, detection, and the commands
plugin/                the Claude Code plugin every agent loads: agents/ (roles and setup), hooks/
templates/team/        the starter .a6g/ that init writes
schema/                team.schema.json, for editors
docs/team.md           the team.json reference; docs/architecture.json is the architecture as a BetterDiagram
examples/              team.json for a page-building team, a journeys team, and a minimal one
test/                  node --test
```

The factory is TypeScript, written the way T3 Code's own is: Node (22.18 or newer) runs the `.ts` files as they
are, so there's no build step, and `tsc` only checks them, with T3 Code's compiler settings (`tsconfig.json`). The
hooks and the launcher run with Node's compile cache on, so stripping the types costs nothing after the first run.

## Development

```bash
npm test                         # type-check, then the suite: policies, config, prompts, guard, merge queue, locks
node bin/a6g.ts check <dir>     # any team's setup, with this checkout's code (whatever the team pins)
node bin/a6g.ts self-install --link
```

To make a release:

1. Bump `version` in `package.json` and `plugin/.claude-plugin/plugin.json` (a test keeps them equal).
2. Note it in `CHANGELOG.md`.
3. Run `a6g self-install`.
4. Run `a6g upgrade <team>` for each team that should move.

## Known limits

- **The guard is a seatbelt for agents that follow instructions, not a sandbox.** A determined shell command can
  get past a pattern. For hard guarantees, scope the credentials on the machine (for example, a GitHub token that
  can only read code and write issues) and protect production with required reviewers. See the constitution's
  Part IV.
- **The factory's records are files, and every member runs as you.** What ran and passed, the verdicts, your
  allowances and the complete marker live in `.a6g/run/state` and the team's run folder. The guard refuses the file
  tools, shell writes and a program's code that names them (`node -e`, `python -c`, a here-document), which stops a
  member that reaches for the quick way. A member that sets out to forge one (a script that builds the path in
  pieces) can: nothing on the machine tells its writes from the factory's. Records a member can't write need a
  second user on the machine, or a signature made with a key members can't read; that's not built.
- **A stored secret is read one command at a time.** The guard passes a store whose every word it can read: the
  tool, the secret's name, where it goes, and a value that comes from standard input. It can't see what an earlier
  command left behind: a stage exported before the store (`export SST_STAGE=production`), or a value typed into a
  variable first and piped in by name. Production secrets are safest where the constitution's Part IV puts them: off
  the machine, behind credentials the team doesn't hold.
- **Platform:** macOS only for now. The watchdog is a launchd job, notifications use `osascript`, and the email
  key is kept in the Keychain.
- **No interrupt:** T3 Code 0.1.x has no command to interrupt a thread, so the watchdog notifies you instead.
- **One shared environment per team:** runs, rebuilds and the checks after merges take turns under locks; they aren't
  isolated. A branch that changes the database's schema can't be tried against it before it merges (prove it with
  tests on an in-memory database); the check after its merge tries it.
- **Page checks run after merges, not before.** Builders and reviewers run `a6g pages shots` on a branch's own
  preview, but nothing yet enforces it.

## License

No license has been chosen yet, so all rights are reserved.
