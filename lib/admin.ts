// The admin API for flowplan-admin (README "Admin API"): Bearer
// ASK_ADMIN_TOKEN, compared in constant time; without a token configured
// every path answers 404. JSON (and one CSV), no CORS headers – server to
// server only, the token never reaches a browser. Nothing personal in any
// answer: subjects only as short hashes, the log anonymised.
import { all, one } from "./db";
import { HttpError, bearer, clientIp, json, readJson } from "./http";
import { config } from "./config";
import { safeEqual } from "./secret";
import { LIMITS, ipKey, limit } from "./rate-limit";
import { getSettings, saveSettings } from "./settings";
import { serviceState } from "./status";
import { usd } from "./models";
import { DAY, dayKey, monthKey, now } from "./clock";
import { block, listBlocked, unblock } from "./subjects";
import { topics } from "./topics";
import { purgeLog, readLog } from "./qalog";
import { listInsights, markInsightHandled, purgeInsights, readInsight, runInsights } from "./insights";
import { MAX_HANDLED_TOPICS, addHandledTopic, editHandledTopic, listHandledTopics, removeHandledTopic } from "./handled-topics";
import { insightsNano } from "./limits";
import type { Source } from "./limits";

export function requireAdmin(request: Request) {
  const token = config.adminToken();
  if (!token) throw new HttpError(404, "not_found", "Not found.");
  const sent = bearer(request);
  if (!sent || !safeEqual(sent, token)) {
    limit(`admin-fail:${ipKey(clientIp(request))}`, LIMITS.tokenFailures);
    throw new HttpError(401, "unauthorized", "Bearer token missing or wrong.");
  }
}

const SPENT = "COALESCE(SUM(CASE WHEN status='pending' THEN reserved_nano ELSE cost_nano END),0)";
type Agg = { questions: number; input: number; output: number; cache_read: number; nano: number; errors: number };
const AGG = `COUNT(*) AS questions, COALESCE(SUM(input_tokens+cache_read_tokens+cache_write_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
             COALESCE(SUM(cache_read_tokens),0) AS cache_read, ${SPENT} AS nano, COALESCE(SUM(status='error'),0) AS errors`;
const agg = (where: string, ...args: string[]) => one<Agg>(`SELECT ${AGG} FROM questions WHERE ${where}`, ...args)!;
const totals = (a: Agg) => ({ questions: a.questions, inputTokens: a.input, outputTokens: a.output, costUsd: usd(a.nano) });

// Nearest-rank percentile.
function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const latencies = (where: string, ...args: string[]) =>
  all<{ ms: number }>(`SELECT latency_ms AS ms FROM questions WHERE ${where} AND status<>'error' AND latency_ms IS NOT NULL ORDER BY latency_ms`, ...args).map((r) => r.ms);

// GET /api/admin/summary
export function adminSummary(at = now()) {
  const settings = getSettings();
  const state = serviceState(settings, at);
  const month = monthKey(at);
  const m = agg("month=?", month);
  // The insight summaries count against the budget too (not as questions).
  const insightsMonth = insightsNano("month", month);
  const budgetUsd = settings.monthlyBudgetUsd;
  const rejected = { subject: 0, global: 0, budget: 0, off: 0 };
  for (const r of all<{ scope: keyof typeof rejected; n: number }>("SELECT scope, SUM(count) AS n FROM rejections WHERE substr(day,1,7)=? GROUP BY scope", month))
    rejected[r.scope] = r.n;
  const ms = latencies("month=?", month);
  return {
    status: { docs: state.docs, discord: state.discord, budgetReached: state.budgetReached, warn: state.warn },
    month: {
      ...totals(m),
      costUsd: usd(m.nano + insightsMonth),
      insightsCostUsd: usd(insightsMonth),
      budgetUsd,
      percent: budgetUsd > 0 ? Math.round((usd(m.nano + insightsMonth) / budgetUsd) * 1000) / 10 : 100,
    },
    today: totals(agg("day=?", dayKey(at))),
    bySource: {
      docs: totals(agg("month=? AND source='docs'", month)),
      discord: totals(agg("month=? AND source='discord'", month)),
    },
    rejected,
    errors: { count: m.errors, rate: m.questions ? Math.round((m.errors / m.questions) * 1000) / 1000 : 0 },
    latencyMs: { p50: percentile(ms, 50), p95: percentile(ms, 95) },
  };
}

// from/to (YYYY-MM-DD, inclusive; an ISO time counts by its UTC date):
// default the last 30 days, at most 400.
export function dateRange(params: URLSearchParams, at = now()) {
  const day = (v: string | null, name: string) => {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v) || !Number.isFinite(Date.parse(v.slice(0, 10)))) throw new HttpError(400, "invalid_date", `${name} must be a date (YYYY-MM-DD).`);
    return v.slice(0, 10);
  };
  const to = day(params.get("to"), "to") ?? dayKey(at);
  const from = day(params.get("from"), "from") ?? dayKey(Date.parse(to) - 29 * DAY);
  if (from > to) throw new HttpError(400, "invalid_range", "from must not be after to.");
  if (Date.parse(to) - Date.parse(from) > 400 * DAY) throw new HttpError(400, "invalid_range", "At most 400 days.");
  return { from, to, fromMs: Date.parse(from), toMs: Date.parse(to) + DAY };
}

