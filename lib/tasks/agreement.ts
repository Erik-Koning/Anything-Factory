// The working agreement: how readily a team brings a question to its operator, which the operator sets and changes at
// any time (a6g agreement, or the web app). Three parts: a level, topics that are always or never asked, and the
// operator's standing instructions in their own words. Each change is a control in the team's store (controls.ts), so
// the newest is in force and the rest are its history.
//
// The planner judges a question three ways (its topic, what a wrong call costs, how sure it is), and route() turns
// those into what happens: asked, decided and flagged for the operator, or decided and recorded. The commands that
// ask (a6g task status … question) and record (a6g decision record) both go through it, so a prompt can't loosen it.
// Pure: the web app shows and edits the same agreement with this code.

export const LEVELS = ["hands-on", "balanced", "hands-off"] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_MEANS: Record<Level, string> = {
  "hands-on": "asks whenever it's unsure and the call matters, and flags more of what it decides",
  balanced: "asks only when two options still fit and a wrong call would be costly",
  "hands-off": "decides everything that isn't always yours, and flags the calls that matter most",
};

// How much, for the two things the planner grades: what a wrong call costs, and how sure it is of the operator's choice.
export const GRADES = ["low", "medium", "high"] as const;
export type Grade = (typeof GRADES)[number];
export const STAKES_MEAN: Record<Grade, string> = {
  low: "a revert undoes it, and nobody outside the team sees it",
  medium: "merged work is redone, or people would notice the change",
  high: "it reaches users, real data or money before the operator could see it, changes the scope a lot, or is costly to undo",
};
export const CONFIDENCE_MEANS: Record<Grade, string> = {
  high: "the direction, a recorded decision or the brief says so",
  medium: "it follows from what the operator has said about the product, its users or the company",
  low: "two or more options still fit the direction",
};

// What happens to a question: the operator is asked; the team decides and flags it for them; the team decides.
export const ROUTES = ["ask", "tell", "decide"] as const;
export type Route = (typeof ROUTES)[number];
export const ROUTE_WORDS: Record<Route, string> = { ask: "asked", tell: "decided and flagged", decide: "decided" };

export const TOPICS = ["product", "scope", "design", "technical", "cost", "security", "privacy", "rules"] as const;
export type Topic = (typeof TOPICS)[number];
export const TOPIC_MEANS: Record<Topic, string> = {
  product: "what a person sees or can do: a behaviour, a default, a limit, an empty or error state",
  scope: "what's in or out: adding to, or dropping from, what the brief or the direction asks for",
  design: "how it looks and reads: layout, wording, visual choices",
  technical: "the platform, the stack, the data model, dependencies, the architecture",
  cost: "what it costs to run, or what the team spends building it",
  security: "who can see or do what: sign-in, permissions, what's exposed",
  privacy: "personal data: collecting, showing, moving or keeping it",
  rules: "the team's own rules and its brief: unlocking a policy, promoting to production, checking less, a brief that contradicts itself or can't be met",
};
// Always the operator's, whatever the agreement says (Article 3): asked, and not for an agreement to set.
export const RESERVED: readonly Topic[] = ["privacy", "rules"];
export const isReserved = (topic: Topic): boolean => RESERVED.includes(topic);

// What the operator may say of a topic: always ask about it, or never (decided, and flagged when it would have been asked).
export const TOPIC_RULES = ["ask", "decide"] as const;
export type TopicRule = (typeof TOPIC_RULES)[number];

export interface Agreement {
  level: Level;
  topics: Partial<Record<Topic, TopicRule>>;
  // The operator's standing instructions to the planner, in their words.
  notes: string;
  // How often the planner's messages may reach the operator, in place of the team's own setting (team.json contact,
  // lib/contact.ts): absent, the team's own holds.
  contact?: AgreementContact;
}
// As team.json's contact: everything open together at most once per `everyMin` ("digest"), or each message as soon as
// it's needed ("priority", whose everyMin is 0).
export interface AgreementContact {
  mode: "digest" | "priority";
  everyMin: number;
}
export const CONTACT_MODES = ["digest", "priority"] as const;
// A digest's window: from a quarter of an hour to a week.
export const CONTACT_EVERY = { min: 15, max: 7 * 24 * 60 } as const;
// What a team works under until its operator says otherwise: what its rules always said. A change of scope is the
// operator's (Article 3) until they leave it to the level or to the team, so the default asks about it.
export const DEFAULT_AGREEMENT: Agreement = { level: "balanced", topics: { scope: "ask" }, notes: "" };
export const NOTES_MAX = 2000;

const isOneOf = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
export const isLevel = (value: unknown): value is Level => isOneOf(value, LEVELS);
export const isGrade = (value: unknown): value is Grade => isOneOf(value, GRADES);
export const isTopic = (value: unknown): value is Topic => isOneOf(value, TOPICS);
export const isTopicRule = (value: unknown): value is TopicRule => isOneOf(value, TOPIC_RULES);

