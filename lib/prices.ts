// What a model request would cost on the Claude API, in US dollars: the API-equivalent price of what a team used. A
// team on a Claude subscription isn't billed per token, but its usage limits weigh models roughly as these prices do,
// so the same figure serves budgets either way. Prices per million tokens, from Anthropic's model price list as of
// 2026-10-06 (platform.claude.com/docs/en/about-claude/pricing); when it changes, change PRICES and PRICED_AT.
//
// A cache read costs 0.1× input unless the model says otherwise; a cache write 1.25× input for the 5-minute TTL and 2×
// for the 1-hour one. Fast mode costs twice the standard rate.

export const PRICED_AT = "2026-10-06";

interface Price {
  input: number;
  output: number;
  // Cache reads, where the model isn't 0.1× input.
  cacheRead?: number;
  // Above this many prompt tokens a request costs `above`'s rates (Claude Haiku 5.5's long-prompt tier).
  tier?: { over: number; input: number; output: number };
}

const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, tier: { over: 100_000, input: 0.5, output: 2.5 } },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// One request's tokens, as a transcript's `usage` gives them.
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  // Cache writes by TTL; a transcript without the breakdown counts all of them as 5-minute writes.
  cacheWrite5m: number;
  cacheWrite1h: number;
  fast?: boolean;
}

// The model's id as priced: without a date suffix (claude-haiku-4-5-20251001) or a context marker (claude-opus-5[1m]).
export const modelKey = (model: string): string => model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");

export const priced = (model: string): boolean => Object.hasOwn(PRICES, modelKey(model));

// The request's API-equivalent cost in dollars, or null for a model the table doesn't know.
export function costOf(model: string, t: Tokens): number | null {
  const price = PRICES[modelKey(model)];
  if (!price) return null;
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  const { input, output } = price.tier && prompt > price.tier.over ? price.tier : price;
  const read = price.cacheRead !== undefined && !(price.tier && prompt > price.tier.over) ? price.cacheRead : input * 0.1;
  const dollars = (t.input * input + t.output * output + t.cacheRead * read + t.cacheWrite5m * input * 1.25 + t.cacheWrite1h * input * 2) / 1e6;
  return t.fast ? dollars * 2 : dollars;
}
