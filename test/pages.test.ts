import { a6g, baseTeam, git, machine, makeRepo, ROOT } from "./helpers.ts";
import { validator } from "./jsonschema.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { browserProblem, factoryChromium } from "../lib/browser.ts";
import { loadTeam, normalize, type RawTeam } from "../lib/config.ts";
import { clippedText, differentLooks, keepLooks, recordPages, smallTargets, unknownSignIns } from "../lib/commands/pages.ts";
import { pagePlan, parseHarness, readHarness } from "../lib/harness.ts";
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
// What the test app serves at a path: a page, or an answer made from the request (a header, a redirect, a cookie read).
type Served = string | ((request: IncomingMessage) => { status?: number; headers?: Record<string, string>; body?: string });
const svg = (): { headers: Record<string, string>; body: string } => ({
  headers: { "content-type": "image/svg+xml" },
  body: "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10' fill='#06c'/></svg>",
});
const site: Record<string, Served> = {
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

describe("what the operator says about a page", () => {
  test("ignore and schemes are team.json's, by the schema and by normalize; the manifest takes neither (23)", () => {
    const validate = validator(JSON.parse(readFileSync(join(ROOT, "schema", "team.schema.json"), "utf8")) as Record<string, unknown>);
    const withPage = (more: Record<string, unknown>) => ({ name: "t", branch: "a6g/next", pages: { list: [{ id: "home", path: "/", ...more }] } });
    const accepted = [{ ignore: [".legacy", "#ticker a"] }, { ignore: [] }, { schemes: ["light"] }, { schemes: ["dark", "light"], ignore: ["nav"] }];
    const rejected = [{ ignore: ".legacy" }, { ignore: [""] }, { ignore: [5] }, { schemes: [] }, { schemes: ["sepia"] }, { schemes: "light" }];
    for (const more of accepted) {
      assert.deepEqual(validate(withPage(more)), [], `the schema takes ${JSON.stringify(more)}`);
      assert.deepEqual(normalize(structuredClone(withPage(more)) as RawTeam, "/tmp/x").problems, [], `normalize takes ${JSON.stringify(more)}`);
    }
    for (const more of rejected) {
      assert.notDeepEqual(validate(withPage(more)), [], `the schema refuses ${JSON.stringify(more)}`);
      assert.notDeepEqual(normalize(structuredClone(withPage(more)) as RawTeam, "/tmp/x").problems, [], `normalize refuses ${JSON.stringify(more)}`);
    }
    const kept = normalize(structuredClone(withPage({ ignore: [".legacy"], schemes: ["light"] })) as RawTeam, "/tmp/x").team.pages?.list?.[0];
    assert.deepEqual([kept?.ignore, kept?.schemes], [[".legacy"], ["light"]]);
    // The manifest only adds checks: a page of its own can't leave anything out.
    for (const more of [{ ignore: [".legacy"] }, { schemes: ["light"] }])
      assert.notDeepEqual(parseHarness({ pages: [{ id: "home", path: "/", ...more }] }).problems, [], `the manifest refuses ${JSON.stringify(more)}`);
  });

  test("a page seen as a sign-in nothing makes is refused by a6g check and at the start of a run (24)", async () => {
    const manifest = {
      e2e: { config: "playwright.config.mjs", timeoutMin: 3 },
      auth: { project: "setup", states: { member: "e2e/.auth/member.json" } },
      pages: [{ id: "account", path: "/account", as: "member" }],
    };
    const team = (list: unknown[]) => ({ ...baseTeam(), pages: { appUrl: "http://127.0.0.1:1", list } }) as RawTeam;
    const home = makeRepo(team([{ id: "admin", path: "/admin", as: "staff" }]), { ".a6g/harness.json": manifest });
    const wrong = 'page admin: as "staff" names no sign-in state (the harness manifest\'s auth.states has member)';
    assert.deepEqual(unknownSignIns(pagePlan(loadTeam(home), readHarness(home).harness)), [wrong]);
    const { env } = machine();
    const checked = await a6g(["check", home], { cwd: home, env: { PATH: env.PATH } });
    assert.ok(checked.out.includes(`FAIL  team.json pages.list: ${wrong}`), checked.out);
    const ran = await a6g(["pages", "run"], { cwd: home, env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: "planner" } });
    assert.equal(ran.code, 2, ran.out);
    assert.ok(ran.out.includes(`pages: ${wrong}`), ran.out);
    assert.ok(!existsSync(join(stateDir(home), "pages.json")), "nothing was recorded");

    // With no manifest to make any sign-in, it says that; a page the manifest's own sign-in covers is taken.
    const bare = makeRepo(team([{ id: "admin", path: "/admin", as: "staff" }]));
    assert.deepEqual(unknownSignIns(pagePlan(loadTeam(bare), readHarness(bare).harness)), [
      'page admin: as "staff" names no sign-in state (the harness manifest has no auth.states)',
    ]);
    const fine = makeRepo(team([{ id: "admin", path: "/admin", as: "member" }]), { ".a6g/harness.json": manifest });
    assert.deepEqual(unknownSignIns(pagePlan(loadTeam(fine), readHarness(fine).harness)), []);
    assert.doesNotMatch((await a6g(["check", fine], { cwd: fine, env: { PATH: env.PATH } })).out, /names no sign-in state/);
  });
});

