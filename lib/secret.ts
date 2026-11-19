// Hashes and the service's HMAC key (hashed addresses, subjects, signed
// session tokens and proof-of-work challenges). The key is ASK_SECRET when
// set, else a random key created once in the data directory – nothing
// secret has to be configured for it.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

const cache = globalThis as unknown as { askSecret?: { id: string; key: Buffer } };

export function secretKey(): Buffer {
  const fromEnv = config.secret();
  const dir = config.dataDir();
  const id = fromEnv ? `env:${sha256(fromEnv)}` : `dir:${dir}`;
  const cached = cache.askSecret;
  if (cached && cached.id === id) return cached.key;
  let key: Buffer;
  if (fromEnv) {
    if (fromEnv.length < 32) console.error("ASK_SECRET is shorter than 32 characters – use `openssl rand -hex 32`.");
    key = createHash("sha256").update(fromEnv).digest();
  } else {
    mkdirSync(dir, { recursive: true });
    const file = join(/*turbopackIgnore: true*/ dir, "secret.key");
    if (existsSync(file)) key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    else {
      key = randomBytes(32);
      writeFileSync(file, key.toString("hex"), { mode: 0o600 });
    }
  }
  cache.askSecret = { id, key };
  return key;
}

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const hmac = (purpose: string, value: string) => createHmac("sha256", secretKey()).update(`${purpose}\0${value}`).digest("base64url");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

// Constant-time comparison of two strings (via their hashes, so lengths don't leak).
export function safeEqual(a: string, b: string) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
