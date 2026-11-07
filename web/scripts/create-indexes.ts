// npm run create-indexes
// The app's indexes, made once by the operator with a database user that may make them (the app's own user may not
// make any on the audit log, so a leaked app credential can't add an expiry that wipes it). Run it before the first
// deploy and after an upgrade that adds one, with MONGODB_URI, AUTH_DATABASE (and the rest of the app's settings) from
// the environment or web/.env.local. Making an index that exists already changes nothing.
import { existsSync } from "node:fs";

const envFile = new URL("../.env.local", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { authDb, closeMongo } = await import("../server/db.ts");
const { ensureAuthIndexes } = await import("../server/auth-indexes.ts");
const audit = await import("../server/audit.ts");
const knownIps = await import("../server/known-ips.ts");
const codeAttempts = await import("../server/code-attempts.ts");
const notifier = await import("../server/notifier.ts");
try {
  await Promise.all([
    ensureAuthIndexes(authDb()),
    audit.ensureIndexes(),
    knownIps.ensureIndexes(),
    codeAttempts.ensureIndexes(),
    notifier.ensureIndexes(),
  ]);
  for (const name of [
    "user",
    "session",
    "account",
    "verification",
    "passkey",
    "twoFactor",
    "rateLimit",
    "audit",
    "known_ips",
    "ip_challenges",
    "code_attempts",
    "notification_queue",
  ]) {
    const indexes = await authDb()
      .collection(name)
      .indexes()
      .catch(() => []);
    console.info(`${name}: ${indexes.map((i) => Object.keys(i.key).join("+")).join(", ") || "none (the collection doesn't exist yet)"}`);
  }
} finally {
  await closeMongo();
}
