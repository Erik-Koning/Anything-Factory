// The Teams page's rows, after the main story: what waits on the operator, answered on Waiting on you or discarded from
// the row itself, and the team's own keys (stop, pause, ⋯) beside it.
import { expect, test } from "@playwright/test";
import { newTask, type Task } from "../../../lib/tasks/model.ts";
import { closeDatabases, databases, signInAsAdmin } from "./helpers.ts";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await closeDatabases();
});

test("a question waiting on the operator is answered from its team's row, or discarded there with words the team reads", async ({ page }) => {
  const { graph } = await databases();
  const tasks = graph.collection("tasks");
  const at = new Date().toISOString();
  const doc = (id: string, fields: Parameters<typeof newTask>[0]) => ({ _id: `shop:${id}` as never, ...newTask(fields), id, version: 1 });
  const stored = async (id: string): Promise<Task> => (await tasks.findOne({ _id: `shop:${id}` as never })) as unknown as Task;
  await tasks.insertMany([
    doc("921", {
      team: "shop",
      title: "Q: a loyalty card?",
      kind: "research",
      status: "question",
      by: "planner",
      body: "Repeat customers asked for one. Options: (a) not now; (b) a stamp card.",
      ask: { reason: "what the shop gives away is the operator's", recommendation: "(a) not now", by: "planner", at },
    }),
  ]);
  try {
    await signInAsAdmin(page);
    const row = page.locator("li.team-row").filter({ has: page.locator("#shop") });
    // Shop has things waiting on the operator, so its row opens with them in it.
    const waiting = row.getByRole("region", { name: "Shop: waiting on you" });
    await expect(waiting).toBeVisible();
    const item = waiting.locator("li.wait-row").filter({ hasText: "Q: a loyalty card?" });
    await expect(item.getByRole("link", { name: "Answer" })).toHaveAttribute("href", "/t/shop/inbox#task-921");

    // The team's own keys sit beside it: stop and pause, or resume while it's held, and the rest under ⋯.
    await expect(waiting.getByRole("button", { name: /^(Stop|Resume)$/ }).first()).toBeVisible();
    await expect(waiting.getByLabel("More for Shop")).toBeVisible();

    // Discarding takes opening it first, and says what the team will read.
    await expect(item.getByRole("button", { name: "Discard #921" })).toBeHidden();
    await item.getByText("Discard…", { exact: true }).click();
    await item.getByLabel("Why, for the team").fill("Not this year.");
    await item.getByRole("button", { name: "Discard #921" }).click();
    await expect(page.getByRole("status")).toContainText("#921 rejected.");
    await expect(waiting.locator("li.wait-row").filter({ hasText: "Q: a loyalty card?" })).toHaveCount(0);
    const discarded = await stored("921");
    expect(discarded.status).toBe("rejected");
    expect(discarded.notes.at(-1)).toMatchObject({ by: "operator", text: "Not this year." });
  } finally {
    await tasks.deleteMany({ _id: { $in: ["shop:921"] as never[] } });
  }
});
