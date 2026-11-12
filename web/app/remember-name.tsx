"use client";
import { useEffect } from "react";
import { rememberFirstName } from "./first-name.ts";

// On any page a signed-in person opens, however they signed in: their first name, kept in this browser for the
// sign-in page's greeting (first-name.ts).
export function RememberName({ name }: { name: string }) {
  useEffect(() => rememberFirstName(name), [name]);
  return null;
}
