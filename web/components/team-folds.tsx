"use client";
import { type ReactNode, useEffect, useRef, useState } from "react";

const OPEN_KEY = "a6g.teams.open";
const ONE_KEY = "a6g.teams.one";

const stored = <T,>(key: string, fallback: T): T => {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
};
const keep = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

// The Teams page's rows fold: each is a <details> the server made (so it opens and shuts with no script at all), and
// this keeps what the person left open in their browser, opens the one a link names (#<team>), and offers all open,
// all shut, or one at a time. One at a time is the browser's own: details that share a name shut each other.
export function TeamFolds({ count, children }: { count: number; children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const [one, setOne] = useState(false);
  const rows = (): HTMLDetailsElement[] => [...(list.current?.querySelectorAll<HTMLDetailsElement>("details.team") ?? [])];
  const save = () =>
    keep(
      OPEN_KEY,
      rows()
        .filter((row) => row.open)
        .map((row) => row.id)
    );
  const group = (on: boolean) => {
    for (const row of rows()) {
      if (on) row.setAttribute("name", "teams");
      else row.removeAttribute("name");
    }
  };

  useEffect(() => {
    const all = rows();
    const before = stored<string[] | null>(OPEN_KEY, null);
    const single = stored<boolean>(ONE_KEY, false);
    // What they left open, of the teams still here.
    if (before) for (const row of all) row.open = before.includes(row.id);
    if (single) {
      // Only the first one open stays open.
      let seen = false;
      for (const row of all) {
        if (row.open && seen) row.open = false;
        seen ||= row.open;
      }
      group(true);
      setOne(true);
    }
    // A link that names a team (#<team>) opens it whatever was left, and alone when it's one at a time: as the page
    // loads, and when the address changes on a page that's already there.
    const named = () => {
      const target = all.find((row) => row.id === decodeURIComponent(window.location.hash.slice(1)));
      if (!target) return;
      if (target.hasAttribute("name")) for (const row of all) row.open = row === target;
      else target.open = true;
      target.scrollIntoView({ block: "nearest" });
    };
    named();
    const toggled = () => save();
    for (const row of all) row.addEventListener("toggle", toggled);
    window.addEventListener("hashchange", named);
    return () => {
      for (const row of all) row.removeEventListener("toggle", toggled);
      window.removeEventListener("hashchange", named);
    };
    // The rows are the server's: when the number of teams changes, they're looked for again.
  }, [count]);

  const setAll = (open: boolean) => {
    for (const row of rows()) row.open = open;
    save();
  };
  const toggleOne = (on: boolean) => {
    setOne(on);
    keep(ONE_KEY, on);
    if (on) {
      let seen = false;
      for (const row of rows()) {
        if (row.open && seen) row.open = false;
        seen ||= row.open;
      }
    }
    group(on);
    save();
  };

  return (
    <div ref={list} className="team-folds">
      {/* Folding has its own words (expand, collapse): "open" is what a row's key does, which goes to the team's page. */}
      <div className="folds-bar">
        <h2 id="all-teams">
          All teams <span className="muted">{count}</span>
        </h2>
        {count > 1 ? (
          <div className="folds-keys">
            {/* A mode, not an action: it stays pressed and ticked while it holds (opening one row then shuts the others),
                and stands apart from the two keys that act once. */}
            <button type="button" className="quiet s mode" aria-pressed={one} onClick={() => toggleOne(!one)}>
              {one ? (
                <span className="sign" aria-hidden="true">
                  ✓{" "}
                </span>
              ) : null}
              One at a time
            </button>
            <span className="divider" aria-hidden="true" />
            <button type="button" className="quiet s" onClick={() => setAll(true)} disabled={one}>
              Expand all
            </button>
            <button type="button" className="quiet s" onClick={() => setAll(false)}>
              Collapse all
            </button>
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
