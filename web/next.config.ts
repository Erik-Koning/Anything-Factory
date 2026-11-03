// The app imports the factory's own task code from ../lib/tasks (no copies), so Turbopack's root and the output
// tracing both reach the repository's root.
//
// For the container (Dockerfile, NEXT_OUTPUT=standalone) the build is a standalone server: .next/standalone/web/server.js
// with only the files it needs. Behind CloudFront, the CDN passes the public host on in x-forwarded-host, which is what
// Next compares a server action's Origin with; SERVER_ACTIONS_ORIGINS (hosts, comma-separated) adds others at build.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const allowedOrigins = (process.env.SERVER_ACTIONS_ORIGINS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const config: NextConfig = {
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  ...(allowedOrigins.length ? { experimental: { serverActions: { allowedOrigins } } } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: repository },
  outputFileTracingRoot: repository,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default config;
