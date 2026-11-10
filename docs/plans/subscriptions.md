# Plan: teams on several Claude subscriptions (0.7.0)

Status: built and tested (see Checklist and Review). Not released: the factory installed in ~/.a6g is still 0.6.1.

## Why

The operator runs two teams whose projects overlap, on two Claude subscriptions, on one Mac or several. 0.6 can read
several subscriptions' usage (`a6g subscriptions add`), but every agent still runs on the Mac's own login (`~/.claude`):
nothing says which subscription a team runs on, a budget is per team only, and what a team spent is read from
`~/.claude/projects` alone, so a team moved to another login would seem to spend nothing.

What's wanted:

1. Each team, and each role in it if need be, runs on the subscriptions the operator chooses, in order of preference.
2. A limit per subscription (keep a share of it for the operator's own use), and one across all of them.
3. A team's budget can cover all its subscriptions together, or one of them.
4. When a team's subscription is at its limit, the team moves to the next one it may use; when none is left, the roles
   on none wait, and pick up again when one opens.
5. The same on several machines.

## What T3 Code already does, and what the factory reuses

- **A Claude instance's own login.** T3 Code's `claudeAgent` provider instances have `config.homePath`, "CLAUDE_CONFIG_DIR
  path ... Keeps .claude.json and .claude separate" (`packages/contracts/src/settings.ts`, since 0.1.4). T3 sets
  `CLAUDE_CONFIG_DIR` for every Claude process of that instance itself (`ClaudeHome.ts makeClaudeEnvironment`), rather
  than `HOME`, so the Keychain login keeps working. The factory sets `homePath` on each role's instance; it doesn't set
  `CLAUDE_CONFIG_DIR` among the instance's variables (`vars` keeps refusing it).
- **Transcripts per login.** T3's usage reader reads `<homePath>/projects` (`claudeUsage.ts`); the factory reads the
  same folders, so its spend and T3's usage view agree.
- **What "exhausted" means.** T3 treats a window as exhausted when its used percent is 100 or more and its reset is
  still ahead (`packages/shared/src/usageLimits.ts exhaustedUsageWindow`), and its fallback model picks the first
  instance that isn't. The factory's choice of subscription follows the same rule, with the operator's limits on top.
- **Not reused, and why.** T3's packages aren't published to npm, so the factory can't import them (`lib/t3.ts`); its
  usage-limit snapshots live in the server's memory and reach only its web client; and its fallback applies only to a
  thread started without a model, while the planner always names a role's instance. The factory keeps reading each
  login's usage with `claude -p /usage`, as 0.6 does.
- **Switching a live thread.** T3 hands a thread's history to a new session only when the thread moves to another
  instance; when an instance's own `homePath` changes, a session that restarts would try to resume a Claude session
  that isn't in the new login's folder (after a T3 restart, or a failed turn it retries). So the factory changes a
  role's subscription only when nothing of it is at work: a member role once its members at work finish (none of it
  starts in between; each does one task), and the planner when it's idle with no member running, by the same rotation
  `a6g rotate` makes.

## Decisions

1. **Which subscription is chosen on each machine, not in `team.json`.** A login is a folder on one Mac, and the
   repository is shared with people whose subscriptions aren't the operator's. `a6g subscriptions use <team>
<name>[,<name>…] [--role <role>]` writes `~/.a6g/subscriptions/use.json`; a role without its own list uses the
   team's; a team without one runs on this Mac's own login, as before. Agents never change it (`a6g subscriptions` is
   an operator command already).
2. **A subscription is known by its login, too.** Each reading records the login's account id and plan
   (`.claude.json`'s `oauthAccount`). A name whose login changed (another `/login`) drops its old estimates and says so;
   two names on one login are refused when added and reported when read.
3. **Limits per subscription, and across all.** `a6g subscriptions limit <name|all> [--weekly <n>%] [--session <n>%]`
   writes `~/.a6g/subscriptions/limits.json`. A subscription is closed when its weekly (or five-hour) use reaches its
   limit, and always at 100% (exhausted, until it resets). `all` closes every subscription once their weekly
   percentages add up to its limit. These readings are the subscription's own, so a limit holds across machines.
4. **A team's budget per subscription.** `a6g budget <team> --account <name> --daily|--weekly|--total` sets limits on
   what the team spends on that subscription (in the budget's unit: dollars, or percent of that subscription's week).
   It's kept with the team's budget in the task graph (`Limits.accounts`), so the web app and every machine see it.
   Reaching one closes that subscription for that team, so the team moves on; it doesn't pause it. The team's own
   budget (all its subscriptions together) pauses it, as in 0.6.
5. **Choosing.** Each run the watchdog chooses each role's subscription: the one it's on while that's open; else the
   first open one in its list; and back to an earlier one only with 5 points of room under its limit (or a new week),
   so a reading near a limit doesn't move the team back and forth. No reading yet counts as open.
6. **Waiting, not pausing.** A role with no open subscription waits on this machine: the guard refuses to start its
   members ("its subscriptions are at their limits"), a worker's watchdog starts none, and a waiting planner gets no
   ticks and no new thread. What's running finishes. The roles still open carry on (a reviewer can review while
   builders wait). It's recorded in the run folder (`subscription.json`), written by the factory only; the operator is
   told once per change, and the planner's ticks say which roles wait and until when. Nothing goes in the task graph's
   controls, so it never tangles with a pause or a budget, and it lifts by itself.
