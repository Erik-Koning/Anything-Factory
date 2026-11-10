import { baseTeam, git, makeRepo } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { browserProblem } from "../lib/browser.ts";
import { loadTeam, type RawTeam } from "../lib/config.ts";
import { differentLooks, keepLooks, recordPages } from "../lib/commands/pages.ts";
import { stateDir } from "../lib/paths.ts";

// The tests' HOME is a temporary folder; the browser is in the person's own Playwright cache, if it's there at all.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir, "Library", "Caches", "ms-playwright");
const noBrowser = browserProblem();

const page = (body: string, style = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>t</title><style>
  body { font: 16px system-ui; margin: 0; padding: 24px; background: #fff; color: #111 }
  html.dark body { background: #111; color: #eee }
  html.dark a { color: #9cf }
  button { min-width: 48px; min-height: 48px }
  ${style}</style></head><body><main>${body}</main></body></html>`;
const site: Record<string, string> = {
  // Next.js's development overlay takes a tab stop; it isn't the page, so it isn't held to the rubric.
  "/": page("<h1>Fine</h1><p>Read <a href='/x'>this link</a> in a sentence.</p><button>Go</button><nextjs-portal tabindex='0'></nextjs-portal>"),
  "/small": page("<h1>Small</h1><button class='tiny'>x</button>", ".tiny { min-width: 0; min-height: 0; width: 20px; height: 20px; padding: 0 }"),
  "/clipped": page(
    "<h1>Clipped</h1><div class='box'>A sentence much too long for its narrow box</div>",
    ".box { width: 80px; overflow: hidden; white-space: nowrap }"
  ),
  "/nofocus": page("<h1>No focus</h1><button class='bare'>Go</button>", ".bare:focus, .bare:focus-visible { outline: none }"),
  "/nodark": page("<h1>Light only</h1>", "html.dark body { background: #fff; color: #111 }"),
};

describe("page checks in the factory's own browser", { skip: noBrowser ?? false }, () => {
  let server: Server;
  let url = "";
  before(async () => {
    server = createServer((request, response) => {
      const body = site[request.url ?? ""];
      response.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      response.end(body ?? "missing");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  after(() => server.close());

  test("see small targets, clipped text, missing focus and a dark mode that doesn't switch; keep and compare looks", async () => {
    const team = {
      ...baseTeam(),
      pages: { appUrl: url, minTarget: 44, list: [{ id: "fine", path: "/" }] },
    } as RawTeam;
    const home = makeRepo(team, {
      ".a6g/harness.json": {
        pages: [
          { id: "small", path: "/small" },
          { id: "clipped", path: "/clipped" },
          { id: "nofocus", path: "/nofocus" },
          { id: "nodark", path: "/nodark" },
        ],
        schemes: { dark: { htmlClass: "dark" } },
      },
    });
    const loaded = loadTeam(home);
    const results = await recordPages(home, loaded);
    const problems = (id: string) => (results[id]?.runs ?? []).flatMap((run) => run.problems.map((p) => `${run.viewport}/${run.scheme}: ${p}`)).join("\n");
    assert.equal(problems("fine"), "", "a page that meets the rubric passes, its in-sentence link excepted");
    assert.match(problems("small"), /phone\/light: 1 controls smaller than 44px: button "x" 20×20/);
    assert.doesNotMatch(problems("small"), /desktop\/light: 1 controls smaller/, "targets are a phone's check");
    assert.match(problems("clipped"), /text clipped by its box: div "A sentence much too long/);
    assert.match(problems("nofocus"), /desktop\/light: no visible focus on 1 of 1 stops: button "Go"/);
    assert.match(problems("nodark"), /dark looks the same as light: the harness manifest's set-up for dark doesn't switch this page/);
    assert.doesNotMatch(problems("fine"), /looks the same/, "the class switched it");
    const shot = results["fine"]?.runs[0]?.shot ?? "";
    assert.ok(existsSync(shot) && readFileSync(shot).length > 1000, "a screenshot was taken");

    // A UX pass at the checked commit keeps its look; the next run compares against it.
    const state = stateDir(home);
    const head = git(home, "rev-parse", "HEAD");
    assert.match(keepLooks(home, state, "fine", head), /kept 6 screenshots/);
    assert.match(keepLooks(home, state, "fine", "0".repeat(40)), /not the commit audited/);
    site["/"] = page("<h1>Changed a lot</h1><p style='height:400px;background:#c00'>Now red.</p><button>Go</button>");
    await recordPages(home, loaded, ["fine"]);
    assert.deepEqual(Object.keys(differentLooks(state)), ["fine"]);
    assert.ok((differentLooks(state)["fine"] ?? []).includes("desktop/light"));
  });
});
