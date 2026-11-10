import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { blocked } from "../../server/access.ts";
import { getViewer } from "../../server/viewer.ts";
import { SignUpForm } from "./sign-up-form.tsx";

export const metadata: Metadata = { title: "Create an account" };

// Anyone may make an account: a name, an email address to confirm, a password. It opens nothing by itself: an admin
// adds the person to a team.
export default async function SignUpPage() {
  const viewer = await getViewer();
  if (viewer && !blocked(viewer)) redirect("/");
  return (
    <div className="narrow">
      <h1>Create an account</h1>
      <p className="lede">An account lets you sign in. What you see then is up to an admin, who adds you to a team.</p>
      <SignUpForm />
      <p>
        Have an account already? <Link href="/sign-in">Sign in</Link>
      </p>
    </div>
  );
}
