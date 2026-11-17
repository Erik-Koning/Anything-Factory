// Which model each role runs on. A team names one per role in team.json (roles.<role>.model), or one for every role
// that names none (model). Left out, the roles that decide what gets built and on what (the planner, the innovator and
// the scaffolder) run on Fable, and the roles that build it and check it on Opus: a wrong plan or a wrong foundation
// costs every task after it, so the dearer model goes where a mistake travels furthest. While the subscription a role
// runs on has used up Fable's own weekly limit, a role on Fable runs on Opus until it resets (lib/subscriptions.ts
// fallbackFor).

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
