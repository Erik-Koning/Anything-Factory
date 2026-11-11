# Plan: the decision log and the working agreement

Status: phases 1 to 3 built, tested and reviewed (see Checklist and Review), and merged into `main` on 2026-11-10 at
the operator's word; phase 4 is planned, not started. No factory release has been made.

## Why

The planner already stands in for the operator's judgment: it looks a question up, works out what they'd choose,
weighs what a wrong call costs, and asks only what's left (`plugin/agents/planner.md`, "Deciding for the operator").
Two things are missing.

- **No trail of what it didn't ask.** A question the planner answers itself becomes one line in `.a6g/decisions.md`: a
  file in the repository, rewritten as it's tidied, with no date, no record of what else was weighed, and nothing that
  says why the operator wasn't asked. It isn't on the web app, so the operator sees those calls only in the Done
  report, after the work is built on them.
- **No way to change how readily it asks.** How often the team checks in is fixed by the prompt and by `team.json`
  (`contact`, `operator`, `approval`). An operator who finds the questions too many, too few or about the wrong
  things edits files, commits, registers and rotates the planner. Nothing can be said on the fly.

The operator asked for both (2026-11-10): a log of the questions an agent would have asked and answered itself
"because of settings, config or confidence", as an audit trail for the critical ones, stored on the web app; and a
way to set the planner's context as it runs, so check-ins and behaviour are adjusted when they turn out wrong.

## What it is

Two records, and one rule that joins them.

```
 a product question the direction doesn't settle
        │  the planner judges three things: topic · what a wrong call costs · how sure it is
        ▼
 THE WORKING AGREEMENT (the operator's; changed at any time from the CLI or the web app)
   level: hands-on | balanced | hands-off   +  per topic: always ask | never ask   +  standing instructions
        │  route(agreement, topic, stakes, confidence): one pure function, used by both commands below
        ├─ ask ──────────▶ a6g task status <id> question …     → Waiting on you (says why it was asked)
        ├─ decide & tell ─▶ a6g decision record …  (flagged)    → Decided for you, to review
        └─ decide ───────▶ a6g decision record …               → Decided for you, on the record
                                   │
        the operator reviews: agree, or overturn with what to do instead ──▶ the planner, within a minute
        "I should have been asked" / "stop asking me this" ──▶ a change to the agreement ──▶ the next question
```

- **The decision log** is every question the team answered in the operator's place: the question, what was weighed,
  what was chosen, the direction it follows, how it's undone, the tasks it concerns, and **why it wasn't asked** (the
  route the agreement gave, the rule that gave it, and which version of the agreement was in force). It's append-only
  and lives in the team's store beside the task graph, so the web app shows it.
- **The working agreement** is the contract between the operator and the team about check-ins: how readily the team
  asks, which topics are always or never asked, and the operator's standing instructions in their own words. Every
  change is a new version in the store, with who made it and when; the newest is in force. It reaches the planner
  within a minute and is in its context at every wake.

## Decisions taken in this plan

1. **The agreement is a control, not a file.** `team.json` and `direction.md` are in the repository and reach an agent
   only at its next session. Pauses, resumes and budgets are already an append-only log in the team's store that the
   web app adds to and the watchdog applies within a minute (`lib/tasks/controls.ts`). The agreement is a fourth kind
   of control, and a review of a decision a fifth. That gives the history, who and when, the authenticator code on the
   web, and the delivery to the planner, with no new machinery and **no new permission for the web app's database
   user** (it already inserts into `controls` and reads the whole database).
2. **Rules are code (Principle 5).** The planner's judgment is the three inputs. What happens to them is one table in
   `lib/tasks/agreement.ts`. `a6g task status <id> question` refuses a question the agreement leaves to the team, and
   `a6g decision record` refuses one it makes the operator's, each naming the other command. The prompt can't drift
   from the table: the compiled rules render the topics and grades from the same constants.
3. **One write path.** `a6g decision record` writes the log entry and appends the line to `.a6g/decisions.md`, which
   stays what it is: the team's working memory of rulings, compiled into every prompt. The log is the audit trail.
