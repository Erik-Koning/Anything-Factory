// Decisions on proposals: approving, rejecting, sending back for research and escalating to the operator. The CLI
// (a6g task approve/reject/research/escalate) and the web app both decide through here, by the move table in model.ts
// (who may decide what, from where), with the team's approval rules; each is checked again as it's written.
import { isTopic, type Topic } from "./agreement.ts";
import {
  type ApprovalRules,
  type Actor,
  fromStakeholder,
  move,
  moveRefusal,
  nowIso,
  OPERATOR,
  Refused,
  SIZES,
  type Status,
  type Task,
  type Via,
} from "./model.ts";
import { type Store, update } from "./store.ts";

export type Decision = "approve" | "reject" | "research" | "escalate";
const TO: Record<Decision, Status> = { approve: "approved", reject: "rejected", research: "researching", escalate: "question" };

// Why an escalation is the operator's, in words, as a planner's question carries the rule of the working agreement
// that asked it: the approval rule that sent it up, or the approver's own call. The agreement doesn't route these (who
// approves is team.json approval); the operator's inbox says so beside each. None for the operator's own.
export function escalationRule(t: Task, who: Actor, approval: ApprovalRules): string | undefined {
  if (who === OPERATOR) return undefined;
  if (fromStakeholder(t) && t.screen?.verdict === "risky") return "the approval rules: work screened risky is the operator's to approve";
  if (fromStakeholder(t) && (approval.stakeholders ?? "operator") === "operator")
    return "the approval rules: work made of a stakeholder's words is the operator's to approve (team.json approval.stakeholders)";
  if (approval.mode === "thresholds" && t.score && SIZES[t.score.size] > SIZES[approval.maxSize])
    return `the approval rules: size ${t.score.size} is over this team's ${approval.maxSize} (team.json approval)`;
  return "the approver's own call: a change of scope, or something it judged the operator's";
}

// `who` decides on task `id`. An approval may carry a note; the others need one (why it's rejected, what to find
// out, what the operator has to decide). An escalation raises it to the operator, so it carries the team's
// recommendation too (the operator escalating to themselves needn't give one). Throws a Refused saying why when it
// can't.
export async function decide(
  store: Store,
  id: string,
  decision: Decision,
  {
    who,
    approval,
    text = "",
    recommendation = "",
    topic,
  }: { who: Actor; approval: ApprovalRules; text?: string; recommendation?: string; topic?: string | undefined }
): Promise<Task> {
  const task = await store.tasks.get(id.replace(/^#/, ""));
  if (!task) throw new Refused(`no task ${id}`);
  const to = TO[decision];
  const via: Via = decision;
  const ctx = { all: await store.tasks.all(), approval };
  const refusal = moveRefusal(task, to, via, who, ctx);
  if (refusal) throw new Refused(refusal);
  if (decision !== "approve" && !text.trim()) throw new Refused("say why");
  // An escalation may say what it's about, so the operator's answers to it count by topic like any question's.
  if (topic !== undefined && (decision !== "escalate" || !isTopic(topic)))
    throw new Refused("--topic says what an escalation is about: one of the agreement's topics");
  const about: { topic?: Topic } = isTopic(topic) ? { topic } : {};
  const rule = decision === "escalate" ? escalationRule(task, who, approval) : undefined;
  const why: { rule?: string } = rule ? { rule } : {};
  return update(store.tasks, task.id, (t) =>
    decision === "approve"
      ? move(t, to, via, who, ctx, { fields: { approval: { by: who, at: nowIso(), note: text } }, why: text || undefined })
      : move(t, to, via, who, ctx, {
          fields: {
            notes: [...t.notes, { at: nowIso(), by: who, text }],
            ...(decision === "escalate"
              ? {
                  ask: {
                    reason: text.trim(),
                    recommendation: recommendation.trim(),
                    by: who,
                    at: nowIso(),
                    ...about,
                    ...why,
                  },
                }
              : {}),
          },
          why: text,
        })
  );
}
