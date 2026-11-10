// The browser the factory checks pages with: its own Playwright (package.json), so every team can check its pages from
// its first day whatever its repository has, and every page check sees the same Chromium (a change in a repository's
// Playwright doesn't change how its pages look). a6g self-install downloads that Chromium's headless shell; a6g doctor
// starts it. A repository's own Playwright runs its own specs (lib/commands/e2e.ts).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { FACTORY_ROOT } from "./paths.ts";

export interface Launcher {
  launch(options?: Record<string, unknown>): Promise<unknown>;
  executablePath(): string;
}

// The factory's Playwright's chromium, from an installed release or a checkout (`root`), or null when it isn't there.
export function factoryChromium(root = FACTORY_ROOT): Launcher | null {
  try {
    return (createRequire(join(root, "package.json"))("playwright") as { chromium: Launcher }).chromium;
  } catch {
    return null;
  }
}

// How long a start of the browser, and its download, may take.
const START_MS = 60_000;
const DOWNLOAD_MIN = 15;
// Starts and closes the browser a check starts, in a process of its own, saying why when it can't.
const PROBE = `require(process.argv[1]).chromium.launch().then((b) => b.close()).then(() => process.exit(0), (e) => { console.error(String((e && e.message) || e).split("\\n")[0]); process.exit(1); });`;
const installCommand = (root: string): string => `${process.execPath} ${join(root, "node_modules", "playwright", "cli.js")} install --only-shell chromium`;

// Why the factory can't check pages, or null when it can. Proven by starting the browser the checks start (Chromium's
// headless shell), not by looking for a file: Playwright's own path names the full Chromium, which no check uses.
export function browserProblem(root = FACTORY_ROOT): string | null {
  if (!factoryChromium(root)) return "the factory's Playwright isn't installed: reinstall Anything Factory (a6g self-install)";
  const started = spawnSync(process.execPath, ["-e", PROBE, join(root, "node_modules", "playwright")], { encoding: "utf8", timeout: START_MS });
  if (started.status === 0) return null;
  const said = (started.stderr ?? "").trim().split("\n")[0] ?? "";
  const why = started.error
    ? `it didn't start in ${START_MS / 1000} s`
    : /Executable doesn't exist/.test(said)
      ? "it isn't downloaded"
      : said || "it didn't start";
  return `the factory's browser (Chromium's headless shell) can't start: ${why}. a6g self-install fetches it (or ${installCommand(root)})`;
}

// Downloads the factory's browser when it's missing (into Playwright's own cache, shared with the repositories'
// copies of the same version): the headless shell only, which is all a check starts. A6G_SKIP_BROWSER=1 skips it (the
// tests, and machines that never check pages). One line says how it went.
export function installBrowser(root = FACTORY_ROOT): string {
  if (process.env.A6G_SKIP_BROWSER === "1") return "skipped (A6G_SKIP_BROWSER)";
  if (!browserProblem(root)) return "already downloaded";
  const cli = join(root, "node_modules", "playwright", "cli.js");
  if (!existsSync(cli)) return "the factory's Playwright isn't installed";
  // Its progress bars and stack traces stay out of the install's output: one line before, and one for how it went.
  console.info("a6g: downloading the factory's browser (Chromium's headless shell, about 200 MB)…");
  const result = spawnSync(process.execPath, [cli, "install", "--only-shell", "--no-progress", "chromium"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: DOWNLOAD_MIN * 60_000,
  });
  if (result.error) return `the download didn't finish in ${DOWNLOAD_MIN} minutes; page checks can't run until it does: ${installCommand(root)}`;
  if (result.status !== 0) {
    const lines = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.split("\n").map((line) => line.trim());
    const said = lines.find((line) => /^Error:/.test(line)) ?? lines.find(Boolean) ?? `exit ${result.status ?? "?"}`;
    return `the download failed (${said.slice(0, 200)}); page checks can't run until it works: ${installCommand(root)}`;
  }
  return browserProblem(root) ?? "downloaded";
}