4. **Some questions are never the team's.** Privacy and personal data, and the team's own rules (unlocking a policy,
   promoting to production, checking less) are asked whatever the agreement says (Article 3). An operator who isn't
   technical is never asked about the platform or the stack (`operator.technical`): those are decided and logged.
5. **The default is today's behaviour**, so a team that sets nothing asks exactly what it asked before: `balanced`,
   with a change of scope always asked (Article 3 makes it the operator's) until they give it to the level or to
   the team. The one difference: a high-stakes call the team makes itself is now flagged for review instead of
   waiting for the Done report.
6. **Calibrate where it hurts.** A question in Waiting on you says why it was asked; a decision says why it wasn't.
   Each links to the agreement, so the fix is one step from the thing that prompted it.

## The working agreement

`lib/tasks/agreement.ts`, pure (the web app imports it):

- **Level**, one of three. Each is a table from what a wrong call costs (rows) and how sure the team is (columns):

  | `balanced` (default) | sure   | derived | unsure |     | `hands-on` | sure   | derived | unsure |     | `hands-off` | sure   | derived | unsure |
  | -------------------- | ------ | ------- | ------ | --- | ---------- | ------ | ------- | ------ | --- | ----------- | ------ | ------- | ------ |
  | low stakes           | decide | decide  | decide |     | low        | decide | decide  | tell   |     | low         | decide | decide  | decide |
  | medium               | decide | decide  | tell   |     | medium     | decide | tell    | ask    |     | medium      | decide | decide  | decide |
  | high                 | tell   | tell    | ask    |     | high       | tell   | ask     | ask    |     | high        | decide | tell    | tell   |
  - **Stakes:** `low` a revert undoes it and nobody outside the team sees it; `medium` merged work is redone, or
    people would notice the change; `high` it reaches users, real data or money before the operator could see it,
    changes the scope a lot, or is costly to undo.
  - **Confidence:** `high` the direction, a recorded decision or the brief says so; `medium` it follows from what the
    operator has said; `low` two or more options still fit.

- **Topics**, each of which the operator may set to _always ask_ or _never ask_ (never: decided, and still flagged
  when the table would have asked): `product` (what a person sees or can do), `scope` (what's in or out; always
  asked by default), `design` (how it looks and reads), `technical` (platform, stack, data model, dependencies),
  `cost` (to run, or to build), `security` (who can see or do what). Two are always asked and can't be set:
  `privacy`, and `rules` (unlocking a policy, promoting, checking less, a brief that contradicts itself).
- **Standing instructions**, up to 2,000 characters of the operator's own words ("I'm away until Monday: batch
  everything", "never add a dependency without asking"). The planner follows them as it follows the direction. They
  don't change a lane, a policy or the constitution; the guard still holds those.
- `route(agreement, { topic, stakes, confidence }, operator)` gives `ask`, `tell` or `decide` and the rule in words.
  `agreementOf(controls)` is the one in force (the newest `agreement` control, else the default).

Set from the terminal with `a6g agreement <team> [--level …] [--ask scope,cost] [--never design] [--follow technical]
[--notes "…" | --notes-file f | --clear-notes] [--reset]` (the operator's alone; with nothing, it shows the agreement
and its history), or on the web app's **Agreement** tab with an authenticator code, like a pause.

## The decision log

`lib/tasks/decisions.ts`, pure. A `decisions` collection in both stores (`d1`, `d2`, …), copied by `a6g task migrate`.

- A record: `question`, `options`, `decision`, `because`, `topic`, `stakes`, `confidence`, `route` (`tell` or
  `decide`), `rule`, `agreement` (the control in force, or none for the default), `undo`, `tasks`, `by`, `at`,
  `review`, `notes`, `history`.
- `a6g decision record "<question>" --decided "…" --because "…" --topic t --stakes s --confidence c [--options "a | b"]
[--task 12,14] [--undo "…"]` (the planner). Refused, naming the question command, when the agreement makes it the
  operator's.
- `a6g decision route --topic t --stakes s --confidence c` says what the agreement does with such a question, and
  `a6g decision agreement` shows the agreement whole (anyone on the team).
- `a6g decision list [--flagged] [--to-review] [--json]`, `show <id>`, and `note <id> "…"` (the planner: what was
  done about an overturned one).
- `a6g decision review <id> agree|overturn [--note "…"]` (the operator; an overturn says what to do instead). A
  review is a control, so the web app adds it with the permission it has. The watchdog writes it onto the record and
  passes an overturn to the planner within a minute; it may be changed from agreed to overturned, never back.
- A question that is asked carries the same classification on the task (`ask.topic`, `stakes`, `confidence`, `rule`,
  `agreement`), so every question and every decision can be counted by topic and by which agreement was in force.

## The harness

- **`a6g task status <id> question`** by the planner takes `--topic`, `--stakes` and `--confidence` beside `--reason`
  and `--recommend`, and is refused when the route isn't `ask`. Not routed: the design check-in (its own gate), the
  approver's escalations (the approval rules), a block raised for what only the operator knows or holds (a key, an
  account, a fact about their business: hands and facts, not judgment, so even `hands-off` never makes the team
  guess one), and the operator raising a question to themselves.
