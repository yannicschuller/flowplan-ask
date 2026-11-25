// POST /api/bot/report-draft (README "Bot API", "Report drafts"): the
// Discord bot asks Flo to draft a bug report or a feature request from a
// conversation it holds (this service stores no conversations). A third
// kind of model call besides the questions and the insight summary – one
// per draft, with its own fixed system prompt (lib/prompt-draft.ts), its
// own max_tokens (settings.reports.maxTokens) and its own budget
// reservation (lib/limits.ts reserveDraft / settleDraft). What goes to
// Anthropic: only the report kind and the conversation's texts, scrubbed
// like the Q&A log (e-mail addresses, numbers, addresses, tokens masked) –
// never the subject, a Discord id, a name, a channel or a time. The draft is
// untrusted text: parsed, every field through the answer sanitiser and the
// scrubber, bounded. It is never stored – only its cost and counts.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { HttpError, json } from "./http";
import { LimitError } from "./rate-limit";
import { isBlocked, subjectKey, validDiscordSubject } from "./subjects";
import { getSettings } from "./settings";
import { draftReservedNano, draftsLeftToday, reserveDraft, settleDraft, type DraftKind } from "./limits";
import { ceilingNano, costNano } from "./models";
import { describeError, draftClaude } from "./claude";
import { CLIENT, DATABASE, HOSTING, draftPromptBytes, draftUserTurn } from "./prompt-draft";
import type { Turn } from "./prompt";
import { sanitizeAnswer } from "./sanitize";
import { scrub } from "./qalog";
import { nextMonth, now } from "./clock";

export const DRAFT_MAX_BODY = 64 * 1024;
// The conversation sent: the newest turns, at most this many and this long.
export const DRAFT_MAX_TURNS = 20;
export const DRAFT_MAX_CONVERSATION_CHARS = 12_000;
// Field lengths – they fit a Discord modal input and an embed field (1,024).
export const DRAFT_LIMITS = {
  title: 90,
  what: 1000,
  step: 200,
  steps: 8,
  stepsChars: 1000,
  expected: 600,
  version: 50,
  environment: 150,
  logs: 1000,
  problem: 1000,
  proposal: 1000,
  alternatives: 600,
} as const;

export type BugDraft = {
  title: string;
  what: string;
  steps: string[];
  expected: string;
  version: string | null;
  hosting: string | null;
  database: string | null;
  client: string | null;
  environment: string | null;
  logs: string | null;
};
export type FeatureDraft = { title: string; problem: string; proposal: string | null; alternatives: string | null };
export const BUG_FIELDS = ["title", "what", "steps", "expected", "version", "hosting", "database", "client", "environment", "logs"] as const;
export const FEATURE_FIELDS = ["title", "problem", "proposal", "alternatives"] as const;

const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g;
const cleanTurn = (s: string) => scrub(s.replace(/\r\n?/g, "\n").replace(INVISIBLE, "")).trim();

// The conversation as sent by the bot: { role, text } turns, oldest first.
export function readHistory(v: unknown): Turn[] {
  if (!Array.isArray(v) || !v.length || v.length > 100) throw new HttpError(400, "invalid_history", "history must be a non-empty list of turns.");
  let turns: Turn[] = [];
  for (const t of v) {
    const turn = t as Record<string, unknown> | null;
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.text !== "string")
      throw new HttpError(400, "invalid_history", 'Each history turn is { role: "user"|"assistant", text }.');
    const text = cleanTurn(turn.text.slice(0, DRAFT_MAX_CONVERSATION_CHARS));
    if (text) turns.push({ role: turn.role, text });
  }
  turns = turns.slice(-DRAFT_MAX_TURNS);
  let total = turns.reduce((n, t) => n + t.text.length, 0);
  while (turns.length > 1 && total > DRAFT_MAX_CONVERSATION_CHARS) total -= turns.shift()!.text.length;
  if (total > DRAFT_MAX_CONVERSATION_CHARS) turns[0] = { ...turns[0], text: turns[0].text.slice(-DRAFT_MAX_CONVERSATION_CHARS) };
  if (!turns.some((t) => t.role === "user")) throw new HttpError(400, "invalid_history", "history needs at least one turn of the user.");
  return turns;
}

