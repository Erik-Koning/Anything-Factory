"use client";
// What a button did, said in a toast: over the page in a corner, never in it, so nothing the person is looking at
// moves. One at a time, the newest replacing the one before; a success goes after a few seconds, a refusal stays a
// little longer, and either goes at once with its close button or Escape. toast() is for any client component; a
// server action's word comes back through components/action-form.tsx, and a signed notice in the address (an action
// that went to another page) through ui.tsx's Notice.
import { useCallback, useEffect, useState } from "react";

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

export function Toaster() {
  const [shown, setShown] = useState<Toast | null>(null);
  const close = useCallback(() => setShown(null), []);
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
    if (!shown) return;
    const timer = setTimeout(close, SHOWN_MS[shown.tone]);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", escape);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", escape);
    };
  }, [shown, close]);
  return (
    <div className="toasts">
      {shown ? (
        <div key={shown.id} className={`toast ${shown.tone}`} role={shown.tone === "error" ? "alert" : "status"}>
          <span>{shown.text}</span>
          <button type="button" className="quiet s" aria-label="Dismiss" onClick={close}>
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
