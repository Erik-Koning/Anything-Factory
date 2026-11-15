"use client";
// The task graph by level, in BetterDiagrams' editor, read-only: the journeys on the top level, a double-click (or a
// card's ⊞) to open one, breadcrumbs and Esc to come back out; no minimap, since a level is small, and no legend on a
// phone. The level it's on goes in the address (?at=), so a reload, a link or going back opens the same one. Light or
// dark as the system is, in the app's paper and ink (its bar and keys are restyled in globals.css, under .level-graph).
import "@mosphere/better-diagrams/styles.css";
import type { RegistryExtensions, StudioHandle } from "@mosphere/better-diagrams";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { LEVEL_KINDS, NO_JOURNEY } from "../../lib/tasks/graph.ts";

// The cards that aren't BetterDiagrams' own tasks (lib/tasks/graph.ts): a journey in emerald, a hue no built-in kind
// wears, the work in no journey in slate, and work no member may take yet in a colour for why: waiting for a decision
// (violet), put to the operator (amber), stopped (rose), or approved but after work that isn't a task yet (indigo, a
// task's own hue, paler). Its checks leave out what doesn't fit a task graph: tasks with no dependencies, no one holding
// open work (members claim it), and cycles among services.
const REGISTRY: RegistryExtensions = {
  nodeKinds: {
    [LEVEL_KINDS.journey]: { label: "Journey", fill: "#022c22", accent: "#34d399", text: "#a7f3d0", icon: "layers" },
    [LEVEL_KINDS.none]: { label: "Tasks", fill: "#0f172a", accent: "#94a3b8", text: "#e2e8f0", icon: "folder" },
    [LEVEL_KINDS.unapproved]: { label: "Not approved", fill: "#2e1065", accent: "#a78bfa", text: "#ddd6fe", icon: "none" },
    [LEVEL_KINDS.question]: { label: "Question", fill: "#451a03", accent: "#fbbf24", text: "#fde68a", icon: "none" },
    [LEVEL_KINDS.blocked]: { label: "Blocked", fill: "#4c0519", accent: "#fb7185", text: "#fecdd3", icon: "none" },
    [LEVEL_KINDS.waiting]: { label: "Waiting", fill: "#1e1b4b", accent: "#a5b4fc", text: "#c7d2fe", icon: "none" },
  },
  lintRules: { "no-orphans": null, "no-cycles": null, "task-unassigned": null },
};
// The same hues dark enough to read on a light card (the registry's are for a dark canvas).
const LIGHT_ACCENTS: Record<string, string> = {
  [LEVEL_KINDS.journey]: "#047857",
  [LEVEL_KINDS.none]: "#475569",
  [LEVEL_KINDS.unapproved]: "#6d28d9",
  [LEVEL_KINDS.question]: "#b45309",
  [LEVEL_KINDS.blocked]: "#be123c",
  [LEVEL_KINDS.waiting]: "#4338ca",
};

// The app's own colours (globals.css) in place of BetterDiagrams' slate: the canvas is the page's ground, the bar, the
// legend and the cards the panels' surface. Written out rather than the app's variables, since a picture export takes
// them out of the page; the type and the corners are the app's own.
const PAPER = {
  bg: "#f0eee8",
  surface: "#fdfcf9",
  surface2: "#e8e5dd",
  border: "#d7d4cc",
  text: "#17191b",
  textDim: "#565a5c",
  accent: "#1f4bc6",
  accentInk: "#ffffff",
  gridDot: "#d3cfc5",
  shadowInk: "rgb(84 76 60 / 18%)",
};
const NIGHT = {
  bg: "#131412",
  surface: "#1c1d1a",
  surface2: "#0b0c0a",
  border: "#3a3b36",
  text: "#ecebe6",
  textDim: "#9e9d95",
  accent: "#93b2ff",
  accentInk: "#131412",
  gridDot: "#2c2d29",
  shadowInk: "rgb(0 0 0 / 55%)",
};
const TYPE = { font: "var(--font-text)", mono: "var(--font-code)", radius: "8px" };

interface Props {
  diagram: Record<string, unknown>;
  dark: boolean;
  narrow: boolean;
  filename: string;
  // Called when it opens and on every move to another level, once the editor has fitted the level to the box.
  onLevel: () => void;
}

