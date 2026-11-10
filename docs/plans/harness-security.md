# Plan: what nothing checks yet (Part 2)

Status: planned, then built on the branch `scaffolder-harness` (the checklist at the end says how far). Not released.
Follows `harness-hardening.md`, whose Part 1 made the existing checks true. This is its Part 2 in full: decisions 29
to 34 as outlined there, and one more (35) that the operator asked for.

## What it's for

`harness.md` named six needs. Two were missing from it:

- **The software does no harm to the people it's for:** their data reaches only them, their money moves only as they
  meant, and the keys to both stay out of the repository and out of the conversation. Today nothing in the factory
  checks any of it beyond a reviewer reading the repository's rules.
- **The operator can see whether the factory is working.** `a6g metrics` says what a team spent. Nothing says what
  it got for it.

## The same four tests decide what's in

From Part 1: a check that lies is worse than none; no team stalls on upgrade; a stated guarantee holds against a
member who isn't trying hard, and fails closed; measure, don't match. Two consequences here:

- **Every refusal names its way through.** A security rule with no way through is a stall, and a way through that
  the refused member can take alone is no rule. So each one says who does what next.
- **Nothing here turns on for a team that didn't ask.** A team with no sign-in states, no `refuses`, no security
  reviewer and no lockfile sees one change on upgrade: a branch that would put a live key or a secrets file into the
  repository's history doesn't merge.

## What was read before planning

The code, as it stands at Part 1's last commit, and each tool's own documentation (read 2026-11-10) or help text.

- **An agent can't store a secret at all today, and can print some.** `sst` in any form is refused by the deploy
  policy, `gh secret` by github, `gcloud` by cloud. `doppler`, `vault` and `op` are named by no rule: an agent can
  run `doppler secrets get NAME --plain` and the value lands in the conversation.
- **How each manager takes a value.** `sst secret set <name> [value]` reads the value from stdin when it's left out
  (`sst secret set Key < file`); it applies under `sst dev` or at the next deploy. `vercel env add <name>
--environment <env>` reads stdin, also takes `--value`, and applies to new deployments only. `gh secret set <name>`
  reads stdin unless `--body` is given. `doppler secrets set NAME` reads stdin, and prints the value back unless
  `--silent`. `gcloud secrets versions add NAME --data-file=-` reads stdin. `wrangler secret put KEY` reads stdin
  but "creates a new version of the Worker and deploys it immediately".
- **What prints values.** `sst secret list` (its output is the `KEY=value` file `sst secret load` reads), `doppler
secrets`, `doppler secrets get` and `download`, `gcloud secrets versions access`, `vercel env pull` (into a file).
- **The merge keeps a branch's history** (`git merge --no-ff`). A key added in one commit and removed in the next is
  not in the branch's net diff and still lands in the repository.
- **A page check already knows where a page ended and with what status**, signed in as any state the manifest
  names: an access rule can be measured with what's there.
- **The task graph records** every status change with who and when, the rounds of changes a review asked for, and
  which findings the check after merges filed; spend is already split by task. The quality numbers need no new
  record.

## G. Security

### 35. A secret is stored through a manager, and its value is never in a command

Asked for by the operator: storing secrets through `sst` or another secret manager is fine, and encouraged, where
the value doesn't show in messages or in the UI. A flat "agents never touch secrets" pushes values into files and
chat instead.

