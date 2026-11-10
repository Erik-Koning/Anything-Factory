# Plan: make the checks true, then cover what nothing checks

Status: planned, not started. Follows `harness.md` (built) and answers `harness-audit.md` (38 findings). Part 1 ships
with the scaffolder as 0.7.0; Part 2 is 0.8.0.

## What decides the order

The audit found more than is worth fixing at once. Four tests decide what's in:

1. **A check that lies is worse than no check.** A page that passes while broken teaches the team to trust it; a
   page that fails while fine, with no way out, teaches the team to ignore it. Both go first.
2. **No team stalls on upgrade.** A rule that can never be satisfied stops the work.
3. **A stated guarantee holds against a member who isn't trying hard.** The guard is a seatbelt (README, Known
   limits). We close what a member would fall into or reach for first, and fail closed where a check can't get its
   answer. We don't chase every spelling of an evasion: we measure the result instead.
4. **Measure, don't match.** Wherever a rule read the text of a diff, the audit got round it and it refused honest
   work. Wherever a rule read what Playwright or the browser reported, it held.

## Part 1: make what's built true (0.7.0)

Each decision names the audit's findings it answers.

### A. Nothing stalls (S1, S2, S3, S5, S6, S7)

1. **Journeys are required once there's a suite.** `harness.journeys` left out means required exactly when the
   integration branch's manifest has `e2e`; `"required"` and `"optional"` stay the operator's to set. A team with a
   tester and no harness closes journeys as it does today. One helper, `journeysRequired(home, team)`, replaces the
   five reads of `team.harness.journeys`. The finish line still asks every journey's tests once a suite exists, so a
   journey closed before the suite is caught there.
2. **Playwright is found from the configuration's folder upward**, not only in the root `node_modules`: a monorepo's
   `apps/web/node_modules` is found, and so is the checkout's from the merge's scratch worktree (which is inside it).
3. **`a6g complete` on a team with no finish command** checks what there is (the suite, when required) and no more.
4. **The factory's browser is the headless shell only**, installed with `--only-shell` (203 MB, not 570) under a time
   limit, with one line when it fails. Doctor and every check prove it by launching it, not by looking for a file.
5. **The planner's prompt names `a6g e2e run`**: the way to record a run when no merge does.

### B. One reading of a suite's run (E2, E9, V2, V5)

6. **A record says whether the suite ran.** A run with no report, or one that timed out, didn't run: it proves
   nothing and disproves nothing. Today it reads as "0 passed, 0 failed".
7. **A test's expected status comes from Playwright's report.** A test declared to fail (`test.fail`,
   `test.info().fail()`) or skipped is not a pass, however it's spelled. New outcome `excused`.
8. **Recorded runs set their own retries and forbid `.only`** (`--retries`, `--forbid-only` always passed), so the
   repository's configuration can't forgive a failure.
9. **One function says whether a journey is proven**, for the move rule and the finish line both: every test tagged
   for it passed (skipped and excused count against), in the newest run that holds its merges. A newer run that
   didn't finish is "not proven yet", never a reason to fall back to an older pass.
10. **The time limit is a limit.** The suite starts in its own process group; the limit kills the group, and the
    factory stops waiting 15 s later whatever is left.

### C. Nobody makes their own proof (E1, E3, E4, E5, E6, E7, S4)

