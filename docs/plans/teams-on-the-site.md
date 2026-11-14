# Plan: every team where it belongs on the site

Status: built, reviewed and released in 0.8.1 (2026-11-13), at the operator's word ("make a thorough plan and then
implement this until done"); deployed to both sites and installed on the operator's Mac, where the finished team it
runs had nothing that counted as new work and kept its nightly tick.

## Why

After 0.8.0 the operator asked whether every way a project starts ends up on the site, and for the logic bugs and UX
problems along the way. Five came up, worst first:

1. **A finished team ignores new work for up to a day.** An idle team (cycles) is woken as soon as a task or a request
   arrives; a team whose work is marked complete gets only its nightly tick (`lib/commands/watchdog.ts`), and nothing
   ever lifts the mark. A task the operator adds from the site to a finished team waits until that night.
2. **A team never leaves the site.** `a6g unregister` doesn't take it off, and the site has no way to. A trial team, or
   one the operator is done with, stays on Teams for good, its questions keep counting in Waiting on you, and its name
   can't be used again.
3. **Teams set up at the terminal are missing from Teams.** Their tasks are in files unless `a6g init --store mongo`
   says otherwise, and the site shows a team only from its store in MongoDB. Teams doesn't say what it leaves out
   (Machines does, in small print).
4. **A team no Mac runs looks like any other.** The only sign is "none reports it", inside the open row. Its questions
   count toward the badge, and an answer just sits until it runs again.
5. **The row's "N waiting on you" pill folds the row** instead of opening what waits. (Fixed first, on this branch.)

## What it is

### 1. A finished team wakes for new work

- **New work** is what already wakes an idle team: a feature request that's new, or a task to triage, approve, build,
  review or verify, changed since the team went quiet. "Since" is now the newer of the `idle` and `complete` marks in
  the run folder, so what was there when the planner finished doesn't count. For a finished team, only work from
  outside it counts: a task whose last change was the operator's or a stakeholder's (added, approved, suggested), and
  a new request. What its own members or the planner's nightly re-check write waits for that tick, as before.
- **When it arrives** at a finished team, the watchdog lifts the `complete` mark (the team's state goes back to
  active, on the site too) and wakes the planner with what arrived, as it wakes an idle one, saying the work isn't
  marked complete any more and to run `a6g complete` once the finish line holds again, with a new Done report only if
  the round built something. That message reaches a planner of any version.
- **Nothing new**: the nightly tick, as before.
- **Which teams**: the watchdog runs at the installed version for every team on the Mac, so this reaches teams pinned
  to older versions without upgrading them. The planner's instructions (`plugin/agents/planner.md`) say what happens,
  for teams on 0.8.1 and later; an older planner reads the tick's words ("new work: …") and has the operator's
  instruction already: "email again only if something broke or the operator added scope".

### 2. Taking a team off the site, and putting it back

The site's database user can only add controls, never change a team's settings (`web/README.md`, Atlas), and the
controls are the record of who asked for what. So taking a team off is a control too:

- **`retire`** (with an optional note) and **`restore`**, in the team's controls. The team is off the site while the
  newest of the two is a `retire` (`retiredOf`, `lib/tasks/controls.ts`).
- **From the site**: an admin, with their authenticator code, from the team's overview ("On the site"). Only when no
  Mac runs it, by the rule in 4: a team whose lead still reports would carry on, unseen. Then the panel says to
  unregister it on its Mac instead. Put back from the same panel, with a code.
- **From the Mac**: `a6g unregister` of a team whose tasks are in MongoDB, on its lead, records a `retire` (by the
  operator, "unregistered on <machine>"). `a6g register` records a `restore` when it publishes a team that's off.
  Either says so; a store it can't reach is a warning, not a failure.
- **A report after it was taken off puts it back** (`offSite`, `web/server/views.ts`): a Mac that was asleep, or a lead
  moved to another Mac (registered there before the old one was unregistered), runs it again, and a team a Mac runs is
  never hidden.
- **What "off" means on the site**: not on Teams (a line at the foot lists those taken off, for admins), not in
  Waiting on you or the header's count, never in an email, not in the team switcher, the notification settings or the
  invitations. Its pages still open from a link, each with a notice saying it's off, since when and who took it off.
  Its tasks, decisions and history stay, and its name stays taken: its tasks carry the name.
- **The watchdog** marks both kinds applied and does nothing else; older versions pass over a kind they don't know.

### 3. Teams set up at the terminal

- **`a6g init`** keeps a new team's tasks in MongoDB by default on a Mac connected to it (`a6g connect mongo`), and
  says so; `--store files` keeps them on the Mac. On a Mac that isn't connected, files, as before.
