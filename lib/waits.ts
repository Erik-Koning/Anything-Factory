// Tasks waiting on other tasks (lib/tasks/model.ts Wait), settled by the watchdog each run: closed once what they were
// folded into is done, back to work once what they waited for is, back to the planner when it's rejected. The merge
// queue settles them as it merges too; this catches what finished another way (research done, a task rejected).
import type { RegistryEntry } from "./paths.ts";
import { WATCHDOG } from "./tasks/model.ts";
import { settleWaits } from "./tasks/ops.ts";
import { openStore } from "./tasks/store.ts";

export async function settleTeamWaits(entry: RegistryEntry, log: (text: string) => void, problem: (text: string) => void): Promise<void> {
  if (!entry.tasks || entry.worker) return;
  try {
    const store = await openStore({ name: entry.name, tasks: entry.tasks }, entry.run);
    try {
      for (const s of await settleWaits(store, WATCHDOG)) log(`#${s.id} ${s.to}: ${s.why}`);
    } finally {
      await store.close();
    }
  } catch (error) {
    problem(`couldn't settle the tasks waiting on others: ${(error as Error).message.split("\n")[0]}`);
  }
}
