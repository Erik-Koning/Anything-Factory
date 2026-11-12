// The pieces of admins' two-factor sign-in that are pure: whether a passkey verified the person, and the
// authenticator's codes create-admin and the end-to-end tests compute.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAdminRole, userVerified } from "../../server/auth.ts";
import { base32, codeAt, codeMatches, totpCode } from "../../server/totp.ts";

// authenticatorData: a 32-byte RP ID hash, a flags byte, a 4-byte counter.
const assertion = (flags: number) => ({
  response: { authenticatorData: Buffer.concat([Buffer.alloc(32, 7), Buffer.from([flags]), Buffer.alloc(4)]).toString("base64url") },
});

test("a passkey counts as a second factor only when the authenticator verified the person (the UV flag)", () => {
  assert.equal(userVerified(assertion(0x05)), true); // user present and verified
  assert.equal(userVerified(assertion(0x45)), true);
  assert.equal(userVerified(assertion(0x01)), false); // present only
  assert.equal(userVerified(assertion(0x00)), false);
  assert.equal(userVerified({ response: { authenticatorData: "AAAA" } }), false); // too short
  assert.equal(userVerified({}), false);
  assert.equal(userVerified(null), false);
  assert.equal(userVerified({ response: { authenticatorData: 42 } }), false);
});

test("the admin role, as Better Auth's admin plugin keeps it", () => {
  assert.equal(isAdminRole("admin"), true);
  assert.equal(isAdminRole("user,admin"), true);
  assert.equal(isAdminRole("user"), false);
  assert.equal(isAdminRole("administrator"), false);
  assert.equal(isAdminRole(null), false);
  assert.equal(isAdminRole(undefined), false);
});

test("authenticator codes match RFC 6238's test vectors", () => {
  // The RFC's SHA-1 secret, "12345678901234567890", in base32.
  const uri = "otpauth://totp/A6G:test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=30";
  assert.equal(totpCode(uri, 59_000), "94287082");
  assert.equal(totpCode(uri, 1_111_111_109_000), "07081804");
  assert.equal(totpCode(uri, 1_234_567_890_000), "89005924");
  assert.equal(totpCode(uri.replace("&digits=8", ""), 59_000), "287082");
  assert.throws(() => totpCode("https://example.com/?secret=AAAA"));
});

test("a code is right for the 30 seconds it shows and the 30 either side, and for no longer", () => {
  const key = base32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(key, Buffer.from("12345678901234567890"));
  const at = 1_700_000_015_000;
  assert.equal(codeAt(key, 59_000), "287082");
  for (const drift of [-30_000, 0, 30_000]) assert.equal(codeMatches(key, codeAt(key, at + drift), at), true, `${drift} ms`);
  for (const drift of [-90_000, -60_000, 60_000, 90_000]) assert.equal(codeMatches(key, codeAt(key, at + drift), at), false, `${drift} ms`);
  // Only six digits are a code at all.
  for (const not of ["", "12345", "1234567", "abcdef", " 12345", "12 345"]) assert.equal(codeMatches(key, not, at), false, JSON.stringify(not));
  // Another key's code is not this one's.
  const other = Buffer.from("another key altogether");
  assert.equal(codeMatches(key, codeAt(other, at), at), codeAt(other, at) === codeAt(key, at));
});
