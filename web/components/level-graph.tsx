"use client";
// The task graph by level, in BetterDiagrams' editor, read-only: the journeys on the top level, a double-click (or a
// card's ⊞) to open one, breadcrumbs and Esc to come back out; no minimap, since a level is small. The level it's on
// goes in the address (?at=), so a reload or a link opens the same one. Light or dark as the system is, like the app.
import "@mosphere/better-diagrams/styles.css";
import {
  createRegistry,
  DARK_THEME,
  LIGHT_THEME,
  type RegistryExtensions,
  registryValidateOptions,
  type StudioHandle,
  validateTemplate,
} from "@mosphere/better-diagrams";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { LEVEL_KINDS } from "../../lib/tasks/graph.ts";

// It draws on a canvas in the browser: nothing to render on the server.
const Studio = dynamic(() => import("@mosphere/better-diagrams").then((m) => m.ArchitectureStudio), {
  ssr: false,
  loading: () => <p className="empty">Drawing the graph…</p>,
});

// The cards that aren't tasks: a journey in emerald, a hue no built-in kind wears, and the work in no journey in slate.
const REGISTRY: RegistryExtensions = {
  nodeKinds: {
    [LEVEL_KINDS.journey]: { label: "Journey", fill: "#022c22", accent: "#34d399", text: "#a7f3d0", icon: "layers" },
    [LEVEL_KINDS.none]: { label: "Tasks", fill: "#0f172a", accent: "#94a3b8", text: "#e2e8f0", icon: "folder" },
  },
};
const VALIDATE = registryValidateOptions(createRegistry(REGISTRY));

const DARK = "(prefers-color-scheme: dark)";
const subscribe = (changed: () => void) => {
  const query = window.matchMedia(DARK);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};

export function LevelGraph({ diagram, at, filename }: { diagram: Record<string, unknown>; at: string | null; filename: string }) {
  const doc = useMemo(() => validateTemplate(diagram, VALIDATE), [diagram]);
  const dark = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DARK).matches,
    () => false
  );
  // Open the level asked for once, when the editor is there: inside a card that holds something, or where a task is.
  const opened = useRef(false);
  const ready = useCallback(
    (studio: StudioHandle | null) => {
      if (!studio || opened.current) return;
      opened.current = true;
      if (!at || !doc.nodes.some((n) => n.id === at)) return;
      if (doc.nodes.some((n) => n.parentId === at)) studio.drillTo([at]);
      else studio.navigateTo(at);
    },
    [doc, at]
  );
  const moved = useCallback((stack: string[]) => {
    const url = new URL(window.location.href);
    const level = stack.at(-1);
    if (level) url.searchParams.set("at", level.replace(/^t/, ""));
    else url.searchParams.delete("at");
    window.history.replaceState(window.history.state, "", url);
  }, []);
  return (
    <div className="level-graph">
      <Studio
        ref={ready}
        value={doc}
        registry={REGISTRY}
        readOnly
        welcome={false}
        minimap={false}
        theme={dark ? DARK_THEME : LIGHT_THEME}
        filename={filename}
        onFocusChange={moved}
      />
    </div>
  );
}
