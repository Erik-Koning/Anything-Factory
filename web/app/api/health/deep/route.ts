// What the outside uptime check calls, through the CDN (Route 53, sst.config.ts): the server answers and so does the
// database, within a few seconds. Lightsail's own check stays /api/health, which reads no database, so a database blip
// never takes a container out of service; this one is for telling the operator. Its answer is kept ten seconds, so the
// checkers' calls from around the world cost the database one ping at most that often.
import { mongo } from "../../../../server/db.ts";

export const dynamic = "force-dynamic";

const KEPT_MS = 10_000;
const WAIT_MS = 4000;
let last: { at: number; ok: boolean } | null = null;

const pinged = (): Promise<boolean> =>
  Promise.race([
    mongo()
      .db("admin")
      .command({ ping: 1 })
      .then(
        () => true,
        () => false
      ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), WAIT_MS)),
  ]);

export async function GET(): Promise<Response> {
  if (!last || Date.now() - last.at > KEPT_MS) last = { at: Date.now(), ok: await pinged() };
  return new Response(last.ok ? "ok" : "the database doesn't answer", {
    status: last.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
  });
}
