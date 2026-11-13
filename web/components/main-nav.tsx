"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { showCurrent, showFocused } from "./in-view.ts";

// The app's pages, the current one marked for screen readers too, and how many wait on the operator (a badge).
export function MainNav({ links }: { links: { href: string; label: string; count?: number }[] }) {
  const path = usePathname();
  // On a phone the links are one row that scrolls sideways: the current page's stays in view.
  const row = useRef<HTMLElement>(null);
  useEffect(() => showCurrent(row.current), [path]);
  // A team's pages are under Teams, and so is starting one.
  const under = (href: string) =>
    href === "/" ? path === "/" || path === "/new" || path.startsWith("/t/") : path === href || path.startsWith(`${href}/`);
  return (
    <nav aria-label="Main" ref={row} onFocus={(e) => showFocused(e)}>
      {links.map(({ href, label, count = 0 }) => (
        <Link key={href} href={href} className={count ? "attention" : undefined} aria-current={under(href) ? "page" : undefined}>
          {label}
          {count ? (
            <>
              {" "}
              <span className="badge">{count}</span>
            </>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
