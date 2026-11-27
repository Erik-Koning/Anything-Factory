"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export interface SwitchTo {
  name: string;
  title: string;
  state: string;
  // The team's pages this person may open there ("" is the overview), to stay on the same one when they can.
  sections: string[];
}

// The other teams a person follows, each with its state, keeping the page they're on (the board, Requests…) when
// it's open to them there. A page about one task or request goes to that list instead: ids are a team's own.
export function TeamSwitcher({ current, teams }: { current: string; teams: SwitchTo[] }) {
  const path = usePathname();
  const section = path.split("/")[3] ?? "";
  const list = section === "tasks" ? "board" : section;
  const others = teams.filter((t) => t.name !== current);
  const menu = useRef<HTMLDetailsElement>(null);
  // Closes like a menu: on Escape (focus back on its button) and on a click anywhere else.
  useEffect(() => {
    const close = (event: KeyboardEvent | PointerEvent) => {
      const details = menu.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        details.open = false;
        details.querySelector("summary")?.focus();
      } else if (!details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, []);
  if (!others.length) return null;
  return (
    <details className="switcher" ref={menu}>
      {/* On a phone the key says only "Switch", and on the narrowest only its arrows, so it stays on the line of the
          team's controls: the words stay for a screen reader. */}
      <summary>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
          <path d="M2.5 5.5h10m-3-3 3 3-3 3M13.5 10.5h-10m3-3-3 3 3 3" />
        </svg>
        <span>
          <span className="switch-word">Switch</span>
          <span className="switch-team"> team</span>
        </span>
      </summary>
      <ul className="plain">
        {others.map((t) => (
          <li key={t.name}>
            <Link
              href={`/t/${t.name}${t.sections.includes(list) && list ? `/${list}` : ""}`}
              onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
            >
              <span>{t.title || t.name}</span>{" "}
              <span className={`chip ${t.state === "active" ? "ok" : t.state === "paused" ? "caution" : ""}`.trim()}>{t.state}</span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
