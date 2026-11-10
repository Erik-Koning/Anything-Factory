# Plan: the scaffolder, and checks that hold

Status: planned and reviewed (see Review); Phase 1 built. Built on `subscriptions-accounts` (branch
`scaffolder-harness`); ships with it, or after it.

## Why

GiveNet's team (1–3 Nov 2026, 216 tasks, $793 API-equivalent) built 10 features and fixed 161 defects: 122 UX and 39
bugs, 101 of them filed by the UX specialist looking at pages. About a third of those fixes (55) were kinds a browser
check finds without judgment: contrast, clipped or overflowing text, missing labels, touch targets under 44 px, focus.
Each one cost a whole task: a finding, an approval, a builder, a review and a merge.

No end-to-end test ran. The factory has a tester (a spec per journey, a regression sweep) and `a6g pages` (axe, overflow,
console errors and screenshots per page, viewport and colour scheme), but both need the repository's own Playwright,
which GiveNet hadn't got: setup proposes a tester only when it finds one (`lib/detect.ts:246`), and nothing set
`pages` up. The team's one test-infrastructure finding (#162) had nobody to claim it, so it was folded into a builder's
task; flaky tests (#165, #182) were fixed as builders' chores.

Journeys were checked once and never again. Journey #2 was signed off and 105 merges landed after it; across the eight
journeys, 16 to 105. The finish line counted them done because they'd been marked done; the gate (typecheck, lint,
Vitest, build) doesn't walk a journey.

And about twelve of the team's 38 lessons work around its one shared environment: a merge's restart stopping an audit,
members' apps changing each other's records, a schema change that can't be tried before it merges.

## First principles

Software is good here when what the brief asks for works for the people it's for, keeps working as the team changes
it, and the operator can trust that without checking it themselves. That takes six things:

1. **Knowing what to build.** The brief, the direction and the journeys with their criteria. The factory has this.
2. **Building it right.** A builder, tests at the right level, a reviewer who didn't write it. The factory has this.
3. **Seeing it work as a person would.** In a browser, at each size and colour scheme, signed in as each kind of user.
   Today an agent's judgment, once. Needed: checks that run themselves.
4. **Keeping it working.** Every change re-checks what was already done. Today nothing re-walks a journey. Needed:
   journeys as specs, re-run after merges, and a journey is done only while they pass; pages re-checked, and
   compared with how they looked when the UX specialist passed them.
5. **Someone who owns the means of checking.** The harness (the browser runner, sign-ins, test data, stand-ins for
   outside services, screenshot rules) has to be set up, kept working and extended as features need. Today nobody
   owns it, and a team without the right tools in its repository gets none.
6. **An environment the checks can trust.** A check that fails because another member's script changed its data, or
   the app restarted under it, teaches the team to ignore checks.

Two constraints from the constitution shape every answer: rules are code (Principle 5: what matters is enforced by a
script, not a prompt), and nobody grades their own work (Principle 9, Article 4). Article 5 forbids weakening a
check; Article 12 keeps the team's rules (`.a6g/`) the operator's.

## Audit of the proposal

The proposal was a separate agent, the scaffolder, that sets a repository up and keeps its harnesses, started when
it's needed, so the planner's prompt doesn't grow. Measured against the six needs:

| Need                   | Does an agent meet it?                                                     | What else it takes                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3. Seeing it work      | Partly: it can set Playwright up in the repository                         | Factory code, so every team checks pages from its first day whatever the repository has: the factory carries Playwright, and page checks learn sign-ins, class-based dark modes, stable screenshots and more of the rubric |
| 4. Keeping it working  | No: an agent re-running checks is a prompt, and prompts aren't enforcement | Factory code: the merge queue re-runs journeys and page checks after merges and files what broke; a journey is done only while its specs pass; the finish line needs them passing at its commit                            |
| 5. Owning the harness  | Yes: this is the scaffolder's job                                          | A lane, task kinds only it claims, and gaps filed by the factory rather than noticed by the planner                                                                                                                        |
| 6. A trustworthy env   | Partly: fixtures that keep members' data apart are harness work            | Factory code: runs against the shared app take its lock, a merge's checks run where no merge can move the code under them, and each run gets a namespace for its data                                                      |
| A small planner prompt | Yes, if the know-how lives in the scaffolder's own prompt                  | The planner's members table already has one line per role (`lib/prompts.ts`); it gains that and a few sentences                                                                                                            |
| Starting a repository  | Yes: an app skeleton on the stack the operator chose at setup              | Setup asks the stack for an empty repository; a `scaffold` task kind                                                                                                                                                       |

