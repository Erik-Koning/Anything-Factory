"use client";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useActionPending } from "./action-form.tsx";

// A form's submit button, disabled while its server action runs (a plain form's, or an ActionForm's). `label` is its
// full name for a screen reader when the words on it are short because the row around it says the rest ("Save" beside
// a person's name and team).
export function SubmitButton({
  children,
  className,
  name,
  value,
  label,
}: {
  children: ReactNode;
  className?: string;
  name?: string;
  value?: string;
  label?: string;
}) {
  const status = useFormStatus();
  const acting = useActionPending();
  const pending = status.pending || acting;
  return (
    <button type="submit" className={className} name={name} value={value} aria-label={label} disabled={pending} aria-disabled={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}