11. **A builder's branch changes no file that holds a journey's test**: judged by the file (its text on either side,
    and the merged suite's own listing), not by which lines changed. A feature that changes a journey's flow gets a
    test task with it; the planner's prompt says so.
12. **Checking less is measured first.** After the gate, the merged suite is listed and compared with the integration
    branch's. Fewer tests, or fewer for any journey, is refused; so is a suite that listed before and can't now.
13. **The text match stays as an early, narrow refusal**: only in files that import Playwright's test runner and the
    manifest's configuration, counting net additions (a moved file adds nothing), ignoring comments, without
    `retries` (decision 8 covers it). The diff reader takes headers only between `diff --git` and the first hunk.
14. **After merges, the check compares what passed with the last run**: fewer passing tests for a journey or in all,
    or more skipped, is one finding naming the merges between, unless one of them carried the operator's allowance.
15. **A scaffolder's branch names its own open task**, or it doesn't merge (teams with a task graph). The test lane
    gains the usual files (`global-setup`, `tsconfig.e2e.json`, `.env.test`, mocks, seed scripts, the suite's CI
    workflow), loses an app's own route folders, and reads `package.json` by key: `devDependencies` and test
    scripts only. The operator adds patterns with `harness.lane` in team.json.
16. **A journey with finished work under it changes kind, or is rejected, only by the operator.**

### D. The check after merges always runs, and says what happened (V1, V3, V4, V6, V7, V8, V9)

17. **Every queued merge, however it ends, runs a check that's due.** Queue markers carry the process's start time
    (as locks do) and are cleared on every exit. A lock wait that times out puts the due mark back. A commit that
    moves gets one retry, then the next merge takes it.
18. **The app's health comes first.** Down is one finding ("the app is down after merges"), nothing else runs, and
    the check stays due. A suite that didn't run (decision 6) is one finding with what it printed, and files no gaps.
19. **A rejected finding quiets that failure, not that page.** The check remembers what each page and spec file last
    failed with; a different failure, or the same one after a pass, is filed again.
20. **The check settles what was waiting on it**: journeys whose proof now holds.
21. **`a6g env use` honours `--wait-min`**, and ends a command that holds the app past `--max-min` (30 by default).

### E. Page checks tell the truth (P1 to P8, P10 to P12)

22. **Only what a person can reach is measured.** Touch targets skip what can't be hit: clipped to a pixel,
    `aria-hidden`, `inert`, disabled, invisible, off screen, in a closed `<details>`. A link is "in a sentence" by its
    nearest block, not its direct parent.
23. **The operator can exempt.** A page in team.json takes `ignore` (selectors every in-page check leaves out) and
    `schemes` (a page with no dark variant). Never in the manifest: it only adds checks.
24. **A page is checked where it was asked for.** Ending at another path (a refused session lands on the login page)
    is a problem. A sign-in that fails fails its pages; an old state is never used in its place. An `as` that names
    no state is refused by `a6g check` and at the start of a run.
25. **The page is whole before it's looked at**: the factory's context bypasses the page's content security policy
    for its own scripts, scrolls to the bottom and back so lazy content loads, and takes the screenshot before the
    focus walk.
26. **Clipped text is measured against the box that clips it**: each run of text against its nearest clipping
    ancestor. A line partly in and partly out is clipped; wholly out is hidden on purpose (a carousel, an accordion).
    An ellipsis excuses both directions.
27. **Focus is judged by what's seen.** The walk tells elements apart by identity (so shadow roots and repeated cards
    don't end it), steps over iframes, and for each stop compares the pixels around the control focused and not. It
    says how many stops it walked of how many there are.

### F. The limit, said plainly (E8)

28. **The guard refuses an interpreter command that names the factory's proof files** (`.a6g/run/state`, the complete
    marker). That closes the direct route. Known limits says the rest: every member runs as the operator's user, so a
    member that sets out to forge a proof can. The real fix (proofs written by a second OS user, or signed with a key
    members can't read) is its own piece of work, listed under Later.

### Not fixing, and why

- **WCAG's spacing and browser-default exceptions for touch targets (P9).** The team's `minTarget` is its rubric's
  (44 px), stricter than WCAG on purpose; a 21 px input on a phone is a finding.
- **Hit areas made with `::after`.** Rare; `ignore` covers it.
- **Owned commands spelled with a variable.** Each command's own role check refuses; nothing gets through.
- **A test lane for testers at the merge queue.** The team's `write` rules already hold them.
- **A schema for `harness.json`.** `a6g harness check` says what's wrong, to the agent that wrote it.

### Tests

Each decision lands with its test. The reviewers' reproductions (the scratchpad's `audit-a`, `audit-b`, `audit-c`)
become fixtures: the queue's markers and a deferred check after a failed, light or paused merge; a crashed suite; the
app down; a rejected finding; the time limit with grandchildren; a gutted journey test; a scaffolder branch with no
task; and one HTML fixture per page-check case, both the honest pages that failed and the broken ones that passed.
Then the same read-only run against a live team's app as last time.

