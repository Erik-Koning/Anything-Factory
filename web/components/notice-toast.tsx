"use client";
// A signed notice that came in the address (?ok=… or ?error=…, from an action that went to another page), said as a
// toast once, then taken out of the address so a reload or a shared link doesn't say it again. It draws nothing on the
// page itself.
import { useEffect } from "react";
import { type Tone, toast } from "./toaster.tsx";

export function NoticeToast({ text, tone }: { text: string; tone: Tone }) {
  useEffect(() => {
    toast(text, tone);
    const url = new URL(window.location.href);
    for (const key of ["ok", "error", "sig"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [text, tone]);
  return null;
}
