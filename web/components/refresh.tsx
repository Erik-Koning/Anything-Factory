"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Reads the page again every `every` seconds while something on it is in flight (a project being started, a control
// the team's Mac hasn't applied yet): the Mac asks the app, never the other way, so the page asks too. It rests while
// the tab is hidden, and stops after `forMinutes`, when whoever left it open has stopped watching.
export function Refresh({ every = 10, forMinutes = 30 }: { every?: number; forMinutes?: number }) {
  const router = useRouter();
  useEffect(() => {
    const until = Date.now() + forMinutes * 60_000;
    const timer = setInterval(() => {
      if (Date.now() > until) return clearInterval(timer);
      if (!document.hidden) router.refresh();
    }, every * 1000);
    // Back on the tab after a while away: at once, rather than at the next tick.
    const seen = () => {
      if (!document.hidden && Date.now() <= until) router.refresh();
    };
    document.addEventListener("visibilitychange", seen);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [router, every, forMinutes]);
  return null;
}
