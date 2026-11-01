// The indexes Better Auth's MongoDB adapter doesn't make: every request finds its session by token, every sign-in its
// person by address, every passkey sign-in its credential, every rate limit its key. Without them each is a scan of
// the whole collection. Expired sessions and verifications (sign-in links, two-factor steps) go by MongoDB's own expiry
// too. Made once per process, in the background: a database user that may not make indexes leaves sign-in slower,
// never broken.
import type { Db, IndexDescription } from "mongodb";

export const AUTH_INDEXES: Record<string, IndexDescription[]> = {
  user: [{ key: { email: 1 }, unique: true }],
  session: [{ key: { token: 1 }, unique: true }, { key: { userId: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  account: [{ key: { userId: 1 } }, { key: { providerId: 1, accountId: 1 } }],
  verification: [{ key: { identifier: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  passkey: [{ key: { userId: 1 } }, { key: { credentialID: 1 }, unique: true }],
  twoFactor: [{ key: { userId: 1 } }],
  // Unique: two first requests at once make one record between them (the limiter retries the one that loses), so a
  // burst can't make many records that each count up to the limit.
  rateLimit: [{ key: { key: 1 }, unique: true }],
};

let made: Promise<void> | null = null;
export function ensureAuthIndexes(db: Db): Promise<void> {
  made ??= Promise.all(
    Object.entries(AUTH_INDEXES).map(([collection, indexes]) =>
      db
        .collection(collection)
        .createIndexes(indexes)
        .catch((error: unknown) => console.warn(`auth: indexes on ${collection} not made:`, (error as Error).message))
    )
  ).then(() => {});
  return made;
}
