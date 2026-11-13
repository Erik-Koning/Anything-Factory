# Plan: running the factory from the web app

Status: built, tested, merged and released in 0.8.0 (2026-11-13; see Checklist and Review). No project has been
started from the site for real yet: the setup agent's unattended run has only ever run as a stand-in in the tests.

## Why

The web app shows the operator their teams, and lets them answer, decide, add tasks, pause and set a budget. Three
things still need a terminal on the team's Mac, and the operator asked for all three from the site (2026-11-12):

1. **Start a new project**, with its budget and its Claude subscriptions.
2. **Choose which Claude subscriptions a team runs on.**
3. **One view of every project that folds**, so one project can be opened and the rest kept shut.

They also asked whether any of it needs a WebSocket. It doesn't; "No WebSocket" below says why.

## What it is

Nothing new carries instructions. The site already tells a team what to do through one channel, the controls in the
team's store, which the lead's watchdog reads every minute. The Mac already tells the site where it stands through
two: the team's state in the store, and the machine's report over its link. All three features ride those.

```
 the site ──(a control: pause, budget, agreement, review, and now subscriptions and start)──▶ MongoDB a6g.controls
                                                                                                   │ read every minute
                                                                                                   │ (start: every full run)
                                                                                                   ▼
 the site ◀──(the team's state: now with its subscriptions; the machine's report: now with      the Mac's watchdog
              what it offers to start; progress on a start: `starting` controls)──────────────────┘
```

The machine's link stays one way. A report still carries nothing the Mac acts on, and the app's answer to it is still
only a token or a refusal (`lib/fleet.ts`).

### 1. Subscriptions from the site

- **What the site sees.** The lead's state report gains `subscriptions`: the subscriptions on that Mac with each
  one's last reading, the list the operator gave the team (`a6g subscriptions use`), what each role runs on now, and
  which roles are moving or waiting (`lib/steer.ts` already keeps all of it in the run folder).
- **What the site sends.** A control of kind `subscriptions`: the team's list, in order, or one role's own list, or
  either one cleared. With the operator's authenticator code, like a pause or a budget.
- **What the Mac does.** The lead's watchdog writes the list where `a6g subscriptions use` writes it and steers at
  once (`steer()`), within a minute. A name that Mac doesn't have is refused in the team's log and changes nothing.
- **Older teams.** A team whose factory version reports no `subscriptions` gets no form: the panel says which
  version reads it.

### 2. Start a project from the site

A Mac starts projects from the site only once its operator has said so at its own terminal:

```
a6g connect app --projects ~/code      # this Mac starts projects the site asks for, in that folder only
a6g connect app --no-projects          # and stops
```

Off by default. With it on, the Mac's report also says what it offers: the folder, the git repositories directly
inside it that no team uses yet, and its subscriptions. The site shows the **Start a project** form to an admin who
has such a Mac of their own.

- **The ask.** The form takes the Mac, a repository in its folder (or a name for a new one), the project's title and
  short name, what should exist when the team is done, whether the operator wants to agree the design first, a
  budget, the subscriptions in order, and the authenticator code. It becomes a control of kind `start`, under the
  new team's name.
- **The Mac's side.** At its full run (every five minutes) the watchdog reads the asks addressed to this Mac (by the
  app's id for it) and starts one at a time, in a process of its own (`a6g projects start <team>`):
  1. checks the ask again: this Mac, opted in, a name no team has, a repository in its folder;
  2. makes the repository if it's new (`git init`, a README with the title and the goal, one commit);
  3. `a6g init --no-interview`, with the tasks in MongoDB and the goal in the brief;
  4. runs the setup agent unattended: it reads the repository and the goal, decides what it would have asked, writes
     each assumption into the brief as one, and proves the result with `a6g check --run`;
  5. `a6g check --run` once more, itself;
  6. `a6g register`, the budget as a control, the subscriptions as the team's list, then `a6g start`.
- **Progress.** Each step is a control of kind `starting` under the same name, by the Mac. The site shows the newest
  on the Teams page until the team has published its settings, then the team's own row takes over. A step that
  stops says four things apart: why, in a sentence; what the command that failed said, in its own words; what to do
  about it; and the command to run on the Mac (`a6g init <repo> --name <team>` to finish the interview by hand,
  `a6g projects start <team>` to carry on). The page shows the command as a block to copy.
- **What it won't do.** Clone from an address, touch a repository outside the folder, start a team under a name
  that's taken, or start two at once. An ask the Mac hasn't picked up in a day is dropped, and can be withdrawn
  before that.

### 3. A Teams page that folds

Each project is a row that folds. Shut, it shows the same four figures in the same places on every row: what waits
on the operator, who's at work, what it spent today, and its last merge. Open, it shows where the work stands (how
many tasks in each lane), the team's facts (planner, machines, subscriptions, aim), what it spent against its budget,
and the ways in: add a task, what's waiting, the board, requests, decisions, subscriptions. Folding has its own
words (**Expand all**, **Collapse all**, and **One at a time**, a mode in which opening one row shuts the rest); the
row's own key says where it goes (**Overview**). What's open is remembered in the browser, and a link with `#<team>`
opens that one. Projects being started show above the rest, each with a row of six marks for how far it has got.

