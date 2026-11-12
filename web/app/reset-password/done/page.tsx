import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Password changed" };

// Where setting a new password ends. Nobody is signed in by it: the new password, and the authenticator where the
// account has one, do that.
export default function PasswordChangedPage() {
  return (
    <div className="narrow stack">
      <h1>Your password is changed</h1>
      <p className="notice ok" role="status">
        Every session of your account has ended, and we&apos;ve emailed you to say the password changed.
      </p>
      <p>
        <Link href="/sign-in">Sign in</Link> with the new password.
      </p>
    </div>
  );
}
