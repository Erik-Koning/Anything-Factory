"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// The app's pages, the current one marked for screen readers too, and how many wait on the operator (a badge).
export function MainNav({ links }: { links: { href: string; label: string; count?: number }[] }) {
  const path = usePathname();
  // A team's pages are under Teams.
  const under = (href: string) => (href === "/" ? path === "/" || path.startsWith("/t/") : path === href || path.startsWith(`${href}/`));
  return (
    <nav aria-label="Main">
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
