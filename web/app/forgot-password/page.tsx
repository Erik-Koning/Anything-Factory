import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-password-form.tsx";

export const metadata: Metadata = { title: "Forgot your password" };

// Asking for a link to set a new password. Open to anyone, signed in or not: the answer is the same for every address,
// and nothing changes until the link is used (server/password-reset.ts).
export default function ForgotPasswordPage() {
  return (
    <div className="narrow">
      <h1>Forgot your password?</h1>
      <p className="lede">We&apos;ll email you a link to set a new one. Your password stays as it is until you use the link.</p>
      <ForgotPasswordForm />
      <p>
        Remembered it? <Link href="/sign-in">Sign in</Link>
      </p>
    </div>
  );
}
