// POST /api/ask (README "Public API"): who is asking (a docs session
// token or the Discord bot's token), whether Flo is on, the input limits,
// the Discord allow-list, the block list, the docs excerpts, the limits and
// the status of the hosted services (fetched by the service, when it may
// matter), the budget (reserved before the call), then the one model call,
// the sanitised answer (without its sources and report lines – returned as
// `sources` and `report` – and without any sources section of its own), the
// real cost, the statistics and the optional log.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { HttpError, bearer, clientIp, json, readJson } from "./http";
import { LIMITS, LimitError, ipKey, limit } from "./rate-limit";
import { safeEqual } from "./secret";
import { sessionId } from "./session";
import { isBlocked, subjectKey, validDiscordSubject } from "./subjects";
import { getSettings, type Settings } from "./settings";
import { recordRejection, remainingToday, reserve, reservedNano, settle, type Source } from "./limits";
import { docsIndex, docsTerms, isLocale, pickSections, type Locale, type Section } from "./docs";
import { leaksPrompt, promptBytes, splitReport, splitSources, stripSourcesTail, userTurn, excerptTitle, type Turn } from "./prompt";
import { hostedStatus, includeStatus, statusBlock } from "./hosted-status";
import { ceilingNano, costNano } from "./models";
import { askClaude, describeError } from "./claude";
import { linksIn, sanitizeAnswer } from "./sanitize";
import { logAnswer } from "./qalog";
import { recordTopics } from "./topics";
import { nextMonth, now } from "./clock";
import { requireAllowedOrigin } from "./cors";

export const MAX_BODY = 32 * 1024;
// Bytes bound tokens from above: a prompt below this stays below the 100K
// token price tier of Claude Haiku 5.5 with room to spare.
const MAX_PROMPT_BYTES = 100_000;

// Control and invisible characters out, lines kept.
const cleanText = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, "")
    .trim();

type Asker = { source: Source; subject: string; ip: string };

function whoIsAsking(request: Request, body: Record<string, unknown>): Asker {
  const token = bearer(request);
  const ip = clientIp(request);
  if (token) {
    const bot = config.botToken();
    if (!bot || !safeEqual(token, bot)) {
      limit(`token-fail:${ipKey(ip)}`, LIMITS.tokenFailures);
      throw new HttpError(401, "unauthorized", "Bearer token missing or wrong.");
    }
    // The bot token never belongs in a browser.
    if (request.headers.get("origin")) throw new HttpError(403, "cross_origin", "Origin not allowed.");
    if (body.source !== "discord") throw new HttpError(400, "invalid_source", "source must be discord with the bot token.");
    const subject = validDiscordSubject(body.subject);
    if (!subject) throw new HttpError(400, "invalid_subject", "subject (the hashed Discord user, 8–128 characters) is required.");
    return { source: "discord", subject: subjectKey("discord", subject), ip: "" };
  }
  const sid = sessionId(request.headers.get("x-ask-session"));
  if (!sid) throw new HttpError(401, "invalid_session", "Session token missing, invalid or expired – get a new one from POST /api/session.");
  if (body.source !== "docs") throw new HttpError(400, "invalid_source", "source must be docs with a session token.");
  return { source: "docs", subject: subjectKey("docs", sid), ip: ipKey(ip) };
}

type Input = { question: string; history: Turn[]; locale: Locale; page?: string; channelId?: string; roleIds: string[] };

