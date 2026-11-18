// At the server's start: the notifier (server/notifier.ts), which emails people what their settings ask for, and a first
// read of every team's tasks (server/task-cache.ts), so the first pages wait for none. Only in Node, never at build
// time; NOTIFY_EVERY_SECONDS=0 keeps the notifier off.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startNotifier } = await import("./server/notifier.ts");
  startNotifier();
  const [{ allTeams }, { warmTasks }] = await Promise.all([import("./server/factory.ts"), import("./server/task-cache.ts")]);
  allTeams()
    .then((teams) => warmTasks(teams.map((t) => t.name)))
    .catch((error: unknown) => console.warn(`[tasks] couldn't list the teams to read: ${(error as Error).message}`));
}
