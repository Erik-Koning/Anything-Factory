"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
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

// On the menu's button, what waits on the operator: the same count as its link, said in words to a screen reader.
function MenuCount({ count, label }: { count: Count; label: string }) {
  const n = useCount(count);
  return n ? (
    <>
      <span className="badge" aria-hidden="true">
        {n}
      </span>
      <span className="sr">
        , {n} {label.toLowerCase()}
      </span>
    </>
  ) : null;
}

type NavLinks = { href: string; label: string; count?: Count }[];

// The app's pages, the current one marked for screen readers too, and how many wait on the operator (a badge). A
// wide window shows them in a row in the top bar. A narrow one has a Menu key there instead, with the count on it, that
// opens them as a list over the page, with who is signed in (`who`) under it. The menu is a <details>, so it opens
// with no script at all; with one it closes like the other menus (on Escape, focus back on its key, and on a press
// elsewhere) and once a link in it is followed.
export function MainNav({ links, who }: { links: NavLinks; who?: ReactNode }) {
  const path = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  // A team's pages are under Teams, and so is starting one.
  const under = (href: string) =>
    href === "/" ? path === "/" || path === "/new" || path.startsWith("/t/") : path === href || path.startsWith(`${href}/`);
  const items = links.map(({ href, label, count = 0 }) => <NavLink key={href} href={href} label={label} count={count} current={under(href)} />);
  const counted = links.find(({ count }) => count !== undefined && count !== 0);

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
  // A page reached some other way (back, a link on the page) shuts it too.
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [path]);

  return (
    <>
      <nav aria-label="Main" className="main-nav">
        {items}
      </nav>
      <details className="main-menu" ref={menu}>
        <summary>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
          </svg>
          Menu
          {counted ? <MenuCount count={counted.count ?? 0} label={counted.label} /> : null}
        </summary>
        <div className="main-menu-items">
          <nav
            aria-label="Main"
            onClick={(event) => {
              if ((event.target as Element).closest("a")) event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            {items}
          </nav>
          {who ? <div className="main-menu-who">{who}</div> : null}
        </div>
      </details>
    </>
  );
}
