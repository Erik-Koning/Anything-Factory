// a6g pages: each page the team checks, at each viewport and colour scheme, in the factory's own Chromium (lib/browser.ts),
// so every team can check its pages from its first day. The pages are the operator's (team.json pages.list) and the
// team's harness manifest's (lib/harness.ts), seen signed in where a page says `as`. For each it records the HTTP
// status, where the page ended when that isn't where it was asked for, uncaught errors, console errors, horizontal
// overflow, axe's WCAG A/AA violations (serious and critical), touch targets under pages.minTarget on phones, text cut
// off by the box that clips it, controls whose focus can't be seen (on the first viewport and scheme), and a
// full-page screenshot with animations off and the manifest's masks painted over. The page is scrolled to its end and
// back first, so what loads lazily is there; the operator's `ignore` selectors are left out of every check in the page.
// A page that says who it `refuses` is then asked for as each of them, and has to be refused: sent to another path, or
// answered 401, 403 or 404.
// Results are keyed to the pages' source, so a change to it has to be checked again, and UX verdicts (a6g verdict ux
// <page>) count only for the source they saw. When the UX specialist passes a page at a commit the factory checked,
// its screenshots are kept, and later runs say which pages look different since: where an audit starts.
//
//   a6g pages run [ids…]                     check the team's app and record the results (the planner)
//   a6g pages shots --base <url> [--out dir] [--path /x] [ids…]   the same checks on any server, or any path (such
//                                            as the original page, or a branch's preview), recording nothing
//   a6g pages status [--brief]               one line per page
//   a6g pages done                           exit 0 only when every page meets the finish line
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserProblem, factoryChromium } from "../browser.ts";
import type { LoadedTeam, Viewport } from "../config.ts";
import { type PageCheck, type PagePlan, pagePlan, readHarness, SIGNED_OUT } from "../harness.ts";
import { acquire } from "../lock.ts";
import { FACTORY_ROOT, stateDir, workDir } from "../paths.ts";
import { teamSession } from "../session.ts";
import { browserMissing, runPlaywright, specsOf } from "../suite.ts";
import { readJson, writeJson } from "../util.ts";

// The part of Playwright this uses.
interface ConsoleMessage {
  type(): string;
  text(): string;
  location(): { url?: string } | undefined;
}
interface Tab {
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(event: "console", listener: (message: ConsoleMessage) => void): void;
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<{ status(): number } | null>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  // A script's source, run as the debugger runs it: the page's content security policy has no say over it.
  evaluate(script: string): Promise<unknown>;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  locator(selector: string): unknown;
  keyboard: { press(key: string): Promise<void> };
  screenshot(options: {
    path?: string;
    fullPage: boolean;
    scale?: "css";
    clip?: Region;
    animations?: "disabled";
    caret?: "hide";
    mask?: unknown[];
  }): Promise<Buffer>;
}
interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Context {
  newPage(): Promise<Tab>;
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>;
  addCookies(cookies: { name: string; value: string; url: string }[]): Promise<void>;
  close(): Promise<void>;
}
interface Browser {
  newContext(options: Record<string, unknown>): Promise<Context>;
  close(): Promise<void>;
}
interface Axe {
  run(context: unknown, options: unknown): Promise<{ violations: { id: string; impact?: string; nodes: unknown[] }[] }>;
}

// One page at one viewport and colour scheme, and a page's result across them.
export interface PageRun {
  viewport: string;
  scheme: string;
  problems: string[];
  status?: number;
  overflow?: number;
  axe?: string[];
  shot?: string;
  slices?: string[];
  // The screenshot's hash, and how much of it differs from the look the UX specialist passed (0 to 1).
  look?: string;
  differs?: number;
  // The focus walk: how many of the page's keyboard stops it walked.
  focus?: { walked: number; stops: number };
}
// One of those a page refuses: how the app refused them, or what's wrong (it served them the page, it answered
// something else, or nothing could be told).
export interface Refusal {
  state: string;
  how?: string;
  problem?: string;
}
export interface PageResult {
  passed: boolean;
  runs: PageRun[];
  refusals?: Refusal[];
}
// Where a page ended for one sign-in state, or signed out: its status, and the path it ended at when that's another.
interface Landing {
  status: number;
  elsewhere: string | null;
  error?: string;
}
interface SavedResult extends PageResult {
  hash: string;
  commit: string;
  at: string;
}
interface UxVerdict {
  verdict: string;
  sha: string;
}
// The screenshots kept when the UX specialist passed a page: state/looks/<page>/<viewport>-<scheme>.png.
interface KeptLooks {
  commit: string;
  at: string;
  files: Record<string, string>;
}

let home = "";
let team: LoadedTeam;
let plan: PagePlan;
let STATE = "";
let RESULTS = "";
let list: PageCheck[] = [];
const git = (...args: string[]): string => execFileSync("git", args, { cwd: home, encoding: "utf8" }).trim();
const pick = (ids: string[]): PageCheck[] => (ids.length ? list.filter((page) => ids.includes(page.id)) : list);
// A difference above this share of a screenshot's pixels is a different look, not rendering noise.
export const DIFFERS = 0.001;
const FOCUS_STOPS = 40;
// Focus shows when at least this many pixels around a control change with it: a one-pixel underline under a word.
const FOCUS_PIXELS = 8;
// Sign-in states older than this are made again before a page needs one.
const STATE_HOURS = 12;
// A refusal is the app's answer that the page isn't this visitor's: these, or sending them to another path.
const REFUSED = [401, 403, 404];
// How many of a state's pages are tried to show its sign-in is live.
const PROOF_PAGES = 3;
// What a refusal says when the app served the page: the worst a page check finds (lib/verify.ts files it a blocker).
const SERVED_TO = "served to";
const SERVED_OUT = "served signed out";
export const servedIt = (refusal: Refusal): boolean => Boolean(refusal.problem?.startsWith("served "));

