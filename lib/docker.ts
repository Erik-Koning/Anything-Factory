// The Docker engine a team's containers run on. A Mac can have several (Docker Desktop, Rancher Desktop, OrbStack,
// Colima), each with its own containers and volumes and all publishing ports on the same machine, and a plain
// `docker` talks to whichever its current context names. So a team is tied to one when it's registered (the
// registry's `docker`): its members, and every command the factory runs for it, get DOCKER_HOST set to that engine,
// the watchdog checks and starts that one, and doctor says when containers have ended up on another.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readRegistry } from "./paths.ts";
import { which } from "./util.ts";

// One of the docker CLI's contexts: its name, its engine's address, and whether a plain `docker` uses it.
export interface Engine {
  name: string;
  host: string;
  current: boolean;
}
// An engine that answers, with its own id: two contexts can name one engine (Docker Desktop's "default" and
// "desktop-linux"), and the id tells.
export type Running = Engine & { id: string };
// A team's engine, as its registry entry keeps it: the address, and the context it was chosen by (for what's said).
export interface Pin {
  host: string;
  context: string | null;
}

// An engine that hangs mustn't hold up the watchdog or doctor.
const TIMEOUT_MS = 15_000;
const docker = (args: string[]): { ok: boolean; out: string } => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return { ok: result.status === 0, out: result.stdout ?? "" };
};

export function contexts(): Engine[] {
  const { ok, out } = docker(["context", "ls", "--format", "{{json .}}"]);
  if (!ok) return [];
  const found: Engine[] = [];
  for (const line of out.split("\n")) {
    try {
      const row = JSON.parse(line) as { Name?: unknown; DockerEndpoint?: unknown; Current?: unknown };
      if (typeof row.Name === "string" && typeof row.DockerEndpoint === "string" && row.DockerEndpoint)
        found.push({ name: row.Name, host: row.DockerEndpoint, current: row.Current === true });
    } catch {}
  }
  return found;
}

// The id of the engine at an address while it answers (its address, when it gives none), else null.
export function engineId(host: string): string | null {
  const { ok, out } = docker(["--host", host, "info", "--format", "{{.ID}}"]);
  return ok ? out.trim() || host : null;
}

// The engines that answer now, each once, under the current context's name when that's one of its names.
export function running(engines: Engine[]): Running[] {
  const found = new Map<string, Running>();
  for (const engine of [...engines].sort((a, b) => Number(b.current) - Number(a.current))) {
    const id = engineId(engine.host);
    if (id !== null && !found.has(id)) found.set(id, { ...engine, id });
  }
  return [...found.values()];
}

// Whether the team's engine answers; with none chosen, whichever a plain `docker` reaches.
export const answers = (pin?: Pin | null): boolean =>
  spawnSync("docker", pin ? ["--host", pin.host, "info"] : ["info"], { stdio: "ignore", timeout: TIMEOUT_MS }).status === 0;

export const label = (pin: Pin): string => pin.context ?? pin.host;

const ADDRESS = /^(unix|tcp|ssh|npipe|fd):\/\//;

// What --docker names: a context, an engine's address, or its socket's path.
export function named(requested: string, engines: Engine[]): Pin | { problem: string } {
  const host = ADDRESS.test(requested) ? requested : requested.startsWith("/") ? `unix://${requested}` : null;
  if (host) return { host, context: engines.find((engine) => engine.host === host)?.name ?? null };
  const engine = engines.find((candidate) => candidate.name === requested);
  if (engine) return { host: engine.host, context: engine.name };
  const known = engines.length ? `docker context ls has ${engines.map((candidate) => candidate.name).join(", ")}` : "docker context ls lists none";
  return {
    problem: `--docker ${requested}: no Docker context has that name here (${known}); name one, or give the engine's address (unix:///…/docker.sock)`,
  };
}

