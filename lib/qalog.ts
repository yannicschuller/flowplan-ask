// The optional question/answer log (off by default, README "Privacy"):
// anonymised – no subject, no session, no ids, no address – and with
// e-mail addresses, numbers, addresses and secrets in the text masked. The
// retention comes from the settings; turning logging off deletes it all.
import { all, run } from "./db";
import { DAY, now } from "./clock";
import { HttpError } from "./http";
import type { Settings } from "./settings";
import { usd } from "./models";
import type { Source } from "./limits";
import type { Locale } from "./docs";

export function scrub(text: string) {
  return text
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "[secret]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[address]")
    .replace(/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, "[address]")
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, "[secret]")
    .replace(/(?<![\w.])\+?\d[\d \-/]{6,}\d\b/g, "[number]");
}

export type LogEntry = {
  source: Source;
  locale: Locale;
  question: string;
  answer: string;
  sources: { title: string; url: string }[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costNano: number;
  latencyMs: number;
  outcome: "ok" | "refusal" | "max_tokens";
};
export function logAnswer(settings: Settings, entry: LogEntry, at = now()) {
  if (!settings.logging.enabled) return;
  run(
    "INSERT INTO qa_log(at,source,locale,question,answer,sources,model,input_tokens,output_tokens,cost_nano,latency_ms,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    at,
    entry.source,
    entry.locale,
    scrub(entry.question).slice(0, 4000),
    scrub(entry.answer).slice(0, 8000),
    JSON.stringify(entry.sources.slice(0, 10)),
    entry.model,
    entry.inputTokens,
    entry.outputTokens,
    Math.round(entry.costNano),
    entry.latencyMs,
    entry.outcome,
  );
}

// Retention (and everything when logging is off).
export function purgeLog(settings: Settings, at = now()) {
  if (!settings.logging.enabled) return run("DELETE FROM qa_log").changes;
  return run("DELETE FROM qa_log WHERE at<?", at - settings.logging.retentionDays * DAY).changes;
}

// GET /api/admin/log?from=&to=&limit=&cursor= – newest first. With
// logging off: { enabled: false, entries: [] } (and nothing is kept).
export function readLog(settings: Settings, params: URLSearchParams, range: { from: number; to: number }) {
  const head = { enabled: settings.logging.enabled, retentionDays: settings.logging.retentionDays };
  if (!settings.logging.enabled) return { ...head, entries: [], nextCursor: null };
  const limitParam = params.get("limit");
  const max = limitParam && /^\d{1,4}$/.test(limitParam) ? Math.min(500, Math.max(1, Number(limitParam))) : 100;
  const cursor = params.get("cursor");
  const c = cursor ? /^(\d{1,15})\.(\d{1,15})$/.exec(cursor) : null;
  if (cursor && !c) throw new HttpError(400, "invalid_cursor", "Invalid cursor.");
  type Row = {
    id: number;
    at: number;
    source: Source;
    locale: Locale;
    question: string;
    answer: string;
    sources: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_nano: number;
    latency_ms: number | null;
    outcome: string;
  };
  const rows = all<Row>(
    `SELECT * FROM qa_log WHERE at>=? AND at<?${c ? " AND (at<? OR (at=? AND id<?))" : ""} ORDER BY at DESC, id DESC LIMIT ?`,
    range.from,
    range.to,
    ...(c ? [Number(c[1]), Number(c[1]), Number(c[2])] : []),
    max + 1,
  );
  const page = rows.slice(0, max);
  const lastRow = page[page.length - 1];
  return {
    ...head,
    entries: page.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      source: r.source,
      locale: r.locale,
      question: r.question,
      answer: r.answer,
      sources: JSON.parse(r.sources) as { title: string; url: string }[],
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: usd(r.cost_nano),
      latencyMs: r.latency_ms,
      outcome: r.outcome,
    })),
    nextCursor: rows.length > max && lastRow ? `${lastRow.at}.${lastRow.id}` : null,
  };
}
