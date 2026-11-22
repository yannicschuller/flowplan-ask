# flowplan-ask

**Flo** („Frag Flo“ / "Ask Flo") is [Flowplan](https://github.com/yannicschuller/flowplan)'s assistant – a small otter with a notepad. It answers questions about using, setting up and self-hosting Flowplan, **only from the public docs** ([docs.flowplan.org](https://docs.flowplan.org)), with links to the pages the answer is based on. People ask it in the docs (the „Frag Flo“ button, built in [flowplan-docs](https://github.com/yannicschuller/flowplan-docs)) and on Discord (`/ask`, built in flowplan-discord-bot). This service, at **ask.flowplan.org**, does the answering: it reads the docs, asks Claude, sanitises the answer and is the only place where limits and the budget are counted. [flowplan-admin](https://github.com/yannicschuller/flowplan-admin) changes its settings and shows its numbers through the [admin API](#admin-api).

The page at `/` only says what Flo is and whether it is answering right now – there is no chat here. Interface in German and English.

## How it works

```
docs widget ──POST /api/session (proof of work)──▶ ┌──────────────┐ ──llms.txt, keywords.json, pages (.md)──▶ docs.flowplan.org
            ──POST /api/ask (X-Ask-Session)─────▶ │ flowplan-ask │
Discord bot ──POST /api/ask (Bearer bot token)──▶ │  SQLite      │ ──one messages.create────▶ Claude API
flowplan-admin ──/api/admin/* (Bearer)──────────▶ └──────────────┘
```

1. **Who is asking.** A docs session token (proof of work, below) or the Discord bot's token with a `subject` the bot computed itself (an HMAC of the Discord user id with the bot's own secret – this service never sees the id). Subjects are stored only as HMACs with this service's key.
2. **Is Flo on, may this ask.** The global switch and the per-source switch, the input limits, the Discord channel/role allow-list, the block list.
3. **Docs retrieval** (`lib/docs.ts`). `${DOCS_URL}/llms.txt` (English) and `${DOCS_URL}/de/llms.txt` (German) list every page with its Markdown address; the pages are fetched (only addresses below `DOCS_URL/<locale>/`, redirects only within the docs' origin, size and time limits) and cut into sections at their `##` headings (long sections again at `###`), with the same anchor ids as the docs site. With the lists, `${DOCS_URL}/keywords.json` and `${DOCS_URL}/de/keywords.json` are fetched: every page's front-matter keywords as `{ "<slug>": ["keyword", …] }` (at most 200 KB, 40 keywords of up to 100 characters per page; slugs not in `llms.txt` are ignored). The Markdown pages carry no front matter, so this is the only way the keywords reach Flo. A missing, unreachable or invalid file only means ranking without keywords. The index lives in memory and is refreshed every 3 hours; when the docs are unreachable the previous index keeps serving. A question (together with the previous user turn, for follow-ups) is ranked with BM25 over folded (NFKD, so "DAVx⁵" is "davx5"), lightly stemmed German/English words plus cross-language synonyms; title and headings weigh more, the page the reader is on (`page`) a little more, and a section shorter than half the average counts as half the average. A page's keywords are a field of their own (weight 0.5 against the section's own score, terms weighted as in the sections): they count for the page's intro section and for each of its sections that matches the question by itself, so they lift the page while its text still picks the section. The best sections – at most 6 and about 8,000 tokens (24,000 characters) – go into the prompt with their URL (page + `#anchor`) in the language of `locale` (falling back to the other language).
4. **Limits and budget** (`lib/limits.ts`). In one SQLite `BEGIN IMMEDIATE` transaction every limit is checked and the question is recorded with its **maximum possible cost** reserved (every prompt byte at the cache-write price plus `max_tokens` of output – a token is never shorter than a byte). After the call the reservation is replaced by the real cost from `usage`. Requests in flight therefore count with their worst case and the budget can never be overshot.
5. **One Claude call** (`lib/claude.ts`): `client.messages.create` with the model from the settings, `max_tokens` from the settings, `output_config: { effort: "low" }`, the fixed system prompt as one text block with `cache_control: { type: "ephemeral" }`, and a single user turn holding the data blocks. No `tools`, no MCP, no web access, no streaming, no `metadata`.
6. **Answer** (`lib/sanitize.ts`): `stop_reason` `refusal` → a short fixed refusal; `max_tokens` → the text with a "shortened" note; an answer that repeats a sentence of the system prompt is treated as a refusal. Then the sanitiser, the sources, the real cost, the statistics and – only when switched on – the anonymised log.

