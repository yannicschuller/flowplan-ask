// Fixed-window rate limits kept in the database (they survive restarts), for
// what is not a question: proof-of-work challenges and sessions, wrong bot
// and admin tokens. Keys hold ipKey(), a daily HMAC of the address – never
// an IP address itself. Questions are counted in lib/limits.ts.
import { hmac } from "./secret";
import { one, run, transaction } from "./db";
import { now } from "./clock";

export type LimitScope = "subject" | "global" | "budget";
// Answered as 429 { error: "limit", scope, retryAt } (lib/http.ts).
export class LimitError extends Error {
  constructor(
    public scope: LimitScope,
    public retryAt: number,
  ) {
    super(`limit: ${scope}`);
  }
}

// Counts one hit; throws LimitError (scope "subject") once `max` hits fell into the window.
export function hit(key: string, max: number, windowSeconds: number, at = now()) {
  const windowMs = windowSeconds * 1000;
  transaction(() => {
    const row = one<{ window_start: number; count: number }>("SELECT window_start,count FROM rate_limits WHERE key=?", key);
    if (!row || at - row.window_start >= windowMs) {
      run("INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=1", key, at);
      return;
    }
    if (row.count >= max) throw new LimitError("subject", row.window_start + windowMs);
    run("UPDATE rate_limits SET count=count+1 WHERE key=?", key);
  });
}

// [max, seconds] per hashed address.
export const LIMITS = {
  // Proof-of-work challenges and solved sessions.
  challenge: [60, 3600],
  session: [30, 3600],
  // Wrong bot or admin tokens.
  tokenFailures: [20, 600],
} as const;
export const limit = (key: string, [max, seconds]: readonly [number, number], at = now()) => hit(key, max, seconds, at);

// The visitor's address as a daily HMAC: enough to tell repeated requests
// apart, useless for recognising anyone the next day.
// IPv6 addresses count per /64: one connection usually has a whole /64, so
// counting single addresses would let it mint unlimited sessions.
export function ipKey(ip: string, at = now()) {
  const day = Math.floor(at / 86_400_000);
  return hmac("ip", `${day}:${ipBucket(ip)}`).slice(0, 22);
}

export function ipBucket(ip: string) {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!v.includes(":") || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(v)) return v.replace(/^::ffff:/, "");
  const [head, tail = ""] = v.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = v.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
