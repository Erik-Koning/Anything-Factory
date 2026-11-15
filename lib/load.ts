// How busy this machine is, for the guard's start of a member (lib/guard.ts): the last minute's load (processes ready
// to run, as os.loadavg counts them) against its cores. Several teams share one machine, each within its own limits,
// and a member started past what the machine can run only slows the rest into timeouts and flaky failures, whose
// re-runs load it more. A6G_MACHINE_LOAD stands in for the reading (tests).
import { cpus, loadavg } from "node:os";

// Load per core past which no member starts.
export const BUSY_PER_CORE = 2;

// Why the machine is too busy to start one more member, or null.
export function machineBusy(): string | null {
  const cores = cpus().length || 1;
  const load = Number(process.env.A6G_MACHINE_LOAD ?? loadavg()[0]);
  return Number.isFinite(load) && load > BUSY_PER_CORE * cores ? `its load is ${load.toFixed(0)} on ${cores} cores` : null;
}
