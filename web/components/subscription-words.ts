// A Claude subscription as a page shows it, and the words for how much of it is used: shared by the list on a team's
// overview (a server component) and the picker that orders them (a client one).
export interface SubscriptionOption {
  name: string;
  // How much of its week is used, as last read; null before a reading.
  percent: number | null;
  // When that week ends, and why it's closed to the team now, when it is.
  resetsAt?: string | null;
  closed?: string | null;
}

const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

// How much of a subscription's week is used, and when a closed one opens again: the same words wherever one is shown.
export function usedWords(option: Pick<SubscriptionOption, "percent" | "resetsAt" | "closed"> | undefined): string {
  if (option?.percent === null || option?.percent === undefined) return "usage not read yet";
  const when = option.resetsAt ? ` · ${option.closed ? "opens again" : "resets"} ${day.format(new Date(option.resetsAt))}` : "";
  return `${option.percent}% of its week used${when}`;
}
