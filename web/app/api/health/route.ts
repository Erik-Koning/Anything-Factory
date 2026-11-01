// The container's health check (Lightsail calls it directly, not through the CDN): the server answers. It says
// nothing else, and reads no database, so a database blip doesn't take every container out of service at once.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok", { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });
}
