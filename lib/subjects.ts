// Subjects – who the per-subject limits and the block list count – stored
// only as HMACs with the service's key: a docs session's random id, or the
// value the Discord bot sends (itself already an HMAC of the Discord user
// id made with the bot's own secret – this service never sees the id).
import { all, run } from "./db";
import { hmac } from "./secret";
import { HttpError } from "./http";
import { now } from "./clock";
import { sessionId } from "./session";
import type { Source } from "./limits";

export const subjectKey = (source: Source, raw: string) => hmac("subject", `${source}:${raw}`).slice(0, 32);
// What the admin sees: a short hash of the stored key.
export const shortHash = (key: string) => hmac("short", key).replace(/[^A-Za-z0-9]/g, "").slice(0, 12);

// The Discord subject as sent by the bot: an opaque token, 8–128 characters.
export function validDiscordSubject(v: unknown) {
  return typeof v === "string" && /^[A-Za-z0-9+/=_.:-]{8,128}$/.test(v) ? v : null;
}

// Blocked? Also notes that the subject was seen.
export function isBlocked(key: string, at = now()) {
  const r = run("UPDATE blocklist SET last_seen=? WHERE subject=?", at, key);
  return Number(r.changes) > 0;
}

type Row = { subject: string; short: string; source: Source; note: string; created_at: number; last_seen: number | null };
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
export function listBlocked() {
  return all<Row>("SELECT * FROM blocklist ORDER BY created_at DESC").map((r) => ({
    subject: r.short,
    source: r.source,
    note: r.note,
    createdAt: iso(r.created_at),
    lastSeen: iso(r.last_seen),
  }));
}

// POST { subject, source, note, actor } – an upsert: subject is what the
// client sends as the subject (Discord: the bot's hashed user; docs: a
// session token) – never stored in clear, only its key – or the short hash
// of an entry already on the list (to change its note).
export function block(input: Record<string, unknown>, at = now()) {
  const source = input.source;
  if (source !== "docs" && source !== "discord") throw new HttpError(400, "invalid_source", "source must be docs or discord.");
  const raw = typeof input.subject === "string" ? input.subject.trim() : "";
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) : "";
  // The short hash of an entry on the list: change its note.
  if (/^[A-Za-z0-9]{12}$/.test(raw)) {
    const r = run("UPDATE blocklist SET note=? WHERE short=? AND source=?", note, raw, source);
    if (Number(r.changes) > 0) return listBlocked();
  }
  let key: string | null = null;
  if (source === "discord") {
    const s = validDiscordSubject(raw);
    if (s) key = subjectKey("discord", s);
  } else {
    const sid = sessionId(raw, at);
    if (sid) key = subjectKey("docs", sid);
  }
  if (!key) throw new HttpError(400, "invalid_subject", source === "discord" ? "subject must be the bot's hashed subject (8–128 characters)." : "subject must be a valid docs session token.");
  run(
    "INSERT INTO blocklist(subject,short,source,note,created_at) VALUES(?,?,?,?,?) ON CONFLICT(subject) DO UPDATE SET note=excluded.note",
    key,
    shortHash(key),
    source,
    note,
    at,
  );
  return listBlocked();
}

// DELETE { subject } or ?subject=: the short hash from the list.
export function unblock(short: unknown) {
  if (typeof short !== "string" || !/^[A-Za-z0-9]{6,32}$/.test(short)) throw new HttpError(400, "invalid_subject", "subject must be the short hash from the list.");
  const r = run("DELETE FROM blocklist WHERE short=?", short);
  if (Number(r.changes) === 0) throw new HttpError(404, "not_found", "Not on the block list.");
  return listBlocked();
}


// The bot's unblock: by the stored key (404 when not on the list).
export function unblockKey(key: string) {
  const r = run("DELETE FROM blocklist WHERE subject=?", key);
  if (Number(r.changes) === 0) throw new HttpError(404, "not_found", "Not on the block list.");
}