// What a page's result depends on: the files under the pages' source paths at a commit, minus the paths that
// belong only to other pages (a page's "exclude"), so a change to one page doesn't make another's verdict stale.
function sourceHash(ref = "HEAD", page: Partial<PageCheck> = {}): string {
  let listing = "";
  try {
    listing = execFileSync("git", ["ls-tree", "-r", ref, "--", ...(plan.content ?? [])], {
      cwd: home,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  const exclude = (page.exclude ?? []).map((rule) => new RegExp(rule));
  const files = listing.split("\n").filter((line) => line && !exclude.some((rule) => rule.test(line.split("\t")[1] ?? "")));
  return createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 16);
}

const looksDir = (state: string, id: string): string => join(state, "looks", id);
const keptLooks = (state: string, id: string): KeptLooks | null => readJson<KeptLooks | null>(join(looksDir(state, id), "looks.json"), null);
const fileHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);

// Pages that ask to be seen signed in as a state the manifest doesn't make (an operator's page, since the manifest's
// own are checked as it's read). a6g check and the start of a run refuse them.
export function unknownSignIns(pages: PagePlan): string[] {
  const states = Object.keys(pages.auth?.states ?? {});
  const has = states.length ? `the harness manifest's auth.states has ${states.join(", ")}` : "the harness manifest has no auth.states";
  return pages.list.flatMap((page) => (page.as && !states.includes(page.as) ? [`page ${page.id}: as "${page.as}" names no sign-in state (${has})`] : []));
}

// Makes the sign-in states the chosen pages need (those they're seen as, and those they refuse), with the repository's
// own Playwright (the manifest's auth project), when one is missing or older than STATE_HOURS. Returns what went wrong, by state. A sign-in that fails fails its
// pages: the state an earlier run left may be a session the app has since ended, so it's never used in its place.
async function signIn(dir: string, base: string, chosen: PageCheck[]): Promise<Record<string, string>> {
  const needed = [...new Set(chosen.flatMap((page) => [...(page.as ? [page.as] : []), ...(page.refuses ?? []).filter((state) => state !== SIGNED_OUT)]))];
  if (!needed.length) return {};
  const auth = plan.auth;
  const problems: Record<string, string> = {};
  if (!auth || !plan.e2eConfig) {
    for (const name of needed) problems[name] = `the sign-in ${name} needs the harness manifest's auth project`;
    return problems;
  }
  const made = (name: string): number => {
    const path = join(dir, auth.states[name] ?? "");
    return existsSync(path) ? statSync(path).mtimeMs : 0;
  };
  const stale: string[] = [];
  for (const name of needed) {
    if (!Object.hasOwn(auth.states, name))
      problems[name] = `as "${name}" names no sign-in state (the harness manifest's auth.states has ${Object.keys(auth.states).join(", ")})`;
    else if (Date.now() - made(name) > STATE_HOURS * 3_600_000) stale.push(name);
  }
  if (!stale.length) return problems;
  // A second's grace: some filesystems keep a file's time to the second.
  const started = Date.now() - 1000;
  const ran = await runPlaywright(dir, {
    config: plan.e2eConfig,
    args: ["--project", auth.project],
    env: { PLAYWRIGHT_BASE_URL: base, A6G_NAMESPACE: `pages-${Date.now().toString(36)}` },
    timeoutMin: 5,
    work: join(workDir(home), "pages-auth"),
  });
  const missing = browserMissing(specsOf(ran.report, dir));
  const failed = ran.status === 0 ? "" : `the sign-in project ${auth.project} ${ran.timedOut ? "timed out" : (missing ?? `exited ${ran.status}`)}`;
  if (failed) console.error(`pages: ${failed}\n${ran.tail}`);
  for (const name of stale) {
    if (failed) problems[name] = `the sign-in ${name} failed (${failed}), so the page wasn't checked`;
    else if (made(name) < started) problems[name] = `the sign-in ${name} wasn't made (${auth.project} didn't write ${auth.states[name]})`;
  }
  return problems;
}

async function check(base: string, chosen: PageCheck[], outDir: string | null, dir: string): Promise<Record<string, PageResult>> {
  const missing = browserProblem();
  const chromium = factoryChromium() as unknown as { launch(): Promise<Browser> } | null;
  if (!chromium || missing) throw new Error(missing ?? "the factory's Playwright isn't installed");
  // axe's source, run in each page by evaluation: a page's content security policy refuses a script tag, and the
  // policy stays on, so what it breaks of the page's own still shows.
  const axePath = join(FACTORY_ROOT, "node_modules/axe-core/axe.min.js");
  const axeSource = existsSync(axePath) ? readFileSync(axePath, "utf8") : null;
  const trim = (path: string): string => path.replace(/\/+$/, "");
  // Where a tab ended, when that isn't the path it was asked for.
  const elsewhereOf = (tab: Tab, asked: URL): string | null => {
    const ended = new URL(tab.url());
    if (ended.origin === asked.origin && trim(ended.pathname) === trim(asked.pathname)) return null;
    return ended.origin === asked.origin ? ended.pathname : ended.origin + ended.pathname;
  };
  const ignore = (plan.ignoreConsole ?? []).map((rule) => new RegExp(rule, "i"));
  const viewports: Viewport[] = plan.viewports ?? [
    { id: "desktop", width: 1440, height: 900 },
    { id: "laptop", width: 1024, height: 768 },
    { id: "phone", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
  ];
  const schemes = plan.schemes ?? ["light", "dark"];
  const signInProblems = await signIn(dir, base, chosen);
  const browser = await chromium.launch();
  const results: Record<string, PageResult> = {};
  // Where each page ended for each state it was asked for as, at the first size and scheme: asked once a run.
  const landings = new Map<string, Landing>();
  const landingKey = (page: PageCheck, state: string): string => `${page.id}\0${state}`;
  // A blank page for comparing screenshots, where no page's own security policy can refuse an image.
  const blank = await browser.newContext({});
  const comparer = await blank.newPage();
  try {
    for (const page of chosen) {
      const runs: PageRun[] = [];
      const kept = outDir ? keptLooks(STATE, page.id) : null;
      for (const [vi, viewport] of viewports.entries()) {
        // The page's own schemes when the operator says it hasn't them all: a page with no dark variant has no dark
        // run, and nothing to differ from light.
        for (const [si, scheme] of (page.schemes ?? schemes).entries()) {
          const run: PageRun = { viewport: viewport.id, scheme, problems: [] };
          const signInProblem = page.as ? signInProblems[page.as] : undefined;
          if (signInProblem) {
            run.problems.push(signInProblem);
            runs.push(run);
            continue;
          }
          const setup = plan.schemeSetup[scheme] ?? {};
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            isMobile: viewport.isMobile ?? false,
            hasTouch: viewport.isMobile ?? false,
            deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
            colorScheme: scheme,
            reducedMotion: "no-preference",
            ...(page.as && plan.auth ? { storageState: join(dir, plan.auth.states[page.as] ?? "") } : {}),
          });
          // The app's own way into a scheme, for apps that don't follow the browser's: local storage before it loads,
          // a cookie, and a class on <html> as soon as there is one.
          await context.addInitScript(
            ({ storage, htmlClass }: { storage: Record<string, string>; htmlClass: string | null }) => {
              try {
                for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
              } catch {}
              if (htmlClass) {
                const add = () => document.documentElement?.classList.add(htmlClass);
                add();
                document.addEventListener("DOMContentLoaded", add);
              }
            },
            { storage: setup.localStorage ?? {}, htmlClass: setup.htmlClass ?? null }
          );
          if (setup.cookie) await context.addCookies([{ ...setup.cookie, url: base }]);
          const tab = await context.newPage();
          const errors: string[] = [];
          const consoleErrors: string[] = [];
          tab.on("pageerror", (error) => errors.push((String(error.message).split("\n")[0] ?? "").slice(0, 200)));
          tab.on("console", (message) => {
            if (message.type() !== "error") return;
            const text = message.text();
            // Rules match the text or the URL it came from ("Failed to load resource" names no URL itself).
            const url = message.location()?.url ?? "";
            const seen = `${text} ${url}`;
            if (!ignore.some((rule) => rule.test(seen)))
              consoleErrors.push(`${(text.split("\n")[0] ?? "").slice(0, 160)}${url ? ` (${url.replace(base, "")})` : ""}`);
          });
          try {
            const asked = new URL(page.path, base);
            const response = await tab.goto(asked.href, { waitUntil: "load", timeout: 120_000 });
            run.status = response?.status() ?? 0;
            await tab.waitForTimeout(plan.settleMs ?? 1500);
            // A page is checked where it was asked for. One that ends at another path (a session the app refused
            // lands on its sign-in page) is photographed, and none of its checks are taken for this page's.
            const where = elsewhereOf(tab, asked);
            const elsewhere = where !== null;
            if (elsewhere)
              run.problems.push(
                `ended at ${where} instead of ${asked.pathname}${page.as ? ` (seen as ${page.as}: the app didn't take the sign-in)` : ""}`
              );
            if (vi === 0 && si === 0) landings.set(landingKey(page, page.as ?? SIGNED_OUT), { status: run.status, elsewhere: where });
            // A framework may take the class off as it starts: put it back before looking.
            if (setup.htmlClass) await tab.evaluate((cls: string) => document.documentElement.classList.add(cls), setup.htmlClass);
            // The whole page before any of it is measured: what loads or shows only once it's scrolled to.
            await tab.evaluate(scrollThrough);
            // What the operator's rules leave out of every check below; one that isn't a selector is said, not obeyed.
            const unreadable = await tab.evaluate(badSelectors, page.ignore ?? []);
            if (unreadable.length) run.problems.push(`ignore: not a selector: ${unreadable.join(", ")}`);
            const leaveOut = (page.ignore ?? []).filter((rule) => !unreadable.includes(rule));
            if (!elsewhere) {
              run.overflow = await tab.evaluate(overflowBy, leaveOut);
              if (axeSource) {
                await tab.evaluate(axeSource);
                run.axe = await tab.evaluate(async (exclude: string[]) => {
                  const result = await (window as unknown as { axe: Axe }).axe.run(
                    exclude.length ? { exclude: exclude.map((rule) => [rule]) } : document,
                    {
                      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
                    }
                  );
                  return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.nodes.length})`);
                }, leaveOut);
              }
              if (viewport.isMobile) {
                const small = await tab.evaluate(smallTargets, { min: plan.minTarget, ignore: leaveOut });
                if (small.count) run.problems.push(`${small.count} controls smaller than ${plan.minTarget}px: ${small.examples.join("; ")}`);
              }
              const clipped = await tab.evaluate(clippedText, leaveOut);
              if (clipped.length) run.problems.push(`text clipped by its box: ${clipped.join("; ")}`);
            }
            if (outDir) {
              mkdirSync(join(outDir, page.id), { recursive: true });
              run.shot = join(outDir, page.id, `${viewport.id}-${scheme}.png`);
              await shoot(tab, run, viewport, run.shot, page.mask ?? []);
              const before = kept?.files[`${viewport.id}-${scheme}`];
              if (!elsewhere) run.look = fileHash(run.shot);
              if (!elsewhere && before && existsSync(before) && !run.slices) run.differs = await difference(comparer, before, run.shot);
            }
            // Last, after the screenshot: walking a page's controls changes it (a form shows its errors as each
            // field is left).
            if (!elsewhere && vi === 0 && si === 0) {
              const walk = await focusRings(tab, comparer, leaveOut);
              run.focus = { walked: walk.walked, stops: walk.stops };
              const more = walk.walked < walk.stops ? ` (the page has ${walk.stops})` : "";
              if (walk.missing.length)
                run.problems.push(`no visible focus on ${walk.missing.length} of ${walk.walked} stops${more}: ${walk.missing.slice(0, 4).join("; ")}`);
              else if (!walk.walked && walk.stops) run.problems.push(`the keyboard reached none of the page's ${walk.stops} controls`);
            }
          } catch (error) {
            run.problems.push(`didn't load: ${String((error as Error).message).split("\n")[0]}`);
          }
          if (run.status && run.status >= 400) run.problems.push(`HTTP ${run.status}`);
          if ((run.overflow ?? 0) > 1) run.problems.push(`scrolls sideways by ${run.overflow}px`);
          if (run.axe?.length) run.problems.push(`axe: ${run.axe.join(", ")}`);
          if (errors.length) run.problems.push(`errors: ${errors.slice(0, 3).join(" | ")}`);
          if (consoleErrors.length) run.problems.push(`console: ${consoleErrors.slice(0, 3).join(" | ")}`);
          if (!axeSource) run.problems.push("axe-core not found (reinstall Anything Factory: a6g self-install)");
          runs.push(run);
          await context.close();
        }
      }
      // A scheme the manifest says how to switch to, that looks the same as light, wasn't switched: its checks saw
      // the light page twice.
      for (const run of runs) {
        if (run.scheme === "light" || !plan.schemeSetup[run.scheme] || !run.look) continue;
        const light = runs.find((other) => other.viewport === run.viewport && other.scheme === "light");
        if (light?.look === run.look)
          run.problems.push(`${run.scheme} looks the same as light: the harness manifest's set-up for ${run.scheme} doesn't switch this page`);
      }
      results[page.id] = { passed: runs.every((run) => !run.problems.length), runs };
    }

    // Who each page refuses. The page is asked for as each of them, once, at the first size and scheme.
    const land = async (page: PageCheck, state: string): Promise<Landing> => {
      const known = landings.get(landingKey(page, state));
      if (known) return known;
      const viewport = viewports[0] ?? { id: "desktop", width: 1440, height: 900 };
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile ?? false,
        hasTouch: viewport.isMobile ?? false,
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        colorScheme: (page.schemes ?? schemes)[0] ?? "light",
        ...(state !== SIGNED_OUT && plan.auth ? { storageState: join(dir, plan.auth.states[state] ?? "") } : {}),
      });
      let landing: Landing;
      try {
        const tab = await context.newPage();
        const asked = new URL(page.path, base);
        const response = await tab.goto(asked.href, { waitUntil: "load", timeout: 120_000 });
        await tab.waitForTimeout(plan.settleMs ?? 1500);
        landing = { status: response?.status() ?? 0, elsewhere: elsewhereOf(tab, asked) };
      } catch (error) {
        landing = { status: 0, elsewhere: null, error: String((error as Error).message).split("\n")[0] ?? "" };
      } finally {
        await context.close();
      }
      landings.set(landingKey(page, state), landing);
      return landing;
    };
    const refusedBy = ({ status, elsewhere, error }: Landing): string | null =>
      error !== undefined ? null : elsewhere !== null ? `ended at ${elsewhere}` : REFUSED.includes(status) ? `HTTP ${status}` : null;
    // A session the app has ended is sent to sign in wherever it goes, which looks like a refusal. So a refusal counts
    // only from a sign-in this run shows to be live: one of the state's own pages lands signed in, and the same page
    // is refused signed out. Null, or why nothing showed it.
    const proofs = new Map<string, string | null>();
    const live = async (state: string): Promise<string | null> => {
      const known = proofs.get(state);
      if (known !== undefined) return known;
      const own = list.filter((page) => page.as === state);
      // Those that say they refuse the signed-out first: they're the ones that can show it.
      const tried = [...own.filter((page) => page.refuses?.includes(SIGNED_OUT)), ...own.filter((page) => !page.refuses?.includes(SIGNED_OUT))].slice(
        0,
        PROOF_PAGES
      );
      let shown = false;
      for (const page of tried) {
        const signedIn = await land(page, state);
        if (signedIn.error !== undefined || signedIn.elsewhere !== null || signedIn.status >= 400) continue;
        if (refusedBy(await land(page, SIGNED_OUT))) {
          shown = true;
          break;
        }
      }
      const why = shown
        ? null
        : `nothing showed the sign-in ${state} is live: ${
            tried.length
              ? `of the pages seen as ${state}, none tried (${tried.map((page) => page.id).join(", ")}) lands signed in and is refused signed out`
              : `no page is seen as ${state}`
          }; a page only ${state} reaches, with "as": "${state}" and "refuses": ["${SIGNED_OUT}"], shows it`;
      proofs.set(state, why);
      return why;
    };
    for (const page of chosen) {
      const result = results[page.id];
      if (!page.refuses?.length || !result) continue;
      const refusals: Refusal[] = [];
      for (const state of page.refuses) {
        const unchecked = state === SIGNED_OUT ? null : (signInProblems[state] ?? (await live(state)));
        if (unchecked) {
          refusals.push({ state, problem: `not checked: ${unchecked}` });
          continue;
        }
        const landing = await land(page, state);
        const how = refusedBy(landing);
        if (how) refusals.push({ state, how });
        else if (landing.error !== undefined) refusals.push({ state, problem: `not checked: didn't load: ${landing.error}` });
        else if (landing.status >= 400)
          refusals.push({
            state,
            problem: `answered HTTP ${landing.status}, which is neither the page nor a refusal (another path, or ${REFUSED.join(", ")})`,
          });
        else refusals.push({ state, problem: state === SIGNED_OUT ? SERVED_OUT : `${SERVED_TO} ${state}` });
      }
      result.refusals = refusals;
      result.passed &&= refusals.every((refusal) => !refusal.problem);
    }
  } finally {
    await blank.close();
    await browser.close();
  }
  return results;
}

