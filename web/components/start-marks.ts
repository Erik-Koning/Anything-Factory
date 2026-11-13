// The six steps a Mac goes through to start a team (lib/tasks/start.ts), in the same words wherever they're shown: the
// row of marks on a project being started, and "What happens next" beside the form that asks.
import type { StartStep } from "../../lib/tasks/start.ts";

export const MARKS: { step: StartStep; label: string; will: string; doing: string }[] = [
  {
    step: "picked-up",
    label: "Picked up",
    will: "Within five minutes the Mac has the ask, checks it can do it, and lets you know by its own email or WhatsApp if you connected one.",
    doing: "The Mac has the ask, and is checking it can do it.",
  },
  {
    step: "repository",
    label: "Repository",
    will: "It makes the repository when it's new, with a README that holds the title and what you wrote.",
    doing: "Making the repository and its first commit.",
  },
  {
    step: "draft",
    label: "Draft",
    will: "It reads what the repository holds and drafts the team's rules from it, in a checkout of the team's own.",
    doing: "Reading what the repository holds, and drafting the team's rules from it.",
  },
  {
    step: "setup",
    label: "Setup",
    will: "A setup agent finishes the rules from the repository and what you wrote, and writes down each thing it assumed. The longest step: often ten minutes or more.",
    doing: "A setup agent is finishing the team's rules. The longest step: often ten minutes or more.",
  },
  {
    step: "check",
    label: "Check",
    will: "The team's checks run on a fresh copy, so nothing starts on a setup that doesn't hold.",
    doing: "Running the team's checks on a fresh copy.",
  },
  {
    step: "register",
    label: "Start",
    will: "The team is registered with the budget and subscriptions you chose, its planner starts, and it shows on Teams.",
    doing: "Registering the team with its budget and subscriptions, and starting its planner.",
  },
];
