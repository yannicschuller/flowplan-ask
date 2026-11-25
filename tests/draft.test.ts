// Report drafts (flowplan-discord-bot#5): the answer's classification line
// becomes `report` (and never reaches the reader); POST /api/bot/report-draft
// drafts a bug report or feature request from the conversation the bot
// sends – its own model call (no tools, nothing personal, a fixed system
// prompt, structured output), its own settings, the per-person drafts per
// day, the budget reserved and settled, and an untrusted answer sanitised.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BOT_TOKEN, DOCS_ORIGIN, admin, body, call, callPublic, newSession, req, settings, setup } from "./helpers";
import { adminRoute, askRoute, botRoute } from "../lib/routes";
import { all, one, run } from "../lib/db";
import { clock } from "../lib/clock";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { SYSTEM_PROMPT, splitReport } from "../lib/prompt";
import { DRAFT_SCHEMAS, DRAFT_SYSTEM_PROMPT } from "../lib/prompt-draft";
import { parseDraft, readHistory } from "../lib/draft";
import { costNano } from "../lib/models";
import { settleStale } from "../lib/limits";
import { defaultReply, userText, type MockReply } from "./anthropic-mock";

const { claude } = await setup();
const T = Date.UTC(2026, 10, 18, 12, 0, 0);
let at = T;
clock.now = () => at;
const SUBJECT = "hmac-of-a-discord-user-for-draft-tests-0001";
const OTHER = "hmac-of-another-discord-user-for-drafts-02";

const HISTORY = [
  { role: "user", text: "My board view loses the card order after I drag a card. Flowplan 0.9.8 in Docker with Postgres, Firefox 140. Mail me at jane@example.com" },
  { role: "assistant", text: "The docs don't cover this – please report it.\n\nSources:\n- [Views](https://docs.flowplan.org/en/views)" },
];
const BUG = {
  title: "Board view loses card order after drag and drop",
  what: "After dragging a card to another column, the order of the cards is lost.",
  steps: ["Open a database in board view", "2. Drag a card to another column", "Reload the page"],
  expected: "The cards keep the order I gave them.",
  version: "0.9.8",
  hosting: "Self-hosted with Docker / Docker Compose",
  database: "PostgreSQL",
  client: ["Browser on a computer"],
  environment: "Firefox 140",
  logs: "",
};
const isDraft = (b: any) => b?.system?.[0]?.text === DRAFT_SYSTEM_PROMPT;
const draftReply = (data: unknown, extra: Partial<MockReply> = {}) => (b: any): MockReply =>
  isDraft(b) ? { text: typeof data === "string" ? data : JSON.stringify(data), usage: { input_tokens: 900, output_tokens: 300 }, ...extra } : defaultReply(b);

const draft = (json: unknown, init: { token?: string; origin?: string } = {}) =>
  call(() => botRoute(req("/api/bot/report-draft", { json, bot: init.token ?? BOT_TOKEN, origin: init.origin }), "report-draft"));
const bugDraft = (subject = SUBJECT, history: unknown = HISTORY) => draft({ kind: "bug", subject, history });
const askDiscord = () => {
  at += 61_000; // past the per-minute limit
  const make = () => req("/api/ask", { json: { source: "discord", locale: "en", subject: SUBJECT, question: "Board view loses the card order – a bug?" }, bot: BOT_TOKEN });
  return callPublic(make(), () => askRoute(make()));
};

beforeEach(() => {
  claude.reset();
  at = T;
  settings({ reports: DEFAULT_SETTINGS.reports, enabled: DEFAULT_SETTINGS.enabled, monthlyBudgetUsd: 20, limits: DEFAULT_SETTINGS.limits });
  run("DELETE FROM drafts");
  run("DELETE FROM questions");
  run("DELETE FROM blocklist");
});

