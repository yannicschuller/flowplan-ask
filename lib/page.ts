// What server components need about the request: the visitor's language
// (?lang= from the header switch, passed on by proxy.ts as x-lang, else the
// browser's languages).
import { headers } from "next/headers";
import { pickLocale, translate, type Locale } from "./i18n";

export async function pageLocale(): Promise<Locale> {
  const h = await headers();
  return pickLocale(h.get("x-lang"), h.get("accept-language"));
}
export async function pageT() {
  const locale = await pageLocale();
  return { locale, t: translate(locale) };
}
