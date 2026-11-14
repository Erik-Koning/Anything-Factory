// a6g init [<repo>] [--name <team>] [--branch <integration>] [--base <ref>] [--checkout <dir> | --in-place]
//          [--owner <email>] [--non-technical] [--model <name>] [--no-interview]
//          [--title <title>] [--store files|mongo] [--goal-file <file>]
//
// Sets up a team in a repository:
// 1. Detects what it can: git, package manager and scripts, what CI runs, how the repository reaches outside the
//    machine, its tests and UI, the agent configuration it already has.
// 2. Makes the team's checkout: by default a worktree beside the repository (<repo>-a6g) on a new integration
//    branch, so the team never works in the operator's own checkout. --in-place uses the repository itself, switched
//    to the integration branch (made from the base if it's new).
// 3. Writes a draft .a6g/ from what it found (team.json, brief, notes, rubric, adapters). Where nothing is built yet,
//    the draft holds a design check-in: the team builds the foundation, then asks the operator to agree it before any
//    feature. --non-technical says the operator has no view on the platform or the stack, so the team is never to
//    ask them about either (and there's no check-in).
// 4. Opens the setup agent (claude --agent a6g:setup) in the team's checkout to interview the operator, finish
//    .a6g/, prove it with a6g check --run, and register and start the team if the operator says so. Its guard lets
//    it write only .a6g/. It runs on Fable unless --model names another (fable, opus, sonnet, haiku, or a model id):
//    what it settles here, every task after is built on.
//
// A project started from the web app (lib/commands/projects.ts) drafts with --no-interview, its title, its tasks in
// MongoDB (--store mongo) and the operator's goal from the form (--goal-file), then runs the setup agent with nobody
// there (setupUnattended, below).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { normalize, TEAM_NAME } from "../config.ts";
import { detect, draftTeam, hasApp } from "../detect.ts";
import { MODEL_ID, modelId } from "../models.ts";
import { FACTORY_ROOT, PACKAGE, versionDir } from "../paths.ts";
import { operatorOnly } from "../session.ts";
import * as t3 from "../t3.ts";
import { mongoStore } from "../tasks/mongo.ts";
import { hasUri, readUri } from "../tasks/mongoUri.ts";
import type { Store } from "../tasks/store.ts";
import { die, git, gitOk, hash, parseArgs, readJson, text as optionText, which, writeJson } from "../util.ts";

const TEMPLATES = join(FACTORY_ROOT, "templates", "team");

function fill(name: string, values: Record<string, string>): string {
  return readFileSync(join(TEMPLATES, name), "utf8").replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
}

// A team name from the repository's folder: lowercase letters, digits and dashes, starting with a letter. A folder
// that starts with a digit gets "team-" in front ("2048" is team-2048); one with no usable characters, a hash.
export function teamName(folder: string): string {
  const slug = folder
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = /^[a-z]/.test(slug) ? slug : slug ? `team-${slug}` : `team-${hash(folder).slice(0, 6)}`;
  return name.slice(0, 31).replace(/-+$/, "");
}

// Why a team's name is taken in a store, or null when it's free: its published settings (on the web app, or taken off
// it: the name stays), a task, or a control other than an ask to start it from the web app and its machine's word on
// it (lib/tasks/start.ts), which come before the team.
export async function nameTaken(store: Pick<Store, "team" | "tasks" | "controls">): Promise<string | null> {
  if (await store.team()) return "a team by that name has published its settings there";
  if ((await store.tasks.all()).length) return "tasks are filed under it";
  if ((await store.controls.all()).some((c) => c.kind !== "start" && c.kind !== "starting")) return "a team's controls are recorded under it";
  return null;
}

const shellWord = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

