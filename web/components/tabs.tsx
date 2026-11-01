"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// A team's pages, the current one marked for screen readers too.
export function Tabs({ links }: { links: { href: string; label: string; exact?: boolean; also?: string[] }[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Team">
      <ul className="tabs">
        {links.map(({ href, label, exact, also = [] }) => {
          const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
          const current = exact ? path === href : under(href) || also.some(under);
          return (
            <li key={href}>
              <Link href={href} aria-current={current ? "page" : undefined}>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
