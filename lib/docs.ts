// The docs Flo answers from: `${DOCS_URL}/llms.txt` (English) and
// `${DOCS_URL}/de/llms.txt` (German) list every page with its Markdown
// address; the pages are fetched, cut into sections at their `##` headings
// (long ones again at `###`) and kept in memory, refreshed every few hours.
// Only addresses below DOCS_URL are ever fetched. A question gets the best
// sections by BM25 (title and heading count more), within a size budget,
// each with its URL (page + #anchor, the same ids as the docs site).
// `${DOCS_URL}/keywords.json` and `/de/keywords.json` ({slug: [keywords]},
// the pages' front-matter keywords) are loaded with the lists; a page's
// keywords are one more field of the ranking. Without that file Flo ranks
// on the pages alone.
import { config } from "./config";
import { fold, stem, synonymsOf, terms, words } from "./text";
import { now } from "./clock";

export type Locale = "de" | "en";
export const LOCALES: Locale[] = ["en", "de"];
export const isLocale = (v: unknown): v is Locale => v === "de" || v === "en";

export type Section = {
  locale: Locale;
  slug: string;
  pageTitle: string;
  heading: string;
  url: string;
  text: string;
  tf: Map<string, number>;
  length: number;
  // The page's first section (its title and lead).
  intro: boolean;
};
// `keywords`: per page, the terms of its keywords with their counts.
type LocaleIndex = { sections: Section[]; df: Map<string, number>; avgLength: number; pages: number; keywords: Map<string, Map<string, number>> };
// `fresh`: the languages loaded this time (the others kept from before).
export type DocsIndex = { loadedAt: number; base: string; locales: Partial<Record<Locale, LocaleIndex>>; vocabulary: Set<string>; fresh: Locale[] };

export const REFRESH_MS = 3 * 3_600_000;
const RETRY_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_INDEX_BYTES = 1_000_000;
const MAX_PAGE_BYTES = 400_000;
const MAX_PAGES = 400;
const MAX_KEYWORDS_BYTES = 200_000;
const MAX_KEYWORDS = 40;
const CONCURRENCY = 8;
// The docs part of a prompt: about 8,000 tokens at most.
export const DOCS_BUDGET_CHARS = 24_000;
const MAX_SECTION_CHARS = 6_000;
const SPLIT_AT_CHARS = 3_000;
export const MAX_SECTIONS = 6;

// ---- Fetching ----

// Redirects are followed only within the docs' own origin.
async function fetchText(url: string, limit: number): Promise<string | null> {
  try {
    const origin = new URL(url).origin;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "text/markdown, text/plain" } });
    if (!res.ok || !res.body || (res.url && new URL(res.url).origin !== origin)) {
      await res.body?.cancel();
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

export type Entry = { title: string; slug: string; mdUrl: string; summary: string };
// The pages of one language from llms.txt – only Markdown pages directly below DOCS_URL/<locale>/.
export function parseLlms(text: string, base: string, locale: Locale): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  const prefix = `${base}/${locale}/`;
  for (const line of text.split("\n")) {
    const m = /^- \[([^\]]{1,200})\]\((\S{1,400})\)(?::\s*(.*))?$/.exec(line.trim());
    if (!m || !m[2].startsWith(prefix) || !m[2].endsWith(".md")) continue;
    const slug = m[2].slice(prefix.length, -3);
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ title: m[1], slug, mdUrl: m[2], summary: (m[3] || "").slice(0, 400) });
    if (out.length >= MAX_PAGES) break;
  }
  return out;
}

// keywords.json: {slug: [keyword, …]}. Anything that is not such an object
// counts as no keywords; odd entries are skipped, long lists cut.
export function parseKeywords(text: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!text) return out;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [slug, list] of Object.entries(data as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug) || !Array.isArray(list)) continue;
    const keywords = list.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 100).slice(0, MAX_KEYWORDS);
    if (keywords.length) out.set(slug, keywords);
    if (out.size >= MAX_PAGES) break;
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---- Cutting pages into sections ----