type Day = {
  date: string;
  source: Source;
  questions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  rejected: number;
  errors: number;
  p50: number | null;
  p95: number | null;
};
// Per day and source, oldest first; days with only rejections included.
export function usageDays(from: string, to: string): Day[] {
  const rows = all<Agg & { day: string; source: Source }>(`SELECT day, source, ${AGG} FROM questions WHERE day>=? AND day<=? GROUP BY day, source`, from, to);
  const rej = all<{ day: string; source: Source; n: number }>("SELECT day, source, SUM(count) AS n FROM rejections WHERE day>=? AND day<=? GROUP BY day, source", from, to);
  const lat = all<{ day: string; source: Source; ms: number }>(
    "SELECT day, source, latency_ms AS ms FROM questions WHERE day>=? AND day<=? AND status<>'error' AND latency_ms IS NOT NULL ORDER BY latency_ms",
    from,
    to,
  );
  const map = new Map<string, Day>();
  const get = (date: string, source: Source) => {
    const k = `${date}|${source}`;
    let d = map.get(k);
    if (!d) {
      d = { date, source, questions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, rejected: 0, errors: 0, p50: null, p95: null };
      map.set(k, d);
    }
    return d;
  };
  for (const r of rows) Object.assign(get(r.day, r.source), { questions: r.questions, inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cache_read, costUsd: usd(r.nano), errors: r.errors });
  for (const r of rej) get(r.day, r.source).rejected = r.n;
  const byKey = new Map<string, number[]>();
  for (const r of lat) {
    const k = `${r.day}|${r.source}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r.ms);
  }
  for (const [k, list] of byKey) {
    const d = map.get(k);
    if (d) Object.assign(d, { p50: percentile(list, 50), p95: percentile(list, 95) });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));
}

const CSV_FIELDS = ["date", "source", "questions", "inputTokens", "outputTokens", "cacheReadTokens", "costUsd", "rejected", "errors", "p50", "p95"] as const;
// Cells starting with = + - @ (or a tab/CR) get a leading ' so a spreadsheet never runs them.
const csvCell = (value: unknown) => {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function adminRoute(request: Request, name: string) {
  requireAdmin(request);
  const params = new URL(request.url).searchParams;
  const method = request.method;
  const only = (...allowed: string[]) => {
    if (!allowed.includes(method)) throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  };
  switch (name) {
    case "settings": {
      only("GET", "PUT");
      if (method === "GET") return json(getSettings());
      const body = await readJson(request, 32 * 1024);
      const actor = typeof body.actor === "string" ? body.actor.trim().slice(0, 100) : "";
      const saved = saveSettings(body.settings, actor);
      purgeLog(saved);
      purgeInsights(saved);
      return json(saved);
    }
    case "summary":
      only("GET");
      return json(adminSummary());
    case "usage": {
      only("GET");
      const g = params.get("granularity") || "day";
      if (g !== "day") throw new HttpError(400, "invalid_granularity", "granularity must be day.");
      const r = dateRange(params);
      return json({ days: usageDays(r.from, r.to) });
    }
    case "topics": {
      only("GET");
      const r = dateRange(params);
      return json({ from: r.from, to: r.to, ...topics(r.from, r.to) });
    }
    case "blocklist": {
      only("GET", "POST", "DELETE");
      if (method === "GET") return json({ entries: listBlocked() });
      if (method === "POST") return json({ entries: block(await readJson(request, 4096)) });
      const body = (request.headers.get("content-type") || "").includes("json") ? await readJson(request, 4096, true) : {};
      return json({ entries: unblock(params.get("subject") ?? body.subject) });
    }
    case "log": {
      only("GET");
      const r = dateRange(params);
      return json(readLog(getSettings(), params, { from: r.fromMs, to: r.toMs }));
    }
    case "insights": {
      only("GET", "POST");
      if (method === "GET") {
        const id = params.get("id");
        if (id === null) return json(listInsights(params));
        if (!/^\d{1,12}$/.test(id)) throw new HttpError(400, "invalid_id", "id must be a number.");
        return json({ entry: readInsight(Number(id)) });
      }
      // "Generate now": synchronous, one at a time (409 busy), only with the log on (409 log_off).
      const body = await readJson(request, 4096, true);
      const actor = typeof body.actor === "string" ? body.actor.trim().slice(0, 100) : "";
      const r = await runInsights({ kind: "manual", actor });
      if (!("id" in r)) throw new HttpError(409, "busy", "A summary is being generated right now.");
      return json({ entry: readInsight(r.id) });
    }
    case "insight-handled": {
      // Mark a summary as worked through: "Generate now" starts at its end.
      only("POST");
      return json({ entry: markInsightHandled(await readJson(request, 4096)) });
    }
    case "handled-topics": {
      only("GET", "POST", "PUT", "DELETE");
      if (method === "GET") return json({ topics: listHandledTopics(), max: MAX_HANDLED_TOPICS });
      if (method === "POST") return json(addHandledTopic(await readJson(request, 4096)));
      if (method === "PUT") return json(editHandledTopic(await readJson(request, 4096)));
      const body = (request.headers.get("content-type") || "").includes("json") ? await readJson(request, 4096, true) : {};
      return json(removeHandledTopic(params.get("id") ?? body.id));
    }
    case "export": {
      only("GET");
      const format = params.get("format") || "csv";
      if (format !== "csv") throw new HttpError(400, "invalid_format", "format must be csv.");
      const r = dateRange(params);
      const days = usageDays(r.from, r.to);
      const csv = [CSV_FIELDS.join(","), ...days.map((d) => CSV_FIELDS.map((f) => csvCell(d[f])).join(","))].join("\r\n") + "\r\n";
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="flowplan-ask-usage-${r.from}-${r.to}.csv"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    default:
      throw new HttpError(404, "not_found", "Not found.");
  }
}