// By level, then what a wrong call costs, then how sure the team is. `balanced` is what the planner's rules always
// said: ask only when two options still fit and a wrong call would be costly.
const TABLES: Record<Level, Record<Grade, Record<Grade, Route>>> = {
  "hands-on": {
    low: { high: "decide", medium: "decide", low: "tell" },
    medium: { high: "decide", medium: "tell", low: "ask" },
    high: { high: "tell", medium: "ask", low: "ask" },
  },
  balanced: {
    low: { high: "decide", medium: "decide", low: "decide" },
    medium: { high: "decide", medium: "decide", low: "tell" },
    high: { high: "tell", medium: "tell", low: "ask" },
  },
  "hands-off": {
    low: { high: "decide", medium: "decide", low: "decide" },
    medium: { high: "decide", medium: "decide", low: "decide" },
    high: { high: "decide", medium: "tell", low: "tell" },
  },
};
// A level's table, for showing it: rows by stakes, columns by confidence.
export const tableOf = (level: Level): Record<Grade, Record<Grade, Route>> => TABLES[level];

// A question as the planner judged it.
export interface Judged {
  topic: Topic;
  stakes: Grade;
  confidence: Grade;
}
export interface Routed {
  route: Route;
  // Why, in words: the record of a decision keeps it, and a refusal says it.
  rule: string;
}

// What the agreement does with a question. `operator.technical` false (team.json) means the platform and the stack are
// never asked, as that team's rules already say.
export function route(agreement: Agreement, { topic, stakes, confidence }: Judged, operator: { technical: boolean } = { technical: true }): Routed {
  if (isReserved(topic)) return { route: "ask", rule: `${topic} is always the operator's (Article 3), whatever the agreement says` };
  const table = TABLES[agreement.level][stakes][confidence];
  const graded = `${stakes} stakes with ${confidence} confidence`;
  // Never asked: what the table would have asked is decided and flagged instead.
  const unasked = (why: string): Routed => ({
    route: table === "ask" ? "tell" : table,
    rule:
      table === "ask"
        ? `${why}; ${graded} would be asked at ${agreement.level}, so it's flagged`
        : `${why}; ${graded} is ${ROUTE_WORDS[table]} at ${agreement.level}`,
  });
  if (topic === "technical" && !operator.technical)
    return unasked("the operator isn't technical, so the platform and the stack are never asked (team.json operator.technical)");
  const set = agreement.topics[topic];
  if (set === "ask") return { route: "ask", rule: `the agreement always asks about ${topic}` };
  if (set === "decide") return unasked(`the agreement never asks about ${topic}`);
  return { route: table, rule: `${agreement.level}: ${graded} is ${ROUTE_WORDS[table]}` };
}