// The anchor id of a heading, as flowplan-docs/lib/docs.ts headingId()
// makes it (version notes like "(since 0.9.6)" are not part of it).
export function headingId(text: string) {
  return text
    .replace(/\s*\((?:[^()]*\d+\.\d+\.\d+[^()]*)\)\s*$/, "")
    .replace(/\{since=[^}]*\}/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
const headingText = (raw: string) =>
  raw
    .replace(/\{since=[^}]*\}/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();

// Relative links of the docs become absolute; images, HTML comments and callout markers go.
function cleanBody(text: string, base: string, locale: Locale) {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\]\(\/(?!\/)([a-z0-9-]*)(#[a-z0-9-]*)?\)/g, (_, slug: string, hash = "") => `](${base}/${locale}/${slug}${hash})`)
    .replace(/^>\s*\[!(\w+)\]\s*$/gm, (_, kind: string) => `> ${kind[0]}${kind.slice(1).toLowerCase()}:`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Raw = { heading: string; anchor: string; parent?: string; lines: string[]; level: number };
export function splitPage(markdown: string, entry: Entry, base: string, locale: Locale) {
  let body = markdown.replace(/\r\n?/g, "\n");
  const fm = /^---\n[\s\S]*?\n---\n/.exec(body);
  if (fm) body = body.slice(fm[0].length);
  let pageTitle = entry.title;
  const lines = body.split("\n");
  const used = new Set<string>();
  const parts: Raw[] = [{ heading: "", anchor: "", lines: [], level: 1 }];
  let fence: string | null = null;
  let h2: Raw | null = null;
  for (const line of lines) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      parts[parts.length - 1].lines.push(line);
      continue;
    }
    const h = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) {
      parts[parts.length - 1].lines.push(line);
      continue;
    }
    const level = h[1].length;
    if (level === 1) {
      pageTitle = headingText(h[2]) || pageTitle;
      continue;
    }
    const idBase = headingId(h[2]) || (locale === "en" ? "section" : "abschnitt");
    let id = idBase;
    for (let n = 2; used.has(id); n++) id = `${idBase}-${n}`;
    used.add(id);
    if (level === 2) {
      h2 = { heading: headingText(h[2]), anchor: id, lines: [], level: 2 };
      parts.push(h2);
    } else if (level === 3 && h2) {
      parts.push({ heading: headingText(h[2]), anchor: id, parent: h2.heading, lines: [line], level: 3 });
    } else parts[parts.length - 1].lines.push(line);
  }
  // `###` parts stay separate only where their `##` section is long.
  const merged: Raw[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.level !== 2) {
      if (p.level === 1) merged.push(p);
      continue;
    }
    const subs: Raw[] = [];
    for (let j = i + 1; j < parts.length && parts[j].level === 3; j++) subs.push(parts[j]);
    const total = p.lines.join("\n").length + subs.reduce((n, s) => n + s.lines.join("\n").length, 0);
    if (total <= SPLIT_AT_CHARS || !subs.length) merged.push({ ...p, lines: [...p.lines, ...subs.flatMap((s) => s.lines)] });
    else merged.push(p, ...subs);
  }
  const pageUrl = `${base}/${locale}/${entry.slug}`;
  const sections: Section[] = [];
  for (const p of merged) {
    let text = cleanBody(p.lines.join("\n"), base, locale);
    if (!p.heading && !text) continue;
    if (!p.heading && entry.summary && !text.includes(entry.summary)) text = `${entry.summary}\n\n${text}`.trim();
    if (text.length > MAX_SECTION_CHARS) text = `${text.slice(0, MAX_SECTION_CHARS).replace(/\s+\S*$/, "")} …`;
    const heading = p.parent ? `${p.parent} › ${p.heading}` : p.heading;
    const tf = new Map<string, number>();
    const add = (t: string, weight: number) => tf.set(t, (tf.get(t) ?? 0) + weight);
    for (const t of terms(pageTitle)) add(t, 2);
    for (const t of terms(heading)) add(t, 3);
    for (const t of terms(text)) add(t, 1);
    let length = 0;
    for (const v of tf.values()) length += v;
    sections.push({ locale, slug: entry.slug, pageTitle, heading, url: p.anchor ? `${pageUrl}#${p.anchor}` : pageUrl, text, tf, length, intro: !sections.length });
  }
  return sections;
}

