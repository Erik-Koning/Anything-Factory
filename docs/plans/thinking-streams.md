# Plan: thinking streams, and the operator's taste from Ditto

Status: built and tested on 2026-11-11, uncommitted, in two repositories (this one, and Ditto's `mcp/`). No team has
run a stream: what a live run still has to prove is under "To verify on a live team". Two facts about Ditto bear on
when it's useful ("Ditto as it stands").

## Why

Nobody on a team works out how a thing should feel before it's built.

- The **innovator** researches what to build next and files ideas with a suggested score.
- The **planner** gates and scores them. One of the eight dimensions is `wow` (0 "expected" to 3 "ten times better;
  worth a demo"), so a feature can claim delight, but nothing afterwards earns it.
- The **builder** decides how (Article 3), and its prompt tells it to find the existing code that does something close
  and match it. That is right for code and wrong for ambition: it gives the conventional answer by construction.
- The **UX specialist** judges the result against the rubric. It catches what's wrong, not what was never tried.

And the operator's taste reached a team only as prose they wrote themselves: `direction.md`, the rubric, their notes.
Ditto holds that taste in a form an agent can query (their position on convention against invention, how bold, how
playful, how far to defer to them on a topic), but the factory didn't use it.

A thinking stream fills both gaps. On one piece of decided work it reasons from first principles to what's free to
change, lets the operator's taste choose within that, and hands the builder a concept instead of a blank page.

## Decisions (operator, 2026-11-11)

1. **Ditto is the team's to read, all of it.** Their profile is already given for this use. The grant is theirs to
   scope (`a6g ditto <team> --grant`, with `--all` for the sensitive categories), and the factory restricts nothing
   beyond which roles read it.
2. **A stream runs only where it's warranted, on impactful areas.** The planner judges which, with Ditto to tell where
   the operator's conviction is, and marks the task. The mark shows in the task graph wherever the task does, and the
   task waits for its concept.
3. **The team may write to Ditto, as a leaf.** What it writes is tertiary: marked as coming from a secondary source,
   never taken for the operator's word. This is for testing and validating the feature.

## What a stream is

Nine steps, in the innovator's prompt ("A thinking stream"):

| Step               | What it asks                                                                    | What it uses                                             |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1. Frame           | Who meets this, in what moment, for what job, and what should it leave them?    | The task, direction, decisions, rubric, running app      |
| 2. Taste           | How far from convention would the operator go here, and in what register?       | Ditto (`get_profile`, `get_expertise`, `consult`)        |
| 3. Split           | Which parts can be decided alone?                                               |                                                          |
| 4. Chain, per part | What is it for? What is convention protecting? What's free? Choose.             | The taste brief                                          |
| 5. Check and widen | Is the claim I leaned on true? What else, in nature or culture, has this shape? | Subagents, one question each, on the web                 |
| 6. One idea        | What's the one move? Does it hold in every state? What's the retreat?           |                                                          |
| 7. Values          | What do performance, empathy, courage and integrity each change?                |                                                          |
| 8. First glance    | What does someone who hasn't seen the reasoning make of it?                     | A sketch in scratch, T3 Code's browser, a subagent       |
| 9. Hand over       | A record with a fixed shape, handed in on the task; notes to Ditto              | `.a6g/run/scratch/streams/<task id>/`, `a6g task stream` |

## What changed from the first sketch of the idea

The idea as first described: segment the problem, reason each segment from first principles with the operator's taste,
draw on nature, culture and research, weigh values, test at a glance, hand to builders. These sharpen it.

1. **Two questions a part, kept apart.** "What must be true whatever the taste?" bounds the space. "What would the
   operator do with what's free?" chooses within it. That is how taste is inferred where Ditto has no answer: it will
   never hold "where does the password field go", but it does hold where they sit between convention and invention,
   and the chain carries that to the field.
2. **Convention is evidence, not a default and not an enemy.** Each chain names what the usual form protects. The
   reason is always kept; the form only where the reason needs it. This is the "right mix or right ignoring of
   existing works", made a step.
3. **Claims are checked, because first-principles reasoning sounds true when it isn't.** Each claim a choice rests on
   is graded established, contested or folklore, by a subagent asked for what contradicts it. The original example
   leans on two that need it: a Z-shaped scan is a pattern reported for sparse pages, not a law of screens, and what
   a thumb reaches depends on the hand, the grip and the phone, so "bottom right" suits a right thumb only. A stream
   built on folklore is confidently wrong, and looks no different from one that's right.
4. **One move, and a retreat.** Novelty spent everywhere reads as noise. The stream spends its departure on the one
   move that makes the thing the product's own, keeps the rest familiar so the move reads, and writes the conventional
   version in two lines. Work on the integration branch is undone with a revert, so the retreat makes courage cheap.
5. **Analogy carries a mechanism, not a likeness.** Doors that part to show what's behind them are an idea, and a
   promise the loaded page must keep. A named film's door is someone's property.
6. **Values are questions that must say what they changed.** A value that changed nothing is recorded as such. Courage
   and integrity pull against each other on purpose.
7. **The first glance is someone else's.** The author knows what it's meant to be. A subagent given only the
   screenshots says what it sees, and that is compared with the frame. It's a filter for a screen nobody can read,
   not a verdict on delight: that is the operator's first look.
8. **The output is a record with a fixed shape,** so the planner can argue with it, the builder can build from it, a
   tester can turn "done looks like" into checks, and the UX specialist has an intent to audit against.

## Who does what

The innovator thinks the stream. The planner marks the work, argues with the concept, decides, and hands it on.

- **Why the innovator, in a second mode, and not a new role.** A stream needs what the innovator already has: a
  read-only lane, the scratch folder, web research, T3 Code's browser, the direction and decisions. A pass answers
  "what next"; a stream answers "how should this feel". Same researcher, different brief.
- **Why not the planner itself.** It writes no product (its prompt, "Rules you don't break"), its context is the
  team's memory, and it must stay the one who judges the concept (Article 4).
- **Why the planner hands over, not the innovator.** Only the planner starts and briefs members (Article 2; the guard
  refuses `delegate_task` from anyone else). The back-and-forth uses what's there: the planner may send to a
  member's thread (`t3_thread_send` is in the guard's planner set) and is woken when it finishes.

What each prompt now says:

- **Planner** ("Thinking streams"): mark only what warrants one, and when all three hold: a person sees it and a
  builder builds it; it's where impact gathers (a first impression, a screen most sessions pass through, the step
  where the job gets done; a `wow` of 2 or 3 is a claim a stream can earn); and the operator would want it to stand
  out there, which Ditto's `get_expertise` and `get_profile` tell. Start the innovator once the task is approved.
  Judge the concept as its reviewer and challenge it once. Settle it as a `design` call in the decision log, with the
  retreat as its undo, then put "Must hold" and "Done looks like" into the task. Note what the operator makes of it.