// One field of the draft: the answer sanitiser (no HTML, links only to the
// allow-list, mentions defused), the log's scrubber, no code fences, bounded.
export function draftText(input: unknown, max: number, multiline = false): string {
  if (typeof input !== "string") return "";
  let s = scrub(sanitizeAnswer(input.slice(0, 4 * max), "en")).replace(/`{3,}[a-z0-9+#.-]*/gi, "").replace(/\*\*/g, "");
  s = multiline ? s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : s.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 2);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()} …`;
}
const orNull = (s: string) => s || null;
const option = (v: unknown, list: readonly string[]) => (typeof v === "string" && list.includes(v) ? v : null);

// The model's answer → a clean draft and its missing fields, or null.
export function parseDraft(kind: DraftKind, text: string): { draft: BugDraft | FeatureDraft; missing: string[] } | null {
  let s = (text || "").slice(0, 100_000).trim();
  // A code fence around the whole object (fences inside its strings stay).
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(s);
  if (fence) s = fence[1];
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let v: unknown;
  try {
    v = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const L = DRAFT_LIMITS;
  if (kind === "feature") {
    const draft: FeatureDraft = {
      title: draftText(o.title, L.title),
      problem: draftText(o.problem, L.problem, true),
      proposal: orNull(draftText(o.proposal, L.proposal, true)),
      alternatives: orNull(draftText(o.alternatives, L.alternatives, true)),
    };
    if (!draft.title && !draft.problem) return null;
    return { draft, missing: FEATURE_FIELDS.filter((f) => !draft[f]) };
  }
  const steps: string[] = [];
  let chars = 0;
  for (const step of Array.isArray(o.steps) ? o.steps : []) {
    const t = draftText(step, L.step).replace(/^\d+[.)]\s*/, "");
    if (!t) continue;
    if (steps.length >= L.steps || chars + t.length + 5 > L.stepsChars) break;
    steps.push(t);
    chars += t.length + 5;
  }
  const clients = (Array.isArray(o.client) ? o.client : []).map((c) => option(c, CLIENT)).filter((c): c is string => !!c);
  const draft: BugDraft = {
    title: draftText(o.title, L.title),
    what: draftText(o.what, L.what, true),
    steps,
    expected: draftText(o.expected, L.expected, true),
    version: orNull(draftText(o.version, L.version)),
    hosting: option(o.hosting, HOSTING),
    database: option(o.database, DATABASE),
    client: clients.length ? [...new Set(clients)].join(", ") : null,
    environment: orNull(draftText(o.environment, L.environment)),
    logs: orNull(draftText(o.logs, L.logs, true)),
  };
  if (!draft.title && !draft.what) return null;
  return { draft, missing: BUG_FIELDS.filter((f) => (f === "steps" ? !draft.steps.length : !draft[f])) };
}

export async function reportDraft(body: Record<string, unknown>): Promise<Response> {
  const settings = getSettings();
  if (!settings.enabled.global || !settings.enabled.discord || !settings.reports.enabled || !config.anthropicConfigured())
    throw new HttpError(503, "off", "Report drafts are switched off right now.");
  const kind = body.kind;
  if (kind !== "bug" && kind !== "feature") throw new HttpError(400, "invalid_kind", 'kind must be "bug" or "feature".');
  const raw = validDiscordSubject(body.subject);
  if (!raw) throw new HttpError(400, "invalid_subject", "subject must be the bot's hashed subject (8–128 characters).");
  const subject = subjectKey("discord", raw);
  const history = readHistory(body.history);
  // A blocked subject is told it reached its limit (and nothing more).
  if (isBlocked(subject)) throw new LimitError("subject", nextMonth(now()));

  const user = draftUserTurn({ kind, history });
  const model = settings.model;
  const maxTokens = settings.reports.maxTokens;
  const id = reserveDraft({ settings, subject, kind, model, ceilingNano: ceilingNano(model, draftPromptBytes(kind, user), maxTokens) });
  const started = performance.now();
  let reply;
  try {
    reply = await draftClaude({ model, maxTokens, kind, user });
  } catch (error) {
    // As for a question: a timeout or a dropped connection may have been billed.
    const maybeBilled = !(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIConnectionError;
    settleDraft(id, { status: "error", error: "upstream", costNano: maybeBilled ? draftReservedNano(id) : 0, latencyMs: Math.round(performance.now() - started) });
    console.error("anthropic (draft):", describeError(error));
    throw new HttpError(502, "upstream", "Flo can't draft the report right now – please try again in a moment.");
  }
  const usage = reply.usage;
  const outcome = {
    costNano: costNano(model, usage),
    inputTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
    outputTokens: usage.output_tokens,
    latencyMs: Math.round(performance.now() - started),
  };
  const parsed = reply.stopReason === "refusal" || reply.stopReason === "max_tokens" ? null : parseDraft(kind, reply.text);
  if (!parsed) {
    settleDraft(id, { status: "error", error: reply.stopReason === "max_tokens" ? "max_tokens" : reply.stopReason === "refusal" ? "refusal" : "invalid_answer", ...outcome });
    throw new HttpError(502, "no_draft", "Flo could not draft this report – please write it yourself.");
  }
  settleDraft(id, { status: "ok", ...outcome });
  return json({ kind, draft: parsed.draft, missing: parsed.missing, usage: { remainingToday: draftsLeftToday(settings, subject) } });
}
