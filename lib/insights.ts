// Insights (README "Insights"): a regular summary of what people asked Flo
// – the main topics with counts, the questions Flo could not answer, and
// candidate docs pages or features – plus a ready-to-copy prompt for the
// maintainer. Built only from the anonymised Q&A log (lib/qalog.ts), so
// only while logging is on.
//
// A summary is NOT a question. It is its own path with its own model call
// (lib/claude.ts summarizeClaude, fixed system prompt in
// lib/prompt-insights.ts), its own model (settings.insights.model) and its
// own budget reservation (lib/limits.ts reserveInsight / settleInsight:
// the maximum cost reserved before, the real cost from the usage after).
// What goes to Anthropic: only the scrubbed question texts (scrubbed again
// here) and for each whether Flo could answer it – never a subject, session,
// id, source, channel, time or answer. At most the newest 500 questions,
// each cut to 300 characters, at most 60 KB together.
//
// Scheduling: instrumentation.ts runs insightsTick() every few minutes;
// a scheduled run summarises the previous full period (the UTC day, or the
// ISO week from Monday) once – the period is unique in the table, a pending
// run blocks every other one (also across processes), and a failed period
// is retried at most three times. "Generate now" (POST
// /api/admin/insights) summarises the last 24 hours or 7 days.
import Anthropic from "@anthropic-ai/sdk";
import { all, one, run } from "./db";
import { DAY, dayKey, now, startOfDay } from "./clock";
import { HttpError } from "./http";
import { config } from "./config";
import { getSettings, type InsightsInterval, type Settings } from "./settings";
import { insightReservedNano, reserveInsight, settleInsight } from "./limits";
import { LimitError } from "./rate-limit";
import { ceilingNano, costNano, usd } from "./models";
import { describeError, summarizeClaude } from "./claude";
import { insightsPromptBytes, insightsUserTurn, type InsightQuestion } from "./prompt-insights";
import { scrub } from "./qalog";
import { sanitizeInsightText } from "./sanitize";

export const MAX_INSIGHT_QUESTIONS = 500;
export const MAX_INSIGHT_QUESTION_CHARS = 300;
export const MAX_INSIGHT_DATA_BYTES = 60_000;
export const INSIGHTS_MAX_TOKENS = 4000;
// How often a failed scheduled period is tried again (on later ticks).
export const INSIGHT_RETRIES = 3;
// How often the timer looks whether a period is due.
export const INSIGHTS_TICK_MS = 10 * 60_000;

