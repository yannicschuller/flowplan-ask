// Settings from the environment. Read on every call (not at import time), so
// tests can set them before the first use. Secrets come only from here and
// are never logged or returned.
import { resolve } from "node:path";

const text = (name: string) => (process.env[name] || "").trim();

// Bearer tokens must be long enough to be a secret; a shorter one keeps the
// API it guards switched off (with one log line).
export const MIN_TOKEN = 24;
const warned = new Set<string>();
function token(name: string) {
  const value = text(name);
  if (value && value.length < MIN_TOKEN) {
    if (!warned.has(name)) console.error(`${name} is shorter than ${MIN_TOKEN} characters – it is ignored.`);
    warned.add(name);
    return "";
  }
  return value;
}

const origins = (value: string) =>
  value
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        const u = new URL(o);
        return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);

export const DEFAULT_DOCS_URL = "https://docs.flowplan.org";
// The Flowplan Discord invite: the only Discord link an answer may keep.
export const DISCORD_INVITE = "https://discord.gg/bCEdB6MPrR";

export const config = {
  // Where the SQLite database and the generated key live (one volume).
  dataDir: () => resolve(/*turbopackIgnore: true*/ text("ASK_DATA_DIR") || "./data"),
  // The public address of this service, without a trailing slash.
  publicUrl: () => (text("ASK_URL") || "http://localhost:3000").replace(/\/+$/, ""),
  https: () => config.publicUrl().startsWith("https://"),
  // The public docs: llms.txt and the pages as Markdown.
  docsUrl: () => {
    const value = (text("DOCS_URL") || DEFAULT_DOCS_URL).replace(/\/+$/, "");
    try {
      const u = new URL(value);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      return u.origin + u.pathname.replace(/\/+$/, "");
    } catch {
      return DEFAULT_DOCS_URL;
    }
  },
  docsOrigin: () => new URL(config.docsUrl()).origin,
  // Origins that may call the public API from a browser (CORS).
  allowedOrigins: () => {
    const list = origins(text("ASK_ALLOWED_ORIGINS"));
    return new Set(list.length ? list : [DEFAULT_DOCS_URL]);
  },
  // Bearer token of the admin API (flowplan-admin); unset = API off (404).
  adminToken: () => token("ASK_ADMIN_TOKEN"),
  // Bearer token of the Discord bot; unset = no Discord questions. Never the
  // same as the admin token.
  botToken: () => {
    const bot = token("ASK_BOT_TOKEN");
    if (bot && bot === config.adminToken()) {
      if (!warned.has("same")) console.error("ASK_BOT_TOKEN equals ASK_ADMIN_TOKEN – the bot token is ignored.");
      warned.add("same");
      return "";
    }
    return bot;
  },
  // Only whether a key is configured; the SDK reads it itself.
  anthropicConfigured: () => !!text("ANTHROPIC_API_KEY"),
  // The HMAC key from the environment (else generated, see lib/secret.ts).
  secret: () => text("ASK_SECRET"),
};
