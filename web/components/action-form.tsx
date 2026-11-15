"use client";
// A form whose server action does its work in place: the page stays where it is (the action refreshes its data, never
// navigates), and what came of it is a toast (components/toaster.tsx), not a notice that pushes the page down. On
// success the form is cleared and the dialog or the open part it's in closes; on a refusal what was typed stays, to
// put right. The button that was pressed goes with the form, as a plain submit would send it.
import { createContext, type FormEvent, type ReactNode, useContext, useTransition } from "react";
import type { ActionResult } from "./action-result.ts";
import { toast } from "./toaster.tsx";

export type { ActionResult };

const Pending = createContext(false);
// Whether the form around a button is waiting on its action (components/submit-button.tsx).
export const useActionPending = (): boolean => useContext(Pending);

export function ActionForm({
  action,
  children,
  className,
  keepOpen = false,
  label,
}: {
  action: (form: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  // Leave the dialog or open part it's in open after a success.
  keepOpen?: boolean;
  label?: string;
}) {
  const [pending, start] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(form, submitter instanceof HTMLButtonElement ? submitter : null);
    start(async () => {
      let result: ActionResult;
      try {
        result = (await action(data)) ?? {};
      } catch (error) {
        // A redirect is the framework's to follow; anything else is said.
        if (error instanceof Error && /NEXT_REDIRECT/.test(error.message)) throw error;
        result = { error: "That didn't reach the server. Check your connection, then try again." };
      }
      if (result.error) {
        toast(result.error, "error");
        return;
      }
      if (result.ok) toast(result.ok);
      form.reset();
      if (!keepOpen) {
        form.closest("dialog")?.close();
        form.closest("details")?.removeAttribute("open");
      }
    });
  };
  return (
    <Pending value={pending}>
      {/* The action as the form's own too: a browser without scripts posts it as a plain form (the page comes back as it
          stands), and React's hidden field names it. With scripts, submit() above runs it and React leaves it be. */}
      <form
        action={action as unknown as (form: FormData) => Promise<void>}
        onSubmit={submit}
        className={className}
        aria-label={label}
        aria-busy={pending || undefined}
      >
        {children}
      </form>
    </Pending>
  );
}
