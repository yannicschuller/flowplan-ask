// The status of the hosted services as a data block (lib/hosted-status.ts)
// and the sources line (system prompt rule 10) – against the local status,
// docs and Claude mocks, never the network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, BOT_TOKEN, body, call, callPublic, req, settings, setup } from "./helpers";
import { adminRoute, askRoute } from "../lib/routes";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { run } from "../lib/db";
import { clock } from "../lib/clock";
import { leaksPrompt, splitSources, stripSourcesTail, worstPromptBytes } from "../lib/prompt";
import {
  RETRY_AFTER,
  SERVICES_TTL,
  STATUS_MAX_CHARS,
  SUMMARY_TTL,
  forgetHostedStatus,
  hostedStatus,
  parseServices,
  parseSummary,
  statusBlock,
  statusRelevant,
} from "../lib/hosted-status";
import { excerptsOf, userText } from "./anthropic-mock";
import { SERVICES, allUp } from "./status-mock";

const { claude, status: mock } = await setup();
const SUBJECT = "hmac-of-a-discord-user-0123456789abcdef";

const ask = (json: Record<string, unknown>) => {
  const make = () => req("/api/ask", { json: { source: "discord", locale: "en", subject: SUBJECT, ...json }, bot: BOT_TOKEN });
  return callPublic(make(), () => askRoute(make()));
};
const lastUser = () => userText(claude.requests[claude.requests.length - 1].body);
const blockOf = (text: string) => /<hosted_status[\s\S]*?<\/hosted_status>/.exec(text)?.[0] ?? null;

beforeEach(() => {
  clock.now = () => Date.now();
  claude.reset();
  mock.reset();
  forgetHostedStatus();
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  base.limits.subject = { ...base.limits.subject, perMinute: 100, perHour: 100, perDay: 100 };
  settings(base);
  run("DELETE FROM questions");
});

