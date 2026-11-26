"use client";
// A moment (an ISO time, as a machine reports it) in the browser's own zone, once that's known: "Fri 27 Nov, 06:00".
// Until then in UTC, which it says.
import { useEffect, useState } from "react";

const label = (at: string, timeZone: string): string =>
  `${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(at))}${timeZone === "UTC" ? " UTC" : ""}`;

export function LocalMoment({ at }: { at: string }) {
  const [zone, setZone] = useState("UTC");
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  return <time dateTime={at}>{label(at, zone)}</time>;
}
