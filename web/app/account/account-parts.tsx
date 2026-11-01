"use client";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { authClient, problemOf } from "../auth-client.ts";
import { type BackupCodesState, backupCodesAction } from "./actions.ts";

export function Passkeys({ passkeys }: { passkeys: { id: string; name: string; createdAt: string }[] }) {
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<{ error?: { message?: string; status?: number } | null } | undefined>, fallback: string) => {
    setBusy(true);
    setProblem(null);
    const result = await work().catch((error: unknown) => ({ error: { message: error instanceof Error ? error.message : fallback } }));
    setBusy(false);
    if (result?.error) setProblem(problemOf(result.error, fallback));
    else router.refresh();
  };
  return (
    <>
      {problem ? (
        <p className="notice error" role="alert">
          {problem}
        </p>
      ) : null}
      {passkeys.length ? (
        <ul className="plain rows">
          {passkeys.map((p) => (
            <li key={p.id} className="head">
              <span className="title">{p.name}</span>
              <span className="muted small">added {new Date(p.createdAt).toLocaleDateString("en")}</span>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => act(() => authClient.passkey.deletePasskey({ id: p.id }), "It wasn't removed.")}
              >
                Remove {p.name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No passkeys yet.</p>
      )}
      <form
        className="inline"
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get("name") ?? "").trim() || "Passkey";
          void act(() => authClient.passkey.addPasskey({ name }), "No passkey was added.");
        }}
      >
        <label>
          Name it
          <input name="name" maxLength={60} placeholder="This laptop" autoComplete="off" />
        </label>
        <button type="submit" disabled={busy}>
          Add a passkey
        </button>
      </form>
    </>
  );
}

// New backup codes: a current code from the authenticator, and an admin's password too. The codes show once.
export function BackupCodes({ password }: { password: boolean }) {
  const [state, action, pending] = useActionState<BackupCodesState, FormData>(backupCodesAction, { error: null, codes: [] });
  return (
    <>
      {state.error ? (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.codes.length ? (
        <div className="notice ok" role="status">
          <p>Your new backup codes. Keep them somewhere safe: each works once, and the old ones no longer do.</p>
          <div className="codes">
            {state.codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </div>
      ) : null}
      <form action={action} className="inline">
        {password ? (
          <label>
            Your password
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
        ) : null}
        <label>
          A code from your authenticator
          <input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Making them…" : "Make new backup codes"}
        </button>
      </form>
    </>
  );
}
