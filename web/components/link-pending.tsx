"use client";
import { useLinkStatus } from "next/link";

// Inside a link of the main menu or a team's tabs: marks it from the click until its page is there, so it shows as the
// current one at once (globals.css) while the page it leaves stays up.
export function LinkPending() {
  const { pending } = useLinkStatus();
  return pending ? <span className="link-pending" aria-hidden="true" /> : null;
}
