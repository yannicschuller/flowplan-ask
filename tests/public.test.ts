import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCS_ORIGIN, body, call, callPublic, newSession, req, settings, setup, solve } from "./helpers";
import { healthRoute, optionsRoute, sessionRoute, statusRoute } from "../lib/routes";
import { CHALLENGE_TTL_MS, POW_DIFFICULTY, SESSION_TTL_MS, sessionId } from "../lib/session";
import { clock } from "../lib/clock";

await setup();
const session = (json: unknown, origin: string | null = DOCS_ORIGIN, ip = "198.51.100.1") =>
  callPublic(req("/api/session", { json, origin: origin ?? undefined, ip }), () => sessionRoute(req("/api/session", { json, origin: origin ?? undefined, ip })));

test("health answers with the service name", async () => {
  assert.deepEqual(await body(await call(() => healthRoute())), { service: "flowplan-ask", status: "ok" });
});

test("status: name, docs and discord, cacheable for a minute, CORS only for allowed origins", async () => {
  const r = await callPublic(req("/api/status", { origin: DOCS_ORIGIN }), () => statusRoute());
  assert.deepEqual(await body(r), { docs: true, discord: true, name: "Flo" });
  assert.equal(r.headers.get("cache-control"), "public, max-age=60");
  assert.equal(r.headers.get("access-control-allow-origin"), DOCS_ORIGIN);
  assert.equal(r.headers.get("access-control-allow-credentials"), null);
  const other = await callPublic(req("/api/status", { origin: "https://evil.example" }), () => statusRoute());
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  // Off per source, globally, without a key, without a bot token.
  settings({ enabled: { docs: false } });
  assert.deepEqual(await body(await call(() => statusRoute())), { docs: false, discord: true, name: "Flo" });
  settings({ enabled: { docs: true, global: false } });
  assert.deepEqual(await body(await call(() => statusRoute())), { docs: false, discord: false, name: "Flo" });
  settings({ enabled: { global: true } });
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(await body(await call(() => statusRoute())), { docs: false, discord: false, name: "Flo" });
  process.env.ANTHROPIC_API_KEY = key;
  const bot = process.env.ASK_BOT_TOKEN;
  process.env.ASK_BOT_TOKEN = "too-short";
  assert.equal((await body(await call(() => statusRoute()))).discord, false);
  process.env.ASK_BOT_TOKEN = bot;
  // The budget at 0 stops everything.
  settings({ monthlyBudgetUsd: 0 });
  assert.deepEqual(await body(await call(() => statusRoute())), { docs: false, discord: false, name: "Flo" });
  settings({ monthlyBudgetUsd: 20 });
});

test("preflight: allowed origins only, the session header allowed, no credentials", () => {
  const ok = optionsRoute(req("/api/ask", { method: "OPTIONS", origin: DOCS_ORIGIN }), "POST");
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), DOCS_ORIGIN);
  assert.match(ok.headers.get("access-control-allow-headers")!, /X-Ask-Session/);
  assert.equal(ok.headers.get("access-control-allow-methods"), "POST");
  assert.equal(ok.headers.get("access-control-allow-credentials"), null);
  const bad = optionsRoute(req("/api/ask", { method: "OPTIONS", origin: "https://evil.example" }), "POST");
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  // Extra origins from ASK_ALLOWED_ORIGINS.
  process.env.ASK_ALLOWED_ORIGINS = `${DOCS_ORIGIN}, https://staging-docs.example.org/`;
  assert.equal(optionsRoute(req("/api/ask", { method: "OPTIONS", origin: "https://staging-docs.example.org" }), "POST").status, 204);
  process.env.ASK_ALLOWED_ORIGINS = DOCS_ORIGIN;
});

test("proof of work: challenge, solve, session token; wrong, expired, forged and replayed challenges fail", async () => {
  const first = await body(await session({}));
  assert.equal(first.difficulty, POW_DIFFICULTY);
  assert.equal(typeof first.challenge, "string");
  const nonce = solve(first.challenge, first.difficulty);
  // A nonce that doesn't solve it (the solution is the smallest one).
  const bad = await session({ challenge: first.challenge, nonce: nonce === 0 ? 1 : nonce - 1 });
  assert.equal(bad.status, 400);
  assert.equal((await body(bad)).error, "wrong_nonce");
  assert.equal(bad.headers.get("access-control-allow-origin"), DOCS_ORIGIN, "CORS on errors too");
  // Solved: a token; the nonce may also come as a string.
  const ok = await body(await session({ challenge: first.challenge, nonce: String(nonce) }));
  assert.equal(typeof ok.sessionToken, "string");
  assert.ok(sessionId(ok.sessionToken));
  assert.ok(Date.parse(ok.expiresAt) > Date.now() + SESSION_TTL_MS - 60_000);
  // Once only.
  assert.equal((await body(await session({ challenge: first.challenge, nonce }))).error, "invalid_challenge");
  // Forged: another payload with the old signature.
  const [payload, sig] = first.challenge.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), d: 1 })).toString("base64url");
  assert.equal((await body(await session({ challenge: `${forged}.${sig}`, nonce: 0 }))).error, "invalid_challenge");
  // Expired.
  const late = await body(await session({}));
  const n = solve(late.challenge, late.difficulty);
  clock.now = () => Date.now() + CHALLENGE_TTL_MS + 1000;
  assert.equal((await body(await session({ challenge: late.challenge, nonce: n }))).error, "invalid_challenge");
  // A session token expires after two hours.
  clock.now = () => Date.now() + SESSION_TTL_MS + 1000;
  assert.equal(sessionId(ok.sessionToken), null);
  clock.now = () => Date.now();
  // Junk.
  assert.equal((await session({ challenge: "x", nonce: "<script>" })).status, 400);
  assert.equal(sessionId("not.a-token"), null);
});

test("sessions: refused from other origins, JSON only, rate-limited per hashed address", async () => {
  const evil = await session({}, "https://evil.example");
  assert.equal(evil.status, 403);
  assert.equal((await body(evil)).error, "cross_origin");
  const form = await call(() =>
    sessionRoute(new Request("http://localhost:3000/api/session", { method: "POST", body: "challenge=x", headers: { "content-type": "application/x-www-form-urlencoded", origin: DOCS_ORIGIN } })),
  );
  assert.equal(form.status, 415);
  const big = await session({ challenge: "x".repeat(5000) });
  assert.equal(big.status, 413);
  // 60 challenges per hour per hashed address.
  let last: Response | null = null;
  for (let i = 0; i < 61; i++) last = await session({}, DOCS_ORIGIN, "192.0.2.99");
  assert.equal(last!.status, 429);
  const limited = await body(last!);
  assert.equal(limited.error, "limit");
  assert.equal(limited.scope, "subject");
  assert.ok(Date.parse(limited.retryAt) > Date.now());
  // Another address is not affected.
  assert.equal((await session({}, DOCS_ORIGIN, "192.0.2.100")).status, 200);
});

test("a fresh session for later tests works end to end", async () => {
  assert.ok(sessionId(await newSession("192.0.2.1")));
});