### Order

A, B, C, D, E, F. B before C and D because both read the record. E is the largest and stands alone.

## Part 2: what nothing checks yet (0.8.0)

`harness.md` named six needs. Two are missing from it: **the software does no harm** to the people it's for (their
data, their money), and **the operator can see whether the factory is working**. Nothing in the factory checks the
first beyond a reviewer reading the repository's rules; nothing measures the second.

### G. Security

29. **Access rules in the manifest.** A page takes `refuses`: the sign-in states (and `signed-out`) that must not be
    served it. The page checks load it as each and expect another path or a 401, 403 or 404. Served is a blocker
    finding. Additive, so the scaffolder may add them; removing one is checking less.
30. **Access tests are a gap the factory files.** A manifest with two or more sign-in states and no passing test
    tagged `@access` (one kind of user reading or changing another's records) is a gap for the scaffolder, like a
    journey with no test.
31. **Secrets don't merge.** The merge queue refuses a branch whose added lines hold a key (a private key block, a
    live payment or cloud key, a service token) or that adds a secrets file. No allowance: remove it and rotate it.
32. **Vulnerable packages are a finding.** When a lockfile changed since the last check, the check after merges runs
    the package manager's own audit and files one finding per package at high or critical. It calls the registry the
    install already uses; offline is a log line.
33. **A security reviewer: the one new agent.** Read-only. The merge queue requires its verdict
    (`a6g verdict security`) on a branch that touches the operator's `security.paths` (setup drafts them: sign-in,
    sessions, permissions, payments, webhooks, migrations and policies, API routes) or that the reviewer sent on.
    It asks of each change: who can call this and as whom, what comes back against what they may see, where the
    input is trusted, whether money is worked out on the server, what reaches logs. Once a cycle it sweeps the whole
    access model. The planner's context says which branches need it, so no merge is tried to find out.

### H. Numbers

34. **`a6g metrics --quality`**, from what's already recorded (tasks' histories, review rounds, the check's
    findings, costs): findings after merge per merged task, reviews passed first time, journeys proven, flaky tests,
    and cost per merged task. It's how we learn whether Part 1 worked, and what to build after it.

### Later, and what would promote each

- **A schema change tried before it merges** (apply the branch's migrations to a throwaway copy of the database):
  the first merge whose migration takes the shared app down.
- **Proofs a member can't write** (decision 28): a forged record found in a real run.
- **One test per journey criterion; tests that assert nothing:** a proven journey that turns out broken.
- **Phone Safari** (a WebKit pass at the phone size): a defect that reaches a person on an iPhone.
- **Performance budgets** in the page checks: a page the UX specialist files as slow.
- **Pruning** (dead code, unused and outdated packages): the scaffolder can already add such a tool to the gate; a
  factory sweep waits for the numbers to show the cost.
- **Release readiness, and production errors as tasks:** the first team that deploys from the factory.

## What's yours to decide

Defaults are chosen; say if you'd choose otherwise.

1. **Builders can't edit a journey's test file (decision 11).** A UI change that breaks a journey's test costs a test
   task for the tester or scaffolder. The alternative lets whoever built a flow rewrite its proof.
2. **The security reviewer runs on every branch touching `security.paths` (decision 33).** One more agent run per
   such branch. Decision 34 will say what it costs.
3. **The package audit calls the registry (decision 32).** It sends package names and versions, as an install does.
4. **Two releases or one.** Part 1 alone makes 0.7.0 safe to install; Part 2 can follow.

## Checklist

- [ ] A. Nothing stalls (1 to 5)
- [ ] B. One reading of a run (6 to 10)
- [ ] C. Nobody makes their own proof (11 to 16)
- [ ] D. The check after merges (17 to 21)
- [ ] E. Page checks (22 to 27)
- [ ] F. The guard and Known limits (28)
- [ ] Tests from the audit's reproductions; a read-only run on a live team; README, CHANGELOG, `docs/team.md`
- [ ] G. Security (29 to 33)
- [ ] H. Numbers (34)
