"use client";
import type { ComponentProps } from "react";
import { showFocused } from "./in-view.ts";

// A region that scrolls sideways, keeping what the keyboard reaches in view: all of the part of it that `whole`
// names, when it's inside one.
export function Sideways({ whole, ...props }: ComponentProps<"div"> & { whole?: string }) {
  return <div {...props} onFocus={(e) => showFocused(e, whole)} />;
}
