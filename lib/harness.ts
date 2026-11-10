// The team's harness manifest, .a6g/harness.json: what the team's own means of checking add to the operator's checks.
// The scaffolder writes it (the only lane that names it), a reviewer reviews it, and it merges like code; like
// team.json, the factory reads it from the team's checkout, never a worktree's copy, so a branch can't change the
// checks it's held to (a worktree's copy is read only to try a branch, recording nothing).
//
// It only adds: pages to check (joining team.json's pages.list), the sign-ins they need, how the app switches colour
// scheme, and where the end-to-end suite's Playwright configuration is. It holds no command: the factory runs the
// repository's own Playwright with that configuration. Whatever could loosen a check (the app's address, console
// messages to ignore, the smallest touch target, what a page's source is) stays the operator's, in team.json; and a
// branch that narrows what the manifest checks needs the operator's approval (narrowing, lib/commands/merge.ts).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PageSpec, PagesSettings, Team } from "./config.ts";

export const HARNESS_FILE = ".a6g/harness.json";
export const SCHEME_NAMES = ["light", "dark"];

// How a colour scheme is switched on, for apps that don't follow the browser's own setting.
export interface SchemeSetup {
  htmlClass?: string;
  localStorage?: Record<string, string>;
  cookie?: { name: string; value: string };
}
export interface HarnessPage {
  id: string;
  path: string;
  title?: string;
  // The sign-in state (auth.states) the page is seen with; none is signed out.
  as?: string;
  // CSS selectors painted over in screenshots: what changes on its own, or is personal (Article 8).
  mask?: string[];
}
export interface Harness {
  // The suite: the repository's Playwright configuration, and how long a whole run may take.
  e2e?: { config: string; timeoutMin: number };
  // The Playwright project in that configuration that signs in and saves each state, by name.
  auth?: { project: string; states: Record<string, string> };
  pages: HarnessPage[];
  schemes: Record<string, SchemeSetup>;
}

const ID = /^[\w-]+$/;
const CLASS = /^[A-Za-z_][\w-]*$/;
const KEYS = ["$schema", "e2e", "auth", "pages", "schemes"];
// A path inside the checkout: relative, and never climbing out.
const inside = (path: unknown): path is string =>
  typeof path === "string" && path.trim() !== "" && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");