- **Innovator** ("A thinking stream"): the nine steps, the record's shape, the hand-in, and what it inferred of the
  operator's taste as notes. An idea it files says whether it would repay a stream.
- **Builder:** builds to the concept's one move, "Must hold" and "Done looks like"; the sketch is a picture, not code.
- **Tester:** each "Done looks like" line is a criterion to assert.
- **UX specialist:** audits against the concept's frame and "Must hold" as well as the rubric.

## The mark in the task graph

A task carries `stream` (`lib/tasks/model.ts`): `wanted` (the planner's, with why), `concept` (the innovator's: its
name and one move, and the record's path), `settled` (the planner's: `concept` or `retreat`).

| Command                                                | Who       | What it does                                                   |
| ------------------------------------------------------ | --------- | -------------------------------------------------------------- |
| `a6g task stream <id> want --why "…"`                  | planner   | Marks work a builder hasn't begun, on a team with an innovator |
| `a6g task stream <id> concept --move "…" --record <f>` | innovator | Hands in the concept; refused unless the record is there       |
| `a6g task stream <id> build concept\|retreat [--note]` | planner   | Settles which is built; refused until a concept is in          |
| `a6g task stream <id> off --reason "…"`                | planner   | Takes the mark off; refused once settled                       |

- **The hold.** `claimRefusal` refuses a task whose stream isn't settled, so `nextClaim` passes it by and the pace
  (`lib/pace.ts`, which simulates claims) leaves it out of what it starts.
- **The label** (`streamLabel`): `stream: wanted`, `stream: concept in`, then `stream: concept` or `stream: retreat`.
  It's in `a6g task list` (after `≈`) and `show`, both graph layouts, `a6g serve`'s chips, and the web app's board
  cards and task page (amber while it's held).
- **The planner's context** (`summary`, every wake): the concepts in, to judge; the streams wanted on approved work,
  with "start the innovator" or "an innovator is at work"; and those wanted once approved.
- **Rules are code:** nobody settles their own concept (the innovator hands in, the planner settles), the record must
  exist, and each move is in the task's history.

## Ditto in the factory

`team.json`:

```json
"ditto": { "roles": ["planner", "innovator"], "notes": true }
```

- **The lane** (`lib/config.ts`). Each role named gets Ditto's read tools in its `mcp` (`whoami`, `get_profile`,
  `consult`, `get_expertise`, and `status`, which is all an unknown client gets), and `record_note` with `notes`. One
  list, so the guard passes exactly what the role's compiled rules list (`lib/prompts.ts`). A role in a worktree of
  its own can't be named: the grant is bound to the team's checkout.
- **The launch** (`lib/commands/team.ts`). Those roles start with `--mcp-config <run>/mcp/ditto.json`, beside
  `--strict-mcp-config` under strict isolation. The file names the factory's launcher and the team, and no secret.
- **The launcher** (`plugin/mcp/ditto.ts`, `lib/ditto.ts`). It reads the team's token from the Keychain and starts the
  operator's Ditto server with it, in the member's own folder. The token is in no file, no launch argument and no
  member's environment. With no token the server still starts and offers only `status`, which says why.