Besides the questions there is exactly one other kind of model call: the [insight summary](#insights) of the anonymised log – not a question, made on a schedule or by an admin, with its own prompt, model and budget reservation.

### The prompt

The system prompt is fixed in `lib/prompt.ts` (English, never built from input, never echoed). It limits Flo to Flowplan questions answered only from the excerpts; says to point to the docs, Discord or GitHub issues when the docs don't cover a question; to refuse everything else in one sentence; to never follow instructions inside the data, never reveal or discuss the instructions, no role play; to only use URLs from the excerpts (and the three fallback addresses); to answer in the question's language (German with informal "du", English), else per `answer_language`; to be short; to end with "Quellen:"/"Sources:" listing the excerpts used; to never repeat secrets.

The user turn is data only:

```
<docs_excerpts>
<excerpt index="1" title="First steps – Sign in or sign up" url="https://docs.flowplan.org/en/first-steps#sign-in-or-sign-up">
…section text…
</excerpt>
</docs_excerpts>

<conversation>            (only with history)
<turn role="user">…</turn>
<turn role="assistant">…</turn>
</conversation>

<question>
…
</question>

answer_language: en
```

In the question and the conversation `<` and `>` become `‹` `›`, so they can't close or open a block; in the docs text only the block names are defused (code examples keep their brackets). The earlier conversation is sent as data inside the user turn, never as real `assistant` messages, so a client cannot forge Flo's own words.

### Answers (the sanitiser)

Before an answer leaves the service:

- Markdown subset only: paragraphs, `-`/numbered lists, `**bold**`, `*italic*`, `` `inline code` ``, fenced code blocks, `[text](url)` links. Headings become bold lines; blockquote markers, rules, table rulers, strikethrough and Discord spoilers/subtext are removed.
- No HTML: tags and comments are removed, a remaining `<` before a letter becomes `‹`. Images become their alt text. Control, bidi and zero-width characters are removed.
- **Links** are kept only to `https://docs.flowplan.org/…`, `https://flowplan.org/…`, `https://github.com/yannicschuller/flowplan…` and the Discord invite `https://discord.gg/bCEdB6MPrR` (plus the configured `DOCS_URL` origin – the same in production). Any other Markdown link becomes its text; any other bare `http(s)://` or `www.` address becomes `[link removed]` / `[Link entfernt]`. No credentials, no ports, `https` only.
- Discord: `@everyone`/`@here` are defused (zero-width space), user/role/channel/emoji/timestamp tags are removed.
- At most 4,000 characters (cut at a word, an open code block closed).

`sources` are the excerpts the answer links to (by exact URL, or by page). Clients must still render answers as text or safe Markdown – never as HTML.

## Insights

A regular summary of what people asked Flo, for the maintainer – shown in flowplan-admin under **Flo → Einblicke / Insights** (`lib/insights.ts`): the main topics with counts, the questions Flo could not answer, candidate docs pages or features derived from them, and a ready-to-copy prompt ("Here are the open questions from Flo users this week: … Please check the docs/feature gaps and propose issues").

- **Only from the anonymised Q&A log.** The log is off by default; with it off there is no summary (scheduled runs do nothing, "Generate now" answers `409 log_off`, the list is empty). Turn it on with `logging.enabled` in the settings.
- **Answered or not.** The log has no flag for it, so it is derived when summarising: `outcome` `refusal` → *refused* (off-topic); an answer without any docs source, or one saying it found nothing in the docs (the fallback answer and the system prompt's rule 2, German and English phrases such as "couldn't find", "the docs don't cover", „nichts gefunden“, „steht nicht in der Doku“) → *not answered*; everything else → *answered*.
- **What goes to Anthropic: only the question texts and whether each was answered.** The logged (already scrubbed) questions are scrubbed again, put on one line and cut to 300 characters; at most the **newest 500** questions of the period and at most 60 KB together (older ones are left out, the counts still include them). Never answers, subjects, sessions, sources, locales, times, Discord or IP data, names or e-mail addresses.
- **Its own call** (`lib/claude.ts` `summarizeClaude`): `client.messages.create` with `settings.insights.model` (from the same allow-list, default `claude-haiku-5-5`), `max_tokens` 4000, `output_config: { effort: "low", format: { type: "json_schema", … } }`, the fixed system prompt of `lib/prompt-insights.ts` (no prompt cache – it runs at most a few times a day) and one user turn holding the data. No `tools`, no MCP, no web access, no streaming, no `metadata`. The questions are data in a delimited block (`<` `>` become `‹` `›`):

  ```
  period: 2026-11-21 · questions in the period: 132 · given below: 132 (the newest)

  <questions>
  <q n="1" answered="no">Can Flowplan sync with Outlook?</q>
  <q n="2" answered="yes">How do backups work?</q>
  </questions>
  ```
- **Its own budget reservation** (`lib/limits.ts` `reserveInsight` / `settleInsight`): in one `BEGIN IMMEDIATE` transaction the monthly budget and the global cost limits (per day and month) are checked and the summary's **maximum cost** is reserved (every prompt byte at the cache-write price plus 4000 output tokens); afterwards the real cost from `usage` replaces it. Summaries count against the budget and the global cost limits like questions do, but never as questions (no question counts, no per-person limits); `/api/admin/summary` shows them as `month.insightsCostUsd`. A failed call costs nothing unless it may have been billed (timeout, dropped connection: the reserved worst case); a summary that died with the process is settled like that by the hourly clean-up.
- **The answer is untrusted text**: parsed as JSON (a code fence or text around the object is tolerated), at most 12 topics, 25 unanswered questions and 12 ideas, counts whole numbers between 0 and the number of questions, unknown fields dropped; every string passes the answer sanitiser (no HTML, links only to the allow-list, mentions defused) and the log's scrubber, on one line and bounded. No usable JSON (or a refusal, or `max_tokens`) → the summary is stored as failed (`invalid_answer`, `refusal`, `max_tokens`), its cost still counted.
- **Schedule** (`insights.interval`: `off` | `daily` (default) | `weekly`): an in-process timer (started with the server in `instrumentation.ts`, every 10 minutes) summarises the previous full period once – the UTC day, or the ISO week Monday to Sunday – shortly after it ends. Idempotent per period (a unique period in the table), one summary at a time (a pending one blocks every other, also across processes), a failed period is tried again on later ticks at most 3 times. A day without questions is stored as `empty` (no call, nothing spent). **Generate now** (`POST /api/admin/insights`) summarises the last 24 hours (daily) or 7 days (weekly or off).
- **Retention**: the summaries quote questions, so their content follows the log – it is cleared after `logging.retentionDays` and all of it when logging is turned off; the rows (cost, counts) stay for the budget and the statistics (400 days).
- **Cost** (Haiku 5.5 at $0.10 / $0.50 per million tokens): a typical daily summary of ~100–500 short questions is about 3,000–20,000 input and 1,000–2,000 output tokens, **≈ $0.001–0.003** (a month of daily summaries ≈ $0.05); the reserved worst case of a full 500-question prompt is about $0.01. With Sonnet 5.5 about 20×, with Opus 5.5 about 40× that.

## Public API

CORS: `Access-Control-Allow-Origin` only for the origins in `ASK_ALLOWED_ORIGINS` (default `https://docs.flowplan.org`), never with credentials; preflights (`OPTIONS`) allow `Content-Type, X-Ask-Session`. A browser request with any other `Origin` is refused (403). No cookies anywhere. Request bodies must be `application/json` (else 415) and are size-limited (413). Errors are JSON `{ error, message, … }`; times are ISO 8601.

### `GET /api/status`

```json
{ "docs": true, "discord": true, "name": "Flo" }
```

`docs`/`discord` are false when that source or Flo as a whole is switched off, no `ANTHROPIC_API_KEY` is set (Discord also without `ASK_BOT_TOKEN`), a global limit is reached, or the monthly budget can't cover one more typical question. `Cache-Control: public, max-age=60`. No secrets, no numbers.

### `POST /api/session` (docs only)

1. `{}` → `{ "challenge": "<token>", "difficulty": 16, "expiresAt": "…" }` (the challenge is valid 5 minutes).
2. The client finds the **smallest nonce ≥ 0** for which **SHA-256(challenge + nonce)** – the nonce in decimal digits, both as UTF-8, concatenated without separator – starts with `difficulty` zero bits (counted from the most significant bit of the first byte; about half a second in a Web Worker).
3. `{ "challenge": "…", "nonce": 12345 }` (number or decimal string) → `{ "sessionToken": "…", "expiresAt": "…" }`.

The session token is HMAC-signed, expires after 2 hours and carries only a random id. Each challenge works once. Errors: 400 `invalid_challenge` (bad, expired or used), `invalid_nonce`, `wrong_nonce`. Limits per hashed address: 60 challenges and 30 solved sessions per hour (429 as below). Keep the token in `sessionStorage` only.

### `POST /api/ask`

Docs: header `X-Ask-Session: <sessionToken>`. Discord: `Authorization: Bearer <ASK_BOT_TOKEN>` (server to server – a request with the bot token *and* an `Origin` header is refused).

```jsonc
{
  "question": "Wie richte ich einen Passkey ein?",
  "history": [{ "role": "user", "text": "…" }, { "role": "assistant", "text": "…" }], // optional
  "locale": "de",                 // "de" | "en" (anything else: en)
  "source": "docs",               // "docs" with a session token, "discord" with the bot token
  "page": "first-steps",          // docs, optional: the page slug the reader is on (ranking hint)
  "subject": "<bot's HMAC>",      // discord, required: 8–128 characters [A-Za-z0-9+/=_.:-]
  "channelId": "1234…",           // discord: for the channel allow-list only
  "roleIds": ["1234…"]            // discord: for the role allow-list only (the bot includes the guild id = @everyone)
}
```

→ `200 { "answer": "<markdown>", "sources": [{ "title": "First steps – Sign in or sign up", "url": "https://docs.flowplan.org/de/first-steps#…" }], "usage": { "remainingToday": 37 } }` (`remainingToday` is the subject's questions left today).

History: the newest `maxTurns` entries (each question and each answer counts as one), then the oldest dropped until all fit into `maxConversationChars`. `channelId`, `roleIds` and `subject` are never sent to Anthropic and never stored in clear.

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ error: "too_long", max }` | the question is longer than `maxQuestionChars` |
| 400 | `invalid_question`, `invalid_history`, `invalid_source`, `invalid_subject`, `invalid_channel`, `invalid_roles`, `invalid_json` | bad input |
| 401 | `invalid_session` | docs: session token missing, invalid or expired – solve a new challenge |
| 401 | `unauthorized` | wrong bot token (rate-limited per hashed address) |
| 403 | `cross_origin` | an `Origin` that is not allowed (or the bot token from a browser) |
| 403 | `not_allowed` | Discord: channel or roles not on the allow-list (when the lists are set) |
| 413 / 415 | `too_large` / `unsupported_media_type` | body over 32 KB / not JSON |
| 429 | `{ error: "limit", scope: "subject" \| "global" \| "budget", retryAt }` | a limit (also `Retry-After`); a blocked subject gets `scope: "subject"` until the next month |
| 503 | `{ error: "off" }` | Flo, this source, or the API key is off |
| 502 | `{ error: "upstream" }` / `{ error: "unavailable" }` | the Claude API failed / the docs can't be read – try again later |

### `GET /api/health`

`{ "service": "flowplan-ask", "status": "ok" }` – for Coolify's healthcheck.

## Bot API

For the Discord bot's moderators (server to server): `Authorization: Bearer <ASK_BOT_TOKEN>`, compared in constant time; without a bot token configured both paths answer **404**, a wrong token **401** (rate-limited per hashed address), a request with an `Origin` header **403**. JSON, no CORS headers. Only the bot can compute a Discord user's subject, so this is how Discord users get onto the [block list](#get--post--delete-apiadminblocklist).

- `POST /api/bot/block` `{ "subject": "<the bot's HMAC of the user id>", "note": "spam", "actor": "discord-mod" }` → `{ "short": "Ab3dE6gH9jK1" }` – adds the user (or changes the note), the same as the admin's `POST /api/admin/blocklist` with `source: "discord"`.
- `POST /api/bot/unblock` `{ "subject": "…", "actor": "discord-mod" }` → `{ "short": "…" }`; 404 when not on the list.

`short` is the short hash flowplan-admin shows for the entry. `actor` is optional and not stored; it must be `"discord-mod"` or the moderator's hashed id (8–128 characters `[A-Za-z0-9+/=_.:-]`) – never a name (400 `invalid_actor`). A bad `subject` is 400 `invalid_subject`.

## Limits and budget

All in the settings (admin). Counted only here, in SQLite, atomically (see "How it works").

- **Per subject** (a Discord user or a docs session): questions per minute and hour (sliding windows), per day and month (UTC calendar), and cost per day and month (USD).
- **Per hashed address** (docs, a fallback against new sessions per question): the subject's per-minute, -hour and -day counts × 3.
- **Global**: questions and cost per day and per month.
- **Insight summaries** count with their cost against the budget and the global cost limits (never as questions; see [Insights](#insights)).
- **Hard monthly budget** (USD): reached → every question gets 429 `budget` and `/api/status` turns false, until the next month (automatically, nothing to reset) or a raised budget (at once). A budget of 0 stops everything. The **warning threshold** (default 80 %) is shown in the admin summary.
- **Block list**: subjects (stored as HMACs; the admin sees a 12-character short hash and when it was last seen).

Costs are counted from `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) with the price table in `lib/models.ts` (USD per million tokens; cache write 1.25× input):

| Model | Input | Output | Cache read | Cache write |
| --- | --- | --- | --- | --- |
| `claude-haiku-5-5` (default) | 0.10 | 0.50 | 0.01 | 0.125 |
| `claude-sonnet-5-5` | 2 | 10 | 0.10 | 2.50 |
| `claude-opus-5-5` | 4 | 20 | 0.20 | 5 |

Haiku's price applies to prompts up to 100K tokens; prompts here stay far below (requests over 100 KB are trimmed: conversation first, then excerpts).

## Admin API

For flowplan-admin (server to server): every request needs `Authorization: Bearer <ASK_ADMIN_TOKEN>` (at least 24 characters), compared in constant time. Without a token configured (or a shorter one) every path answers **404**; a missing or wrong token **401** (rate-limited per hashed address). JSON, no CORS headers, `Cache-Control: no-store`, times ISO 8601, money in USD. Dates in `from`/`to` are `YYYY-MM-DD` (UTC, inclusive; default the last 30 days, at most 400).

### `GET /api/admin/settings` · `PUT /api/admin/settings`

```jsonc
{
  "enabled": { "global": true, "docs": true, "discord": true },
  "model": "claude-haiku-5-5",            // claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5
  "maxTokens": 700,                       // 100–4000
  "maxQuestionChars": 500,                // 50–4000
  "maxTurns": 6,                          // 0–20 history entries (question or answer each)
  "maxConversationChars": 4000,           // 500–50000, ≥ maxQuestionChars
  "limits": {
    "subject": { "perMinute": 3, "perHour": 20, "perDay": 40, "perMonth": 300, "costPerDayUsd": 0.25, "costPerMonthUsd": 2 },
    "global": { "perDay": 2000, "perMonth": 20000, "costPerDayUsd": 5, "costPerMonthUsd": 50 }
  },                                      // counts ≥ 1, USD ≥ 0.01; perMinute ≤ perHour ≤ perDay ≤ perMonth; costPerDay ≤ costPerMonth
  "monthlyBudgetUsd": 20,                 // 0–10000 (0 stops everything)
  "warnAtPercent": 80,                    // 1–100
  "discord": { "channelIds": [], "roleIds": [], "onLimit": "message" }, // ids: 17–20 digits, ≤ 50 each; empty = any; onLimit: message | readonly
  "logging": { "enabled": false, "retentionDays": 30 }, // 1–365
  "insights": { "interval": "daily", "model": "claude-haiku-5-5" } // interval: off | daily | weekly; model from the allow-list
}
```

`PUT` takes `{ "settings": { … }, "actor": "yannic" }` and returns the stored settings. Fields left out keep their value, unknown fields are ignored; a value out of range rejects the whole PUT with `400 { error: "invalid_settings", errors: ["maxTokens: integer 100–4000", …] }`. Turning logging off deletes the log and the insights' content. (The audit log is flowplan-admin's own.)

