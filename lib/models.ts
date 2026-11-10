// Which model each role runs on. A team names one per role in team.json (roles.<role>.model), or one for every role
// that names none (model). Left out, the roles that decide what gets built and on what (the planner, the innovator and
// the scaffolder) run on Fable, and the roles that build it and check it on Opus: a wrong plan or a wrong foundation
// costs every task after it, so the dearer model goes where a mistake travels furthest.

// Short names for the newest model of each family this version knows, so a team.json can say "opus" and move with the
// factory's releases. Any other value is a model id, taken as written.
export const MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5-1",
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