7. **Readings more often near a limit.** Every quarter hour as in 0.6, every five minutes while a subscription in use
   is within 10 points of a limit or closed (to see it open again soon after it resets).
8. **Spend by subscription.** Each request is counted for the login whose transcripts it's in; a usage row records its
   subscription (`account`, missing in rows from before: this Mac's own login). `spend.json` and the web app get each
   subscription's share. One subscription's week in dollars is estimated per subscription (the median of its own
   readings, else of those on the same plan, else of all), and a budget in percent counts what was spent on each
   subscription against that subscription's week.
9. **Several machines.** Names are per machine: give the same login the same name on each. A worker chooses its
   builders' subscription from its own list and limits; the subscription-wide limits read the same usage everywhere.
   Estimates count what the reading machine used, so a subscription used on two machines is under-estimated in
   dollars (its percentages, and so the limits, are exact).

Defaults taken: switching to a subscription that's only five points under its limit isn't refused (the margin applies
only to moving back up the list); the five-hour window is used when the usage report has one (Claude Code 2.1.309 reports
only the weekly ones on this Mac); a subscription removed while a team uses it is refused.

## Files

| File                               | What                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `~/.a6g/subscriptions.json`        | The logins (unchanged): `[{ name, configDir }]`.                                       |
| `~/.a6g/subscriptions/limits.json` | `{ "<name>" or "all": { weekly?, session? } }`, percent.                               |
| `~/.a6g/subscriptions/use.json`    | `{ "<team>": { "*": ["a", "b"], "<role>": ["b"] } }`.                                  |
| `~/.a6g/subscriptions/state.json`  | Readings (now with `account`, `plan`, `session`), estimates, `week` and `weeks`.       |
| `<run>/subscription.json`          | Per role: the subscription it's on, the one it waits to move to, and why a role waits. |

## Checklist

### Phase 1: logins, readings and choosing (`lib/subscriptions.ts`)

- [x] Login identity from `.claude.json`; readings carry it; a changed login drops its estimates; duplicates reported.
- [x] The five-hour window parsed when the report has one.
- [x] Estimates per subscription (`weekFor`), falling back to the plan's, then all.
- [x] `limits.json` and `use.json`, read and written.
- [x] `gate` (open, exhausted, room) and `choose` (per role, with the margin), pure and tested.

### Phase 2: instances and usage

- [x] `lib/t3.ts instance()` sets `config.homePath`; register writes each role's chosen subscription and records it.
- [x] Usage read from every subscription's transcripts, rows tagged with their subscription; `a6g metrics` too.
- [x] Spend per subscription, the blended week for budgets in percent, and `Limits.accounts`.
- [x] Guard: no writes into any subscription's folder; no member started for a waiting role.

### Phase 3: the watchdog and commands

- [x] Each run: choose, rewrite members' instances, move the planner at a safe point, record, tell the operator.
- [x] Waiting roles: no ticks or new planner; workers start no builders; ticks name what waits.
- [x] Readings every five minutes near a limit.
- [x] `a6g subscriptions use|limit`, the show with each subscription's teams, limits and session; `add` refuses a
      login that's listed already; `remove` refuses one in use.
- [x] `a6g budget --account`; the team budget's percent against each subscription's week.
- [x] `a6g status` and `a6g doctor` show and check the subscriptions.

### Phase 4: the web app and documents

- [x] The web app keeps `Limits.accounts` when its budget form saves, and shows spend per subscription.
- [x] README, CHANGELOG, `bin/a6g.ts` help.
- [x] Every test passes; new tests for each part.

## Review (2026-11-09)

An independent review of the diff found these, each fixed and tested (`test/steer.test.ts`):

1. A wait's alert fired again whenever a reading changed its figures ("at 82%", "at 83%"). Waits now carry a key of
   what closed each subscription, without the figures; the alert's key is a hash of the change, not the minute.
2. A team's spend on this Mac's own login was lost when no listed subscription was that login (`remove default` in
   0.6): `loginDirs` always reads `~/.claude`.
3. A planner moved with no thread to retire started in the same run as its instance changed: the watchdog now keys
   that on the planner's instance moving, not on a retired thread.
4. A waiting planner was still sent replies, answers, held notes and controls, which a turn it can't run would lose:
   they're kept (`queueNote`) until it can work.
5. Member roles moved while their members worked, whose sessions T3 would resume under the new login: a member role
   now moves once those at work finish, and none of it starts in between. Found alongside: a worker's builders are
   threads its watchdog started, not members, so they're counted from `worker-threads.json`.
6. Clearing the budget from the web app kept the limits on a subscription, which the form doesn't show: a cleared
   budget clears them.
7. A change to a team's limits on one subscription alone counted as a budget change, so it undid the operator's
   carrying on past a budget pause: only a change to the team's own limits counts.
8. Warning keys for a subscription's limits were the same in dollars and percent: they now say which.