function buildLocale(sections: Section[], pages: number, keywordLists = new Map<string, string[]>()): LocaleIndex {
  const df = new Map<string, number>();
  let total = 0;
  for (const s of sections) {
    total += s.length;
    for (const t of s.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // Keywords only of pages that are in the index.
  const slugs = new Set(sections.map((s) => s.slug));
  const keywords = new Map<string, Map<string, number>>();
  for (const [slug, list] of keywordLists) {
    if (!slugs.has(slug)) continue;
    const tf = new Map<string, number>();
    for (const t of list.flatMap((k) => terms(k))) tf.set(t, (tf.get(t) ?? 0) + 1);
    if (tf.size) keywords.set(slug, tf);
  }
  return { sections, df, avgLength: sections.length ? total / sections.length : 1, pages, keywords };
}

export async function loadIndex(base = config.docsUrl(), previous?: DocsIndex | null): Promise<DocsIndex> {
  const locales: Partial<Record<Locale, LocaleIndex>> = {};
  const fresh: Locale[] = [];
  for (const locale of LOCALES) {
    const prefix = locale === "en" ? base : `${base}/${locale}`;
    const [list, keywords] = await Promise.all([fetchText(`${prefix}/llms.txt`, MAX_INDEX_BYTES), fetchText(`${prefix}/keywords.json`, MAX_KEYWORDS_BYTES)]);
    const entries = list ? parseLlms(list, base, locale) : [];
    const pages = await pool(entries, CONCURRENCY, async (e) => {
      const md = await fetchText(e.mdUrl, MAX_PAGE_BYTES);
      return md ? splitPage(md, e, base, locale) : [];
    });
    const loaded = pages.filter((p) => p.length).length;
    // A language that failed to load keeps its previous sections.
    if (loaded) {
      locales[locale] = buildLocale(pages.flat(), loaded, parseKeywords(keywords));
      fresh.push(locale);
    }
    else if (previous?.base === base && previous.locales[locale]) locales[locale] = previous.locales[locale];
  }
  const vocabulary = new Set<string>();
  for (const l of Object.values(locales)) {
    for (const t of l!.df.keys()) vocabulary.add(t);
    for (const tf of l!.keywords.values()) for (const t of tf.keys()) vocabulary.add(t);
  }
  return { loadedAt: now(), base, locales, vocabulary, fresh };
}

// ---- The cached index ----

type Holder = { index: DocsIndex | null; loading: Promise<DocsIndex | null> | null; failedAt: number };
const holder = globalThis as unknown as { askDocs?: Holder };
const state = (): Holder => (holder.askDocs ??= { index: null, loading: null, failedAt: 0 });
const sectionCount = (i: DocsIndex | null) => Object.values(i?.locales ?? {}).reduce((n, l) => n + (l?.sections.length ?? 0), 0);

export function refreshDocs(): Promise<DocsIndex | null> {
  const s = state();
  if (s.loading) return s.loading;
  const base = config.docsUrl();
  s.loading = loadIndex(base, s.index)
    .then((index) => {
      if (index.fresh.length && sectionCount(index)) {
        s.index = index;
        s.failedAt = 0;
        console.log(`docs: ${Object.entries(index.locales).map(([l, x]) => `${x!.pages} ${l} pages`).join(", ")} indexed`);
      } else {
        s.failedAt = now();
        console.error("docs: no pages could be loaded – keeping the previous index");
      }
      return s.index;
    })
    .catch(() => {
      s.failedAt = now();
      return s.index;
    })
    .finally(() => {
      s.loading = null;
    });
  return s.loading;
}

// The index; loads it on first use (waiting at most `waitMs`) and refreshes
// it in the background when it is older than REFRESH_MS.
export async function docsIndex(waitMs = 15_000): Promise<DocsIndex | null> {
  const s = state();
  const base = config.docsUrl();
  const fresh = s.index && s.index.base === base;
  if (fresh && now() - s.index!.loadedAt < REFRESH_MS) return s.index;
  const mayRetry = now() - s.failedAt >= RETRY_MS;
  if (fresh) {
    if (mayRetry) void refreshDocs();
    return s.index;
  }
  if (!mayRetry && !s.loading) return null;
  const loading = refreshDocs();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs).unref?.());
  const index = await Promise.race([loading, timeout]);
  return index && index.base === base ? index : null;
}
export const forgetDocs = () => {
  holder.askDocs = undefined;
};
export const docsLoaded = () => sectionCount(state().index) > 0;