// What the tests use of the factory's browser, to measure one fixture with one in-page check.
interface TestTab {
  setContent(html: string): Promise<void>;
  evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R>;
}
interface TestContext {
  newPage(): Promise<TestTab>;
  close(): Promise<void>;
}
interface TestBrowser {
  newContext(options: Record<string, unknown>): Promise<TestContext>;
  close(): Promise<void>;
}

// Text for screen readers only, as the frameworks write it.
const SR =
  ".sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0 }";
const TINY = ".tiny { min-width: 0; min-height: 0; width: 20px; height: 20px; padding: 0 }";

// Touch targets (22): [what it is, the body, what's found].
const TARGETS: [string, string, string[]][] = [
  ["a skip link for screen readers", "<a href='#main' class='sr'>Skip to content</a>", []],
  ["a skip link off the page", "<a href='#main' style='position:absolute;left:-9999px'>Skip to content</a>", []],
  ["a control hidden from assistive technology", "<div aria-hidden='true'><button class='tiny'>x</button></div>", []],
  ["an inert control", "<div inert><button class='tiny'>x</button></div>", []],
  ["a disabled control", "<button class='tiny' disabled>x</button>", []],
  ["a control in a closed details", "<details><summary style='display:block;padding:14px'>More</summary><button class='tiny'>x</button></details>", []],
  [
    "a menu moved off the page",
    "<nav style='position:fixed;left:0;top:0;width:200px;transform:translateX(-100%)'><a href='/a' style='display:block;height:20px'>Orders</a></nav>",
    [],
  ],
  ["a collapsed menu", "<div style='max-height:0;overflow:hidden'><a href='/a' style='display:block;height:20px'>Orders</a></div>", []],
  ["a menu not shown yet", "<div style='opacity:0;pointer-events:none'><button class='tiny'>x</button></div>", []],
  ["an invisible control", "<div style='visibility:hidden'><button class='tiny'>x</button></div>", []],
  ["a link in a sentence, inside its emphasis", "<p>Read <strong><a href='/x'>this</a></strong> now.</p>", []],
  [
    "a component's hidden select beside its trigger",
    "<button style='width:200px'>Choose</button><select aria-hidden='true' tabindex='-1' class='sr'><option>A</option></select>",
    [],
  ],
  ["a honeypot field", "<input name='website' tabindex='-1' autocomplete='off' style='position:absolute;left:-9999px'>", []],
  [
    "a hidden checkbox under a label big enough",
    "<label style='display:flex;align-items:center;min-height:48px'><input type='checkbox' class='sr'> Agree to the terms</label>",
    [],
  ],
  ["a file input of one transparent pixel", "<input type='file' style='position:absolute;opacity:0;width:1px;height:1px'>", []],
  [
    "links in a row with bars between them",
    "<footer><a href='/t'>Terms</a> | <a href='/p'>Privacy</a> | <a href='/c'>Cookies</a></footer>",
    ['a "Terms"', 'a "Privacy"', 'a "Cookies"'],
  ],
  ["a link that is its whole paragraph", "<p><a href='/more'>More</a></p>", ['a "More"']],
  ["a small button", "<button class='tiny'>x</button>", ['button "x" 20×20']],
  ["a hidden checkbox under a label too small", "<label><input type='checkbox' class='sr' id='agree'> ok</label>", ["input#agree"]],
  [
    "a transparent checkbox over its small stand-in",
    "<span style='position:relative;display:inline-block;width:20px;height:20px;border:1px solid'><input type='checkbox' id='on' style='position:absolute;inset:0;width:20px;height:20px;margin:0;opacity:0'></span>",
    ["input#on 20×20"],
  ],
];

