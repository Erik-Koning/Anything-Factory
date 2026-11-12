# Anything Factory web app

A small Next.js app, on the same MongoDB as the teams' task graphs, where people beyond the operator's machine send
**requests** to a team and follow its work, members **suggest tasks** for the planner to triage, and the operator
**adds tasks**, **decides on proposals** and **answers what waits on them** from anywhere, switching between the teams
they run, and everyone chooses what they're **emailed** about. The plan is
[docs/plans/web-app.md](../docs/plans/web-app.md).

It has no rules of its own. It imports the factory's task code from `../lib/tasks/` (no copies) and writes only through
it: a request is the factory's `addRequest`, a person's stakeholder record its `stakeholderFor`, a task its `addTask`,
and an admin's decision its `decide`, as the operator, with the team's approval rules from the `teams` document
`a6g register` publishes. An approval from the web is exactly `a6g task approve` by the operator, and a task an admin
adds is exactly `a6g task add` by the operator (`--approved` when they approve it as they add it). A member's
suggestion is a task in `triage` by `stakeholder`. Either way the task records who added it, as their stakeholder id
(`from`, and in its first history event), never their name: the board shows them as "you", by name to an admin and by
role to anyone else.

## Who sees what

| Role                        | Sees and does                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **admin** (the operator)    | everything, on every team; adds tasks; decides proposals; reviews what the team decided for them and sets its working agreement; invites, changes and removes people; sees senders' names and emails |
| **member** (of a team)      | the board, journeys, the graph, recent merges, each task and every request (senders by role, never by name); reads what the team decided for the operator; sends requests; suggests tasks for triage |
| **contributor** (to a team) | the team's overview (status, journeys, progress counts) and their own requests; sends requests                                                                                                       |

Admins and members also see the machines they've linked to their account (`a6g connect app`) and the teams each runs,
and may unlink them; an admin sees and may unlink every machine, and sees whose it is. A team's card names only the
machines of its members and admins that run it: a member of another team may link a machine whose report names any
team, but it says nothing about where this one runs.

Anyone may create an account (below), and a new account is on no team: its Teams page is empty and says an admin adds
them to one. People lists everyone, on a team or not; inviting an address that has an account puts that account on the
team.

Roles are per team (a member of one team can be a contributor to another). The rules are in `server/access.ts`; every
page and server action asks there, and `tests/unit/access.test.ts` proves them. The team's agents still see a request's
stakeholder id and role only: names and emails live in the accounts and the stakeholder records, never in a task or a
request (Article 8).

## Pages

- `/` Teams: the teams you can see, each with its state, planner, members at work by role, the machines it runs on
  (for members and admins: its lead first, and any not reporting), aim, last merge, and links to its pages.
- `/machines` Machines: your linked machines (an admin's: every one, with its owner), those reporting first, each with
  its last report and the address it came from, when it was linked, and the teams registered on it: lead or worker,
  state, planner, members at work and checkout (a team whose tasks are in files is named, with no pages here); and
  Unlink. `/machines/link`: where `a6g connect app` sends you to look up its code, check it, and approve or refuse it.
- `/t/<team>/add`, as an admin, **Approve it now** takes a code from your authenticator, as a pause does: the task goes
  straight to the builders.
- `/t/<team>` Overview: status, progress, journeys (and which are due their verification); for members and admins the
  graph (the factory's own `layout`, as SVG) and recent merges. For admins, **Pause and resume**: pause the team now,
  after the work under way, or after chosen journeys (they finish, verification and polish included, and nothing else
  starts); while it's pausing, what's still going and what can't move without you; once paused, the report of where it
  stands; and Resume, with feedback for the planner. Each asks for an authenticator code and goes in the audit log; the
  lead's watchdog applies it within a minute (until then the panel says it's waiting for the team's Mac). Then
  **Spend**: what its tokens would cost on the Claude API today, this week and in all (against the budget, when there
  is one), each of the last 14 days, and the journeys and tasks that cost the most; and the budget itself (a day, a
  week, in all, and whether a new day or week resumes a team it paused), set with an authenticator code like a pause,
  in dollars or in percent of a Claude subscription's week (over 100% for more than one subscription's worth). Once
  the subscription is measured (`a6g subscriptions`), every figure also shows its share of a subscription's week, and
  the panel what the subscription's own usage report says.
- `/t/<team>/inbox` **Waiting on you** (admins), with its count on the tab, in the header on every page (all teams:
  `/inbox`), on the Teams page and at the top of the overview: each question the planner or the approver put to the
  operator, and each block raised to them (a block the team sorts out, or that waits on other tasks, isn't listed).
  Every one shows why it's theirs and what the team recommends (the task's `ask`, which raising it requires; from its
  own words for one raised before, or said to be missing), the task's options read out of it ("(a) … (b) …") as
  choices with the recommended one marked, what it holds up and the other questions it mentions. An
  answer is an option, the recommendation or the admin's own words, with anything added: the factory's `answer`
  (`lib/tasks/answer.ts`), a note by the operator marked as the answer, which leaves the task where it is. The lead's
  watchdog passes it to the planner within a minute, which records it in its decisions and moves the task on; until
  then it's under "Answered, with the planner" (marked when the planner hasn't acted for 15 minutes), and once it has,
  under "Settled this week". "Or decide it yourself" approves (scored work only, never a research question) or
  rejects, as on Decisions, and comes back here.
