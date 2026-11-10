# Plan: the scaffolder, and checks that hold

Status: planned. Built on `subscriptions-accounts` (branch `scaffolder-harness`); ships with it, or after it.

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
   journeys as specs, re-run after merges; pages compared with how they looked when the UX specialist passed them.
5. **Someone who owns the means of checking.** The harness (the browser runner, sign-ins, test data, stand-ins for
   outside services, screenshot rules) has to be set up, kept working and extended as features need. Today nobody
   owns it, and a team without the right tools in its repository gets none.
6. **An environment the checks can trust.** A check that fails because another member's script changed its data, or
   the app restarted under it, teaches the team to ignore checks.

Two constraints from the constitution shape every answer: rules are code (Principle 5: what matters is enforced by a
script, not a prompt), and nobody grades their own work (Principle 9, Article 4). Article 5 forbids weakening a
check; Article 12 keeps the team's rules (`.a6g/`) the operator's.

## Audit of the proposal

The proposal was a separate agent, the scaffolder, that sets a repository up and keeps its harnesses, started by the
planner when it's needed, so the planner's prompt doesn't grow. Measured against the six needs:

| Need                  | Does an agent meet it?                                                     | What else it takes                                                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3. Seeing it work     | Partly: it can set Playwright up in the repository                         | Factory code, so every team checks pages from day one whatever the repository has: the factory carries its own Playwright, and the page checks learn sign-ins, class-based dark modes, stable screenshots and more of the rubric (targets, clipping, focus) |
| 4. Keeping it working | No: an agent re-running checks is a prompt, and prompts aren't enforcement | Factory code: the merge queue re-runs journeys and page checks after merges and files what broke; a journey is done only while its specs pass; the finish line needs them passing now                                                                       |
| 5. Owning the harness | Yes: this is the scaffolder's job                                          | A lane, task kinds only it claims, and triggers that don't depend on the planner noticing                                                                                                                                                                   |
| 6. A trustworthy env  | Partly: fixtures that keep members' data apart are harness work            | Factory code: a merge's restart waits for checks using the app; browser runs are limited; each run is given a namespace for its data                                                                                                                        |
| Small planner prompt  | Yes, if the scaffolder's knowledge lives in its own prompt                 | The planner's members table already lists roles from one summary line each (`lib/prompts.ts`); it gains that line and a few sentences                                                                                                                       |
| Starting a repository | Yes: an app skeleton on the stack the operator chose at setup              | Setup asks the stack for an empty repository; a `scaffold` task kind                                                                                                                                                                                        |

So the agent is right but not sufficient: most of what makes quality hold is factory code, which the agent feeds.

Problems the audit found in the proposal, and how this plan answers them:

1. **The factory would run the team's commands outside the guard.** If the scaffolder writes a command into a file the
   factory runs (the end-to-end command, the sign-in command, the prune command), that command never passes the
   guard. Answer: before the factory runs a harness command it checks it with the guard's own policy and `never`
   rules, as if the scaffolder typed it, and refuses one that breaks a rule; and a branch that changes the harness
   manifest always needs a review.
2. **Weakening by removal.** A team that writes its own checks could remove one to make the finish line hold. Answer:
   removing a page from the manifest, or deleting or renaming a spec file, counts like removing an assertion: the
   branch needs a reviewer's approval whatever its role. The operator's own checks (`team.json pages`) stay theirs.
3. **Grading its own work.** A builder writing the only spec of the journey it built grades itself. Answer: journey
   specs are `test` tasks, claimed by the tester, or by the scaffolder when the team has none, never by a builder.
4. **Rules stay the operator's.** The harness manifest describes the team's means of checking; it isn't the rules.
   It lives at `.a6g/harness.json` (everything about one repository lives in `.a6g/`), only the scaffolder's lane
   names it, it merges through the queue like code, and it can only add checks to the operator's. Whether the finish
   line counts it is the operator's switch (`team.json harness.finish`).
5. **Cost.** Re-running everything after each of 190 merges would take hours. Answer: after-merge checks are coalesced
   (one run for the newest commit, however many merged meanwhile), page checks re-run only pages whose source
   changed, and runs share a browser slot.
