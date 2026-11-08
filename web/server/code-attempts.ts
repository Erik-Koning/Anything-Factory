// How many authenticator or backup codes a person may try: five in the 15 minutes from their first, whichever session
// or page they come from. Each try is counted before its code is checked, so tries made at once can't each get a guess; a
// right code clears the count. (Better Auth's own limits cover a password's second step, which has no session yet.)
// Linking a machine counts its own tries the same way, under keys of its own and with limits of its own (machines.ts).
import { authDb } from "./db.ts";

export const CODE_TRIES = 5;
const LOCK_MINUTES = 15;

interface Attempts {
  _id: string;
  n: number;
  expiresAt: Date;
}
const attempts = () => authDb().collection<Attempts>("code_attempts");

let indexed: Promise<unknown> | null = null;
export const ensureIndexes = (): Promise<unknown> =>
  (indexed ??= attempts()
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    .catch(() => {}));

const duplicate = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

// Takes one of the person's tries (of `tries`, CODE_TRIES unless said); false when they've none left.
export async function takeCodeAttempt(userId: string, now = new Date(), tries: number = CODE_TRIES): Promise<boolean> {
  void ensureIndexes();
  try {
    const taken = await attempts().findOneAndUpdate(
      { _id: userId, n: { $lt: tries }, expiresAt: { $gt: now } },
      { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date(now.getTime() + LOCK_MINUTES * 60_000) } },
      { upsert: true, returnDocument: "after" }
    );
    return taken !== null;
  } catch (error) {
    // The count exists and is spent (the filter didn't match, so the upsert tried to make a second one), or expired
    // and not yet removed: an expired one is replaced.
    if (!duplicate(error)) throw error;
    const replaced = await attempts().findOneAndUpdate(
      { _id: userId, expiresAt: { $lte: now } },
      { $set: { n: 1, expiresAt: new Date(now.getTime() + LOCK_MINUTES * 60_000) } },
      { returnDocument: "after" }
    );
    return replaced !== null;
  }
}

export async function clearCodeAttempts(userId: string): Promise<void> {
  await attempts().deleteOne({ _id: userId });
}
