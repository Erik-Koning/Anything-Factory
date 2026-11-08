// Before every request: behind the CDN, nothing that didn't come through it (ORIGIN_SECRET); a Content Security Policy
// with a fresh nonce (Next puts it on its own scripts); and anyone without a session cookie off to sign in. The cookie
// is only a hint here; every page and action checks the session itself (server/viewer.ts). The machines' endpoints
// take no session: a machine asks for a code, or brings its own token (server/machine-api.ts).
import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { originAllowed } from "./server/origin-check.ts";

const OPEN = [/^\/sign-in(\/|$)/, /^\/api\/auth\//, /^\/api\/health$/, /^\/api\/machines\/(link|token|report|self)$/];

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  // The CDN sends the secret with every request it passes on, and sets the viewer-IP header the app trusts; a request
  // straight to the origin has neither, and is refused. The container's own health check is let through.
  if (pathname !== "/api/health" && !originAllowed(request.headers, process.env.ORIGIN_SECRET))
    return new NextResponse("Not here.", { status: 403, headers: { "Cache-Control": "no-store" } });
  if (!OPEN.some((path) => path.test(pathname)) && !getSessionCookie(request)) {
    const to = new URL("/sign-in", request.url);
    if (pathname !== "/") to.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(to);
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  // Every request but Next's own static files, prefetches included: a matcher that skipped some would let them past the
  // CDN's secret.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