- **A new policy, `secrets`, allowed by default** (as `dependencies` is; `"secrets": "deny"` turns it off). Under
  it, one simple command that stores one secret, with its value on stdin, passes the rules that otherwise refuse the
  tool (deploy, cloud, github):

  | Tool    | The form that passes                                                            |
  | ------- | ------------------------------------------------------------------------------- |
  | SST     | `… \| sst secret set <Name> [--stage <s>] [--fallback]`                         |
  | Vercel  | `… \| vercel env add <NAME> --environment <env>` (an environment must be named) |
  | GitHub  | `… \| gh secret set <NAME> [--env <e>] [--app <a>]` (the repository's own)      |
  | Doppler | `… \| doppler secrets set <NAME> --silent`                                      |
  | Google  | `… \| gcloud secrets versions add <NAME> --data-file=-` (and `secrets create`)  |

  The value comes from what's piped in or redirected: generated in the pipe (`openssl rand -hex 32 | npx sst secret
set AuthSecret`), or from the team's environment (`printf %s "$STRIPE_KEY" | npx sst secret set StripeKey`).
  Package runners (`npx`, `pnpm`, `pnpm exec`, `bunx`, `yarn`) and `timeout` may stand in front; any other wrapper,
  a variable set for the command, or an option the table doesn't list leaves the command to the tool's own policy.

- **Never, whatever is unlocked (core rules):**
  - **The value in the command:** a value operand (`sst secret set Name abc`, and `"$VAR"` too: arguments are
    logged), `--value`, `--body`, `NAME=value`, or literal text fed to the command (`echo abc | …`, a here-string, a
    here-document). What `echo` and `printf` feed must be nothing but a variable or a substitution.
  - **Printing values back:** `sst secret list`, `doppler secrets` (without `--only-names`), `doppler secrets get`
    and `download`, `doppler secrets set` without `--silent`, `gcloud secrets versions access`, `vercel env pull`,
    `aws secretsmanager get-secret-value`, `aws ssm get-parameter… --with-decryption`, `heroku config`, `vault kv
get` and `vault read`, `op read`, `kubectl get secret -o …`, `firebase functions:secrets:access`. The first five
    were read from the tools' pages or help this week; the rest are long-standing behaviour.
- **Production stays the operator's.** A store that names a production target (`--stage`, `--environment`, `--env`
  or `--config` holding `prod` or `live`; a Vercel variable with no environment named) is left to the deploy policy:
  it changes what the next deploy runs. With `"deploy": "allow"` it passes. A production stage under another name is
  the operator's to name in the team's `never` rules.
- **Left with their own policies, and why:** `wrangler secret put` deploys at once and `fly secrets` restarts the
  app, so both are deploys. `supabase secrets set`, `netlify env:set`, `heroku config:set`, `railway variables` and
  `convex env set` take the value as an argument and have no documented stdin form for one value.
- **The prompts say it** (planner, builder, scaffolder, tester, setup): a secret the work makes (a signing secret)
  is generated in the pipe; one that comes from a third party is the operator's, asked for by name with the command
  they'd run; no value is ever written into a file, a message, a commit or a command.
- **Where:** `lib/policies.ts` (the policy, the reading of a store, the core rules, the exemption in `brokenRule`),
  the guard's self-tests in `a6g check`, `lib/prompts.ts` and the role prompts.
- **As built, beyond the above:** a read-only role (reviewer, UX specialist, innovator, approver) stores none, and
  says which is needed in its report; a target that's a variable (`--stage "$STAGE"`) counts as production, since
  the guard can't read it; `gcloud auth print-access-token` and `op item get` joined the commands that print; a team
  whose own `never` rule names a store keeps refusing it, and `a6g check` expects that. A refusal of an unread form
  says which form passes.
- **Limits, stated:** the guard reads the command as written. A script that prints a value, `tee` in the pipe, a
  stage exported by an earlier command, or a value typed into a variable first isn't read: this is the seatbelt the
  README describes, and decision 31 is the check that measures.

### 31. Secrets don't merge

The other half of 35: wherever a value ended up, it doesn't reach the repository through the merge queue.

- **What's read:** the added lines of every commit the merge would bring in (`git log -p integration..tip`: the
  history, not the net diff), and the files those commits add or change.
- **Refused, with no allowance:**
  - a line holding a live credential by its shape: a private key block, a live Stripe key (`sk_live_`, `rk_live_`
    with a real key's length), an AWS access key id (`AKIA…`, not the documentation's `…EXAMPLE`), a GitHub token
    (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), a Slack token (`xox…`), an Anthropic or OpenAI key, a
    SendGrid key, a Stripe webhook secret (`whsec_` with a real one's length);
  - a secrets file added or changed (the guard's own list: `.env*`, `.dev.vars`, `*.pem`, `*.key`, `.npmrc`,
    service-account files, …). `.env.example` and its kin pass, as in the guard. `.env.test` and `.env.e2e` pass by
    name, because Part 1 put them in the scaffolder's test lane (decision 15), and are read for keys like any file.
- **Only shapes that are real by construction.** Test-mode keys, JWTs, Google API keys (public in a web app's
  configuration) and "looks random" are left out: with no allowance, a false alarm would be a stall.
- **The refusal names the file, the line, the commit and the kind, never the value**, and the way through: the
  branch is built again without it (the value is in the branch's history, so a commit that removes it isn't enough),
  the planner tells the operator, who rotates the key. A test that needs a private key generates one. A secrets file
  that holds no secrets is the operator's to commit.
- **Where:** `lib/secrets.ts` (the shapes, the patch reader), `lib/commands/merge.ts` before the lane checks.

### 29. Access rules in the manifest

- **A page takes `refuses`:** the sign-in states, and `signed-out`, that must not be served it.
  `{"id": "admin", "path": "/admin", "as": "admin", "refuses": ["member", "signed-out"]}`.
- **Measured with the page checks' own reading.** For each refused state the page is loaded once (first size, first
  scheme) signed in as that state, or signed out. Refused is: it ended at another path once settled, or it answered
  401, 403 or 404. Anything else is a failure of the page: "served to member" (a blocker when the check after
  merges files it: data reaches the wrong person), or the status it answered.
- **A refusal counts only from a sign-in the same run proved.** An expired `member` session is sent to the sign-in
  page too, and would read as refused. So every state a page refuses must be the `as` of some page in the manifest
  (the manifest doesn't load otherwise), and before a refusal is trusted the run loads that page as that state: if
  it doesn't land, the refusal is reported as not checked, which fails.
- **Additive, so the scaffolder may add them; removing one is checking less** (`narrowing`, and so the operator's
  allowance).
- **Limit, stated:** an app that refuses in place, with a 200 and "not allowed" on the same address, can't be told
  from one that serves. That rule is proved by a test tagged `@access` instead (decision 30).
- **Where:** `lib/harness.ts` (the field, its validation, `narrowing`), `lib/commands/pages.ts` (`signIn` makes the
  refused states too; the refusal pass; the result and its printing), `lib/verify.ts` (the finding), the
  scaffolder's prompt.

### 30. Access tests are a gap the factory files

- A manifest with two or more sign-in states, a suite that ran, and no passing test tagged `@access` is a gap, filed
  once like a journey with no test: a `test` task for the scaffolder or tester. Its body says what such a test is:
  signed in as one user, read and change another's record by its address and through the API, and expect to be
  refused; one for each kind of record that belongs to somebody.
- Rejected by the operator, it stays quiet (`fileOnce`).
- **Where:** `fileGaps` in `lib/verify.ts`; the tester's and scaffolder's prompts name the tag.

### 32. Vulnerable packages are a finding

- **When:** in the check after merges, when a lockfile's content differs from the last one audited, and once a week
  otherwise (advisories arrive for packages that didn't change).
- **What runs:** the package manager's own audit of what ships, in the lockfile's folder, under a time limit: `npm
audit --omit=dev --json` beside a `package-lock.json`, `pnpm audit --prod --json` beside a `pnpm-lock.yaml`. Both
  reports' shapes are measured in the tests from real output. Other lockfiles get one log line and no audit.
- **What's filed:** one task per package with an advisory at high or critical, kind `chore`, severity major, naming
  the advisories, the range that's fixed, and whether the package is the app's own dependency or one of theirs.
  Quiet while its task is open; a rejected one stays quiet until a new advisory arrives for the package.
- **Offline, or a report that can't be read, is a log line** in `verify.log`, and the audit is tried again at the
  next check. It never fails a merge.
- **It calls the registry the install already uses** (package names and versions go to it). `"security":
{"audit": false}` in team.json turns it off.
- **Where:** `lib/audit.ts` (the commands and the two report readers), `lib/verify.ts`.

### 33. A security reviewer: the one new agent

- **A role, `security-reviewer`:** read-only, one at a time, with its own prompt. A team has it when team.json's
  `roles` lists it; setup drafts it for a repository with sign-in, payments or its own API.
- **Its verdict is the factory's record:** `a6g verdict security <branch> pass|issues --sha <tip> --note …`, kept in
  `state/security/`, owned by the role (the guard and the command both check), pinned to the tip like a review.
- **The merge queue requires it** on a team that has the role, for a branch that:
  - changes a path matching team.json's `security.paths`; left out, a built-in list (sign-in, sessions,
    permissions, payments, webhooks, migrations, policies; not every API route, which setup offers the operator
    instead); or
  - the reviewer sent on: `a6g verdict review <branch> approve --security`, for a change that touches who can do
    what in a file no pattern names.

  A rebased branch keeps its pass the way a review does (an unchanged range-diff). A team without the role is asked
  for nothing; `a6g check` says so when it has `security.paths` and no reviewer.

- **What it asks of each change** (its prompt): who can call this, and as whom; what comes back, against what they
  may see; where input is trusted (queries, file paths, redirects, HTML); whether money and permissions are worked
  out on the server; what reaches logs and messages; whether a secret is named, never held (decision 35).
- **The planner knows before it merges.** At submit the task records the security paths its branch touches (beside
  `critical`); `a6g task show` and the planner's context say "needs the security reviewer". The planner's prompt
  gains the step: start one beside the reviewer, merge when both passed.
- **Once a cycle, and before a finish line, it sweeps** the whole access model with no branch (who can reach which
  page and which record), and files what it finds as tasks. This one is the planner's prompt, not a rule: nothing
  refuses a cycle that skipped it.
- **Where:** `lib/config.ts` (`ROLES`, `security`), `plugin/agents/security-reviewer.md`, `lib/commands/tools.ts`
  (the verdict), `lib/guard.ts` (the owner), `lib/commands/merge.ts`, `lib/commands/task.ts`, `lib/tasks/model.ts`,
  `lib/prompts.ts`, the planner's and reviewer's prompts, the review skill, `lib/detect.ts`, the setup prompt,
  `docs/team.md`.

## H. Numbers

### 34. `a6g metrics --quality`

From what's already recorded, for the period `--since`/`--until` name:

- **Merged:** tasks merged, by kind.
- **Reviews passed first time:** of the merged tasks that were reviewed, the share with no round of changes.
- **Found after merge:** the tasks the check after merges filed (a page or a test that failed, the app down), per
  merged task. Gaps (a journey with no test, no access test) and package advisories are counted apart: they're not
  something a merge broke.
- **Journeys proven**, of those the team has.
- **Flaky tests** in the recorded runs.
- **Cost per merged task**, and the time from claimed to merged (median).

`--json` gives the same numbers. It's how we learn whether Part 1 worked, what the security reviewer costs, and what
to build after it.

- **Where:** `lib/commands/metrics.ts`, reading the task store, the suite's history and `spendByWork`.

## Build order

Each phase ends with its tests, `npm test` and `npx prettier --check .` passing, and one local commit.

1. **G1: secrets through a manager (35).** The policy, the store reader, the core rules, `a6g check`'s cases, the
   prompts. Tests: every form in the table passes with deploy, cloud and github denied; each value-in-command form
   and each printing command is refused with every policy allowed; production and unknown options fall to the
   tool's policy; `"secrets": "deny"` refuses the forms.
2. **G2: secrets don't merge (31).** Tests: a key added then removed in a later commit is refused; a `.env.local`
   added is refused and `.env.example` and `.env.test` pass; the message holds no part of the value; a documentation
   example key and a short fake pass.
3. **G3: `refuses` and the `@access` gap (29, 30).** Tests against the fixture app: a page served to a refused state
   fails and one that redirects or answers 403 passes; a refusal with a dead sign-in is "not checked"; removing an
   entry is narrowing; the gap is filed once and not with one state.
4. **G4: the package audit (32).** Tests from recorded npm and pnpm reports; a registry that can't be reached is a
   log line; an unchanged lockfile within the week isn't audited again.
5. **G5: the security reviewer (33).** Tests: the verdict's owner and its pin to the tip; a merge refused without it
   on a matching path and on a sent-on branch; a team without the role merges as before; the task shows the need.
6. **H: the quality numbers (34).** Tests over a fixture task store.
7. **Wrap-up:** README, CHANGELOG, `docs/team.md`, the checklists here and in `harness-hardening.md`.

## What a team sees on upgrade

| Team                                       | What changes                                                 |
| ------------------------------------------ | ------------------------------------------------------------ |
| Any                                        | A branch carrying a live key or a secrets file doesn't merge |
| Any                                        | Commands that print a manager's secrets are refused          |
| Any (default)                              | The store forms of decision 35 pass                          |
| With a lockfile and the check after merges | Advisories at high or critical become tasks                  |
| With two sign-in states and a suite        | One task: no `@access` test                                  |
| Whose manifest gains `refuses`             | Those pages are loaded as the refused states                 |
| That adds `security-reviewer` to its roles | Branches on `security.paths`, or sent on, need its pass      |

## Later, and what would promote each

- **Reading a secret out of one manager into another** (`op read … | sst secret set …`): a team that keeps its
  secrets in one and deploys from another.
- **`printenv` and `env` printing the team's environment:** a value seen in a transcript.
- **A key written into a file, caught as it's written** (the guard reading what Write and Edit hold): a branch
  refused at the merge for it, after the work was done.
- **Test-mode keys and unshaped secrets in the merge check:** one that reaches the repository.
- **Audits beyond npm and pnpm** (yarn, bun, pip-audit, cargo audit, govulncheck): the first team on one.
- **Access rules for API routes in the manifest** (a method, a body, an expected refusal): an `@access` test that
  proves too little.
- **The sweep as a rule** (a finish line that asks for it): a finish line reached without one.
- **Response headers in the page checks** (a content security policy, cookies' flags): the security reviewer filing
  the same finding twice.
- From Part 1's list, unchanged: a schema change tried before it merges; proofs a member can't write; one test per
  journey criterion; phone Safari; performance budgets; pruning; release readiness and production errors as tasks.

## What's yours to decide

Defaults are chosen; say if you'd choose otherwise.

1. **Agents store secrets by default, except for production (35).** `"secrets": "deny"` turns it off for a team;
   `"deploy": "allow"` is what lets a team set production's. The alternative is a production store allowed under
   `secrets` alone.
2. **A value is given on stdin only (35).** `sst secret set Name "$VAR"` is refused though nothing shows in the
   message, because arguments are logged and one form is easier to check and to teach.
3. **The security reviewer runs on every branch touching `security.paths` (33),** and the built-in list leaves out
   API routes. One more agent run per such branch; `a6g metrics --quality` says what it costs.
4. **The package audit calls the registry (32),** covers what ships (not development tools), and its findings are
   major: they hold a finish line until fixed or rejected.
5. **Two releases or one.** Part 1 alone makes 0.7.0 safe to install; Part 2 can follow as 0.8.0.

## Checklist

- [x] G1. Secrets through a manager (35)
- [ ] G2. Secrets don't merge (31)
- [ ] G3. `refuses` and the `@access` gap (29, 30)
- [ ] G4. The package audit (32)
- [ ] G5. The security reviewer (33)
- [ ] H. The quality numbers (34)
- [ ] README, CHANGELOG, `docs/team.md`
