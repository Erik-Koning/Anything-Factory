"use server";
// Starting a project from the web app (docs/plans/run-from-the-site.md): an admin asks one of their own machines, one
// whose operator said at its terminal that it starts projects, to make a team. The ask is a control under the new
// team's name (lib/tasks/start.ts); the machine picks it up at its next full run and says each step. Each ask takes a
// code from the admin's authenticator, like a pause.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withNotice } from "../../components/ui.tsx";
import { REPO_NAME, START_TEAM, startFrom } from "../../../lib/tasks/start.ts";
import { type Limits, Refused, stakeholderOf, startFromWeb, teamDoc } from "../../server/factory.ts";
import { linkedMachines } from "../../server/machines.ts";
import { takeRequestAllowance } from "../../server/people.ts";
import { OPEN_STARTS, startFor, startingMachines, startOpen, starts, STARTS_A_DAY } from "../../server/starts.ts";
import { checkCode } from "../../server/step-up.ts";
import { allowed, authHeaders, getViewer, NotAllowed, record } from "../../server/viewer.ts";

const text = (form: FormData, key: string): string => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

function reasonOf(error: unknown): string {
  if (error instanceof NotAllowed || error instanceof Refused) return error.message;
  console.error(error);
  return "Something went wrong; try again.";
}

export interface StartFormState {
  error: string | null;
  machine: string;
  repo: "new" | "existing";
  create: string;
  existing: string;
  title: string;
  name: string;
  goal: string;
  technical: boolean;
  unit: "usd" | "subscription";
  daily: string;
  weekly: string;
  total: string;
  autoResume: boolean;
  use: string[];
}

