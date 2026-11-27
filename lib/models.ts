// Which model each role runs on. A team names one per role in team.json (roles.<role>.model), or one for every role
// that names none (model). Left out, the roles that decide what gets built and on what (the planner, the innovator and
// the scaffolder) run on Fable, and the roles that build it and check it on Opus: a wrong plan or a wrong foundation
// costs every task after it, so the dearer model goes where a mistake travels furthest. While the subscription a role
// runs on has used up Fable's own weekly limit, a role on Fable runs on Opus until it resets (lib/subscriptions.ts
// fallbackFor).
import { modelKey } from "./prices.ts";

// Short names for the newest model of each family this version knows, so a team.json can say "opus" and move with the
// factory's releases. Any other value is a model id, taken as written.
export const MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5-2",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

// A model id as team.json and the registry may hold it: it goes into a command line and into the planner's rules.
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

const DESIGNS = new Set(["planner", "innovator", "scaffolder"]);

export const defaultModel = (role: string): string => MODEL_ALIASES[DESIGNS.has(role) ? "fable" : "opus"] as string;

// The id a team.json value names: an alias's, in any case, or the value itself.
export const modelId = (name: string): string => (Object.hasOwn(MODEL_ALIASES, name.toLowerCase()) ? (MODEL_ALIASES[name.toLowerCase()] as string) : name);

// The family a model id or a usage report's model name is of ("fable" for claude-fable-5-2, and for "Fable"), or null.
export const familyOf = (name: string): string | null =>
  Object.keys(MODEL_ALIASES).find((family) => new RegExp(`(^|[^a-z])${family}([^a-z]|$)`, "i").test(name)) ?? null;

// What a role on a model of the family runs on while the subscription it runs on has used up that family's own weekly
// limit (Fable's, on some plans, beside the limit across all models): the newest of another family, until it resets.
export const FALLBACKS: Record<string, string> = { fable: "opus" };

// The model a role on `model` runs on while its family's own limit is used up, or null when it has none.
export function fallbackModel(model: string): string | null {
  const to = FALLBACKS[familyOf(model) ?? ""];
  return to ? (MODEL_ALIASES[to] ?? null) : null;
}

// A model as people say it: its family's name for the newest of one ("Opus" for claude-opus-5-5), else its id.
export function modelName(id: string): string {
  const alias = Object.keys(MODEL_ALIASES).find((name) => MODEL_ALIASES[name] === id);
  return alias ? `${alias.charAt(0).toUpperCase()}${alias.slice(1)}` : id;
}

// --- Newer models -----------------------------------------------------------------------------------------------
// The short names are this version's table, so a model released after it reaches no role until a release knows it and
// each team moves to that release (a6g upgrade): Fable 5.2 was in use on the operator's own sessions for days while
// their teams' roles on Fable still ran 5.1. The models in use on this machine's subscriptions (lib/subscriptions.ts
// modelNotices) say when a family has a newer one than its short name here, or a team runs an older one than it.

// A model id's family and version ("fable" and [5, 2] for claude-fable-5-2, [5, 0] for claude-opus-5), with a context
// marker or a date suffix aside; null for an id of no family here, or one without a version.
export function versionOf(id: string): { family: string; version: [number, number] } | null {
  const match = /^claude-([a-z]+)-(\d{1,3})(?:-(\d{1,2}))?$/.exec(modelKey(id));
  if (!match || !Object.hasOwn(MODEL_ALIASES, match[1] as string)) return null;
  return { family: match[1] as string, version: [Number(match[2]), Number(match[3] ?? 0)] };
}

// Whether `a` is a newer model than `b` of the same family.
export function newerThan(a: string, b: string): boolean {
  const [x, y] = [versionOf(a), versionOf(b)];
  if (!x || !y || x.family !== y.family) return false;
  return x.version[0] - y.version[0] > 0 || (x.version[0] === y.version[0] && x.version[1] > y.version[1]);
}

// A model as the release notes name it: "Fable 5.2" for claude-fable-5-2, else its id.
export function modelTitle(id: string): string {
  const of = versionOf(id);
  if (!of) return id;
  return `${of.family.charAt(0).toUpperCase()}${of.family.slice(1)} ${of.version[0]}${of.version[1] ? `.${of.version[1]}` : ""}`;
}

// For each family, the newest of `ids` that's newer than this version's short name for it: what a role on that short
// name would run on if this version knew it. By family.
export function newerThanShortNames(ids: Iterable<string>): Record<string, string> {
  const newest: Record<string, string> = {};
  for (const id of ids) {
    const of = versionOf(id);
    if (!of) continue;
    const bar = newest[of.family] ?? (MODEL_ALIASES[of.family] as string);
    if (newerThan(id, bar)) newest[of.family] = modelKey(id);
  }
  return newest;
}

// Whether a team's role, as team.json writes it (`raw`), runs on a short name or on the default, which a6g upgrade moves
// with the factory's releases; a role that names a model id keeps it, on purpose.
export function onShortName(raw: unknown, role: string): boolean {
  const team = raw && typeof raw === "object" ? (raw as { model?: unknown; roles?: Record<string, { model?: unknown } | null> }) : {};
  const written = team.roles?.[role]?.model ?? team.model;
  return written === undefined || (typeof written === "string" && Object.hasOwn(MODEL_ALIASES, written.toLowerCase()));
}
