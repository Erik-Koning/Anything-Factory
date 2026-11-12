// An authenticator's code (RFC 6238: HMAC-SHA1, 30 seconds, 6 digits): from an otpauth:// URI, so create-admin can
// confirm the authenticator it enrols and the end-to-end tests can sign in with it; and from the key itself, so a
// code can be checked for someone who has no session to check it in (password-reset.ts).
import { createHmac, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(uri: string, at = Date.now()): string {
  const url = new URL(uri);
  const secret = url.searchParams.get("secret");
  if (url.protocol !== "otpauth:" || !secret) throw new Error("not an otpauth URI");
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  return codeAt(base32(secret), at, digits, period);
}

// The code a key shows at a time.
export function codeAt(key: Buffer, at = Date.now(), digits = 6, period = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

// Whether `code` is what the key shows now, or showed or will show 30 seconds either side (clocks drift): the same
// window Better Auth allows. Every candidate is compared, in constant time.
export function codeMatches(key: Buffer, code: string, at = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let matched = false;
  for (const step of [-1, 0, 1]) matched = timingSafeEqual(Buffer.from(codeAt(key, at + step * 30_000)), Buffer.from(code)) || matched;
  return matched;
}