// An ask from the form. What was typed comes back with a refusal, so a wrong code doesn't lose the goal.
export async function startProjectAction(_previous: StartFormState, form: FormData): Promise<StartFormState> {
  const fields: Omit<StartFormState, "error"> = {
    machine: text(form, "machine"),
    repo: text(form, "repo") === "existing" ? "existing" : "new",
    create: text(form, "create").trim(),
    existing: text(form, "existing"),
    title: text(form, "title"),
    name: text(form, "name").trim(),
    goal: text(form, "goal").replace(/\r\n?/g, "\n"),
    technical: text(form, "technical") !== "no",
    unit: text(form, "unit") === "subscription" ? "subscription" : "usd",
    daily: text(form, "daily").trim(),
    weekly: text(form, "weekly").trim(),
    total: text(form, "total").trim(),
    autoResume: text(form, "autoResume") === "yes",
    use: form.getAll("use").filter((value): value is string => typeof value === "string"),
  };
  const again = (error: string): StartFormState => ({ error, ...fields });
  let viewer = null;
  let said = "";
  try {
    viewer = await allowed("projects:start");
    const machine = startingMachines(await linkedMachines(), viewer.userId).find((m) => m.id === fields.machine);
    if (!machine?.projects) return again("Choose a Mac of yours that starts projects.");
    if (!START_TEAM.test(fields.name)) return again("The short name is lowercase letters, digits and dashes, starting with a letter, up to 31.");
    if ((await teamDoc(fields.name)) || machine.teams.some((team) => team.name === fields.name))
      return again(`There's a team named ${fields.name} already. Give this one another short name.`);
    const before = await startFor(fields.name);
    if (before && startOpen(before)) return again(`${fields.name} is being started already: the Teams page shows how far it is.`);
    const repoName = fields.repo === "existing" ? fields.existing : fields.create;
    if (fields.repo === "existing" && !machine.projects.repos.includes(repoName)) return again(`Choose a repository from ${machine.name}'s folder.`);
    if (fields.repo === "new" && !REPO_NAME.test(repoName))
      return again("Name the new repository's folder: letters, digits, dots, dashes and underscores, like shop-redesign.");
    if (fields.repo === "new" && machine.projects.repos.includes(repoName))
      return again(`${machine.name} has a repository named ${repoName} already. Choose it from the list, or give the new one another name.`);
    const known = machine.projects.subscriptions.map((sub) => sub.name);
    if (fields.use.some((sub) => !known.includes(sub))) return again(`Choose the subscriptions from ${machine.name}'s own.`);
    // The budget, as the team's own form takes it: dollars, or percent of a subscription's week; blank for none.
    const amount = (key: "daily" | "weekly" | "total"): number | null => {
      const value = fields[key].replace(/^\$/, "").replace(/%$/, "");
      if (!value) return null;
      const n = Number(value);
      const max = fields.unit === "subscription" ? 10_000 : 1_000_000;
      if (!Number.isFinite(n) || n < 0 || n > max)
        throw new Refused(
          fields.unit === "subscription" ? `The ${key} budget is a percentage, from 0 to 10,000.` : `The ${key} budget is dollars, from 0 to 1,000,000.`
        );
      return n === 0 ? null : Math.round(n * 100) / 100;
    };
    const [daily, weekly, total] = [amount("daily"), amount("weekly"), amount("total")];
    const limits: Limits | null =
      daily === null && weekly === null && total === null
        ? null
        : { daily, weekly, total, unit: fields.unit, autoResume: fields.autoResume, since: new Date().toISOString() };
    const ask = startFrom({
      machine: machine.id,
      machineName: machine.name,
      title: fields.title,
      repo: fields.repo === "existing" ? { existing: repoName } : { create: repoName },
      goal: fields.goal,
      technical: fields.technical,
      limits,
      use: fields.use,
    });
    if ("problem" in ask) return again(ask.problem);
    const mine = new Set(startingMachines(await linkedMachines(), viewer.userId).map((m) => m.id));
    const open = (await starts(new Set())).filter((start) => startOpen(start) && mine.has(start.ask.machine)).length;
    if (open >= OPEN_STARTS) return again(`${OPEN_STARTS} projects are being started on your Macs already: wait for one to finish, or withdraw one.`);
    const wrong = await checkCode(viewer.userId, text(form, "code").replace(/\s+/g, ""), await authHeaders());
    if (wrong) return again(wrong);
    if (!(await takeRequestAllowance(`start:${viewer.userId}`, STARTS_A_DAY)))
      return again(`You've asked for ${STARTS_A_DAY} projects today, the most a day.`);
    const from = (await stakeholderOf(fields.name, viewer, "operator")).id;
    const control = await startFromWeb(fields.name, ask, from);
    said = `Asked ${machine.name} to start ${ask.title}. It looks every five minutes; each step shows here as it goes.`;
    await record(viewer, {
      action: "project.asked",
      outcome: "ok",
      team: fields.name,
      target: `${control.id} ${ask.title}`,
      detail: `on ${machine.name}, ${fields.repo === "existing" ? "in" : "a new repository"} ${repoName}${limits ? ", with a budget" : ""}${ask.use.length ? `, on ${ask.use.join(", then ")}` : ""}`,
    });
  } catch (error) {
    const reason = reasonOf(error);
    await record(viewer ?? (await getViewer()), { action: "project.asked", outcome: "refused", team: null, target: fields.name || null, detail: reason });
    return again(reason);
  }
  revalidatePath("/", "layout");
  redirect(withNotice("/", { ok: said }));
}

// Withdraws an ask its machine hasn't picked up, or clears one that ended (stopped, refused, or dropped) from the Teams
// page. One under way can't be: the team is paused once it's registered.
export async function withdrawStartAction(form: FormData): Promise<void> {
  const team = text(form, "team");
  if (!START_TEAM.test(team)) redirect("/");
  let notice: { ok?: string; error?: string };
  let viewer = null;
  try {
    viewer = await allowed("projects:start");
    const start = await startFor(team);
    if (!start) throw new Refused("That one is gone already.");
    if (startOpen(start) && start.step !== "waiting")
      throw new Refused(`${start.ask.machineName} is setting it up already. Pause the team once it's registered, or stop it on that Mac.`);
    const from = (await stakeholderOf(team, viewer, "operator")).id;
    const control = await startFromWeb(team, null, from);
    const waiting = start.step === "waiting";
    notice = { ok: waiting ? `Withdrawn: ${start.ask.machineName} won't start ${start.ask.title}.` : `Cleared ${start.ask.title} from this page.` };
    await record(viewer, {
      action: "project.withdrawn",
      outcome: "ok",
      team,
      target: `${control.id} ${start.ask.title}`,
      detail: waiting ? "before it was picked up" : `after it ${start.step}`,
    });
  } catch (error) {
    notice = { error: reasonOf(error) };
    await record(viewer ?? (await getViewer()), { action: "project.withdrawn", outcome: "refused", team, target: null, detail: notice.error });
  }
  revalidatePath("/", "layout");
  redirect(withNotice("/", notice));
}
