// At the server's start: the notifier (server/notifier.ts), which emails people what their settings ask for. Only in
// Node, never at build time; NOTIFY_EVERY_SECONDS=0 keeps it off.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startNotifier } = await import("./server/notifier.ts");
  startNotifier();
}
