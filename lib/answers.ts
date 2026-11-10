// The operator's answers from the web app or a6g task answer (lib/tasks/answer.ts), passed to the team's planner once
// each, in one message per watchdog run, so it acts on them within a minute instead of at its next wake. A marker in the
// run folder's replies/ says which went, as for the operator's replies by email; answers older than a day aren't passed
// on (the planner reads those notes on its own wakes).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryEntry } from "./paths.ts";
import { answersMessage, answersSince } from "./tasks/answer.ts";
import { openStore } from "./tasks/store.ts";

const DAY_MS = 86_400_000;

export async function relayAnswers(
  entry: RegistryEntry,
  tell: (text: string) => boolean,
  log: (text: string) => void,
  problem: (text: string) => void,
  now = Date.now()
): Promise<void> {
  if (!entry.tasks || entry.worker) return;
  let tasks;
  try {
    const store = await openStore({ name: entry.name, tasks: entry.tasks }, entry.run);
    try {
      tasks = await store.tasks.all();
    } finally {
      await store.close();
    }
  } catch (error) {
    problem(`couldn't read the task graph for the operator's answers: ${(error as Error).message.split("\n")[0]}`);
    return;
  }
  const dir = join(entry.run, "replies");
  const fresh = answersSince(tasks, new Date(now - DAY_MS).toISOString()).filter((a) => !existsSync(join(dir, a.key)));
  if (!fresh.length) return;
  if (!tell(answersMessage(fresh))) {
    log(`couldn't pass the operator's answers on ${fresh.map((a) => `#${a.task.id}`).join(", ")} to the planner; trying again next run`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  for (const a of fresh) writeFileSync(join(dir, a.key), "");
  log(`passed the operator's answers on ${fresh.map((a) => `#${a.task.id}`).join(", ")} to the planner`);
}
