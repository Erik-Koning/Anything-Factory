import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { param, type SearchParams } from "../../../components/ui.tsx";
import { getViewer } from "../../../server/viewer.ts";

export const metadata: Metadata = { title: "Confirm your email" };

const ERRORS: Record<string, string> = {
  TOKEN_EXPIRED: "That link has expired: it works for an hour.",
  INVALID_TOKEN: "That link isn't one of ours, or it was cut short on the way.",
  USER_NOT_FOUND: "There's no account for that link any more.",
};

// Where the link in a confirmation email lands. It signs the person in, so they're on their way: to the authenticator
// they asked for (/welcome), or to Teams. Without a session the link was old, used already, or for an account that
// only signs in another way.
export default async function ConfirmedPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await getViewer();
  if (viewer) redirect("/");
  const error = param((await searchParams)["error"]);
  return (
    <div className="narrow stack">
      <h1>Confirm your email</h1>
      {error ? (
        <>
          <p className="notice error" role="alert">
            {ERRORS[error] ?? "That link didn't work."}
          </p>
          <p>
            <Link href="/sign-in">Sign in</Link> with your email and password and we&apos;ll send a new link.
          </p>
        </>
      ) : (
        <>
          <p className="notice ok" role="status">
            That link has done its work: it confirms an address once.
          </p>
          <p>
            <Link href="/sign-in">Sign in</Link> to go on.
          </p>
        </>
      )}
    </div>
  );
}