- `/t/<team>/board` Board (members and admins): a lane per step of a task's way through the team, left to right:
  Triage, Proposed (escalated and researching marked), Approved (in claim order, with what each waits for), Building
  (which role on which machine, and the lease left or run out), Review (branch, commit, rounds of changes), Blocked
  (only when something is) and Done (the newest eight, with a count of the rest and of what was rejected; "show them"
  opens `?done=all`, every done task and a Rejected lane). Each card says who it came from ("suggested by", "added
  by", "requested by" for work the planner made of a request, or the team role) and links its journey. Journeys aren't
  cards. The lanes run to the window's edge and scroll sideways when they don't fit. A team with no tasks yet gets one
  empty state. The board shows the work; moves stay with the team (claims, review, the merge queue) and the Decisions
  page.
- `/t/<team>/graph` Graph (members and admins): the task graph by level, in BetterDiagrams' own editor
  (`@mosphere/better-diagrams`, read-only), from the factory's `levelDiagram` (`lib/tasks/graph.ts`). The journeys are on
  the top level (C1), with a card for the work in no journey (opened at once when a team has no journeys); double-click
  one, or its ⊞ count, to open its tasks a level down (C2), and a journey inside it a level further (C3, and so on: a
  level for every `parent`). Each level puts a card after the cards beside it that it waits on, a dependency between
  tasks in two journeys showing as one between the journeys. Only approved work is a Task card (done once merged, in
  progress or in review, held by the member's role on its machine), so the editor's own reading of it holds: ready
  when nothing it waits on is open, and the plan's progress. Work waiting for a decision, a question put to the
  operator, blocked work and approved work after something that isn't a task card (a journey, unapproved or blocked
  work, a rejected task: the editor would read it as ready) each have a card that says so, and what a blocked task
  waits on is a dashed line. The editor's checks leave out what doesn't fit a task graph (tasks with no dependencies,
  nobody holding open work); a deadlock still shows. Each card links (↗) to the task's page. The level is in the address (`?at=<id>`), which a task's
  page links to ("In the graph"); the breadcrumbs and Esc come back out. The overview's graph links here.
- `/t/<team>/add`, from the board's button: Add a task (admins: a proposal, or approved as it's added, under a
  journey, after other tasks) or Suggest a task (members: title, kind, how bad it is for a bug or a UX problem, and
  what's needed, at least 20 characters; it goes to triage, and the planner never approves it itself: it makes it its
  own proposal for the approver or the operator).
- `/t/<team>/tasks/<id>` (members and admins): one task, as `a6g task show` prints it: where it stands, its journey and
  dependencies, who holds it, who it came from, its gate and score, notes and history (people in it said as you may
  read them). For an admin, a proposal or a task in triage has a Decide button. The board, journeys, merges, the
  Decisions page and a request's page link here.
- **Switch team**, beside each team's name: the other teams you follow and their state, keeping the page you're on.
- `/t/<team>/requests` and `/t/<team>/requests/<id>`: the form, the list, and each request with its status, the tasks
  it became and theirs, notes and the reason when it's turned down. Contributors see their own.
- `/t/<team>/proposals` (admins): proposals with who they came from, their gate and score; approve with a note, reject
  with a reason, send back for research, escalate. Tasks in triage come last, for when one can't wait for the planner.
- `/t/<team>/decided` (members and admins; the tab reads **Decided for you** to an admin, **Decision log** to a
  member): the decision log, every question the team answered in the operator's place (`a6g decision record`). What's
  flagged and not reviewed comes first, then what stands, then what was overturned. Each says what was chosen, what
  that follows from, what was weighed, how it's undone, its tasks, and why the operator wasn't asked: the rule of the
  working agreement, and the version in force then. An admin agrees with one or overturns it and says what to do
  instead; a review the team's Mac hasn't written onto the record yet says so, and an overturned one shows what the
  planner noted it did. The tab counts what an admin has left to review. The app only reads decisions: a review is a
  control, as a pause is, which the lead's watchdog writes onto the record and, for an overturn, passes to the planner.
- `/t/<team>/agreement` (admins): the working agreement, how readily the team brings a question to the operator.
  What's in force and who set it; how the last 30 days went (asked, decided, flagged, overturned); what the
  operator's reviews and answers under the agreement in force suggest (since it was last changed, and at most those
  30 days), when they suggest anything: a topic they keep overturning is one to be asked about, and one where they
  take the team's recommendation as it stood every time is one the team could decide. Each hint says what was seen
  and the change it points to, and nothing is changed for them; each level's table of what happens to a question, by
  what a wrong call costs and how sure the team is; the form that changes it (the level, each topic as follows the
  level, always ask or never ask, how often a message may reach them, and standing instructions in the operator's
  words), with a code from the authenticator, like a pause; and every version, with what it changed and who made it.
  How often a message may reach the operator is the team's own setting (`contact` in its `team.json`) until the
  agreement sets it: a digest with its window in hours, or each message as soon as it's needed. Privacy and the
  team's own rules are always the operator's and aren't offered; nor are the platform and the stack on a team whose
  operator isn't technical. A team published by a factory version from before the agreement (its settings name no
  `operator`) says so on both pages and offers no form. Under a question on **Waiting on you**: why it was asked. One
  the planner raised says which rule of the agreement made it the operator's and how it was judged, with a link here;
  one the approver escalated says the approval rule that sent it up, which is the team's own setting, so it has no
  link. An answer that takes the team's recommendation as it stood (the recommendation, or the option it names, with
  nothing added) is recorded in the recommendation's own words and marked so on the task: those are what the hints
  count, one answer a question.
- `/admin/people` (admins): invite by email with a role on a team (an address that signed up joins the team with the
  account it has), change a role, remove from a team, ban and unban; everyone with an account, on a team or on none.