// Scrolls to the bottom of the page and back, so what loads or shows itself only once it's scrolled to (a lazy image,
// a section revealed on scroll) is there to be measured and photographed. Runs in the page.
async function scrollThrough(): Promise<void> {
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const page = document.scrollingElement ?? document.documentElement;
  // A page that grows as it's scrolled is followed for a hundred screens, no further.
  for (let step = 0; step < 100 && window.scrollY + window.innerHeight < page.scrollHeight - 1; step++) {
    window.scrollBy({ top: window.innerHeight, behavior: "instant" });
    await pause(50);
  }
  // Up to three seconds for the images that started on the way.
  for (let waited = 0; waited < 3000 && Array.from(document.images).some((image) => !image.complete && image.checkVisibility()); waited += 100)
    await pause(100);
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  await pause(50);
}

// The rules among these that aren't CSS selectors, which no check could read. Runs in the page.
function badSelectors(rules: string[]): string[] {
  return rules.filter((rule) => {
    try {
      document.querySelector(rule);
      return false;
    } catch {
      return true;
    }
  });
}

// How far the page scrolls sideways. When it does, what the operator's rules leave out is taken out of the layout
// and the page measured again. Runs in the page.
function overflowBy(ignore: string[]): number {
  const measure = () => document.documentElement.scrollWidth - window.innerWidth;
  const by = measure();
  if (by <= 1 || !ignore.length) return by;
  const taken = Array.from(document.querySelectorAll<HTMLElement>(ignore.join(","))).map((el) => ({
    el,
    value: el.style.getPropertyValue("display"),
    priority: el.style.getPropertyPriority("display"),
  }));
  for (const { el } of taken) el.style.setProperty("display", "none", "important");
  const without = measure();
  for (const { el, value, priority } of taken) {
    if (value) el.style.setProperty("display", value, priority);
    else el.style.removeProperty("display");
  }
  return without;
}

