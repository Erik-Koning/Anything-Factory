"use client";
// On a phone the view and the window are menus rather than rows of keys, as T3 Code's are: choosing one goes there.
import { useRouter } from "next/navigation";

export function ViewSelect({ label, items }: { label: string; items: { label: string; href: string; on: boolean }[] }) {
  const router = useRouter();
  const current = items.find((item) => item.on)?.href ?? items[0]?.href ?? "";
  return (
    <label className="usage-select">
      <span className="sr">{label}</span>
      <select value={current} onChange={(e) => router.push(e.target.value, { scroll: false })}>
        {items.map((item) => (
          <option key={item.href} value={item.href}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}
