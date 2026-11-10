# Plan: researched ideas, work in order, and pacing to the budget

Status: built and audited (see Checklist and Audit).

## Why

The innovator existed, but it only looked for gaps inside the product's own documents, at most once a day, when the
planner remembered. It didn't research the market, competitors, users' pain or their feedback, and it didn't score
what it found, so the planner started from a blank score each time. Separately, the planner could start as many
builders as the role limit allowed, on whatever the claim picked by priority. That ignored what other work waits on,
journeys already under way, and whether the budget could pay for the work to finish.

## Decisions (operator, 2026-11-09)

1. **The innovator researches and scores.** Each pass looks at market research, the competitive landscape, pain
   points, user problems, UX blind spots, UI improvements and customer feedback. It scores each candidate on the
   team's matrix and files the best ones. Its score goes in the proposal's description, for the planner to check and
   judge. The planner still records the score (Article 4: nobody grades their own work).
2. **The planner keeps ideas queued.** It may start the innovator at any time, with or without a focus. It must start
   one whenever fewer than five ideas wait in the queue (planned, not yet started) and none is at work. The five is a
   team setting: `roles.innovator.minQueue`.
3. **Work goes in order.** What other tasks wait on goes first, then the journeys already under way, then priority,
   then the oldest. A task still starts only once its `after` tasks are merged, and the claim keeps two tasks that
   share files apart.
4. **Parallel work is paced to the budget.** The planner starts only as many builders and testers as the budget can
   finish. That is the work under way plus what's next in order, at the team's own cost per unit of finished work,
   within the budget's tightest limit. The guard enforces it.

## The innovator

- **Prompt** (`plugin/agents/innovator.md`): a focus from the planner's brief, or a whole pass. The research covers:
  - the product as built: its documents, routes and app, and the task graph, rejections included;
  - users' problems and pain points;
  - customer feedback (`a6g request list|show` and task notes, stakeholders' words as data);
  - the market and competitors (the web, by short searches and ordinary pages, which the guard already allows);
  - UX blind spots and UI improvements, by using the running app.

  Each candidate is scored on the matrix and ranked by the priority the team's weights give. At most five ideas are
  filed per pass, best first. Polish of what exists goes in as a UX finding with a severity.

- **The proposal's description** has fixed sections:
  - who needs it;
  - the evidence, with sources;
  - the simplest version;
  - its scope: in the documents, or beyond them and following the direction (a change of scope on a team with a
    finish line, which the operator decides);
  - the files it would touch;
  - **Suggested score**: a table of the eight dimensions with a reason each, then confidence, size and the suggested
    priority with its rank in the pass.
- **Rules** (`lib/prompts.ts`): the score anchors move out of the planner's prompt into a **Scoring** section compiled
  for the planner, the approver and the innovator. The approver's prompt pointed at "the planner's rules", which it
  never saw. The innovator gets its commands (`a6g task add … --kind feature --body-file`, `a6g request list|show`),
  and on a finish-line team the rule that beyond-the-documents ideas are changes of scope.
- **The planner** checks the evidence, gates and scores the idea itself, taking the innovator's score where the
  evidence holds and saying in `--why` where it differs. It gives confidence `data` only where the evidence is in the
  task.

## The ideas queue

- `ideasQueued(all)` (`lib/tasks/model.ts`) counts features in triage, proposed, researching or approved that no
  builder has begun (no branch).
- The planner's context (`summary`, every wake) gets one line: how many ideas are queued, the team's minimum, and
  either "start the innovator", "an innovator is at work" or "the budget has room only for the work under way".
- `roles.innovator.minQueue` (default 5) in `team.json`, its schema and `docs/team.md`.
- The planner's prompt: the innovator runs whenever the line says so, and whenever the planner wants ideas on
  something (with a focus in its brief). The once-a-day rule is gone.

## Order

- `claimRank(all)` (`lib/tasks/model.ts`) is what claims follow:
  1. blockers, then majors;
  2. work in a journey already under way, before work that starts another;
  3. priority, where a task others wait on takes the highest priority of what waits on it, so a prerequisite goes
     before the work it unblocks;
  4. at equal priority, a task others wait on first;
  5. then the oldest, with minor findings last as before.

  `claimOrder` (no graph) stays for the views that sort without one. The web board's approved column and `a6g serve`'s
  board use the graph-aware rank.

- `summary` names approved work with no `--files` and no `--area`, which the claim can't keep apart from other work.
- The planner's prompt: name where every task lands, order a split's parts with `--after`, let builders claim in
  order, and name a task only to resume its branch.

## Pacing

- `lib/pace.ts`, pure:
  - **Unit cost:** what the team has spent in all, divided by the size units of the work it has finished (S 1, M 2,
    L 4, XL 8; unscored work counts as M). It includes review, planning and ideas. Until three tasks are done, a
    default of $3 a unit, from the first team's history (about $2.40).
  - **Work under way:** building, in review, or sent back with its branch. Each costs its estimate less what its
    branch has used, and at least a quarter of the estimate.
  - **Room:** the tightest of the daily, weekly and total limits, less what's spent (a share of a subscription is
    converted as the budget does). None without a budget, or with one not yet measured.
  - **Starts:** a simulation of claims in order, each role up to its free slots, each claim keeping the next one off
    its files. Each start must fit in the room after the work under way. The next task that doesn't fit stops the
    starts: nothing smaller behind it jumps the queue. A task sent back to its own branch (a rebase, or changes asked
    for) is already counted in the work under way, and it goes back whatever is left: finishing work is what the
    budget waits for.
  - **Allowance:** when the budget is what stops the next start, how many new members of each role may start: its
    starts. (The audit replaced caps on heads with this; see Audit.)