// The manifest from its JSON, and what's wrong with it. A key the factory doesn't know is a problem, not a warning:
// the scaffolder writes it, and a typo would quietly check less.
export function parseHarness(input: unknown): { harness: Harness; problems: string[] } {
  const problems: string[] = [];
  const bad = (where: string, what: string): undefined => {
    problems.push(`${where}: ${what}`);
    return undefined;
  };
  const harness: Harness = { pages: [], schemes: {} };
  const record = (value: unknown, where: string, keys: string[] | null): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return bad(where, "an object");
    if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) bad(`${where}.${key}`, `not one of ${keys.join(", ")}`);
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, where: string): string | undefined =>
    value === undefined ? undefined : typeof value === "string" && value.trim() ? value : bad(where, "text");
  const root = record(input, "harness.json", KEYS);
  if (!root) return { harness, problems: input === undefined ? ["harness.json: empty"] : problems };

  const e2e = record(root.e2e, "e2e", ["config", "timeoutMin"]);
  if (e2e) {
    const config = inside(e2e.config) ? e2e.config : bad("e2e.config", "the Playwright configuration file, a path inside the checkout");
    const timeout = e2e.timeoutMin ?? 20;
    if (!(typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 1 && timeout <= 240)) bad("e2e.timeoutMin", "whole minutes, 1 to 240");
    else if (config) harness.e2e = { config, timeoutMin: timeout };
  }
  const auth = record(root.auth, "auth", ["project", "states"]);
  if (auth) {
    const project =
      typeof auth.project === "string" && ID.test(auth.project) ? auth.project : bad("auth.project", "the name of the Playwright project that signs in");
    const states: Record<string, string> = {};
    for (const [name, path] of Object.entries(record(auth.states, "auth.states", null) ?? {})) {
      if (!ID.test(name)) bad(`auth.states.${name}`, "a name of letters, digits, _ and -");
      else if (!inside(path)) bad(`auth.states.${name}`, "a path inside the checkout, where the project saves it");
      else states[name] = path;
    }
    if (!Object.keys(states).length) bad("auth.states", 'at least one sign-in state, by name ({"staff": "e2e/.auth/staff.json"})');
    if (!harness.e2e) bad("auth", "sign-ins are made by a project in e2e.config, so the manifest needs e2e");
    if (project && Object.keys(states).length) harness.auth = { project, states };
  }
  if (root.pages !== undefined && !Array.isArray(root.pages)) bad("pages", "a list of pages");
  for (const [i, value] of (Array.isArray(root.pages) ? root.pages : []).entries()) {
    const where = `pages[${i}]`;
    const spec = record(value, where, ["id", "path", "title", "as", "mask"]);
    if (!spec) continue;
    const id = typeof spec.id === "string" && ID.test(spec.id) ? spec.id : bad(`${where}.id`, "letters, digits, _ and - (it names the page's files)");
    const path =
      typeof spec.path === "string" && spec.path.startsWith("/") ? spec.path : bad(`${where}.path`, "the page's path on the app, starting with /");
    const title = text(spec.title, `${where}.title`);
    const as = text(spec.as, `${where}.as`);
    if (as !== undefined && !harness.auth?.states[as])
      bad(`${where}.as`, `a sign-in state auth.states names (${Object.keys(harness.auth?.states ?? {}).join(", ") || "none yet"})`);
    let mask: string[] | undefined;
    if (spec.mask !== undefined) {
      if (!Array.isArray(spec.mask)) bad(`${where}.mask`, "a list of CSS selectors");
      else
        mask = spec.mask.flatMap((selector, j) =>
          typeof selector === "string" && selector.trim() ? [selector] : (bad(`${where}.mask[${j}]`, "a CSS selector") ?? [])
        );
    }
    if (id === undefined || path === undefined) continue;
    if (harness.pages.some((page) => page.id === id)) {
      bad(`${where}.id`, `more than one page is named ${id}`);
      continue;
    }
    harness.pages.push({ id, path, ...(title === undefined ? {} : { title }), ...(as === undefined ? {} : { as }), ...(mask?.length ? { mask } : {}) });
  }
  for (const [name, value] of Object.entries(record(root.schemes, "schemes", null) ?? {})) {
    const where = `schemes.${name}`;
    if (!SCHEME_NAMES.includes(name)) {
      bad(where, `a colour scheme (${SCHEME_NAMES.join(", ")})`);
      continue;
    }
    const spec = record(value, where, ["htmlClass", "localStorage", "cookie"]);
    if (!spec) continue;
    const setup: SchemeSetup = {};
    const htmlClass = text(spec.htmlClass, `${where}.htmlClass`);
    if (htmlClass !== undefined) {
      if (CLASS.test(htmlClass)) setup.htmlClass = htmlClass;
      else bad(`${where}.htmlClass`, "one class name");
    }
    const storage = record(spec.localStorage, `${where}.localStorage`, null);
    if (storage) {
      setup.localStorage = {};
      for (const [key, v] of Object.entries(storage)) {
        if (typeof v === "string") setup.localStorage[key] = v;
        else bad(`${where}.localStorage.${key}`, "text");
      }
    }
    const cookie = record(spec.cookie, `${where}.cookie`, ["name", "value"]);
    if (cookie) {
      const cookieName = text(cookie.name, `${where}.cookie.name`);
      const cookieValue = typeof cookie.value === "string" ? cookie.value : bad(`${where}.cookie.value`, "text");
      if (cookieName !== undefined && cookieValue !== undefined) setup.cookie = { name: cookieName, value: cookieValue };
    }
    if (!Object.keys(setup).length) bad(where, "how the app switches to it: htmlClass, localStorage or cookie");
    else harness.schemes[name] = setup;
  }
  return { harness, problems };
}

// The manifest's text: in a checkout or worktree (`dir`), or at a commit of the repository at `dir` (`ref`, for a
// branch the merge queue checks). Null when there's none.
export function harnessSource(dir: string, ref?: string): string | null {
  if (ref) {
    const shown = spawnSync("git", ["show", `${ref}:${HARNESS_FILE}`], { cwd: dir, encoding: "utf8" });
    return shown.status === 0 ? shown.stdout : null;
  }
  return existsSync(join(dir, HARNESS_FILE)) ? readFileSync(join(dir, HARNESS_FILE), "utf8") : null;
}

