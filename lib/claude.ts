// The one call to the Claude API per question: no tools, no MCP, no web
// access. The insight summary (lib/insights.ts) is a separate path with its
// own call below – not a question, made on a schedule or by an admin, with
// its own fixed system prompt and its own budget reservation. The client reads ANTHROPIC_API_KEY itself (new Anthropic()); the
// key is never logged and never part of an answer. Tests hand in a client
// with a baseURL pointing to a local mock (useAnthropic()).
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt";
import { INSIGHTS_SCHEMA, INSIGHTS_SYSTEM_PROMPT } from "./prompt-insights";
import type { ModelId } from "./models";

const holder = globalThis as unknown as { askAnthropic?: Anthropic | null };

export function anthropic(): Anthropic {
  // One retry at most: the reserved cost covers one answer, and a waiting
  // user prefers a quick "try again".
  holder.askAnthropic ??= new Anthropic({ maxRetries: 0, timeout: 45_000, logLevel: "off" });
  return holder.askAnthropic;
}
export const useAnthropic = (client: Anthropic | null) => {
  holder.askAnthropic = client;
};

export type ClaudeAnswer = {
  text: string;
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
};

export async function askClaude(input: { model: ModelId; maxTokens: number; user: string }): Promise<ClaudeAnswer> {
  const response = await anthropic().messages.create({
    model: input.model,
    max_tokens: input.maxTokens,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: input.user }] }],
    output_config: { effort: "low" },
  });
  return answerOf(response);
}

// The insight summary: one call per summary, no tools, no MCP, no web
// access, no metadata; a structured (JSON) answer. No prompt cache – it
// runs at most a few times a day, so a cache write would only cost more.
export async function summarizeClaude(input: { model: ModelId; maxTokens: number; user: string }): Promise<ClaudeAnswer> {
  const response = await anthropic().messages.create({
    model: input.model,
    max_tokens: input.maxTokens,
    system: [{ type: "text", text: INSIGHTS_SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [{ type: "text", text: input.user }] }],
    output_config: { effort: "low", format: { type: "json_schema", schema: INSIGHTS_SCHEMA as unknown as Record<string, unknown> } },
  });
  return answerOf(response);
}

function answerOf(response: Anthropic.Message): ClaudeAnswer {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const u = response.usage;
  return {
    text,
    stopReason: response.stop_reason ?? null,
    usage: {
      input_tokens: u?.input_tokens ?? 0,
      output_tokens: u?.output_tokens ?? 0,
      cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
    },
  };
}

// A log line for a failed call: the error's class, status and request id –
// never its message or headers (and never the key).
export function describeError(error: unknown) {
  if (error instanceof Anthropic.APIError) {
    const body = error.error as { error?: { type?: unknown } } | undefined;
    const type = typeof body?.error?.type === "string" ? body.error.type.replace(/[^a-z_]/g, "").slice(0, 40) : "-";
    return `status=${error.status ?? "-"} type=${type} request=${error.requestID ?? "-"}`;
  }
  return error instanceof Error ? error.name : "unknown error";
}
// Worth a retry later (rate limit, overload, connection) rather than a configuration problem.
export const isTransient = (error: unknown) =>
  error instanceof Anthropic.RateLimitError ||
  error instanceof Anthropic.InternalServerError ||
  error instanceof Anthropic.APIConnectionError;
