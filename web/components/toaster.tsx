"use client";
// What a button did, said in a toast: over the page, never in it, so nothing the person is looking at moves; in the
// lower right corner on a wide screen, dropping in from the top on a phone (globals.css). One at a time, the newest
// replacing the one before; a success goes after a few seconds, a refusal stays a little longer, and neither goes while
// the pointer or the focus is on it. Either goes at once with its close button, Escape, or a swipe up on a phone. toast() is for any client component; a
// server action's word comes back through components/action-form.tsx, and a signed notice in the address (an action
// that went to another page) through ui.tsx's Notice.
import { useCallback, useEffect, useRef, useState } from "react";

export type Tone = "ok" | "error";
interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

const listeners = new Set<(toast: Toast) => void>();
let next = 1;
// Said before the toaster mounted (a notice on the first page loaded): kept for it.
let early: Toast | null = null;

export function toast(text: string, tone: Tone = "ok"): void {
  const said = { id: next++, tone, text };
  if (!listeners.size) early = said;
  for (const listener of listeners) listener(said);
}

const SHOWN_MS: Record<Tone, number> = { ok: 5000, error: 9000 };
// How far up a finger moves a toast to put it away.
const SWIPE_PX = 24;

export function Toaster() {
  const [shown, setShown] = useState<Toast | null>(null);
  // Held while the pointer or the focus is on it: it stays until they leave.
  const [held, setHeld] = useState(false);
  const touched = useRef<number | null>(null);
  const close = useCallback(() => {
    setShown(null);
    setHeld(false);
  }, []);
  useEffect(() => {
    listeners.add(setShown);
    if (early) {
      setShown(early);
      early = null;
    }
    return () => {
      listeners.delete(setShown);
    };
  }, []);
  useEffect(() => {
    if (!shown || held) return;
    const timer = setTimeout(close, SHOWN_MS[shown.tone]);
    return () => clearTimeout(timer);
  }, [shown, held, close]);
  useEffect(() => {
    if (!shown) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [shown, close]);
  return (
    <div className="toasts">
      {shown ? (
        <div
          key={shown.id}
          className={`toast ${shown.tone}`}
          role={shown.tone === "error" ? "alert" : "status"}
          onPointerEnter={(event) => event.pointerType === "mouse" && setHeld(true)}
          onPointerLeave={(event) => event.pointerType === "mouse" && setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
          onTouchStart={(event) => {
            touched.current = event.touches[0]?.clientY ?? null;
          }}
          onTouchEnd={(event) => {
            const from = touched.current;
            const to = event.changedTouches[0]?.clientY;
            touched.current = null;
            if (from !== null && to !== undefined && from - to > SWIPE_PX) close();
          }}
        >
          <span>{shown.text}</span>
          <button type="button" className="quiet s" aria-label="Dismiss" onClick={close}>
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