// The manifest, read as harnessSource finds it. Null with no problems when there's none.
export function readHarness(dir: string, ref?: string): { harness: Harness | null; problems: string[] } {
  const source = harnessSource(dir, ref);
  if (source === null) return { harness: null, problems: [] };
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    return { harness: null, problems: [`${HARNESS_FILE}: not JSON (${(error as Error).message})`] };
  }
  const { harness, problems } = parseHarness(input);
  return { harness, problems: problems.map((problem) => `${HARNESS_FILE} ${problem}`) };
}

// Whether the team's journeys need their specs passing: the operator's word (team.json harness.journeys), else exactly
// when the team's checkout has a suite to prove them with. A team with no suite yet closes its journeys as it always
// did, and the finish line asks every journey's tests once there is one.
export const journeysRequired = (home: string, team: Team): boolean =>
  team.harness.journeys === "auto" ? Boolean(readHarness(home).harness?.e2e) : team.harness.journeys === "required";

// What a branch's manifest checks less than the integration branch's: the operator's call (Article 5). Pages gone,
// or seen at another path or signed in otherwise; the suite or its sign-ins gone, or another configuration.
export function narrowing(before: Harness | null, after: Harness | null): string[] {
  if (!before) return [];
  const found: string[] = [];
  const now = after ?? { pages: [], schemes: {} };
  for (const page of before.pages) {
    const same = now.pages.find((p) => p.id === page.id);
    if (!same) found.push(`page ${page.id} is no longer checked`);
    else if (same.path !== page.path) found.push(`page ${page.id} moves from ${page.path} to ${same.path}`);
    else if ((same.as ?? "") !== (page.as ?? ""))
      found.push(`page ${page.id} is seen ${same.as ? `as ${same.as}` : "signed out"} instead of ${page.as ? `as ${page.as}` : "signed out"}`);
  }
  if (before.e2e && !now.e2e) found.push("the end-to-end suite is no longer run");
  else if (before.e2e && now.e2e && before.e2e.config !== now.e2e.config)
    found.push(`the suite's configuration moves from ${before.e2e.config} to ${now.e2e.config}`);
  if (before.auth && !now.auth) found.push("the sign-ins are no longer made");
  for (const name of Object.keys(before.auth?.states ?? {}))
    if (before.auth && now.auth && !now.auth.states[name]) found.push(`the sign-in ${name} is no longer made`);
  for (const scheme of Object.keys(before.schemes)) if (!now.schemes[scheme]) found.push(`the ${scheme} scheme's set-up is gone`);
  return found;
}

// What a6g pages checks: the operator's settings and pages (team.json), with the manifest's pages after them, its
// sign-ins and its scheme set-up.
export type PageCheck = PageSpec & Pick<HarnessPage, "as" | "mask">;
export interface PagePlan extends PagesSettings {
  list: PageCheck[];
  schemeSetup: Record<string, SchemeSetup>;
  minTarget: number;
  auth?: { project: string; states: Record<string, string> };
  e2eConfig?: string;
  // The pages the manifest added (the team's own), by id.
  fromHarness: string[];
}
// The smallest touch target on a phone when team.json doesn't say: WCAG 2.2's AA minimum.
export const DEFAULT_TARGET = 24;
export function pagePlan(team: Team, harness: Harness | null): PagePlan {
  const operator = team.pages ?? {};
  const listed = operator.list ?? [];
  const added = (harness?.pages ?? []).filter((page) => !listed.some((own) => own.id === page.id));
  const health = team.environment.health.find((url) => /^https?:\/\//.test(url));
  const appUrl = operator.appUrl ?? (health ? new URL(health).origin : undefined);
  return {
    ...operator,
    ...(appUrl ? { appUrl } : {}),
    list: [...listed, ...added],
    schemeSetup: harness?.schemes ?? {},
    minTarget: operator.minTarget ?? DEFAULT_TARGET,
    ...(harness?.auth ? { auth: harness.auth } : {}),
    ...(harness?.e2e ? { e2eConfig: harness.e2e.config } : {}),
    fromHarness: added.map((page) => page.id),
  };
}
