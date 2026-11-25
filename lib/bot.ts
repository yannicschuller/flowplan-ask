// Moderation from Discord (README "Bot API"): the bot blocks and unblocks a
// Discord user by the subject only it can compute (its HMAC of the user id).
// Bearer ASK_BOT_TOKEN, compared in constant time; without a token 404.
// The answer is the short hash flowplan-admin shows – never the subject.
// POST /api/bot/report-draft drafts a bug report or feature request from a
// conversation the bot sends (lib/draft.ts).
import { config } from "./config";
import { HttpError, bearer, clientIp, json, readJson } from "./http";
import { LIMITS, ipKey, limit } from "./rate-limit";
import { safeEqual } from "./secret";
import { DRAFT_MAX_BODY, reportDraft } from "./draft";
import { block, shortHash, subjectKey, unblockKey, validDiscordSubject } from "./subjects";

function requireBot(request: Request) {
  const token = config.botToken();
  if (!token) throw new HttpError(404, "not_found", "Not found.");
  const sent = bearer(request);
  if (!sent || !safeEqual(sent, token)) {
    limit(`token-fail:${ipKey(clientIp(request))}`, LIMITS.tokenFailures);
    throw new HttpError(401, "unauthorized", "Bearer token missing or wrong.");
  }
  // Server to server only.
  if (request.headers.get("origin")) throw new HttpError(403, "cross_origin", "Origin not allowed.");
}

// `actor` is "discord-mod" or the moderator's hashed id – never a name. Not stored.
const validActor = (v: unknown) => v === undefined || v === "discord-mod" || (typeof v === "string" && /^[A-Za-z0-9+/=_.:-]{8,128}$/.test(v));

export async function botRoute(request: Request, name: string) {
  requireBot(request);
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  // A bug report or feature request drafted from a conversation (lib/draft.ts).
  if (name === "report-draft") return reportDraft(await readJson(request, DRAFT_MAX_BODY));
  if (name !== "block" && name !== "unblock") throw new HttpError(404, "not_found", "Not found.");
  const body = await readJson(request, 4096);
  const subject = validDiscordSubject(body.subject);
  if (!subject) throw new HttpError(400, "invalid_subject", "subject must be the bot's hashed subject (8–128 characters).");
  if (!validActor(body.actor)) throw new HttpError(400, "invalid_actor", 'actor must be "discord-mod" or the moderator\'s hashed id.');
  const key = subjectKey("discord", subject);
  if (name === "block") block({ subject, source: "discord", note: body.note });
  else unblockKey(key);
  return json({ short: shortHash(key) });
}
