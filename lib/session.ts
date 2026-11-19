// Docs sessions behind a proof of work (README "Public API"): POST
// /api/session gives a signed challenge; the browser finds a nonce so that
// SHA-256(challenge + nonce) starts with `difficulty` zero bits (about half
// a second in a Web Worker) and trades it for a session token. Both are
// HMAC-signed with the service's key, carry their expiry and nothing
// personal; a challenge works once. Bots and Discord never see these.
import { createHash } from "node:crypto";
import { hmac, randomToken, safeEqual } from "./secret";
import { run } from "./db";
import { HttpError } from "./http";
import { now } from "./clock";

export const POW_DIFFICULTY = 16;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 2 * 3_600_000;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function sign(purpose: string, payload: Record<string, unknown>) {
  const body = b64(payload);
  return `${body}.${hmac(purpose, body)}`;
}
// The payload of a token signed for `purpose` that has not expired, else null.
function verify<T extends { exp: number }>(purpose: string, token: unknown, at = now()): T | null {
  if (typeof token !== "string" || token.length > 400) return null;
  const m = /^([A-Za-z0-9_-]{8,300})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m || !safeEqual(m[2], hmac(purpose, m[1]))) return null;
  try {
    const payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as T;
    if (!payload || typeof payload.exp !== "number" || payload.exp <= at) return null;
    return payload;
  } catch {
    return null;
  }
}

export function leadingZeroBits(hash: Buffer) {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}
export const powHash = (challenge: string, nonce: string) => createHash("sha256").update(`${challenge}${nonce}`, "utf8").digest();

export function newChallenge(at = now()) {
  const challenge = sign("pow", { id: randomToken(12), d: POW_DIFFICULTY, exp: at + CHALLENGE_TTL_MS });
  return { challenge, difficulty: POW_DIFFICULTY, expiresAt: new Date(at + CHALLENGE_TTL_MS).toISOString() };
}

// The nonce as the client sent it: a decimal integer (number or string) or a short token.
export function nonceText(v: unknown) {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v)) return v;
  return null;
}

export function solveChallenge(challenge: unknown, nonceInput: unknown, at = now()) {
  const payload = verify<{ id: string; d: number; exp: number }>("pow", challenge, at);
  if (!payload) throw new HttpError(400, "invalid_challenge", "Challenge invalid or expired.");
  const nonce = nonceText(nonceInput);
  if (nonce === null) throw new HttpError(400, "invalid_nonce", "Invalid nonce.");
  if (leadingZeroBits(powHash(challenge as string, nonce)) < payload.d) throw new HttpError(400, "wrong_nonce", "The nonce does not solve the challenge.");
  // Each challenge once.
  try {
    run("INSERT INTO used_challenges(id,expires_at) VALUES(?,?)", payload.id, payload.exp);
  } catch {
    throw new HttpError(400, "invalid_challenge", "Challenge already used.");
  }
  const sid = randomToken(16);
  return { sessionToken: sign("session", { sid, exp: at + SESSION_TTL_MS }), expiresAt: new Date(at + SESSION_TTL_MS).toISOString() };
}

// The session id inside a valid session token, else null.
export const sessionId = (token: unknown, at = now()) => verify<{ sid: string; exp: number }>("session", token, at)?.sid ?? null;

export const purgeChallenges = (at = now()) => run("DELETE FROM used_challenges WHERE expires_at<?", at);
