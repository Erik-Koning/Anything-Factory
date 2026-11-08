import type { Metadata } from "next";
import { normalUserCode, shownUserCode } from "../../../../lib/fleet.ts";
import { Notice, param, type SearchParams } from "../../../components/ui.tsx";
import { mayLinkMachines } from "../../../server/access.ts";
import { requireViewer } from "../../../server/viewer.ts";
import { LinkMachine } from "./link-machine.tsx";

export const metadata: Metadata = { title: "Link a machine" };

// Where a6g connect app sends the person: signed in (and past any step their session owes), they look up the code
// their terminal shows, check it and the machine that asked, and approve or refuse it. A code in the address only
// fills the form: nothing is looked up until they ask (server/machines.ts).
export default async function LinkMachinePage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  const code = normalUserCode(param((await searchParams)["code"]));
  return (
    <>
      <h1>Link a machine</h1>
      <Notice searchParams={searchParams} />
      {mayLinkMachines(viewer) ? (
        <LinkMachine prefill={code ? shownUserCode(code) : ""} />
      ) : (
        <p className="panel empty">Only a team&apos;s members and admins link machines: the teams you follow run on theirs.</p>
      )}
    </>
  );
}
