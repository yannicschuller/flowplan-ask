// Two languages: German and English. Texts sit next to each other in the
// code as t("Deutsch", "English"), like in Flowplan. Client-safe. The page
// follows the browser's languages; the header switch adds ?lang= (no cookie).
export type Locale = "de" | "en";
export const isLocale = (v: unknown): v is Locale => v === "de" || v === "en";

export function pickLocale(choice: string | undefined | null, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(choice)) return choice;
  const ranked = (acceptLanguage || "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^q=([\d.]+)$/.exec(p.trim())?.[1]).find(Boolean);
      return { lang: tag.toLowerCase().split("-")[0], q: q ? Number(q) : 1 };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { lang } of ranked) if (isLocale(lang)) return lang;
  return "en";
}

export type T = (de: string, en: string) => string;
export const translate = (locale: Locale): T => (de, en) => (locale === "de" ? de : en);
