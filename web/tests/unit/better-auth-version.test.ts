// Better Auth's packages ship together and its security fixes land in specific releases: all of them stay exactly at
// this version, in the app's package.json, in the lockfile (nested copies too) and on disk, until someone moves this on purpose.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const VERSION = "1.7.17";
const WEB = resolve(import.meta.dirname, "../..");
// @better-auth/utils is the one with its own version line (0.x): better-auth pins it itself.
const isBetterAuth = (name: string): boolean => name === "better-auth" || (name.startsWith("@better-auth/") && name !== "@better-auth/utils");
const json = <T>(path: string): T => JSON.parse(readFileSync(join(WEB, path), "utf8")) as T;

test("package.json pins every Better Auth package exactly", () => {
  const { dependencies = {}, devDependencies = {} } = json<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    "package.json"
  );
  const pinned = Object.entries({ ...dependencies, ...devDependencies }).filter(([name]) => isBetterAuth(name));
  assert.deepEqual(pinned.map(([name]) => name).sort(), ["@better-auth/core", "@better-auth/mongo-adapter", "@better-auth/passkey", "better-auth"]);
  for (const [name, version] of pinned) assert.equal(version, VERSION, name);
});

test("the lockfile resolves one version of Better Auth, transitive and nested copies included", () => {
  const { packages } = json<{ packages: Record<string, { version?: string }> }>("package-lock.json");
  const copies = Object.entries(packages).filter(([path]) => isBetterAuth(path.split("node_modules/").at(-1) ?? ""));
  const names = copies.map(([path]) => path);
  for (const expected of ["better-auth", "@better-auth/core", "@better-auth/mongo-adapter", "@better-auth/passkey"])
    assert.ok(names.includes(`node_modules/${expected}`), `${expected} is in the lockfile`);
  for (const [path, { version }] of copies) assert.equal(version, VERSION, path);
});

test("what's installed is that version", () => {
  for (const name of ["better-auth", "@better-auth/core", "@better-auth/mongo-adapter", "@better-auth/passkey"])
    assert.equal(json<{ version: string }>(join("node_modules", name, "package.json")).version, VERSION, name);
});