test("the classification line: taken off the answer, returned as report", async () => {
  assert.match(SYSTEM_PROMPT, /\[report: bug\]/);
  assert.deepEqual(splitReport("Answer.\n\nSources:\n- [A](https://docs.flowplan.org/en/a)\n[report: bug]"), {
    text: "Answer.\n\nSources:\n- [A](https://docs.flowplan.org/en/a)",
    report: "bug",
  });
  assert.equal(splitReport("Answer.\n**[Report: Feature]**").report, "feature");
  assert.deepEqual(splitReport("Answer.\n[report: none]"), { text: "Answer.", report: null });
  assert.deepEqual(splitReport("No line here."), { text: "No line here.", report: null });
  // Only whole lines count – the words inside a sentence stay.
  assert.equal(splitReport("Write [report: bug] here.").text, "Write [report: bug] here.");

  claude.reply = (b) => ({ text: `${defaultReply(b).text}\n[report: bug]` });
  const r = await body(await askDiscord());
  assert.equal(r.report, "bug");
  assert.doesNotMatch(r.answer, /report:/i);
  // Docs answers carry the field too (additive).
  claude.reply = (b) => ({ text: `${defaultReply(b).text}\n[report: feature]` });
  const session = await newSession();
  const make = () => req("/api/ask", { json: { source: "docs", locale: "en", question: "Can Flowplan do Gantt charts?" }, session, origin: DOCS_ORIGIN });
  assert.equal((await body(await callPublic(make(), () => askRoute(make())))).report, "feature");
  // Without the line, after max_tokens or with reports switched off: null.
  claude.reply = (b) => ({ text: defaultReply(b).text });
  assert.equal((await body(await askDiscord())).report, null);
  claude.reply = (b) => ({ text: `${defaultReply(b).text}\n[report: bug]`, stopReason: "max_tokens" });
  assert.equal((await body(await askDiscord())).report, null);
  settings({ reports: { enabled: false } });
  claude.reply = (b) => ({ text: `${defaultReply(b).text}\n[report: bug]` });
  const off = await body(await askDiscord());
  assert.equal(off.report, null);
  assert.doesNotMatch(off.answer, /report:/i);
});

test("a bug draft: its own call, nothing personal, the template's fields and what is missing", async () => {
  claude.reply = draftReply(BUG);
  const res = await bugDraft();
  assert.equal(res.status, 200);
  const r = await body(res);
  assert.equal(r.kind, "bug");
  assert.deepEqual(r.draft, {
    title: BUG.title,
    what: BUG.what,
    steps: ["Open a database in board view", "Drag a card to another column", "Reload the page"],
    expected: BUG.expected,
    version: "0.9.8",
    hosting: "Self-hosted with Docker / Docker Compose",
    database: "PostgreSQL",
    client: "Browser on a computer",
    environment: "Firefox 140",
    logs: null,
  });
  assert.deepEqual(r.missing, ["logs"]);
  assert.deepEqual(r.usage, { remainingToday: 4 });

  assert.equal(claude.requests.length, 1);
  const sent = claude.requests[0].body;
  assert.equal(sent.model, DEFAULT_SETTINGS.model);
  assert.equal(sent.max_tokens, 1500);
  assert.equal(sent.tools, undefined);
  assert.equal(sent.metadata, undefined);
  assert.equal(sent.stream, undefined);
  assert.deepEqual(sent.output_config.format, { type: "json_schema", schema: JSON.parse(JSON.stringify(DRAFT_SCHEMAS.bug)) });
  assert.equal(sent.system.length, 1);
  assert.equal(sent.system[0].text, DRAFT_SYSTEM_PROMPT);
  const user = userText(sent);
  assert.match(user, /^report_kind: bug\n\n<conversation>\n<turn role="user">/);
  assert.match(user, /<turn role="assistant">/);
  // Scrubbed like the log; never the subject.
  assert.doesNotMatch(user, /jane@example\.com/);
  assert.match(user, /\[e-mail\]/);
  assert.ok(!JSON.stringify(sent).includes(SUBJECT));

  // The ledger: settled with the real cost, no text stored, counted against the budget.
  const rows = all<any>("SELECT * FROM drafts");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].kind, "bug");
  assert.equal(rows[0].cost_nano, costNano(DEFAULT_SETTINGS.model, { input_tokens: 900, output_tokens: 300 }));
  assert.ok(!JSON.stringify(rows).includes("Board view"));
  assert.ok(!JSON.stringify(rows).includes(SUBJECT));
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM questions")!.n, 0, "a draft is not a question");
  const summary = await body(await call(() => adminRoute(admin("/api/admin/summary"), "summary")));
  assert.equal(summary.month.drafts, 1);
  assert.equal(summary.month.draftsOk, 1);
  assert.ok(summary.month.draftsCostUsd > 0);
  assert.equal(summary.month.costUsd, summary.month.draftsCostUsd);
  assert.equal(summary.month.questions, 0);
});