// Touch targets smaller than `min` CSS pixels on a phone. Only what a finger can reach is measured: not what's
// disabled, inert, hidden (from everyone, or from assistive technology), transparent, clipped to a pixel (text for
// screen readers, a collapsed menu), off the page or in a closed <details>. A control hidden under its label (a
// styled checkbox) is measured by the label, a checkbox or radio button with it, and a link in a sentence is
// excepted, as WCAG 2.5.8 excepts it: an inline link whose nearest block has words of its own. Runs in the page.
export function smallTargets({ min, ignore = [] }: { min: number; ignore?: string[] }): { count: number; examples: string[] } {
  const describe = (el: Element): string => {
    const label = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${label ? ` "${label}"` : ""}`;
  };
  const selector =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[tabindex]:not([tabindex="-1"])';
  const closed = (el: Element): Element | null => el.parentElement?.closest("details:not([open])") ?? null;
  const unreachable = (el: Element): boolean => {
    if (el.matches(":disabled") || el.closest('[inert],[aria-hidden="true"]')) return true;
    for (let details = closed(el); details; details = closed(details)) if (!details.querySelector(":scope > summary")?.contains(el)) return true;
    const style = getComputedStyle(el);
    if (style.visibility !== "visible" || style.pointerEvents === "none") return true;
    // A transparent native control laid over its styled stand-in is still what's hit; anything else transparent
    // is a menu or a hint that isn't there yet.
    const field = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    for (let e: Element | null = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) === 0 && !(e === el && field)) return true;
    // What's left of its box inside each ancestor that clips; one that scrolls can bring any of it into view.
    const box = el.getBoundingClientRect();
    let [left, top, right, bottom] = [box.left, box.top, box.right, box.bottom];
    if (right - left <= 1 || bottom - top <= 1) return true;
    for (let e = el.parentElement; e; e = e.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(e);
      if (overflowX === "visible" && overflowY === "visible") continue;
      const clip = e.getBoundingClientRect();
      const hides = (value: string) => value === "hidden" || value === "clip";
      if (overflowX !== "visible") [left, right] = hides(overflowX) ? [Math.max(left, clip.left), Math.min(right, clip.right)] : [clip.left, clip.right];
      if (overflowY !== "visible") [top, bottom] = hides(overflowY) ? [Math.max(top, clip.top), Math.min(bottom, clip.bottom)] : [clip.top, clip.bottom];
      if (right - left <= 1 || bottom - top <= 1) return true;
    }
    // Left of the page or above it, where nothing scrolls to; or past its end.
    const page = document.documentElement;
    return (
      box.right + scrollX <= 0 ||
      box.bottom + scrollY <= 0 ||
      box.left + scrollX >= Math.max(page.scrollWidth, innerWidth) ||
      box.top + scrollY >= Math.max(page.scrollHeight, innerHeight)
    );
  };
  // The nearest ancestor laid out as a block (the sentence's own box), and whether it has words outside its controls.
  const blockOf = (el: Element | null): Element | null => {
    for (let e = el; e; e = e.parentElement) if (!/^(inline|contents)$/.test(getComputedStyle(e).display)) return e;
    return null;
  };
  const sentences = new Map<Element, boolean>();
  const inSentence = (link: Element): boolean => {
    const block = blockOf(link.parentElement);
    if (!block) return false;
    let words = sentences.get(block);
    if (words === undefined) {
      words = false;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && !words; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || !/[\p{L}\p{N}]/u.test(node.textContent ?? "") || blockOf(parent) !== block) continue;
        const control = parent.closest(selector);
        words = !control || control === block || !block.contains(control);
      }
      sentences.set(block, words);
    }
    return words;
  };
  let count = 0;
  const examples: string[] = [];
  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (ignore.some((rule) => el.closest(rule))) continue;
    const label = (el as HTMLInputElement).labels?.[0];
    let box = el.getBoundingClientRect();
    if (unreachable(el)) {
      if (!label || el.matches(":disabled") || unreachable(label)) continue;
      box = label.getBoundingClientRect();
    } else if (el.tagName === "A" && getComputedStyle(el).display === "inline" && inSentence(el)) continue;
    else if (label) {
      const around = label.getBoundingClientRect();
      box = new DOMRect(
        Math.min(box.left, around.left),
        Math.min(box.top, around.top),
        Math.max(box.width, around.width),
        Math.max(box.height, around.height)
      );
    }
    if (box.width < min || box.height < min) {
      count++;
      if (examples.length < 4) examples.push(`${describe(el)} ${Math.round(box.width)}×${Math.round(box.height)}`);
    }
  }
  return { count, examples };
}

// Text cut off by the box that clips it: each run of text is measured against its nearest ancestor with overflow
// hidden or clip (a positioned run, against its containing block's; a page that hides what runs out sideways, against
// the window). A run partly in and partly out is clipped; one wholly out is hidden on purpose (a carousel's next
// slide, a closed accordion, text for screen readers). An ellipsis on text that can't wrap, or a line clamp, says so
// itself and excuses both directions. Runs in the page.
export function clippedText(ignore: string[] = []): string[] {
  const hides = (value: string) => value === "hidden" || value === "clip";
  const scrolls = (value: string) => value === "auto" || value === "scroll";
  interface Clip {
    box: Element;
    x: boolean;
    y: boolean;
  }
  const clips = new Map<Element, Clip | null>();
  const clipOf = (start: Element): Clip | null => {
    const known = clips.get(start);
    if (known !== undefined) return known;
    let found: Clip | null = null;
    let out = "";
    for (let e: Element | null = start; e; e = e.parentElement) {
      const style = getComputedStyle(e);
      // The page's own box is the window. What it hides sideways can't be scrolled to; downwards is the page's length.
      if (e === document.body || e === document.documentElement) {
        if (out !== "fixed" && hides(style.overflowX)) found = { box: document.documentElement, x: true, y: false };
        if (found) break;
        continue;
      }
      // An absolutely positioned box is clipped only from its containing block up; a fixed one, by the window.
      if (out === "fixed" ? style.transform === "none" : out === "absolute" && style.position === "static" && style.transform === "none") continue;
      out = "";
      if (hides(style.overflowX) || hides(style.overflowY)) found = { box: e, x: hides(style.overflowX), y: hides(style.overflowY) };
      if (found || (scrolls(style.overflowX) && scrolls(style.overflowY))) break;
      if (style.position === "absolute" || style.position === "fixed") out = style.position;
    }
    clips.set(start, found);
    return found;
  };
  const found: string[] = [];
  const reported = new Set<Element>();
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && found.length < 5; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = (node.textContent ?? "").trim();
    if (!(parent instanceof HTMLElement) || !text || parent.closest("select,textarea") || ignore.some((rule) => parent.closest(rule))) continue;
    const clip = clipOf(parent);
    if (!clip || reported.has(clip.box) || !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const style = getComputedStyle(clip.box);
    const clamp = (style as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp;
    const oneLine = /^(nowrap|pre)$/.test(getComputedStyle(parent).whiteSpace);
    if ((style.textOverflow === "ellipsis" && oneLine) || (clamp && clamp !== "none")) continue;
    // The clipping box's padding edge.
    const outer = clip.box.getBoundingClientRect();
    const [left, top] = [outer.left + clip.box.clientLeft, outer.top + clip.box.clientTop];
    const [right, bottom] = [left + clip.box.clientWidth, top + clip.box.clientHeight];
    let seen = false;
    let cut = false;
    range.selectNodeContents(node);
    for (const line of Array.from(range.getClientRects())) {
      if (line.width < 1 || line.height < 1) continue;
      const wide = clip.x ? Math.min(line.right, right) - Math.max(line.left, left) : line.width;
      const tall = clip.y ? Math.min(line.bottom, bottom) - Math.max(line.top, top) : line.height;
      if (wide <= 1 || tall <= 1) cut = true;
      else {
        seen = true;
        // A line's box is taller than its letters, and a tight line height trims it: a third may go unseen.
        if (line.width - wide > 1.5 || line.height - tall > line.height / 3) cut = true;
      }
    }
    if (!seen || !cut) continue;
    reported.add(clip.box);
    found.push(`${parent.tagName.toLowerCase()} "${text.replace(/\s+/g, " ").slice(0, 30)}"`);
  }
  return found;
}

// One stop of the focus walk: what the keyboard's focus is on after a Tab. The walk's memory is kept in the page, by
// element, so a control in a shadow root, or the third of three cards alike, is a stop of its own. Runs in the page.
interface FocusStop {
  // none: nothing has the focus. seen: the walk has come round. skip: not this page's to answer for (a frame's own
  // document, a framework's development overlay, what the operator's rules leave out).
  kind: "none" | "seen" | "skip" | "stop";
  name?: string;
  // The control and its label with room around them, where its focus should show; null when none of it is in view.
  region?: Region | null;
}
interface FocusWalk {
  seen: WeakSet<Element>;
  inside: Element | null;
  current: HTMLElement | null;
}
function focusStop(ignore: string[]): FocusStop {
  const page = window as unknown as { __a6gFocus?: FocusWalk };
  const walk = (page.__a6gFocus ??= { seen: new WeakSet(), inside: null, current: null });
  walk.current = null;
  let el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) {
    walk.inside = null;
    return { kind: "none" };
  }
  // A framework's own development overlay isn't the page (Next.js's, Vite's, Astro's toolbar).
  const overlay = /^(nextjs-portal|vite-error-overlay|astro-dev-toolbar|vercel-live-feedback)$/i.test(el.tagName);
  // Focus inside a component's shadow root: the control itself, not its host.
  if (!overlay) while (el.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
  // An overlay has stops of its own, and so has a frame's document: Tab walks through them while the focus here
  // stays on the one element, which is stepped over until the keyboard is out of it.
  if (overlay || /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(el.tagName)) {
    if (walk.inside === el) return { kind: "skip" };
    walk.inside = el;
    if (walk.seen.has(el)) return { kind: "seen" };
    walk.seen.add(el);
    return { kind: "skip" };
  }
  walk.inside = null;
  if (walk.seen.has(el)) return { kind: "seen" };
  walk.seen.add(el);
  // The operator's rules, looked for from the control out through the shadow roots it's in.
  const ignored = (e: Element): boolean => {
    const root = e.getRootNode();
    return ignore.some((rule) => e.closest(rule)) || (root instanceof ShadowRoot && ignored(root.host));
  };
  if (ignored(el)) return { kind: "skip" };
  walk.current = el;
  const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${(el.getAttribute("aria-label") ?? el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 30)}"`;
  // A ring is drawn on the control, on a wrapper a little way out, or on its label (a styled checkbox's).
  const around = 24;
  const boxes = [el, ...Array.from((el as HTMLInputElement).labels ?? [])]
    .map((part) => part.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.height > 0);
  const left = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.left)) - around));
  const top = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.top)) - around));
  const right = Math.min(window.innerWidth, Math.ceil(Math.max(...boxes.map((box) => box.right)) + around));
  const bottom = Math.min(window.innerHeight, Math.ceil(Math.max(...boxes.map((box) => box.bottom)) + around));
  const inView = boxes.length > 0 && right - left >= 1 && bottom - top >= 1;
  return { kind: "stop", name, region: inView ? { x: left, y: top, width: right - left, height: bottom - top } : null };
}

