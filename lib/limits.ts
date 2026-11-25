// Who may ask how much: per subject (a Discord user or a docs session), per
// hashed address (docs, as a fallback), globally, and the hard monthly
// budget. flowplan-ask is the only counter.
//
// Atomic: checking every limit and recording the question happen in one
// BEGIN IMMEDIATE transaction, and the question's maximum possible cost
// (lib/models.ts ceilingNano) is reserved before the model is called. Once
// the answer is in, the reservation is replaced by the real cost from the
// usage. So parallel requests can never spend more than the budget: each
// one is counted with its worst case while it runs.
import { all, one, run, transaction } from "./db";
import { DAY, HOUR, MINUTE, dayKey, monthKey, nextDay, nextMonth, now, startOfDay } from "./clock";
import { LimitError, type LimitScope } from "./rate-limit";
import { nano, type ModelId } from "./models";
import type { Settings } from "./settings";

export type Source = "docs" | "discord";
export const isSource = (v: unknown): v is Source => v === "docs" || v === "discord";

// The hashed address shares the per-subject limits with this factor (an
// office or a mobile network may share one address); minute, hour and day
// only, as the hash changes every day.
export const IP_FACTOR = 3;

type Totals = { questions: number; nano: number };
const SPENT = "COALESCE(SUM(CASE WHEN status='pending' THEN reserved_nano ELSE cost_nano END),0)";

function totals(where: string, ...args: (string | number)[]): Totals {
  const row = one<{ questions: number; nano: number }>(`SELECT COUNT(*) AS questions, ${SPENT} AS nano FROM questions WHERE ${where}`, ...args);
  return { questions: row?.questions ?? 0, nano: row?.nano ?? 0 };
}
// What the insight summaries spent (their own calls, lib/insights.ts): part
// of the global cost and the budget, never of anyone's question counts.
export function insightsNano(column: "month" | "day", key: string) {
  return one<{ nano: number }>(`SELECT ${SPENT} AS nano FROM insights WHERE ${column}=?`, key)?.nano ?? 0;
}
// What the report drafts spent (their own calls, lib/draft.ts): part of the
// global cost and the budget – and of the drafting person's cost – never of
// anyone's question counts.
export function draftsNano(column: "month" | "day", key: string, subject?: string) {
  const who = subject === undefined ? "" : " AND subject=?";
  const args = subject === undefined ? [key] : [key, subject];
  return one<{ nano: number }>(`SELECT ${SPENT} AS nano FROM drafts WHERE ${column}=?${who}`, ...args)?.nano ?? 0;
}
const withInsights = (t: Totals, column: "month" | "day", key: string): Totals => ({
  questions: t.questions,
  nano: t.nano + insightsNano(column, key) + draftsNano(column, key),
});
const monthTotals = (at: number) => withInsights(totals("month=?", monthKey(at)), "month", monthKey(at));
const dayTotals = (at: number) => withInsights(totals("day=?", dayKey(at)), "day", dayKey(at));

const withDrafts = (t: Totals, column: "month" | "day", key: string, subject: string): Totals => ({
  questions: t.questions,
  nano: t.nano + draftsNano(column, key, subject),
});

// When a sliding window has room again: the oldest question in it leaves.
function windowRetry(column: "subject" | "ip_key", key: string, since: number, windowMs: number) {
  const row = one<{ at: number }>(`SELECT MIN(at) AS at FROM questions WHERE ${column}=? AND at>=?`, key, since);
  return (row?.at ?? since) + windowMs;
}

