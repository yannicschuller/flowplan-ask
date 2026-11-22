// One SQLite file in the data directory (node:sqlite). The schema is built by
// numbered migrations; the table schema_version holds the last one applied.
// Nothing here holds a plain IP address, a Discord id or a session token:
// subjects are HMACs (lib/subjects.ts), addresses daily HMACs (ipKey()).
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

const MIGRATIONS: string[] = [
  // 1: settings, questions (the ledger for limits, budget and statistics),
  // rejections, topics, block list, the optional Q&A log, rate limits and
  // used proof-of-work challenges.
  `CREATE TABLE settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     json TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     actor TEXT NOT NULL DEFAULT ''
   );
   -- One row per accepted question. subject and ip_key are HMACs, emptied
   -- after 40 days (lib/maintenance.ts); the counts stay for the statistics.
   -- While the model call runs the row is 'pending' and holds the reserved
   -- (maximum) cost; settling replaces it with the cost from the usage.
   -- ceiling_nano keeps the maximum for the status estimate.
   CREATE TABLE questions (
     id INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     day TEXT NOT NULL,
     month TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('docs','discord')),
     subject TEXT NOT NULL DEFAULT '',
     ip_key TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL CHECK (status IN ('pending','ok','refusal','max_tokens','error')),
     model TEXT NOT NULL,
     reserved_nano INTEGER NOT NULL DEFAULT 0,
     ceiling_nano INTEGER NOT NULL DEFAULT 0,
     cost_nano INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     latency_ms INTEGER,
     settled_at INTEGER
   );
   CREATE INDEX questions_subject ON questions(subject, at);
   CREATE INDEX questions_ip ON questions(ip_key, at);
   CREATE INDEX questions_month ON questions(month, source);
   CREATE INDEX questions_day ON questions(day, source);
   CREATE INDEX questions_pending ON questions(status) WHERE status = 'pending';
   CREATE TABLE rejections (
     day TEXT NOT NULL,
     source TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('subject','global','budget','off')),
     count INTEGER NOT NULL,
     PRIMARY KEY (day, source, scope)
   );
   -- Doc pages linked in answers and docs terms asked about (only words of
   -- the docs' own vocabulary, so nothing personal).
   CREATE TABLE topic_pages (
     day TEXT NOT NULL,
     url TEXT NOT NULL,
     title TEXT NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (day, url)
   );
   CREATE TABLE topic_terms (
     day TEXT NOT NULL,
     term TEXT NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (day, term)
   );
   CREATE TABLE blocklist (
     subject TEXT PRIMARY KEY,
     short TEXT NOT NULL UNIQUE,
     source TEXT NOT NULL CHECK (source IN ('docs','discord')),
     note TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     last_seen INTEGER
   );
   -- Only while logging is on; anonymised (no subject, no ids).
   CREATE TABLE qa_log (
     id INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     source TEXT NOT NULL,
     locale TEXT NOT NULL,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     sources TEXT NOT NULL,
     model TEXT NOT NULL DEFAULT '',
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cost_nano INTEGER NOT NULL DEFAULT 0,
     latency_ms INTEGER,
     outcome TEXT NOT NULL DEFAULT 'ok'
   );
   CREATE INDEX qa_log_at ON qa_log(at);
   CREATE TABLE rate_limits (
     key TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL
   );
   CREATE TABLE used_challenges (
     id TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL
   );`,
  // 2: insights – the regular summaries of the anonymised Q&A log
  // (lib/insights.ts). A row is also the summary call's entry in the
  // budget: 'pending' with the reserved (maximum) cost while the call runs,
  // then the real cost from the usage. period is the scheduled run's period
  // ('2026-11-21' or '2026-W47'), unique so a period is summarised once;
  // it is emptied when that run failed (period_key keeps it, for the retry
  // count). result holds the sanitised JSON (topics, unanswered, ideas);
  // it is cleared (purged=1) with the log's retention or when logging is
  // turned off, while the cost stays for the budget and the statistics.
  `CREATE TABLE insights (
     id INTEGER PRIMARY KEY,
     created_at INTEGER NOT NULL,
     day TEXT NOT NULL,
     month TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('scheduled','manual')),
     interval TEXT NOT NULL CHECK (interval IN ('daily','weekly')),
     period TEXT,
     period_key TEXT NOT NULL DEFAULT '',
     from_at INTEGER NOT NULL,
     to_at INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending','ok','empty','error')),
     error TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL DEFAULT '',
     questions INTEGER NOT NULL DEFAULT 0,
     sent INTEGER NOT NULL DEFAULT 0,
     unanswered INTEGER NOT NULL DEFAULT 0,
     refused INTEGER NOT NULL DEFAULT 0,
     result TEXT NOT NULL DEFAULT '',
     purged INTEGER NOT NULL DEFAULT 0,
     actor TEXT NOT NULL DEFAULT '',
     reserved_nano INTEGER NOT NULL DEFAULT 0,
     ceiling_nano INTEGER NOT NULL DEFAULT 0,
     cost_nano INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     latency_ms INTEGER,
     settled_at INTEGER
   );
   CREATE UNIQUE INDEX insights_period ON insights(period) WHERE period IS NOT NULL;
   CREATE INDEX insights_month ON insights(month);
   CREATE INDEX insights_day ON insights(day);
   CREATE INDEX insights_pending ON insights(status) WHERE status = 'pending';`,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

const holder = globalThis as unknown as { askDb?: { db: DatabaseSync; dir: string } };

export function migrate(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (!row) db.exec("INSERT INTO schema_version(version) VALUES(0)");
  const current = Number(row?.version ?? 0);
  if (current > SCHEMA_VERSION) throw new Error(`Database schema ${current} is newer than this version (${SCHEMA_VERSION}).`);
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare("UPDATE schema_version SET version=?").run(v + 1);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

// The connection for the current data directory (a new one when it changed,
// which only tests do).
export function db(): DatabaseSync {
  const dir = config.dataDir();
  const open = holder.askDb;
  if (open && open.dir === dir) return open.db;
  holder.askDb?.db.close();
  mkdirSync(dir, { recursive: true });
  const conn = new DatabaseSync(join(/*turbopackIgnore: true*/ dir, "ask.db"));
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(conn);
  holder.askDb = { db: conn, dir };
  return conn;
}
export function closeDb() {
  holder.askDb?.db.close();
  holder.askDb = undefined;
}

// Rows as plain objects (node:sqlite gives null-prototype ones).
export const all = <T>(sql: string, ...params: SQLInputValue[]) => db().prepare(sql).all(...params).map((row) => ({ ...row })) as T[];
export const one = <T>(sql: string, ...params: SQLInputValue[]) => {
  const row = db().prepare(sql).get(...params);
  return (row ? { ...row } : undefined) as T | undefined;
};
export const run = (sql: string, ...params: SQLInputValue[]) => db().prepare(sql).run(...params);
let depth = 0;
// BEGIN IMMEDIATE: the write lock is taken at once, so a check and the write
// that depends on it (reserving a question's cost) cannot interleave with
// another request. Nested calls join the outer transaction.
export function transaction<T>(fn: () => T): T {
  const conn = db();
  if (depth > 0) return fn();
  conn.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  } finally {
    depth--;
  }
}