test("a feature draft", async () => {
  claude.reply = draftReply({ title: "Gantt chart view", problem: "I plan projects and need a timeline.", proposal: "", alternatives: "I export to a spreadsheet." });
  const r = await body(await draft({ kind: "feature", subject: SUBJECT, history: [{ role: "user", text: "Can Flowplan show a Gantt chart?" }] }));
  assert.deepEqual(r.draft, { title: "Gantt chart view", problem: "I plan projects and need a timeline.", proposal: null, alternatives: "I export to a spreadsheet." });
  assert.deepEqual(r.missing, ["proposal"]);
  assert.deepEqual(claude.requests[0].body.output_config.format.schema, JSON.parse(JSON.stringify(DRAFT_SCHEMAS.feature)));
});

test("the draft is untrusted: sanitised, scrubbed, bounded, unknown options dropped", () => {
  const parsed = parseDraft(
    "bug",
    JSON.stringify({
        title: "<b>Crash</b> @everyone " + "x".repeat(200),
        what: "See [this](https://evil.example/x) and <script>alert(1)</script> token sk-ant-abcdefghijklmnop, ip 10.1.2.3",
        steps: Array.from({ length: 20 }, (_, i) => `Step ${i}`),
        expected: "```\nworks\n```",
        version: "",
        hosting: "On my toaster",
        database: "SQLite (default)",
        client: ["Android app", "Fridge"],
        environment: 42,
        logs: "line 1\nline 2",
        extra: "dropped",
      }),
  )!;
  const d = parsed.draft as any;
  assert.ok(d.title.length <= 90);
  assert.doesNotMatch(d.title, /<b>|@everyone/);
  assert.doesNotMatch(d.what, /evil\.example|<script|sk-ant-|10\.1\.2\.3/);
  assert.equal(d.steps.length, 8);
  assert.equal(d.expected, "works");
  assert.equal(d.hosting, null);
  assert.equal(d.database, "SQLite (default)");
  assert.equal(d.client, "Android app");
  assert.equal(d.environment, null);
  assert.equal(d.logs, "line 1\nline 2");
  assert.equal(d.extra, undefined);
  assert.deepEqual(parsed.missing, ["version", "hosting", "environment"]);
  assert.equal(parseDraft("feature", '```json\n{"title":"T","problem":"P"}\n```')!.draft.title, "T");
  assert.equal(parseDraft("bug", "no json"), null);
  assert.equal(parseDraft("bug", JSON.stringify({ title: "", what: "" })), null);
});