// Takes the keyboard's focus off the walk's current stop, or puts it back where it was. Runs in the page.
function setFocus(on: boolean): void {
  const el = (window as unknown as { __a6gFocus?: FocusWalk }).__a6gFocus?.current;
  if (on) el?.focus({ preventScroll: true });
  else el?.blur();
}

// How many stops the keyboard has on the page: what Tab lands on, through open shadow roots, a group of radio
// buttons once, without frames, overlays and what the operator's rules leave out. Runs in the page.
function countStops(ignore: string[]): number {
  const overlay = /^(nextjs-portal|vite-error-overlay|astro-dev-toolbar|vercel-live-feedback)$/i;
  const groups = new Map<unknown, Set<string>>();
  let count = 0;
  const walk = (root: Document | ShadowRoot): void => {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (overlay.test(el.tagName)) continue;
      if (el.shadowRoot) walk(el.shadowRoot);
      if (/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(el.tagName)) continue;
      // The keyboard stops at an editing host whatever its tabIndex says, and passes an anchor that isn't a link.
      const editing = el.isContentEditable && !el.parentElement?.isContentEditable && !el.hasAttribute("tabindex");
      if (el.tabIndex < 0 && !editing) continue;
      if (el.matches("a:not([href]):not([tabindex]), area:not([href]):not([tabindex])")) continue;
      if (el.matches(":disabled") || el.closest("[inert]") || ignore.some((rule) => el.closest(rule))) continue;
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      if (el instanceof HTMLInputElement && el.type === "radio" && el.name) {
        const names = groups.get(el.form) ?? new Set<string>();
        groups.set(el.form, names);
        if (names.has(el.name)) continue;
        names.add(el.name);
      }
      count++;
    }
  };
  walk(document);
  return count;
}

