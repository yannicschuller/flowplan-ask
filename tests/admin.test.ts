import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, BOT_TOKEN, DOCS_ORIGIN, admin, body, call, callPublic, newSession, req, settings, setup } from "./helpers";
import { adminRoute, askRoute } from "../lib/routes";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { all, one, run } from "../lib/db";
import { clock } from "../lib/clock";
import { maintenance } from "../lib/maintenance";
import { recordRejection } from "../lib/limits";
import { excerptsOf } from "./anthropic-mock";

const { claude, docs } = await setup();
const T = Date.UTC(2026, 10, 18, 12, 0, 0);
let at = T;
clock.now = () => at;
const SUBJECT = "hmac-of-a-discord-user-for-admin-tests-01";

const get = (path: string, init: Parameters<typeof admin>[1] = {}) => {
  const name = /^\/api\/admin\/([a-z]+)/.exec(path)![1];
  return call(() => adminRoute(admin(path, init), name));
};
const ask = (subject = SUBJECT, question = "How do backups work?") => {
  const make = () => req("/api/ask", { json: { source: "discord", locale: "en", subject, question }, bot: BOT_TOKEN });
  return callPublic(make(), () => askRoute(make()));
};

beforeEach(() => {
  at = T;
  claude.reset();
  settings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  for (const t of ["questions", "rejections", "blocklist", "qa_log", "topic_pages", "topic_terms"]) run(`DELETE FROM ${t}`);
});

test("the admin API: 404 without a token (or a short one), 401 for a wrong one, rate-limited, no CORS", async () => {
  const saved = process.env.ASK_ADMIN_TOKEN;
  delete process.env.ASK_ADMIN_TOKEN;
  assert.equal((await get("/api/admin/summary")).status, 404);
  process.env.ASK_ADMIN_TOKEN = "short-token";
  assert.equal((await get("/api/admin/summary")).status, 404);
  process.env.ASK_ADMIN_TOKEN = saved;
  const wrong = (ip: string) => call(() => adminRoute(req("/api/admin/summary", { headers: { authorization: `Bearer ${"w".repeat(40)}` }, ip }), "summary"));
  assert.equal((await wrong("192.0.2.50")).status, 401);
  assert.equal((await call(() => adminRoute(req("/api/admin/summary"), "summary"))).status, 401);
  for (let i = 0; i < 25; i++) await wrong("192.0.2.51");
  assert.equal((await wrong("192.0.2.51")).status, 429);
  const ok = await get("/api/admin/summary", { origin: DOCS_ORIGIN });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), null);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal((await get("/api/admin/nothing")).status, 404);
  assert.equal((await get("/api/admin/summary", { method: "DELETE" })).status, 405);
  // The bot token is not the admin token.
  assert.equal((await call(() => adminRoute(req("/api/admin/summary", { bot: BOT_TOKEN }), "summary"))).status, 401);
  assert.ok(ADMIN_TOKEN.length >= 24);
});

test("settings: the defaults, a validated PUT { settings, actor }, the stored result", async () => {
  assert.deepEqual(await body(await get("/api/admin/settings")), DEFAULT_SETTINGS);
  const put = (json: unknown) => get("/api/admin/settings", { method: "PUT", json });
  const saved = await body(
    await put({
      settings: { model: "claude-opus-5-5", maxTokens: 900, limits: { subject: { perMinute: 5 } }, discord: { channelIds: ["123456789012345678", "123456789012345678", "45678901234567890"], onLimit: "readonly" }, extra: "ignored" },
      actor: "yannic",
    }),
  );
  assert.equal(saved.model, "claude-opus-5-5");
  assert.equal(saved.maxTokens, 900);
  assert.equal(saved.limits.subject.perMinute, 5);
  assert.equal(saved.limits.subject.perHour, DEFAULT_SETTINGS.limits.subject.perHour, "untouched fields keep their value");
  assert.deepEqual(saved.discord, { channelIds: ["123456789012345678", "45678901234567890"], roleIds: [], onLimit: "readonly" });
  assert.equal("extra" in saved, false);
  assert.deepEqual(await body(await get("/api/admin/settings")), saved);
  assert.equal(one<{ actor: string }>("SELECT actor FROM settings")!.actor, "yannic");
  const bad = await put({
    settings: { model: "claude-haiku-5-5-20261001", maxTokens: 10, warnAtPercent: 0, limits: { global: { perDay: -1 } }, enabled: { docs: "yes" }, discord: { roleIds: ["abc"], onLimit: "kick" }, logging: { retentionDays: 0 } },
  });
  assert.equal(bad.status, 400);
  const errors = (await body(bad)).errors as string[];
  for (const field of ["model", "maxTokens", "warnAtPercent", "limits.global.perDay", "enabled.docs", "discord.roleIds", "discord.onLimit", "logging.retentionDays"])
    assert.ok(errors.some((e) => e.startsWith(field)), field);
  assert.equal((await body(await get("/api/admin/settings"))).model, "claude-opus-5-5", "nothing stored from a bad PUT");
  assert.equal((await put({ actor: "x" })).status, 400);
  // Ranges as in flowplan-admin's form, and their order.
  for (const settings of [
    { maxTokens: 99 },
    { maxQuestionChars: 49 },
    { maxConversationChars: 499 },
    { maxQuestionChars: 4000, maxConversationChars: 3999 },
    { limits: { subject: { perMinute: 0 } } },
    { limits: { subject: { perMinute: 30, perHour: 20 } } },
    { limits: { subject: { perMonth: 39 } } },
    { limits: { subject: { costPerDayUsd: 0.001 } } },
    { limits: { subject: { costPerDayUsd: 3, costPerMonthUsd: 2 } } },
    { limits: { global: { perDay: 30000 } } },
    { limits: { global: { costPerDayUsd: 60 } } },
    { monthlyBudgetUsd: 10001 },
    { discord: { channelIds: ["1234567890123456"] } },
    { discord: { roleIds: Array.from({ length: 51 }, (_, i) => String(100000000000000000n + BigInt(i))) } },
  ])
    assert.equal((await put({ settings })).status, 400, JSON.stringify(settings));
  assert.equal((await put({ settings: { monthlyBudgetUsd: 0, maxTurns: 0, maxConversationChars: 50_000 } })).status, 200);
  assert.equal((await put({ settings: { monthlyBudgetUsd: 12.345678 } }).then(body)).monthlyBudgetUsd, 12.345678);
});