## No WebSocket

- Nothing here changes faster than the watchdog's minute: a control is read within one, a start within five.
- The Mac can't be called: it's behind a router, so it asks. It would have to hold a socket open to the app, through
  CloudFront, to a container that restarts on every deploy, for news that arrives once a minute at most.
- The page asks instead. While something is in flight (a project starting, a control not yet applied) it reads the
  page again every ten seconds, and stops when nothing is.

## Security

- **Off by default, and turned on at the Mac.** The site can't turn it on. The link's token still only reports.
- **One folder.** The Mac starts a project only in a repository directly inside the folder its operator named, or a
  new one there, and checks that itself. Names are checked on both sides.
- **The operator's second factor.** Starting a project and changing subscriptions take an authenticator code, and
  only an admin may, on a Mac linked to their own account.
- **The Mac says so.** When it picks an ask up, the operator hears through the Mac's own channels, with how to stop it.
- **What the goal is.** The operator's direction, as an approved task from the site already is. A site that was
  broken into could already add approved work to a team; with a Mac opted in it could also start a team in that
  folder. The new team runs under the same guard as any other: nothing deploys, publishes or pays unless its rules
  say so, and the setup agent still writes only `.a6g/`.
- **Limits.** Three asks open per person and ten a day; the goal at most 4,000 characters.

## Changes

Factory (`lib/`, `bin/`, `plugin/`):

- `lib/tasks/controls.ts`: kinds `subscriptions`, `start`, `starting`, and their readers.
- `lib/tasks/teams.ts`: `TeamState.subscriptions`.
- `lib/steer.ts`, `lib/commands/watchdog.ts`: apply a `subscriptions` control; report the team's subscriptions.
- `lib/fleet.ts`, `lib/app.ts`, `lib/commands/connect.ts`: `--projects`, and what the report says a Mac offers.
- `lib/orders.ts`, `lib/commands/projects.ts`: reading the asks, and carrying one out.
- `lib/commands/init.ts`: `--store`, `--title`, `--goal-file`, `--unattended`.
- `plugin/agents/setup.md`: setting a team up with the operator away.

Web app (`web/`):

- `server/factory.ts`, `server/orders.ts`: the two new controls, and the asks with their progress.
- `server/machines.ts`: what a Mac offers, kept with its report.
- `app/page.tsx`: the Teams page; `app/new/`: Start a project; `components/subscriptions-panel.tsx` on a team's
  overview; `app/machines/page.tsx`: whether each Mac starts projects.
- `components/refresh.tsx`: the page reads itself again while something is in flight.

## Checklist

- [x] Factory: the controls, the state report and the subscriptions control, with tests
- [x] Factory: `--projects`, the report, the asks and `a6g projects`, with tests
- [x] Factory: init's new options and the setup agent unattended (run only as a stand-in: see Review)
- [x] Web: subscriptions on a team's overview
- [x] Web: Start a project, and its progress
- [x] Web: the Teams page that folds
- [x] Web: unit, integration and browser tests
- [x] The look, judged from screenshots until each page scores 8 of 10 or more
- [x] Merged, and released in 0.8.0
- [ ] A real project started from the site (it spends: the operator's call)

## Review

**The look.** A judge that saw only screenshots (desktop and phone, light and dark) scored the five pages over three
rounds, with 8 meaning ready to ship: Teams 6, 7.5, 8; Start a project 7, 8, 8; the same page with no Mac that starts
projects 6.5, 7, 8; Subscriptions 7, 8, 8; Machines 7.5, 8, 8. What it found each round was fixed before the next:
work counts that broke mid-word, "open" meaning both unfold and go to, a stopped start that buried its command in a
red sentence, examples in fields that read as typed, a command block that ran off a phone's screen. Its last round
left one small point a page (a mode that looked like an action, a key that didn't say what it waited for, a select
clipped on a phone, where to run the update, a footer that came apart on a phone); those were made too, and were not
scored again.

**Not proven.** The unattended setup agent (`setupUnattended`, `claude -p` with a fixed list of tools) has never run
against a real repository: the tests stand in for it and for `a6g check`, `register` and `start`. The first real
project started from the site is the test of it. `a6g register` asks which Docker engine is the team's when several
run: an ask that meets that stops at "register" and says the command to run.

**Noted, and left.**

- Two factory homes on one Mac (the installed one and a lab) share one link in the Keychain, so with both watchdogs
  running the machine's report flips between their teams. Older than this work.
- A team whose work is marked complete gets a nightly tick only, so a task added from the site waits up to a day.
- The ask and its progress stay in the new team's controls for good; its watchdog passes over them.

## Out of scope

Cloning a repository from an address; starting a project on someone else's Mac; a worker machine's own subscription
list from the site; limits per subscription (`a6g subscriptions limit`, `a6g budget --account`); stopping a start
that's under way (pause the team once it's registered).
