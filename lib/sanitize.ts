// The model's answer before it leaves the service: a plain Markdown subset
// (paragraphs, lists, bold/italic, inline code, code blocks, links), no
// HTML, links only to the allow-list, bounded length. Clients still render
// it as text or safe Markdown – never as HTML. Also defuses what Discord
// would act on (mass mentions, user/role/channel tags, spoilers).
import { DISCORD_INVITE, config } from "./config";
import type { Locale } from "./docs";

export const MAX_ANSWER_CHARS = 4000;
const MAX_INPUT_CHARS = 20_000;

// The links an answer may keep (README "Answers"): the docs, the website,
// Flowplan's GitHub repositories and the Discord invite – plus the origin
// of the configured DOCS_URL (the same docs in production).
export function allowedLink(raw: string, docsOrigin = config.docsOrigin()): string | null {
  if (!/^https?:\/\/\S+$/i.test(raw) || raw.length > 600) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  // A path with "//" or a backslash can turn into a protocol-relative link
  // ("//evil.com/…") once a client shortens a docs URL to its path.
  if (/\/\/|\\/.test(u.pathname) || /%2f%2f|%5c/i.test(u.pathname)) return null;
  const href = u.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  // The configured docs, exactly as configured (https in production).
  if (u.origin === docsOrigin) return href;
  if (u.protocol !== "https:" || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (host === "docs.flowplan.org" || host === "flowplan.org") return href;
  if (host === "github.com" && /^\/yannicschuller\/flowplan[A-Za-z0-9._-]*(\/|$)/.test(u.pathname)) return href;
  const invite = new URL(DISCORD_INVITE);
  if (host === invite.hostname && u.pathname.replace(/\/+$/, "") === invite.pathname && !u.search && !u.hash) return DISCORD_INVITE;
  return null;
}

// Control, bidi, zero-width and private-use characters (the latter are the
// placeholders below, so the input cannot forge them).
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ue000-\uf8ff]/g;

const removed = (locale: Locale) => (locale === "de" ? "[Link entfernt]" : "[link removed]");
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

function bareUrls(text: string, locale: Locale, keep: (s: string) => string) {
  return text.replace(URL_RE, (match) => {
    // Closing punctuation after a URL belongs to the sentence.
    const trail = /[.,;:!?)\]}*_]+$/.exec(match)?.[0] ?? "";
    const url = trail ? match.slice(0, -trail.length) : match;
    const ok = allowedLink(url);
    return (ok ? keep(ok) : removed(locale)) + trail;
  });
}

function inline(text: string, locale: Locale) {
  const held: string[] = [];
  const hold = (s: string) => `\ue000${held.push(s) - 1}\ue001`;
  let s = text;
  // Inline code: kept as it is (rendered as code, never as a link or HTML).
  s = s.replace(/(`+)([^`\n]{1,500}?)\1/g, (_, _ticks: string, code: string) => hold(`\`${code.replace(/`/g, "'")}\``));
  // HTML tags and Discord's tags (<@id>, <#id>, <:emoji:id>, <t:…>); <https://…> autolinks keep their address.
  s = s.replace(/<(https?:\/\/[^\s<>]+)>/gi, " $1 ");
  s = s.replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\/?>/g, "");
  s = s.replace(/<(?:[@#][!&]?\d*|a?:\w*:\d*|\/[\w -]+:\d*|t:\d+(?::\w)?)>/g, "");
  // Images: their text only.
  s = s.replace(/!\[([^\]\n]{0,300})\]\([^)\n]*\)/g, "$1");
  // Links: kept with an allowed address, else only their text.
  s = s.replace(/\[([^\]\n]{0,300})\]\(\s*<?([^)\s>]{0,600})>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g, (_, label: string, href: string) => {
    const ok = allowedLink(href);
    // The label gets the same clean-up as the rest of the text (mass
    // mentions, tag starts) – it is held back before those steps run.
    const text = label
      .replace(/[[\]]/g, "")
      .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\/?>/g, "")
      .replace(/@(everyone|here)\b/gi, "@​$1")
      .replace(/<(?=[A-Za-z/!?@#:])/g, "‹")
      .trim();
    if (ok) return hold(`[${text ? bareUrls(text, locale, (u) => u) : ok}](${ok})`);
    return text;
  });
  // Reference links: their text.
  s = s.replace(/\[([^\]\n]{1,300})\]\[[^\]\n]{0,100}\]/g, "$1");
  s = bareUrls(s, locale, hold);
  // Strikethrough and Discord spoilers are not part of the subset.
  s = s.replace(/~~/g, "").replace(/\|\|/g, "");
  // Mass mentions.
  s = s.replace(/@(everyone|here)\b/gi, "@\u200b$1");
  // Anything left that looks like the start of a tag is shown as a lookalike.
  s = s.replace(/<(?=[A-Za-z/!?@#:])/g, "‹");
  // Held parts may hold others (code inside a link text).
  for (let i = 0; i < 3 && s.includes("\ue000"); i++) s = s.replace(/\ue000(\d+)\ue001/g, (_, n: string) => held[Number(n)] ?? "");
  return s.replace(/[\ue000\ue001]/g, "");
}

function block(line: string) {
  let l = line;
  // Reference definitions, rules and table rulers are dropped.
  if (/^\s{0,3}\[[^\]]+\]:\s*\S+/.test(l)) return null;
  // Blockquotes lose the marker, headings become bold, rules and table rulers go.
  for (let i = 0; i < 5 && /^\s{0,3}>/.test(l); i++) l = l.replace(/^\s{0,3}>\s?/, "");
  const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
  if (h) return h[1] ? `**${h[1].replace(/\*\*/g, "")}**` : "";
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) return null;
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)) return null;
  if (/^\s{0,3}(=+|-+)\s*$/.test(l)) return null;
  // Discord's small text ("-# …").
  l = l.replace(/^(\s*)-#\s+/, "$1");
  return l;
}

