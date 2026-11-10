import { a6g, makeRepo, tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { acquire, TIMED_OUT, withLock } from "../lib/lock.ts";

describe("lock", { concurrency: true }, () => {
  test("one slot: the second holder waits for the first", async () => {
    const home = tmp();
    const first = await acquire(home, "merge", { slots: 1, waitMin: 1 });
    assert.ok(first);
    const started = Date.now();
    setTimeout(first, 300);
    const second = await acquire(home, "merge", { slots: 1, waitMin: 1 });
    assert.ok(second);
    assert.ok(Date.now() - started >= 250, "it waited");
    second();
  });

  test("two slots hold two at once", async () => {
    const home = tmp();
    const a = await acquire(home, "gate", { slots: 2, waitMin: 0.01 });
    const b = await acquire(home, "gate", { slots: 2, waitMin: 0.01 });
    assert.ok(a && b);
    a();
    b();
  });

  test("a slot whose holder died is taken over", async () => {
    const home = tmp();
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
    mkdirSync(join(home, ".a6g/run/locks/app/slot-0"), { recursive: true });
    writeFileSync(join(home, ".a6g/run/locks/app/slot-0/pid"), dead);
    const started = Date.now();
    const release = await acquire(home, "app", { slots: 1, waitMin: 0.01 });
    assert.ok(release);
    assert.ok(Date.now() - started < 1000, "without waiting");
    release();
  });

  test("no slot in time: null, and withLock reports TIMED_OUT", async () => {
    const home = tmp();
    const held = await acquire(home, "journeys", { slots: 1, waitMin: 1 });
    assert.equal(await acquire(home, "journeys", { slots: 1, waitMin: 0.01 }), null);
    const error = console.error;
    console.error = () => {};
    try {
      assert.equal(await withLock(home, "journeys", ["true"], { slots: 1, waitMin: 0.01 }), TIMED_OUT);
    } finally {
      console.error = error;
    }
    held?.();
    assert.equal(await withLock(home, "journeys", ["sh", "-c", "exit 3"], { slots: 1, waitMin: 0.01, stdio: "ignore" }), 3, "the command's own exit code");
  });
});

describe("a6g env use", () => {
  const as = (home: string) => ({ cwd: home, env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: "tester", A6G_RUN: `${home}-run` } });
  const use = (home: string, ...args: string[]) => a6g(["env", "use", ...args], as(home));

  test("holds the team's app for its command, waits no longer than --wait-min, and ends a command past --max-min with all it started", async () => {
    const home = makeRepo();
    const ran = await use(home, "--", "sh", "-c", "echo held=$A6G_APP_LOCK as=$A6G_NAMESPACE");
    assert.equal(ran.code, 0, ran.out);
    assert.match(ran.out, /held=held as=tester/);
    assert.equal((await use(home, "--", "sh", "-c", "exit 3")).code, 3, "the command's own exit code");

    // The app is busy (a merge restarting it): it waits as long as it was told, and says so.
    const held = await acquire(home, "app", { slots: 1, waitMin: 1, holder: "a merge restarting it" });
    assert.ok(held);
    const busy = await use(home, "--wait-min", "0.01", "--", "sh", "-c", "echo ran");
    held();
    assert.equal(busy.code, TIMED_OUT, busy.out);
    assert.match(busy.out, /env use: the team's app stayed busy for 0\.01 minutes \(a merge restarting it, or another run\); try again/);
    assert.doesNotMatch(busy.out, /^ran$/m);

    // A command that hangs doesn't hold the app for good: past --max-min it's ended, with what it started.
    const pidFile = join(tmp(), "pid");
    const over = await use(home, "--max-min", "0.02", "--", "sh", "-c", `sleep 60 & echo $! > ${pidFile}; wait`);
    assert.equal(over.code, 124, over.out);
    assert.match(over.out, /env use: the command held the team's app for 0\.02 minutes \(--max-min\) and was ended, with everything it started\./);
    const started = Number(readFileSync(pidFile, "utf8"));
    const alive = (): boolean => {
      try {
        process.kill(started, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((next) => setTimeout(next, 100));
    assert.ok(!alive(), "what the command started is gone too");
    const free = await acquire(home, "app", { slots: 1, waitMin: 0.01 });
    assert.ok(free, "and the app is free again");
    free();

    // Nothing holds the app for longer than two hours, whatever it says.
    const much = await use(home, "--max-min", "121", "--", "true");
    assert.equal(much.code, 2);
    assert.match(much.out, /env use: --max-min 121 is more than the 120 minutes anything may hold the team's app/);
    assert.match((await use(home, "--max-min", "soon", "--", "true")).out, /env use: not a duration: soon/);
  });
});