// Tabs through the page's first FOCUS_STOPS stops and names those whose focus can't be seen: the pixels around the
// control and its label are the same with the focus on it and off it. An outline, a shadow, a ring on a sibling, a
// wrapper or a pseudo-element all show; a transparent outline, or one the page's own colour, doesn't. Both pictures
// are taken after the focus has left once, so what leaving a field changes (its error) isn't taken for a ring.
// Returns how many stops it walked, of how many the page has.
async function focusRings(tab: Tab, comparer: Tab, ignore: string[]): Promise<{ walked: number; stops: number; missing: string[] }> {
  const stops = await tab.evaluate(countStops, ignore);
  const missing: string[] = [];
  const shot = (clip: Region) => tab.screenshot({ fullPage: false, clip, scale: "css", animations: "disabled", caret: "hide" });
  let walked = 0;
  let nowhere = 0;
  // A frame's stops take presses of their own: three presses a stop, at most.
  for (let press = 0; press < FOCUS_STOPS * 3 && walked < FOCUS_STOPS; press++) {
    await tab.keyboard.press("Tab");
    const stop = await tab.evaluate(focusStop, ignore);
    // Past the last stop the focus may leave the page for a press before it comes round; twice is a page with none.
    if (stop.kind === "none" ? ++nowhere > 1 : stop.kind === "seen") break;
    if (stop.kind !== "none") nowhere = 0;
    if (stop.kind !== "stop") continue;
    walked++;
    let shows = false;
    if (stop.region) {
      await tab.evaluate(setFocus, false);
      const without = await shot(stop.region);
      await tab.evaluate(setFocus, true);
      const focused = await shot(stop.region);
      const pixels = stop.region.width * stop.region.height;
      shows = !without.equals(focused) && (await difference(comparer, without, focused)) * pixels >= FOCUS_PIXELS;
    }
    if (!shows) missing.push(stop.name ?? "");
  }
  return { walked, stops: Math.max(stops, walked), missing };
}