// ---- whether Flo could answer ----------------------------------------------
// The log has no "answered" flag, so it is derived cheaply from what is
// there: a refusal (off-topic) is "refused"; an answer without any docs
// source, or one that says it found nothing in the docs (the phrases of the
// fallback answer and of the system prompt's rule 2, German and English), is
// "no"; everything else "yes".
const NOT_FOUND =
  /\bI (?:couldn['’]?t|could not|can['’]?t|cannot|did not|didn['’]?t) find\b|\bnot (?:covered|mentioned|described|documented|explained) in the (?:docs|documentation)\b|\b(?:the )?(?:docs|documentation|excerpts) (?:don['’]?t|do not|does not|doesn['’]?t) (?:cover|say|mention|describe|explain|contain)\b|\bno information (?:about|on)\b|nichts (?:dazu |darüber |davon )?(?:in der doku |in den docs )?gefunden|(?:steht|finde ich|ist) (?:leider )?(?:dazu )?nicht in der (?:doku|dokumentation)|(?:die )?(?:doku|dokumentation|auszüge) (?:sagt|sagen|beschreibt|beschreiben|erwähnt|erwähnen|enthält|enthalten) (?:dazu |darüber )?(?:leider )?nichts/i;

export type Answered = InsightQuestion["answered"];
export function answeredOf(row: { outcome: string; hasSources: boolean; answer: string }): Answered {
  if (row.outcome === "refusal") return "refused";
  if (!row.hasSources || NOT_FOUND.test(row.answer)) return "no";
  return "yes";
}

// ---- periods ----------------------------------------------------------------
export type InsightWindow = { interval: "daily" | "weekly"; period: string | null; label: string; fromAt: number; toAt: number };

export function isoWeek(at: number) {
  const day = startOfDay(at);
  const thursday = day + (3 - ((new Date(day).getUTCDay() + 6) % 7)) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}
const mondayOf = (at: number) => startOfDay(at) - ((new Date(startOfDay(at)).getUTCDay() + 6) % 7) * DAY;

// The previous full period: yesterday (UTC), or last week (Monday to Sunday).
export function scheduledWindow(interval: "daily" | "weekly", at: number): InsightWindow {
  if (interval === "daily") {
    const from = startOfDay(at) - DAY;
    return { interval, period: dayKey(from), label: dayKey(from), fromAt: from, toAt: from + DAY };
  }
  const monday = mondayOf(at);
  const from = monday - 7 * DAY;
  return { interval, period: isoWeek(from), label: `${dayKey(from)} – ${dayKey(monday - DAY)}`, fromAt: from, toAt: monday };
}
// "Generate now": the last 24 hours (daily) or the last 7 days (weekly, or when the schedule is off).
export function manualWindow(interval: InsightsInterval, at: number): InsightWindow {
  const daily = interval === "daily";
  const fromAt = at - (daily ? 1 : 7) * DAY;
  return { interval: daily ? "daily" : "weekly", period: null, label: `${dayKey(fromAt)} – ${dayKey(at)}`, fromAt, toAt: at + 1 };
}
// When the next scheduled summary starts (null when off or the log is off).
export function nextRunAt(settings: Settings, at = now()) {
  const interval = settings.insights.interval;
  if (interval === "off" || !settings.logging.enabled) return null;
  const w = scheduledWindow(interval, at);
  const due = !one("SELECT id FROM insights WHERE period=?", w.period) && failures(w.period!) < INSIGHT_RETRIES;
  if (due) return at + INSIGHTS_TICK_MS;
  return interval === "daily" ? startOfDay(at) + DAY : mondayOf(at) + 7 * DAY;
}
const failures = (period: string) => one<{ n: number }>("SELECT COUNT(*) AS n FROM insights WHERE period_key=? AND status='error'", period)?.n ?? 0;

// ---- what goes in --------------------------------------------------------------
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿-]/g;
// A logged question once more through the log's scrubber, on one line, cut.
export function cleanQuestion(text: string) {
  const s = scrub(text).replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return s.length > MAX_INSIGHT_QUESTION_CHARS ? `${s.slice(0, MAX_INSIGHT_QUESTION_CHARS - 2).trimEnd()} …` : s;
}

export type Collected = { total: number; unanswered: number; refused: number; questions: InsightQuestion[] };
// The questions of a window, newest first: counted all, sent at most the
// newest MAX_INSIGHT_QUESTIONS within MAX_INSIGHT_DATA_BYTES. Only the
// question text and whether it was answered leave this function.
export function collectQuestions(fromAt: number, toAt: number): Collected {
  const rows = all<{ question: string; answer: string; sources: string; outcome: string }>(
    "SELECT question, substr(answer,1,800) AS answer, sources, outcome FROM qa_log WHERE at>=? AND at<? ORDER BY at DESC, id DESC",
    fromAt,
    toAt,
  );
  const out: Collected = { total: rows.length, unanswered: 0, refused: 0, questions: [] };
  let bytes = 0;
  let full = false;
  for (const r of rows) {
    const answered = answeredOf({ outcome: r.outcome, hasSources: r.sources !== "[]" && r.sources !== "", answer: r.answer });
    if (answered === "no") out.unanswered++;
    else if (answered === "refused") out.refused++;
    if (full) continue;
    const text = cleanQuestion(r.question);
    if (!text) continue;
    const size = Buffer.byteLength(text, "utf8") + 40;
    if (out.questions.length >= MAX_INSIGHT_QUESTIONS || bytes + size > MAX_INSIGHT_DATA_BYTES) {
      full = true;
      continue;
    }
    bytes += size;
    out.questions.push({ text, answered });
  }
  return out;
}

// ---- what comes back -----------------------------------------------------------
export type InsightResult = {
  topics: { title: string; count: number }[];
  unanswered: { question: string; count: number; note: string }[];
  ideas: { kind: "docs" | "feature"; title: string; detail: string }[];
};
const LIMITS = { topics: 12, unanswered: 25, ideas: 12 };

// The model's answer → a clean result, or null when it is no usable JSON
// object. Every string passes the answer sanitiser (no HTML, links only to
// the allow-list, mentions defused) and the log's scrubber, on one line and
// bounded; counts are whole numbers between 0 and the number of questions;
// lists are bounded; unknown fields are dropped.
export function parseInsights(text: string, maxCount: number): InsightResult | null {
  let s = (text || "").slice(0, 200_000).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
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
  if (!Array.isArray(o.topics) && !Array.isArray(o.unanswered) && !Array.isArray(o.ideas)) return null;
  const list = (x: unknown, max: number) =>
    (Array.isArray(x) ? x : []).filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e)).slice(0, max);
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(0, maxCount), Math.max(0, Math.round(n))) : 0);
  const txt = (t: unknown, max: number) => scrub(sanitizeInsightText(t, max)).slice(0, max + 20);
  return {
    topics: list(o.topics, LIMITS.topics)
      .map((e) => ({ title: txt(e.title, 80), count: count(e.count) }))
      .filter((e) => e.title),
    unanswered: list(o.unanswered, LIMITS.unanswered)
      .map((e) => ({ question: txt(e.question, 240), count: Math.max(1, count(e.count)), note: txt(e.note, 300) }))
      .filter((e) => e.question),
    ideas: list(o.ideas, LIMITS.ideas)
      .map((e) => ({ kind: e.kind === "feature" ? ("feature" as const) : ("docs" as const), title: txt(e.title, 120), detail: txt(e.detail, 400) }))
      .filter((e) => e.title),
  };
}

