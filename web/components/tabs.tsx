"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { showCurrent, showFocused } from "./in-view.ts";

// A team's pages, the current one marked for screen readers too, and how many wait on one (a badge).
export function Tabs({ links }: { links: { href: string; label: string; exact?: boolean; also?: string[]; count?: number }[] }) {
  const path = usePathname();
  // On a phone the pages are one row that scrolls sideways: the current one stays in view.
  const row = useRef<HTMLUListElement>(null);
  useEffect(() => showCurrent(row.current), [path]);
  return (
    <nav aria-label="Team">
      <ul className="tabs" ref={row} onFocus={(e) => showFocused(e)}>
        {links.map(({ href, label, exact, also = [], count = 0 }) => {
          const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
          const current = exact ? path === href : under(href) || also.some(under);
          return (
            <li key={href}>
              <Link href={href} aria-current={current ? "page" : undefined}>
                {label}
                {count ? (
                  <>
                    {" "}
                    <span className="badge">{count}</span>
                  </>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
