import type { Metadata, Viewport } from "next";
import "./globals.css";
import { pageLocale } from "@/lib/page";
import { config } from "@/lib/config";
import { translate } from "@/lib/i18n";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

export async function generateMetadata(): Promise<Metadata> {
  const t = translate(await pageLocale());
  return {
    metadataBase: new URL(config.publicUrl()),
    title: { default: t("Frag Flo · Flowplan", "Ask Flo · Flowplan"), template: "%s · Flowplan" },
    description: t(
      "Flo ist Flowplans Assistent: Er beantwortet Fragen zu Flowplan aus der öffentlichen Doku – in der Doku und im Discord.",
      "Flo is Flowplan's assistant: it answers questions about Flowplan from the public docs – in the docs and on Discord.",
    ),
    applicationName: "Flowplan Ask",
    icons: { icon: [{ url: "/flo.svg", type: "image/svg+xml" }] },
  };
}
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfbf8" },
    { media: "(prefers-color-scheme: dark)", color: "#16151b" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await pageLocale();
  return (
    <html lang={locale}>
      <body>
        <a className="skip-link" href="#main">
          {translate(locale)("Zum Inhalt", "Skip to content")}
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
