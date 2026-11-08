"use server";
// Linking a machine to one's account (looking up the code its terminal shows, then approving or refusing it,
// link/link-machine.tsx) and unlinking one. Each is recorded in the audit log, a code that was gone too.
import { redirect } from "next/navigation";
import { MAX_MACHINES, normalUserCode } from "../../../lib/fleet.ts";
import { withNotice } from "../../components/ui.tsx";
import { can, mayLinkMachines } from "../../server/access.ts";
import { decideLink, LOOKS_PER_PERSON, lookUpLink, unlinkMachine, type WaitingLink } from "../../server/machines.ts";
import { record, requireViewer } from "../../server/viewer.ts";

export interface LinkState {
  error: string | null;
  // The waiting code as looked up: whether it was asked for from the address the person is on, so they must type it
  // to approve it when it wasn't; and how long ago, as words.
  link: (WaitingLink & { here: boolean; ago: string }) | null;
  code: string;
}
// What a decision came back with, when it didn't go to the Machines page: why, for the code `code`, and whether that
// code is gone (expired, or decided already).
export interface DecideState {
  error: string | null;
  code: string;
  gone: boolean;
}

const NOT_YOURS = "Only a team's members and admins link machines.";
const TRIES = `That's ${LOOKS_PER_PERSON} looks at codes in 15 minutes: wait, then try again.`;
const GONE = "No machine is waiting for that code. Codes work for ten minutes, once: run a6g connect app again for a new one.";
const ago = (at: string): string => {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
};

export async function lookUpLinkAction(_before: LinkState, form: FormData): Promise<LinkState> {
  const viewer = await requireViewer();
  const typed = String(form.get("code") ?? "");
  if (!mayLinkMachines(viewer)) return { error: NOT_YOURS, link: null, code: typed };
  const code = normalUserCode(typed);
  if (!code) return { error: "That isn't a code: eight letters, like BCDF-GHJK.", link: null, code: typed };
  const link = await lookUpLink(viewer.userId, viewer.ip, code);
  if (link === "tries") {
    await record(viewer, { action: "machine.linked", outcome: "refused", detail: `looked up a code past the limit on looks in 15 minutes` });
    return { error: TRIES, link: null, code: typed };
  }
  if (!link) {
    await record(viewer, { action: "machine.linked", outcome: "failed", detail: "looked up a code no machine was waiting for" });
    return { error: GONE, link: null, code: typed };
  }
  return { error: null, link: { ...link, here: link.ip !== null && link.ip === viewer.ip, ago: ago(link.createdAt) }, code: typed };
}

// Approves or refuses the code looked up (`decision`); a code asked for from another address is approved only with
// `typed`, the code typed again. On success, off to the Machines page; otherwise the reason.
export async function decideLinkAction(_before: DecideState, form: FormData): Promise<DecideState> {
  const viewer = await requireViewer();
  const code = normalUserCode(String(form.get("code") ?? ""));
  const failed = (error: string, gone = false): DecideState => ({ error, code: code ?? "", gone });
  if (!mayLinkMachines(viewer)) return failed(NOT_YOURS);
  if (!code) return failed("That isn't a code: eight letters, like BCDF-GHJK.");
  const approve = form.get("decision") === "approve";
  const action = approve ? "machine.linked" : "machine.refused";
  const typed = normalUserCode(String(form.get("typed") ?? ""));
  const link = await decideLink({ userId: viewer.userId, ip: viewer.ip }, code, approve, typed);
  if (link === "tries") {
    await record(viewer, { action, outcome: "refused", detail: `${LOOKS_PER_PERSON} looks at codes in 15 minutes` });
    return failed(TRIES);
  }
  if (link === "type the code") return failed("Type the code your terminal shows, to approve a machine that asked from another address.");
  if (link === "too many") return failed(`You have ${MAX_MACHINES} machines linked: unlink one first.`);
  if (!link) {
    await record(viewer, { action, outcome: "failed", detail: "no machine was waiting for that code" });
    return failed(GONE, true);
  }
  await record(viewer, {
    action,
    outcome: "ok",
    target: link.name,
    detail: `asked for from ${link.ip ?? "an unknown address"} by ${link.device}${link.ip !== null && link.ip === viewer.ip ? "" : ", another address than the person's"}`,
  });
  redirect(
    withNotice(
      "/machines",
      approve
        ? { ok: `${link.name} is linked to your account. Its terminal finishes in a few seconds, and it shows here once it reports.` }
        : { ok: `Refused: ${link.name} isn't linked, and its code no longer works.` }
    )
  );
}

// Unlinks one of one's own machines, or, for an admin, anyone's: its token stops working at once.
export async function unlinkMachineAction(form: FormData): Promise<void> {
  const viewer = await requireViewer();
  const machine = await unlinkMachine(String(form.get("id") ?? ""), can(viewer, "machines:all") ? null : viewer.userId);
  if (!machine) redirect(withNotice("/machines", { error: "That machine isn't linked any more." }));
  await record(viewer, {
    action: "machine.unlinked",
    outcome: "ok",
    target: machine.name,
    detail: machine.userId === viewer.userId ? "from the Machines page" : "another person's, by an admin",
  });
  redirect(withNotice("/machines", { ok: `${machine.name} is unlinked: its token no longer works, and it reports nothing more.` }));
}