// ---- the prompt for the maintainer ------------------------------------------------
type PromptInput = { interval: "daily" | "weekly"; kind: "scheduled" | "manual"; label: string; questions: number; unanswered: number; result: InsightResult };
export function maintainerPrompt(e: PromptInput) {
  const when =
    e.kind === "manual" ? (e.interval === "daily" ? "in the last 24 hours" : "in the last 7 days") : e.interval === "daily" ? `on ${e.label}` : `this week (${e.label})`;
  const lines = [
    `Here are the open questions from Flo users ${when} (Flo is the docs assistant of Flowplan; it answers only from docs.flowplan.org). ${e.questions} questions were asked, ${e.unanswered} of them Flo could not answer from the docs.`,
    "",
  ];
  lines.push("Open questions (Flo found nothing in the docs):");
  if (e.result.unanswered.length)
    e.result.unanswered.forEach((q, i) => lines.push(`${i + 1}. "${q.question}"${q.count > 1 ? ` (×${q.count})` : ""}${q.note ? ` – ${q.note}` : ""}`));
  else lines.push("- none");
  lines.push("", "Main topics:");
  if (e.result.topics.length) for (const t of e.result.topics) lines.push(`- ${t.title} (${t.count})`);
  else lines.push("- none");
  if (e.result.ideas.length) {
    lines.push("", "Candidate docs pages and features (suggested by the summary, unchecked):");
    for (const i of e.result.ideas) lines.push(`- [${i.kind}] ${i.title}${i.detail ? ` – ${i.detail}` : ""}`);
  }
  lines.push(
    "",
    "Please check the docs (flowplan-docs) and Flowplan itself for these gaps: for each open question, find out whether the docs really miss it (or only word it so it isn't found), whether a feature is missing, or whether it is out of scope. Then propose GitHub issues – one per gap, with a title, a short description, whether it is a docs or a feature issue, and which questions it answers – and leave out what an existing issue already covers. Don't change anything yet; list your findings and the proposed issues first.",
  );
  return lines.join("\n");
}

// ---- running a summary ------------------------------------------------------------
const holder = globalThis as unknown as { askInsightsRunning?: boolean };
export const insightsRunning = () => !!holder.askInsightsRunning || !!one("SELECT id FROM insights WHERE status='pending'");