// The first limit a question of `cost` would break, or null.
function firstBreach(settings: Settings, source: Source, subject: string, ip: string, cost: number, at: number): { scope: LimitScope; retryAt: number } | null {
  const month = monthTotals(at);
  const budget = nano(settings.monthlyBudgetUsd);
  if (budget <= 0 || month.nano + cost > budget) return { scope: "budget", retryAt: nextMonth(at) };

  const g = settings.limits.global;
  const day = dayTotals(at);
  if (g.perMonth > 0 && month.questions >= g.perMonth) return { scope: "global", retryAt: nextMonth(at) };
  if (g.costPerMonthUsd > 0 && month.nano + cost > nano(g.costPerMonthUsd)) return { scope: "global", retryAt: nextMonth(at) };
  if (g.perDay > 0 && day.questions >= g.perDay) return { scope: "global", retryAt: nextDay(at) };
  if (g.costPerDayUsd > 0 && day.nano + cost > nano(g.costPerDayUsd)) return { scope: "global", retryAt: nextDay(at) };

  const s = settings.limits.subject;
  const windows: [number, number][] = [
    [s.perMinute, MINUTE],
    [s.perHour, HOUR],
  ];
  for (const [max, ms] of windows) {
    if (max > 0 && totals("subject=? AND at>?", subject, at - ms).questions >= max) return { scope: "subject", retryAt: windowRetry("subject", subject, at - ms + 1, ms) };
  }
  const subjectDay = withDrafts(totals("subject=? AND day=?", subject, dayKey(at)), "day", dayKey(at), subject);
  if (s.perDay > 0 && subjectDay.questions >= s.perDay) return { scope: "subject", retryAt: nextDay(at) };
  if (s.costPerDayUsd > 0 && subjectDay.nano + cost > nano(s.costPerDayUsd)) return { scope: "subject", retryAt: nextDay(at) };
  const subjectMonth = withDrafts(totals("subject=? AND month=?", subject, monthKey(at)), "month", monthKey(at), subject);
  if (s.perMonth > 0 && subjectMonth.questions >= s.perMonth) return { scope: "subject", retryAt: nextMonth(at) };
  if (s.costPerMonthUsd > 0 && subjectMonth.nano + cost > nano(s.costPerMonthUsd)) return { scope: "subject", retryAt: nextMonth(at) };

  if (ip) {
    for (const [max, ms] of windows) {
      if (max > 0 && totals("ip_key=? AND at>?", ip, at - ms).questions >= max * IP_FACTOR) return { scope: "subject", retryAt: windowRetry("ip_key", ip, at - ms + 1, ms) };
    }
    if (s.perDay > 0 && totals("ip_key=? AND at>=?", ip, startOfDay(at)).questions >= s.perDay * IP_FACTOR) return { scope: "subject", retryAt: nextDay(at) };
  }
  return null;
}

export function recordRejection(source: Source, scope: LimitScope | "off", at = now()) {
  run(
    "INSERT INTO rejections(day,source,scope,count) VALUES(?,?,?,1) ON CONFLICT(day,source,scope) DO UPDATE SET count=count+1",
    dayKey(at),
    source,
    scope,
  );
}

// Checks every limit and records the question with its reserved cost, or
// throws LimitError (and counts the rejection).
export function reserve(input: { settings: Settings; source: Source; subject: string; ip: string; model: ModelId; ceilingNano: number; at?: number }): number {
  const at = input.at ?? now();
  const result = transaction(() => {
    const breach = firstBreach(input.settings, input.source, input.subject, input.ip, input.ceilingNano, at);
    if (breach) {
      recordRejection(input.source, breach.scope, at);
      return breach;
    }
    const r = run(
      "INSERT INTO questions(at,day,month,source,subject,ip_key,status,model,reserved_nano,ceiling_nano) VALUES(?,?,?,?,?,?,'pending',?,?,?)",
      at,
      dayKey(at),
      monthKey(at),
      input.source,
      input.subject,
      input.ip,
      input.model,
      input.ceilingNano,
      input.ceilingNano,
    );
    return Number(r.lastInsertRowid);
  });
  if (typeof result === "number") return result;
  throw new LimitError(result.scope, result.retryAt);
}

export type Outcome = {
  status: "ok" | "refusal" | "max_tokens" | "error";
  costNano: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs?: number;
};
// Replaces the reservation by what the answer really cost.
export function settle(id: number, o: Outcome, at = now()) {
  run(
    `UPDATE questions SET status=?, cost_nano=?, reserved_nano=0, input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=?, latency_ms=?, settled_at=?
     WHERE id=? AND status='pending'`,
    o.status,
    Math.max(0, Math.round(o.costNano)),
    o.inputTokens ?? 0,
    o.outputTokens ?? 0,
    o.cacheReadTokens ?? 0,
    o.cacheWriteTokens ?? 0,
    o.latencyMs ?? null,
    at,
    id,
  );
}