So the agent is right but not enough: most of what makes quality hold is factory code, which the agent feeds. Problems
the first audit found in the proposal itself: the factory running commands the scaffolder wrote outside the guard;
checks weakened by removing them; a builder writing the only spec of its own journey; cost; flaky checks; unstable
screenshots; pages behind sign-in; dark modes set by a class; personal data in screenshots; several machines; and
repositories without a UI. The decisions below answer each, as revised by the review that follows them.

## Decisions

1. **A role, `scaffolder`, not more planner context.** Its know-how is in `plugin/agents/scaffolder.md`, loaded only
   in its own thread. It works like a builder: its own worktree, one task at a time from the graph, the stop gate.
   Lane: a builder's plus `.a6g/harness.json` (kept even when `team.json` sets its `write`). Branches
   `a6g/s<id>-<slug>`. Every scaffolder branch is reviewed, whatever `review.required` says.
2. **What it claims, and where it may write for each.** A new kind, `scaffold` (the repository's structure: an app or
   package skeleton and its build, lint, typecheck and test set-up), anywhere a builder may write; and `test-infra`
   (the harness), plus `test` where the team has no tester, whose branches the merge queue holds to test and harness
   files: test files, the test folders, Playwright's and the test runner's configuration, package manifests and
   lockfiles, and the manifest. A product change is a builder's task. A tester keeps `test-infra` where the team has
   no scaffolder. Builders claim none of these, and a builder's branch may not add or change a `@journey-` tag: the
   specs that prove a journey come from someone who didn't build it.
3. **Gaps are filed by the factory**, from `a6g register` and after merges, by `merge-queue` (the watchdog never
   touches a checkout): an app with pages and no harness, a journey with no tagged spec, and a flaky spec. Each is
   filed once for triage, and not again once the planner rejects it. The planner adds a `test-infra` task when a
   feature needs something to test it (a fixture, a sign-in, a stand-in) and makes the feature wait for it, and a
   `scaffold` task when the brief starts from an empty repository or asks for a new app or package.
4. **The manifest only adds checks, and holds no commands.** `.a6g/harness.json` is read from the team's checkout
   (never a worktree's copy) and validated by `a6g check` and the merge queue:
   ```json
   {
     "e2e": { "config": "playwright.config.ts", "timeoutMin": 20 },
     "auth": { "project": "auth", "states": { "staff": "e2e/.auth/staff.json" } },
     "pages": [{ "id": "admin", "path": "/admin", "as": "staff", "mask": ["[data-live]"] }],
     "schemes": { "dark": { "htmlClass": "dark" } }
   }
   ```
   The factory runs the repository's own Playwright with that configuration (and the `auth` project in it to make
   the sign-in states); it never runs a command from the manifest. Everything that could loosen a check stays the
   operator's, in `team.json pages`: the app's address, the console messages to ignore, the smallest touch target,
   the viewports and schemes, and what a page's source is. The manifest's pages join the operator's (an id the
   operator listed stays theirs). A scheme's set-up must change the page: a dark screenshot the same as the light
   one is a problem, not a pass.
5. **Narrowing a check is the operator's call** (Article 5). The merge queue compares a branch with the integration
   branch and refuses one that narrows the checks unless the operator allowed that exact commit
   (`a6g harness allow <branch> --sha <commit> --why "…"`, which no agent may run; the planner asks with a question):
   - a page removed from the manifest, or its path or sign-in changed;
   - `e2e` or `auth` removed, or `e2e.config` changed;
   - fewer tests in the suite, or fewer for a journey (`playwright test --list`, before and after, in the merge's
     scratch worktree);
   - lines added to test or configuration files that skip or narrow tests: `.skip(`, `.fixme(`, `.only(`,
     `test.fail(`, `testIgnore`, `grepInvert`, `retries`.