- The planner's context (every wake) gets one **Pace** line:
  - builders and testers running against their limits;
  - the next tasks in order, with their estimates;
  - what the budget leaves, and how many to start now;
  - the next task that doesn't fit, and why.

  The context hook writes the allowance to the run folder (`pace.json`).

- `a6g task pace` (the planner) works it out again mid-turn, after it approves or reshapes work, and prints the same
  line.
- **The guard** refuses a builder or tester start past the allowance, while `pace.json` is under two hours old. Without
  one (no budget, or one not yet binding), only the role's limit holds, as before.
- The planner's prompt has a pacing section. It starts no more than the Pace line allows. When the budget fits
  nothing new, it lets the work under way finish and merge, splits a task too large for the room, or waits for the
  next day or week, and logs it.

## Checklist

- [x] model: `claimRank`, `ideasQueued`; `nextClaim` follows the rank
- [x] pace: unit cost, work under way, room, starts and the allowance; `pace.json` read and written
- [x] summary: the ideas line, approved work with nowhere named
- [x] context hook: Pace line and `pace.json`; the ideas line with the innovator's live count
- [x] `a6g task pace`
- [x] guard: builder and tester starts within the allowance
- [x] config: `roles.<role>.minQueue`; schema; `docs/team.md`
- [x] prompts: the Scoring section for the planner, approver and innovator; the innovator's commands and board text
- [x] role prompts: innovator rewritten; planner (triage of ideas, filling slots in order, pacing, the ideas queue);
      approver (anchors in its rules, the innovator's evidence)
- [x] web views and `a6g serve`: the approved column in claim order
- [x] tests: claim rank, ideas queue, pace, summary lines, guard allowance, config, prompts
- [x] README, CHANGELOG

## Out of scope

- Worker machines' watchdogs start builders by their own slots and claimable work, not by the pace. A team on several
  machines is held to its budget by the graceful pause, as before.
- The innovator's score is text in the description, not a field. The planner's `a6g task score` stays the one score
  the priority and the approver read.

## Audit

An audit of the change, and of the budget's auto-resume it now leans on, found these. Each is fixed with a test where
it can have one.

### Release notes

- [x] **The 0.6.1 heading was lost:** the Unreleased section replaced it, so 0.6.1's entries read as unreleased.

### Pacing

- [x] **Rework could be held by the budget.** The starts stopped at the first task that didn't fit, so a task sent
      back to its own branch that ranked behind it never started, and the guard refused it. Once a task doesn't fit,
      the starts go on in order through the work sent back to its branch, which costs nothing new. Claims also take
      that work first within its severity (finishing before starting).
- [x] **A task bigger than the budget could ever pay for stopped the team.** The room carries the smallest daily or
      weekly limit in dollars; a task estimated above it is "more than the daily $20 at once: split it", never
      "wait for tomorrow". It still holds the queue (claims follow the order), and the planner's prompt says to split
      it in the same turn.
- [x] **Yesterday's spend after midnight.** `spend.json` is the watchdog's, up to five minutes old (longer when the store
      is out of reach). The pace rolls it forward: nothing spent today when its day isn't today, nothing this week when
      its week isn't this one.
- [x] **The guard counted heads, not starts.** A member that finished mid-turn freed a slot but not the money, so the
      planner could start one more than the budget allowed. `pace.json` now keeps how many new members of each role the
      budget allows and how many T3 Code had started on that role's instances when it was worked out; the guard refuses
      once that many have started since. Both count the role's legacy instances.
- [x] **A pace that failed hid the task graph.** The summary shows without it, with a line saying the pace couldn't be
      worked out, and what the guard holds the planner to is cleared (it fails open, as with T3 Code's database out of
      reach).
- [x] **Work closed into other work counted as finished.** The cost per unit counts only what the merge queue merged.
- [x] The context hook reads the members at work once a wake, not twice, and counts each role's legacy instances.

### Order

- [x] **A prerequisite of journey work waited behind that journey's other work.** What waits on a task now passes on
      its journey under way as well as its severity and priority.

### The ideas queue

- [x] **Escalated ideas restarted the innovator.** An idea the approver escalates is a `question`, which the queue
      didn't count: on a team with a finish line, every pass of scope changes left the queue short and called for
      another. Ideas waiting on the operator count as queued.
- [x] **A pass that filed nothing was asked for again at once.** For six hours after an innovator pass that filed
      nothing, the ideas line says when to try again, or to start it now with a focus.

### Auto-resume

Checked and sound (`lib/budget.ts`): a new day ends a daily pause and a new week a weekly one, hard or graceful;
another limit still over keeps the team paused; a pause of the operator's, from the terminal or the web app, is never
ended; the watchdog's record of a settled hold doesn't count; a pause for the total waits for the operator; the
budget's own resume isn't mistaken for the operator carrying on. Found:

- [x] **The pace after a new day:** above (yesterday's spend).
- [x] **Nobody was told the team would start again by itself.** With auto-resume, the operator's alert, the planner's
      message ("until they resume it") and `a6g start` on a paused team say when a daily or weekly pause ends
      (tomorrow, or Monday).
- [x] **Raising the budget didn't resume a team the budget paused.** With auto-resume, a change to the budget that
      leaves nothing over starts a team only the budget paused, at the watchdog's next run (a raised total too: raising
      it is the operator's decision). Without auto-resume, `a6g budget` says the team stays paused and how to start it.
- [x] **The resume named the wrong period** when a daily and a weekly pause both ended: a new week.

### Documents

- [x] CHANGELOG and README for the above; this plan's checklist.