### `GET /api/admin/summary`

```jsonc
{
  "status": { "docs": true, "discord": true, "budgetReached": false, "warn": false },
  "month": { "questions": 812, "inputTokens": 2100000, "outputTokens": 120000, "costUsd": 0.41, "budgetUsd": 20, "percent": 2.1 },
  "today": { "questions": 31, "inputTokens": 80000, "outputTokens": 4600, "costUsd": 0.02 },
  "bySource": { "docs": { "questions": 600, … }, "discord": { "questions": 212, … } }, // month totals
  "rejected": { "subject": 4, "global": 0, "budget": 0, "off": 2 },                   // this month
  "errors": { "count": 3, "rate": 0.004 },                                             // this month, rate = errors / questions
  "latencyMs": { "p50": 1800, "p95": 4200 }                                            // this month; null without answers
}
```

`inputTokens` = input + cache read + cache write tokens. `costUsd` includes reservations of questions still in flight (as the budget does). `month.costUsd` and `month.percent` also include the [insight summaries](#insights) (they count against the budget), shown on their own as `month.insightsCostUsd`; `today`, `bySource` and `/usage` are questions only.

### `GET /api/admin/usage?from=&to=&granularity=day`

`{ "days": [{ "date": "2026-11-18", "source": "docs", "questions", "inputTokens", "outputTokens", "cacheReadTokens", "costUsd", "rejected", "errors", "p50", "p95" }] }` – one row per day and source with activity, oldest first. Only `granularity=day`.

### `GET /api/admin/topics?from=&to=`

`{ "from", "to", "pages": [{ "title", "url", "count" }], "keywords": [{ "keyword", "count" }] }` – the doc pages linked in answers and the words of questions that are also words of the docs (so names or addresses typed into a question are never counted). Top 25 each.

### `GET · POST · DELETE /api/admin/blocklist`

- `GET` → `{ "entries": [{ "subject": "Ab3dE6gH9jK1", "source": "discord", "note": "spam", "createdAt": "…", "lastSeen": "…" | null }] }` (`subject` is the short hash).
- `POST { subject, source: "docs" | "discord", note, actor }` – an upsert: `subject` is what the client sends as the subject (Discord: the bot's HMAC of the user; docs: a session token) or the short hash of an entry already on the list (changes its note). → `{ entries }`.
- `DELETE /api/admin/blocklist?subject=<short hash>` (or body `{ subject, actor }`) → `{ entries }`; 404 when not on the list.

### `GET /api/admin/log?from=&to=&limit=&cursor=`

```jsonc
{
  "enabled": true, "retentionDays": 30,
  "entries": [{ "id": 12, "at": "…", "source": "docs", "locale": "de", "question": "…", "answer": "…",
                "sources": [{ "title", "url" }], "model": "claude-haiku-5-5", "inputTokens": 2100, "outputTokens": 150,
                "costUsd": 0.000204, "latencyMs": 1830, "outcome": "ok" }],   // outcome: ok | refusal | max_tokens
  "nextCursor": "…" // null on the last page
}
```

Newest first, `limit` 1–500 (default 100). With logging off: `{ "enabled": false, "entries": [] }`. Entries are anonymised: no subject, no session, no Discord or IP data; e-mail addresses, phone numbers, IP addresses and long tokens in the text are masked.

### `GET · POST /api/admin/insights`

The [insight summaries](#insights).

- `GET /api/admin/insights?limit=` (1–100, default 30) → newest first, without the content:

  ```jsonc
  {
    "enabled": true,               // false while the Q&A log is off – then "entries" is empty
    "interval": "daily", "model": "claude-haiku-5-5", "retentionDays": 30, "maxQuestions": 500,
    "running": false,              // a summary is being generated
    "nextRunAt": "2026-11-23T00:00:00.000Z", // null when off or the log is off
    "entries": [{ "id": 12, "createdAt": "…", "kind": "scheduled", "interval": "daily", "period": "2026-11-21",
                  "label": "2026-11-21", "from": "…", "to": "…",
                  "status": "ok",          // pending | ok | empty (no questions, no call) | error
                  "error": null,           // upstream | invalid_answer | max_tokens | refusal | interrupted
                  "model": "claude-haiku-5-5", "questions": 132, "sent": 132, "unanswered": 9, "refused": 2,
                  "costUsd": 0.0021, "inputTokens": 14200, "outputTokens": 1300, "latencyMs": 9800,
                  "topTopics": ["Database views", "Self-hosting", "Formulas"], "ideas": 3 }]
  }
  ```
  `kind` is `scheduled` or `manual`; `period` is `YYYY-MM-DD` or `YYYY-Www` (ISO week) for scheduled ones, null for manual ones; `label` is the period as shown (a date or `from – to`).
- `GET /api/admin/insights?id=12` → `{ "entry": { …the fields above without topTopics/ideas…, "result": { "topics": [{ "title", "count" }], "unanswered": [{ "question", "count", "note" }], "ideas": [{ "kind": "docs" | "feature", "title", "detail" }] } | null, "prompt": "Here are the open questions from Flo users …" | null } }`; 404 `not_found` (also once its content is purged), 400 `invalid_id`.
- `POST /api/admin/insights` `{ "actor": "yannic" }` – **Generate now**, synchronous (up to about a minute) → `{ "entry": { … as with ?id= } }` (status `ok`, `empty` or `error`). Errors: 409 `log_off` (the Q&A log is off), 409 `busy` (one is running), 503 `off` (no API key), 429 `{ error: "limit", scope: "budget" | "global" }`, 502 `upstream`.

The interval and the model are part of the settings (`insights`).

### `GET /api/admin/export?format=csv&from=&to=`

The daily usage (fields as in `/usage`) as a CSV download: header line, RFC 4180 quoting, CRLF; cells starting with `= + - @` get a leading `'`.

## Security and privacy

- **Secrets only from the environment**: `ANTHROPIC_API_KEY` is read by the SDK (`new Anthropic()`), never logged, never returned; failed API calls are logged only as status, error type and request id – never the message or headers. `ASK_ADMIN_TOKEN` and `ASK_BOT_TOKEN` must be at least 24 characters, are compared in constant time and must differ. `ASK_SECRET` (or a key generated once into the data directory, mode 600) signs session tokens and challenges and keys every HMAC.
- **Nothing personal goes to Anthropic**: only the question, the bounded conversation and doc excerpts. No names, Discord ids, channel or role ids, IP addresses, session tokens or subjects; no `metadata.user_id`. The insight summary gets only the scrubbed question texts of the anonymised log and whether each was answered.
- **Prompt injection**: question, conversation and docs are delimited data; the system prompt forbids following instructions in them, revealing itself, role play and non-Flowplan topics; and whatever the model returns passes the sanitiser and the prompt-leak check. The model has no tools, so an injection can at most change the text of one answer.
- **Abuse**: proof-of-work sessions, per-subject, per-address, global and budget limits, the block list, body size and length limits, 2-hour sessions. The SDK retries a failed call at most once (45 s timeout); a request that died with the process keeps its reserved cost.
- **No IP addresses stored**: addresses are used only through `ipKey()`, a daily rotating HMAC. Subjects are HMACs and are emptied from the ledger after 40 days (the counts stay for the statistics, 400 days).
- **No cookies, no tracking**, no external fonts or scripts. A strict Content Security Policy on the page (`proxy.ts`): scripts only with the per-request nonce, no inline scripts or style attributes, no framing, no external hosts.
- **Logging is off by default.** When on: anonymised (see the log above), deleted after `retentionDays` (checked hourly), all deleted when turned off – the insights' content with it. The landing page says whether it is on.
- Notice shown to people (docs panel and `/ask`): „Deine Frage geht an Anthropic (Claude) und wird nur aus den öffentlichen Docs beantwortet.“ / "Your question goes to Anthropic (Claude) and is answered only from the public docs."

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `ASK_URL` | yes | The public base URL, e.g. `https://ask.flowplan.org`. |
| `ANTHROPIC_API_KEY` | yes | Claude API key. Without it Flo is off (status false, 503). |
| `ASK_ADMIN_TOKEN` | for flowplan-admin | Bearer token of the admin API, ≥ 24 characters (`openssl rand -hex 32`); the same value goes into flowplan-admin. Unset: admin API 404. |
| `ASK_BOT_TOKEN` | for Discord | Bearer token of the Discord bot, ≥ 24 characters, not the admin token; the same value goes into the bot. Unset: no Discord questions. |
| `ASK_SECRET` | – | HMAC key (≥ 32 characters, `openssl rand -hex 32`). Unset: generated once into the data directory. Changing it ends all sessions and resets the per-subject counts. |
| `DOCS_URL` | – | The public docs (default `https://docs.flowplan.org`). |
| `ASK_ALLOWED_ORIGINS` | – | Origins allowed to call the public API from a browser, comma-separated (default `https://docs.flowplan.org`; the list replaces the default). |
| `ASK_DATA_DIR` | – | Directory for the SQLite database and the generated key (default `./data`; `/app/data` in the image). |
| `PORT` | – | Port of the server (default 3000). |

See [`.env.example`](.env.example).

## Deploy (Coolify)

The image is built on every push to main and published as `ghcr.io/yannicschuller/flowplan-ask:latest` (and `:sha-…`), for linux/amd64 and linux/arm64.

1. **DNS**: an `A`/`AAAA` record for `ask.flowplan.org` pointing to the Coolify server.
2. **Anthropic**: in the [Claude Console](https://console.anthropic.com) create an API key for this service (ideally in its own workspace) and set a **monthly spend limit** there (Settings → Limits) a little above `monthlyBudgetUsd` – a second, independent stop in case anything goes wrong here.
3. In Coolify, create a resource from the image (or the Dockerfile), port 3000, domain `ask.flowplan.org`, with a persistent volume at `/app/data`.
4. Set the environment variables above: `ASK_URL=https://ask.flowplan.org`, `ANTHROPIC_API_KEY`, `ASK_ADMIN_TOKEN`, `ASK_BOT_TOKEN`, ideally `ASK_SECRET`.
5. Coolify's reverse proxy terminates TLS and sets `X-Forwarded-For`; the healthcheck is `GET /api/health`.
6. Optional: the repository secrets `COOLIFY_WEBHOOK` and `COOLIFY_TOKEN` let the Docker workflow roll out every new `:latest`.
7. flowplan-admin: `ASK_URL` and the same `ASK_ADMIN_TOKEN`. Discord bot: the service URL and the same `ASK_BOT_TOKEN` (for `discord.onLimit = "readonly"` it needs the Manage Channels permission). Docs: `ASK_URL` (default `https://ask.flowplan.org`).

## Local development

```sh
npm ci
cp .env.example .env.local   # fill in what you need
npm run dev                  # http://127.0.0.1:3000
```

Checks (all must be green before a commit):

```sh
npm run typecheck
npm test            # unit and route tests, no network (Claude API and docs are local mocks)
npm run build
npm run test:browser   # after the build: the landing page in Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE to use an installed one)
```

The tests run against a fake Claude API (`tests/anthropic-mock.ts`, reached through the SDK's `baseURL`; it records every request so the tests can assert there are no tools, a cached system prompt, the settings' model and `max_tokens`, and nothing personal) and fake docs (`tests/docs-mock.ts`). Tokens and keys are throwaway values generated at runtime.

## License

[AGPL-3.0-only](LICENSE), like Flowplan.