6. **Flaky checks.** A check that fails at random blocks the finish line or gets ignored. Answer: after-merge runs
   retry once; a test that passes on its retry is recorded as flaky and filed for the scaffolder to fix the cause,
   never to skip or loosen (Article 5).
7. **Screenshots that differ for no reason.** Animations (GiveNet's 150 ms fades), the caret, the clock and live data.
   Answer: screenshots with animations off and the caret hidden, and the manifest's masks for live regions.
8. **Pages behind sign-in and class-based dark modes.** `a6g pages` loads pages signed out and sets the browser's
   colour scheme, which GiveNet's `.dark` class ignores. Answer: sign-in states from the harness, and per-scheme setup
   (a class, local storage or a cookie).
9. **Personal data in screenshots** (Article 8; GiveNet's checkout pre-fills a real address). Answer: masks.
10. **Several machines.** The checks need the team's environment, which runs on the lead. Answer: they run on the lead
    only, where the merge queue runs.
11. **Repositories without a UI.** Playwright doesn't apply. Answer: page checks need pages; journeys as specs need a
    Playwright suite. A library or a command-line tool keeps its finish command as today; the scaffolder still owns
    its test setup.

## Decisions

1. **A role, `scaffolder`, not more planner context.** Its knowledge (Playwright set-up, sign-ins, fixtures, stand-ins,
   screenshot rules, flaky tests, app skeletons) is in `plugin/agents/scaffolder.md`, loaded only in its own thread.
   It works like a builder: its own worktree, one task at a time, claimed from the graph, the stop gate, a reviewer
   for every branch. Lane: everything a builder may write, plus `.a6g/harness.json`. Branch `a6g/s<id>-<slug>`. One at
   a time by default.
2. **What it claims.** A new kind, `scaffold` (the repository's structure: an app or package skeleton, its build,
   lint, typecheck and test configuration), and `test-infra` (the harness). `test` too when the team has no tester;
   the tester keeps `test-infra` when the team has no scaffolder. Builders claim neither.
3. **When it runs, without the planner having to notice.**
   - The factory finds gaps and files them for triage as `test-infra` (or `test`) findings by `watchdog`: an app with
     no harness, a journey with no spec, a page the app serves that nothing checks, a flaky spec, and the prune
     check's findings (as a `chore` for builders). It looks at `a6g register` and after merges; a gap is filed once,
     and not again once the planner rejects it.
   - The planner adds a `test-infra` task when a feature needs something to test it that doesn't exist (a fixture, a
     sign-in, a stand-in for an outside service), and makes the feature wait for it (`--after`).
   - The planner adds a `scaffold` task when the brief starts from an empty repository or asks for a new app or
     package.
4. **The harness manifest, `.a6g/harness.json`.** The team's description of its means of checking, written by the
   scaffolder, reviewed, merged by the queue, read from the team's checkout (never a worktree's copy):
   ```json
   {
     "app": "http://localhost:9330",
     "e2e": { "command": "pnpm exec playwright test", "timeoutMin": 20 },
     "auth": { "command": "pnpm exec playwright test --project=auth", "states": { "staff": "e2e/.auth/staff.json" } },
     "pages": [{ "id": "admin", "path": "/admin", "as": "staff", "mask": ["[data-live]"] }],
     "schemes": { "dark": { "htmlClass": "dark" } },
     "minTarget": 44,
     "ignoreConsole": [],
     "prune": { "command": "pnpm exec knip" }
   }
   ```
   Its pages add to `team.json pages.list` (the operator's), never replace them. `a6g check` and the merge queue
   validate it; a branch with an invalid one doesn't merge.
5. **Harness commands pass the guard.** The factory checks each manifest command against the policies and `never`
   rules before running it (`lib/guard.ts`'s rule check, as the scaffolder), and refuses one that breaks a rule.
6. **Removing a check needs a review.** Whatever the branch's role: a page removed from the manifest, a spec file
   deleted or renamed under the end-to-end folder, or a journey tag removed, like an assertion removed today.
7. **The factory carries Playwright.** `playwright` 1.64.1 becomes a dependency; `a6g self-install` downloads its
   Chromium; `a6g doctor` checks it. `a6g pages` uses the repository's own Playwright when it has one, else the
   factory's. Every team can check pages from its first day.
8. **Page checks learn the rest of the rubric that a script can check.** Per scheme setup (a class on `<html>`, local
   storage, a cookie); sign-in states from the harness (`as`); screenshots with animations off, the caret hidden and
   masks; touch targets under `minTarget` on phones (default 24 px, WCAG 2.2 AA); text clipped by its box; controls
   with no visible focus ring (desktop, light, the first 40 stops). Each screenshot's hash is recorded.
9. **A UX pass carries to a new commit only when the page looks the same.** When the page passes its checks and every
   screenshot matches the ones taken at the commit the UX specialist passed, the pass holds; otherwise the page is due
   again. After a merge, the pages that look different are listed: that's the visual regression check, and the UX
   specialist audits only those.
10. **Journeys as specs.** A journey's specs are Playwright tests tagged `@journey-<id>`. `a6g e2e run|status|done`
    runs the suite against the team's app, records each test's result for the commit, and says which journeys have
    specs. With a harness that has `e2e`: a journey can be marked done only while it has specs and they pass at the
    integration branch's head, and `a6g finish` needs `a6g e2e done` as well as the team's own finish command (unless
    `team.json harness.finish` is `false`).
11. **After merges, one run for the newest commit.** The merge queue starts a background verification after the
    after-merge command: page checks for pages whose source changed, the whole end-to-end suite (one retry), and the
    gap check. If one is already running, it runs again for the newest commit when it finishes. What newly fails is
    filed as a finding (`bug`, major, by `merge-queue`, naming the merges since the last passing run, the test or page
    and its first error), and the planner is woken.
12. **The shared environment stays, with its state kept apart.**
    - A merge's restart waits for the checks using the app: `a6g pages`, `a6g e2e`, `a6g env use -- <command>` (a
      member's own run) and `a6g env hold <minutes>` (an interactive audit, at most 30) hold the app as readers; the
      after-merge command is the writer, which lets no new reader in, waits for the current ones (up to 30 minutes),
      then restarts.
    - Browser runs share `team.json harness.browsers` slots (default 1), so two suites don't starve the machine.
    - Every harness run gets `A6G_NAMESPACE` (the member's branch, like `b12`; `team` for the factory's own runs);
      the scaffolder's fixtures make their records under it and remove them after.
13. **Setup.** `draftTeam` adds a scaffolder to any repository with an app, a UI, or nothing yet. For an empty
    repository the setup agent asks the stack (framework, package manager, how it's tested) and writes it in the brief;
    the planner's first task is then a `scaffold` task.
14. **The planner's prompt gains one table row and a few sentences**: what the scaffolder owns, that a feature needing
    a harness waits on a `test-infra` task, that journeys are done only while their specs pass, and that the merge
    queue files what breaks. The cycle's "sweep for regressions" step becomes the factory's.

## Not in this release

- **A database of its own for a branch that changes the schema.** It depends on each stack (Supabase's API serves one
  database), so it becomes an adapter verb (`env.sh branch-db <branch>`) a later release adds; until then, schema
  branches are proven with in-memory database tests and checked right after they merge.
- **Measuring quality** (defects found after merge, first-pass reviews). The after-merge findings record the merges
  they came after, so a later `a6g metrics` can count them.
- **Turning the team's lessons about the factory into factory fixes.**
- **End-to-end runners other than Playwright** for journeys. A team with Cypress keeps it; its journeys get Playwright
  specs from the scaffolder.

## Files

| File                                                                          | What                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `lib/config.ts`                                                               | the `scaffolder` role, its branch, `harness` settings (`finish`, `browsers`), the review default       |
| `lib/harness.ts` (new)                                                        | the manifest: load, validate, merge with `team.json pages`; commands checked by the guard's rules      |
| `lib/tasks/model.ts`, `lib/commands/task.ts`                                  | the `scaffold` kind; claims by team; journeys done only while their specs pass                         |
| `lib/guard.ts`, `plugin/hooks/stop.ts`, `lib/prompts.ts`                      | the scaffolder's commands, stop gate and prompt text; `a6g env use/hold/release` for members           |
| `lib/commands/pages.ts`                                                       | the factory's Playwright, schemes, sign-ins, masks, new checks, screenshot hashes, the UX carry-over   |
| `lib/commands/e2e.ts` (new)                                                   | `a6g e2e run                                                                                           | status | done` |
| `lib/commands/harness.ts` (new)                                               | `a6g harness check [--file]` (gaps) and `verify` (the after-merge run)                                 |
| `lib/lock.ts`, `lib/commands/tools.ts`                                        | readers and a writer on the app; `env use`, `env hold`, `env release`; `finish` with `e2e done`        |
| `lib/commands/merge.ts`                                                       | the writer side of the app lock, the manifest's validation, removals needing review, starting `verify` |
| `lib/detect.ts`, `plugin/agents/setup.md`                                     | the scaffolder in the draft team; the stack for an empty repository                                    |
| `plugin/agents/scaffolder.md` (new)                                           | the role's prompt                                                                                      |
| `plugin/agents/{planner,tester,ux-specialist,reviewer,builder}.md`            | the few sentences each needs                                                                           |
| `lib/commands/install.ts`, `lib/commands/doctor.ts`, `package.json`           | Playwright shipped, its Chromium downloaded and checked                                                |
| `schema/team.schema.json`, `schema/harness.schema.json` (new), `docs/team.md` | the role, the kind, `harness`, the manifest                                                            |
| `web/` (task form)                                                            | the `scaffold` kind                                                                                    |
| `README.md`, `CHANGELOG.md`                                                   |                                                                                                        |

## Checklist

### Phase 1: the scaffolder role

- [ ] `ROLES.scaffolder` (worktree, limit 1, write `*` and `.a6g/harness.json`), branch `a6g/s<id>-…`, `branchFor`.
- [ ] Kind `scaffold`; claims by team (`scaffold`, `test-infra`, and `test` without a tester).
- [ ] Guard: claim, release and submit; the stop gate; prompts (claim text, board text, blast).
- [ ] `review.required` includes the scaffolder by default; schema, `docs/team.md`, `draftTeam`, setup's table.
- [ ] `plugin/agents/scaffolder.md`; the planner's, tester's and reviewer's sentences.

### Phase 2: Playwright in the factory, and page checks that see more

- [ ] `playwright` dependency; self-install downloads Chromium; doctor checks it; the repository's copy first.
- [ ] Schemes setup, sign-in states, masks, animations off; target size, clipping and focus checks; screenshot hashes.
- [ ] The UX carry-over and the list of pages that look different.

### Phase 3: the harness manifest

- [ ] `lib/harness.ts`: load and validate `.a6g/harness.json`, merge pages, check commands with the guard's rules.
- [ ] `a6g check` validates it; the merge queue refuses an invalid one and requires a review for removals.

### Phase 4: journeys as specs

- [ ] `a6g e2e run|status|done` (Playwright's JSON report, `@journey-<id>` tags, results per commit).
- [ ] A journey is done only while its specs pass; `a6g finish` needs `e2e done` (`harness.finish`).

### Phase 5: the shared environment

- [ ] Readers and a writer on the app (`lib/lock.ts`); `env use`, `env hold`, `env release`; browser slots.
- [ ] `A6G_NAMESPACE` for every harness run.

### Phase 6: after merges, and gaps

- [ ] `a6g harness verify`: coalesced, page checks for changed pages, the suite with one retry, findings for what
      newly fails, flaky tests filed, the planner woken.
- [ ] `a6g harness check [--file]`: gaps filed once, not again once rejected; at register and after merges.
- [ ] The prune check, at most daily.

### Phase 7: documents and release

- [ ] The UX specialist's and builder's sentences; README, CHANGELOG, `docs/team.md`, the web task form.
- [ ] Every test passes; new tests for each part.
