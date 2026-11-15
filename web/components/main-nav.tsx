"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { showCurrent, showFocused } from "./in-view.ts";
import { LinkPending } from "./link-pending.tsx";

// A count the server is still working out (the layout streams it): the link shows the count it had until then (none,
// on a first load). Never through Suspense: React holds a page rendered again (after an answer, say) until every
// boundary it had shown is ready again, so the page would wait for the count.
type Count = number | Promise<number>;
function useCount(count: Count): number {
  const [settled, setSettled] = useState(typeof count === "number" ? count : 0);
  useEffect(() => {
    if (typeof count === "number") return;
    let live = true;
    count.then(
      (n) => live && setSettled(n),
      () => {}
    );
    return () => {
      live = false;
    };
  }, [count]);
  return typeof count === "number" ? count : settled;
}

function NavLink({ href, label, count, current }: { href: string; label: string; count: Count; current: boolean }) {
  const n = useCount(count);
  return (
    <Link href={href} className={n ? "attention" : undefined} aria-current={current ? "page" : undefined}>
      <LinkPending />
      {label}
      {n ? (
        <>
          {" "}
          <span className="badge">{n}</span>
        </>
      ) : null}
    </Link>
  );
}

// The app's pages, the current one marked for screen readers too, and how many wait on the operator (a badge).
export function MainNav({ links }: { links: { href: string; label: string; count?: Count }[] }) {
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
        <NavLink key={href} href={href} label={label} count={count} current={under(href)} />
      ))}
    </nav>
  );
}