- **A name taken in MongoDB is refused** (`nameTaken`, `lib/commands/init.ts`), unless the checkout is that team's
  own already: published settings, any task, or any control but the web app's ask to start it. Otherwise a new team
  named like an old one (the folder's name by default) would share its tasks and controls. When MongoDB doesn't
  answer, init says it couldn't check and carries on.
- **Teams** (admins): a line names the teams the linked Macs run that the site doesn't show, and why: "its tasks are
  in files on that Mac", or "not published yet" (`a6g register` publishes it).

### 4. A team no Mac runs

- **The rule** (`quietSince`, `web/server/views.ts`): a team's lead reports its state on every full watchdog run, about
  every five minutes. No report for 15 minutes (`ONLINE_MIN`, as for a machine), or none at all 15 minutes after it was
  published, means no Mac runs it now.
- **Teams**: a "no Mac runs it" mark beside the team's state, saying when it was last heard from. The team's own
  pages show it in their header.
- **Waiting on you**: under such a team's name, "No Mac has run this team since …: an answer waits until one does."

### 5. The row's figure

The pill is a link to the team's Waiting on you; a link in the fold's header goes where it says and leaves the fold
be. Out of the tab order, so the header stays one key: the open row's foot has the same link.

## Security

- Taking a team off or putting it back is an admin's, with a code from their authenticator, recorded in the audit log
  (`team.retired`, `team.restored`) and in the team's controls. No new grant for the app's database user: it adds a
  control, as for a pause.
- Taking a team off never stops it: the site refuses while its lead reports, and says how to stop it on its Mac.
- Waking a finished team spends only on work someone added after it finished.

## Changes

- `lib/tasks/controls.ts`: the `retire` and `restore` kinds, `retireControl`, `restoreControl`, `retiredOf`.
- `lib/holds.ts`: both marked applied, nothing done.
- `lib/commands/watchdog.ts`: "since" from either mark; a finished team wakes for new work.
- `lib/commands/team.ts`: `unregister` retires a lead's Mongo team; `publishTeam` restores one that's off.
- `lib/commands/init.ts`: MongoDB by default when connected. `bin/a6g.ts`: help.
- `plugin/agents/planner.md`: new work after the finish.
- `web/server/factory.ts`: `allTeams` without the teams taken off (`{ retired: true }` for all), `retirements`,
  `retireFromWeb`, `restoreFromWeb`. `web/server/access.ts`: `team:retire`, admins only. `web/server/audit.ts`:
  the two actions. `web/server/views.ts`: `quietSince`, the controls' words.
- `web/app/page.tsx` (marks, the two lines at the foot), `web/app/t/[team]/layout.tsx` (notice, mark),
  `web/app/t/[team]/page.tsx` and `web/components/site-panel.tsx` (On the site), `web/app/t/[team]/actions.ts`
  (`siteAction`), the inbox pages, `web/app/layout.tsx` (the count), `web/server/notifier.ts`, the notification
  settings, `web/app/admin/people/page.tsx`, `web/app/machines/page.tsx`, `web/app/globals.css`.
- Docs: `README.md`, `web/README.md`, `CHANGELOG.md` (0.8.1).

## Validation

- Factory tests: a finished team wakes for work added after it finished, not for what was there before, and loses
  its mark; `retiredOf`; the watchdog marks the new kinds applied; `a6g init` picks MongoDB when connected.
- Web: unit (the words, `quietSince`), integration over a throwaway MongoDB (taking off, putting back, refusing while
  the lead reports, what `allTeams` leaves out), end to end (the pill; the mark; the inbox's note; taking a team off
  with a code and putting it back; the line for a Mac's unshown team).
- Screenshots of each changed page, light and dark, desktop and phone, looked over and fixed.
- An independent review of the whole change, its findings fixed or answered.
- Rollout: before installing, check that a finished team on this Mac has nothing that would count as new work since
  it finished (it would wake and spend at once). After: the watchdog's next run of each team reads as before; both
  sites answer; their logs show no errors.

## Not in this

Starting a project by cloning a repository, or with a new repository on GitHub too, from the site; registering a
team that's set up but not running; adding a Mac to a team as a worker. Next, in a plan of their own.

## Review

An independent review of the whole change (a fresh agent, given the code and this plan, not my conclusions) found five
real problems; each is fixed above and tested:

1. A woken finished team on an older planner might never mark itself complete again, and be ticked every 10 minutes:
   the wake now says to run `a6g complete`, in a message every version reads.
2. The team's own activity woke a finished team, and each wake repeated the whole finish: only work from outside it
   counts now, and the planner reports again only when the round built something.
3. A team taken off while its Mac slept, or whose lead moved, ran on unseen: a report after the take-off puts it back.
4. `a6g init`'s new default could quietly join an existing team's graph: a taken name is refused.
5. Saving notification settings dropped the mutes of teams that are off: they're kept (`mutedAfter`).

Noted and left: the notifier's cursor for a team that comes back sends what it missed in one go; `retirements()` reads
the controls by kind with no index of its own (a handful per team); `a6g unregister` on a lead leaves its workers
claiming approved work until they're unregistered too; "since" compares the Mac's file time with the web server's.

## Checklist

- [x] The row's figure is a link (5)
- [x] A finished team wakes for new work (1)
- [x] Taking a team off the site and putting it back (2)
- [x] Teams set up at the terminal (3)
- [x] A team no Mac runs (4)
- [x] Tests, screenshots, review: factory 748 of 749 (one skipped, as before), web unit and integration 152, browser
      55; screenshots of each changed page in both themes at desktop and phone width, looked over (the answer
      forms of a team no Mac runs promised "within a minute": now they say it waits)
- [x] Merged, released as 0.8.1, deployed to both sites, installed on the operator's Mac
