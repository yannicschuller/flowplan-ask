<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## This repository

- Domain logic lives in `lib/` and works on plain `Request`/`Response`; `app/api/**` only forwards to `lib/routes.ts` (`publicRoute(request, () => route(request))` for the public API, `handle(() => adminRoute(…))` / `handle(() => botRoute(…))` for the admin and bot APIs). Keep it that way so `tests/` can call it without Next.js.
- The public API (`/api/status`, `/api/session`, `/api/ask`) is a contract with flowplan-docs (the „Frag Flo“ widget) and flowplan-discord-bot; the bot API (`lib/bot.ts`, `/api/bot/*`) one with flowplan-discord-bot; the admin API (`lib/admin.ts`, `/api/admin/*`) one with flowplan-admin. Both are described in the README. Paths, field names, error shapes and the proof-of-work format change only together with those repositories.
- Exactly one `client.messages.create` per question (`lib/claude.ts`): no tools, no MCP, no web access. The periodic insights summary (`lib/insights.ts`, #429) is its own, separate call over the anonymised Q&A log only – same rules: no tools, nothing personal, budget reserved and settled through `lib/limits.ts`. The system prompt (`lib/prompt.ts`) is fixed in code and cached; the docs excerpts, the conversation and the question are data inside delimited blocks. Never put anything personal (names, Discord ids, addresses, session tokens, subjects) into a request to Anthropic.
- Every answer passes `lib/sanitize.ts` (Markdown subset, no HTML, link allow-list, length) before it leaves the service. Change the allow-list only together with flowplan-docs and flowplan-discord-bot.
- Limits and budget are counted only here (`lib/limits.ts`): check and reserve the maximum cost in one transaction before the call, settle with the real cost from `usage` afterwards. Prices live in `lib/models.ts`; models only from its allow-list, without date suffixes.
- UI texts in German and English side by side: `t("Deutsch", "English")`, German informal "du". Code comments, README and commits in English.
- No inline scripts or style attributes (strict CSP in `proxy.ts`), no cookies, no tracking, never store IP addresses (use `ipKey()`), subjects only as HMACs (`lib/subjects.ts`). The Q&A log is off by default and anonymised (`lib/qalog.ts`).
- Secrets only from environment variables – never in code, tests, fixtures, logs or commits; never log an Anthropic error's message. Tests generate throwaway tokens at runtime and use a local Anthropic mock (`tests/anthropic-mock.ts`, via the SDK's `baseURL`) and docs mock (`tests/docs-mock.ts`), never the network.
- Schema changes only as a new numbered migration in `lib/db.ts`.
- Checks: `npm run typecheck`, `npm test`, `npm run build`; the browser smoke test of the landing page is `npm run test:browser`.