// The engine a team is registered with, and why that one: the one asked for, else the one it already has, else the
// one DOCKER_HOST names in the operator's shell, else the only one running. With several running and nothing to say
// which, the operator says: guessing is how a team's containers end up on two engines. With none running, the docker
// CLI's current one; with no docker at all, none.
export function choose({
  requested,
  previous,
  engines,
  up,
  host,
}: {
  requested?: string | undefined;
  previous?: Pin | null | undefined;
  engines: Engine[];
  up: Engine[];
  host?: string | undefined;
}): { pin: Pin | null; why: string } | { problem: string } {
  const of = (engine: Engine): Pin => ({ host: engine.host, context: engine.name });
  if (requested) {
    const pin = named(requested, engines);
    return "problem" in pin ? pin : { pin, why: "named with --docker" };
  }
  if (previous) return { pin: previous, why: "as it was registered" };
  if (host) return { pin: { host, context: engines.find((engine) => engine.host === host)?.name ?? null }, why: "DOCKER_HOST names it in this shell" };
  if (up.length > 1)
    return {
      problem: `${up.length} Docker engines are running here (${up.map((engine) => engine.name).join(", ")}), each with its own containers: say which one is this team's with --docker <name>`,
    };
  const only = up[0];
  if (only) return { pin: of(only), why: "the only one running" };
  const current = engines.find((engine) => engine.current);
  return current ? { pin: of(current), why: "the docker CLI's current one; it isn't running now" } : { pin: null, why: "" };
}

// The engine of the team in `home`, when it's registered with one.
export function pinOf(name: string, home: string): Pin | null {
  try {
    const entry = readRegistry(name);
    return entry && entry.home === home && entry.docker ? entry.docker : null;
  } catch {
    return null;
  }
}

// From here on, whatever this process starts talks to the team's engine. DOCKER_CONTEXT goes, so that nothing reads
// another engine from it.
export function useEngine(pin: Pin | null | undefined): void {
  if (!pin) return;
  process.env.DOCKER_HOST = pin.host;
  delete process.env.DOCKER_CONTEXT;
}

// The Docker apps a Mac may have: where each keeps its docker CLI (launchd's PATH has none of them), and its
// engine's socket, in the home folder unless the path is whole.
export const DOCKER_APPS = [
  { app: "Docker", bin: "/Applications/Docker.app/Contents/Resources/bin", sockets: [".docker/run/docker.sock", "/var/run/docker.sock"] },
  { app: "Rancher Desktop", bin: join(homedir(), ".rd", "bin"), sockets: [".rd/docker.sock"] },
  { app: "OrbStack", bin: join(homedir(), ".orbstack", "bin"), sockets: [".orbstack/run/docker.sock"] },
].filter(({ app }) => existsSync(join("/Applications", `${app}.app`)));

// How an engine is started: the app that runs it, or Colima's command for the profile its socket belongs to. null
// for one the factory doesn't know (a remote engine, a socket of something else).
export type Starter = { app: string } | { command: string; args: string[] } | null;
export function starter(pin: Pin, apps: { app: string; sockets: string[] }[] = DOCKER_APPS, home = homedir()): Starter {
  if (!pin.host.startsWith("unix://")) return null;
  const socket = pin.host.slice("unix://".length);
  const app = apps.find(({ sockets }) => sockets.some((path) => socket === (isAbsolute(path) ? path : join(home, path))));
  if (app) return { app: app.app };
  const profile = /\/\.?colima\/([^/]+)\/docker\.sock$/.exec(socket)?.[1];
  return profile ? { command: "colima", args: ["start", profile] } : null;
}