// The editor, and all of the package it needs, load in the browser once the page is there: none of it is drawn on the
// server, and the page's own script stays small.
const Studio = dynamic(
  async () => {
    const bd = await import("@mosphere/better-diagrams");
    const validate = bd.registryValidateOptions(bd.createRegistry(REGISTRY));
    const light = { ...bd.LIGHT_THEME, ...PAPER, ...TYPE, nodeAccents: { ...bd.LIGHT_THEME.nodeAccents, ...LIGHT_ACCENTS } };
    const night = { ...bd.DARK_THEME, ...NIGHT, ...TYPE };
    return function LevelStudio({ diagram, dark, narrow, filename, onLevel }: Props) {
      const doc = useMemo(() => bd.validateTemplate(diagram, validate), [diagram]);
      // Open the level the address asks for once, when the editor is there: inside a card that holds something, or
      // where a task is. With nothing asked for and no journeys, the only card is the work in none: open it.
      const opened = useRef(false);
      const ready = useCallback(
        (studio: StudioHandle | null) => {
          if (!studio || opened.current) return;
          opened.current = true;
          const asked = new URLSearchParams(window.location.search).get("at");
          const at = asked === NO_JOURNEY ? NO_JOURNEY : asked ? `t${asked}` : null;
          const top = doc.nodes.filter((n) => !n.parentId);
          const open = at && doc.nodes.some((n) => n.id === at) ? at : top.length === 1 && top[0]!.id === NO_JOURNEY ? NO_JOURNEY : null;
          if (!open) return;
          if (doc.nodes.some((n) => n.parentId === open)) studio.drillTo([open]);
          else studio.navigateTo(open);
        },
        [doc]
      );
      // Passing no state lets Next's router follow the address (its own state would make it skip the change).
      // It reports the level on opening too, so the first level is settled here as well as each one after it.
      const moved = useCallback(
        (stack: string[]) => {
          const url = new URL(window.location.href);
          const level = stack.at(-1);
          if (level) url.searchParams.set("at", level.replace(/^t/, ""));
          else url.searchParams.delete("at");
          window.history.replaceState(null, "", url);
          onLevel();
        },
        [onLevel]
      );
      return (
        <bd.ArchitectureStudio
          ref={ready}
          value={doc}
          registry={REGISTRY}
          readOnly
          welcome={false}
          minimap={false}
          legend={!narrow}
          theme={dark ? night : light}
          filename={filename}
          onFocusChange={moved}
        />
      );
    };
  },
  { ssr: false, loading: () => <p className="empty">Drawing the graph…</p> }
);

// Whether a media query holds, kept up to date (false on the server, which draws none of this).
const DARK = "(prefers-color-scheme: dark)";
const NARROW = "(max-width: 560px)";
function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}

// The editor fits a level to the box at up to two and a half times life size, so a level of two cards would fill the
// window with them. Once the view has been still for a moment after a fit, anything over life size goes back to it with
// the editor's own 100% key, which keeps the middle where it is; then `done`. Pressed by the script, not the person:
// their own zooming afterwards is left alone.
function settle(box: HTMLElement | null, done: () => void) {
  if (!box) return;
  let last = "";
  let still = 0;
  let polls = 0;
  const timer = window.setInterval(() => {
    const reset = box.querySelector<HTMLButtonElement>(".as-zoom");
    const now = reset?.textContent ?? "";
    still = now === last ? still + 1 : 0;
    last = now;
    polls += 1;
    // At least 0.6 s, for the fit to start, and still for 0.3 s; never longer than 4 s.
    if (polls < 6 || (still < 3 && polls < 40)) return;
    window.clearInterval(timer);
    if (reset && Number.parseInt(now, 10) > 100) {
      reset.click();
      // The key's own move takes 120 ms.
      window.setTimeout(done, 160);
    } else done();
  }, 100);
}

export function LevelGraph({ diagram, filename }: { diagram: Record<string, unknown>; filename: string }) {
  const dark = useMedia(DARK);
  // On a phone the legend would cover most of the canvas.
  const narrow = useMedia(NARROW);
  const box = useRef<HTMLDivElement>(null);
  // The cards show once the first level has settled, so they don't open large and then shrink (globals.css); at the
  // latest after 5 s, whatever happened.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), 5000);
    return () => window.clearTimeout(timer);
  }, []);
  const level = useCallback(() => settle(box.current, () => setShown(true)), []);
  return (
    <div
      ref={box}
      className="level-graph"
      data-shown={shown ? "" : undefined}
      // The editor's Fit keys fit at up to the same size: settled the same way.
      onClickCapture={(event) => {
        const key = (event.target as Element).closest("button");
        if (key?.matches(".react-flow__controls-fitview") || (key?.matches(".as-toolbar .as-btn") && key.textContent === "Fit")) level();
      }}
    >
      <Studio diagram={diagram} dark={dark} narrow={narrow} filename={filename} onLevel={level} />
    </div>
  );
}
