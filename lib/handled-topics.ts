// Handled topics (README "Insights"): topics the maintainer has already
// dealt with ('done') or decided not to cover ('not_a_topic'), with a short
// note – e.g. "CalDAV" / "Docs page views#sync-both-ways-caldav". They go
// into the insight summary's user turn as data (lib/prompt-insights.ts), so
// the summary reports them only when questions about them are still
// unanswered, and into the maintainer prompt.
//
// Admin text only, nothing personal: control and invisible characters go,
// everything is on one line and bounded, and the log's scrubber masks
// e-mail addresses, phone numbers, addresses and tokens. Who changed a
// topic (actor) is kept here for the admin and never sent to Anthropic.
import { all, one, run } from "./db";
import { now } from "./clock";
import { HttpError } from "./http";
import { scrub } from "./qalog";

export const MAX_HANDLED_TOPICS = 100;
export const MAX_TOPIC_TITLE = 80;
export const MAX_TOPIC_NOTE = 200;
export type HandledStatus = "done" | "not_a_topic";
export type HandledTopic = { id: number; title: string; status: HandledStatus; note: string; createdAt: string; updatedAt: string; actor: string };

type Row = { id: number; title: string; status: HandledStatus; note: string; created_at: number; updated_at: number; actor: string };
const apiTopic = (r: Row): HandledTopic => ({
  id: r.id,
  title: r.title,
  status: r.status,
  note: r.note,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
  actor: r.actor,
});

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g;
// One line, no control or invisible characters, personal data masked.
export function cleanTopicText(v: unknown, max: number) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HttpError(400, "invalid_topic", "title and note must be text.");
  const s = scrub(v.slice(0, max * 4 + 16).replace(INVISIBLE, " ")).replace(/\s+/g, " ").trim();
  return s;
}
const statusOf = (v: unknown): HandledStatus => {
  if (v === "done" || v === "not_a_topic") return v;
  throw new HttpError(400, "invalid_topic", "status must be done or not_a_topic.");
};
function titleOf(v: unknown) {
  const title = cleanTopicText(v, MAX_TOPIC_TITLE);
  if (!title || [...title].length > MAX_TOPIC_TITLE) throw new HttpError(400, "invalid_topic", `title: 1–${MAX_TOPIC_TITLE} characters.`);
  return title;
}
function noteOf(v: unknown) {
  const note = cleanTopicText(v, MAX_TOPIC_NOTE);
  if ([...note].length > MAX_TOPIC_NOTE) throw new HttpError(400, "invalid_topic", `note: at most ${MAX_TOPIC_NOTE} characters.`);
  return note;
}
const actorOf = (v: unknown) => (typeof v === "string" ? v.replace(INVISIBLE, " ").trim().slice(0, 100) : "");
const idOf = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, "invalid_id", "id must be a number.");
  return n;
};

// Oldest first (the order the maintainer added them).
export const listHandledTopics = () => all<Row>("SELECT * FROM handled_topics ORDER BY created_at, id").map(apiTopic);

function sameTitle(title: string, except = 0) {
  if (one("SELECT id FROM handled_topics WHERE lower(title)=lower(?) AND id<>?", title, except))
    throw new HttpError(409, "exists", "A handled topic with this title exists already.");
}
function byId(id: number) {
  const r = one<Row>("SELECT * FROM handled_topics WHERE id=?", id);
  if (!r) throw new HttpError(404, "not_found", "No such handled topic.");
  return r;
}

// POST {title, status, note?, actor}
export function addHandledTopic(body: Record<string, unknown>, at = now()) {
  const title = titleOf(body.title);
  const status = statusOf(body.status);
  const note = noteOf(body.note);
  sameTitle(title);
  if ((one<{ n: number }>("SELECT COUNT(*) AS n FROM handled_topics")?.n ?? 0) >= MAX_HANDLED_TOPICS)
    throw new HttpError(409, "too_many", `At most ${MAX_HANDLED_TOPICS} handled topics.`);
  const r = run("INSERT INTO handled_topics(title,status,note,created_at,updated_at,actor) VALUES(?,?,?,?,?,?)", title, status, note, at, at, actorOf(body.actor));
  return { topic: apiTopic(byId(Number(r.lastInsertRowid))), topics: listHandledTopics() };
}

// PUT {id, title?, status?, note?, actor} – fields left out keep their value.
export function editHandledTopic(body: Record<string, unknown>, at = now()) {
  const old = byId(idOf(body.id));
  const title = body.title === undefined ? old.title : titleOf(body.title);
  const status = body.status === undefined ? old.status : statusOf(body.status);
  const note = body.note === undefined ? old.note : noteOf(body.note);
  sameTitle(title, old.id);
  run("UPDATE handled_topics SET title=?, status=?, note=?, updated_at=?, actor=? WHERE id=?", title, status, note, at, actorOf(body.actor), old.id);
  return { topic: apiTopic(byId(old.id)), topics: listHandledTopics() };
}

// DELETE ?id= (or {id})
export function removeHandledTopic(id: unknown) {
  const r = byId(idOf(id));
  run("DELETE FROM handled_topics WHERE id=?", r.id);
  return { topics: listHandledTopics() };
}
