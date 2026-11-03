// Who a task came from, as the person looking may read it, the same on every page: someone on the web app by their
// stakeholder record ("you", by name to an admin, by role to anyone else); a stakeholder whose request the planner
// turned into it; otherwise the team role (or the operator, from the CLI) that added it.
import "server-only";
import { OPERATOR, type Task } from "../../lib/tasks/model.ts";
import { can, senderLabel, senderShort } from "./access.ts";
import { linkedStakeholder, storeFor } from "./factory.ts";
import type { Person } from "./viewer.ts";

export interface Origins {
  // "suggested by you", "added by Olive Operator", "requested by customer", "by the planner"; `full` gives an admin
  // the name, address and role, as on a request's page.
  of(task: Task, full?: boolean): string;
  // A history line with each "stakeholder sN" in it said as `of` would say the person.
  history(text: string): string;
}

export async function originsFor(team: string, viewer: Person): Promise<Origins> {
  const store = storeFor(team);
  const [stakeholders, requests, own] = await Promise.all([store.stakeholders.all(), store.requests.all(), linkedStakeholder(team, viewer.userId)]);
  const people = new Map(stakeholders.map((s) => [s.id, s]));
  const askedBy = new Map(requests.map((r) => [r.id, r.from]));
  // A request names the tasks it became, whether or not each task names the request back.
  const becameOf = new Map(requests.flatMap((r) => r.tasks.map((id) => [id, r.id] as const)));
  const ownId = own?.id ?? null;
  const who = (id: string | null | undefined, full = false): string | null => {
    const person = id ? (people.get(id) ?? null) : null;
    if (!person) return null;
    return full ? senderLabel(viewer, team, person, ownId) : senderShort(viewer, team, person, ownId);
  };
  return {
    of(task, full = false) {
      const added = who(task.from, full);
      if (added && task.by === OPERATOR) return added === "you" || can(viewer, "senders:names", team) ? `added by ${added}` : "added by the operator";
      if (added) return `suggested by ${added}`;
      const request = task.request ?? becameOf.get(task.id);
      if (request) {
        const asked = who(askedBy.get(request), full);
        return asked ? `requested by ${asked}` : `from request ${request}`;
      }
      return `by the ${task.by}`;
    },
    history: (text) => text.replace(/\bstakeholder (s[1-9]\d*)\b/g, (whole, id: string) => who(id) ?? whole),
  };
}
