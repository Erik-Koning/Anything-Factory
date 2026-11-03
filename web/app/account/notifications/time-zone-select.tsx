"use client";
import { useEffect, useState } from "react";

// The digest's time zone: the one saved, or until there is one, the browser's own.
export function TimeZoneSelect({ name, value, zones, detect }: { name: string; value: string; zones: string[]; detect: boolean }) {
  const [zone, setZone] = useState(value);
  const [detected, setDetected] = useState(false);
  useEffect(() => {
    if (!detect) return;
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (own && zones.includes(own) && own !== value) {
      setZone(own);
      setDetected(true);
    }
  }, [detect, value, zones]);
  return (
    <>
      <select name={name} value={zone} onChange={(event) => setZone(event.target.value)} aria-describedby={detected ? `${name}-detected` : undefined}>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      {detected ? (
        <span id={`${name}-detected`} className="hint">
          Your browser&apos;s; save to keep it.
        </span>
      ) : null}
    </>
  );
}
