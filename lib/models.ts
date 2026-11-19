// The models the admin may choose and their prices (USD per million tokens),
// for the cost accounting. Prompts stay far below 100K tokens (the price
// tier of Claude Haiku 5.5): see MAX_PROMPT_TOKENS.
export const MODELS = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
} as const;
export type ModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelId = "claude-haiku-5-5";
export const isModel = (v: unknown): v is ModelId => typeof v === "string" && Object.hasOwn(MODELS, v);

// The Haiku price tier ends at 100K prompt tokens; a request is refused well before.
export const MAX_PROMPT_TOKENS = 60_000;

// Costs are kept as integer nano-USD (1e-9 USD): a price of p USD per
// million tokens is p * 1000 nano-USD per token.
export const NANO_PER_USD = 1_000_000_000;
const perToken = (usdPerMTok: number) => Math.round(usdPerMTok * 1000);

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

// The cost of one answer from its usage.
export function costNano(model: ModelId, usage: Usage) {
  const p = MODELS[model];
  return (
    Math.max(0, usage.input_tokens || 0) * perToken(p.input) +
    Math.max(0, usage.output_tokens || 0) * perToken(p.output) +
    Math.max(0, usage.cache_creation_input_tokens || 0) * perToken(p.cacheWrite) +
    Math.max(0, usage.cache_read_input_tokens || 0) * perToken(p.cacheRead)
  );
}

// An upper bound of what one request can cost, reserved before the call:
// every prompt token at the highest input price (a cache write) – a token
// is never shorter than one byte, so the UTF-8 size bounds the count – plus
// max_tokens of output (thinking included).
export function ceilingNano(model: ModelId, promptBytes: number, maxTokens: number) {
  const p = MODELS[model];
  return promptBytes * perToken(Math.max(p.input, p.cacheWrite)) + maxTokens * perToken(p.output);
}

export const usd = (nano: number) => Math.round(nano / 1000) / 1_000_000;
export const nano = (usdValue: number) => Math.round(usdValue * NANO_PER_USD);
