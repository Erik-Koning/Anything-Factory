// A team's Docker engine (lib/docker.ts): how register chooses it, who gets it, what the watchdog starts, and what
// doctor says when containers are on two engines. `docker` here is a stand-in that answers from a file: which
// contexts there are, which engines run, and the containers on each.
import { a6g, baseTeam, makeRepo, ROOT, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam } from "../lib/config.ts";
import { choose, clashes, type Container, containersOn, contexts, type Engine, named, running, some, starter, strays } from "../lib/docker.ts";
import { memberEnvironment } from "../lib/commands/team.ts";
import { PACKAGE, type RegistryEntry } from "../lib/paths.ts";
import { fakeWorld, type World } from "./fake-t3.ts";

const COLIMA = "unix:///Users/op/.colima/default/docker.sock";
const RANCHER = "unix:///Users/op/.rd/docker.sock";
const colima: Engine = { name: "colima", host: COLIMA, current: true };
const rancher: Engine = { name: "rancher-desktop", host: RANCHER, current: false };

interface FakeContainer {
  name: string;
  ports?: number[];
  mounts?: string[];
}
interface FakeState {
  contexts: Engine[];
  // The engines that answer, by address.
  engines: Record<string, { id: string; containers?: FakeContainer[] }>;
}

// A docker (and a colima) first on a PATH of the caller's choosing, which answer from state.json and log every call.
function fakeDocker(state: FakeState): { dir: string; set: (state: FakeState) => void; calls: () => string[] } {
  const dir = tmp("a6g-docker-");
  write(dir, {
    "state.json": state,
    "docker.mjs": `import { appendFileSync, readFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const state = JSON.parse(readFileSync(dir + "/state.json", "utf8"));
let args = process.argv.slice(2);
appendFileSync(dir + "/calls", "docker " + args.join(" ") + " [DOCKER_HOST=" + (process.env.DOCKER_HOST ?? "") + "]\\n");
let host = process.env.DOCKER_HOST ?? state.contexts.find((context) => context.current)?.host;
if (args[0] === "--host") {
  host = args[1];
  args = args.slice(2);
}
if (args[0] === "context") {
  for (const context of state.contexts)
    console.log(JSON.stringify({ Name: context.name, DockerEndpoint: context.host, Current: context.current, Description: "", Error: "" }));
  process.exit(0);
}
const engine = state.engines[host];
if (!engine) process.exit(1);
const containers = engine.containers ?? [];
if (args[0] === "info" && args.includes("--format")) console.log(engine.id);
if (args[0] === "ps") containers.forEach((_, i) => console.log("c" + i));
if (args[0] === "inspect")
  for (const id of args.filter((arg) => /^c\\d+$/.test(arg))) {
    const container = containers[Number(id.slice(1))];
    console.log(
      JSON.stringify({
        name: "/" + container.name,
        ports: container.ports ? Object.fromEntries(container.ports.map((port) => [port + "/tcp", [{ HostIp: "", HostPort: String(port) }]])) : null,
        mounts: (container.mounts ?? []).map((Source) => ({ Type: "bind", Source })),
      })
    );
  }
`,
    docker: `#!/bin/sh\nexec "${process.execPath}" "${dir}/docker.mjs" "$@"\n`,
    colima: `#!/bin/sh\necho "colima $*" >> "${dir}/calls"\n`,
  });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "colima"), 0o755);
  return {
    dir,
    set: (next) => writeFileSync(join(dir, "state.json"), JSON.stringify(next)),
    calls: () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean) : []),
  };
}

const both: FakeState = { contexts: [colima, rancher], engines: { [COLIMA]: { id: "C" }, [RANCHER]: { id: "R" } } };
const onlyColima: FakeState = { contexts: [colima, rancher], engines: { [COLIMA]: { id: "C" } } };

