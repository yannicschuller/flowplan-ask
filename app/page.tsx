import { pageT } from "@/lib/page";
import { config, DISCORD_INVITE } from "@/lib/config";
import { serviceState } from "@/lib/status";
import { getSettings } from "@/lib/settings";
import { FloOtter } from "@/components/flo-otter";

// What Flo is, where to ask and whether it answers right now. No chat here:
// Flo lives in the docs ("Frag Flo" bottom right) and on Discord (/ask).
export const dynamic = "force-dynamic";

export default async function Home() {
  const { t, locale } = await pageT();
  const settings = getSettings();
  const state = serviceState(settings);
  const docs = config.docsUrl();
  const status = (on: boolean) => (
    <span className={`status ${on ? "on" : "off"}`}>
      <span className="dot" aria-hidden="true" />
      {on ? t("antwortet", "answering") : t("pausiert", "paused")}
    </span>
  );
  return (
    <div className="home">
      <section className="hero">
        <FloOtter size={112} />
        <div className="stack">
          <h1>{t("Frag Flo", "Ask Flo")}</h1>
          <p className="lede">
            {t(
              "Flo ist Flowplans Assistent – ein kleiner Otter mit Notizblock. Er beantwortet Fragen zur Nutzung, Einrichtung und zum Selbst-Hosten von Flowplan, und zwar nur aus der öffentlichen Doku, mit Links auf die Seiten, auf denen die Antwort beruht.",
              "Flo is Flowplan's assistant – a small otter with a notepad. It answers questions about using, setting up and self-hosting Flowplan, only from the public docs, with links to the pages the answer is based on.",
            )}
          </p>
        </div>
      </section>

      <section className="grid" aria-label={t("Wo du Flo fragst", "Where to ask Flo")}>
        <div className="card">
          <div className="row">
            <h2>{t("In der Doku", "In the docs")}</h2>
            <span className="spacer" />
            {status(state.docs)}
          </div>
          <p>
            {t("Auf jeder Seite von ", "On every page of ")}
            <a href={`${docs}/${locale}`}>docs.flowplan.org</a>
            {t(" unten rechts „Frag Flo“ – oder in der Suche „Flo fragen: …“.", ": “Ask Flo” at the bottom right – or “Ask Flo: …” in the search.")}
          </p>
        </div>
        <div className="card">
          <div className="row">
            <h2>Discord</h2>
            <span className="spacer" />
            {status(state.discord)}
          </div>
          <p>
            {t("Im ", "In the ")}
            <a href={DISCORD_INVITE}>{t("Flowplan-Discord", "Flowplan Discord")}</a>
            {t(" mit ", " with ")}
            <code>/ask</code>
            {t(" – Flo antwortet in einem Thread, Nachfragen gehen dort weiter.", " – Flo answers in a thread, follow-ups continue there.")}
          </p>
        </div>
      </section>

      <section className="card privacy">
        <h2>{t("Datenschutz", "Privacy")}</h2>
        <p>
          {t(
            "Deine Frage geht an Anthropic (Claude) und wird nur aus den öffentlichen Docs beantwortet.",
            "Your question goes to Anthropic (Claude) and is answered only from the public docs.",
          )}
        </p>
        <ul>
          <li>
            {t(
              "An Anthropic gehen nur die Frage, der bisherige Gesprächsverlauf und Auszüge aus der Doku – keine Namen, Discord-IDs, IP-Adressen oder Sitzungsdaten.",
              "Only the question, the conversation so far and excerpts from the docs go to Anthropic – no names, Discord ids, IP addresses or session data.",
            )}
          </li>
          <li>
            {t(
              "Keine Cookies, kein Tracking. Für die Limits zählt Flo Fragen pro Sitzung bzw. Discord-Konto nur als Hash.",
              "No cookies, no tracking. For the limits, Flo counts questions per session or Discord account only as a hash.",
            )}
          </li>
          <li>
            {settings.logging.enabled
              ? t(
                  `Fragen und Antworten werden anonymisiert ${settings.logging.retentionDays} Tage aufbewahrt, um Flo zu verbessern – ohne Bezug zu dir.`,
                  `Questions and answers are kept anonymised for ${settings.logging.retentionDays} days to improve Flo – without any link to you.`,
                )
              : t("Fragen und Antworten werden nicht gespeichert.", "Questions and answers are not stored.")}
          </li>
        </ul>
        <p>
          <a href={`${docs}/${locale}/flo`}>{t("Mehr über Flo in der Doku", "More about Flo in the docs")}</a>
        </p>
      </section>
    </div>
  );
}