// The share of pixels that differ between two screenshots (1 when their sizes differ), compared in a blank page.
async function difference(comparer: Tab, before: string | Buffer, after: string | Buffer): Promise<number> {
  const asUrl = (image: string | Buffer) => `data:image/png;base64,${(typeof image === "string" ? readFileSync(image) : image).toString("base64")}`;
  return comparer.evaluate(
    async ([a, b]: [string, string]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((done, fail) => {
          const image = new Image();
          image.onload = () => done(image);
          image.onerror = () => fail(new Error("unreadable"));
          image.src = src;
        });
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return 1;
      const pixels = (image: HTMLImageElement) => {
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [p, q] = [pixels(x), pixels(y)];
      let differing = 0;
      for (let i = 0; i < p.length; i += 4)
        if (Math.abs((p[i] ?? 0) - (q[i] ?? 0)) + Math.abs((p[i + 1] ?? 0) - (q[i + 1] ?? 0)) + Math.abs((p[i + 2] ?? 0) - (q[i + 2] ?? 0)) > 24)
          differing++;
      return differing / (x.width * x.height);
    },
    [asUrl(before), asUrl(after)] as [string, string]
  );
}

// Chromium can't capture more than about 16,000 device pixels in one screenshot (taller ones come out blank). A
// tall page is shot at CSS scale, and past 16,000 CSS px in slices: <name>.png, <name>-2.png, …
const MAX_DEVICE_PX = 16_000;
async function shoot(tab: Tab, run: PageRun, viewport: Viewport, path: string, mask: string[]): Promise<void> {
  const height = await tab.evaluate(() => document.documentElement.scrollHeight);
  const scale = viewport.deviceScaleFactor ?? 1;
  const stable = { animations: "disabled" as const, caret: "hide" as const, mask: mask.map((selector) => tab.locator(selector)) };
  if (height * scale <= MAX_DEVICE_PX) {
    await tab.screenshot({ path, fullPage: true, ...stable });
    return;
  }
  if (height <= MAX_DEVICE_PX) {
    await tab.screenshot({ path, fullPage: true, scale: "css", ...stable });
    return;
  }
  const slices: string[] = [];
  run.slices = slices;
  for (let y = 0, i = 1; y < height; y += MAX_DEVICE_PX / 2, i++) {
    const slice = i === 1 ? path : path.replace(/\.png$/, `-${i}.png`);
    await tab.screenshot({
      path: slice,
      fullPage: true,
      scale: "css",
      clip: { x: 0, y, width: viewport.width, height: Math.min(MAX_DEVICE_PX / 2, height - y) },
      ...stable,
    });
    slices.push(slice);
  }
}

function print(results: Record<string, PageResult>): void {
  for (const [id, result] of Object.entries(results)) {
    console.info(`${result.passed ? "pass" : "FAIL"} ${id}`);
    for (const run of result.runs) {
      const differs =
        run.differs !== undefined && run.differs > DIFFERS ? `  (looks different since its UX pass: ${(run.differs * 100).toFixed(1)}%)` : "";
      const focus = run.focus ? `  (focus: walked ${run.focus.walked} of ${run.focus.stops} stops)` : "";
      console.info(
        `  ${run.viewport}/${run.scheme}: ${run.problems.length ? run.problems.join("; ") : "ok"}${focus}${run.shot ? `  ${run.shot}` : ""}${differs}`
      );
    }
    for (const refusal of result.refusals ?? []) console.info(`  refuses ${refusal.state}: ${refusal.problem ?? refusal.how}`);
  }
}

// What's wrong with who a page is served to, one line each.
export const refusalProblems = (result: Pick<PageResult, "refusals">): string[] =>
  (result.refusals ?? []).flatMap((refusal) => (refusal.problem ? [`refuses ${refusal.state}: ${refusal.problem}`] : []));

function uxFor(page: PageCheck, hash: string): string {
  const record = readJson<UxVerdict>(join(STATE, "ux", `${page.id}.json`));
  if (!record) return "due";
  return sourceHash(record.sha, page) === hash ? record.verdict : "due";
}

// Pages whose latest screenshots differ from the look the UX specialist passed, with the views that differ.
export function differentLooks(state: string): Record<string, string[]> {
  const saved = readJson<{ pages: Record<string, SavedResult> }>(join(state, "pages.json"), { pages: {} }).pages;
  const found: Record<string, string[]> = {};
  for (const [id, result] of Object.entries(saved)) {
    const views = result.runs.filter((run) => (run.differs ?? 0) > DIFFERS).map((run) => `${run.viewport}/${run.scheme}`);
    if (views.length) found[id] = views;
  }
  return found;
}

function rows(): { id: string; path: string; checks: string; ux: string; looks: string; problems: string[] }[] {
  const saved = readJson<{ pages: Record<string, SavedResult> }>(RESULTS, { pages: {} }).pages;
  const different = differentLooks(STATE);
  return list.map((page) => {
    const hash = sourceHash("HEAD", page);
    const result = saved[page.id];
    const current = result?.hash === hash;
    return {
      id: page.id,
      path: page.path,
      checks: !result ? "not run" : !current ? "stale" : result.passed ? "pass" : "fail",
      ux: uxFor(page, hash),
      looks: !keptLooks(STATE, page.id) ? "-" : different[page.id] ? "different" : "same",
      problems: current
        ? [...result.runs.flatMap((run) => run.problems.map((problem) => `${run.viewport}/${run.scheme}: ${problem}`)), ...refusalProblems(result)]
        : [],
    };
  });
}

// What the branch changed outside pages.allowedChanges, since pages.base (the team's base when it's left out).
function outsideChanges(): string[] {
  if (!plan.allowedChanges) return [];
  const base = plan.base ?? team.base;
  const allowed = plan.allowedChanges.map((rule) => new RegExp(rule));
  let changed: string;
  try {
    // -z: git quotes unusual names otherwise, and a quoted one would match no rule.
    changed = git("diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`);
  } catch {
    throw new Error(`can't compare with ${base}, which allowedChanges is checked against (pages.base, or the team's base)`);
  }
  return changed
    .split("\0")
    .filter(Boolean)
    .filter((path) => !allowed.some((rule) => rule.test(path)));
}

// When the UX specialist passes a page at a commit the factory checked, its screenshots from that run are kept: the
// look later runs compare against. Returns what was kept, or why nothing was.
export function keepLooks(checkout: string, state: string, id: string, sha: string): string {
  const saved = readJson<{ pages: Record<string, SavedResult> }>(join(state, "pages.json"), { pages: {} }).pages[id];
  if (!saved) return "no page check has run for it";
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${saved.commit}^{commit}`], { cwd: checkout, encoding: "utf8" }).trim();
  } catch {}
  if (commit !== sha) return `the last page check ran at ${saved.commit}, not the commit audited`;
  const dir = looksDir(state, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const run of saved.runs) {
    if (!run.shot || !existsSync(run.shot) || run.slices) continue;
    const kept = join(dir, `${run.viewport}-${run.scheme}.png`);
    copyFileSync(run.shot, kept);
    files[`${run.viewport}-${run.scheme}`] = kept;
  }
  writeJson(join(dir, "looks.json"), { commit: sha, at: new Date().toISOString(), files } satisfies KeptLooks);
  return `kept ${Object.keys(files).length} screenshots`;
}

// The team's app as the shared environment: a run against it takes the app lock, unless the caller already holds it
// (the after-merge command and the merge queue's check pass A6G_APP_LOCK down), so a merge doesn't restart it mid-run.
export async function holdingApp<T>(checkout: string, holder: string, work: () => Promise<T>): Promise<T> {
  if (process.env.A6G_APP_LOCK === "held") return work();
  const release = await acquire(checkout, "app", { slots: 1, waitMin: 8, holder, onWait: (text) => console.error(`${holder}: ${text}`) });
  if (!release) throw new Error("the team's app stayed busy for 8 minutes (a merge restarting it, or another run); try again");
  process.env.A6G_APP_LOCK = "held";
  try {
    return await work();
  } finally {
    delete process.env.A6G_APP_LOCK;
    release();
  }
}

const toplevel = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return home;
  }
};

export async function run(argv: string[]): Promise<number> {
  ({ home, team } = teamSession());
  const [command, ...rest] = argv;
  // shots tries a branch: the manifest in the worktree it's run from. Everything that records reads the checkout's.
  const here = command === "shots" ? toplevel() : home;
  const manifest = readHarness(here);
  for (const problem of manifest.problems) console.error(`pages: ${problem}`);
  plan = pagePlan(team, manifest.harness);
  STATE = stateDir(home);
  RESULTS = join(STATE, "pages.json");
  list = plan.list;
  const option = (flag: string): string | undefined => {
    const at = rest.indexOf(flag);
    if (at < 0) return undefined;
    const [value] = rest.splice(at, 2).slice(1);
    return value;
  };
  // A page to be seen signed in as a state nothing makes is refused before a browser starts.
  const refused = (): boolean => {
    const unknown = unknownSignIns(plan);
    for (const problem of unknown) console.error(`pages: ${problem}`);
    return unknown.length > 0;
  };
  // Nothing to check is never done: an empty list would pass every finish line.
  if (["run", "status", "done"].includes(command ?? "") && !list.length) {
    console.error('pages: neither team.json "pages.list" nor the harness manifest names a page, so there is nothing to check');
    return 2;
  }

  if (command === "run") {
    if (git("rev-parse", "--abbrev-ref", "HEAD") !== team.branch) {
      console.error(`pages: results are recorded only on ${team.branch} in the team's checkout; use shots for anything else`);
      return 2;
    }
    if (!plan.appUrl) {
      console.error("pages: team.json pages.appUrl (or environment.health) says where the team's app runs");
      return 2;
    }
    if (refused()) return 2;
    print(await recordPages(home, team, rest));
    const all = rows();
    console.info(
      `pages: ${all.filter((row) => row.checks === "pass").length}/${all.length} pass their checks at ${git("rev-parse", "--short", "HEAD")}; UX: ${all.map((row) => `${row.id} ${row.ux}`).join(", ")}. Screenshots in .a6g/run/shots/.`
    );
  } else if (command === "shots") {
    const base = option("--base");
    const path = option("--path");
    const out = resolve(option("--out") ?? join("/tmp", `pages-${Date.now()}`));
    if (!base) {
      console.error("usage: a6g pages shots --base <url> [--out dir] [--path /x] [ids…]");
      return 2;
    }
    if (!path && refused()) return 2;
    const chosen = path ? [{ id: path.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "root", path }] : pick(rest);
    const shots = () => check(base, chosen, out, here);
    // The team's own app is shared: hold it so a merge doesn't restart it under the checks.
    const team = plan.appUrl && new URL(base).origin === new URL(plan.appUrl).origin;
    print(team ? await holdingApp(home, "pages shots", shots) : await shots());
    console.info(`screenshots in ${out}`);
  } else if (command === "status") {
    for (const row of rows()) {
      console.info(`${row.id.padEnd(12)} checks:${row.checks.padEnd(8)} ux:${row.ux.padEnd(7)} looks:${row.looks.padEnd(9)} ${row.path}`);
      if (!rest.includes("--brief")) for (const problem of row.problems.slice(0, 6)) console.info(`             ↳ ${problem}`);
    }
    const outside = outsideChanges();
    if (outside.length) console.info(`Changed outside the allowed paths since ${plan.base ?? team.base}: ${outside.join(", ")}`);
  } else if (command === "done") {
    const gaps = rows().flatMap((row) => [
      ...(row.checks === "pass" ? [] : [`${row.id}: checks ${row.checks}`]),
      ...(row.ux === "pass" ? [] : [`${row.id}: UX ${row.ux}`]),
    ]);
    const outside = outsideChanges();
    if (outside.length) gaps.push(`changed outside the allowed paths: ${outside.join(", ")}`);
    if (gaps.length) {
      console.info(`Not done (${gaps.length}):\n${gaps.map((gap) => `- ${gap}`).join("\n")}`);
      return 1;
    }
    console.info(`Done: every page passes its checks on the current source and has a UX pass for it.`);
  } else {
    console.error("usage: a6g pages run [ids…] | shots --base <url> [--out dir] [--path /x] [ids…] | status [--brief] | done");
    return 2;
  }
  return 0;
}

// Checks the team's app for the chosen pages (all with none) and records the results: a6g pages run, and the merge
// queue's check after merges (lib/commands/harness.ts), which holds the app itself.
export async function recordPages(checkout: string, loaded: LoadedTeam, ids: string[] = []): Promise<Record<string, PageResult>> {
  home = checkout;
  team = loaded;
  plan = pagePlan(team, readHarness(home).harness);
  STATE = stateDir(home);
  RESULTS = join(STATE, "pages.json");
  list = plan.list;
  const appUrl = plan.appUrl;
  if (!appUrl) throw new Error("team.json pages.appUrl (or environment.health) says where the team's app runs");
  const results = await holdingApp(home, "pages run", () => check(appUrl, pick(ids), join(workDir(home), "shots"), home));
  const saved = readJson<{ pages: Record<string, SavedResult> }>(RESULTS, { pages: {} });
  const commit = git("rev-parse", "--short", "HEAD");
  for (const [id, result] of Object.entries(results))
    saved.pages[id] = {
      ...result,
      hash: sourceHash(
        "HEAD",
        list.find((page) => page.id === id)
      ),
      commit,
      at: new Date().toISOString(),
    };
  mkdirSync(STATE, { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(saved, null, 2)}\n`);
  return results;
}