6. **The factory carries Playwright; page checks always use it.** `playwright` 1.64.1 is a dependency,
   `a6g self-install` downloads its Chromium, `a6g doctor` checks it. One browser for every page check, so a change in
   the repository's Playwright doesn't change what pages look like. The repository's own Playwright runs its specs.
7. **Page checks see more of the rubric.** Per-scheme set-up (a class on `<html>`, `localStorage`, a cookie); sign-in
   states (`as`); screenshots with animations off, the caret hidden and the manifest's masks; touch targets under
   `team.json pages.minTarget` on phones (default 24 px, WCAG 2.2 AA; links inside a sentence excepted); text clipped
   by its box (an ellipsis excepted); controls with no visible focus (desktop, light, the first 40 stops).
   `a6g pages shots` (anyone, any address, records nothing) uses the worktree's manifest, so a builder or the
   scaffolder can check a branch before it's handed in.
8. **Pages that look different are listed, and nothing more.** When the UX specialist passes a page at a commit the
   factory checked, its screenshots are kept. Later checks compare against them (pixels, with a small tolerance) and
   list the pages that look different since their pass, so an audit starts there. The rule for a UX verdict doesn't
   change: any change to a page's source makes it due.
9. **Journeys as specs.** A journey's specs are Playwright tests tagged `@journey-<id>` (exact: `@journey-1` isn't
   `@journey-12`).
   - `a6g e2e run` (the planner and the merge queue, in the team's checkout on the integration branch) runs the suite
     against the team's app and records each test's result for the commit; `a6g e2e try [files…]` (anyone, records
     nothing) runs it from a worktree; `a6g e2e status` says which journeys have specs and how they fared;
     `a6g e2e done` exits 0 only when every journey has specs and the whole suite passed at the integration branch's
     head.
   - The factory runs `playwright test --config <config>` with its JSON report written to the run folder,
     `PLAYWRIGHT_BASE_URL` set to the team's app, `A6G_NAMESPACE` set for the run, and its output folder outside the
     checkout, so a run never leaves the checkout dirty.
   - A journey moves to done (by the planner, or settled by the queue) only on a recorded run at a commit that holds
     all its tasks' merges, in which it had specs and they all passed. The operator may still mark one done.
   - With `team.json harness.journeys` `"required"` (the default for a team with a scaffolder or tester),
     `a6g finish` also needs `a6g e2e done`. `a6g complete` writes the team's complete marker only when the finish line
     holds; the planner can no longer write it by hand. A cycle's report says how the suite stands.
10. **After merges, one check of the newest commit, where nothing moves under it.** When a queued merge has finished
    its after-merge command, and no other merge is waiting, the queue checks the integration branch: it takes the
    merge lock (so nothing fast-forwards the checkout), then the app lock (so nothing restarts it), then a gate slot;
    runs the page checks for every page and the whole suite with one retry, as its own namespace; records the results;
    and throws them away if the checkout's commit moved anyway. What newly fails is filed: one finding per page, and
    one per spec file, by `merge-queue`, naming the merges since the last passing run. A test that passes on its retry
    is flaky: a `test-infra` finding. Then the gaps, and the planner is woken if anything is new. It doesn't run when
    the after-merge command failed (the app may be down). A merge that arrives while one runs waits for it.
11. **The shared environment stays, used one run at a time.** `a6g env use -- <command>` runs a member's command
    against the team's app under the app lock (the same lock `a6g lock app` takes, waiting up to 8 minutes), with
    `PLAYWRIGHT_BASE_URL` and an `A6G_NAMESPACE` from the member's branch (`b12`). The guard looks through it to the
    command, as it does for `a6g lock … --`. `a6g pages run|shots` against the team's app and `a6g e2e run` take the
    same lock; the after-merge command holds it and passes that down (`A6G_APP_LOCK`), so its own checks don't wait on
    it. Locks are always taken in one order: merge, then app, then gate. The scaffolder's fixtures make their records
    under `A6G_NAMESPACE` and remove them.
12. **Setup.** `draftTeam` adds a scaffolder to any repository with an app, a UI, or nothing yet; for an empty
    repository the setup agent asks the stack and writes it in the brief, and the planner's first task is a
    `scaffold` task.
13. **The planner's prompt gains one table row and a few sentences:** what the scaffolder owns, that a feature
    needing a harness waits on a `test-infra` task, that journeys are done only while their specs pass, and that the
    merge queue files what breaks. The cycle's "sweep for regressions" becomes the queue's.

## Not in this release

- **A database of its own for a branch that changes the schema.** It depends on each stack (Supabase's API serves one
  database), so it's a later adapter verb (`env.sh branch-db <branch>`); until then such branches are proven with
  in-memory database tests, and checked right after they merge.
- **Page checks before a merge, enforced.** Builders and reviewers run `a6g pages shots` against the branch's own
  preview (their prompts say so); enforcing it needs the branch's app running, which the queue can't do yet.
- **Criteria-level journey tags** (`@journey-12-c3`), so a journey's every criterion has a test. Until then, the
  reviewer judges whether a journey's specs assert its criteria.
- **Measuring quality** (defects found after merge, first-pass reviews). After-merge findings name the merges they
  came after, so a later `a6g metrics` can count them.
- **Cut after review:** an interactive hold on the app (`env hold`), browser slots, a prune check, discovering the
  routes an app serves, and re-checking only pages whose source changed.

## Review (2026-11-09)

An independent review of the first version of this plan, against the code, found these; the decisions above are the
answers.

1. **The manifest could loosen checks** (console rules, masks, the target size, the app's address, a filtered
   end-to-end command, dropping `e2e`), and "a review for removals" adds nothing for branches that need one anyway.
   Now: the manifest holds only additive fields and no commands; loosening settings are the operator's in `team.json`;
   narrowing, by the manifest or by the suite (`--list` before and after, skip and filter lines), needs the operator's
   approval of the exact commit (Decisions 4, 5).
2. **`a6g env use -- <command>` would have slipped past the guard**, which looks through only `a6g lock … --`. Now
   the guard looks through `env use` too, with tests (Decision 11).
3. **The planned readers-and-writer locks deadlocked** (the after-merge command's own checks waiting on it; no lock
   order; `a6g lock app` going around it). Now: one exclusive app lock, passed down to nested checks, and a fixed
   order: merge, app, gate (Decisions 10, 11).
4. **A lock on restarts doesn't stop the code moving**: the fast-forward happens under the merge lock and a dev server
   reloads. Now the after-merge check holds the merge lock too, and discards a run whose commit moved (Decision 10).
5. **Latency and starvation** from long reader holds. Now: no long holds by members (a single command at a time), the
   planner is woken by each merge as today, and the check runs only when no merge is waiting (Decision 10).
6. **A journey's "done" had ways round it**: the queue settling a journey, the hand-written complete marker, cycles,
   and "passing at head" while merges outrun the suite. Now: the check is in the move rules for every way to done, on
   the latest checked commit that holds the journey's merges; `a6g complete` writes the marker; a cycle's report says
   how the suite stands (Decision 9).
7. **Anyone could have recorded end-to-end results.** Now `run` is the planner's and the queue's, in the team's
   checkout; `try` records nothing (Decision 9).
8. **The scaffolder could change product code to make its own specs pass.** Now test and test-infra branches stay in
   test and harness files, and builders can't add journey tags (Decision 2).
9. **A screenshot hash is a weak test of "looks the same", and carrying a UX pass on it loosened today's rule.** Now
   comparisons only list pages to look at; the verdict rule is unchanged; the factory's Chromium takes every page
   screenshot (Decisions 6, 8).
10. **Finding defects after merge doesn't prevent them.** Partly answered: `pages shots` works on a branch's preview
    with its manifest, and the builder's and reviewer's prompts use it; enforcing it is in Not in this release.
11. **Scaffolder branches were reviewed only by default.** Now always (Decision 1).
12. **The watchdog can't run checks in a checkout.** Now gaps are filed from register and after merges (Decision 3).
13. **Coalescing could lose a run.** Now a due-mark is set before the lock is tried, and the holder re-checks it after
    it lets go (Decision 10).
14. **Running the suite was fragile** (the JSON report in stdout, inexact tag filters, the base URL). Now the report
    goes to a file, tags are matched exactly from it, and the factory sets the base URL (Decision 9).
15. **One namespace for all the factory's runs.** Now one per run (Decision 10).
16. **Checking a command string protects little, and a run could dirty the checkout.** Now the manifest has no
    commands, and output goes outside the checkout (Decisions 4, 9).
17. **The scaffolder couldn't check its own branch's manifest.** Now `pages shots`, `e2e try` and `harness check`
    read the worktree's manifest (Decisions 7, 9).
18. **A 24 px default against a 44 px rubric, and false findings.** The operator sets `minTarget` from the rubric;
    links in a sentence and ellipses are excepted (Decision 7).
19. **Cuts and order.** The prune check, `env hold`, route discovery and per-page re-checks are cut; the manifest is
    built before the page checks that read it.

## Files

| File                                                                     | What                                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `lib/config.ts`                                                          | the `scaffolder` role and its branch; `pages.minTarget`; `harness.journeys`                                         |
| `lib/harness.ts` (new)                                                   | the manifest: parse, read (checkout, worktree or commit), page plan, narrowing between two commits                  |
| `lib/browser.ts` (new)                                                   | the factory's Playwright and Chromium; installing and checking it                                                   |
| `lib/tasks/model.ts`, `lib/commands/task.ts`, `lib/tasks/ops.ts`         | the `scaffold` kind; claims; a journey done only on a passing run                                                   |
| `lib/guard.ts`, `lib/shell.ts`, `plugin/hooks/stop.ts`, `lib/prompts.ts` | the scaffolder's commands; `env use` looked through; `harness allow` the operator's; no hand-written complete       |
| `lib/commands/pages.ts`                                                  | the factory's browser, schemes, sign-ins, masks, the new checks, kept looks                                         |
| `lib/commands/e2e.ts` (new)                                              | `a6g e2e run                                                                                                        | try | status | done` |
| `lib/commands/harness.ts` (new)                                          | `a6g harness check [--file]`, `allow`, and the after-merge check                                                    |
| `lib/commands/tools.ts`                                                  | `env use`; `finish` with `e2e done`; `complete`; keeping a page's looks on a UX pass                                |
| `lib/commands/merge.ts`                                                  | lanes by kind, journey tags, the manifest's validation, narrowing, always reviewing the scaffolder, the check after |
| `lib/detect.ts`, `plugin/agents/setup.md`                                | the scaffolder in the draft team; the stack for an empty repository                                                 |
| `plugin/agents/scaffolder.md` (new), the other prompts, the review skill | the role, and the sentences each other role needs                                                                   |
| `lib/commands/install.ts`, `lib/commands/doctor.ts`, `package.json`      | Playwright shipped, its Chromium downloaded and checked                                                             |
| `schema/`, `docs/team.md`, `web/`, `README.md`, `CHANGELOG.md`           |                                                                                                                     |

## Checklist

### Phase 1: the scaffolder role

- [x] `ROLES.scaffolder`, its branch, `branchFor`; the `scaffold` kind; claims; the guard, stop gate and prompts.
- [x] `review.required` default; schema, `docs/team.md`, `draftTeam`, setup's table; the role's prompt; the planner's,
      tester's and review skill's sentences.

### Phase 2: the manifest, and Playwright in the factory

- [ ] `lib/harness.ts`: parse and read the manifest; the page plan; `a6g check` validates it.
- [ ] `playwright` dependency, `lib/browser.ts`, self-install's Chromium, doctor.

### Phase 3: page checks that see more

- [ ] Schemes, sign-ins, masks, stable screenshots; targets, clipping and focus; a scheme that changes nothing.
- [ ] Kept looks on a UX pass, and the pages that look different; `pages shots` with the worktree's manifest.

### Phase 4: journeys as specs

- [ ] `a6g e2e run|try|status|done`; journeys done only on a passing run; `finish`, `complete`, the cycle's report.

### Phase 5: the merge queue

- [ ] Lanes by kind; no journey tags from builders; scaffolder branches always reviewed; the manifest validated.
- [ ] Narrowing refused without `a6g harness allow`.
- [ ] The check after merges: coalesced, locked, discarded if moved, findings, flaky tests, gaps, the wake.

### Phase 6: the shared environment

- [ ] `a6g env use` and the guard looking through it; the app lock passed down; one lock order.

### Phase 7: gaps, documents and release

- [ ] `a6g harness check [--file]` at register; the UX specialist's and builder's sentences; README, CHANGELOG,
      `docs/team.md`, schema.
- [ ] Every test passes; new tests for each part.