- `/admin/audit` (admins): the audit log, newest first, filtered by what, how it went, who and IP address.
- `/account/notifications`: what the person is emailed about, for each kind of event they could see in the app
  (questions for them, what the team decided for them and flagged, blocked work, journeys done, a team pausing or
  finishing, work merged, their requests): at once, in a daily digest at the hour and time zone they choose (the
  browser's until they save one), or not at all; the teams they hear about; for admins, whether the digest also
  lists what still waits on them and how many of the team's flagged calls they haven't reviewed. Until they save,
  their role's defaults apply (an admin hears of questions at once, and of blocked work and flagged calls in the
  digest); a kind of event added after they saved has their role's default until they choose. It shows the last
  email sent and what's waiting to go, and sends a test email (three an hour).
- `/account`: passkeys; the authenticator (on for admins; anyone else turns it on or off) and backup codes; where
  you're signed in, with each session's address; the IP addresses you've confirmed, and whether new ones are checked
  (always, for an admin); your recent activity; sign out.
- `/sign-up`: a name, an email address, a password, and the two choices, both ticked: two-factor authentication and
  the check of new IP addresses. `/sign-up/confirmed` is where the emailed link lands when it couldn't sign anyone in
  (used already, expired).
- `/welcome`: where someone who chose two-factor authentication as they signed up sets up their authenticator, or
  puts it off, before anything else opens.
- `/second-factor` and `/confirm-sign-in`: where a session waits for its authenticator's code, or for its new IP
  address to be confirmed by email; `/sign-in/confirm` is the email's page (“Was this you?”), no session needed.