// ---- Ranking ----

export type Hit = { section: Section; score: number };
const K1 = 1.2;
const B = 0.75;
// How much a page's keywords count against a section's own text (whose
// title and heading already weigh 2 and 3).
const KEYWORD_WEIGHT = 0.5;

export function rank(index: DocsIndex, query: string, locale: Locale, page?: string): Hit[] {
  const l = index.locales[locale] ?? index.locales[locale === "de" ? "en" : "de"];
  if (!l || !l.sections.length) return [];
  const q = new Map<string, number>();
  for (const t of terms(query)) q.set(t, 1);
  for (const t of [...q.keys()]) for (const s of synonymsOf(t)) if (!q.has(s)) q.set(s, 0.5);
  if (!q.size) return [];
  const n = l.sections.length;
  const idf = new Map([...q.keys()].map((t) => [t, Math.log(1 + (n - (l.df.get(t) ?? 0) + 0.5) / ((l.df.get(t) ?? 0) + 0.5))]));
  const phrase = fold(query).replace(/\s+/g, " ").trim();
  // A page's keywords as a field of their own: the terms' weight from the
  // sections, saturated like BM25 (no length normalisation, the lists are
  // short). They count for the page's intro and for each of its sections
  // that matches the question itself – so they lift the page, and its text
  // still decides which section.
  const kwScores = new Map<string, number>();
  for (const [slug, tf] of l.keywords) {
    let score = 0;
    for (const [t, weight] of q) {
      const f = tf.get(t);
      if (!f) continue;
      score += weight * idf.get(t)! * ((f * (K1 + 1)) / (f + K1));
    }
    if (score) kwScores.set(slug, score * KEYWORD_WEIGHT);
  }
  const hits: Hit[] = [];
  for (const section of l.sections) {
    let score = 0;
    for (const [t, weight] of q) {
      const tf = section.tf.get(t);
      if (!tf) continue;
      // A section shorter than half the average counts as half the average:
      // a one-line intro does not outrank a full section only for being short.
      score += weight * idf.get(t)! * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * Math.max(section.length, l.avgLength / 2)) / l.avgLength)));
    }
    if (score || section.intro) score += kwScores.get(section.slug) ?? 0;
    if (!score) continue;
    if (phrase.length >= 8 && phrase.split(" ").length >= 2 && fold(section.text).includes(phrase)) score *= 1.3;
    if (page && section.slug === page) score *= 1.25;
    hits.push({ section, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

// The sections for a prompt: the best ones, at most MAX_SECTIONS and
// DOCS_BUDGET_CHARS, none far below the best.
export function pickSections(index: DocsIndex, query: string, locale: Locale, page?: string, budget = DOCS_BUDGET_CHARS): Section[] {
  const hits = rank(index, query, locale, page);
  if (!hits.length) return [];
  const top = hits[0].score;
  const out: Section[] = [];
  let used = 0;
  for (const h of hits) {
    if (out.length >= MAX_SECTIONS || h.score < top * 0.25) break;
    const size = h.section.text.length + h.section.heading.length + h.section.pageTitle.length + 100;
    if (used + size > budget) continue;
    out.push(h.section);
    used += size;
  }
  return out;
}

// Words of a question that are also words of the docs (for the topics
// statistics – a name or an address typed into a question is not counted).
export function docsTerms(index: DocsIndex | null, question: string) {
  if (!index) return [];
  const out = new Set<string>();
  for (const w of words(question)) if (w.length >= 3 && /^\p{L}+$/u.test(w) && index.vocabulary.has(stem(w))) out.add(w);
  return [...out].slice(0, 12);
}
