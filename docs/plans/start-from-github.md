# Plan: starting a project from a GitHub repository, and the settings each step takes

Status: built, reviewed and released in 0.8.2 (2026-11-14), at the operator's word ("Yes, and also any other settings
per step that would be prudent"). No project has been started from GitHub for real yet: that spends, and is the
operator's to ask for.

## Why

A project started from the web app can only use a repository already in the Mac's projects folder, or a new one that
stays on the Mac. The operator asked to start one on a GitHub repository by its name: cloned when their account owns it
or can push to it, forked to their account when it can't. And, for each step of a start, the settings it would be
prudent to choose on the form rather than leave to the setup agent's guesses.

## What it is

### Where the code comes from (the Repository step)

Four choices on the form, where there were two:

1. **A new one, on this Mac** (as now).
2. **A new one, on GitHub too**: made as now, then created on GitHub under the Mac's own GitHub account, private
   unless the form says public, and pushed (`gh repo create --source --remote origin --push`).
3. **One already in the projects folder** (as now).
4. **From GitHub**, by `owner/name` or its address. The Mac asks GitHub, as its own account, what that account may do
   with it (`gh api repos/<owner>/<name>`):
   - **It can push** (owner, collaborator, organisation member with write): cloned into the projects folder.
   - **It can only read**: forked to that account first (`POST repos/<owner>/<name>/forks`, which hands back the
     fork that's there already, if one is), then the fork is cloned, the original kept as `upstream`, and the fork
     made gh's default for that clone (`gh repo set-default`).
   - **It can't see it**, or it's archived: the start stops, saying so and what to do.

   The card says which: "Cloned owner/name: Erik-Koning can push to it", or "Forked owner/name to Erik-Koning/name:
   Erik-Koning can't push to the original. Its pull requests go to the fork."

**Is it yours?** The site can't ask GitHub as the operator, and shouldn't hold a GitHub token: the check runs on the
Mac, which reports its GitHub account with what it offers (`projects.github`). The form says which account will be
used, and the card says what happened.

**Someone else's code.** Setting a team up installs a repository's packages and runs its scripts and tests on the Mac.
For a repository whose owner isn't the Mac's GitHub account, the form asks the operator to tick that they trust its
code to run on that Mac, and the Mac refuses an ask without the tick. Forking puts a copy under their account: the
same tick says so.

**Its base**: the branch the team's work starts from and its pull requests go into. The repository's default branch
unless the form names another; a name the repository doesn't have stops the start at this step.

### What it may do on GitHub (the Register step's rules, chosen on the form)

For a repository with a GitHub remote (2, 4, and one in the folder whose `origin` is on GitHub):

- **Nothing**: its work stays on the Mac (`push: null`, as a new team's rules have it now).
- **Push its branch** (`a6g/next`, at most every 6 hours, the planner only).
- **Push its branch and open a pull request into the base**, for the operator to merge: the default for 2 and 4.
  The pull request goes to the repository `origin` names: the fork, for a fork, never the original. Opening one on
  the original stays the operator's.

Nothing merges into the base, or any protected branch, either way: `protectedBranches` holds.

### How it works with the operator (a step of its own on the form)

What the setup agent settles alone when nobody's there, now chosen on the form, each with the safer default:

- **Who chooses the platform and the stack** (moved here, as it is).
- **Its aim**: to a finish line (what the form says, then it stops), or in cycles (it keeps improving toward it,
  resting when nothing's left). `team.json` `mode`.
- **Who approves new work**: the operator, each piece (the default, as the setup agent chooses now); or the team's
  approver up to a medium task, larger ones to the operator (`approval: thresholds`, maxSize M, with an approver).
- **How readily it asks**: hands-on, balanced (the default) or hands-off: the working agreement's level, recorded as
  the operator's control when the team registers.

### When it starts (the last step)

- **As soon as it's set up** (as now), or **set it up, then wait for me**: the Mac records a pause, by the operator who
  asked, before starting the watch, so nothing runs until they resume it from the team's overview. The card ends on
  "Set up and waiting for you".

### Older Macs

A Mac on 0.8.1 or earlier reads only what it knows of an ask, so it would ignore a setting (and start a team asked to
wait). The site offers the new choices only for a Mac whose report says it reads them (`projects.github` is there, null
when it isn't signed in to GitHub), and refuses an ask that has them for any other. Choices 2 and 4 also need the Mac
to be signed in to GitHub.

## Security

- The site sends a repository's name, never a URL to fetch or a command: `owner/name` in GitHub's own characters,
  checked on both sides. The Mac runs `gh` and `git` with arguments, no shell.
- The Mac's GitHub token stays in its own `gh` login; nothing about it goes to the site but the account's name.
- The trust tick for someone else's code, enforced by the Mac as well as the form.
- Pull requests only to the repository the team pushes to; the `github` policy stays denied for the agents.

## Changes

- `lib/tasks/start.ts`: the ask's new fields (`repo.github`, `repo.publish`, `trusted`, `base`, `mode`, `approval`,
  `push`, `level`, `hold`) and their checks; `StartProgress.note`; `GITHUB_REPO`.
- `lib/tasks/controls.ts`: `startOf` keeps the notes.
- `lib/fleet.ts`: `projects.github`. `lib/orders.ts`: the account (`gh api user`, kept an hour), what the ask needs
  of the Mac, and where a repository from GitHub goes.
- `lib/commands/projects.ts`: the repository step's clone, fork and new-on-GitHub; the draft's flags; the agreement
  and the pause at register.
- `lib/commands/init.ts`: `--mode`, `--approval`, `--push`. `plugin/agents/setup.md`: keep them.
- Web: `app/new/start-form.tsx` (the steps), `app/new/actions.ts`, `app/new/page.tsx`, `components/start-card.tsx`
  (the notes), `app/machines/page.tsx` (the Mac's GitHub account).
- Docs: `README.md`, `web/README.md`, `docs/team.md` where it says what a draft holds, `CHANGELOG.md` (0.8.2).

## Validation

- Factory: the ask's checks; the refusals; each repository path through `carryOut` with a stand-in `gh` (clone,
  fork, fork already there, can't see it, new on GitHub, a base it doesn't have); the draft's flags in `team.json`;
  the agreement and the pause at register.
- Web: unit, integration (a report with the account), end to end (the choices for a Mac that reads them and for one
  that doesn't, the tick, the ask as recorded, the card's notes).
- Screenshots of the form and the cards, and a judge's score from them (8 of 10 or better, as before).
- An independent review of the whole change.
- Rollout as for 0.8.1. A real start from GitHub stays the operator's to ask for: it spends.

## Review

An independent review (a fresh agent, given the code and this plan) found eight real bugs; each is fixed and tested:

1. An ask made again kept the first try's rules (init keeps a draft it finds): they're put into the draft again
   (`applyRules`).
2. A fork with a named base always stopped (forked with its default branch only): every branch when a base is named,
   and the original's branch put on a fork that lacks it.
3. A wait an earlier try recorded outlived an ask to start at once: lifted.
4. "Not signed in to GitHub" was kept an hour: five minutes.
5. A try's clone was used again for another repository under the same name: only when its origin or upstream is the
   repository asked for.
6. The tick was checked against the owner asked, not the one GitHub answers with (a moved repository): both.
7. The form promised a wait (and an aim) to a Mac that doesn't read them, after switching Macs: only where they're sent.
8. "Ask again" on an older ask turned pull requests on: nothing, as it was.

And of its smaller points: a token in a remote's address is never shown, origin is checked as GitHub's by its parsed
address, the site refuses an ask with the newer settings for an older Mac outright, and a public repository is said
back on the form.

A judge scored the form and the cards from screenshots (desktop and phone, light and dark) over three rounds: the form
6.5, 7.5, 8.5; the older Mac's 7.5, 8.5, 8.5; the start card 7, 6 (a class name that clashed with another page's broke
its layout), 8.5. Its last nits were taken where they were cheap; ids in running text stay as they are.

Noted and left: a fork GitHub hands back may be behind the original; the team starts from it as it is.

## Checklist

- [x] The ask and its checks
- [x] The Mac: account, clone, fork, new on GitHub, base, flags, agreement, pause
- [x] The form, the card, the Machines page
- [x] Tests (factory 761 of 762, one skipped as before; web unit and integration 152; browser 56), screenshots and a
      judge, review
- [ ] Merged, released as 0.8.2, deployed to both sites, installed on the operator's Mac
