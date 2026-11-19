// What people ask about, without anything personal: the doc pages linked
// in answers and the docs' own words in questions (lib/docs.ts docsTerms).
import { all, run, transaction } from "./db";
import { dayKey, now } from "./clock";

export function recordTopics(sources: { title: string; url: string }[], terms: string[], at = now()) {
  const day = dayKey(at);
  transaction(() => {
    const pages = new Map<string, string>();
    for (const s of sources) pages.set(s.url.split("#")[0], s.title.split(" – ")[0]);
    for (const [url, title] of pages)
      run(
        "INSERT INTO topic_pages(day,url,title,count) VALUES(?,?,?,1) ON CONFLICT(day,url) DO UPDATE SET count=count+1, title=excluded.title",
        day,
        url,
        title.slice(0, 200),
      );
    for (const term of terms) run("INSERT INTO topic_terms(day,term,count) VALUES(?,?,1) ON CONFLICT(day,term) DO UPDATE SET count=count+1", day, term.slice(0, 40));
  });
}

export function topics(from: string, to: string, max = 25) {
  const pages = all<{ url: string; title: string; count: number }>(
    "SELECT MAX(title) AS title, url, SUM(count) AS count FROM topic_pages WHERE day>=? AND day<=? GROUP BY url ORDER BY count DESC, url LIMIT ?",
    from,
    to,
    max,
  );
  const keywords = all<{ keyword: string; count: number }>(
    "SELECT term AS keyword, SUM(count) AS count FROM topic_terms WHERE day>=? AND day<=? GROUP BY term ORDER BY count DESC, keyword LIMIT ?",
    from,
    to,
    max,
  );
  return { pages, keywords };
}