// Clipped text (26): [what it is, the body, what's found].
const TRUNCATE = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
const CLIPS: [string, string, string[]][] = [
  ["a heading cut with an ellipsis, its lines tight", `<h2 style='${TRUNCATE};width:120px;line-height:1'>A heading much too long for its box</h2>`, []],
  ["an ellipsis on a box too short as well", `<div style='${TRUNCATE};width:120px;height:10px'>A label much too long for its box</div>`, []],
  [
    "a line clamp",
    "<p style='display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;width:120px'>A paragraph that runs on for many more lines than the two it is given here.</p>",
    [],
  ],
  ["text for screen readers", "<button><span class='sr'>Close the dialog</span>×</button>", []],
  [
    "a carousel's other slides",
    "<div style='overflow:hidden;width:300px'><div style='display:flex;width:900px'><div style='width:300px'>Slide one</div><div style='width:300px'>Slide two</div><div style='width:300px'>Slide three</div></div></div>",
    [],
  ],
  ["a closed accordion", "<div style='height:0;overflow:hidden'><p>The answer, when it's opened.</p></div>", []],
  [
    "a logo's text moved out of its box",
    "<a href='/' style='display:block;width:100px;height:30px;overflow:hidden;text-indent:-9999px;background:#06c'>Home</a><a href='/b' style='display:block;width:100px;height:30px;overflow:hidden;text-indent:100%;white-space:nowrap;background:#06c'>Brand</a>",
    [],
  ],
  ["a box that scrolls", "<div style='overflow:auto;width:200px;height:40px'><p>One line.<br>Two lines.<br>Three lines.<br>Four lines.</p></div>", []],
  [
    "a text area and a select",
    "<textarea aria-label='Notes' style='width:80px;height:20px;overflow:hidden'>Notes that run on and on and on</textarea><select aria-label='Size' style='width:60px'><option>A very long option to choose</option></select>",
    [],
  ],
  ["a large heading with a tight line", "<h2 style='overflow:hidden;line-height:1;font-size:48px;margin:0'>Typography</h2>", []],
  [
    "a label positioned outside a box that clips only its own",
    "<div style='position:relative;height:40px'><div style='overflow:hidden;width:100px;height:20px'><span style='position:absolute;left:150px;top:0'>A floating label</span></div></div>",
    [],
  ],
  ["a hint not shown yet", "<div style='opacity:0'><div style='overflow:hidden;width:50px;white-space:nowrap'>A hint that fades in later</div></div>", []],
  [
    "a label cut by its parent",
    "<div style='width:80px;overflow:hidden;white-space:nowrap'><span>A label much too long for its box</span></div>",
    ['span "A label much too long for its "'],
  ],
  [
    "a card of fixed height",
    "<div style='width:200px;height:40px;overflow:hidden'><p style='margin:0'>Line one of the card. Line two of the card. Line three of the card. Line four of it.</p></div>",
    ['p "Line one of the card. Line two"'],
  ],
  [
    "a button's label",
    "<button style='width:60px;overflow:hidden;white-space:nowrap;padding:0'><span>Continue to checkout</span></button>",
    ['span "Continue to checkout"'],
  ],
  [
    "wrapped text whose ellipsis never shows",
    "<div style='width:120px;height:30px;overflow:hidden;text-overflow:ellipsis'>A paragraph that wraps onto several lines and is cut off below them.</div>",
    ['div "A paragraph that wraps onto se"'],
  ],
  [
    "a line half shown",
    "<div style='width:300px;height:28px;overflow:hidden;line-height:20px'>The first line<br>The second line</div>",
    ['div "The second line"'],
  ],
  [
    "a line running out of a page that hides it",
    "<style>body { overflow-x: hidden }</style><p style='white-space:nowrap'>" + "A line that runs on past the window. ".repeat(8) + "</p>",
    ['p "A line that runs on past the w"'],
  ],
];

