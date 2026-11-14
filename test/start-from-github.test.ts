// Starting a project from a GitHub repository, and the settings an ask may carry (docs/plans/start-from-github.md):
// the ask's checks, the machine's GitHub account, what it refuses, each way the repository step goes, and init's rules
// from the form. gh and the factory's own commands are stand-ins; git runs for real.
import { a6g, gitRepo, machine, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { carryOut, type Sh } from "../lib/commands/projects.ts";
import { parseReport } from "../lib/fleet.ts";
import { githubAccount, refusalOf } from "../lib/orders.ts";
import { agreementOf, holdOf, startControl, startOf } from "../lib/tasks/controls.ts";
import { storeOver } from "../lib/tasks/mongo.ts";
import { githubRepoOf, newerAsk, type StartAsk, startFrom } from "../lib/tasks/start.ts";
import { fakeMongo } from "./fake-mongo.ts";

const A6G_HOME = process.env.A6G_HOME ?? "";
const MACHINE = "m0123456789abcdef01234567";
const ask = (fields: Partial<StartAsk> = {}): StartAsk => ({
  machine: MACHINE,
  machineName: "studio",
  title: "Hello",
  repo: { github: "octocat/hello" },
  goal: "Make it say hello in French too.",
  technical: true,
  limits: null,
  use: [],
  ...fields,
});
for (const [key, value] of Object.entries({
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.com",
}))
  process.env[key] = value;
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

describe("an ask from GitHub, and the settings it may carry", () => {
  test("names a GitHub repository by owner/name or its address, and checks each setting", () => {
    const made = startFrom({
      ...ask(),
      repo: { github: "https://github.com/octocat/Hello.git" },
      trusted: true,
      base: "develop",
      mode: "cycles",
      approval: "thresholds",
      push: "pull-request",
      level: "hands-off",
      hold: true,
    });
    assert.ok(!("problem" in made), JSON.stringify(made));
    assert.deepEqual(made.repo, { github: "octocat/Hello" });
    assert.deepEqual(
      [made.trusted, made.base, made.mode, made.approval, made.push, made.level, made.hold],
      [true, "develop", "cycles", "thresholds", "pull-request", "hands-off", true]
    );
    assert.ok(newerAsk(made));
    const before = startFrom({ ...ask(), repo: { create: "hello" } });
    assert.ok(!("problem" in before) && !newerAsk(before), "an ask with none of them reads as one did before");
    const problem = (fields: Record<string, unknown>) => {
      const m = startFrom({ ...ask(), ...fields });
      return "problem" in m ? m.problem : "";
    };
    assert.match(problem({ repo: { github: "gitlab.com/a/b" } }), /owner\/name/);
    assert.match(problem({ repo: { github: "a/b", create: "b" } }), /Choose a repository/);
    assert.match(problem({ repo: { existing: "hello", publish: "private" } }), /private or public/);
    assert.match(problem({ repo: { create: "hello", publish: "secret" } }), /private or public/);
    assert.match(problem({ base: "-x" }), /branch's name/);
    assert.match(problem({ base: "a..b" }), /branch's name/);
    assert.match(problem({ mode: "forever" }), /finish line/);
    assert.match(problem({ approval: "nobody" }), /approves/);
    assert.match(problem({ push: "force" }), /on GitHub/);
    assert.match(problem({ level: "loud" }), /readily/);
    assert.match(problem({ hold: "yes" }), /starts/);
    assert.equal(githubRepoOf("git@github.com:octocat/hello.git")?.full, "octocat/hello");
    assert.equal(githubRepoOf("https://github.com/octocat/hello/")?.full, "octocat/hello");
    assert.equal(githubRepoOf("https://example.com/octocat/hello"), null);
  });

  test("the machine's GitHub account goes with its report, asked of GitHub at most hourly", () => {
    rmSync(join(A6G_HOME, "orders", "github.json"), { force: true });
    let asked = 0;
    const now = Date.parse("2026-11-13T12:00:00Z");
    const min = 60_000;
    assert.equal(
      githubAccount(now, () => (asked++, "octocat")),
      "octocat"
    );
    assert.equal(
      githubAccount(now + 30 * min, () => (asked++, "other")),
      "octocat"
    );
    assert.equal(asked, 1);
    // An hour on GitHub doesn't answer: the account it had stands, and it's asked again only after ten minutes.
    assert.equal(
      githubAccount(now + 61 * min, () => (asked++, undefined)),
      "octocat"
    );
    assert.equal(
      githubAccount(now + 65 * min, () => (asked++, "x")),
      "octocat"
    );
    assert.equal(asked, 2);
    // Signed out: none.
    assert.equal(
      githubAccount(now + 72 * min, () => (asked++, null)),
      null
    );
    const projects = { dir: "~/code", repos: [], subscriptions: [] };
    assert.equal(parseReport({ name: "studio", factory: "0.8.2", teams: [], projects: { ...projects, github: "octocat" } })?.projects?.github, "octocat");
    assert.equal(parseReport({ name: "studio", factory: "0.8.2", teams: [], projects: { ...projects, github: null } })?.projects?.github, null);
    assert.equal(parseReport({ name: "studio", factory: "0.8.2", teams: [], projects: { ...projects, github: "not a login!" } }), null);
    assert.equal(
      parseReport({ name: "studio", factory: "0.8.1", teams: [], projects })?.projects?.github,
      undefined,
      "an older machine's report has no such key"
    );
  });
});

describe("a machine takes an ask from GitHub", () => {
  function setting() {
    const dir = tmp("a6g-projects-");
    write(A6G_HOME, {
      "app.json": { url: "https://app.example.test", machine: { id: MACHINE, name: "studio" }, linkedAt: new Date().toISOString(), projects: { dir } },
      "machine.json": { name: "studio" },
    });
    return { dir, machine: { id: MACHINE, name: "studio" } };
  }
  const me = () => "octocat";

  test("refuses one without a GitHub account here, and someone else's code without the tick", () => {
    const s = setting();
    assert.match(refusalOf(ask(), "hello", s, () => null) ?? "", /isn't signed in to GitHub: run gh auth login there, then ask again/);
    assert.equal(refusalOf(ask(), "hello", s, me), null, "its own");
    assert.match(
      refusalOf(ask({ repo: { github: "someone/hello" } }), "hello", s, me) ?? "",
      /someone\/hello isn't octocat's: ask again, ticking that you trust its code to run on studio/
    );
    assert.equal(refusalOf(ask({ repo: { github: "someone/hello" }, trusted: true }), "hello", s, me), null);
    assert.match(refusalOf(ask({ repo: { create: "hello", publish: "private" } }), "hello", s, () => null) ?? "", /signed in to GitHub/);
  });

  // gh as GitHub would answer it for octocat: `repos` the repositories it sees, with whether it can push (and, for one
  // that moved, the name GitHub answers with); a clone made as a real repository (with origin), failing its first
  // `cloneFails` tries; and a6g register failing its first `registerFails`.
  function world(repos: Record<string, { push: boolean; now?: string }>, { cloneFails = 0, registerFails = 0 } = {}) {
    const s = setting();
    const ran: string[] = [];
    const gh: string[] = [];
    let fails = cloneFails;
    let registers = registerFails;
    let waited = 0;
    const store = storeOver(fakeMongo(), { name: "hello", tasks: { store: "mongo", database: "a6g", lead: null } });
    // When each of the factory's commands ran.
    const ranAt: Record<string, string> = {};
    const sh: Sh = (command, args, { cwd }) => {
      if (command === "git") {
        const done = git(cwd, ...args);
        return { code: done.status ?? 1, out: `${done.stdout}${done.stderr}` };
      }
      if (command === "gh") {
        gh.push(args.join(" "));
        const [verb, ...rest] = args;
        if (verb === "api" && rest[0] === "-X") {
          const parent = rest[2]?.replace(/^repos\//, "").replace(/\/forks$/, "") ?? "";
          return { code: 0, out: JSON.stringify({ full_name: `octocat/${parent.split("/")[1]}` }) };
        }
        if (verb === "api") {
          const full = rest[0]?.replace(/^repos\//, "") ?? "";
          const seen = repos[full];
          return seen
            ? { code: 0, out: JSON.stringify({ full_name: seen.now ?? full, archived: false, permissions: { push: seen.push } }) }
            : { code: 1, out: "gh: Not Found (HTTP 404)" };
        }
        if (verb === "repo" && rest[0] === "clone") {
          if (fails-- > 0) return { code: 1, out: "remote: Repository not found." };
          const [, source = "", target = ""] = rest;
          gitRepo(target, { "README.md": `# ${source}\n` });
          git(target, "branch", "develop");
          git(target, "remote", "add", "origin", `https://github.com/${source}.git`);
          return { code: 0, out: "" };
        }
        if (verb === "repo" && rest[0] === "create") {
          git(cwd, "remote", "add", "origin", `https://github.com/octocat/${rest[1]}.git`);
          return { code: 0, out: "" };
        }
        return { code: 0, out: "" };
      }
      // The factory's own commands, recorded, with when each ran.
      const line = args.slice(1).join(" ");
      ran.push(line);
      ranAt[line.split(" ")[0] ?? ""] = new Date().toISOString();
      if (line.startsWith("register") && registers-- > 0) return { code: 1, out: "T3 Code isn't answering" };
      return { code: 0, out: "" };
    };
    return {
      s,
      store,
      ran,
      gh,
      ranAt,
      waited: () => waited,
      deps: { store, setting: s, sh, setup: () => ({ code: 0, out: "done" }), github: me, wait: () => void waited++ },
    };
  }
  const state = async (store: ReturnType<typeof storeOver>) => startOf(await store.controls.all()) as NonNullable<ReturnType<typeof startOf>>;
  const steps = async (store: ReturnType<typeof storeOver>) =>
    (await store.controls.all()).filter((c) => c.kind === "starting").map((c) => c.starting?.step);

  test("clones one its account can push to, drafts with the rules chosen, records the agreement, and waits as asked", async () => {
    const w = world({ "octocat/hello": { push: true } });
    const asked = ask({ base: "develop", mode: "cycles", approval: "thresholds", push: "pull-request", level: "hands-off", hold: true });
    await w.store.controls.create(startControl("hello", "web:s1", asked));
    assert.equal(await carryOut("hello", await state(w.store), w.deps), true);
    assert.deepEqual(await steps(w.store), ["repository", "draft", "setup", "check", "register", "started"]);
    const done = await state(w.store);
    assert.deepEqual(done.notes, [
      "Cloned octocat/hello: octocat can push to it.",
      "Set up, and waiting for you: resume it from its overview when you're ready.",
    ]);
    assert.deepEqual(w.gh.slice(0, 2), ["api repos/octocat/hello", `repo clone octocat/hello ${join(w.s.dir, "hello")} -- --quiet`]);
    assert.ok(!w.gh.some((line) => line.includes("forks")), "nothing forked");
    assert.match(w.ran[0] ?? "", / --base develop --mode cycles --approval thresholds --push pull-request$/);
    const all = await w.store.controls.all();
    const hold = holdOf(all);
    assert.deepEqual([hold?.scope, hold?.by], ["now", "web:s1"]);
    assert.equal(agreementOf(all).agreement.level, "hands-off");
    assert.equal(agreementOf(all).control?.by, "web:s1");
    // The pause was there before the team was registered.
    const paused = all.find((c) => c.kind === "pause")?.at ?? "";
    assert.ok(paused && paused <= (w.ranAt["register"] ?? ""), `${paused} before ${w.ranAt["register"]}`);
  });

  test("forks one its account can only read, clones the fork once GitHub has made it, and keeps gh on the fork", async () => {
    const w = world({ "someone/hello": { push: false } }, { cloneFails: 2 });
    await w.store.controls.create(startControl("hello", "web:s1", ask({ repo: { github: "someone/hello" }, trusted: true })));
    assert.equal(await carryOut("hello", await state(w.store), w.deps), true);
    assert.deepEqual((await state(w.store)).notes, [
      "Forked someone/hello to octocat/hello: octocat can't push to the original. Its pull requests go to the fork.",
    ]);
    assert.equal(w.waited(), 2, "waited for GitHub between tries");
    assert.ok(w.gh.includes("api -X POST repos/someone/hello/forks -F default_branch_only=true"));
    assert.ok(w.gh.includes("repo set-default octocat/hello"));
    assert.match(git(join(w.s.dir, "hello"), "remote", "get-url", "origin").stdout, /github\.com\/octocat\/hello\.git/);
  });

  test("says what stopped it: a repository its account can't see, and a base the repository doesn't have", async () => {
    const hidden = world({});
    await hidden.store.controls.create(startControl("hello", "web:s1", ask({ repo: { github: "someone/secret" }, trusted: true })));
    assert.equal(await carryOut("hello", await state(hidden.store), hidden.deps), false);
    const stopped = await state(hidden.store);
    assert.deepEqual([stopped.step, stopped.stoppedAt], ["failed", "repository"]);
    assert.equal(stopped.problem, "GitHub says octocat can't see someone/secret.");
    assert.match(stopped.said ?? "", /Not Found/);
    assert.match(stopped.fix ?? "", /ask its owner to give octocat access/);

    const nobase = world({ "octocat/hello": { push: true } });
    await nobase.store.controls.create(startControl("hello", "web:s1", ask({ base: "release" })));
    assert.equal(await carryOut("hello", await state(nobase.store), nobase.deps), false);
    const missing = await state(nobase.store);
    assert.equal(missing.stoppedAt, "repository");
    assert.match(missing.problem ?? "", /has no branch release\.$/);
  });

  test("makes a new repository on GitHub too, and won't promise pull requests where origin isn't GitHub", async () => {
    const made = world({});
    await made.store.controls.create(
      startControl("hello", "web:s1", ask({ title: "Hello two", repo: { create: "hello-two", publish: "private" }, push: "pull-request" }))
    );
    assert.equal(await carryOut("hello", await state(made.store), made.deps), true);
    const repo = join(made.s.dir, "hello-two");
    assert.ok(made.gh.includes(`repo create hello-two --private --source ${repo} --remote origin --push`));
    assert.deepEqual((await state(made.store)).notes, ["Made octocat/hello-two on GitHub (private), and pushed it."]);
    assert.match(readFileSync(join(repo, "README.md"), "utf8"), /^# Hello two/);

    const elsewhere = world({});
    gitRepo(join(elsewhere.s.dir, "shop"), { "README.md": "shop" });
    git(join(elsewhere.s.dir, "shop"), "remote", "add", "origin", "https://gitlab.example/team/shop.git");
    await elsewhere.store.controls.create(startControl("hello", "web:s1", ask({ repo: { existing: "shop" }, push: "pull-request" })));
    assert.equal(await carryOut("hello", await state(elsewhere.store), elsewhere.deps), false);
    const refused = await state(elsewhere.store);
    assert.match(refused.problem ?? "", /origin isn't on GitHub, where the team opens its pull requests/);
    assert.doesNotMatch(JSON.stringify(refused), /gitlab\.example/, "origin's address isn't shown: it may hold a token");
  });

  test("an ask made again runs on its own rules, not the first try's", async () => {
    const w = world({ "octocat/hello": { push: true } });
    await w.store.controls.create(startControl("hello", "web:s1", ask({ push: "pull-request", mode: "cycles", approval: "thresholds" })));
    const stops = { ...w.deps, setup: () => ({ code: 0, out: "Needs the operator: a key" }) };
    assert.equal(await carryOut("hello", await state(w.store), stops), false);
    // The first try's draft, as init would have left it.
    const checkout = join(w.s.dir, "hello-a6g");
    write(join(checkout, ".a6g"), {
      "team.json": {
        name: "hello",
        branch: "a6g/next",
        mode: "cycles",
        approval: { mode: "thresholds", maxSize: "M" },
        roles: { approver: {} },
        push: { remote: "origin", branch: "a6g/next", every: "6h", pullRequest: true },
      },
      "brief.md": "# Hello\n\n## What should exist when the team is done\n\nOld.\n",
    });
    await w.store.controls.create(startControl("hello", "web:s1", ask({ push: "none", mode: "finish", approval: "operator", goal: "New." })));
    assert.equal(await carryOut("hello", await state(w.store), w.deps), true);
    const team = JSON.parse(readFileSync(join(checkout, ".a6g", "team.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual([team["push"], team["mode"], (team["approval"] as { mode: string }).mode], [null, "finish", "operator"]);
    assert.match(readFileSync(join(checkout, ".a6g", "brief.md"), "utf8"), /done\n\nNew\.\n/);
  });

  test("a fork for an ask with a base has every branch; and a wait from a try that failed doesn't outlast an ask to start", async () => {
    const forking = world({ "someone/hello": { push: false } });
    await forking.store.controls.create(startControl("hello", "web:s1", ask({ repo: { github: "someone/hello" }, trusted: true, base: "develop" })));
    assert.equal(await carryOut("hello", await state(forking.store), forking.deps), true);
    assert.ok(forking.gh.includes("api -X POST repos/someone/hello/forks"), forking.gh.join("\n"));

    const w = world({ "octocat/hello": { push: true } }, { registerFails: 1 });
    await w.store.controls.create(startControl("hello", "web:s1", ask({ hold: true })));
    assert.equal(await carryOut("hello", await state(w.store), w.deps), false);
    assert.equal(holdOf(await w.store.controls.all())?.scope, "now", "waiting, as the first ask said");
    await w.store.controls.create(startControl("hello", "web:s1", ask()));
    assert.equal(await carryOut("hello", await state(w.store), w.deps), true);
    assert.equal(holdOf(await w.store.controls.all()), null, "lifted: this ask starts it");
  });

  test("a clone a try left is used again only for the same repository; a moved one asks for the tick again", async () => {
    const w = world({ "octocat/hello": { push: true }, "someone/hello": { push: true } });
    await w.store.controls.create(startControl("hello", "web:s1", ask()));
    assert.equal(await carryOut("hello", await state(w.store), { ...w.deps, setup: () => ({ code: 1, out: "stopped" }) }), false);
    await w.store.controls.create(startControl("hello", "web:s1", ask({ repo: { github: "someone/hello" }, trusted: true })));
    assert.equal(await carryOut("hello", await state(w.store), w.deps), false);
    assert.match((await state(w.store)).problem ?? "", /holds another repository than someone\/hello\.$/);

    const moved = world({ "octocat/app": { push: true, now: "acme/app" } });
    await moved.store.controls.create(startControl("hello", "web:s1", ask({ repo: { github: "octocat/app" } })));
    assert.equal(await carryOut("hello", await state(moved.store), moved.deps), false);
    assert.equal((await state(moved.store)).problem, "GitHub says that's acme/app now, which isn't octocat's.");
  });
});

describe("what the review found, fixed", () => {
  test("a token in what a command said never reaches the site", async () => {
    const { tail } = await import("../lib/commands/projects.ts");
    assert.equal(tail("fatal: https://x-access-token:ghs_secret@github.com/o/r.git not found"), "fatal: https://github.com/o/r.git not found");
  });

  test("an account that isn't there is asked about again after five minutes, not an hour", () => {
    rmSync(join(A6G_HOME, "orders", "github.json"), { force: true });
    const now = Date.parse("2026-11-14T12:00:00Z");
    let asked = 0;
    assert.equal(
      githubAccount(now, () => (asked++, null)),
      null
    );
    assert.equal(
      githubAccount(now + 4 * 60_000, () => (asked++, "octocat")),
      null
    );
    assert.equal(
      githubAccount(now + 6 * 60_000, () => (asked++, "octocat")),
      "octocat"
    );
    assert.equal(asked, 2);
  });
});

describe("a6g init's rules from the form", () => {
  test("its aim, who approves (with the approver thresholds need), and what it pushes, kept in team.json", async () => {
    const m = machine();
    const repo = gitRepo(join(tmp("a6g-init-"), "shop"), {
      "package.json": { name: "shop", scripts: { test: "node --test" } },
      "package-lock.json": "{}\n",
    });
    const refused = await a6g(["init", repo, "--no-interview", "--push", "branch"], { cwd: repo, env: m.env });
    assert.equal(refused.code, 2);
    assert.match(refused.out, /has no origin remote for the team to push to/);
    git(repo, "remote", "add", "origin", "https://github.com/octocat/shop.git");
    const made = await a6g(["init", repo, "--no-interview", "--mode", "cycles", "--approval", "thresholds", "--push", "pull-request"], {
      cwd: repo,
      env: m.env,
    });
    assert.equal(made.code, 0, made.out);
    const team = JSON.parse(readFileSync(join(`${repo}-a6g`, ".a6g", "team.json"), "utf8")) as Record<string, unknown> & {
      roles: Record<string, unknown>;
    };
    assert.equal(team["mode"], "cycles");
    assert.deepEqual(team["approval"], { mode: "thresholds", maxSize: "M" });
    assert.ok("approver" in team.roles);
    assert.deepEqual(team["push"], { remote: "origin", branch: "a6g/next", every: "6h", pullRequest: true });
    const wrong = await a6g(["init", repo, "--no-interview", "--mode", "forever"], { cwd: repo, env: m.env });
    assert.match(wrong.out, /--mode forever: finish \(to a finish line\) or cycles/);
  });
});
