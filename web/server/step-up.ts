// A code from the person's authenticator for one action, on top of their session's second factor: for turning an
// authenticator on or off, and for what changes how a team runs (pausing, resuming, its budget, its working agreement). Each try counts
// against the person's five (code-attempts.ts), whichever page it comes from.
import { auth } from "./auth.ts";
import { CODE_TRIES, clearCodeAttempts, takeCodeAttempt } from "./code-attempts.ts";

// Why `code` isn't right, or null when it is. `requestHeaders` are the session's (viewer.ts authHeaders).
export async function checkCode(userId: string, code: string, requestHeaders: Headers): Promise<string | null> {
  if (!/^\d{6}$/.test(code)) return "Enter the 6-digit code the app shows.";
  if (!(await takeCodeAttempt(userId))) return `That's ${CODE_TRIES} wrong codes: wait 15 minutes, then try again.`;
  try {
    await auth().api.verifyTOTP({ body: { code }, headers: requestHeaders });
  } catch {
    return "That code isn't right. Check the app's clock, and use the code it shows now.";
  }
  await clearCodeAttempts(userId);
  return null;
}
