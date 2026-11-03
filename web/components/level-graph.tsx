"use client";
// The task graph by level, in BetterDiagrams' editor, read-only: the journeys on the top level, a double-click (or a
// card's ⊞) to open one, breadcrumbs and Esc to come back out; no minimap, since a level is small, and no legend on a
// phone. The level it's on goes in the address (?at=), so a reload, a link or going back opens the same one. Light or
// dark as the system is, like the app.
import "@mosphere/better-diagrams/styles.css";
import type { RegistryExtensions, StudioHandle } from "@mosphere/better-diagrams";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
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

interface Props {
  diagram: Record<string, unknown>;
  dark: boolean;
  narrow: boolean;
  filename: string;
}

// The editor, and all of the package it needs, load in the browser once the page is there: none of it is drawn on the
// server, and the page's own script stays small.
const Studio = dynamic(
  async () => {
    const bd = await import("@mosphere/better-diagrams");
    const validate = bd.registryValidateOptions(bd.createRegistry(REGISTRY));
    const light = { ...bd.LIGHT_THEME, nodeAccents: { ...bd.LIGHT_THEME.nodeAccents, ...LIGHT_ACCENTS } };
    return function LevelStudio({ diagram, dark, narrow, filename }: Props) {
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
      const moved = useCallback((stack: string[]) => {
        const url = new URL(window.location.href);
        const level = stack.at(-1);
        if (level) url.searchParams.set("at", level.replace(/^t/, ""));
        else url.searchParams.delete("at");
        window.history.replaceState(null, "", url);
      }, []);
      return (
        <bd.ArchitectureStudio
          ref={ready}
          value={doc}
          registry={REGISTRY}
          readOnly
          welcome={false}
          minimap={false}
          legend={!narrow}
          theme={dark ? bd.DARK_THEME : light}
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

export function LevelGraph({ diagram, filename }: { diagram: Record<string, unknown>; filename: string }) {
  const dark = useMedia(DARK);
  // On a phone the legend would cover most of the canvas.
  const narrow = useMedia(NARROW);
  return (
    <div className="level-graph">
      <Studio diagram={diagram} dark={dark} narrow={narrow} filename={filename} />
    </div>
  );
}
