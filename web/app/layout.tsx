import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { MainNav } from "../components/main-nav.tsx";
import { NavProgress } from "../components/nav-progress.tsx";
import { Toaster } from "../components/toaster.tsx";
import { blocked, can } from "../server/access.ts";
import { allTeams, tasksFor } from "../server/factory.ts";
import { waitingCount } from "../server/inbox.ts";
import { getViewer, type Person } from "../server/viewer.ts";
import { RememberName } from "./remember-name.tsx";
import { SignOutButton } from "./sign-out-button.tsx";
import "./globals.css";

// Served from this app, never a font service: Geist for text, Martian Mono (its width axis too) for ids, figures and
// part labels. Both are under the SIL Open Font License (fonts/LICENSE-*.txt).
const sans = localFont({ src: "./fonts/geist.woff2", variable: "--font-sans", weight: "100 900", display: "swap" });
const mono = localFont({
  src: "./fonts/martian-mono.woff2",
  variable: "--font-mono",
  weight: "100 800",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "75% 112.5%" }],
});

// Every page is the signed-in person's own, from live data: never prerendered or cached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Anything Factory", template: "%s · Anything Factory" },
  description: "Requests, decisions and each team's state",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fdfcf9" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1d1a" },
  ],
};

// What waits on an admin, on every team they decide for: the header says how much on every page, and never fails one.
// Streamed in (components/main-nav.tsx): no page waits for it.
async function waitingFor(viewer: Person): Promise<number> {
  try {
    const teams = (await allTeams()).filter((team) => can(viewer, "proposals:decide", team.name));
    const counts = await Promise.all(teams.map(async (team) => waitingCount(await tasksFor(team.name))));
    return counts.reduce((n, count) => n + count, 0);
  } catch {
    return 0;
  }
}

// A factory's sawtooth roof on a tile of the brand's solid. Decorative: the words beside it are the name.
function Mark() {
  return (
    <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true" focusable="false">
      <rect className="tile" width="28" height="28" rx="7" />
      <path className="roof" d="M6 20.5v-8.2l5 3.2v-3.2l5 3.2V7.5h6v13z" />
    </svg>
  );
}

// Who is signed in, and the way out: at the right of the top bar, or under the links in a narrow window's menu.
function Who({ viewer }: { viewer: Person }) {
  return (
    <>
      <span>{viewer.name || viewer.email}</span>
      {viewer.admin ? <span className="chip">admin</span> : null}
      <SignOutButton className="quiet s" />
    </>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  const signedIn = viewer !== null && !blocked(viewer);
  const waiting = signedIn && viewer.admin ? waitingFor(viewer) : 0;
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        <a className="skip" href="#main">
          Skip to the content
        </a>
        <header className="top">
          <div className="top-inner">
            <Link className="brand" href="/">
              <Mark />
              Anything Factory
            </Link>
            {signedIn ? (
              <MainNav
                links={[
                  { href: "/", label: "Teams" },
                  ...(viewer.admin ? [{ href: "/inbox", label: "Waiting on you", count: waiting }] : []),
                  { href: "/machines", label: "Machines" },
                  { href: "/subscriptions", label: "Subscriptions" },
                  ...(viewer.admin
                    ? [
                        { href: "/admin/people", label: "People" },
                        { href: "/admin/audit", label: "Audit" },
                      ]
                    : []),
                  { href: "/account", label: "Account" },
                ]}
                who={<Who viewer={viewer} />}
              />
            ) : (
              <span className="spacer" />
            )}
            {viewer ? (
              <span className="who">
                <Who viewer={viewer} />
              </span>
            ) : null}
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        {signedIn ? <RememberName name={viewer.name} /> : null}
        <Toaster />
      </body>
    </html>
  );
}
