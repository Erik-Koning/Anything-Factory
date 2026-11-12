import type { Metadata } from "next";
import Link from "next/link";
import { param, type SearchParams } from "../../components/ui.tsx";
import { readReset } from "../../server/password-reset.ts";
import { ResetPasswordForm } from "./reset-password-form.tsx";

// The link's token is in this page's address: it is sent on to nowhere.
export const metadata: Metadata = { title: "Set a new password", referrer: "no-referrer" };

// The page a "set a new password" email links to. Opening it changes nothing (a mail scanner that follows links sets
// no password): the form does, with the authenticator's code where the account has one.
export default async function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const token = param((await searchParams)["token"]);
  const found = await readReset(token);
  if (!found)
    return (
      <div className="narrow stack">
        <h1>This link has expired</h1>
        <p>It works once, for 30 minutes.</p>
        <p>
          <Link href="/forgot-password">Ask for a new link</Link>
        </p>
      </div>
    );
  if (found.refused)
    return (
      <div className="narrow stack">
        <h1>Set a new password</h1>
        <p className="notice error" role="alert">
          {found.refused}
        </p>
        <p>
          <Link href="/sign-in">Sign in</Link>
        </p>
      </div>
    );
  return (
    <div className="narrow">
      <h1>Set a new password</h1>
      <p className="lede">For {found.email}. Changing it ends every session of the account.</p>
      <ResetPasswordForm token={token} email={found.email} needsCode={found.needsCode} />
    </div>
  );
}