- `/forgot-password` and `/reset-password`: asking for a link to set a new password, and the page the link opens
  (the new password, and the authenticator's code for an account that has one); no session needed, and none made.

## Linking a machine

`a6g connect app` (on the operator's Mac, `lib/app.ts`) links the Mac to the account of whoever approves it, with
OAuth's device authorization grant (RFC 8628). The machine never sees the person's sign-in, and the person never
handles the machine's token. Admins and the members of a team link machines, at most ten each; contributors don't.

1. The CLI asks `POST /api/machines/link` (a form, or JSON: `client_id=a6g-cli`, `name`) for a code: a device code (32
   random bytes, kept here only as their hash) and a user code (eight letters without vowels, shown as `BCDF-GHJK`),
   for ten minutes. An address asks for at most five in 15 minutes. Linking again, the CLI sends its old token
   (`Authorization: Bearer …`): the new link replaces that machine, and only that one.
2. It shows the user code and opens `/machines/link?code=…`, which only fills the form in. The person signs in as
   anywhere else (their second factor, a confirmed address) and looks the code up: a form post, so a link from
   anywhere else can't spend their looks. Every look and every decision counts, right or wrong, and nothing clears the
   count before it expires: ten per person and thirty per address in 15 minutes, so nobody signed in finds someone
   else's code by guessing. The page shows the code, the machine's name, and the address and device it asked from; a
   code asked for from another address than the person's comes with a warning, and must be typed to be approved.
3. Meanwhile the CLI polls `POST /api/machines/token` (`grant_type`, `device_code`, `client_id`) every five seconds,
   five more after a `slow_down`; it gets `authorization_pending`, then `access_denied`, `expired_token` or
   `invalid_grant`, or once the token: `a6gm_` and 32 random bytes, kept here only as its hash, with the account it's
   linked to, masked (`m•••@example.com`). The person is emailed that a machine was linked, from where, and where to
   unlink it.
4. The watchdog reports with it (`POST /api/machines/report`, `Authorization: Bearer …`): the report is rebuilt from
   the fields it may have (`lib/fleet.ts parseReport`: no control or format characters, checkouts as absolute or
   `~/` paths) and refused whole otherwise (400), over 256 KB (413), or sooner than 20 seconds after the last (429). It
   doesn't rename the machine. When the token is a week old, the answer carries the next one (200); the old one keeps
   working for a day, for a CLI that missed it, until the new one is used, and if it's used after that, the link ends
   (RFC 9700's refresh token rotation). An old one that comes back while its successor is unused gets another in the
   successor's place; that successor, if it ever turns up, was someone else's, and the link ends too.
   `DELETE /api/machines/self` unlinks it (`a6g disconnect app`).

The token reports its machine and does nothing else: no page or Better Auth endpoint takes it, and these endpoints
take no cookie and set none. It stops working when the machine is unlinked (from its card, or by itself), when its
person is banned or is no longer a member of any team (an admin's change of their role or teams unlinks them at once),
and after 30 days without a report; only an `invalid_token` tells the watchdog to forget it. The endpoints are behind
the CDN like every other request, and their answers are never cached. Links and codes live in the accounts database
(`machine_links`, `machines`), never in the task graphs the agents read. Linking, refusing, a token's issue, unlinking
(a link a token's use ended too: copied, quiet too long, its person no longer allowed), a look past the limit, and a
made-up token (once per address in 15 minutes) go in the audit log.

## Signing up and signing in: two factors, new IP addresses, and the audit log

Two ways to an account. **Anyone signs up** at `/sign-up`; and an admin **invites** someone by email from People: the
app makes the account (Better Auth's admin plugin), gives it its role on the team and a stakeholder record there, and
emails a sign-in link. An invited account has no password; one that signed up is on no team until an admin adds it.

- **Signing up** takes a name, an email address and a password of 12 characters or more. Nothing opens until the
  address is confirmed: the sign-up emails a link, good for an hour, and opening it confirms the address and signs the
  person in, once (opened again it signs nobody in). Until then the password is refused, and the link is sent again
  (at most one a minute). A sign-up for an address that already has an account answers exactly as a new one does, as
  slowly, changes nothing on that account, and emails its owner that they have one. A sign-up sets a name, an
  address, a password and the two choices below and nothing else: a role in the request is refused, and a ban, a
  second factor or “confirmed” is dropped. Nobody becomes an admin by signing up, and a confirmation link never signs
  an admin in. From one IP address: three sign-ups and three requests for the link again a minute.
- **The two choices on the sign-up page**, both ticked unless the person unticks them, are kept on the account
  (`authenticatorDue`, `ipCheck`). They're read as the account is made and changed afterwards only by the app's own
  server actions; no endpoint takes either.
  - **Two-factor authentication**: once the address is confirmed the person lands on `/welcome` and sets up an
    authenticator app before anything else opens: their password, the QR code (or its key), a code to prove it, ten
    backup codes shown once, then on to Teams. **Set it up later** there puts it off (audited); the account page
    offers it from then on.
  - **Check new IP addresses**: a sign-in from an address they haven't used asks them by email first (below). Without
    it no address is asked about. It can be changed on the account page: turning it off takes a sign-in from the last
    ten minutes and a code from the authenticator when one is on, is audited, and emails the person that it was
    turned off; turning it on confirms the address it's turned on from. An admin's addresses are always checked.
  - Accounts from before these were kept read as: new addresses checked, nothing due.
- An account whose address is first proven by a sign-in link, not by its confirmation link, loses the password it was
  signed up with (Better Auth's rule: whoever chose it hadn't proven the inbox) and has its IP check on.
- **A forgotten password is set again from a link by email** (`/forgot-password`, from the sign-in page;
  `server/password-reset.ts`). Asking answers the same for every address, as slowly, and emails only an address that
  has an account, never a banned one, once a minute; three asks a minute from one IP address. The link works once,
  for 30 minutes, and opens the app's own page (`/reset-password`): opening it changes nothing, and it signs nobody
  in. Only a digest of its token is stored.
  - **An account with an authenticator gives its code as well**, so an inbox alone never changes a password that a
    second factor guards. That is every admin. Each try counts against the person's five (below); a wrong code
    doesn't use the link up. An admin with no authenticator (made some other way than `create-admin`) can't use the
    link, and is told who can start the account afresh. A backup code isn't taken here: someone without their
    authenticator signs in with their password and a backup code, or is started afresh.
  - Setting it ends every session of the account, emails its address that the password changed and from where, and
    is audited (asked for; set, failed or refused). The old password is refused from then on.
  - An account with no password (an invited one) gets its first this way: the link proves the inbox as a sign-in
    link does. An address nobody had confirmed is confirmed by it, with its IP check on, and the password it was
    signed up with is gone.
  - Better Auth's own endpoints for setting the password (`/api/auth/reset-password`) are refused over HTTP: only
    the app's page sets one, after these checks.
- **Everyone** signs in with a **passkey**, a **magic link** by email (15 minutes, once), or **their password** when
  they have one (they signed up). A link is sent only to an address with an account: no sign-up by link.
- **Admins sign in with two factors, by design.** Better Auth enforces two-factor only on email-and-password sign-in,
  so the app makes that the admins' way in and closes the others:
  - An admin is made by `npm run create-admin` on the operator's machine, which creates the account with a password
    **and enrols its authenticator (TOTP) at once**, printing the setup link and ten backup codes. No admin account
    exists with only a password.
  - An admin signs in with **password + authenticator code** (or a backup code), or with a **passkey whose
    authenticator verified them** (PIN or biometrics: the UV flag of the signed assertion, checked on the server).
  - **No magic link for admins**: none is sent to an admin's address, and a session from one is refused for an admin.
    An admin who asks for one is emailed a note in its place (once a minute): how admins sign in, that a forgotten
    password is set again from the sign-in page with the authenticator's code, and that whoever runs the site starts
    an admin without their authenticator afresh with `npm run create-admin`. The page answers the same as for
    anyone, so without the note nothing would say why no link came.
- **Anyone else may turn on an authenticator**, as they sign up or from their account page (a QR code, a code to
  prove it, ten backup codes shown once; Better Auth's two-factor plugin). From then on every sign-in, by passkey,
  link or password, also asks for its code. Turning it off takes a current code. An account with a password gives it
  too, to turn the authenticator on or off and to make new backup codes (Better Auth asks it of any account that has
  one); an invited account has none to give.
- Each session records **whether it has its second factor** (`session.secondFactor`): set by the server from how the
  session was made, or once a code is entered for it at `/second-factor` (an admin whose passkey didn't verify them,
  anyone with an authenticator after a link). Five wrong codes end the session. The client can't set it.
- **A new IP address is confirmed by email.** Every session records its IP address, and each person has a list of the
  addresses they've confirmed (an IPv4 address whole, an IPv6 address by its /64). A session used from any other
  address, at sign-in or later (a cookie taken elsewhere), can do nothing until its person confirms it: they're
  emailed a link to a page that shows the address, device and time, with **Yes, it was me** (the address joins their
  list) and **It wasn't me** (every session on the account ends). A button answers, not the link, so a mail scanner
  that opens links answers nothing; the link works once, for 30 minutes, and a new one goes out at most every 10
  minutes. Signing in by an email link, or confirming a sign-up's address, confirms the address it's opened from, since
  opening it already proves the inbox. The account page lists your addresses (with Forget) and each session's
  address. Someone who isn't an admin may turn the check off for their own account (above).
- **The audit log** keeps every sign-up, sign-in (by method, or why it failed), sign-out and ended session, second
  factor, new address (asked, confirmed, denied, forgotten), the check of new addresses turned off or on, passkey and
  authenticator change (and one put off at sign-up), invitation, role change, removal,
  ban, request, task and decision, pause, resume and budget, change to a team's working agreement (`team.agreement`)
  and review of what a team decided (`decision.reviewed`): who, when, from which address and device, and how it went. It's in the accounts
  database (`audit`), written once and never changed, kept `AUDIT_RETENTION_DAYS` (400). Admins read and filter it at
  `/admin/audit`; each person sees their own recent activity on their account page. The team's agents never see it.
- Pages and server actions check all of this on the server (`server/viewer.ts`, `server/access.ts`): a session that
  owes its second factor, an address confirmation or the authenticator it chose at sign-up is sent to finish that and
  can do nothing else. Over HTTP a session without its second factor or its address confirmed may
  only look at itself, sign out or sign in again, so it can't enrol a passkey or new backup codes to raise itself.
  Better Auth's own admin endpoints (`/api/auth/admin/*`) and turning the authenticator on or off are never served over
  HTTP; the app calls them from its server actions after its own checks. (`server/auth.ts` has the sign-in rules in
  one place.)
- **The viewer's address comes from the CDN**, never from what a browser says: CloudFront's function sets
  `x-a6g-viewer-ip` (`CLIENT_IP_HEADER`), and the app refuses every request without CloudFront's secret
  (`ORIGIN_SECRET`, sent as `x-a6g-origin`; `proxy.ts`), so nobody reaches it around CloudFront or makes the header up.
  Sessions, rate limits, the new-address check and the audit log all read the same address.
- Sessions are revocable from the account page; a ban ends all of a person's sessions and keeps them out.
- Rate limits: Better Auth's, kept in the database (from one IP address, 3 sign-ups, 3 requests for a confirmation
  link, 3 for a link to set a new password, 5 password sign-ins, 5 link requests and 5 two-factor tries a minute;
  100 auth requests a minute in all),
  plus Better Auth's own lockout after repeated wrong
  codes; and at most 20 requests and task suggestions a day per person.

## Running it locally

You need Node 22.18 or later and a MongoDB **replica set** (Better Auth's Mongo adapter uses transactions): an Atlas
development cluster, or a local one (`mongod --replSet rs0` then `rs.initiate()`). Never point a local run at the
teams' production database by accident: use your own cluster or a local one.

```sh
cd web
npm install
# web/.env.local, with the variables below (BETTER_AUTH_URL=http://localhost:3000)
npm run create-admin -- --email you@example.com --name "Your Name"
npm run dev            # http://localhost:3000
```

Without a mail service, sign-in links, confirmation links and invitations are printed to the dev server's console (`[mail] to=… link=…`):
only while the app's address is this machine (`http://localhost`), never where a log could hand someone a link.
A team shows up once its settings are in the `teams` collection: `a6g register` publishes them for a team whose tasks
are in Mongo (team.json `tasks.store: "mongo"`), and the lead's watchdog keeps its status current.

### Environment variables

| Variable                                                   | Needed                      | What                                                                                                                  |
| ---------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                                              | yes                         | The connection string (`mongodb+srv://…`), the app's own database user                                                |
| `A6G_DATABASE`                                             | no (`a6g`)                  | The task graphs' database (team.json `tasks.database`)                                                                |
| `AUTH_DATABASE`                                            | no (`a6g_web`)              | The app's accounts (Better Auth's users, sessions, passkeys, two-factor, rate limits; memberships)                    |
| `BETTER_AUTH_SECRET`                                       | yes                         | At least 32 random characters (`openssl rand -base64 32`); signs cookies, encrypts TOTP secrets                       |
| `BETTER_AUTH_URL`                                          | yes                         | The app's address (`https://a6g.example.com`): email links, and the passkeys' relying party and origin                |
| `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | served for real (or Resend) | Amazon SES and a key that may only send as the sender (`sst.config.ts` makes both)                                    |
| `RESEND_API_KEY`                                           | served for real (or SES)    | Resend's API key, instead of SES                                                                                      |
| `MAIL_FROM`                                                | served for real             | The sender, verified with the mail service (`Anything Factory <a6g@example.com>`)                                     |
| `MAIL_LOG`                                                 | no                          | `1` prints emails to the console when there's no mail service: only while `BETTER_AUTH_URL` is `http://localhost`     |
| `CLIENT_IP_HEADER`                                         | served for real             | The one header that carries the viewer's IP address (`x-a6g-viewer-ip` behind CloudFront; `x-forwarded-for` if unset) |
| `ORIGIN_SECRET`                                            | served for real             | At least 32 characters, the same as the CDN sends in `x-a6g-origin`; requests without it are refused                  |
| `AUDIT_RETENTION_DAYS`                                     | no (400)                    | How long the audit log keeps each event                                                                               |
| `NOTIFY_EVERY_SECONDS`                                     | no (60)                     | How often the notifier looks for what to email; `0` turns notifications off                                           |
| `NOTIFY_TIME_ZONE`                                         | no (`UTC`)                  | The daily digest's time zone for someone who hasn't chosen theirs (`America/Toronto`)                                 |

`.env.local` is ignored by git. The connection string, the secret and the mail key are the app's, never a team's.
Served anywhere but `http://localhost` with `NODE_ENV=production`, the app refuses to start without `ORIGIN_SECRET`,
`CLIENT_IP_HEADER` and a mail service: without the first two anyone could say what address they come from, and
without the last nobody could sign in.

### Tests

```sh
npm test               # tsc, then node --test: the unit tests (access rules, the UV check, TOTP, views, the origin check, import boundaries,
                       #   the Better Auth pin) and the integration tests (the real server/auth.ts over a throwaway local MongoDB)
npm run test:e2e       # next build, then Playwright against a local MongoDB
npm run test:e2e:atlas # the same against a real cluster, from the repository's .env (below)
npm run check:infra    # sst install, then tsc against SST's platform: the deployment (sst.config.ts) type-checks
```

The integration tests (`tests/integration/auth.test.ts`) call `auth().handler` directly, with no server or browser, over
a throwaway replica set from the same cached mongod binary as below: signing up (nothing before the address is
confirmed, the same answer for an address that has an account, what a sign-up can't set, the two choices and that no
request changes them, the limit), magic links, a forgotten password (the link alone for an account without an
authenticator, the link and a code for one with, what the link proves, the limits), an admin's password and
authenticator code, confirming a new IP address by email, backup codes, the HTTP guard, passkeys signed by a software
authenticator (with and without user verification, and from another origin), sessions, bans and `create-admin` run again.

The end-to-end tests start a MongoDB replica set with `mongodb-memory-server` from the mongod binary already on this
machine (`MONGOMS_SYSTEM_BINARY`, by default `~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6`; nothing is
downloaded), seed it with the factory's own functions (`tests/e2e/seed.ts`), run `next start` against it with
`MAIL_LOG=1`, and read sign-in links from its log. They cover an admin's sign-in with the authenticator and with a
backup code; an invitation; a contributor's magic link, request and what they can and can't see; a member's board,
graph by level and requests (senders by role); approving and rejecting (checked in the task documents); the decision
log as a member reads it and as an admin reviews it (the review a control, applied with the factory's own code), the
working agreement changed with a code (and a wrong one refused), a digest's window set in it, a question and an
escalation that each say why they were asked, an answer that takes the recommendation marked so, and the hint that
follows from three of them; a contributor and an admin
session without its second factor calling admin server actions directly (refused, nothing changes); passkeys with and
without user verification; the daily limit; phone width; and the sign-in rate limit. Its browsers send a viewer IP
address and the origin secret as CloudFront does (`playwright.config.ts`), and `security.spec.ts` covers the rest of
signing in: a request without the secret refused, an admin's new address confirmed by email (the link once), a session
taken elsewhere and “it wasn't me”, a member's authenticator and every sign-in after it asking for a code, and the
audit log. `sign-up.spec.ts` signs three people up: one through the confirmation email and the authenticator at
`/welcome` to an empty Teams page, one who puts the authenticator off and turns the IP check off and on from the
account page, one with both boxes unticked, whom an admin then adds to a team. Playwright's Chromium must be installed (`npx playwright install chromium`).

`npm run test:e2e:atlas` runs the same suite against a real cluster: it reads `DB_USER`, `DB_PASSWORD` and `DB_HOST`
from the repository's `.env` (gitignored; or `E2E_MONGODB_URI`), and uses databases of its own, `a6g_e2e` and
`a6g_web_e2e`, which every run empties first (it refuses any name that doesn't end in `_e2e`, so it never touches the
app's own). It leaves them after the run, with that run's admin (the e2e user) in `web/.env.e2e`: its address,
password, authenticator link and unused backup codes, to sign in with `npm run dev` against the same databases. The
tests' sign-ins come from 198.51.100.7, so one from your own address asks for an email confirmation first (printed to
the dev server's console). Against a distant cluster each page waits on several round trips, so the run takes minutes
rather than one.

## The first admin

```sh
cd web
npm run create-admin -- --email you@example.com --name "Your Name"
```

Run it on your own machine with `web/.env.local` pointing at the production database (or the variables in the
environment). It prints, once: the password, an `otpauth://` link for your authenticator app (paste it in, or make a
QR code of it locally), and ten backup codes. Keep the backup codes apart from the password.

Run it again for the same address to start that admin afresh: a new password, authenticator and backup codes, and every
earlier session and passkey ended (a lost authenticator; or to make an existing person an admin). There's no way to
make an admin from the web.

The admin's first sign-in comes from an address they haven't confirmed, so it asks them to confirm it by email: the
app's email (SES or Resend) must reach them before the first admin can get in.

## Deploying: Lightsail, behind CloudFront, by SST

The operator deploys the app; teams never do (Article 7). `sst.config.ts` (SST 4) makes all of it in one AWS account:

```
 viewer ──https──▶ CloudFront ──https + x-a6g-origin──▶ Lightsail container service ──▶ the app (Dockerfile)
                    │ its function sets x-a6g-viewer-ip and x-forwarded-host; /_next/static/* cached
```

- **The image** (`Dockerfile`, built from the repository's root since the app compiles `../lib/tasks`): Next's
  standalone server on Node 24 Alpine, as an unprivileged user, for `linux/amd64`, built into the local Docker engine
  and pushed into the container service's own registry (AWS's `lightsailctl` plugin). Not ECR: the organization's
  resource control policy refuses Lightsail's puller role, which belongs to AWS's account.
- **Lightsail**: a container service (`micro`, one container, by default) and a deployment of the newest image with the
  app's environment. Its health check calls `/api/health`, the one path open without the origin secret.
- **CloudFront** (SST's `Cdn`): everything passed through uncached with every viewer header but Host, except Next's
  hashed static files; HTTPS only; a viewer-request function that sets the viewer's address and the public host; the
  origin secret (made by SST, kept in its state) on every request to Lightsail. With `A6G_WEB_DOMAIN`, a certificate and
  DNS records for that domain in the account's Route 53 zone.

### Before the first deploy

1. **AWS**: credentials for the account (`aws configure` or SSO), AWS's `lightsailctl` plugin
   (`brew install aws/tap/lightsailctl`), and Docker running (SST builds the image). On an
   Apple-silicon Mac, run `scripts/rosetta-builder.sh` once and deploy with `BUILDX_BUILDER=a6g-rosetta`: the default
   builder emulates amd64 with QEMU, where `next build` hangs.
2. **MongoDB Atlas**: a database user for the app alone (below), and its `mongodb+srv://` connection string. Put the
   cluster in the same place as the app (an AWS cluster in `A6G_WEB_REGION`): every page waits on several round trips
   to it, a millisecond each next door and tens of milliseconds across a continent or between clouds.
3. **Email (Amazon SES)**: once per domain, not per stage, make the sender's domain an SES sender: with its Route 53
   zone in the account, `AWS_REGION=us-east-2 scripts/ses-domain.sh anythingfactory.dev` adds the SES identity with DKIM,
   its own MAIL FROM (`mail.<domain>`, for SPF) and a DMARC policy, so mail from it is signed, authorised and not spam.
   Each stage then sends from `A6G_WEB_SENDER` (`no-reply@anythingfactory.dev`) with an IAM user's key that may send from
   that address alone. Until the account has SES production access (asked for in the SES console), SES sends only to
   verified addresses, 200 a day: verify each person's address in SES meanwhile. Sign-in links, invitations and
   new-address confirmations all go by email; the first admin can't get in without them.
4. **The domain**: pick it now (`A6G_WEB_DOMAIN`, in a Route 53 hosted zone of the account). Passkeys belong to the
   domain they were made on, so moving later means everyone adds theirs again. Without one the app is on CloudFront's
   `*.cloudfront.net` address. A domain the app moved off is retired with
   `AWS_REGION=us-east-2 scripts/retire-domain.sh a6gfactory.dev anythingfactory.dev`: each of its names redirects to
   the same name on the new one, and once no stage serves on it (run it again after the last `sst remove`) its SES
   identity goes and its DNS says it sends no mail, so nobody can send as it. Keep it registered while anything may
   still point at it.
5. **The secrets**, per stage (SST keeps them encrypted in the account; never in the repository):

   ```sh
   cd web
   npx sst secret set MongodbUri --stage production < connection-string.txt   # or the value as an argument
   openssl rand -base64 32 | npx sst secret set BetterAuthSecret --stage production
   ```

6. **The indexes**, made once with an operator's database user (the app's own may not make any on the audit log):
   `npm run create-indexes` with that user's `MONGODB_URI` and the stage's `AUTH_DATABASE` in the environment.

### Deploying

```sh
cd web
A6G_WEB_SENDER=no-reply@anythingfactory.dev A6G_WEB_DOMAIN=app.anythingfactory.dev npx sst deploy --stage production
```

It prints the app's `url` and Lightsail's `origin`. Then make the first admin (above) against the production database
and sign in. A later deploy builds the image again and moves Lightsail to the new digest; the origin secret, the
certificate and the distribution stay. `A6G_WEB_REGION` (`us-east-2`, where the account's organization allows Lightsail, SSM and ECR), `A6G_WEB_POWER` (`micro`) and
`A6G_WEB_SCALE` (1) change where and how big it runs. The production stage is protected and retained: removing it
takes an explicit change.

Things to know:

- **Lightsail keeps a deployment's environment in the deployment**, readable by anyone with Lightsail access to the
  account: the connection string, the auth secret and the mailer's key included. Give that access to the operators only.
- **Lightsail's own address** (`*.cs.amazonlightsail.com`) answers anyone, but the app refuses every request there
  without CloudFront's secret, except `/api/health` (which says `ok` and nothing else).
- **Server actions** compare the browser's Origin with the public host CloudFront passes in `x-forwarded-host`. If a
  setup in front ever drops that header, list the public host in `SERVER_ACTIONS_ORIGINS` at build (the image build
  sets it to `A6G_WEB_DOMAIN`).

### Atlas

1. **A database user for the app alone**, with a custom role that gives only what it needs (Database Access → Custom
   Roles). On the task graphs' database (`a6g`):
   - `find` on the whole database;
   - `insert` on `requests` (the app only adds them; the planner changes them, through the factory's commands);
   - `insert` and `update` on `stakeholders` (linking a person's account) and `counters` (new ids come from them);
   - `insert` and `update` on `tasks` (an admin's tasks and members' suggestions, through the factory's `addTask`, and
     decisions; the app's code changes only a task's status, approval and notes, through the factory's move table).
     MongoDB can't scope a role to fields, so whoever holds this user's password can add and rewrite any team's tasks,
     which agents then act on: keep it only in the deployment's environment, and rotate it if it leaks;
   - `insert` on `controls` (an admin's pause, resume or budget, a change to the working agreement, and a review of
     what the team decided: the app only adds them, never changes one, so they're also the record; the watchdog
     applies them). An agreement's standing instructions reach the planner as the operator's words, so, as with
     tasks, whoever holds this user's password could write some: the same care. The decision log needs no grant of
     its own: the app reads `decisions` under the database's `find`, and never writes there (the planner records a
     decision, and the watchdog writes a review onto it);
   - `createIndex` on `tasks`, `requests`, `stakeholders`, `cycles` and `controls` (the store asks for its index;
     refused, it carries on).

   On the accounts database (`a6g_web`): `find`, `insert`, `update` and `remove` on each of Better Auth's collections
   and the app's own (`user`, `session`, `account`, `verification`, `twoFactor`, `passkey`, `rateLimit`, `memberships`,
   `request_counts`, `magic_link_sends`, `known_ips`, `ip_challenges`, `code_attempts`, the linked machines'
   `machine_links` and `machines`, and the notifier's `notification_prefs`, `notification_queue`, `notification_tests`
   and `notifier`), and only `find` and `insert` on `audit`, so the app can't change or delete what it recorded, nor add
   an index that would expire it early (MongoDB's own expiry still removes old events). The indexes are an operator's to
   make (`npm run create-indexes`); the app tries its own too and carries on when refused. Nothing else: no `remove` on
   `a6g`, nothing on other databases, no admin roles. Give it a long random password.

2. **Network access**: Lightsail containers have no fixed outbound address, so allow `0.0.0.0/0`, and let the narrow
   role, the long password and TLS (always on with Atlas) carry the protection.
3. The connection string is the cluster's `mongodb+srv://` one with this user: the `MongodbUri` secret.

`next.config.ts` sets `turbopack.root` and `outputFileTracingRoot` to the repository, so the factory's files compile
and nothing outside `web/` is traced into the standalone server. Passkeys are bound to `BETTER_AUTH_URL`'s host:
changing the domain means adding passkeys again.

## The code

- `server/access.ts`: who may see and do what (pure).
- `server/auth.ts`: Better Auth: plugins, the second-factor rule, the HTTP guard, emails.
- `server/viewer.ts`: the signed-in person, their roles and second factor, for pages and actions.
- `server/factory.ts`: the bridge to `../lib/tasks` (`storeOver` over the app's MongoClient, `addRequest`,
  `stakeholderFor`, `addTask`, `decide`); `server/views.ts`: what the pages work out from a graph (progress, journeys,
  merges, proposals, the board's lanes).
- `server/inbox.ts`: what waits on the operator, from a team's graph: the questions and blocked work, the options and
  recommendation read out of each, what's answered and what was settled (pure).
- `server/decided.ts`: what the Decided for you and Agreement pages show, from a team's decision log and the
  operator's controls: what's to review, what stands, what was overturned, each topic as the agreement has it, the
  agreement's versions, a hint in the form's words, and the form's fields for how often a message may go (pure). The
  rules themselves (the levels' tables, what a review may follow, what makes a hint) are the factory's, in
  `../lib/tasks/agreement.ts` and `decisions.ts`.
- `server/events.ts`, `server/notifications.ts`, `server/notifier.ts`, `instrumentation.ts`: notifications. The events
  are worked out from each team's history and its decision log, never stored (pure); a person's settings and the emails' words; and the
  notifier, which the server starts (`instrumentation.ts`) and which runs every `NOTIFY_EVERY_SECONDS` under a lease in
  the accounts database, so one container sends. It queues an email per person and event (`notification_queue`, its id
  the person and the event, so each goes once, kept 30 days), sends what goes at once in one email per person a run,
  and each digest once its hour has come. A team it sees for the first time has no news; a person hears only of what
  they could open in the app (`access.ts`), and of a request only when it's theirs.
- `server/origin.ts`: who a task came from, as the person looking may read it, the same on every page.
- `server/auth-indexes.ts`: the indexes Better Auth's MongoDB adapter doesn't make (sessions by token, people by
  address, passkeys by credential, rate limits by key) and expiry for old sessions and verifications.
- `server/code-attempts.ts`: five authenticator or backup codes per person in 15 minutes, counted before each is
  checked; `scripts/create-indexes.ts`: the app's indexes, made by an operator.
- `server/audit.ts`: the audit log; `server/known-ips.ts`: confirmed addresses and the emails that confirm new ones;
  `server/origin-check.ts`: the CDN's secret; `server/device.ts`: a browser's name from its user agent.
- `server/mail.ts`: sending, and how an email looks. The text part is whole. The HTML part is a heading, a line or
  two, one button on the email's link and a line of small print where the sender gives them (sign-up, sign-in,
  invitations, new addresses); no address is spelled out, so nobody is shown a link hundreds of characters long.
  Other emails show their text, each address a link under a short name.
- `server/people.ts`: memberships, stakeholder links, the daily limit on requests and suggestions. `server/bootstrap.ts`: create-admin.
- `server/account-choices.ts`: the two choices made at sign-up, and whether an account has a password.
- `server/password-reset.ts`: a new password from an emailed link, and the authenticator's code it takes for an
  account that has one; `server/totp.ts`: an authenticator's codes, made and checked.
- `components/level-graph.tsx`: the graph by level in BetterDiagrams' editor, in the browser only, with the journey and
  no-journey kinds registered and the level kept in the address.
- `server/machines.ts`: linked machines, their codes and reports; `server/machine-api.ts`: what the machines'
  endpoints (`app/api/machines/`) share: no caching, OAuth's errors, bodies read up to a size, the bearer's machine.
- `app/`: the pages; `app/t/[team]/actions.ts`, `app/admin/people/actions.ts`, `app/account/actions.ts`,
  `app/welcome/actions.ts`, `app/machines/actions.ts`: every write a person makes.
- `proxy.ts`: requests without the CDN's secret refused, a nonce-based Content Security Policy, and anyone without a
  session cookie off to sign in.
- `sst.config.ts`, `Dockerfile`: the deployment (Lightsail behind CloudFront); `tsconfig.infra.json` checks it.

The app imports only `model`, `store` (for `update`), `mongo`, `requests`, `decide`, `answer`, `add`, `teams`, `graph`
and `controls` from `lib/tasks`, and `lib/fleet.ts` (machines' reports and the link's protocol); never the file store,
the Keychain, migrations or `lib/tasks/machines.ts`, and it never calls `openStore`
(`tests/unit/boundaries.test.ts` keeps it so).
