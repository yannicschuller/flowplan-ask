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
const monthTotals = (at: number) => totals("month=?", monthKey(at));
const dayTotals = (at: number) => totals("day=?", dayKey(at));

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
  const subjectDay = totals("subject=? AND day=?", subject, dayKey(at));
  if (s.perDay > 0 && subjectDay.questions >= s.perDay) return { scope: "subject", retryAt: nextDay(at) };
  if (s.costPerDayUsd > 0 && subjectDay.nano + cost > nano(s.costPerDayUsd)) return { scope: "subject", retryAt: nextDay(at) };
  const subjectMonth = totals("subject=? AND month=?", subject, monthKey(at));
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
  return stale.length;
}

export const RETENTION = { subjectDays: 40, statsDays: 400 };
// Subjects and hashed addresses are kept only as long as the monthly limits need them.
export function purgeLedger(at = now()) {
  run("UPDATE questions SET subject='', ip_key='' WHERE at<? AND (subject<>'' OR ip_key<>'')", at - RETENTION.subjectDays * DAY);
  const before = dayKey(at - RETENTION.statsDays * DAY);
  run("DELETE FROM questions WHERE day<?", before);
  run("DELETE FROM rejections WHERE day<?", before);
  run("DELETE FROM topic_pages WHERE day<?", before);
  run("DELETE FROM topic_terms WHERE day<?", before);
}
