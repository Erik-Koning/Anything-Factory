// a6g pages: each page the team checks, at each viewport and colour scheme, in the factory's own Chromium (lib/browser.ts),
// so every team can check its pages from its first day. The pages are the operator's (team.json pages.list) and the
// team's harness manifest's (lib/harness.ts), seen signed in where a page says `as`. For each it records the HTTP
// status, uncaught errors, console errors, horizontal overflow, axe's WCAG A/AA violations (serious and critical),
// touch targets under pages.minTarget on phones, text clipped by its box, controls with no visible focus (on the first
// viewport and scheme), and a full-page screenshot with animations off and the manifest's masks painted over.
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
import { type PageCheck, type PagePlan, pagePlan, readHarness } from "../harness.ts";
import { acquire } from "../lock.ts";
import { FACTORY_ROOT, stateDir, workDir } from "../paths.ts";
import { teamSession } from "../session.ts";
import { runPlaywright } from "../suite.ts";
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
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  addScriptTag(options: { path: string }): Promise<unknown>;
  locator(selector: string): unknown;
  keyboard: { press(key: string): Promise<void> };
  screenshot(options: {
    path: string;
    fullPage: boolean;
    scale?: "css";
    clip?: { x: number; y: number; width: number; height: number };
    animations?: "disabled";
    caret?: "hide";
    mask?: unknown[];
  }): Promise<unknown>;
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
}
export interface PageResult {
  passed: boolean;
  runs: PageRun[];
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
// Sign-in states older than this are made again before a page needs one.
const STATE_HOURS = 12;

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

// Makes the sign-in states the chosen pages need, with the repository's own Playwright (the manifest's auth project),
// when one is missing or older than STATE_HOURS. Returns what went wrong, by state.
async function signIn(dir: string, base: string, chosen: PageCheck[]): Promise<Record<string, string>> {
  const needed = [...new Set(chosen.flatMap((page) => (page.as ? [page.as] : [])))];
  if (!needed.length) return {};
  const auth = plan.auth;
  const problems: Record<string, string> = {};
  if (!auth || !plan.e2eConfig) {
    for (const name of needed) problems[name] = `the sign-in ${name} needs the harness manifest's auth project`;
    return problems;
  }
  const stale = needed.filter((name) => {
    const path = join(dir, auth.states[name] ?? "");
    return !existsSync(path) || Date.now() - statSync(path).mtimeMs > STATE_HOURS * 3_600_000;
  });
  if (stale.length) {
    const ran = await runPlaywright(dir, {
      config: plan.e2eConfig,
      args: ["--project", auth.project],
      env: { PLAYWRIGHT_BASE_URL: base, A6G_NAMESPACE: `pages-${Date.now().toString(36)}` },
      timeoutMin: 5,
      work: join(workDir(home), "pages-auth"),
    });
    if (ran.status !== 0) console.error(`pages: the sign-in project ${auth.project} ${ran.timedOut ? "timed out" : `exited ${ran.status}`}\n${ran.tail}`);
  }
  for (const name of needed)
    if (!existsSync(join(dir, auth.states[name] ?? ""))) problems[name] = `the sign-in ${name} wasn't made (${auth.states[name]})`;
  return problems;
}

async function check(base: string, chosen: PageCheck[], outDir: string | null, dir: string): Promise<Record<string, PageResult>> {
  const missing = browserProblem();
  const chromium = factoryChromium() as unknown as { launch(): Promise<Browser> } | null;
  if (!chromium || missing) throw new Error(missing ?? "the factory's Playwright isn't installed");
  const axePath = join(FACTORY_ROOT, "node_modules/axe-core/axe.min.js");
  const hasAxe = existsSync(axePath);
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
  // A blank page for comparing screenshots, where no page's own security policy can refuse an image.
  const blank = await browser.newContext({});
  const comparer = await blank.newPage();
  try {
    for (const page of chosen) {
      const runs: PageRun[] = [];
      const kept = outDir ? keptLooks(STATE, page.id) : null;
      for (const [vi, viewport] of viewports.entries()) {
        for (const [si, scheme] of schemes.entries()) {
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
            const response = await tab.goto(new URL(page.path, base).href, { waitUntil: "load", timeout: 120_000 });
            run.status = response?.status() ?? 0;
            await tab.waitForTimeout(plan.settleMs ?? 1500);
            // A framework may take the class off as it starts: put it back before looking.
            if (setup.htmlClass) await tab.evaluate((cls: string) => document.documentElement.classList.add(cls), setup.htmlClass);
            run.overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (hasAxe) {
              await tab.addScriptTag({ path: axePath });
              run.axe = await tab.evaluate(async () => {
                const result = await (window as unknown as { axe: Axe }).axe.run(document, {
                  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
                });
                return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.nodes.length})`);
              });
            }
            if (viewport.isMobile) {
              const small = await tab.evaluate(smallTargets, plan.minTarget);
              if (small.count) run.problems.push(`${small.count} controls smaller than ${plan.minTarget}px: ${small.examples.join("; ")}`);
            }
            const clipped = await tab.evaluate(clippedText);
            if (clipped.length) run.problems.push(`text clipped by its box: ${clipped.join("; ")}`);
            if (vi === 0 && si === 0) {
              const unseen = await focusRings(tab);
              if (unseen.missing.length)
                run.problems.push(`no visible focus on ${unseen.missing.length} of ${unseen.stops} stops: ${unseen.missing.slice(0, 4).join("; ")}`);
            }
            if (outDir) {
              mkdirSync(join(outDir, page.id), { recursive: true });
              run.shot = join(outDir, page.id, `${viewport.id}-${scheme}.png`);
              // Back to the top: the focus check may have scrolled.
              await tab.evaluate(() => window.scrollTo(0, 0));
              await shoot(tab, run, viewport, run.shot, page.mask ?? []);
              run.look = fileHash(run.shot);
              const before = kept?.files[`${viewport.id}-${scheme}`];
              if (before && existsSync(before) && !run.slices) run.differs = await difference(comparer, before, run.shot);
            }
          } catch (error) {
            run.problems.push(`didn't load: ${String((error as Error).message).split("\n")[0]}`);
          }
          if (run.status && run.status >= 400) run.problems.push(`HTTP ${run.status}`);
          if ((run.overflow ?? 0) > 1) run.problems.push(`scrolls sideways by ${run.overflow}px`);
          if (run.axe?.length) run.problems.push(`axe: ${run.axe.join(", ")}`);
          if (errors.length) run.problems.push(`errors: ${errors.slice(0, 3).join(" | ")}`);
          if (consoleErrors.length) run.problems.push(`console: ${consoleErrors.slice(0, 3).join(" | ")}`);
          if (!hasAxe) run.problems.push("axe-core not found (reinstall Anything Factory: a6g self-install)");
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
  } finally {
    await blank.close();
    await browser.close();
  }
  return results;
}

// Touch targets smaller than `min` CSS pixels, as WCAG 2.5.8 counts them: a link inside a sentence is excepted, and a
// checkbox or radio button is measured with its label. Runs in the page.
export function smallTargets(min: number): { count: number; examples: string[] } {
  const describe = (el: Element): string => {
    const label = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${label ? ` "${label}"` : ""}`;
  };
  const selector =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[tabindex]:not([tabindex="-1"])';
  let count = 0;
  const examples: string[] = [];
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    let box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    if (
      el.tagName === "A" &&
      style.display === "inline" &&
      Array.from(el.parentElement?.childNodes ?? []).some((n) => n.nodeType === 3 && n.textContent?.trim())
    )
      continue;
    const label = (el as HTMLInputElement).labels?.[0];
    if (label) {
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

// Text cut off by its own box (overflow hidden or clip), where it doesn't say so with an ellipsis or a line clamp.
// Boxes of a pixel or less are the visually hidden text screen readers read, not clipping. Runs in the page.
export function clippedText(): string[] {
  const found: string[] = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (!(el instanceof HTMLElement) || found.length >= 5) continue;
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim())) continue;
    if (el.clientWidth <= 1 || el.clientHeight <= 1) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const hides = (value: string) => value === "hidden" || value === "clip";
    const wide = hides(style.overflowX) && el.scrollWidth > el.clientWidth + 1 && style.textOverflow !== "ellipsis";
    const clamp = (style as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp;
    const tall = hides(style.overflowY) && el.scrollHeight > el.clientHeight + 1 && (!clamp || clamp === "none");
    if (wide || tall) found.push(`${el.tagName.toLowerCase()} "${(el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 30)}"`);
  }
  return found;
}

// Tabs through the first FOCUS_STOPS controls and names those whose focus shows nowhere: nothing about the control
// or its parent (outline, shadow, border, background, colour, underline) changes when it's focused.
async function focusRings(tab: Tab): Promise<{ stops: number; missing: string[] }> {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (let i = 0; i < FOCUS_STOPS; i++) {
    await tab.keyboard.press("Tab");
    const stop = await tab.evaluate(() => {
      // A framework's own development overlay isn't the page (Next.js's, Vite's, Astro's toolbar).
      const tooling = /^(nextjs-portal|vite-error-overlay|astro-dev-toolbar|vercel-live-feedback)$/i;
      let el = document.activeElement as HTMLElement | null;
      if (el && tooling.test(el.tagName)) return { name: "", path: `tooling:${el.tagName}`, visible: true, skip: true };
      // Focus inside a component's shadow root: the control itself, not its host.
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const look = (e: Element | null) => {
        if (!e) return "";
        const s = getComputedStyle(e);
        return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join("|");
      };
      const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${(el.getAttribute("aria-label") ?? el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 30)}"`;
      const parts: string[] = [];
      for (let e: Element | null = el; e && parts.length < 6; e = e.parentElement)
        parts.push(`${e.tagName}${Array.from(e.parentElement?.children ?? []).indexOf(e)}`);
      const focused = look(el) + look(el.parentElement);
      el.blur();
      const blurred = look(el) + look(el.parentElement);
      el.focus();
      return { name, path: parts.join("<"), visible: focused !== blurred, skip: false };
    });
    if (!stop || seen.has(stop.path)) break;
    if (stop.skip) {
      seen.add(stop.path);
      continue;
    }
    seen.add(stop.path);
    if (!stop.visible) missing.push(stop.name);
  }
  return { stops: [...seen].filter((path) => !path.startsWith("tooling:")).length, missing };
}

// The share of pixels that differ between two screenshots (1 when their sizes differ), compared in a blank page.
async function difference(comparer: Tab, before: string, after: string): Promise<number> {
  const asUrl = (path: string) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;
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
      console.info(`  ${run.viewport}/${run.scheme}: ${run.problems.length ? run.problems.join("; ") : "ok"}${run.shot ? `  ${run.shot}` : ""}${differs}`);
    }
  }
}

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
      problems: current ? result.runs.flatMap((run) => run.problems.map((problem) => `${run.viewport}/${run.scheme}: ${problem}`)) : [],
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