type RunResult = { id: number } | { skipped: string };

// A manual run throws HttpError/LimitError (the admin API answers with
// them); a scheduled one returns { skipped } instead where there is nothing to do.
export async function runInsights(opts: { kind: "scheduled" | "manual"; actor?: string; at?: number }): Promise<RunResult> {
  const at = opts.at ?? now();
  const manual = opts.kind === "manual";
  const skip = (status: number, code: string, message: string): RunResult => {
    if (manual) throw new HttpError(status, code, message);
    return { skipped: code };
  };
  const settings = getSettings();
  if (!settings.logging.enabled) return skip(409, "log_off", "Insights need the Q&A log – switch on logging.enabled in the settings.");
  if (!manual && settings.insights.interval === "off") return { skipped: "off" };
  if (!config.anthropicConfigured()) return skip(503, "off", "No ANTHROPIC_API_KEY is configured.");
  if (holder.askInsightsRunning) return skip(409, "busy", "A summary is being generated right now.");
  const w = manual ? manualWindow(settings.insights.interval, at) : scheduledWindow(settings.insights.interval as "daily" | "weekly", at);
  if (w.period && (one("SELECT id FROM insights WHERE period=?", w.period) || failures(w.period) >= INSIGHT_RETRIES)) return { skipped: "done" };

  holder.askInsightsRunning = true;
  try {
    const data = collectQuestions(w.fromAt, w.toAt);
    const model = settings.insights.model;
    const base = {
      settings,
      model,
      kind: opts.kind,
      interval: w.interval,
      period: w.period,
      fromAt: w.fromAt,
      toAt: w.toAt,
      counts: { questions: data.total, sent: data.questions.length, unanswered: data.unanswered, refused: data.refused },
      actor: opts.actor,
      at,
    };
    const user = data.questions.length ? insightsUserTurn({ period: w.label, total: data.total, questions: data.questions }) : "";
    // Nothing asked: an 'empty' summary, no call, nothing spent.
    const reserved = reserveInsight({ ...base, ceilingNano: user ? ceilingNano(model, insightsPromptBytes(user), INSIGHTS_MAX_TOKENS) : 0 });
    if ("skipped" in reserved) return reserved.skipped === "busy" ? skip(409, "busy", "A summary is being generated right now.") : { skipped: reserved.skipped };
    if (!user) return reserved;

    const started = performance.now();
    let reply;
    try {
      reply = await summarizeClaude({ model, maxTokens: INSIGHTS_MAX_TOKENS, user });
    } catch (error) {
      // As for a question: a timeout or a dropped connection may have been billed.
      const maybeBilled = !(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIConnectionError;
      settleInsight(reserved.id, {
        status: "error",
        error: "upstream",
        costNano: maybeBilled ? insightReservedNano(reserved.id) : 0,
        latencyMs: Math.round(performance.now() - started),
      });
      console.error("anthropic (insights):", describeError(error));
      if (manual) throw new HttpError(502, "upstream", "The summary could not be generated right now – please try again later.");
      return reserved;
    }
    const usage = reply.usage;
    const outcome = {
      costNano: costNano(model, usage),
      inputTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      outputTokens: usage.output_tokens,
      latencyMs: Math.round(performance.now() - started),
    };
    const parsed = reply.stopReason === "refusal" ? null : parseInsights(reply.text, data.total);
    if (parsed) settleInsight(reserved.id, { status: "ok", result: JSON.stringify(parsed), ...outcome });
    else settleInsight(reserved.id, { status: "error", error: reply.stopReason === "max_tokens" ? "max_tokens" : reply.stopReason === "refusal" ? "refusal" : "invalid_answer", ...outcome });
    return reserved;
  } finally {
    holder.askInsightsRunning = false;
  }
}

// The timer's job (instrumentation.ts): a due scheduled summary, never throwing.
export async function insightsTick(at = now()) {
  try {
    return await runInsights({ kind: "scheduled", at });
  } catch (error) {
    const what = error instanceof LimitError ? `limit ${error.scope}` : error instanceof HttpError ? error.code : error instanceof Error ? error.name : "unknown";
    console.error("insights failed:", what);
    return { skipped: "failed" };
  }
}

// ---- reading (admin API) -------------------------------------------------------------
type Row = {
  id: number;
  created_at: number;
  kind: "scheduled" | "manual";
  interval: "daily" | "weekly";
  period_key: string;
  from_at: number;
  to_at: number;
  status: "pending" | "ok" | "empty" | "error";
  error: string;
  model: string;
  questions: number;
  sent: number;
  unanswered: number;
  refused: number;
  result: string;
  actor: string;
  reserved_nano: number;
  cost_nano: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number | null;
};
const iso = (ms: number) => new Date(ms).toISOString();
function resultOf(r: Row): InsightResult | null {
  if (r.status !== "ok" || !r.result) return null;
  try {
    return JSON.parse(r.result) as InsightResult;
  } catch {
    return null;
  }
}
function labelOf(r: Row) {
  if (r.kind === "scheduled" && r.interval === "daily") return dayKey(r.from_at);
  return `${dayKey(r.from_at)} – ${dayKey(Math.max(r.from_at, r.to_at - 1))}`;
}
function head(r: Row) {
  return {
    id: r.id,
    createdAt: iso(r.created_at),
    kind: r.kind,
    interval: r.interval,
    period: r.period_key || null,
    label: labelOf(r),
    from: iso(r.from_at),
    to: iso(r.to_at),
    status: r.status,
    error: r.error || null,
    model: r.model || null,
    questions: r.questions,
    sent: r.sent,
    unanswered: r.unanswered,
    refused: r.refused,
    costUsd: usd(r.status === "pending" ? r.reserved_nano : r.cost_nano),
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    latencyMs: r.latency_ms,
  };
}

// GET /api/admin/insights?limit= – newest first, without the full content.
export function listInsights(params: URLSearchParams, at = now()) {
  const settings = getSettings();
  const l = params.get("limit");
  const max = l && /^\d{1,3}$/.test(l) ? Math.min(100, Math.max(1, Number(l))) : 30;
  const rows = settings.logging.enabled ? all<Row>("SELECT * FROM insights WHERE purged=0 ORDER BY created_at DESC, id DESC LIMIT ?", max) : [];
  return {
    enabled: settings.logging.enabled,
    interval: settings.insights.interval,
    model: settings.insights.model,
    retentionDays: settings.logging.retentionDays,
    maxQuestions: MAX_INSIGHT_QUESTIONS,
    running: insightsRunning(),
    nextRunAt: nextRunAt(settings, at) === null ? null : iso(nextRunAt(settings, at)!),
    entries: rows.map((r) => {
      const result = resultOf(r);
      return {
        ...head(r),
        topTopics: result ? result.topics.slice(0, 3).map((t) => t.title) : [],
        ideas: result?.ideas.length ?? 0,
      };
    }),
  };
}

// GET /api/admin/insights?id= – one summary with its content and the prompt.
export function readInsight(id: number) {
  const r = getSettings().logging.enabled ? one<Row>("SELECT * FROM insights WHERE id=? AND purged=0", id) : undefined;
  if (!r) throw new HttpError(404, "not_found", "No such summary.");
  const result = resultOf(r);
  return {
    ...head(r),
    result,
    prompt: result ? maintainerPrompt({ interval: r.interval, kind: r.kind, label: labelOf(r), questions: r.questions, unanswered: r.unanswered, result }) : null,
  };
}

// The summaries' content follows the log (they quote its questions): cleared
// after the log's retention, and all of it when logging is turned off. The
// rows stay (without content) for the budget and the statistics.
export function purgeInsights(settings: Settings, at = now()) {
  if (!settings.logging.enabled) return run("UPDATE insights SET result='', purged=1 WHERE purged=0").changes;
  return run("UPDATE insights SET result='', purged=1 WHERE purged=0 AND created_at<?", at - settings.logging.retentionDays * DAY).changes;
}