function readInput(body: Record<string, unknown>, settings: Settings, source: Source): Input {
  if (typeof body.question !== "string") throw new HttpError(400, "invalid_question", "question is required.");
  const question = cleanText(body.question);
  if (!question) throw new HttpError(400, "invalid_question", "question is empty.");
  if (question.length > settings.maxQuestionChars)
    throw new HttpError(400, "too_long", `The question is longer than ${settings.maxQuestionChars} characters.`, { max: settings.maxQuestionChars });
  const locale: Locale = isLocale(body.locale) ? body.locale : "en";

  let history: Turn[] = [];
  if (body.history !== undefined && body.history !== null) {
    if (!Array.isArray(body.history) || body.history.length > 100) throw new HttpError(400, "invalid_history", "history must be a list of turns.");
    for (const t of body.history) {
      const turn = t as Record<string, unknown> | null;
      if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.text !== "string")
        throw new HttpError(400, "invalid_history", 'Each history turn is { role: "user"|"assistant", text }.');
      const text = cleanText(turn.text).slice(0, settings.maxConversationChars);
      if (text) history.push({ role: turn.role, text });
    }
    // The newest entries within the limits (each question and each answer counts as one).
    history = settings.maxTurns > 0 ? history.slice(-settings.maxTurns) : [];
    let total = history.reduce((n, t) => n + t.text.length, 0);
    while (history.length && total > settings.maxConversationChars) total -= history.shift()!.text.length;
  }

  const page = typeof body.page === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(body.page) && source === "docs" ? body.page : undefined;
  let channelId: string | undefined;
  let roleIds: string[] = [];
  if (source === "discord") {
    if (body.channelId !== undefined && body.channelId !== null) {
      if (typeof body.channelId !== "string" || !/^\d{1,25}$/.test(body.channelId)) throw new HttpError(400, "invalid_channel", "channelId must be a Discord id.");
      channelId = body.channelId;
    }
    if (body.roleIds !== undefined && body.roleIds !== null) {
      if (!Array.isArray(body.roleIds) || body.roleIds.length > 250 || !body.roleIds.every((r) => typeof r === "string" && /^\d{1,25}$/.test(r)))
        throw new HttpError(400, "invalid_roles", "roleIds must be a list of Discord ids.");
      roleIds = body.roleIds as string[];
    }
  }
  return { question, history, locale, page, channelId, roleIds };
}

// Only for the check – never stored, never sent on.
function checkDiscordAllowList(settings: Settings, input: Input) {
  const { channelIds, roleIds } = settings.discord;
  if (channelIds.length && (!input.channelId || !channelIds.includes(input.channelId)))
    throw new HttpError(403, "not_allowed", "Flo does not answer in this channel.");
  if (roleIds.length && !input.roleIds.some((r) => roleIds.includes(r))) throw new HttpError(403, "not_allowed", "Flo does not answer for these roles.");
}

const FALLBACK = {
  refusal: {
    de: "Dabei kann ich dir leider nicht helfen. Frag mich gern etwas zu Flowplan – die Doku findest du unter https://docs.flowplan.org.",
    en: "Sorry, I can't help with that. Feel free to ask me something about Flowplan – the docs are at https://docs.flowplan.org.",
  },
  empty: {
    de: "Dazu habe ich in der Doku nichts gefunden. Schau in die Doku (https://docs.flowplan.org) oder frag im Flowplan-Discord (https://discord.gg/bCEdB6MPrR).",
    en: "I couldn't find anything about this in the docs. Have a look at the docs (https://docs.flowplan.org) or ask in the Flowplan Discord (https://discord.gg/bCEdB6MPrR).",
  },
  cut: {
    de: "(Die Antwort wurde gekürzt – frag gern genauer nach.)",
    en: "(The answer was shortened – feel free to ask a narrower question.)",
  },
};

// The sources: the excerpts the sources line names (system prompt rule 10),
// then the ones the answer links to (by URL, or by page).
function sourcesOf(answer: string, sections: Section[], indexes: number[] = []) {
  const out: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const n of indexes) {
    const s = sections[n - 1];
    if (!s || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ title: excerptTitle(s), url: s.url });
  }
  for (const link of linksIn(answer)) {
    const exact = sections.find((s) => s.url === link);
    const page = exact ?? sections.find((s) => s.url.split("#")[0] === link.split("#")[0]);
    if (!page) continue;
    const url = exact ? exact.url : link.split("#")[0];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: exact ? excerptTitle(exact) : page.pageTitle, url });
  }
  return out.slice(0, 8);
}

