import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BOT_TOKEN, DOCS_ORIGIN, body, callPublic, newSession, req, settings, setup } from "./helpers";
import { askRoute, statusRoute } from "../lib/routes";
import { DEFAULT_SETTINGS, getSettings } from "../lib/settings";
import { all, one, run } from "../lib/db";
import { clock, nextDay, nextMonth } from "../lib/clock";
import { settleStale } from "../lib/limits";
import { serviceState } from "../lib/status";
import { nano } from "../lib/models";

const { claude } = await setup();
// A fixed time in the middle of a UTC month and day.
const T = Date.UTC(2026, 10, 18, 12, 0, 0);
let at = T;
clock.now = () => at;

const ask = (subject: string, question = "How do backups work?") => {
  const make = () => req("/api/ask", { json: { source: "discord", locale: "en", subject, question }, bot: BOT_TOKEN });
  return callPublic(make(), () => askRoute(make()));
};
const askDocs = (token: string, ip: string) => {
  const make = () => req("/api/ask", { json: { source: "docs", locale: "en", question: "How do backups work?" }, origin: DOCS_ORIGIN, session: token, ip });
  return callPublic(make(), () => askRoute(make()));
};
const unlimited = () => {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const many = 10_000_000;
  s.limits.subject = { perMinute: many, perHour: many, perDay: many, perMonth: many, costPerDayUsd: 10_000, costPerMonthUsd: 10_000 };
  s.limits.global = { perDay: many, perMonth: many, costPerDayUsd: 10_000, costPerMonthUsd: 10_000 };
  s.monthlyBudgetUsd = 1000;
  return s;
};
const limitsWith = (patch: (s: typeof DEFAULT_SETTINGS) => void) => {
  const s = unlimited();
  patch(s);
  settings(s);
};
const spentNano = () => one<{ n: number }>("SELECT COALESCE(SUM(CASE WHEN status='pending' THEN reserved_nano ELSE cost_nano END),0) AS n FROM questions")!.n;
let subjectN = 0;
const newSubject = () => `discord-subject-${String(++subjectN).padStart(4, "0")}-abcdef`;

beforeEach(() => {
  at = T;
  claude.reset();
  run("DELETE FROM questions");
  run("DELETE FROM rejections");
  settings(unlimited());
});

async function expectLimit(r: Response, scope: string, retryAt: number) {
  assert.equal(r.status, 429);
  const b = await body(r);
  assert.deepEqual(b, { error: "limit", scope, retryAt: new Date(retryAt).toISOString() });
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
}

test("per subject: per minute (sliding), per hour, per day and per month", async () => {
  limitsWith((s) => (s.limits.subject.perMinute = 3));
  const s = newSubject();
  for (let i = 0; i < 3; i++) {
    assert.equal((await ask(s)).status, 200);
    at += 10_000;
  }
  await expectLimit(await ask(s), "subject", T + 60_000);
  assert.equal((await ask(newSubject())).status, 200, "others are not affected");
  at = T + 60_001;
  assert.equal((await ask(s)).status, 200);

  limitsWith((x) => Object.assign(x.limits.subject, { perMinute: 2, perHour: 2 }));
  const h = newSubject();
  at = T;
  await ask(h);
  at = T + 20 * 60_000;
  await ask(h);
  await expectLimit(await ask(h), "subject", T + 3_600_000);

  limitsWith((x) => Object.assign(x.limits.subject, { perMinute: 2, perHour: 2, perDay: 2 }));
  const d = newSubject();
  at = T;
  await ask(d);
  at = T + 2 * 3_600_000;
  await ask(d);
  await expectLimit(await ask(d), "subject", nextDay(at));
  at = nextDay(at) + 1;
  assert.equal((await ask(d)).status, 200, "a new day");

  limitsWith((x) => Object.assign(x.limits.subject, { perMinute: 3, perHour: 3, perDay: 3, perMonth: 3 }));
  const m = newSubject();
  for (let i = 0; i < 3; i++) {
    await ask(m);
    at += 86_400_000;
  }
  await expectLimit(await ask(m), "subject", nextMonth(at));
  at = nextMonth(at) + 1;
  assert.equal((await ask(m)).status, 200, "a new month");
});

test("per subject: cost per day and per month (the reserved maximum counts)", async () => {
  claude.reply = () => ({ text: "ok", usage: { input_tokens: 0, output_tokens: 40_000 } });
  limitsWith((x) => (x.limits.subject.costPerDayUsd = 0.02));
  const s = newSubject();
  assert.equal((await ask(s)).status, 200);
  assert.equal(spentNano(), 40_000 * 500);
  await expectLimit(await ask(s), "subject", nextDay(at));
  limitsWith((x) => Object.assign(x.limits.subject, { costPerDayUsd: 0.02, costPerMonthUsd: 0.02 }));
  at = nextDay(at) + 1;
  await expectLimit(await ask(s), "subject", nextMonth(at));
});

test("the hashed address shares the per-subject limits (times three) across docs sessions", async () => {
  limitsWith((x) => (x.limits.subject.perMinute = 1));
  const ip = "198.51.100.77";
  for (let i = 0; i < 3; i++) assert.equal((await askDocs(await newSession(ip), ip)).status, 200);
  const fourth = await askDocs(await newSession(ip), ip);
  assert.equal(fourth.status, 429);
  assert.equal((await body(fourth)).scope, "subject");
  assert.equal((await askDocs(await newSession("198.51.100.78"), "198.51.100.78")).status, 200);
  // No address is stored, only its daily hash.
  assert.equal(all("SELECT 1 FROM questions WHERE ip_key LIKE '%198.51%'").length, 0);
});