// Questions left today for a subject (null without a daily limit).
export function remainingToday(settings: Settings, subject: string, at = now()) {
  const max = settings.limits.subject.perDay;
  if (max <= 0) return null;
  return Math.max(0, max - totals("subject=? AND day=?", subject, dayKey(at)).questions);
}

// The reserved maximum of a typical question: the largest of the last 20
// with the current model, else `fallback`.
export function typicalCeilingNano(model: ModelId, fallback: number) {
  const row = one<{ n: number | null }>("SELECT MAX(ceiling_nano) AS n FROM (SELECT ceiling_nano FROM questions WHERE model=? AND ceiling_nano>0 ORDER BY id DESC LIMIT 20)", model);
  return row?.n || fallback;
}

// Whether the global limits or the budget leave room for one more question
// of the given (typical) cost (GET /api/status, the admin summary).
export function globalState(settings: Settings, worstCaseNano: number, at = now()) {
  const month = monthTotals(at);
  const day = dayTotals(at);
  const budget = nano(settings.monthlyBudgetUsd);
  const budgetReached = budget <= 0 || month.nano + worstCaseNano > budget;
  const g = settings.limits.global;
  const globalReached =
    (g.perMonth > 0 && month.questions >= g.perMonth) ||
    (g.costPerMonthUsd > 0 && month.nano + worstCaseNano > nano(g.costPerMonthUsd)) ||
    (g.perDay > 0 && day.questions >= g.perDay) ||
    (g.costPerDayUsd > 0 && day.nano + worstCaseNano > nano(g.costPerDayUsd));
  const warn = budget <= 0 || month.nano >= (budget * settings.warnAtPercent) / 100;
  return { budgetReached, globalReached, warn, monthNano: month.nano, budgetNano: budget };
}

// A pending question whose request died with the process: settled as an
// error that keeps its reserved cost (it may have been billed).
// The worst case reserved for a pending question (0 once settled).
export function reservedNano(id: number) {
  return one<{ reserved_nano: number }>("SELECT reserved_nano FROM questions WHERE id=? AND status='pending'", id)?.reserved_nano ?? 0;
}

export function settleStale(at = now(), olderThanMs = 10 * MINUTE) {
  const stale = all<{ id: number; reserved_nano: number }>("SELECT id,reserved_nano FROM questions WHERE status='pending' AND at<?", at - olderThanMs);
  for (const q of stale) settle(q.id, { status: "error", costNano: q.reserved_nano }, at);
  const staleInsights = all<{ id: number; reserved_nano: number }>("SELECT id,reserved_nano FROM insights WHERE status='pending' AND created_at<?", at - olderThanMs);
  for (const q of staleInsights) settleInsight(q.id, { status: "error", error: "interrupted", costNano: q.reserved_nano }, at);
  const staleDrafts = all<{ id: number; reserved_nano: number }>("SELECT id,reserved_nano FROM drafts WHERE status='pending' AND at<?", at - olderThanMs);
  for (const q of staleDrafts) settleDraft(q.id, { status: "error", error: "interrupted", costNano: q.reserved_nano }, at);
  return stale.length + staleInsights.length + staleDrafts.length;
}

// ---- the insight summaries (lib/insights.ts) ------------------------------
// A summary is not a question: it has its own row in `insights` and its own
// reservation, but the same rule – its maximum possible cost is reserved in
// one BEGIN IMMEDIATE transaction with the checks (the monthly budget and
// the global cost limits, which it shares with the questions), and settled
// from the usage afterwards. The same transaction is the guard against
// parallel runs (one pending summary at a time, across processes) and makes
// a scheduled period run once (the unique period).

export type InsightReservation = {
  settings: Settings;
  model: ModelId;
  ceilingNano: number;
  kind: "scheduled" | "manual";
  interval: "daily" | "weekly";
  period: string | null;
  fromAt: number;
  toAt: number;
  counts: { questions: number; sent: number; unanswered: number; refused: number };
  actor?: string;
  at?: number;
};
export type InsightReserved = { id: number } | { skipped: "busy" | "done" };