test("summary, usage, topics and the CSV export", async () => {
  settings({ warnAtPercent: 1, monthlyBudgetUsd: 0.01 });
  claude.reply = (sent) => ({ text: `See [Backups](${excerptsOf(sent)[0].url})` });
  await ask();
  await ask(SUBJECT, "Wie funktioniert die Sicherung?");
  at = T - 86_400_000;
  await ask(SUBJECT, "restore from a backup");
  at = T;
  claude.reply = () => ({ status: 400, error: { type: "invalid_request_error", message: "bad" } });
  await ask();
  recordRejection("docs", "budget", T);
  recordRejection("discord", "subject", T);
  const s = await body(await get("/api/admin/summary"));
  assert.deepEqual(Object.keys(s).sort(), ["bySource", "errors", "latencyMs", "month", "rejected", "status", "today"]);
  assert.deepEqual(Object.keys(s.status).sort(), ["budgetReached", "discord", "docs", "warn"]);
  assert.equal(s.status.warn, true);
  assert.equal(s.month.questions, 4);
  assert.equal(s.month.inputTokens, 3 * (1200 + 900));
  assert.equal(s.month.outputTokens, 3 * 150);
  assert.equal(s.month.costUsd, Math.round((3 * 204_000) / 1000) / 1_000_000);
  assert.equal(s.month.budgetUsd, 0.01);
  assert.equal(s.month.percent, Math.round(((3 * 0.000204) / 0.01) * 1000) / 10);
  assert.equal(s.today.questions, 3);
  assert.equal(s.bySource.discord.questions, 4);
  assert.equal(s.bySource.docs.questions, 0);
  assert.deepEqual(s.rejected, { subject: 1, global: 0, budget: 1, off: 0 });
  assert.deepEqual(s.errors, { count: 1, rate: 0.25 });
  assert.equal(typeof s.latencyMs.p50, "number");
  assert.equal(typeof s.latencyMs.p95, "number");

  const u = await body(await get("/api/admin/usage?from=2026-11-17&to=2026-11-18&granularity=day"));
  assert.deepEqual(
    u.days.map((d: any) => [d.date, d.source, d.questions, d.errors, d.rejected]),
    [
      ["2026-11-17", "discord", 1, 0, 0],
      ["2026-11-18", "discord", 3, 1, 1],
      ["2026-11-18", "docs", 0, 0, 1],
    ],
  );
  assert.deepEqual(Object.keys(u.days[0]).sort(), ["cacheReadTokens", "costUsd", "date", "errors", "inputTokens", "outputTokens", "p50", "p95", "questions", "rejected", "source"]);
  assert.equal(u.days[0].cacheReadTokens, 900);
  assert.equal((await get("/api/admin/usage?granularity=week")).status, 400);
  assert.equal((await get("/api/admin/usage?from=yesterday")).status, 400);
  assert.equal((await get("/api/admin/usage?from=2026-11-18&to=2026-11-01")).status, 400);
  assert.equal((await get("/api/admin/usage?from=2020-01-01&to=2026-11-18")).status, 400);

  const t = await body(await get("/api/admin/topics?from=2026-11-01&to=2026-11-30"));
  assert.equal(t.pages[0].url, `${docs.base}/en/backup`);
  assert.equal(t.pages[0].count, 3);
  assert.deepEqual(Object.keys(t.pages[0]).sort(), ["count", "title", "url"]);
  assert.ok(t.keywords.some((k: any) => k.keyword === "backups"));
  assert.ok(t.keywords.every((k: any) => !/anna|@/.test(k.keyword)));

  const csv = await get("/api/admin/export?format=csv&from=2026-11-17&to=2026-11-18");
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(csv.headers.get("content-disposition")!, /attachment; filename="flowplan-ask-usage-2026-11-17-2026-11-18.csv"/);
  const lines = (await csv.text()).trimEnd().split("\r\n");
  assert.equal(lines[0], "date,source,questions,inputTokens,outputTokens,cacheReadTokens,costUsd,rejected,errors,p50,p95");
  assert.equal(lines.length, 4);
  assert.equal((await get("/api/admin/export?format=xlsx")).status, 400);
});