describe("choosing a team's engine", () => {
  const engines = [colima, rancher];

  test("the one named, by its context, its address or its socket's path", () => {
    assert.deepEqual(named("rancher-desktop", engines), { host: RANCHER, context: "rancher-desktop" });
    assert.deepEqual(named(COLIMA, engines), { host: COLIMA, context: "colima" });
    assert.deepEqual(named("/var/run/docker.sock", engines), { host: "unix:///var/run/docker.sock", context: null });
    assert.deepEqual(named("tcp://10.0.0.5:2376", engines), { host: "tcp://10.0.0.5:2376", context: null });
    const unknown = named("orbstack", engines);
    assert.ok("problem" in unknown);
    assert.match(unknown.problem, /--docker orbstack: no Docker context has that name here \(docker context ls has colima, rancher-desktop\)/);
  });

  test("named, else kept, else DOCKER_HOST's, else the only one running", () => {
    const pin = (result: ReturnType<typeof choose>) => ("problem" in result ? result.problem : result.pin);
    assert.deepEqual(pin(choose({ requested: "rancher-desktop", previous: { host: COLIMA, context: "colima" }, engines, up: engines })), {
      host: RANCHER,
      context: "rancher-desktop",
    });
    assert.deepEqual(pin(choose({ previous: { host: RANCHER, context: "rancher-desktop" }, engines, up: engines })), {
      host: RANCHER,
      context: "rancher-desktop",
    });
    assert.deepEqual(pin(choose({ engines, up: engines, host: RANCHER })), { host: RANCHER, context: "rancher-desktop" });
    assert.deepEqual(
      pin(choose({ engines, up: [rancher] })),
      { host: RANCHER, context: "rancher-desktop" },
      "not the current context, which isn't running"
    );
  });

  test("several running and nothing to say which: the operator says", () => {
    const result = choose({ engines, up: engines });
    assert.ok("problem" in result);
    assert.equal(
      result.problem,
      "2 Docker engines are running here (colima, rancher-desktop), each with its own containers: say which one is this team's with --docker <name>"
    );
  });

  test("none running: the docker CLI's current one; no docker at all: none", () => {
    const down = choose({ engines, up: [] });
    assert.ok(!("problem" in down));
    assert.deepEqual(down.pin, { host: COLIMA, context: "colima" });
    assert.match(down.why, /isn't running now/);
    assert.deepEqual(choose({ engines: [], up: [] }), { pin: null, why: "" });
  });
});

describe("reading the engines", () => {
  test("the contexts, the engines that answer (each once), and what's on one", () => {
    const fake = fakeDocker({
      contexts: [
        { name: "default", host: "unix:///var/run/docker.sock", current: false },
        { name: "desktop-linux", host: "unix:///Users/op/.docker/run/docker.sock", current: true },
        rancher,
        { ...colima, current: false },
      ],
      engines: {
        // Docker Desktop under both its names, and Rancher Desktop; Colima is down.
        "unix:///var/run/docker.sock": { id: "D" },
        "unix:///Users/op/.docker/run/docker.sock": { id: "D" },
        [RANCHER]: {
          id: "R",
          containers: [{ name: "db", ports: [5432], mounts: [] }, { name: "studio", mounts: ["/work/app/.a6g/run/env/snippets"] }, { name: "worker" }],
        },
      },
    });
    const path = process.env.PATH;
    process.env.PATH = `${fake.dir}:${path}`;
    try {
      const found = contexts();
      assert.deepEqual(
        found.map((engine) => engine.name),
        ["default", "desktop-linux", "rancher-desktop", "colima"]
      );
      assert.deepEqual(
        running(found).map((engine) => [engine.name, engine.id]),
        [
          ["desktop-linux", "D"],
          ["rancher-desktop", "R"],
        ],
        "one engine under two contexts counts once, under the current one's name"
      );
      assert.deepEqual(containersOn(RANCHER), [
        { name: "db", ports: [5432], mounts: [] },
        { name: "studio", ports: [], mounts: ["/work/app/.a6g/run/env/snippets"] },
        { name: "worker", ports: [], mounts: [] },
      ]);
      assert.equal(containersOn(COLIMA), null, "an engine that doesn't answer");
    } finally {
      process.env.PATH = path;
    }
  });

  test("the same containers on two engines, the same port on two, and a team's on the wrong one", () => {
    const on = (name: string, containers: Container[]) => ({ name, containers });
    const c = (name: string, ports: number[] = [], mounts: string[] = []): Container => ({ name, ports, mounts });
    const each = [
      on("colima", [c("db_app", [5432]), c("studio_app", [3001], ["/work/app-a6g/.a6g/run/env/snippets"])]),
      on("rancher-desktop", [c("db_app", [5432]), c("db_old", [5432]), c("studio_old", [], ["/work/app-a6g/.a6g/run/env/snippets"]), c("cache", [6379])]),
    ];
    const found = clashes(each);
    assert.deepEqual(found.names, [{ name: "db_app", engines: ["colima", "rancher-desktop"] }]);
    assert.deepEqual(
      found.ports.map(({ port, held }) => [port, held.map((h) => `${h.container}@${h.engine}`)]),
      [[5432, ["db_app@colima", "db_app@rancher-desktop", "db_old@rancher-desktop"]]]
    );
    // The same container on both, publishing its port on both, is said once: as a copy.
    assert.deepEqual(clashes([on("colima", [c("db_app", [5432])]), on("rancher-desktop", [c("db_app", [5432])])]).ports, []);
    assert.deepEqual(strays(["/work/app-a6g", "/t3/worktrees/app-a6g"], each.slice(1)), [{ engine: "rancher-desktop", containers: ["studio_old"] }]);
    assert.deepEqual(strays(["/work/app"], each), [], "a folder whose name only starts the same isn't the team's");
    assert.equal(some(["a", "b", "c", "d", "e"]), "a, b, c and 2 more");
    assert.equal(some(["a", "b"]), "a, b");
  });

  test("how an engine is started: its app, Colima's profile, or not by the factory", () => {
    const apps = [
      { app: "Docker", sockets: [".docker/run/docker.sock", "/var/run/docker.sock"] },
      { app: "Rancher Desktop", sockets: [".rd/docker.sock"] },
    ];
    const how = (host: string) => starter({ host, context: null }, apps, "/Users/op");
    assert.deepEqual(how(RANCHER), { app: "Rancher Desktop" });
    assert.deepEqual(how("unix:///var/run/docker.sock"), { app: "Docker" });
    assert.deepEqual(how(COLIMA), { command: "colima", args: ["start", "default"] });
    assert.deepEqual(how("unix:///Users/op/.colima/work/docker.sock"), { command: "colima", args: ["start", "work"] });
    assert.equal(how("unix:///Users/op/.orbstack/run/docker.sock"), null, "an app that isn't installed");
    assert.equal(how("tcp://10.0.0.5:2376"), null);
  });
});

// A team that needs Docker, in a world whose docker is the stand-in.
const needsDocker = () => baseTeam({ environment: { script: ".a6g/adapters/env.sh", needsDocker: true } });
async function worldWith(state: FakeState, { register = false } = {}): Promise<{ w: World; fake: ReturnType<typeof fakeDocker> }> {
  const w = await fakeWorld(needsDocker(), { register });
  const fake = fakeDocker(state);
  w.env.PATH = `${fake.dir}:${w.env.PATH}`;
  mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
  return { w, fake };
}
const entryOf = (w: World): RegistryEntry => JSON.parse(readFileSync(join(w.a6gHome, "teams", "fixture.json"), "utf8")) as RegistryEntry;

describe("register", () => {
  test("ties the team to the only engine running, and gives it to every member", async () => {
    const { w } = await worldWith(onlyColima);
    try {
      const result = await w.a6g("register", w.home);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /^ {2}Docker engine: colima \(unix:\/\/\/Users\/op\/\.colima\/default\/docker\.sock\), the only one running: /m);
      assert.deepEqual(entryOf(w).docker, { host: COLIMA, context: "colima" });
      // Every role's T3 instance carries it.
      const settings = readFileSync(join(w.t3Home, "userdata", "settings.json"), "utf8");
      const carried: unknown[] = [];
      JSON.parse(settings, (_key, value: { name?: unknown; value?: unknown } | null) => {
        if (value && typeof value === "object" && value.name === "DOCKER_HOST") carried.push(value.value);
        return value;
      });
      assert.deepEqual(
        carried,
        Object.keys(needsDocker().roles ?? {}).map(() => COLIMA)
      );
    } finally {
      await w.close();
    }
  });

  test("with two running it stops and asks, registering nothing; --docker says which, and it's kept", async () => {
    const { w, fake } = await worldWith(both);
    try {
      const asked = await w.a6g("register", w.home);
      assert.equal(asked.code, 2, asked.out);
      assert.match(asked.out, /2 Docker engines are running here \(colima, rancher-desktop\), each with its own containers: say which one is this team's/);
      assert.ok(!existsSync(join(w.a6gHome, "teams", "fixture.json")), "nothing registered");

      const said = await w.a6g("register", w.home, "--docker", "rancher-desktop");
      assert.equal(said.code, 0, said.out);
      assert.match(said.out, /Docker engine: rancher-desktop \(unix:\/\/\/Users\/op\/\.rd\/docker\.sock\), named with --docker/);
      assert.deepEqual(entryOf(w).docker, { host: RANCHER, context: "rancher-desktop" });

      // Registered again with both still running, and with only the other one: it stays where it is.
      const again = await w.a6g("register", w.home);
      assert.equal(again.code, 0, again.out);
      assert.match(again.out, /Docker engine: rancher-desktop .*as it was registered/);
      fake.set(onlyColima);
      assert.equal((await w.a6g("register", w.home)).code, 0);
      assert.deepEqual(entryOf(w).docker, { host: RANCHER, context: "rancher-desktop" });

      const moved = await w.a6g("register", w.home, "--docker", "colima");
      assert.equal(moved.code, 0, moved.out);
      assert.deepEqual(entryOf(w).docker, { host: COLIMA, context: "colima" });
    } finally {
      await w.close();
    }
  });

  test("a name docker doesn't know, and --docker with nothing after it, are refused", async () => {
    const { w } = await worldWith(both);
    try {
      const unknown = await w.a6g("register", w.home, "--docker", "orbstack");
      assert.equal(unknown.code, 2);
      assert.match(unknown.out, /--docker orbstack: no Docker context has that name here \(docker context ls has colima, rancher-desktop\)/);
      const bare = await w.a6g("register", w.home, "--docker");
      assert.equal(bare.code, 2);
      assert.match(bare.out, /--docker takes a Docker context's name/);
      assert.ok(!existsSync(join(w.a6gHome, "teams", "fixture.json")));
    } finally {
      await w.close();
    }
  });

  test("DOCKER_HOST in the operator's shell says which, where several run", async () => {
    const { w } = await worldWith(both);
    try {
      w.env.DOCKER_HOST = RANCHER;
      const result = await w.a6g("register", w.home);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /Docker engine: rancher-desktop .*DOCKER_HOST names it in this shell/);
      assert.deepEqual(entryOf(w).docker, { host: RANCHER, context: "rancher-desktop" });
    } finally {
      await w.close();
    }
  });

  test("a team that needs no Docker gets no engine, unless the operator names one", async () => {
    const w = await fakeWorld(baseTeam(), { register: false });
    const fake = fakeDocker(both);
    w.env.PATH = `${fake.dir}:${w.env.PATH}`;
    mkdirSync(join(w.a6gHome, "versions", PACKAGE.version, "plugin"), { recursive: true });
    try {
      const plain = await w.a6g("register", w.home);
      assert.equal(plain.code, 0, plain.out);
      assert.equal(entryOf(w).docker, undefined);
      assert.doesNotMatch(plain.out, /Docker engine/);
      assert.equal((await w.a6g("register", w.home, "--docker", "colima")).code, 0);
      assert.deepEqual(entryOf(w).docker, { host: COLIMA, context: "colima" });
    } finally {
      await w.close();
    }
  });

  test("upgrade gives an engine to a team registered before teams had one, and passes --docker on", async () => {
    const w = await fakeWorld(needsDocker());
    const fake = fakeDocker(both);
    try {
      // This checkout as the version it moves to, and an older release that only notes how it was run.
      write(join(w.a6gHome, "versions", "0.2.0"), {
        "package.json": { type: "module" },
        "bin/a6g.ts": 'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.OLD_RAN, process.argv.slice(2).join(" ") + "\\n");\n',
      });
      symlinkSync(ROOT, join(w.a6gHome, "versions", PACKAGE.version));
      const oldRan = join(w.root, "old-ran");
      const env = { ...w.env, PATH: `${fake.dir}:${w.env.PATH}`, OLD_RAN: oldRan };
      const pin = () => (JSON.parse(readFileSync(join(w.home, ".a6g/team.json"), "utf8")) as { factory?: string }).factory;

      const asked = await a6g(["upgrade", "fixture"], { cwd: w.root, env });
      assert.equal(asked.code, 2, asked.out);
      assert.match(asked.out, /2 Docker engines are running here \(colima, rancher-desktop\)/);
      assert.equal(pin(), undefined, "the pin doesn't move");
      assert.equal(entryOf(w).docker, undefined);

      const said = await a6g(["upgrade", "fixture", "--docker", "colima"], { cwd: w.root, env });
      assert.equal(said.code, 0, said.out);
      assert.equal(pin(), PACKAGE.version);
      assert.deepEqual(entryOf(w).docker, { host: COLIMA, context: "colima" });

      assert.equal((await a6g(["upgrade", "fixture", "0.2.0", "--docker", "rancher-desktop"], { cwd: w.root, env })).code, 0);
      assert.equal(readFileSync(oldRan, "utf8"), "upgrade fixture 0.2.0 --docker rancher-desktop\n");
    } finally {
      await w.close();
    }
  });

  test("a member's DOCKER_HOST is the team's engine, whatever team.json's vars say", () => {
    const home = makeRepo(baseTeam({ vars: { DOCKER_HOST: "unix:///elsewhere.sock", PORT: 3200 } }));
    const team = loadTeam(home);
    const env = (engine?: { host: string; context: string | null }) =>
      memberEnvironment(team, "builder", { home, run: "/tmp/run", version: PACKAGE.version, ...(engine ? { engine } : {}) });
    assert.equal(env({ host: COLIMA, context: "colima" })["DOCKER_HOST"], COLIMA);
    assert.equal(env()["DOCKER_HOST"], "unix:///elsewhere.sock", "with no engine chosen, the team's own var stands");
  });
});

describe("what the factory runs for a team", () => {
  test("a person's a6g env reaches the team's engine, not their shell's", async () => {
    const { w } = await worldWith(both);
    try {
      write(w.home, { ".a6g/adapters/env.sh": '#!/bin/sh\necho "engine=${DOCKER_HOST:-none} context=${DOCKER_CONTEXT:-none}"\n' });
      chmodSync(join(w.home, ".a6g/adapters/env.sh"), 0o755);
      const before = await a6g(["env", "status"], { cwd: w.home, env: { ...w.env, DOCKER_CONTEXT: "colima" } });
      assert.match(before.out, /engine=none context=colima/, "an unregistered checkout is left alone");
      assert.equal((await w.a6g("register", w.home, "--docker", "rancher-desktop")).code, 0);
      const after = await a6g(["env", "status"], { cwd: w.home, env: { ...w.env, DOCKER_CONTEXT: "colima" } });
      assert.match(after.out, new RegExp(`engine=${RANCHER} context=none`));
      const status = await w.a6g("status", "fixture");
      assert.match(status.out, /^ {3}Docker engine: rancher-desktop$/m);
    } finally {
      await w.close();
    }
  });

  test("a6g check warns about a script that picks an engine itself, not about one that only mentions it", async () => {
    const picks = makeRepo(needsDocker(), {
      ".a6g/adapters/env.sh": '#!/bin/sh\nfor sock in "$HOME/.rd/docker.sock"; do [ -S "$sock" ] && export DOCKER_HOST="unix://$sock"; done\n',
    });
    assert.match((await a6g(["check", picks])).out, /^warn {2}\.a6g\/adapters\/env\.sh picks a Docker engine itself/m);
    const leaves = makeRepo(needsDocker(), {
      ".a6g/adapters/env.sh": '#!/bin/sh\n# The factory sets DOCKER_HOST=… to the team\'s engine.\n[ -n "${DOCKER_HOST:-}" ] && docker info >/dev/null\n',
    });
    assert.doesNotMatch((await a6g(["check", leaves])).out, /picks a Docker engine/);
  });
});

describe("the watchdog and doctor", () => {
  const pinTo = (w: World, docker: RegistryEntry["docker"] | null): void => {
    const { docker: _had, ...entry } = entryOf(w);
    writeFileSync(join(w.a6gHome, "teams", "fixture.json"), JSON.stringify({ ...entry, needsDocker: true, ...(docker ? { docker } : {}) }));
  };

  test("the watchdog starts the team's engine, not another, and says which", async () => {
    // Rancher Desktop runs; the team's engine is Colima, which doesn't.
    const { w, fake } = await worldWith({ contexts: [colima, rancher], engines: { [RANCHER]: { id: "R" } } }, { register: true });
    try {
      pinTo(w, { host: `unix://${w.env.HOME}/.colima/default/docker.sock`, context: "colima" });
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      const log = readFileSync(join(w.run, "watchdog.log"), "utf8");
      assert.match(log, /the team's Docker engine \(colima\) isn't running; starting it \(colima start default\)/);
      // It's started in a session of its own, so it may land a moment after the run ends.
      for (let i = 0; i < 50 && !fake.calls().includes("colima start default"); i++) await new Promise((done) => setTimeout(done, 100));
      assert.ok(fake.calls().includes("colima start default"), fake.calls().join("\n"));
      assert.ok(!w.calls().some((call) => call.startsWith("open ")), "no other engine's app is opened");
      assert.ok(!existsSync(join(w.run, "planner-thread")), "and nothing starts until it answers");

      // An engine the factory can't start is said, and nothing else is started in its place.
      pinTo(w, { host: "tcp://10.0.0.5:2376", context: null });
      await w.a6g("watchdog", "run", "fixture");
      assert.match(
        readFileSync(join(w.run, "watchdog.log"), "utf8"),
        /the team's Docker engine \(tcp:\/\/10\.0\.0\.5:2376\) isn't running, and the watchdog doesn't know how to start it/
      );
      assert.ok(!w.calls().some((call) => call.startsWith("open ")));
    } finally {
      await w.close();
    }
  });

  test("doctor says what's on two engines, and whose", async () => {
    const snippets = (w: World) => join(w.home, ".a6g/run/env/snippets");
    const { w, fake } = await worldWith(both, { register: true });
    try {
      fake.set({
        contexts: [colima, rancher],
        engines: {
          [COLIMA]: {
            id: "C",
            containers: [
              { name: "db_app", ports: [5432] },
              { name: "studio_app", mounts: [snippets(w)] },
            ],
          },
          [RANCHER]: {
            id: "R",
            containers: [
              { name: "db_app", ports: [5432] },
              { name: "studio_app", mounts: [snippets(w)] },
              { name: "db_old", ports: [5432] },
            ],
          },
        },
      });
      pinTo(w, { host: COLIMA, context: "colima" });
      const lines = (await w.a6g("doctor")).out;
      assert.match(lines, /^warn {2}Docker: 2 containers are on both colima and rancher-desktop \(db_app, studio_app\): one copy of each is a stray/m);
      assert.match(
        lines,
        /^warn {2}Docker: containers on different engines publish the same port of this Mac, which only one of them gets: 5432 \(db_app on colima and rancher-desktop, db_old on rancher-desktop\)$/m
      );
      assert.match(lines, /^warn {2}fixture: 1 container of its checkout is on rancher-desktop \(studio_app\), though its Docker engine is colima$/m);
      assert.doesNotMatch(lines, /fixture: (its Docker engine|needs Docker|no Docker engine)/);

      // No engine chosen, with two running: how to choose. Then its own engine down.
      pinTo(w, null);
      const unchosen = (await w.a6g("doctor")).out;
      assert.match(
        unchosen,
        new RegExp(
          `^warn {2}fixture: no Docker engine is chosen for it and 2 are running \\(colima, rancher-desktop\\), so .* \\(a6g register ${w.home} --docker <name>\\)$`,
          "m"
        )
      );
      pinTo(w, { host: COLIMA, context: "colima" });
      fake.set({ contexts: [colima, rancher], engines: { [RANCHER]: { id: "R", containers: [{ name: "studio_app", mounts: [snippets(w)] }] } } });
      const down = (await w.a6g("doctor")).out;
      assert.match(down, /^warn {2}fixture: its Docker engine \(colima\) isn't running$/m);
      assert.match(down, /^warn {2}fixture: 1 container of its checkout is on rancher-desktop \(studio_app\), though its Docker engine is colima$/m);
      assert.doesNotMatch(down, /^warn {2}Docker: /m, "one engine running has nothing to clash with");
      assert.match((await w.a6g("status", "fixture")).out, /^ {3}Docker engine: colima, which isn't running$/m);
    } finally {
      await w.close();
    }
  });
});