test("a question about an outage gets the status block, fetched by the service – nothing personal in the requests", async () => {
  const r = await ask({ question: "Is app.flowplan.org down? My sync doesn't connect." });
  assert.equal(r.status, 200);
  const user = lastUser();
  const block = blockOf(user);
  assert.ok(block, user);
  // A data block of its own, before the question.
  assert.ok(user.indexOf("</hosted_status>") < user.indexOf("<question>"));
  assert.match(user, /answer_language: en$/);
  assert.match(block, /^<hosted_status checked="\d{4}-\d\d-\d\d \d\d:\d\d UTC" page="https:\/\/status\.flowplan\.org">/);
  assert.match(block, /Current status of Flowplan's hosted services \(status\.flowplan\.org\), checked \d{4}-\d\d-\d\d \d\d:\d\d UTC:/);
  assert.match(block, /- Flowplan Cloud: Web app up; API and sync up/);
  assert.match(block, /- Website and help: Website up; Documentation up/);
  // Only the two public files, without any query – no question, subject or address.
  assert.deepEqual([...mock.paths].sort(), ["/services.json", "/summary.json"]);
  // Still no tools: the model never fetches anything itself.
  const sent = claude.requests[0].body;
  for (const key of ["tools", "tool_choice", "mcp_servers"]) assert.equal(key in sent, false, key);
});

test("German and French keywords count too; unrelated questions while everything is up get no block", async () => {
  for (const q of ["Die Web-App ist nicht erreichbar, gibt es eine Störung?", "Flowplan est en panne ? La connexion au serveur est lente.", "What's the status of Flowplan?"]) {
    assert.ok(statusRelevant(q), q);
    await ask({ question: q });
    assert.ok(blockOf(lastUser()), q);
  }
  for (const q of ["How do I set up a passkey?", "Wie stelle ich eine Sicherung wieder her?", "Comment créer une page ?", "Who downloaded it?"]) assert.equal(statusRelevant(q), false, q);
  await ask({ question: "How do I set up a passkey?" });
  assert.equal(blockOf(lastUser()), null);
});

test("an outage, slowness, maintenance and an incident: states and lines, and the block goes into every question", async () => {
  const at = Date.now();
  mock.state.summary = {
    ...allUp(at),
    status: "partial_outage",
    services: { app: "down", api: "degraded", website: "maintenance" },
    incidents: [{ service: "app", status: "down", since: new Date(at - 20 * 60_000).toISOString() }],
    maintenance: [{ title: { en: "Database upgrade", de: "Datenbank-Update" }, start: new Date(at - 60_000).toISOString(), end: new Date(at + 3600_000).toISOString(), services: ["website"] }],
  };
  await ask({ question: "How do I set up a passkey?" });
  const block = blockOf(lastUser())!;
  assert.ok(block, "included although the question is not about the status");
  assert.match(block, /- Flowplan Cloud: Web app outage; API and sync slow/);
  assert.match(block, /Website maintenance; Documentation no data/);
  assert.match(block, /Ongoing incident: Web app: outage since \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.match(block, /Maintenance: "Database upgrade" – Website, now, until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
});

test("stale data counts as no data", async () => {
  mock.state.summary = { ...allUp(), updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
  await ask({ question: "Is Flowplan down?" });
  assert.match(blockOf(lastUser())!, /Web app no data; API and sync no data/);
});

test("unreachable status data never fails a question: the block says so (and only when it matters)", async () => {
  mock.state.fail = true;
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const r = await ask({ question: "Is the server down?" });
    assert.equal(r.status, 200);
    assert.equal(blockOf(lastUser()), "<hosted_status>\nThe current status of Flowplan's hosted services could not be read. Status page: https://status.flowplan.org\n</hosted_status>");
    // An unrelated question without the block.
    await ask({ question: "How do I set up a passkey?" });
    assert.equal(blockOf(lastUser()), null);
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((e) => /status: summary\.json could not be read \(HTTP 500\)/.test(e)), errors.join("\n"));
  // After a failure the next try waits (no fetch per question while it is down).
  assert.equal(mock.paths.filter((p) => p === "/summary.json").length, 1);
});

test("the cache: summary.json for 2 minutes, services.json for an hour, a failed try again after 30 seconds", async () => {
  let at = Date.now();
  clock.now = () => at;
  await ask({ question: "Is Flowplan down?" });
  await ask({ question: "Is Flowplan down?" });
  const count = (p: string) => mock.paths.filter((x) => x === p).length;
  assert.equal(count("/summary.json"), 1);
  assert.equal(count("/services.json"), 1);
  at += SUMMARY_TTL + 1;
  await ask({ question: "Is Flowplan down?" });
  assert.equal(count("/summary.json"), 2);
  assert.equal(count("/services.json"), 1);
  at += SERVICES_TTL;
  // Within the staleness of the status check (updatedAt is the mock's own clock).
  mock.state.summary = allUp(at);
  await ask({ question: "Is Flowplan down?" });
  assert.equal(count("/summary.json"), 3);
  assert.equal(count("/services.json"), 2);
  // A failure keeps the last good list of services and summary (still fresh enough) …
  mock.state.fail = true;
  at += SUMMARY_TTL + 1;
  const original = console.error;
  console.error = () => {};
  try {
    await ask({ question: "Is Flowplan down?" });
    assert.match(blockOf(lastUser())!, /Web app up/);
    at += RETRY_AFTER / 2;
    await ask({ question: "Is Flowplan down?" });
    assert.equal(count("/summary.json"), 4, "no new try within 30 seconds");
    at += RETRY_AFTER;
    mock.state.fail = false;
    await ask({ question: "Is Flowplan down?" });
    assert.equal(count("/summary.json"), 5);
  } finally {
    console.error = original;
  }
});

test("a slow status host: the question waits at most the timeout, then goes on", async () => {
  mock.state.delayMs = 3600;
  const original = console.error;
  console.error = () => {};
  const started = Date.now();
  try {
    const r = await ask({ question: "Is Flowplan offline?" });
    assert.equal(r.status, 200);
  } finally {
    console.error = original;
  }
  assert.ok(Date.now() - started < 3500, `${Date.now() - started} ms`);
  assert.match(blockOf(lastUser())!, /could not be read/);
});

test("switched off in the settings: no fetch, no block; the admin API shows and validates the status settings", async () => {
  const get = await body(await call(() => adminRoute(req("/api/admin/settings", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), "settings")));
  assert.deepEqual(get.status, { enabled: true, summaryUrl: "", servicesUrl: "" });
  settings({ status: { enabled: false } });
  await ask({ question: "Is Flowplan down?" });
  assert.equal(blockOf(lastUser()), null);
  assert.deepEqual(mock.paths, []);

  const put = (s: unknown) =>
    call(() => adminRoute(req("/api/admin/settings", { method: "PUT", json: { settings: s, actor: "t" }, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), "settings"));
  const bad = await put({ status: { summaryUrl: "http://example.com/summary.json", servicesUrl: 5, enabled: "yes" } });
  assert.equal(bad.status, 400);
  const errors = (await body(bad)).errors as string[];
  assert.ok(errors.includes('status.summaryUrl: "" or an https URL'), errors.join());
  assert.ok(errors.includes('status.servicesUrl: "" or an https URL'), errors.join());
  assert.ok(errors.includes("status.enabled: boolean"), errors.join());
  // Addresses of its own (here the mock under another path) – and "" back to the default.
  const ok = await body(await put({ status: { enabled: true, summaryUrl: `${mock.base}/summary.json?x=1`, servicesUrl: "" } }));
  assert.deepEqual(ok.status, { enabled: true, summaryUrl: `${mock.base}/summary.json?x=1`, servicesUrl: "" });
  await ask({ question: "Is Flowplan down?" });
  assert.match(blockOf(lastUser())!, /Web app up/);
});

test("parsing: summary.json and the full status.json, names from services.json, data cleaned up and bounded", async () => {
  assert.deepEqual(parseSummary({ updatedAt: "x", services: { app: { status: "down" }, "bad id!": "up", api: "up" } }).services, { app: "down", api: "up" });
  const groups = parseServices({ groups: [{ id: "g", name: { en: "G <b>" }, services: [{ id: "a", name: "A\u0000\nB" }, { id: "../x" }] }] });
  assert.deepEqual(groups, [{ name: "G ‹b›", services: [{ id: "a", name: "A B" }] }]);
  // A huge maintenance list stays within the bound of the reserved worst case.
  const at = Date.now();
  const s = {
    ok: true as const,
    checkedAt: at,
    groups: parseServices(SERVICES).map((g) => ({ ...g, services: g.services.map((x) => ({ ...x, state: "up" as const })) })),
    incidents: Array.from({ length: 5 }, () => "x".repeat(200)),
    maintenance: Array.from({ length: 3 }, () => "y".repeat(300)),
    notice: true,
  };
  const block = statusBlock(s);
  assert.ok(block.length <= STATUS_MAX_CHARS, String(block.length));
  assert.ok(block.endsWith("</hosted_status>"));
  // The worst case counts the block.
  assert.ok(worstPromptBytes(0, 0, 0, 0) >= 2 * STATUS_MAX_CHARS);
  // Without services.json: the ids of summary.json.
  forgetHostedStatus();
  mock.state.services = { nope: true };
  const h = await hostedStatus({ ...DEFAULT_SETTINGS });
  assert.ok(h && h.ok);
  assert.deepEqual(h.groups[0].services.map((x) => `${x.name} ${x.state}`), ["app up", "api up", "website up", "docs up"]);
});

test("answers about the status don't trip the prompt-leak check", () => {
  for (const a of [
    "The status page shows the Web app as down since 09:40 UTC (checked 10:05 UTC). Follow https://status.flowplan.org for updates.",
    "The status page only covers Flowplan's hosted services – it can't show the state of your self-hosted instance. Check the container logs as described in the docs.",
    "All of Flowplan's hosted services are up right now (checked 10:05 UTC), so the problem is probably on your side.",
    "Die Statusseite zeigt nur die gehosteten Dienste von Flowplan, nicht deinen eigenen Server.",
  ])
    assert.equal(leaksPrompt(a), false, a);
});

test("one sources heading: the sources line becomes `sources`, a sources section of the model's own goes", async () => {
  assert.deepEqual(splitSources("Answer.\n\n[sources: 2, 1, 2]\n"), { text: "Answer.", indexes: [2, 1] });
  assert.deepEqual(splitSources("Answer.\n**Sources: none**"), { text: "Answer.", indexes: [] });
  assert.deepEqual(splitSources("The sources: are explained below."), { text: "The sources: are explained below.", indexes: [] });
  for (const [input, out] of [
    ["Answer.\n\nQuellen:\n- [A](https://docs.flowplan.org/en/a)", "Answer."],
    ["Answer.\n\n**Sources**\n\n1. [A](https://docs.flowplan.org/en/a)\n2. https://docs.flowplan.org/en/b", "Answer."],
    ["Réponse.\n\n*Sources :* [A](https://docs.flowplan.org/fr/a)", "Réponse."],
    ["Answer.\n\n## Sources used\n- A", "Answer."],
    ["Sources of truth are explained below.\nMore text.", "Sources of truth are explained below.\nMore text."],
    ["Answer.\n\nSources: the docs say otherwise.", "Answer.\n\nSources: the docs say otherwise."],
  ])
    assert.equal(stripSourcesTail(input), out, input);

  // The case from Discord: an English answer that ended with "Quellen:" (German) and its
  // own list – which, next to the bot's "**Sources**", made two headings.
  claude.reply = (b) => {
    const [first] = excerptsOf(b);
    return { text: `To restore, open Settings → Backups.\n\nQuellen:\n- [${first.title}](${first.url})\n\n[report: none]` };
  };
  const a = await body(await ask({ question: "How do I restore a backup?" }));
  assert.equal(a.answer, "To restore, open Settings → Backups.");
  assert.equal(a.sources.length, 1);
  assert.match(a.sources[0].url, /\/en\/backup#/);
  // The new form: only the index line, no heading – the sources come from it.
  claude.reply = () => ({ text: "Open **Settings → Backups** and click **Restore**.\n\n[sources: 2, 1]\n[report: none]" });
  const b = await body(await ask({ question: "How do I restore a backup?" }));
  assert.equal(b.answer, "Open **Settings → Backups** and click **Restore**.");
  const excerpts = excerptsOf(claude.requests[claude.requests.length - 1].body);
  assert.deepEqual(b.sources.map((x: { url: string }) => x.url), [excerpts[1].url, excerpts[0].url]);
  assert.equal(JSON.stringify(b).match(/sources|quellen/gi)?.length, 1, "only the field name");
});
