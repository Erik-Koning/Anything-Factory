"use client";
// What opens over the page rather than in it, so nothing the person is looking at moves: a menu of the less used
// actions behind ⋯, and a dialog for an action that needs more than a press (a pause's scope, a note, a team's name
// typed to delete it). A form inside either that succeeds closes it (components/action-form.tsx).
import { type ReactNode, useEffect, useRef } from "react";

// A menu behind a ⋯ button: open, it lies over the page; a press elsewhere or Escape closes it.
export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const open = menu.current;
      if (open?.open && !open.contains(event.target as Node)) open.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const open = menu.current;
      if (event.key !== "Escape" || !open?.open) return;
      open.open = false;
      open.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <details ref={menu} className="menu">
      <summary aria-label={label} title={label}>
        <span aria-hidden="true">⋯</span>
      </summary>
      <div className="menu-items">{children}</div>
    </details>
  );
}

// A dialog over the page, opened by an OpenDialog naming its id. A press on the dim around it, Escape or its close
// button closes it.
export function Dialog({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <dialog
      id={id}
      className="dialog"
      aria-labelledby={`${id}-title`}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="dialog-body">
        <div className="dialog-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <CloseDialog className="quiet s" label="Close">
            ×
          </CloseDialog>
        </div>
        {children}
      </div>
    </dialog>
  );
}

// A button that opens the dialog `target` (and closes the menu it's in).
export function OpenDialog({ target, children, className }: { target: string; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      className={className}
      aria-haspopup="dialog"
      onClick={(event) => {
        event.currentTarget.closest("details")?.removeAttribute("open");
        (document.getElementById(target) as HTMLDialogElement | null)?.showModal();
      }}
    >
      {children}
    </button>
  );
}

// A button that closes the dialog it's in, doing nothing else.
export function CloseDialog({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <button type="button" className={className} aria-label={label} onClick={(event) => event.currentTarget.closest("dialog")?.close()}>
      {children}
    </button>
  );
}