// The focus walk (27): [id, the body, its style, what's found ("" when every stop's focus shows), walked of how many].
const BARE = ".bare, .bare:focus, .bare:focus-visible { outline: none }";
const HID =
  ".hid { position: absolute; opacity: 0; width: 28px; height: 28px; margin: 0 } .box { display: inline-block; width: 24px; height: 24px; border: 2px solid #111; vertical-align: middle }";
const FRAME = `<iframe title='Inner' srcdoc="<button>In one</button><button>In two</button>"></iframe>`;
const deep = (inner: string): string => `<section>${"<div>".repeat(7)}${inner}${"</div>".repeat(7)}</section>`;
const FOCUS: [string, string, string, string, [number, number]][] = [
  [
    "within",
    "<h1>A ring on the wrapper</h1><div class='wrap'><input aria-label='Name' class='bare'></div>",
    ".wrap { display: inline-block; padding: 4px; border: 2px solid #767676 } .wrap:focus-within { border-color: #06c; box-shadow: 0 0 0 3px #9cf } .bare { border: 0 }",
    "",
    [1, 1],
  ],
  [
    "within2",
    "<h1>A ring two wrappers out</h1><div class='wrap'><div><input aria-label='Name' class='bare'></div></div>",
    ".wrap { display: inline-block; padding: 4px; border: 2px solid #767676 } .wrap:focus-within { border-color: #06c; box-shadow: 0 0 0 3px #9cf } .bare { border: 0 }",
    "",
    [1, 1],
  ],
  [
    "sibling",
    "<h1>A ring on the stand-in</h1><label><input type='checkbox' class='hid'><span class='box'></span> Agree</label>",
    `${HID} .hid:focus-visible + .box { outline: 3px solid #06c; outline-offset: 2px }`,
    "",
    [1, 1],
  ],
  [
    "pseudo",
    "<h1>A ring on a pseudo-element</h1><button class='bare ps'>Go</button>",
    '.ps { position: relative } .ps:focus-visible::after { content: ""; position: absolute; inset: -4px; border: 2px solid #06c; border-radius: 6px }',
    "",
    [1, 1],
  ],
  [
    "fade",
    "<h1>A ring that fades in</h1><button class='bare fade'>Go</button>",
    ".fade { transition: box-shadow 0.3s } .fade:focus-visible { box-shadow: 0 0 0 3px #06c }",
    "",
    [1, 1],
  ],
  [
    "skip",
    "<a href='#top' class='skip'>Skip to content</a><h1 id='top'>A skip link shown when focused</h1><button>Go</button>",
    ".skip { position: absolute; left: -9999px; top: 0; background: #fff; padding: 14px; outline: none } .skip:focus { left: 0 }",
    "",
    [2, 2],
  ],
  ["frame", `<h1>A frame between two buttons</h1><button>First</button>${FRAME}<button>After</button>`, "", "", [2, 2]],
  ["shadow", "<h1>A button in a shadow root</h1><x-card><template shadowrootmode='open'><button>Inside</button></template></x-card>", "", "", [1, 1]],
  [
    "clear",
    "<h1>An outline nobody sees</h1><button class='clear'>Go</button>",
    ".clear:focus-visible { outline: 2px solid transparent }",
    'no visible focus on 1 of 1 stops: button "Go"',
    [1, 1],
  ],
  [
    "white",
    "<h1>White on white</h1><button class='white'>Go</button>",
    ".white:focus-visible { outline: 2px solid #fff; outline-offset: 2px }",
    'no visible focus on 1 of 1 stops: button "Go"',
    [1, 1],
  ],
  [
    "faint",
    "<h1>One shade darker</h1><button class='faint'>Go</button>",
    ".faint { background: #111111; color: #fff; border: 0; outline: none } .faint:focus-visible { background: #121212 }",
    'no visible focus on 1 of 1 stops: button "Go"',
    [1, 1],
  ],
  [
    "shadows",
    "<h1>Components</h1><x-a><template shadowrootmode='open'><button>One</button></template></x-a><x-b><template shadowrootmode='open'><style>button { outline: none }</style><button>Two</button><button>Three</button><button>Four</button></template></x-b>",
    "",
    'no visible focus on 3 of 4 stops: button "Two"; button "Three"; button "Four"',
    [4, 4],
  ],
  [
    "cards",
    `<h1>Three cards alike</h1>${deep("<button class='bare'>Buy</button>").repeat(3)}`,
    "",
    'no visible focus on 3 of 3 stops: button "Buy"; button "Buy"; button "Buy"',
    [3, 3],
  ],
  [
    "frame-after",
    `<h1>A bare button after a frame</h1><button>First</button>${FRAME}<button class='bare'>After</button>`,
    "",
    'no visible focus on 1 of 2 stops: button "After"',
    [2, 2],
  ],
  [
    "trap",
    "<h1>A trap</h1><button id='a'>A</button><button id='b' class='bare'>B</button><button id='c'>C</button><script>document.getElementById('b').addEventListener('keydown', (event) => { if (event.key === 'Tab') { event.preventDefault(); document.getElementById('a').focus(); } });</script>",
    "",
    'no visible focus on 1 of 2 stops (the page has 3): button#b "B"',
    [2, 3],
  ],
  [
    "autofocus",
    "<h1>Focused as it loads</h1><input autofocus aria-label='Search' class='bare'><button>Go</button>",
    "",
    'no visible focus on 1 of 2 stops: input "Search"',
    [2, 2],
  ],
  [
    "hidden-input",
    "<h1>No ring on the stand-in</h1><label><input type='checkbox' class='hid' id='agree'><span class='box'></span> Agree</label>",
    HID,
    'no visible focus on 1 of 1 stops: input#agree ""',
    [1, 1],
  ],
  [
    "blur",
    "<h1>An error when the field is left</h1><input id='email' aria-label='Email' class='bare' onblur=\"document.getElementById('err').hidden = false\"><p id='err' hidden>Enter your email</p>",
    "",
    'no visible focus on 1 of 1 stops: input#email "Email"',
    [1, 1],
  ],
  [
    "many",
    `<h1>More stops than are walked</h1><p><a>Not a link</a> <a>Nor this</a> ${Array.from({ length: 44 }, (_, i) => `<a href='/to/${i}'>Link ${i}</a>`).join(" ")}</p><div contenteditable>A note</div><button class='bare'>Last</button>`,
    "",
    "",
    [40, 46],
  ],
  [
    "stuck",
    "<h1>A page that takes the Tab key</h1><button>Go</button><script>addEventListener('keydown', (event) => event.preventDefault(), true);</script>",
    "",
    "the keyboard reached none of the page's 1 controls",
    [0, 1],
  ],
];

