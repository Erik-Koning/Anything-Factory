// The browser the factory checks pages with: its own Playwright (package.json), so every team can check its pages from
// its first day whatever its repository has, and every page check sees the same Chromium (a change in a repository's
// Playwright doesn't change how its pages look). a6g self-install downloads that Chromium; a6g doctor checks it. A
// repository's own Playwright runs its own specs (lib/commands/e2e.ts).
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

// Why the factory can't check pages, or null when it can.
export function browserProblem(root = FACTORY_ROOT): string | null {
  const chromium = factoryChromium(root);
  if (!chromium) return "the factory's Playwright isn't installed: reinstall Anything Factory (a6g self-install)";
  let path = "";
  try {
    path = chromium.executablePath();
  } catch {}
  if (!path || !existsSync(path))
    return `the factory's Chromium isn't downloaded: a6g self-install fetches it (or ${process.execPath} ${join(root, "node_modules", "playwright", "cli.js")} install chromium)`;
  return null;
}

// Downloads the factory's Chromium when it's missing (into Playwright's own cache, shared with the repositories'
// copies of the same version). A6G_SKIP_BROWSER=1 skips it (the tests, and machines that never check pages).
export function installBrowser(root = FACTORY_ROOT): string {
  if (process.env.A6G_SKIP_BROWSER === "1") return "skipped (A6G_SKIP_BROWSER)";
  if (!browserProblem(root)) return "already downloaded";
  const cli = join(root, "node_modules", "playwright", "cli.js");
  if (!existsSync(cli)) return "the factory's Playwright isn't installed";
  const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
  return result.status === 0 ? "downloaded" : `the download failed (exit ${result.status ?? "?"}): run ${process.execPath} ${cli} install chromium`;
}