export async function init(argv: string[]): Promise<number> {
  operatorOnly("init");
  const { positional, options } = parseArgs(argv, { booleans: ["in-place", "no-interview", "non-technical"] });
  const model = modelId(optionText(options["model"]) ?? "fable");
  if (!MODEL_ID.test(model)) die(`--model ${model}: a model's name (fable, opus, sonnet, haiku) or its id`);
  // Only the interview needs Claude Code; --no-interview writes the draft without it.
  if (!options["no-interview"] && !which("claude")) die("Claude Code (claude) isn't on PATH (or pass --no-interview to write the draft only)");
  const repo = (() => {
    try {
      return realpathSync(git(resolve(positional[0] ?? "."), "rev-parse", "--show-toplevel"));
    } catch {
      die(`${resolve(positional[0] ?? ".")} isn't in a git repository`);
    }
  })();
  const problems = t3.contract();
  if (problems.length) console.warn(`a6g: T3 Code isn't ready yet; the team can't start until it is (a6g doctor):\n  - ${problems.join("\n  - ")}`);

  const found = detect(repo);
  const given = optionText(options["name"]);
  if (given !== undefined && !TEAM_NAME.test(given)) die(`--name ${given}: lowercase letters, digits and dashes, starting with a letter, up to 31`);
  const name = given ?? teamName(basename(repo));
  const branch = optionText(options["branch"]) ?? "a6g/next";
  const base = optionText(options["base"]) ?? found.git.defaultBranch ?? "main";
  const port = 9300 + (Number.parseInt(hash(name), 16) % 90);
  const draft = draftTeam(found, { name, branch, owner: optionText(options["owner"]), technical: !options["non-technical"] });
  draft.base = base;
  // What a project started from the web app is given (lib/commands/projects.ts): its title, its tasks in MongoDB,
  // where the app reads them, and the operator's goal from the form.
  const title = optionText(options["title"]);
  if (title !== undefined) draft.title = title;
  // Its tasks in MongoDB, where the web app shows the team, by default on a Mac connected to it; in files otherwise.
  const asked = optionText(options["store"]);
  if (asked !== undefined && asked !== "files" && asked !== "mongo") die(`--store ${asked}: files (in the run folder) or mongo (a6g connect mongo)`);
  const store = asked ?? (hasUri() ? "mongo" : "files");
  if (store === "mongo") draft.tasks = { store: "mongo" };
  const goalFile = optionText(options["goal-file"]);
  let goal: string | null = null;
  if (goalFile !== undefined) {
    try {
      goal = readFileSync(resolve(goalFile), "utf8").trim() || null;
    } catch {
      die(`--goal-file: ${resolve(goalFile)} can't be read`);
    }
  }
  const app = hasApp(found);
  if (app) draft.environment = { ...draft.environment, health: [`http://localhost:${port}/`] };
  // Refuse a draft that couldn't load (a protected integration branch, a bad owner) before making anything.
  const { team: drafted, problems: draftProblems } = normalize(draft, repo);
  if (draftProblems.length) die(`the team can't be set up like that:\n  - ${draftProblems.join("\n  - ")}`);

  // A new team whose tasks go in MongoDB mustn't share another's: its name mustn't be taken there, unless the checkout
  // is that team's own already (init run again).
  const ownCheckout = options["in-place"] ? repo : resolve(optionText(options["checkout"]) ?? join(dirname(repo), `${basename(repo)}-a6g`));
  if (store === "mongo" && !existsSync(join(ownCheckout, ".a6g", "team.json"))) {
    let taken: string | null = null;
    try {
      const mongo = await mongoStore({ name, tasks: { store: "mongo", database: drafted.tasks.database, lead: null } }, readUri());
      try {
        taken = await nameTaken(mongo);
      } finally {
        await mongo.close();
      }
    } catch (error) {
      console.warn(
        `a6g: couldn't check in MongoDB that the name ${name} is free (${(error as Error).message.split("\n")[0]}); a6g register publishes the team under it`
      );
    }
    if (taken)
      die(
        `the name ${name} is taken in MongoDB: ${taken}. Choose another with --name${asked === undefined ? ", or keep its tasks on this Mac with --store files" : ""}`
      );
  }

  // The team's checkout.
  let checkout: string;
  if (options["in-place"]) {
    checkout = repo;
    let current: string | null = null;
    try {
      current = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD");
    } catch {}
    if (current !== branch) {
      if (git(repo, "status", "--porcelain", "--untracked-files=no"))
        die(`${repo} has uncommitted changes; commit or stash them, so init can switch it to ${branch}`);
      const exists = gitOk(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      const switched = spawnSync("git", exists ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch, base], { cwd: repo, encoding: "utf8" });
      if (switched.status !== 0) die(`couldn't check out ${branch} in ${repo}: ${switched.stderr.trim()}`);
      console.info(`a6g: switched ${repo} to ${exists ? branch : `a new branch ${branch} (from ${base})`}`);
    }
  } else {
    checkout = ownCheckout;
    if (!existsSync(checkout)) {
      const made = gitOk(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)
        ? spawnSync("git", ["worktree", "add", checkout, branch], { cwd: repo, encoding: "utf8" })
        : spawnSync("git", ["worktree", "add", "-b", branch, checkout, base], { cwd: repo, encoding: "utf8" });
      if (made.status !== 0) die(`couldn't make the team's checkout at ${checkout}: ${made.stderr.trim()}`);
      console.info(`a6g: made the team's checkout ${checkout} on ${branch} (from ${base})`);
    } else {
      let on = "";
      try {
        on = git(checkout, "symbolic-ref", "--quiet", "--short", "HEAD");
      } catch {}
      console.info(`a6g: using the existing checkout ${checkout}${on === branch ? "" : ` (on ${on || "no branch"}, not ${branch}: check it out there)`}`);
    }
  }

  // The draft .a6g/, never overwriting what's there.
  const dir = join(checkout, ".a6g");
  const write = (path: string, text: string, mode?: number): void => {
    const file = join(dir, path);
    if (existsSync(file)) return console.info(`  kept .a6g/${path}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (mode) chmodSync(file, mode);
    console.info(`  wrote .a6g/${path}`);
  };
  const runners: Record<string, string> = { pnpm: "pnpm", yarn: "yarn", bun: "bun run", npm: "npm run" };
  const runner = runners[found.packageManager ?? ""] ?? "npm run";
  const checks = (names: string[]) =>
    names
      .filter((script) => found.scripts[script])
      .map((script) => `check ${script.replace(/[^\w-]/g, "-")} ${runner} ${script}`)
      .join("\n");
  write("team.json", `${JSON.stringify(draft, null, 2)}\n`);
  write(".gitignore", readFileSync(join(TEMPLATES, "gitignore"), "utf8"));
  write(
    "brief.md",
    fill("brief.md", {
      GOAL: goal ?? "(The operator's direction goes here.)",
      FINISH: "(How done is proven: the finish command in team.json.)",
      BUDGET: "(None given.)",
    })
  );
  write("direction.md", readFileSync(join(TEMPLATES, "direction.md"), "utf8"));
  write(
    "notes.md",
    fill("notes.md", {
      ENVIRONMENT: app
        ? `The app runs on http://localhost:${port}/ (.a6g/adapters/env.sh).`
        : "No app was found to run (no UI, no dev or start script, no HTML), so team.json names no environment and no after-merge step. If there is one, fill in .a6g/adapters/env.sh and set environment.script, its health URL and afterMerge.",
      COMMANDS: Object.keys(found.scripts).length
        ? Object.entries(found.scripts)
            .map(([script, command]) => `- \`${runner} ${script}\`: \`${command}\``)
            .join("\n")
        : "(none detected)",
    })
  );
  if (found.ui.length) write("rubric.md", readFileSync(join(TEMPLATES, "rubric.md"), "utf8"));
  const full = checks(["build", "test:e2e"]);
  const install = found.installCommand ? `${found.installCommand} >/dev/null || { echo "install failed" >&2; exit 1; }` : ":";
  write(
    "adapters/gate.sh",
    fill("adapters/gate.sh", {
      QUICK_CHECKS:
        [found.installCommand ? `check install ${found.installCommand}` : null, checks(["typecheck", "lint", "format:check", "test"])]
          .filter(Boolean)
          .join("\n") || "# (fill in: what CI runs first)",
      // An empty if-block is a syntax error, so a repository without these scripts gets a placeholder command.
      FULL_CHECKS: full ? full.replace(/^/gm, "  ") : "  : # (fill in: the rest of what CI runs)",
    }),
    0o755
  );
  // Written either way, ready to fill in: team.json names them only when there's an app to run.
  write(
    "adapters/env.sh",
    fill("adapters/env.sh", {
      PORT: String(port),
      INSTALL: install,
      SERVE: found.scripts["dev"] ? `${runner} dev` : "echo 'fill in: how to serve the app'",
    }),
    0o755
  );
  write("adapters/after-merge.sh", fill("adapters/after-merge.sh", { INSTALL: install }), 0o755);
  writeJson(join(dir, "run", "setup", "detect.json"), found);

  const report = join(dir, "run", "setup", "detect.json");
  console.info(
    `\na6g: detected ${found.packageManager ?? "no package manager"}, ${found.ci.length} CI workflow(s), ${found.surfaces.length} way(s) out: ${found.surfaces.map((s) => s.id).join(", ") || "none"}`
  );
  if (found.security.length) console.info(`a6g: it has ${found.security.join(", ")}, so the draft team has a security reviewer`);
  if (asked === undefined)
    console.info(
      store === "mongo"
        ? "a6g: its tasks go in MongoDB (this Mac is connected: a6g connect mongo), so the web app shows the team; --store files keeps them on this Mac"
        : "a6g: its tasks stay in files on this Mac, so the web app won't show the team; a6g connect mongo, then --store mongo, puts them where it does"
    );
  if (draft.operator?.designCheckIn)
    console.info("a6g: nothing is built here yet, so the draft team builds the foundation, then checks its design with you before any feature");
  if (draft.operator?.technical === false)
    console.info("a6g: the draft team chooses the platform and the stack itself, the safer way each time, and asks you only about the product");
  if (!existsSync(versionDir(PACKAGE.version)))
    console.warn(`a6g: the draft pins Anything Factory ${PACKAGE.version}, which isn't installed yet; run a6g self-install before a6g register`);
  if (options["no-interview"]) {
    // Members' worktrees are made from the integration branch, so .a6g/ must be committed there before the gate runs.
    console.info(
      [
        `a6g: draft written in ${dir}. Next:`,
        `  1. finish .a6g/ (the reference is ${join(FACTORY_ROOT, "docs", "team.md")})`,
        `  2. commit it on ${branch}: cd ${shellWord(checkout)} && git add .a6g && git commit -m "Anything Factory team: ${name}"`,
        "  3. a6g check --run (commit again after any fix)",
        `  4. a6g register, then a6g start ${name}`,
      ].join("\n")
    );
    return 0;
  }
  const first = `${setupOpening({ repo, checkout, branch, base, name, empty: found.empty, technical: draft.operator?.technical !== false })} Read them and the repository first, then interview me.`;
  const session = spawnSync(
    "claude",
    ["--plugin-dir", join(FACTORY_ROOT, "plugin"), "--agent", "a6g:setup", "--model", model, "--setting-sources", "project", first],
    {
      cwd: checkout,
      stdio: "inherit",
      env: { ...process.env, A6G_SETUP: "1", A6G_HOME_DIR: checkout, A6G_FACTORY: FACTORY_ROOT },
    }
  );
  return session.status ?? 0;
}