test("the conversation: bounded, at least one user turn, bad input refused", async () => {
  const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn ${i} ${"y".repeat(1000)}` }));
  const turns = readHistory(long);
  assert.ok(turns.length <= 20);
  assert.ok(turns.reduce((n, t) => n + t.text.length, 0) <= 12_000);
  assert.match(turns[turns.length - 1].text, /^turn 29 /);
  assert.equal((await body(await bugDraft(SUBJECT, []))).error, "invalid_history");
  assert.equal((await body(await bugDraft(SUBJECT, [{ role: "assistant", text: "only Flo" }]))).error, "invalid_history");
  assert.equal((await body(await bugDraft(SUBJECT, [{ role: "system", text: "x" }]))).error, "invalid_history");
  assert.equal((await body(await draft({ kind: "question", subject: SUBJECT, history: HISTORY }))).error, "invalid_kind");
  assert.equal((await body(await bugDraft("short"))).error, "invalid_subject");
  assert.equal((await draft({ kind: "bug", subject: SUBJECT, history: HISTORY }, { token: "x".repeat(40) })).status, 401);
  assert.equal((await draft({ kind: "bug", subject: SUBJECT, history: HISTORY }, { origin: DOCS_ORIGIN })).status, 403);
  assert.equal(claude.requests.length, 0);
});

test("limits: drafts per person and day, blocked subjects, the budget, switched off", async () => {
  claude.reply = draftReply(BUG);
  settings({ reports: { perDay: 2 } });
  assert.equal((await bugDraft()).status, 200);
  assert.equal((await body(await bugDraft())).usage.remainingToday, 0);
  const third = await bugDraft();
  assert.equal(third.status, 429);
  assert.equal((await body(third)).scope, "subject");
  // Someone else still may; the next day the person may again.
  assert.equal((await bugDraft(OTHER)).status, 200);
  at = T + 24 * 3600_000;
  assert.equal((await bugDraft()).status, 200);
  assert.equal(claude.requests.length, 4);

  // Blocked from Flo: no drafts either.
  await call(() => botRoute(req("/api/bot/block", { json: { subject: OTHER }, bot: BOT_TOKEN }), "block"));
  assert.equal((await body(await bugDraft(OTHER))).scope, "subject");

  // The budget is shared with the questions.
  settings({ monthlyBudgetUsd: 0 });
  assert.equal((await body(await bugDraft(SUBJECT))).scope, "budget");
  settings({ monthlyBudgetUsd: 20 });

  for (const off of [{ reports: { enabled: false } }, { enabled: { discord: false } }, { enabled: { global: false } }]) {
    settings(off);
    assert.equal((await body(await bugDraft(SUBJECT))).error, "off");
    settings({ reports: { enabled: true }, enabled: { global: true, discord: true } });
  }
  assert.equal(claude.requests.length, 4);
});

test("a draft's cost counts for the person's cost limits and the questions' budget", async () => {
  claude.reply = draftReply(BUG, { usage: { input_tokens: 900, output_tokens: 300 } });
  // Room for one ceiling only: a draft (≈ $0.002 reserved) and then a question no more.
  settings({ limits: { subject: { costPerDayUsd: 0.01 } } });
  assert.equal((await bugDraft()).status, 200);
  run("UPDATE drafts SET cost_nano=9000000");
  const q = await askDiscord();
  assert.equal(q.status, 429);
  assert.equal((await body(q)).scope, "subject");
});

test("an unusable, refused or failed draft: an error, its cost still counted (or the worst case)", async () => {
  claude.reply = draftReply("not json at all");
  const bad = await bugDraft();
  assert.equal(bad.status, 502);
  assert.equal((await body(bad)).error, "no_draft");
  claude.reply = draftReply(BUG, { stopReason: "refusal" });
  assert.equal((await body(await bugDraft())).error, "no_draft");
  claude.reply = () => ({ error: { type: "overloaded_error", message: "secret detail" }, status: 529 });
  const up = await bugDraft();
  assert.equal(up.status, 502);
  assert.equal((await body(up)).error, "upstream");
  const rows = all<any>("SELECT status, error, cost_nano FROM drafts ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.status, r.error]), [["error", "invalid_answer"], ["error", "refusal"], ["error", "upstream"]]);
  assert.ok(rows[0].cost_nano > 0);
  assert.equal(rows[2].cost_nano, 0, "an API error answer was not billed");
  // A draft that died with the process keeps its reserved worst case.
  run("INSERT INTO drafts(at,day,month,subject,kind,status,model,reserved_nano,ceiling_nano) VALUES(?,?,?,?,?,'pending',?,?,?)", T - 3600_000, "2026-11-18", "2026-11", "x", "bug", "claude-haiku-5-5", 5000, 5000);
  assert.ok(settleStale(T) >= 1);
  assert.deepEqual(one<any>("SELECT status, error, cost_nano FROM drafts WHERE subject='x'"), { status: "error", error: "interrupted", cost_nano: 5000 });
});

test("admin settings: reports (enabled, maxTokens, perDay) validated", async () => {
  const put = (s: unknown) => call(() => adminRoute(admin("/api/admin/settings", { method: "PUT", json: { settings: s, actor: "yannic" } }), "settings"));
  assert.deepEqual((await body(await call(() => adminRoute(admin("/api/admin/settings"), "settings")))).reports, { enabled: true, maxTokens: 1500, perDay: 5 });
  const bad = await body(await put({ reports: { maxTokens: 100, perDay: 0, enabled: "yes" } }));
  assert.equal(bad.error, "invalid_settings");
  assert.deepEqual(bad.errors.sort(), ["reports.enabled: boolean", "reports.maxTokens: integer 500–4000", "reports.perDay: integer 1–100"]);
  const ok = await body(await put({ reports: { maxTokens: 2000, perDay: 10, enabled: false } }));
  assert.deepEqual(ok.reports, { enabled: false, maxTokens: 2000, perDay: 10 });
  claude.reply = draftReply(BUG);
  settings({ reports: { enabled: true } });
  await bugDraft();
  assert.equal(claude.requests[0].body.max_tokens, 2000);
});
