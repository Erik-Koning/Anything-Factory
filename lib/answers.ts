// The operator's answers from the web app or a6g task answer (lib/tasks/answer.ts), passed to the team's planner once
// each, in one message per watchdog run, so it acts on them within a minute instead of at its next wake. A marker in the
// run folder's replies/ says which went, as for the operator's replies by email; answers older than a day aren't passed
// on (the planner reads those notes on its own wakes).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reply } from "./channels.ts";
import type { RegistryEntry } from "./paths.ts";
import { answer, answerKey, answersMessage, answersSince } from "./tasks/answer.ts";
import { designOpen, OPERATOR } from "./tasks/model.ts";
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

// A reply to the design check-in's message, which a channel checked came from the operator, is their answer on the
// task: the planner closes the check-in or takes it back only on an answer recorded there (model.ts), can't record one
// itself, and a reply is how most people answer a message. The message is known by its subject, which the planner's
// rules set (plugin/agents/planner.md); a reply to any other goes to the planner as it always did. Recorded once (a
// marker beside the replies'), and marked as passed on, since the reply itself goes to the planner (passReplies in the
// watchdog, which says it's on the task already). Returns the check-in each recorded reply answered, by the reply's id.
export const NAMES_CHECK_IN = /\bdesign check-?in\b/i;
export async function answerCheckInByReply(entry: RegistryEntry, replies: Reply[], log: (text: string) => void): Promise<Map<string, string>> {
  const answered = new Map<string, string>();
  const dir = join(entry.run, "replies");
  const about = replies.filter((reply) => NAMES_CHECK_IN.test(reply.subject) && !existsSync(join(dir, reply.id)));
  if (!about.length || !entry.tasks || entry.worker) return answered;
  try {
    const store = await openStore({ name: entry.name, tasks: entry.tasks }, entry.run);
    try {
      const design = designOpen(await store.tasks.all());
      // Not raised, or back with the planner while changes are made: nothing waits on the operator's word yet.
      if (design?.status !== "question") return answered;
      mkdirSync(dir, { recursive: true });
      for (const reply of about) {
        const marker = join(dir, `answered-${reply.id}`);
        if (!existsSync(marker)) {
          const task = await answer(store, design.id, { who: OPERATOR, text: reply.text });
          const note = task.notes.at(-1);
          if (note) writeFileSync(join(dir, answerKey(task, note)), "");
          writeFileSync(marker, "");
          log(`recorded the operator's ${reply.via} reply to "${reply.subject}" as their answer on the design check-in (#${design.id})`);
        }
        answered.set(reply.id, design.id);
      }
    } finally {
      await store.close();
    }
  } catch (error) {
    log(`couldn't record the operator's reply on the design check-in: ${(error as Error).message.split("\n")[0]}`);
  }
  return answered;
}