- **The planner's context, every wake** (`plugin/hooks/context.ts`): the agreement in a few lines (its version, who
  set it and when, the level, the topics, the standing instructions), and any overturned decision it hasn't noted.
- **The watchdog** (`lib/holds.ts`, `lib/commands/watchdog.ts`): a new agreement is told to the planner once, in full,
  and wakes it, with what to re-check; an overturn is told once and wakes it; an agreed review changes nothing.
- **The guard:** `a6g decision record|note` are the planner's; `a6g decision review` and `a6g agreement` the
  operator's.
- **The compiled rules** (`lib/prompts.ts`, planner): a section that renders the topics, the grades and how the
  operator fits (`operator.technical`) from the constants. **The planner's prompt:** "Deciding for the operator" ends
  in the route rather than in "ask"; its message to the operator lists what was decided and flagged since the last.
- **The constitution:** Article 3 names the agreement among what the operator directs, and says what it may leave
  to the team (changes of scope, and product questions costly to get wrong) and that nothing else of theirs moves;
  Article 10 says it sets how readily the planner asks; Article 11 lists the decision log among the records.
- **A team on a GitHub board** has no store, so neither an agreement nor a log: its planner's compiled rules say to
  apply the default by hand and to write decisions in `.a6g/decisions.md` itself.

## The web app

- **Decided for you** (`/t/<team>/decided`; members read, admins review): what's to review first (flagged, not yet
  reviewed), then everything, then what was overturned. Each record shows the question, the choice, why, what was
  weighed, how it's undone, its tasks, and why it wasn't asked. **Agree** or **Overturn** (with what to do instead)
  for admins; a review the team's Mac hasn't applied yet says so. The tab carries the count to review.
- **Agreement** (`/t/<team>/agreement`; admins): the level with its table, the topics, the standing instructions, and
  a code from the authenticator to save. Below: how it has gone in the last 30 days (asked, decided, flagged,
  overturned) and every earlier version with who changed what.
- **Waiting on you** says under each question why it was asked, with a link to the agreement.
- **The audit log** gains `team.agreement` and `decision.reviewed`.
- A team whose factory version doesn't read the agreement says so on both pages instead of offering forms that would
  do nothing (`a6g register` publishes `operator` with its settings; its absence is the sign).

## Phases

1. **The model** (pure, tested): `agreement.ts`, `decisions.ts`, the two control kinds, the `decisions` collection in
   both stores and in `migrate`.
2. **The harness:** `a6g decision`, `a6g agreement`, routing in `a6g task status … question`, the hook's context, the
   watchdog's delivery, the guard's ownership, the compiled rules, the planner's prompt, the constitution, the tests.
3. **The web app:** the two pages, the tab counts, why a question was asked, the audit actions, unit and browser
   tests.
