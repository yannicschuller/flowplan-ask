// Every test file gets its own data directory, a known environment, a fake
// docs site (tests/docs-mock.ts) and a fake Claude API
// (tests/anthropic-mock.ts) – never the network. The keys and tokens here
// are throwaway values generated at runtime.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { after } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { closeDb } from "../lib/db";
import { forgetDocs } from "../lib/docs";
import { forgetSettings, saveSettings } from "../lib/settings";
import { useAnthropic } from "../lib/claude";
import { clock } from "../lib/clock";
import { handle } from "../lib/http";
import { publicRoute, sessionRoute } from "../lib/routes";
import { leadingZeroBits, powHash } from "../lib/session";
import { startAnthropicMock } from "./anthropic-mock";
import { startDocsMock } from "./docs-mock";

export const BASE = "http://localhost:3000";
export const DOCS_ORIGIN = "https://docs.flowplan.org";
export const ADMIN_TOKEN = `admin-${randomBytes(18).toString("hex")}`;
export const BOT_TOKEN = `bot-${randomBytes(18).toString("hex")}`;
export const API_KEY = `sk-ant-test-${randomBytes(12).toString("hex")}`;

export async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
  const docs = await startDocsMock();
  const claude = await startAnthropicMock();
  process.env.ASK_DATA_DIR = dir;
  process.env.ASK_URL = BASE;
  process.env.DOCS_URL = docs.base;
  process.env.ASK_ALLOWED_ORIGINS = DOCS_ORIGIN;
  process.env.ASK_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.ASK_BOT_TOKEN = BOT_TOKEN;
  process.env.ANTHROPIC_API_KEY = API_KEY;
  delete process.env.ASK_SECRET;
  clock.now = () => Date.now();
  forgetDocs();
  forgetSettings();
  useAnthropic(new Anthropic({ apiKey: API_KEY, baseURL: claude.base, maxRetries: 0, timeout: 10_000, logLevel: "off" }));
  after(async () => {
    closeDb();
    forgetDocs();
    forgetSettings();
    useAnthropic(null);
    await docs.close();
    await claude.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, docs, claude };
}

type Init = RequestInit & { json?: unknown; origin?: string | null; session?: string; bot?: string | null; ip?: string };
export function req(path: string, init: Init = {}) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  if (init.origin) headers.set("origin", init.origin);
  if (init.session) headers.set("x-ask-session", init.session);
  if (init.bot) headers.set("authorization", `Bearer ${init.bot}`);
  headers.set("x-forwarded-for", init.ip ?? "203.0.113.7");
  return new Request(BASE + path, { method: init.method ?? (body !== undefined ? "POST" : "GET"), ...init, headers, body });
}
export const body = async (r: Response) => (await r.json()) as Record<string, any>;
export const call = (fn: () => Promise<Response> | Response) => handle(fn);
export const callPublic = (request: Request, fn: () => Promise<Response> | Response) => publicRoute(request, fn);

// Solves the proof of work like the docs widget does (SHA-256(challenge + nonce)).
export function solve(challenge: string, difficulty: number) {
  for (let nonce = 0; ; nonce++) if (leadingZeroBits(powHash(challenge, String(nonce))) >= difficulty) return nonce;
}
export async function newSession(ip = "203.0.113.7") {
  const first = await body(await call(() => sessionRoute(req("/api/session", { json: {}, origin: DOCS_ORIGIN, ip }))));
  const nonce = solve(first.challenge, first.difficulty);
  const second = await body(await call(() => sessionRoute(req("/api/session", { json: { challenge: first.challenge, nonce }, origin: DOCS_ORIGIN, ip }))));
  return second.sessionToken as string;
}

export const settings = (partial: Record<string, unknown>) => saveSettings(partial, "test");
export const admin = (path: string, init: Init = {}) => req(path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(init.headers as Record<string, string>) } });
