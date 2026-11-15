// A health address (lib/util.ts answers): one slow to answer, as a development server is on its first request after a
// while idle, counts as answering when it's given long enough, as the watchdog's second ask gives it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { answers } from "../lib/util.ts";

test("a slow answer is no answer within the usual wait, and one within a longer wait; an error status never is", async () => {
  const server = createServer((request, response) => {
    setTimeout(() => {
      response.statusCode = request.url === "/broken" ? 500 : 200;
      response.end("ok");
    }, 300);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await answers(`${base}/`, 100), false);
    assert.equal(await answers(`${base}/`, 2000), true);
    assert.equal(await answers(`${base}/broken`, 2000), false);
    assert.equal(await answers(`any:${base}/broken`, 2000), true);
  } finally {
    server.close();
  }
});
