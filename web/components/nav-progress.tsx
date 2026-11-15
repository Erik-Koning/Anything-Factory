"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// A line along the top while the next page comes: from the click on a link to another page of the app (or a search
// form's submit) until the address changes. It shows only once a page takes a moment (DELAY), creeps toward the end
// without reaching it, and runs out to the end when the page is there. Meanwhile the page being left fades a little
// (data-navigating on the document, globals.css), and the link clicked shows as the current one (link-pending.tsx).
// Decorative: the address and the page's heading say where you are to a screen reader once it's there.
const DELAY = 90;
// However the page went (a redirect back to where it was, say), the line doesn't stay.
const GIVE_UP = 12_000;

const elsewhere = (url: URL): boolean => url.origin === location.origin && (url.pathname !== location.pathname || url.search !== location.search);

export function NavProgress() {
  const path = usePathname();
  const search = useSearchParams().toString();
  const [at, setAt] = useState<number | null>(null);
  const finish = useRef<() => void>(() => {});

  useEffect(() => {
    let timers: number[] = [];
    const clear = () => {
      for (const id of timers) clearTimeout(id);
      timers = [];
    };
    const start = () => {
      clear();
      document.documentElement.dataset["navigating"] = "";
      timers.push(
        window.setTimeout(() => {
          setAt(0.08);
          // Each step a little of what's left: quick at first, never there.
          timers.push(window.setInterval(() => setAt((p) => (p === null ? p : p + (0.9 - p) * 0.06)), 200));
        }, DELAY),
        window.setTimeout(() => finish.current(), GIVE_UP)
      );
    };
    finish.current = () => {
      clear();
      delete document.documentElement.dataset["navigating"];
      setAt((p) => (p === null ? null : 1));
      timers.push(window.setTimeout(() => setAt(null), 260));
    };
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      if (elsewhere(new URL(link.href))) start();
    };
    const onSubmit = (event: SubmitEvent) => {
      if (event.target instanceof HTMLFormElement && event.target.method === "get") start();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      clear();
      delete document.documentElement.dataset["navigating"];
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, []);

  // The new page is there: its address is.
  useEffect(() => finish.current(), [path, search]);

  return (
    <div className="nav-progress" aria-hidden="true" data-state={at === null ? "idle" : at >= 1 ? "done" : "loading"}>
      <span style={{ transform: `scaleX(${at ?? 0})` }} />
    </div>
  );
}