// Control and format characters (a bidirectional override, a zero-width space, a terminal escape), as lib/untrusted.ts
// names them: the instructions go into an agent's context as the operator typed them, without those.
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
export const cleanNotes = (text: string): string =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(UNSHOWN, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// How often messages may go, from what a form or a command gave: nothing (the team's own setting), or a mode and, for a
// digest, its window in minutes.
function contactFrom(input: unknown): AgreementContact | null | { problem: string } {
  if (input === undefined || input === null || input === "" || input === "team") return null;
  const given = input as { mode?: unknown; everyMin?: unknown };
  if (typeof input !== "object" || !isOneOf(given.mode, CONTACT_MODES))
    return {
      problem: "Messages: a digest (everything open together, at most once per window), as soon as they're needed, or as the team's own settings say.",
    };
  if (given.mode === "priority") return { mode: "priority", everyMin: 0 };
  const every = Number(given.everyMin);
  if (!Number.isInteger(every) || every < CONTACT_EVERY.min || every > CONTACT_EVERY.max)
    return { problem: `A digest goes at most once per window, from ${CONTACT_EVERY.min} minutes to a week: say how long.` };
  return { mode: "digest", everyMin: every };
}

// A window in words: "4 h", "30 min", "2 d".
export const everyWords = (minutes: number): string =>
  minutes % 1440 === 0
    ? `${minutes / 1440} d`
    : minutes % 60 === 0
      ? `${minutes / 60} h`
      : minutes > 60
        ? `${Number((minutes / 60).toFixed(1))} h`
        : `${minutes} min`;
export const contactWords = (contact: AgreementContact): string =>
  contact.mode === "priority" ? "each as soon as it's needed" : `a digest, at most one every ${everyWords(contact.everyMin)}`;

// An agreement from what a form or a command gave, or what's wrong with it.
export function agreementFrom(input: { level?: unknown; topics?: unknown; notes?: unknown; contact?: unknown }): Agreement | { problem: string } {
  if (!isLevel(input.level)) return { problem: `Choose a level: ${LEVELS.join(", ")}.` };
  const topics: Agreement["topics"] = {};
  for (const [topic, rule] of Object.entries((input.topics ?? {}) as Record<string, unknown>)) {
    if (rule === undefined || rule === null || rule === "" || rule === "follow") continue;
    if (!isTopic(topic)) return { problem: `There's no topic ${topic}: ${TOPICS.filter((t) => !isReserved(t)).join(", ")}.` };
    if (isReserved(topic)) return { problem: `${topic} is always asked (Article 3): it isn't the agreement's to set.` };
    if (!isTopicRule(rule)) return { problem: `${topic}: always ask, never ask, or follow the level.` };
    topics[topic] = rule;
  }
  const notes = cleanNotes(typeof input.notes === "string" ? input.notes : "");
  if (notes.length > NOTES_MAX) return { problem: `Keep the standing instructions to ${NOTES_MAX.toLocaleString("en")} characters.` };
  const contact = contactFrom(input.contact);
  if (contact && "problem" in contact) return contact;
  return { level: input.level, topics, notes, ...(contact ? { contact } : {}) };
}

// An agreement as stored, read back whatever wrote it: an unknown level or topic falls back rather than throwing.
export function normalised(agreement: Partial<Agreement> | null | undefined): Agreement {
  const made = agreementFrom({ level: agreement?.level, topics: agreement?.topics, notes: agreement?.notes, contact: agreement?.contact });
  if (!("problem" in made)) return made;
  const contact = contactFrom(agreement?.contact);
  const topics = Object.fromEntries(
    Object.entries(agreement?.topics ?? {}).filter(([topic, rule]) => isTopic(topic) && !isReserved(topic) && isTopicRule(rule))
  ) as Agreement["topics"];
  return {
    level: isLevel(agreement?.level) ? agreement.level : DEFAULT_AGREEMENT.level,
    topics,
    notes: cleanNotes(String(agreement?.notes ?? "")).slice(0, NOTES_MAX),
    ...(contact && !("problem" in contact) ? { contact } : {}),
  };
}

const sameContact = (a: AgreementContact | undefined, b: AgreementContact | undefined): boolean =>
  (a?.mode ?? null) === (b?.mode ?? null) && (a?.everyMin ?? null) === (b?.everyMin ?? null);
export const sameAgreement = (a: Agreement, b: Agreement): boolean =>
  a.level === b.level &&
  a.notes === b.notes &&
  sameContact(a.contact, b.contact) &&
  TOPICS.every((topic) => (a.topics[topic] ?? null) === (b.topics[topic] ?? null));

const topicsSet = (agreement: Agreement, rule: TopicRule): Topic[] => TOPICS.filter((topic) => agreement.topics[topic] === rule);

// The agreement in a few lines, for the planner's context, a6g agreement and a6g status. Without the standing
// instructions, which the caller places (clipped in a context, whole in a message).
export function agreementLines(agreement: Agreement, operator: { technical: boolean } = { technical: true }): string[] {
  // A team whose operator isn't technical never asks the stack, whatever the agreement says of it.
  const theirs = (topic: Topic): boolean => topic !== "technical" || operator.technical;
  const asked = topicsSet(agreement, "ask").filter(theirs);
  const never = topicsSet(agreement, "decide").filter(theirs);
  if (!operator.technical) never.push("technical");
  return [
    `Level ${agreement.level}: the team ${LEVEL_MEANS[agreement.level]}.`,
    [
      asked.length ? `Always asked: ${asked.join(", ")}.` : null,
      never.length ? `Never asked (decided, and flagged when it matters): ${never.join(", ")}.` : null,
      `Always the operator's: ${RESERVED.join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" "),
    ...(agreement.contact ? [`Messages to the operator, by the agreement: ${contactWords(agreement.contact)}.`] : []),
  ];
}

// What changed between two agreements, in words, for the history and the message to the planner.
export function agreementChanges(before: Agreement, after: Agreement): string[] {
  const changes: string[] = [];
  if (before.level !== after.level) changes.push(`level ${before.level} → ${after.level}`);
  for (const topic of TOPICS) {
    const was = before.topics[topic] ?? null;
    const now = after.topics[topic] ?? null;
    if (was !== now) changes.push(`${topic}: ${now === "ask" ? "always asked" : now === "decide" ? "never asked" : "follows the level again"}`);
  }
  if (before.notes !== after.notes)
    changes.push(after.notes ? (before.notes ? "standing instructions changed" : "standing instructions added") : "standing instructions removed");
  if (!sameContact(before.contact, after.contact))
    changes.push(after.contact ? `messages: ${contactWords(after.contact)}` : "messages: as the team's own settings say again");
  return changes;
}