describe("page checks in the factory's own browser", { skip: noBrowser ?? false }, () => {
  let server: Server;
  let url = "";
  // Every path asked of the test app, in order.
  const hits: string[] = [];
  const problemsOf = (results: Awaited<ReturnType<typeof recordPages>>, id: string): string =>
    (results[id]?.runs ?? []).flatMap((run) => run.problems.map((p) => `${run.viewport}/${run.scheme}: ${p}`)).join("\n");
  // One viewport and one scheme, for the checks that don't differ by either.
  const one = { settleMs: 50, schemes: ["light"], viewports: [{ id: "desktop", width: 1024, height: 768 }] };
  before(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? "";
      hits.push(path);
      const served = site[path];
      const answer = typeof served === "function" ? served(request) : served ? { body: served } : { status: 404, body: "missing" };
      response.writeHead(answer.status ?? 200, { "content-type": "text/html", ...answer.headers });
      response.end(answer.body ?? "");
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
  test("focus is judged by what's seen, at each stop the keyboard has, and says how far it walked (27)", async () => {
    for (const [id, body, style] of FOCUS) site[`/focus/${id}`] = page(body, `${BARE} ${style}`);
    const list = FOCUS.map(([id]) => ({ id, path: `/focus/${id}` }));
    const home = makeRepo({ ...baseTeam(), pages: { appUrl: url, ...one, list } } as RawTeam);
    const results = await recordPages(home, loadTeam(home));
    for (const [id, , , problem, [walked, stops]] of FOCUS) {
      assert.equal(problemsOf(results, id), problem && `desktop/light: ${problem}`, id);
      assert.deepEqual(results[id]?.runs[0]?.focus, { walked, stops }, id);
    }
    // The run says how far the walk went, whether or not it found anything.
    const ran = await a6g(["pages", "run", "trap", "many"], { cwd: home, env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: "planner" } });
    assert.match(
      ran.out,
      /^FAIL trap\n {2}desktop\/light: no visible focus on 1 of 2 stops \(the page has 3\): button#b "B" {2}\(focus: walked 2 of 3 stops\)/m
    );
    assert.match(ran.out, /^pass many\n {2}desktop\/light: ok {2}\(focus: walked 40 of 46 stops\)/m);
  });

  test("the operator's ignore leaves a part of a page out of every check, and schemes a scheme it hasn't (23)", async () => {
    site["/dot.svg"] = svg;
    site["/plain"] = page("<h1>Plain</h1><button>Go</button>");
    site["/legacy"] = page(
      "<h1>Legacy</h1><div class='legacy'><button class='tiny bare'>x</button><div class='ticker'>A ticker much too long for its narrow box</div><img src='/dot.svg'><div style='width:3000px;height:10px'></div></div><button>Fine</button>",
      `${TINY} ${BARE} .ticker { width: 80px; overflow: hidden; white-space: nowrap }`
    );
    const pages = {
      appUrl: url,
      settleMs: 50,
      minTarget: 44,
      viewports: [
        { id: "desktop", width: 1024, height: 768 },
        { id: "phone", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
      ],
      list: [
        { id: "legacy", path: "/legacy" },
        { id: "kept", path: "/legacy", ignore: [".legacy"] },
        { id: "unread", path: "/plain", ignore: ["a[", ".legacy"] },
        // The manifest's own page, taken over by its id to say what the manifest can't.
        { id: "nodark", path: "/nodark", schemes: ["light"] },
      ],
    };
    const home = makeRepo({ ...baseTeam(), pages } as RawTeam, {
      ".a6g/harness.json": { pages: [{ id: "nodark", path: "/nodark" }], schemes: { dark: { htmlClass: "dark" } } },
    });
    const results = await recordPages(home, loadTeam(home));
    const legacy = problemsOf(results, "legacy");
    assert.match(legacy, /desktop\/light: .*scrolls sideways by \d+px/);
    assert.match(legacy, /desktop\/light: .*axe: image-alt \(1\)/);
    assert.match(legacy, /phone\/light: 1 controls smaller than 44px: button "x" 20×20/);
    assert.match(legacy, /desktop\/light: text clipped by its box: div "A ticker much too long/);
    assert.match(legacy, /desktop\/light: .*no visible focus on 1 of 2 stops: button "x"/);
    assert.equal(problemsOf(results, "kept"), "", "the same page with that part left out");
    assert.deepEqual(results["kept"]?.runs[0]?.focus, { walked: 1, stops: 1 });
    assert.deepEqual(
      results["unread"]?.runs.map((run) => run.problems),
      Array.from({ length: 4 }, () => ["ignore: not a selector: a["]),
      "a rule that can't be read is said, and the rest of the page is still checked"
    );
    assert.deepEqual(
      results["nodark"]?.runs.map((run) => `${run.viewport}/${run.scheme}`),
      ["desktop/light", "phone/light"],
      "a page with no dark variant isn't checked dark"
    );
    assert.equal(problemsOf(results, "nodark"), "", "nor held to looking different there");
  });

  test("the page is whole before it's looked at: under its own security policy, scrolled through, photographed before the walk (25)", async () => {
    const strict = {
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; require-trusted-types-for 'script'",
    };
    site["/dot.svg"] = svg;
    site["/lazy.svg"] = svg;
    site["/beacon"] = "ok";
    site["/csp"] = () => ({ headers: strict, body: page("<h1>Strict</h1><button>Go</button>") });
    site["/csp-img"] = () => ({ headers: strict, body: page("<h1>Strict</h1><img src='/dot.svg'><button>Go</button>") });
    site["/lazy"] = page(
      "<h1>Lazy</h1><div style='height:5000px'></div><img loading='lazy' src='/lazy.svg' alt='Lazy' width='100' height='100'><p id='shown' hidden>Shown once it's scrolled to</p><script>new IntersectionObserver((entries, observer) => { if (!entries.some((entry) => entry.isIntersecting)) return; observer.disconnect(); document.getElementById('shown').hidden = false; fetch('/beacon'); }).observe(document.querySelector('img'));</script>"
    );
    const left =
      "<h1>An error when the field is left</h1><input id='email' aria-label='Email'ONBLUR><p id='err' hidden>Enter your email</p><button>Go</button>";
    site["/left"] = page(left.replace("ONBLUR", " onblur=\"document.getElementById('err').hidden = false\""));
    site["/left-twin"] = page(left.replace("ONBLUR", ""));
    const list = ["csp", "csp-img", "lazy", "left", "left-twin"].map((id) => ({ id, path: `/${id}` }));
    const home = makeRepo({ ...baseTeam(), pages: { appUrl: url, ...one, list } } as RawTeam);
    hits.length = 0;
    const results = await recordPages(home, loadTeam(home));
    assert.equal(problemsOf(results, "csp"), "", "the factory's own script runs, and adds nothing to the page's console");
    assert.equal(problemsOf(results, "csp-img"), "desktop/light: axe: image-alt (1)", "axe ran under the policy");
    assert.equal(problemsOf(results, "lazy"), "");
    assert.ok(hits.includes("/lazy.svg") && hits.includes("/beacon"), `what loads when scrolled to was loaded: ${hits.join(" ")}`);
    assert.equal(problemsOf(results, "left"), "");
    assert.deepEqual(results["left"]?.runs[0]?.focus, { walked: 2, stops: 2 });
    assert.equal(results["left"]?.runs[0]?.look, results["left-twin"]?.runs[0]?.look, "the screenshot is of the page before its fields were walked");
  });

  test("a page is checked where it was asked for, signed in afresh or not at all (24)", async () => {
    // The account page is the member's: anyone else is sent to sign in.
    site["/login"] = page("<h1>Sign in</h1><button>Sign in</button>");
    site["/account"] = (request) =>
      /\bsid=good\b/.test(request.headers.cookie ?? "")
        ? { body: page("<h1>Your account</h1><button>Go</button>") }
        : { status: 302, headers: { location: "/login" } };
    const state = "e2e/.auth/member.json";
    const home = makeRepo({ ...baseTeam(), pages: { appUrl: url, ...one } } as RawTeam, {
      ".a6g/harness.json": {
        e2e: { config: "playwright.config.mjs", timeoutMin: 3 },
        auth: { project: "setup", states: { member: state } },
        pages: [
          { id: "account", path: "/account", as: "member" },
          { id: "open", path: "/account" },
        ],
      },
      "playwright.config.mjs": "export default { testDir: 'e2e', projects: [{ name: 'setup', testMatch: /auth\\.setup\\.mjs/ }] };\n",
      // The sign-in, without a browser: the session the app gives, or (once there's a file named refused) none.
      "e2e/auth.setup.mjs": [
        'import { test } from "playwright/test";',
        'import { existsSync, mkdirSync, writeFileSync } from "node:fs";',
        'test("signs in as the member", () => {',
        '  if (existsSync("refused")) throw new Error("the app refused the password");',
        '  const cookie = { name: "sid", value: "good", domain: new URL(process.env.PLAYWRIGHT_BASE_URL).hostname, path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" };',
        '  mkdirSync("e2e/.auth", { recursive: true });',
        `  writeFileSync("${state}", JSON.stringify({ cookies: [cookie], origins: [] }));`,
        "});",
        "",
      ].join("\n"),
      ".gitignore": "node_modules\ne2e/.auth\nrefused\n",
    });
    // The repository's own Playwright: the factory's copy, linked in.
    mkdirSync(join(home, "node_modules"), { recursive: true });
    for (const name of ["playwright", "playwright-core"]) symlinkSync(join(ROOT, "node_modules", name), join(home, "node_modules", name));
    const loaded = loadTeam(home);

    const signedIn = await recordPages(home, loaded);
    assert.equal(problemsOf(signedIn, "account"), "", "signed in, the page is the one asked for");
    assert.equal(problemsOf(signedIn, "open"), "desktop/light: ended at /login instead of /account");
    assert.equal(signedIn["open"]?.runs[0]?.look, undefined, "another page's look isn't kept as this one's");
    assert.ok(existsSync(signedIn["open"]?.runs[0]?.shot ?? ""), "where it ended is photographed");

    // The sign-in fails and yesterday's state is still there: the page isn't checked with it.
    const yesterday = new Date(Date.now() - 13 * 3_600_000);
    utimesSync(join(home, state), yesterday, yesterday);
    writeFileSync(join(home, "refused"), "");
    hits.length = 0;
    const failed = await recordPages(home, loaded, ["account"]);
    assert.equal(
      problemsOf(failed, "account"),
      "desktop/light: the sign-in member failed (the sign-in project setup exited 1), so the page wasn't checked"
    );
    assert.deepEqual(hits, [], "the app wasn't asked for the page with the old state");

    // A state made a moment ago that the app no longer takes: the page ends at the sign-in, and that's said.
    rmSync(join(home, "refused"));
    writeFileSync(join(home, state), JSON.stringify({ cookies: [], origins: [] }));
    const refused = await recordPages(home, loaded, ["account"]);
    assert.equal(problemsOf(refused, "account"), "desktop/light: ended at /login instead of /account (seen as member: the app didn't take the sign-in)");

    // An operator's page seen as a state nothing makes fails by itself, and the others are still checked.
    writeFileSync(
      join(home, ".a6g", "team.json"),
      JSON.stringify({ ...baseTeam(), pages: { appUrl: url, ...one, list: [{ id: "admin", path: "/account", as: "staff" }] } })
    );
    const unknown = await recordPages(home, loadTeam(home), ["admin", "open"]);
    assert.equal(problemsOf(unknown, "admin"), 'desktop/light: as "staff" names no sign-in state (the harness manifest\'s auth.states has member)');
    assert.equal(problemsOf(unknown, "open"), "desktop/light: ended at /login instead of /account");
  });

  describe("one check, one fixture", () => {
    let browser: TestBrowser;
    before(async () => {
      browser = (await factoryChromium()?.launch()) as TestBrowser;
    });
    after(() => browser.close());
    const measured = async <A, R>(options: Record<string, unknown>, body: string, check: (arg: A) => R, arg: A): Promise<R> => {
      const context = await browser.newContext(options);
      try {
        const tab = await context.newPage();
        await tab.setContent(page(body, `${SR} ${TINY}`));
        return await tab.evaluate(check, arg);
      } finally {
        await context.close();
      }
    };

    test("touch targets are what a finger can reach, and a link is in a sentence by its block (22)", async () => {
      const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
      for (const [what, body, expected] of TARGETS) {
        const found = await measured(phone, body, smallTargets, { min: 44 });
        assert.equal(found.count, expected.length, `${what}: ${found.examples.join("; ")}`);
        for (const [i, example] of expected.entries()) assert.ok(found.examples[i]?.startsWith(example), `${what}: ${found.examples.join("; ")}`);
      }
      // What the operator's rules leave out isn't measured.
      const footer = "<footer><a href='/t'>Terms</a> | <a href='/p'>Privacy</a></footer><button class='tiny'>x</button>";
      assert.deepEqual((await measured(phone, footer, smallTargets, { min: 44, ignore: ["footer"] })).examples, ['button "x" 20×20']);
    });

    test("clipped text is a run partly in and partly out of the box that clips it (26)", async () => {
      const desktop = { viewport: { width: 1024, height: 768 } };
      for (const [what, body, expected] of CLIPS) assert.deepEqual(await measured(desktop, body, clippedText, []), expected, what);
      const two =
        "<div class='a' style='width:80px;overflow:hidden;white-space:nowrap'>The first of two cut off</div><div style='width:80px;overflow:hidden;white-space:nowrap'>The second of two cut off</div>";
      assert.deepEqual(await measured(desktop, two, clippedText, [".a"]), ['div "The second of two cut off"']);
    });
  });
});