// How the setup agent's first message opens: where everything is, and what whoever started the setup already said.
function setupOpening(at: { repo: string; checkout: string; branch: string; base: string; name: string; empty: boolean; technical: boolean }): string {
  const dir = join(at.checkout, ".a6g");
  return [
    `Set up an Anything Factory team for the repository at ${at.repo}.`,
    `The team's checkout is ${at.checkout} on its integration branch ${at.branch} (from ${at.base}); the team is named ${at.name}.`,
    `The detection report is ${join(dir, "run", "setup", "detect.json")}. The draft is in ${dir}. The reference for team.json is ${join(FACTORY_ROOT, "docs", "team.md")}.`,
    ...(at.empty ? ["Nothing is built here yet: this is a new project, and its foundation is yours to propose."] : []),
    ...(at.technical ? [] : ["The draft says the operator isn't technical (operator.technical): whoever started this said so, so it stands."]),
  ].join(" ");
}

// What the setup agent may run when nobody is there to be asked (a team started from the web app,
// lib/commands/projects.ts): reading (its guard keeps it from secrets, as it keeps every agent), writing (its guard
// keeps that to .a6g/), and the few commands its instructions name. Nothing else is allowed, and no permission check
// is skipped: a call outside this list is refused, not asked about.
export const UNATTENDED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Write",
  "Edit",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(a6g check *)",
  "Bash(a6g doctor *)",
  "Bash(a6g help *)",
  "Bash(chmod *)",
  "Bash(bash -n *)",
];
const UNATTENDED_MIN = 45;