test("block list: hashed subjects only, a blocked subject hears 'limit', unblock by the short hash", async () => {
  const post = (json: unknown) => get("/api/admin/blocklist", { method: "POST", json });
  const list = (await body(await post({ subject: SUBJECT, source: "discord", note: "spam", actor: "yannic" }))).entries;
  assert.equal(list.length, 1);
  assert.match(list[0].subject, /^[A-Za-z0-9]{12}$/);
  assert.notEqual(list[0].subject, SUBJECT);
  assert.equal(list[0].lastSeen, null);
  assert.deepEqual(Object.keys(list[0]).sort(), ["createdAt", "lastSeen", "note", "source", "subject"]);
  assert.ok(!JSON.stringify(all("SELECT * FROM blocklist")).includes(SUBJECT), "never in clear");
  const r = await ask();
  assert.equal(r.status, 429);
  assert.equal((await body(r)).scope, "subject");
  assert.equal(claude.requests.length, 0);
  const seen = (await body(await get("/api/admin/blocklist"))).entries[0];
  // Upsert: the short hash changes the note.
  assert.equal((await body(await post({ subject: seen.subject, source: "discord", note: "still spam" }))).entries[0].note, "still spam");
  assert.equal(seen.lastSeen, new Date(T).toISOString());
  assert.equal((await ask("another-discord-subject-xyz")).status, 200);
  // A docs session.
  const token = await newSession("192.0.2.200");
  await post({ subject: token, source: "docs" });
  const make = () => req("/api/ask", { json: { source: "docs", locale: "en", question: "Passkey?" }, session: token, origin: DOCS_ORIGIN });
  assert.equal((await callPublic(make(), () => askRoute(make()))).status, 429);
  assert.equal((await post({ subject: "nope", source: "docs" })).status, 400);
  assert.equal((await post({ subject: "x", source: "discord" })).status, 400);
  assert.equal((await post({ subject: SUBJECT, source: "irc" })).status, 400);
  // Unblock.
  const after = (await body(await get(`/api/admin/blocklist?subject=${seen.subject}`, { method: "DELETE" }))).entries;
  assert.equal(after.length, 1);
  assert.equal((await get(`/api/admin/blocklist`, { method: "DELETE", json: { subject: seen.subject } })).status, 404);
  assert.equal((await ask()).status, 200);
});

test("the log: only when on, anonymised, retention purge, deleted when turned off", async () => {
  assert.deepEqual(await body(await get("/api/admin/log")), { enabled: false, retentionDays: 30, entries: [], nextCursor: null });
  settings({ logging: { enabled: true, retentionDays: 7 } });
  await ask(SUBJECT, "How do backups work? Mail me: bob@example.org");
  at = T - 10 * 86_400_000;
  await ask(SUBJECT, "An old question about backups");
  at = T;
  const log = await body(await get("/api/admin/log?from=2026-11-01&to=2026-11-30"));
  assert.equal(log.entries.length, 2);
  assert.equal(log.retentionDays, 7);
  assert.equal(log.enabled, true);
  const e = log.entries[0];
  assert.equal(e.question, "How do backups work? Mail me: [e-mail]");
  assert.deepEqual(Object.keys(e).sort(), ["answer", "at", "costUsd", "id", "inputTokens", "latencyMs", "locale", "model", "outcome", "outputTokens", "question", "source", "sources"]);
  assert.equal(e.model, "claude-haiku-5-5");
  assert.equal(e.inputTokens, 2100);
  assert.equal(e.outputTokens, 150);
  assert.equal(e.costUsd, 0.000204);
  assert.equal(e.outcome, "ok");
  assert.equal(e.at, new Date(T).toISOString());
  assert.ok(!JSON.stringify(log).includes(SUBJECT));
  const page = await body(await get("/api/admin/log?from=2026-11-01&to=2026-11-30&limit=1"));
  assert.equal(page.entries.length, 1);
  assert.ok(page.nextCursor);
  // The daily (here: hourly) purge.
  maintenance(at);
  assert.equal((await body(await get("/api/admin/log?from=2026-11-01&to=2026-11-30"))).entries.length, 1);
  // Off: everything goes.
  await get("/api/admin/settings", { method: "PUT", json: { settings: { logging: { enabled: false } }, actor: "t" } });
  assert.equal(all("SELECT 1 FROM qa_log").length, 0);
});

test("maintenance: subjects are forgotten after 40 days, the counts stay", async () => {
  await ask();
  at = T + 41 * 86_400_000;
  maintenance(at);
  const row = one<{ subject: string; ip_key: string; status: string }>("SELECT subject, ip_key, status FROM questions")!;
  assert.deepEqual(row, { subject: "", ip_key: "", status: "ok" });
});