export async function askRoute(request: Request): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  requireAllowedOrigin(request);
  const body = await readJson(request, MAX_BODY);
  const asker = whoIsAsking(request, body);
  const settings = getSettings();
  if (!settings.enabled.global || !settings.enabled[asker.source] || !config.anthropicConfigured()) {
    recordRejection(asker.source, "off");
    throw new HttpError(503, "off", "Flo is switched off right now.");
  }
  const input = readInput(body, settings, asker.source);
  if (asker.source === "discord") checkDiscordAllowList(settings, input);
  // A blocked subject is told it reached its limit (and nothing more).
  if (isBlocked(asker.subject)) {
    recordRejection(asker.source, "subject");
    throw new LimitError("subject", nextMonth(now()));
  }

  // The docs and the status of the hosted services in parallel; the status
  // never fails a question (unreadable → the block says so).
  const [index, hosted] = await Promise.all([docsIndex(), hostedStatus(settings).catch(() => ({ ok: false }) as const)]);
  if (!index) throw new HttpError(502, "unavailable", "The docs cannot be read right now – please try again in a few minutes.");
  // A follow-up question is searched together with the previous one.
  const lastUser = [...input.history].reverse().find((t) => t.role === "user")?.text ?? "";
  let sections = pickSections(index, `${input.question}\n${lastUser}`, input.locale, input.page);
  const block = hosted && includeStatus(hosted, `${input.question}\n${lastUser}`) ? statusBlock(hosted) : undefined;
  let history = input.history;
  let user = userTurn({ sections, history, question: input.question, locale: input.locale, status: block });
  while (promptBytes(user) > MAX_PROMPT_BYTES && (history.length || sections.length > 1)) {
    if (history.length) history = history.slice(1);
    else sections = sections.slice(0, -1);
    user = userTurn({ sections, history, question: input.question, locale: input.locale, status: block });
  }

  const model = settings.model;
  const id = reserve({
    settings,
    source: asker.source,
    subject: asker.subject,
    ip: asker.ip,
    model,
    ceilingNano: ceilingNano(model, promptBytes(user), settings.maxTokens),
  });
  const started = performance.now();
  let reply;
  try {
    reply = await askClaude({ model, maxTokens: settings.maxTokens, user });
  } catch (error) {
    // A timeout or a dropped connection may still have been billed: count the
    // reserved worst case; an error answer of the API was not.
    const maybeBilled = !(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIConnectionError;
    settle(id, { status: "error", costNano: maybeBilled ? reservedNano(id) : 0, latencyMs: Math.round(performance.now() - started) });
    console.error("anthropic:", describeError(error));
    throw new HttpError(502, "upstream", "Flo can't answer right now – please try again in a moment.");
  }
  const latencyMs = Math.round(performance.now() - started);
  // A refusal of the model, or an answer that repeats its instructions.
  const status = reply.stopReason === "refusal" || leaksPrompt(reply.text) ? "refusal" : reply.stopReason === "max_tokens" ? "max_tokens" : "ok";
  // The classification line (system prompt rule 14) never reaches the reader.
  const split = splitReport(reply.text);
  // So does the sources line (rule 10): the clients show `sources` themselves.
  const cited = splitSources(split.text);
  // Only a complete answer may offer a report – and only while reports are on.
  const report = status === "ok" && settings.reports.enabled ? split.report : null;
  let raw = cited.text.trim();
  if (status === "refusal") raw = FALLBACK.refusal[input.locale];
  else if (status === "max_tokens") raw = raw ? `${raw} …\n\n${FALLBACK.cut[input.locale]}` : `${FALLBACK.cut[input.locale]}\n\n${FALLBACK.empty[input.locale]}`;
  else if (!raw) raw = FALLBACK.empty[input.locale];
  const clean = sanitizeAnswer(raw, input.locale);
  const sources = status === "refusal" ? [] : sourcesOf(clean, sections, cited.indexes);
  // A sources section the model wrote anyway goes – its links already
  // counted above – so a client never shows two headings (one of them,
  // perhaps, in the wrong language).
  const answer = stripSourcesTail(clean) || clean;
  const cost = costNano(model, reply.usage);
  settle(id, {
    status,
    costNano: cost,
    inputTokens: reply.usage.input_tokens,
    outputTokens: reply.usage.output_tokens,
    cacheReadTokens: reply.usage.cache_read_input_tokens,
    cacheWriteTokens: reply.usage.cache_creation_input_tokens,
    latencyMs,
  });
  recordTopics(sources, docsTerms(index, input.question));
  logAnswer(settings, {
    source: asker.source,
    locale: input.locale,
    question: input.question,
    answer,
    sources,
    model,
    inputTokens: reply.usage.input_tokens + reply.usage.cache_read_input_tokens + reply.usage.cache_creation_input_tokens,
    outputTokens: reply.usage.output_tokens,
    costNano: cost,
    latencyMs,
    outcome: status,
  });
  const remaining = remainingToday(settings, asker.subject);
  return json({ answer, sources, report, usage: remaining === null ? {} : { remainingToday: remaining } });
}
