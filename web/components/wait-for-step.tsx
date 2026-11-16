"use client";
// A page that waits on a step done somewhere else (the confirm-sign-in page, on the email's answer): it asks every few
// seconds, and as soon as the tab is looked at again, whether the session still owes `step`, and goes on by itself
// once it doesn't. A full load, never the router's copy of a page that sent it here a moment ago.
import { useEffect, useState } from "react";

const EVERY_MS = 3000;
// As long as the emailed link works.
const FOR_MS = 30 * 60_000;

export function WaitForStep({ step }: { step: string }) {
  const [said, setSaid] = useState("Waiting for your answer: this page goes on by itself.");
  useEffect(() => {
    let done = false;
    const until = Date.now() + FOR_MS;
    const ask = async () => {
      if (done || document.visibilityState !== "visible") return;
      try {
        const answer = await fetch("/api/sign-in/step", { cache: "no-store", credentials: "same-origin" });
        if (!answer.ok) return;
        const { step: now, next } = (await answer.json()) as { step: string | null; next: string };
        if (now === step || done) return;
        done = true;
        setSaid(now === "signed-out" ? "Signed out." : "Confirmed. Going on…");
        window.location.replace(next || "/");
      } catch {
        // Offline for a moment: the next ask tries again.
      }
    };
    const timer = window.setInterval(() => {
      if (Date.now() < until) void ask();
      else {
        window.clearInterval(timer);
        setSaid("The link has run out: email yourself a new one below.");
      }
    }, EVERY_MS);
    const back = () => void ask();
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      done = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [step]);
  return (
    <p className="notice waiting-step" role="status" aria-live="polite">
      {said}
    </p>
  );
}