export function sanitizeAnswer(input: string, locale: Locale): string {
  let text = (input || "").slice(0, MAX_INPUT_CHARS).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(INVISIBLE, "");
  text = text.replace(/<!--[\s\S]*?(-->|$)/g, "");
  const out: string[] = [];
  let code: { fence: string; lines: string[]; lang: string } | null = null;
  for (const line of text.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9+#.-]{0,20})?.*$/.exec(line);
    if (code) {
      if (f && f[1][0] === code.fence[0] && f[1].length >= code.fence.length && !f[2]) {
        out.push("```" + code.lang, ...code.lines, "```");
        code = null;
      } else code.lines.push(line.replace(/```/g, "'''"));
      continue;
    }
    if (f) {
      code = { fence: f[1], lines: [], lang: (f[2] || "").toLowerCase() };
      continue;
    }
    const b = block(line);
    if (b === null) continue;
    out.push(inline(b, locale));
  }
  if (code) out.push("```" + code.lang, ...code.lines, "```");
  let result = out
    .join("\n")
    .replace(/[ \u00a0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (result.length > MAX_ANSWER_CHARS) {
    let cut = result.slice(0, MAX_ANSWER_CHARS - 6);
    const space = cut.search(/\s\S*$/);
    if (space > MAX_ANSWER_CHARS / 2) cut = cut.slice(0, space);
    // A cut inside a link drops the unfinished link.
    cut = cut.replace(/\[[^\]\n]*(\]\([^)\n]*)?$/, "");
    const fences = (cut.match(/^```/gm) || []).length;
    result = `${cut.trimEnd()} …${fences % 2 ? "\n```" : ""}`;
  }
  return result;
}

// The links of a sanitised answer (all of them are allowed ones).
export function linksIn(answer: string) {
  const out: string[] = [];
  for (const m of answer.matchAll(/\]\((https?:\/\/[^)\s]+)\)|(?<![(\w])(https?:\/\/[^\s)\]]+)/g)) out.push((m[1] || m[2]).replace(/[.,;:!?]+$/, ""));
  return [...new Set(out)];
}

// One short text of an insight summary (a topic, a question, a note):
// the same rules as an answer (no HTML, links only to the allow-list,
// mentions defused, invisible characters out), then on one line, without
// Markdown emphasis or code fences, at most `max` characters.
export function sanitizeInsightText(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  const clean = sanitizeAnswer(input.slice(0, 4 * max), "en")
    .replace(/```[a-z0-9+#.-]*/gi, " ")
    .replace(/\*\*|__|(?<![\w*])\*(?!\s)|(?<!\s)\*(?![\w*])/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 2);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/\[[^\]]*(\]\([^)]*)?$/, "").trimEnd()} …`;
}