// Runs the setup agent with nobody there, on a checkout `a6g init --no-interview` drafted: it reads the repository and
// the goal in the brief, decides what it would have asked, and proves the result (plugin/agents/setup.md, "When the
// operator isn't there"). Its message goes on standard input, since the list of tools would otherwise take it for one
// more. Resolves to its exit status and what it printed.
export function setupUnattended(repo: string, checkout: string, { model = "fable" }: { model?: string } = {}): { code: number; out: string } {
  const team = readJson<{ name?: string; branch?: string; base?: string; operator?: { technical?: boolean } } | null>(
    join(checkout, ".a6g", "team.json"),
    null
  );
  if (!team?.name) return { code: 1, out: `${join(checkout, ".a6g", "team.json")} can't be read: a6g init --no-interview drafts it` };
  if (!which("claude")) return { code: 1, out: "Claude Code (claude) isn't on the watchdog's PATH on this machine" };
  let empty = false;
  try {
    empty = detect(repo).empty;
  } catch {}
  const first = [
    setupOpening({
      repo,
      checkout,
      branch: team.branch ?? "a6g/next",
      base: team.base ?? "main",
      name: team.name,
      empty,
      technical: team.operator?.technical !== false,
    }),
    "This setup is unattended: the operator started it from the web app and isn't at this machine, so nobody can answer you.",
    `What they asked for is in ${join(checkout, ".a6g", "brief.md")}, under "What should exist when the team is done": their goal, in their words.`,
    'Follow "When the operator isn\'t there" in your instructions.',
  ].join(" ");
  const session = spawnSync(
    "claude",
    [
      "-p",
      "--plugin-dir",
      join(FACTORY_ROOT, "plugin"),
      "--agent",
      "a6g:setup",
      "--model",
      modelId(model),
      "--setting-sources",
      "project",
      "--allowedTools",
      UNATTENDED_TOOLS.join(","),
    ],
    {
      cwd: checkout,
      input: first,
      encoding: "utf8",
      timeout: UNATTENDED_MIN * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, A6G_SETUP: "1", A6G_UNATTENDED: "1", A6G_HOME_DIR: checkout, A6G_FACTORY: FACTORY_ROOT },
    }
  );
  const out = `${session.stdout ?? ""}${session.stderr ?? ""}`;
  if (session.error)
    return {
      code: 1,
      out: `${out}\n${(session.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? `the setup agent took more than ${UNATTENDED_MIN} minutes` : session.error.message}`,
    };
  return { code: session.status ?? 1, out };
}
