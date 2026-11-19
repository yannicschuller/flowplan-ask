import Link from "next/link";
import { BrandMark } from "./brand-mark";
import { pageT } from "@/lib/page";
import type { Locale } from "@/lib/i18n";

const LANGUAGES: { locale: Locale; short: string; name: string }[] = [
  { locale: "de", short: "DE", name: "Deutsch" },
  { locale: "en", short: "EN", name: "English" },
];

export async function SiteHeader() {
  const { t, locale } = await pageT();
  return (
    <header className="site-header">
      <div className="bar">
        <Link href={`/?lang=${locale}`} className="brand" aria-label={t("Flowplan – Frag Flo", "Flowplan – Ask Flo")}>
          <BrandMark />
          <span className="brand-name">Flowplan</span>
          <small>{t("Frag Flo", "Ask Flo")}</small>
        </Link>
        <nav className="header-lang" aria-label={t("Sprache", "Language")}>
          {LANGUAGES.map((l) => (
            <a key={l.locale} href={`/?lang=${l.locale}`} hrefLang={l.locale} lang={l.locale} aria-label={l.name} title={l.name} aria-current={l.locale === locale ? "true" : undefined}>
              {l.short}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