test("global limits per day and per month, in questions and in cost", async () => {
  limitsWith((x) => (x.limits.global.perDay = 2));
  await ask(newSubject());
  await ask(newSubject());
  await expectLimit(await ask(newSubject()), "global", nextDay(at));
  assert.deepEqual(await body(await statusRoute()), { docs: false, discord: false, name: "Flo" });
  at = nextDay(at) + 1;
  assert.equal((await ask(newSubject())).status, 200);

  limitsWith((x) => Object.assign(x.limits.global, { perDay: 3, perMonth: 3 }));
  await expectLimit(await ask(newSubject()), "global", nextMonth(at));

  run("DELETE FROM questions");
  claude.reply = () => ({ text: "ok", usage: { input_tokens: 0, output_tokens: 40_000 } });
  limitsWith((x) => (x.limits.global.costPerDayUsd = 0.02));
  assert.equal((await ask(newSubject())).status, 200);
  await expectLimit(await ask(newSubject()), "global", nextDay(at));
  const rejected = all<{ scope: string; n: number }>("SELECT scope, SUM(count) AS n FROM rejections GROUP BY scope");
  assert.deepEqual(rejected, [{ scope: "global", n: 3 }]);
});

test("the monthly budget: never overspent, a warning at the threshold, back next month or with a raised budget", async () => {
  limitsWith((x) => {
    x.monthlyBudgetUsd = 0.002;
    x.warnAtPercent = 10;
  });
  const budget = nano(0.002);
  assert.equal(serviceState().warn, false);
  let ok = 0;
  for (let i = 0; i < 50; i++) {
    const r = await ask(newSubject());
    assert.ok(spentNano() <= budget, "never more than the budget");
    if (r.status === 429) {
      await expectLimit(r, "budget", nextMonth(at));
      break;
    }
    assert.equal(r.status, 200);
    ok++;
  }
  assert.ok(ok >= 1 && ok < 50, String(ok));
  assert.equal(serviceState().warn, true);
  assert.equal(serviceState().budgetReached, true);
  assert.deepEqual(await body(await statusRoute()), { docs: false, discord: false, name: "Flo" });
  // Next month: back by itself.
  at = nextMonth(at) + 1000;
  assert.equal(serviceState().budgetReached, false);
  assert.equal((await ask(newSubject())).status, 200);
  // A raised budget: back at once.
  at = T;
  assert.equal((await ask(newSubject())).status, 429);
  limitsWith((x) => (x.monthlyBudgetUsd = 5));
  assert.equal((await ask(newSubject())).status, 200);
  // Budget 0: everything stops.
  limitsWith((x) => (x.monthlyBudgetUsd = 0));
  assert.equal((await body(await ask(newSubject()))).scope, "budget");
});

test("parallel questions reserve their maximum: the budget is not overshot by requests in flight", async () => {
  // One question first, to learn its reserved maximum.
  await ask(newSubject());
  const ceiling = one<{ n: number }>("SELECT ceiling_nano AS n FROM questions")!.n;
  const spent = spentNano();
  assert.ok(ceiling > spent, "the reservation is above the real cost");
  // Room for one more reservation, not for two.
  limitsWith((x) => (x.monthlyBudgetUsd = (spent + ceiling * 1.5) / 1e9));
  claude.reset();
  claude.reply = () => ({ text: "ok", delayMs: 300 });
  const results = await Promise.all(Array.from({ length: 6 }, () => ask(newSubject())));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429, 429, 429, 429, 429]);
  for (const r of results.filter((x) => x.status === 429)) assert.equal((await body(r)).scope, "budget");
  assert.equal(claude.requests.length, 1);
  // Settled: the real cost is small, so the next question fits again.
  assert.equal((await ask(newSubject())).status, 200);
});

test("a request that died with the process keeps its reserved cost", () => {
  run("INSERT INTO questions(at,day,month,source,subject,status,model,reserved_nano) VALUES(?,?,?,?,?,'pending','claude-haiku-5-5',?)", at - 11 * 60_000, "2026-11-18", "2026-11", "docs", "x", 5000);
  run("INSERT INTO questions(at,day,month,source,subject,status,model,reserved_nano) VALUES(?,?,?,?,?,'pending','claude-haiku-5-5',?)", at - 60_000, "2026-11-18", "2026-11", "docs", "y", 7000);
  assert.equal(settleStale(at), 1);
  assert.deepEqual(all("SELECT status, cost_nano, reserved_nano FROM questions ORDER BY id"), [
    { status: "error", cost_nano: 5000, reserved_nano: 0 },
    { status: "pending", cost_nano: 0, reserved_nano: 7000 },
  ]);
  assert.equal(getSettings().model, "claude-haiku-5-5");
});

test("security review W1: IPv6 addresses count per /64", async () => {
  const { ipBucket, ipKey } = await import("../lib/rate-limit");
  assert.equal(ipBucket("2001:db8:1:2:aaaa::1"), ipBucket("2001:db8:1:2:ffff:1:2:3"));
  assert.notEqual(ipBucket("2001:db8:1:2::1"), ipBucket("2001:db8:1:3::1"));
  assert.equal(ipBucket("203.0.113.7"), "203.0.113.7");
  assert.equal(ipBucket("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("2001:db8:1:2::1"), ipKey("[2001:db8:1:2:0:0:0:9]"));
});
