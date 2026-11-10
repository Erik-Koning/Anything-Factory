import type { FocusEvent } from "react";

// A row that scrolls sideways on a narrow screen (the main links, a team's pages, the board): what's in it stays in
// view. Only the row moves, never the page.

// Clear of the fade at the row's edge.
const EDGE = 28;

// Bring `item` into view in `row`: centred, or just clear of the nearest edge.
export function showIn(row: Element, item: Element, centre = false): void {
  const r = row.getBoundingClientRect();
  const i = item.getBoundingClientRect();
  if (centre) row.scrollLeft += i.left - r.left - (r.width - i.width) / 2;
  else if (i.left < r.left + EDGE) row.scrollLeft += i.left - r.left - EDGE;
  else if (i.right > r.right - EDGE) row.scrollLeft += i.right - r.right + EDGE;
}

// The current page's link, centred in `row` (a row that fits doesn't move).
export function showCurrent(row: Element | null): void {
  const current = row?.querySelector('[aria-current="page"]');
  if (row && current) showIn(row, current, true);
}

// For a row's onFocus: what the keyboard reaches is brought fully in (a browser only does that for what is wholly
// out of view). `whole` names the part around it to bring in instead: a board's lane, which the board snaps to.
export function showFocused(e: FocusEvent<HTMLElement>, whole?: string): void {
  if (e.target === e.currentTarget || !e.target.matches(":focus-visible")) return;
  showIn(e.currentTarget, (whole ? e.target.closest(whole) : null) ?? e.target);
}
