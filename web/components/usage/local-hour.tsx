"use client";
// An hour (UTC, as a machine reports it) in the browser's own zone, once that's known: "Nov 15, 3 PM".
import { useEffect, useState } from "react";
import { hourLabel } from "./format.ts";

export function LocalHour({ hour, now }: { hour: string; now: number }) {
  const [zone, setZone] = useState("UTC");
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  return <time dateTime={`${hour}:00Z`}>{hourLabel(hour, zone, now)}</time>;
}