- **`a6g ditto <team>`** (`lib/commands/ditto.ts`), the operator's alone. `--grant` runs Ditto's own `grant` for
  `a6g-<team>`, bound to the team's checkout, read-only or notes-only as the team's rules say, reads the token from
  what Ditto prints without showing it, stores it, and checks it from the checkout. `--all` names every category.
  `--off` revokes and forgets. Alone, it shows what's connected.
- **Subagents reach none of it.** A subagent's role is `subagent:<type>` (`lib/session.ts`), which has no lane, so
  the guard refuses it every outside tool. The profile is read in one place, and a subagent gets the taste brief in
  the innovator's words.

## Notes from secondary sources, in Ditto

Ditto's `record_feedback` would not have done: its entries are shown as corrections, which outrank survey answers
(`schema/precedence.md`, level 5), and they raise conviction and skill in the expertise map. So Ditto has a third
tier, built in its `mcp/`:

- a grant made `--notes-only` has one write, `record_note` (`text`, `basis`: `inferred` or `relayed`, `from`,
  `category`);
- notes go to their own file (`~/.ditto/profile/notes.jsonl`), and nothing is made from one: no conviction, no skill,
  no pattern, no proposed rule;
- `get_profile` and `consult` show them last, under "Notes from secondary sources (not the user's words)", each with
  its basis and the grant that wrote it. `schema/precedence.md` ranks them after survey answers and before category
  defaults: one can break a tie, and never outweighs an answer, a correction or a rule.

Who writes what, from the factory: the innovator, after a stream, what it had to work out that Ditto didn't hold
(`inferred`, three at most); the planner, what the operator made of a concept it settled (`relayed`).

The loop this guards against: an agent infers a taste, writes it, reads it back as evidence, and grows surer of its
own guess. A note is always labelled, so the second reading is of a note, not of the operator.

## Ditto as it stands

Found while building, and both matter for when this is useful:

1. **This machine has no Ditto profile.** There is no `~/.ditto`: no answers, no grants. A team connected today reads
   an empty profile, and a stream falls back to the direction and says so. Ditto's own plan lists the first step as
   still open (its `TODO.md`, Phase 8: answer the facts card and the starter set with the local server, about twenty
   minutes).
2. **Ditto's plan retires the server this wiring uses.** As of 2026-11-10 Ditto is to be hosted only
   (`audits/2026-11-10-plan.md`, Phase 13): a remote MCP at `/mcp`, connections in place of grants, and then "the
   stdio server, the file store and the local evaluation page are removed". The newer plan
   (`audits/2026-11-11-plan.md`) names other tools: `get_context`, `open_node`, `search_context`, `record_edit`,
   `record_outcome`. Neither is built.

What moves when that ships: the tool names and the launcher (`lib/ditto.ts`, `plugin/mcp/ditto.ts`), `a6g ditto`'s
grant (a connection token instead), and the tool names in the two role prompts. The team's setting, the lanes, the
guard, the mark and the stream itself stay. The notes tier maps onto that plan's vocabulary: a node there carries
`confidence: answered | observed in their work | inferred`, and a note is the third, from a source that is an agent.

## Checklist

- [x] innovator prompt: the stream, the record's shape, the hand-in, notes, the report after a stream
- [x] planner prompt: what warrants a stream, starting it, judging and settling it, what the operator makes of it
- [x] builder, tester and UX specialist prompts: a task built from a concept
- [x] the task graph: the mark, its commands, the hold on claims, the label on every view, the planner's context line
- [x] Ditto: the `ditto` setting, lanes, the launch, the launcher, the compiled rules, `a6g ditto`
- [x] Ditto's repository: `--notes-only` grants, `record_note`, notes read back as from a secondary source
- [x] tests: `test/streams.test.ts` (17), Ditto's `mcp/test/server.test.js` (one added), and an end-to-end run of
      `a6g ditto --grant`, the launcher and Ditto's real server with a throwaway profile
- [x] `docs/team.md`, the schema, README, CHANGELOG
- [ ] `a6g check` proving a team's grant when its rules name Ditto (`a6g register` says when it isn't connected)
- [ ] a pilot on one team, and what it cost

## To verify on a live team

None of these can be proved without T3 Code running a member:

- That Claude Code under T3 Code loads `--mcp-config` from a member's launch arguments beside T3 Code's own tools,
  with and without `--strict-mcp-config`. The file, the launcher and Ditto's server are proved; that last join isn't.
- That a member can start Claude Code's own subagents. The guard expects them (`lib/session.ts` `roleFor`), and its
  hooks don't match the tool that starts them, but no test starts one.
- How a static sketch opens in T3 Code's browser: by its file address, a rendered preview, or a server on a port.
- That T3 Code starts the planner and the innovator in the team's checkout, which the grant is bound to.
- What a stream costs, against a pass, and whether "one or two in ten" is the right amount of marking.

## Out of scope

- Teams whose board is GitHub issues: no task graph to mark, and no decision log to settle a concept in.
- Worker machines: the operator's profile is on their own machine, so streams run on the lead.
- Streams on work that isn't a screen. The steps are written to allow it (step 3); none has been tried.
- Changing the constitution. Article 4 names who judges the result; a stream adds a concept before the build without
  changing who decides.