// Starts the team's engine and returns what to log. With none chosen (a team registered before engines were), the
// first Docker app installed, as the watchdog always did.
export function startEngine(pin: Pin | null | undefined): string {
  if (!pin) {
    const app = DOCKER_APPS[0]?.app;
    if (app) spawnSync("open", ["-a", app], { stdio: "ignore" });
    return app ? `Docker isn't running; starting ${app}` : "Docker isn't running, and no Docker app is installed to start";
  }
  const what = `the team's Docker engine (${label(pin)}) isn't running`;
  const how = starter(pin);
  if (!how) return `${what}, and the watchdog doesn't know how to start it (${pin.host})`;
  if ("app" in how) {
    spawnSync("open", ["-a", how.app], { stdio: "ignore" });
    return `${what}; starting ${how.app}`;
  }
  if (!which(how.command)) return `${what}, and ${how.command} isn't on the watchdog's PATH to start it`;
  // In a session of its own, so it outlives this run: it takes longer than the watchdog waits.
  spawn(how.command, how.args, { detached: true, stdio: "ignore" })
    .on("error", () => {})
    .unref();
  return `${what}; starting it (${how.command} ${how.args.join(" ")})`;
}

// A container on an engine, running or not: the ports of this Mac it publishes when it runs, and the folders of this
// Mac it mounts.
export interface Container {
  name: string;
  ports: number[];
  mounts: string[];
}
const SHOWN = '{"name":{{json .Name}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}}';

// Every container on an engine, stopped ones too; null when it couldn't be read.
export function containersOn(host: string): Container[] | null {
  const listed = docker(["--host", host, "ps", "-aq"]);
  if (!listed.ok) return null;
  const ids = listed.out.split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const shown = docker(["--host", host, "inspect", "--format", SHOWN, ...ids]);
  if (!shown.ok) return null;
  const found: Container[] = [];
  for (const line of shown.out.split("\n")) {
    try {
      const row = JSON.parse(line) as {
        name?: unknown;
        ports?: Record<string, { HostPort?: string }[] | null> | null;
        mounts?: { Type?: string; Source?: string }[] | null;
      };
      if (typeof row.name !== "string") continue;
      const ports = Object.values(row.ports ?? {})
        .flatMap((bindings) => bindings ?? [])
        .map((binding) => Number(binding.HostPort))
        .filter((port) => Number.isInteger(port) && port > 0);
      const mounts = (row.mounts ?? []).flatMap((mount) => (mount.Type === "bind" && mount.Source ? [mount.Source] : []));
      found.push({ name: row.name.replace(/^\//, ""), ports: [...new Set(ports)], mounts });
    } catch {}
  }
  return found;
}

export interface Clashes {
  // A container's name on more than one engine: one of each is a copy nothing reaches.
  names: { name: string; engines: string[] }[];
  // A port of this Mac that containers on different engines publish: only one of them can hold it. Not the copies
  // above, which `names` already says.
  ports: { port: number; held: { engine: string; container: string }[] }[];
}
export function clashes(each: { name: string; containers: Container[] }[]): Clashes {
  const engines = new Map<string, string[]>();
  const held = new Map<number, { engine: string; container: string }[]>();
  for (const { name: engine, containers } of each)
    for (const container of containers) {
      engines.set(container.name, [...(engines.get(container.name) ?? []), engine]);
      for (const port of container.ports) held.set(port, [...(held.get(port) ?? []), { engine, container: container.name }]);
    }
  const names = [...engines].filter(([, on]) => on.length > 1).map(([name, on]) => ({ name, engines: on }));
  const ports = [...held]
    .filter(([, holders]) => holders.some((a) => holders.some((b) => a.engine !== b.engine && a.container !== b.container)))
    .map(([port, holders]) => ({ port, held: holders }))
    .sort((a, b) => a.port - b.port);
  return { names, ports };
}

// A team's containers on engines other than its own: those that mount a folder of its checkout or of its members'
// worktrees.
export function strays(roots: string[], others: { name: string; containers: Container[] }[]): { engine: string; containers: string[] }[] {
  const inside = (path: string): boolean => roots.some((root) => root !== "" && (path === root || path.startsWith(`${root}/`)));
  return others
    .map(({ name, containers }) => ({ engine: name, containers: containers.filter((container) => container.mounts.some(inside)).map((c) => c.name) }))
    .filter((found) => found.containers.length > 0);
}

// "a, b, c and 6 more".
export const some = (items: string[], most = 3): string =>
  items.length <= most ? items.join(", ") : `${items.slice(0, most).join(", ")} and ${items.length - most} more`;