// The first limit a summary of `cost` would break (the budget, the global cost), or null.
function insightBreach(settings: Settings, cost: number, at: number): { scope: LimitScope; retryAt: number } | null {
  const month = monthTotals(at);
  const budget = nano(settings.monthlyBudgetUsd);
  if (budget <= 0 || month.nano + cost > budget) return { scope: "budget", retryAt: nextMonth(at) };
  const g = settings.limits.global;
  if (g.costPerMonthUsd > 0 && month.nano + cost > nano(g.costPerMonthUsd)) return { scope: "global", retryAt: nextMonth(at) };
  if (g.costPerDayUsd > 0 && dayTotals(at).nano + cost > nano(g.costPerDayUsd)) return { scope: "global", retryAt: nextDay(at) };
  return null;
}

// Records a summary row: 'pending' with its reserved cost when ceilingNano
// > 0 (a model call follows), else directly 'empty' (nothing to summarise,
// nothing spent). Throws LimitError when the budget or a global cost limit
// leaves no room.
export function reserveInsight(input: InsightReservation): InsightReserved {
  const at = input.at ?? now();
  const result = transaction((): InsightReserved | { scope: LimitScope; retryAt: number } => {
    if (one("SELECT id FROM insights WHERE status='pending'")) return { skipped: "busy" };
    if (input.period && one("SELECT id FROM insights WHERE period=?", input.period)) return { skipped: "done" };
    const call = input.ceilingNano > 0;
    if (call) {
      const breach = insightBreach(input.settings, input.ceilingNano, at);
      if (breach) return breach;
    }
    const r = run(
      `INSERT INTO insights(created_at,day,month,kind,interval,period,period_key,from_at,to_at,status,model,questions,sent,unanswered,refused,actor,reserved_nano,ceiling_nano,settled_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      at,
      dayKey(at),
      monthKey(at),
      input.kind,
      input.interval,
      input.period,
      input.period ?? "",
      input.fromAt,
      input.toAt,
      call ? "pending" : "empty",
      call ? input.model : "",
      input.counts.questions,
      input.counts.sent,
      input.counts.unanswered,
      input.counts.refused,
      (input.actor ?? "").slice(0, 100),
      call ? input.ceilingNano : 0,
      call ? input.ceilingNano : 0,
      call ? null : at,
    );
    return { id: Number(r.lastInsertRowid) };
  });
  if ("scope" in result) throw new LimitError(result.scope, result.retryAt);
  return result;
}

export type InsightOutcome = {
  status: "ok" | "error";
  costNano: number;
  error?: string;
  result?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
};
// Replaces a summary's reservation by its real cost (and stores its result).
// A failed scheduled run gives its period free again, so a later tick can retry.
export function settleInsight(id: number, o: InsightOutcome, at = now()) {
  run(
    `UPDATE insights SET status=?, error=?, result=?, cost_nano=?, reserved_nano=0, input_tokens=?, output_tokens=?, latency_ms=?, settled_at=?,
       period=CASE WHEN ?='error' THEN NULL ELSE period END
     WHERE id=? AND status='pending'`,
    o.status,
    (o.error ?? "").slice(0, 40),
    o.status === "ok" ? (o.result ?? "") : "",
    Math.max(0, Math.round(o.costNano)),
    o.inputTokens ?? 0,
    o.outputTokens ?? 0,
    o.latencyMs ?? null,
    at,
    o.status,
    id,
  );
}

// The worst case reserved for a pending summary (0 once settled).
export const insightReservedNano = (id: number) =>
  one<{ reserved_nano: number }>("SELECT reserved_nano FROM insights WHERE id=? AND status='pending'", id)?.reserved_nano ?? 0;

// ---- the report drafts (lib/draft.ts) ---------------------------------------
// A draft is not a question either: its own row in `drafts`, its own
// reservation, the same rule. In one BEGIN IMMEDIATE transaction: the
// monthly budget and the global cost limits (shared with the questions and
// the insight summaries), the person's drafts per day
// (settings.reports.perDay) and the person's cost limits per day and month
// (shared with their questions); then the maximum cost is reserved.

export type DraftKind = "bug" | "feature";

// Drafts left today for a subject.
export function draftsLeftToday(settings: Settings, subject: string, at = now()) {
  const used = one<{ n: number }>("SELECT COUNT(*) AS n FROM drafts WHERE subject=? AND day=?", subject, dayKey(at))?.n ?? 0;
  return Math.max(0, settings.reports.perDay - used);
}

function draftBreach(settings: Settings, subject: string, cost: number, at: number): { scope: LimitScope; retryAt: number } | null {
  const shared = insightBreach(settings, cost, at);
  if (shared) return shared;
  if (draftsLeftToday(settings, subject, at) <= 0) return { scope: "subject", retryAt: nextDay(at) };
  const s = settings.limits.subject;
  const day = withDrafts(totals("subject=? AND day=?", subject, dayKey(at)), "day", dayKey(at), subject);
  if (s.costPerDayUsd > 0 && day.nano + cost > nano(s.costPerDayUsd)) return { scope: "subject", retryAt: nextDay(at) };
  const month = withDrafts(totals("subject=? AND month=?", subject, monthKey(at)), "month", monthKey(at), subject);
  if (s.costPerMonthUsd > 0 && month.nano + cost > nano(s.costPerMonthUsd)) return { scope: "subject", retryAt: nextMonth(at) };
  return null;
}

// Checks the limits and records the draft with its reserved cost, or throws LimitError.
export function reserveDraft(input: { settings: Settings; subject: string; kind: DraftKind; model: ModelId; ceilingNano: number; at?: number }): number {
  const at = input.at ?? now();
  const result = transaction(() => {
    const breach = draftBreach(input.settings, input.subject, input.ceilingNano, at);
    if (breach) return breach;
    const r = run(
      "INSERT INTO drafts(at,day,month,subject,kind,status,model,reserved_nano,ceiling_nano) VALUES(?,?,?,?,?,'pending',?,?,?)",
      at,
      dayKey(at),
      monthKey(at),
      input.subject,
      input.kind,
      input.model,
      input.ceilingNano,
      input.ceilingNano,
    );
    return Number(r.lastInsertRowid);
  });
  if (typeof result === "number") return result;
  throw new LimitError(result.scope, result.retryAt);
}

export type DraftOutcome = { status: "ok" | "error"; costNano: number; error?: string; inputTokens?: number; outputTokens?: number; latencyMs?: number };
// Replaces a draft's reservation by its real cost.
export function settleDraft(id: number, o: DraftOutcome, at = now()) {
  run(
    `UPDATE drafts SET status=?, error=?, cost_nano=?, reserved_nano=0, input_tokens=?, output_tokens=?, latency_ms=?, settled_at=?
     WHERE id=? AND status='pending'`,
    o.status,
    (o.error ?? "").slice(0, 40),
    Math.max(0, Math.round(o.costNano)),
    o.inputTokens ?? 0,
    o.outputTokens ?? 0,
    o.latencyMs ?? null,
    at,
    id,
  );
}

// The worst case reserved for a pending draft (0 once settled).
export const draftReservedNano = (id: number) =>
  one<{ reserved_nano: number }>("SELECT reserved_nano FROM drafts WHERE id=? AND status='pending'", id)?.reserved_nano ?? 0;

export const RETENTION = { subjectDays: 40, statsDays: 400 };
// Subjects and hashed addresses are kept only as long as the monthly limits need them.
export function purgeLedger(at = now()) {
  run("UPDATE questions SET subject='', ip_key='' WHERE at<? AND (subject<>'' OR ip_key<>'')", at - RETENTION.subjectDays * DAY);
  run("UPDATE drafts SET subject='' WHERE at<? AND subject<>''", at - RETENTION.subjectDays * DAY);
  const before = dayKey(at - RETENTION.statsDays * DAY);
  run("DELETE FROM questions WHERE day<?", before);
  run("DELETE FROM rejections WHERE day<?", before);
  run("DELETE FROM topic_pages WHERE day<?", before);
  run("DELETE FROM topic_terms WHERE day<?", before);
  run("DELETE FROM insights WHERE day<?", before);
  run("DELETE FROM drafts WHERE day<?", before);
}