4. **Closing the loop** (not started):
   - calibration hints from the record ("you took the team's recommendation on 6 of 6 design questions: let it
     decide those?", "2 of 5 scope decisions overturned: ask about scope?");
   - how often a message may go (`contact`) as part of the agreement, read by the guard and the watchdog;
   - flagged decisions in the web app's email digest, and the decision log on `a6g serve`'s local page;
   - asked, decided and overturned in `a6g metrics --quality`;
   - the approver's escalations classified the same way.

## What's yours to decide

The operator had this list on 2026-11-10 and said to carry on to the merge and the deploy without changing any of
it, so each stands as built until they say otherwise.

1. **The names.** Tabs **Decided for you** and **Agreement**; commands `a6g decision` and `a6g agreement`. The
   existing **Decisions** tab (proposals to approve) keeps its name.
2. **The constitution's amendments** (Articles 3, 10 and 11, and Part III). They follow from the feature, but
   changing the constitution is yours (Part V).
3. **`balanced` flags high-stakes calls** the team makes itself. Before, they waited for the Done report.
4. **Who reads the log on the web app.** Members read it, as they read the board (their tab says **Decision log**),
   with your review notes; only admins review, and only admins see or change the agreement. A review takes no
   authenticator code, as an answer doesn't; a change to the agreement does.
5. **The release.** A version bump, a tag, `a6g self-install`, `a6g upgrade <team>` and a deploy of the web app are
   yours each time. A team on an installed version from before this keeps working as it did: its planner neither
   reads the agreement nor writes the log until it's upgraded and rotated.

## Checklist

- [x] 1. `agreement.ts`: levels, topics, tables, `route`, `agreementOf`, validation (`test/agreement.test.ts`)
- [x] 1. `decisions.ts`: the record, `recordDecision`, reviews as controls, `applyReview`, stats
      (`test/decisions.test.ts`)
- [x] 1. stores: `decisions` in files and Mongo; `migrate` copies it
- [x] 2. `a6g decision record|route|agreement|list|show|note|review` (`test/decision-commands.test.ts`)
- [x] 2. `a6g agreement <team>`
- [x] 2. `a6g task status … question` routed; `a6g task ask` re-judges
- [x] 2. hook context; watchdog applies and tells (held while paused); guard
- [x] 2. compiled rules, planner prompt, setup agent, constitution, README, `docs/team.md`, changelog
- [x] 3. web: Decided for you, Agreement, tabs with the count to review, why a question was asked, audit actions
- [x] 3. web: unit tests (`web/tests/unit/decided.test.ts`) and four browser tests
- [ ] 4. closing the loop

## Review

An independent review of phases 1 and 2 found no high-severity bug. What it found, and what was done:

- **A change of scope could be decided by the team under `balanced`,** against Article 3. The default now asks about
  scope, the operator may give it away, and Article 3 says so.
- **A question raised without a judgment** (imported from an old board, or from before the agreement) could be raised
  again unrouted with `a6g task ask`. The planner's own unjudged question is now judged there; the approver's and
  the operator's are not.
- **A dead end:** a journey with finished work can only be rejected by the operator, and the refusal named a command
  the agreement might refuse. It now names the `rules` topic, which every agreement asks.
- **Messages kept through a pause** could arrive after newer ones. Kept messages now go first, in order, at the first
  pass once the team isn't paused.
- **The message about a new agreement** ignored `operator.technical`. The registry keeps it now, and `a6g agreement`
  refuses `--ask technical` on such a team.
- **`a6g agreement` built on a stale read.** It builds on the agreement in force as the control is recorded.
- **A team on a GitHub board** was told to use commands it doesn't have. Its rules now say what to do by hand.
- **A note written between the operator's click and the watchdog's pass** hid an overturn from the planner's context.
  A review records when it reached the record, and notes count from then.

Known limits, left as they are:

- **The agreement is enforced one way.** Nothing it makes the operator's can be recorded as decided. A planner that
  wants to ask more than the agreement allows can still find a way (a `design` task raised as a check-in, a block
  with a recommendation, a ticket imported from an old board as a question), and each shows in Waiting on you.
- **A decision that is never recorded isn't seen.** Recording is the planner's rule, not a check: a decision is made
  in a turn, not by a command. The Done report and the cycle report are drawn from the log, so what's missing there
  is missing where the operator looks.
- **How a question is judged is the planner's word.** The record shows the stakes and the confidence it gave, so a
  call the operator overturns shows what was judged too low.
