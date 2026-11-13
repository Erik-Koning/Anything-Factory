// Running the factory from the web app (docs/plans/run-from-the-site.md): the controls that choose a team's
// subscriptions and ask for a new team, what a machine offers and how it takes an ask, and init's options for one.
import { a6g, fakeKeychain, gitRepo, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { saveLink, setProjects } from "../lib/app.ts";
import { type Sh, carryOut, tail } from "../lib/commands/projects.ts";
import { TEAM_NAME } from "../lib/config.ts";
import { parseReport } from "../lib/fleet.ts";
import { guardedFolder, keepOrderPid, machineProjects, offeredRepos, projectsSetting, refusalOf, takeOrders } from "../lib/orders.ts";
import { SUBSCRIPTION_NAME, teamUses } from "../lib/subscriptions.ts";
import { applySubscriptionControls, subscriptionsView } from "../lib/steer.ts";
import { type Control, limitsOf, startControl, startingControl, startOf, subscriptionsControl } from "../lib/tasks/controls.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { storeOver } from "../lib/tasks/mongo.ts";
import { START_SUBSCRIPTION, START_TEAM, type StartAsk, slugOf, startFrom } from "../lib/tasks/start.ts";
import { instance } from "../lib/t3.ts";
import { fakeMongo } from "./fake-mongo.ts";

const A6G_HOME = process.env.A6G_HOME ?? "";
const MACHINE = "m0123456789abcdef01234567";
const ask = (fields: Partial<StartAsk> = {}): StartAsk => ({
  machine: MACHINE,
  machineName: "studio",
  title: "Shop two",
  repo: { create: "shop-two" },
  goal: "A shop that takes orders.\n\nIt ships to Canada.",
  technical: true,
  limits: null,
  use: [],
  ...fields,
});
const mongoTeam = (name: string) => ({ name, tasks: { store: "mongo" as const, database: "a6g", lead: null } });

describe("an ask to start a team", () => {
  test("is rebuilt from the fields it may have; anything wrong is said in words", () => {
    assert.deepEqual(startFrom({ ...ask(), extra: "dropped", use: ["default", "default", "two"] }), ask({ use: ["default", "two"] }));
    const budget = startFrom(ask({ limits: { daily: 20, weekly: null, total: 100, unit: "usd", since: "2026-11-01T00:00:00.000Z", autoResume: true } }));
    assert.ok(!("problem" in budget));
    assert.deepEqual(budget.limits, { daily: 20, weekly: null, total: 100, unit: "usd", since: "2026-11-01T00:00:00.000Z", autoResume: true });
    // A form's line endings become plain new lines.
    assert.equal((startFrom(ask({ goal: "One.\r\n\r\nTwo.\r\n" })) as StartAsk).goal, "One.\n\nTwo.");
    // A budget of nothing is no budget.
    assert.equal((startFrom({ ...ask(), limits: { daily: null, weekly: null, total: null } }) as StartAsk).limits, null);
    const problem = (fields: Record<string, unknown>): string => {
      const made = startFrom({ ...ask(), ...fields });
      return "problem" in made ? made.problem : "";
    };
    assert.match(problem({ machine: "studio" }), /Choose the Mac/);
    assert.match(problem({ title: "  " }), /title/);
    assert.match(problem({ title: "two\nlines" }), /one line/);
    assert.match(problem({ repo: { existing: "../etc" } }), /repository's folder/);
    assert.match(problem({ repo: { existing: ".hidden" } }), /repository's folder/);
    assert.match(problem({ repo: { existing: "a", create: "b" } }), /repository's folder/);
    assert.match(problem({ goal: "" }), /what should exist/);
    assert.match(problem({ goal: "x".repeat(4001) }), /4000/);
    assert.match(problem({ goal: "hidden‮text" }), /plain text/);
    assert.match(problem({ technical: "yes" }), /design/);
    assert.match(problem({ use: ["Not A Name"] }), /subscriptions/);
    assert.match(problem({ limits: { daily: -1 } }), /budget/);
    assert.match(String((startFrom("no") as { problem: string }).problem), /isn't an ask/);
  });

  test("a short name comes from the title, in the shape team.json takes", () => {
    assert.equal(slugOf("Shop redesign 2"), "shop-redesign-2");
    assert.equal(slugOf("2048!"), "team-2048");
    assert.equal(slugOf("Crème brûlée"), "creme-brulee");
    assert.equal(slugOf("!!!"), "");
    assert.ok(START_TEAM.test(slugOf("x".repeat(80))));
    // The web app's copies of the factory's own shapes.
    assert.equal(START_TEAM.source, TEAM_NAME.source);
    assert.equal(START_SUBSCRIPTION.source, SUBSCRIPTION_NAME.source);
  });

  test("stands where its machine last said: waiting, a step, withdrawn, or dropped after a day", () => {
    const at = (minutes: number) => new Date(Date.parse("2026-11-12T12:00:00Z") + minutes * 60_000).toISOString();
    const now = Date.parse(at(10));
    const doc = (id: string, fields: Omit<Control, "id" | "version">): Control => ({ ...fields, id, version: 1 });
    const asked = doc("k1", startControl("shop-two", "web:s1", ask(), at(0)));
    assert.equal(startOf([], now), null);
    assert.deepEqual([startOf([asked], now)?.step, startOf([asked], now)?.asked], ["waiting", at(0)]);
    const picked = doc("k2", startingControl("shop-two", "studio", { of: "k1", step: "setup", problem: null }, at(2)));
    assert.deepEqual([startOf([asked, picked], now)?.step, startOf([asked, picked], now)?.at], ["setup", at(2)]);
    const failed = doc("k3", startingControl("shop-two", "studio", { of: "k1", step: "failed", stoppedAt: "check", problem: "the gate failed" }, at(4)));
    const stopped = startOf([asked, picked, failed], now);
    assert.deepEqual([stopped?.step, stopped?.stoppedAt, stopped?.problem], ["failed", "check", "the gate failed"]);
    // Asked again: what the machine said of the first one says nothing of this one.
    const again = doc("k4", startControl("shop-two", "web:s1", ask({ title: "Shop two, again" }), at(6)));
    assert.deepEqual(
      [startOf([asked, picked, failed, again], now)?.step, startOf([asked, picked, failed, again], now)?.ask.title],
      ["waiting", "Shop two, again"]
    );
    assert.equal(startOf([asked, doc("k2", startControl("shop-two", "web:s1", null, at(1)))], now), null, "withdrawn");
    assert.equal(startOf([asked], now + 25 * 3_600_000)?.step, "expired");
    assert.equal(startOf([asked, picked], now + 25 * 3_600_000)?.step, "setup", "one that was picked up isn't dropped");
  });
});

describe("what a machine offers to start", () => {
  test("a report carries it only when it's whole; one without it is as before", () => {
    const report = { name: "studio", factory: "0.8.0", teams: [] };
    assert.deepEqual(parseReport(report), report);
    const projects = {
      dir: "~/code",
      repos: ["shop", "blog.site"],
      subscriptions: [
        { name: "default", percent: 41 },
        { name: "two", percent: null },
      ],
    };
    assert.deepEqual(parseReport({ ...report, projects: { ...projects, extra: 1 } }), { ...report, projects });
    // Null is said: a machine whose version starts projects, and whose operator hasn't said it may.
    assert.deepEqual(parseReport({ ...report, projects: null }), { ...report, projects: null });
    for (const wrong of [
      { ...projects, dir: "code" },
      { ...projects, repos: ["../up"] },
      { ...projects, repos: Array.from({ length: 201 }, (_, i) => `r${i}`) },
      { ...projects, subscriptions: [{ name: "Two", percent: 1 }] },
      { ...projects, subscriptions: [{ name: "two", percent: "half" }] },
      "yes",
    ])
      assert.equal(parseReport({ ...report, projects: wrong }), null);
  });

  test("the repositories directly in its folder that no team uses, and its subscriptions; nothing until its operator says so", () => {
    const dir = tmp("a6g-projects-");
    gitRepo(join(dir, "shop"), { "README.md": "shop" });
    gitRepo(join(dir, "blog"), { "README.md": "blog" });
    mkdirSync(join(dir, "blog-a6g"));
    gitRepo(join(dir, "in-place"), { ".a6g/team.json": {} });
    gitRepo(join(dir, "not a name"), { "README.md": "x" });
    mkdirSync(join(dir, "plain-folder"));
    assert.deepEqual(offeredRepos(dir), ["shop"]);
    assert.deepEqual(offeredRepos(join(dir, "nowhere")), []);

    assert.equal(projectsSetting(), null);
    assert.equal(machineProjects(), null);
    assert.equal(setProjects(dir), false, "a machine that isn't linked can't be told to");
    write(A6G_HOME, { "app.json": { url: "https://app.example.test", machine: { id: MACHINE, name: "studio" }, linkedAt: new Date().toISOString() } });
    assert.equal(projectsSetting(), null);
    assert.equal(setProjects(dir), true);
    assert.deepEqual(projectsSetting(), { dir, machine: { id: MACHINE, name: "studio" } });
    assert.deepEqual(machineProjects(), { dir, repos: ["shop"], subscriptions: [{ name: "default", percent: null }] });
    assert.equal(setProjects(null), true);
    assert.equal(machineProjects(), null);
    assert.equal(guardedFolder(join(process.env.HOME ?? "", "Documents", "code")), "Documents");
    assert.equal(guardedFolder(join(process.env.HOME ?? "", "code")), null);
  });

  test("a6g connect app --projects: said at the machine's own terminal, for a folder the watchdog can read", async () => {
    fakeKeychain();
    const home = process.env.HOME ?? "";
    const dir = join(home, "code");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(home, "Documents", "code"), { recursive: true });
    write(A6G_HOME, { "machine.json": { name: "studio" } });
    assert.ok(
      saveLink("https://app.example.test", {
        access_token: `a6gm_${"a".repeat(43)}`,
        token_type: "Bearer",
        expires_in: 0,
        machine: { id: MACHINE, name: "studio" },
        account: "",
      })
    );
    const settings = () => JSON.parse(readFileSync(join(A6G_HOME, "app.json"), "utf8"));
    assert.equal(settings().projects, undefined);

    const on = await a6g(["connect", "app", "--projects", "~/code"]);
    assert.equal(on.code, 0, on.out);
    assert.match(on.out, /now starts the projects the web app asks for/);
    assert.match(on.out, /isn't connected to it yet: a6g connect mongo/);
    assert.equal(settings().projects.dir, dir);
    assert.match((await a6g(["connect"])).out, /starts the projects the web app asks for, in .*code/);
    assert.match((await a6g(["projects"])).out, /starts the projects https:\/\/app\.example\.test asks for, in ~\/code/);

    for (const [folder, why] of [
      ["~", /not the whole home folder/],
      ["~/Documents/code", /can't read ~\/Documents/],
      ["~/nowhere", /isn't a folder/],
    ] as const) {
      const refused = await a6g(["connect", "app", "--projects", folder]);
      assert.notEqual(refused.code, 0);
      assert.match(refused.out, why);
    }
    assert.notEqual((await a6g(["connect", "app", "--projects", "~/code", "--no-projects"])).code, 0);
    assert.equal(settings().projects.dir, dir, "a refusal changes nothing");

    const off = await a6g(["connect", "app", "--no-projects"]);
    assert.equal(off.code, 0, off.out);
    assert.equal(settings().projects, undefined);
    assert.match((await a6g(["projects"])).out, /starts no projects/);
    // A link made again to the same app keeps the folder; one to another app is asked anew.
    setProjects(dir);
    saveLink("https://app.example.test", {
      access_token: `a6gm_${"b".repeat(43)}`,
      token_type: "Bearer",
      expires_in: 0,
      machine: { id: MACHINE, name: "studio" },
      account: "",
    });
    assert.equal(settings().projects.dir, dir);
    saveLink("https://other.example.test", {
      access_token: `a6gm_${"c".repeat(43)}`,
      token_type: "Bearer",
      expires_in: 0,
      machine: { id: MACHINE, name: "studio" },
      account: "",
    });
    assert.equal(settings().projects, undefined);
  });
});

describe("a machine takes an ask", () => {
  // The folder and the link, for the tests below; each makes its own asks.
  function setting() {
    const dir = tmp("a6g-projects-");
    write(A6G_HOME, {
      "app.json": { url: "https://app.example.test", machine: { id: MACHINE, name: "studio" }, linkedAt: new Date().toISOString(), projects: { dir } },
      "machine.json": { name: "studio" },
    });
    return { dir, machine: { id: MACHINE, name: "studio" } };
  }
  const steps = async (store: ReturnType<typeof storeOver>) =>
    (await store.controls.all()).filter((c) => c.kind === "starting").map((c) => c.starting?.step);

  test("refuses in words what it won't start: a name taken, a repository that isn't its own, a subscription it lacks", () => {
    const s = setting();
    gitRepo(join(s.dir, "shop"), { "README.md": "shop" });
    assert.equal(refusalOf(ask(), "shop-two", s), null);
    assert.equal(refusalOf(ask({ repo: { existing: "shop" } }), "shop-two", s), null);
    assert.match(refusalOf(ask(), "Shop", s) ?? "", /isn't a team's name/);
    assert.match(refusalOf(ask({ repo: { create: "shop" } }), "shop-two", s) ?? "", /is there already/);
    assert.match(refusalOf(ask({ repo: { existing: "gone" } }), "shop-two", s) ?? "", /isn't on studio any more/);
    mkdirSync(join(s.dir, "plain"));
    assert.match(refusalOf(ask({ repo: { existing: "plain" } }), "shop-two", s) ?? "", /isn't a repository of its own/);
    spawnSync("ln", ["-s", tmp("a6g-outside-"), join(s.dir, "linked")]);
    assert.match(refusalOf(ask({ repo: { existing: "linked" } }), "shop-two", s) ?? "", /isn't a repository of its own/);
    mkdirSync(join(s.dir, "shop-a6g"));
    assert.match(refusalOf(ask({ repo: { existing: "shop" } }), "shop-two", s) ?? "", /a team's checkout is made beside/);
    assert.match(refusalOf(ask({ use: ["default", "two"] }), "shop-two", s) ?? "", /no subscription named two \(it has default\)/);
    write(join(A6G_HOME, "teams"), { "taken.json": { name: "taken", title: "Taken", home: "/nowhere", run: "/nowhere/run" } });
    assert.match(refusalOf(ask(), "taken", s) ?? "", /already runs a team named taken/);
  });

  test("at each full run: one ask picked up and started, the next waits; another machine's is left alone; a start that died is said", async () => {
    const s = setting();
    const client = fakeMongo();
    const launched: string[] = [];
    const told: string[] = [];
    const log: string[] = [];
    const run = (now?: number) =>
      takeOrders({
        client,
        log: (text) => log.push(text),
        launch: (team) => {
          launched.push(team);
          keepOrderPid(team, process.pid);
        },
        tell: (team, _ask, repo) => void told.push(`${team} on ${repo}`),
        ...(now === undefined ? {} : { now }),
      });
    const one = storeOver(client, mongoTeam("shop-two"));
    const two = storeOver(client, mongoTeam("site"));
    const theirs = storeOver(client, mongoTeam("elsewhere"));
    const bad = storeOver(client, mongoTeam("bad"));
    await one.controls.create(startControl("shop-two", "web:s1", ask()));
    await two.controls.create(startControl("site", "web:s1", ask({ title: "Site", repo: { create: "site" } })));
    await theirs.controls.create(startControl("elsewhere", "web:s2", ask({ machine: "mffffffffffffffffffffffff" })));
    await bad.controls.create(startControl("bad", "web:s1", ask({ repo: { existing: "gone" } })));

    await run();
    assert.deepEqual(launched, ["shop-two"]);
    assert.deepEqual(told, [`shop-two on ${join(s.dir, "shop-two")}`]);
    assert.deepEqual(await steps(one), ["picked-up"]);
    assert.deepEqual(await steps(two), [], "one at a time");
    assert.deepEqual(await steps(theirs), []);
    assert.deepEqual(await steps(bad), ["refused"]);
    assert.match(startOf(await bad.controls.all())?.problem ?? "", /isn't on studio any more/);
    assert.match(log.join("\n"), /picked up the web app's ask to start shop-two \(Shop two\)/);

    // Still under way: nothing new starts, and nothing is said twice.
    await run();
    assert.deepEqual(launched, ["shop-two"]);
    assert.deepEqual(await steps(one), ["picked-up"]);

    // Its process is gone without a last word.
    keepOrderPid("shop-two", 2 ** 22 - 3);
    await run();
    const stopped = startOf(await one.controls.all());
    assert.deepEqual([stopped?.step, stopped?.stoppedAt], ["failed", "picked-up"]);
    assert.equal(stopped?.problem, "It stopped while getting ready, without saying why.");
    assert.match(stopped?.fix ?? "", /Its log is .*orders\/shop-two\.log on studio\. To carry on from where it stopped, there:/);
    assert.equal(stopped?.command, "a6g projects start shop-two");
    assert.deepEqual(launched, ["shop-two", "site"], "the next one starts once nothing is under way");

    // Withdrawn, or older than a day: left alone.
    const late = storeOver(client, mongoTeam("late"));
    await late.controls.create(startControl("late", "web:s1", ask({ repo: { create: "late" } }), new Date(Date.now() - 25 * 3_600_000).toISOString()));
    const gone = storeOver(client, mongoTeam("gone"));
    await gone.controls.create(startControl("gone", "web:s1", ask({ repo: { create: "gone" } })));
    await gone.controls.create(startControl("gone", "web:s1", null));
    keepOrderPid("site", 2 ** 22 - 3);
    await run();
    assert.deepEqual(await steps(late), []);
    assert.deepEqual(await steps(gone), []);

    // A machine whose operator took it back takes nothing.
    setProjects(null);
    const fresh = storeOver(client, mongoTeam("fresh"));
    await fresh.controls.create(startControl("fresh", "web:s1", ask({ repo: { create: "fresh" } })));
    await run();
    assert.deepEqual(await steps(fresh), []);
  });

  test("carrying one out: the repository, the draft, the setup, its check, then registered with its budget and subscriptions, and started", async () => {
    const s = setting();
    for (const [key, value] of Object.entries({
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@example.com",
    }))
      process.env[key] = value;
    const store = storeOver(fakeMongo(), mongoTeam("shop-two"));
    const limits = { daily: 20, weekly: null, total: 100, unit: "usd" as const, since: "2026-01-01T00:00:00.000Z", autoResume: false };
    await store.controls.create(startControl("shop-two", "web:s1", ask({ limits, use: ["default"], technical: false })));
    const ran: string[] = [];
    // git for real; the factory's own commands only recorded.
    const sh: Sh = (command, args, { cwd }) => {
      if (command === "git") {
        const done = spawnSync("git", args, { cwd, encoding: "utf8" });
        return { code: done.status ?? 1, out: `${done.stdout}${done.stderr}` };
      }
      ran.push(args.slice(1).join(" "));
      return { code: 0, out: "" };
    };
    const state = async () => startOf(await store.controls.all());
    let setups = 0;
    const first = await carryOut("shop-two", (await state()) as NonNullable<Awaited<ReturnType<typeof state>>>, {
      store,
      setting: s,
      sh,
      setup: () => ({ code: 0, out: `working…\nNeeds the operator: a Stripe key scoped for the team\n${++setups}` }),
    });
    assert.equal(first, false);
    const stopped = await state();
    assert.deepEqual([stopped?.step, stopped?.stoppedAt], ["failed", "setup"]);
    // Why, what to do about it, and the command to run, each apart: a page shows the command as one.
    assert.equal(stopped?.problem, "The setup agent can't finish without you.");
    assert.equal(stopped?.said, "a Stripe key scoped for the team");
    assert.equal(stopped?.fix, "To finish the setup yourself, on studio:");
    assert.match(stopped?.command ?? "", /^a6g init \S*shop-two --name shop-two$/);
    const repo = join(s.dir, "shop-two");
    assert.match(readFileSync(join(repo, "README.md"), "utf8"), /^# Shop two\n\nA shop that takes orders\./);
    assert.equal(spawnSync("git", ["log", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim(), "Start Shop two");
    assert.deepEqual(ran, [
      `init ${repo} --name shop-two --title Shop two --store mongo --goal-file ${join(A6G_HOME, "orders", "shop-two.goal.md")} --no-interview --non-technical`,
    ]);
    assert.equal(limitsOf(await store.controls.all()), null, "no budget before it's registered");

    // Carried on: what the first try made is its own, and the rest follows.
    ran.length = 0;
    const second = await carryOut("shop-two", (await state()) as NonNullable<Awaited<ReturnType<typeof state>>>, {
      store,
      setting: s,
      sh,
      setup: () => ({ code: 0, out: "done" }),
    });
    assert.equal(second, true);
    assert.deepEqual((await steps(store)).slice(-6), ["repository", "draft", "setup", "check", "register", "started"]);
    const checkout = join(s.dir, "shop-two-a6g");
    assert.deepEqual(
      ran.map((line) => (line.startsWith("init ") ? "init" : line)),
      ["init", `check ${checkout} --run`, `register ${checkout}`, "start shop-two"]
    );
    const budget = limitsOf(await store.controls.all());
    assert.deepEqual([budget?.daily, budget?.total, budget?.unit], [20, 100, "usd"]);
    assert.notEqual(budget?.since, limits.since, "the total counts from when the team started");
    assert.equal((await store.controls.all()).findLast((c) => c.kind === "budget")?.by, "web:s1");
    assert.deepEqual(teamUses()["shop-two"], { "*": ["default"] });
    assert.equal(spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim(), "1", "no second first commit");

    // Asked again under the same name after one stopped: what the first made is still its own, and the brief takes
    // the goal as it is now.
    const third = storeOver(fakeMongo(), mongoTeam("shop-two"));
    await third.controls.create(startControl("shop-two", "web:s1", ask()));
    await third.controls.create(startControl("shop-two", "web:s1", ask({ goal: "A shop that also takes returns." })));
    const brief = join(checkout, ".a6g", "brief.md");
    write(join(checkout, ".a6g"), {
      "brief.md": "# Brief\n\n## What should exist when the team is done\n\nA shop that takes orders.\n\n## How done is proven\n\nTests.\n",
    });
    const asked = startOf(await third.controls.all()) as NonNullable<ReturnType<typeof startOf>>;
    assert.equal(asked.control.id, "k2");
    assert.equal(refusalOf(asked.ask, "shop-two", s), null);
    assert.equal(await carryOut("shop-two", asked, { store: third, setting: s, sh, setup: () => ({ code: 0, out: "" }) }), true);
    assert.equal(
      readFileSync(brief, "utf8"),
      "# Brief\n\n## What should exist when the team is done\n\nA shop that also takes returns.\n\n## How done is proven\n\nTests.\n"
    );

    // A step's own failure, in its last words.
    const other = storeOver(fakeMongo(), mongoTeam("site"));
    await other.controls.create(startControl("site", "web:s1", ask({ title: "Site", repo: { create: "site" } })));
    const failing: Sh = (command, args, options) =>
      command !== "git" && args[1] === "check" ? { code: 1, out: "gate.sh: typecheck failed\n\u001b[31m2 errors\u001b[0m\n" } : sh(command, args, options);
    assert.equal(
      await carryOut("site", startOf(await other.controls.all()) as NonNullable<ReturnType<typeof startOf>>, {
        store: other,
        setting: s,
        sh: failing,
        setup: () => ({ code: 0, out: "" }),
      }),
      false
    );
    const failed = startOf(await other.controls.all());
    assert.deepEqual([failed?.step, failed?.stoppedAt], ["failed", "check"]);
    assert.equal(failed?.problem, "The setup didn't pass its check.");
    assert.equal(failed?.said, "gate.sh: typecheck failed · 2 errors");
    assert.match(failed?.command ?? "", /^a6g init \S*site --name site$/);
    assert.equal(tail("\n\n"), "it said nothing");
  });

  test("a6g init for one: its title, its tasks in MongoDB, and the operator's goal in the brief", async () => {
    const dir = tmp("a6g-init-");
    const repo = gitRepo(join(dir, "shop-two"), { "README.md": "# Shop two\n" });
    write(dir, { "goal.md": "A shop that takes orders.\n\nIt ships to Canada.\n" });
    const drafted = await a6g([
      "init",
      repo,
      "--name",
      "shop-two",
      "--title",
      "Shop two",
      "--store",
      "mongo",
      "--goal-file",
      join(dir, "goal.md"),
      "--no-interview",
    ]);
    assert.equal(drafted.code, 0, drafted.out);
    const checkout = join(dir, "shop-two-a6g");
    const team = JSON.parse(readFileSync(join(checkout, ".a6g", "team.json"), "utf8"));
    assert.deepEqual([team.name, team.title, team.tasks], ["shop-two", "Shop two", { store: "mongo" }]);
    assert.match(
      readFileSync(join(checkout, ".a6g", "brief.md"), "utf8"),
      /## What should exist when the team is done\n\nA shop that takes orders\.\n\nIt ships to Canada\.\n/
    );
    assert.notEqual((await a6g(["init", repo, "--store", "sqlite", "--no-interview"])).code, 0);
    assert.notEqual((await a6g(["init", repo, "--goal-file", join(dir, "nowhere.md"), "--no-interview"])).code, 0);
    assert.ok(existsSync(join(checkout, ".a6g", "adapters", "gate.sh")));
  });
});

describe("the team's subscriptions, chosen on the web app", () => {
  test("a control sets the list where a6g subscriptions use writes it; one this machine can't follow changes nothing; the lead reports what there is", async () => {
    const run = tmp("a6g-run-");
    write(join(process.env.T3CODE_HOME ?? "", "userdata"), {
      "settings.json": {
        providerInstances: Object.fromEntries(
          ["planner", "builder"].map((role) => [
            `a6g-fixture-${role}`,
            instance({ displayName: role, launchArgs: "", environment: { A6G_TEAM: "fixture", A6G_ROLE: role } }),
          ])
        ),
      },
    });
    const second = tmp("a6g-login-");
    write(A6G_HOME, {
      "subscriptions.json": [
        { name: "default", configDir: null },
        { name: "two", configDir: second },
      ],
    });
    const store = fileStore(run, "fixture");
    const entry = { name: "fixture", run, worker: false };
    assert.deepEqual(applySubscriptionControls(entry, await store.controls.all()), []);

    await store.controls.create(subscriptionsControl("fixture", "web:s1", { role: null, use: ["two", "two", "default"] }));
    const said = applySubscriptionControls(entry, await store.controls.all());
    assert.match(said[0] ?? "", /the operator \(web app\) set the team's subscriptions \(k1\): two, then default/);
    assert.deepEqual(teamUses()["fixture"], { "*": ["two", "default"] });
    assert.deepEqual(applySubscriptionControls(entry, await store.controls.all()), [], "once");

    await store.controls.create(subscriptionsControl("fixture", "web:s1", { role: "builder", use: ["default"] }));
    await store.controls.create(subscriptionsControl("fixture", "web:s1", { role: null, use: ["nowhere"] }));
    await store.controls.create(subscriptionsControl("fixture", "web:s1", { role: "tester", use: ["two"] }));
    const more = applySubscriptionControls(entry, await store.controls.all()).join("\n");
    assert.match(more, /set the builder role's subscriptions \(k2\): default/);
    assert.match(more, /this Mac has no nowhere \(it has default, two\): nothing changed/);
    assert.match(more, /the team has no tester here: nothing changed/);
    assert.deepEqual(teamUses()["fixture"], { "*": ["two", "default"], builder: ["default"] });

    write(join(A6G_HOME, "subscriptions"), {
      "state.json": {
        readings: {
          two: {
            account: "two",
            at: new Date().toISOString(),
            percent: 100,
            resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
            scoped: [],
            spent: 0,
          },
        },
        estimates: [],
        week: null,
      },
    });
    const view = subscriptionsView(entry);
    assert.deepEqual(
      view.available.map((a) => [a.name, a.percent, a.closed]),
      [
        ["default", null, null],
        ["two", 100, "two has used its week"],
      ]
    );
    assert.deepEqual(view.use, { "*": ["two", "default"], builder: ["default"] });
    assert.deepEqual(Object.keys(view.roles).sort(), ["builder", "planner"]);

    await store.controls.create(subscriptionsControl("fixture", "web:s1", { role: "builder", use: [] }));
    await store.controls.create(subscriptionsControl("fixture", "web:s1", { role: null, use: [] }));
    const cleared = applySubscriptionControls(entry, await store.controls.all()).join("\n");
    assert.match(cleared, /cleared the builder role's subscriptions \(k5\): they follow the team's list/);
    assert.match(cleared, /cleared the team's subscriptions \(k6\): the team runs on this Mac's own login/);
    assert.equal(teamUses()["fixture"], undefined);
  });
});
