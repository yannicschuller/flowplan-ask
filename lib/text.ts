// Words for the docs search: folding, stop words (German and English), a
// light stemmer and synonyms across both languages (ideas from
// flowplan-docs/lib/search.ts).

// Lower case without accents; ß becomes "ss", ä/ö/ü their bare letters.
export const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss");

const STOP = new Set(
  (
    "a about after all also am an and any are as at be because been but by can could did do does doing for from had has have how i if in into is it its just me more most my no not of on once only or other our out over own same should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who why will with would you your yours " +
    "aber alle allem allen aller alles als also am an ander andere anderem anderen anderer anderes auch auf aus bei bin bis bist da damit dann das dass dein deine dem den der des dessen dich die dies diese diesem diesen dieser dieses dir doch dort du durch ein eine einem einen einer eines er es etwas euch euer eure fur gibt hab habe haben hat hatte hier hin hinter ich ihm ihn ihnen ihr ihre im in ist ja jede jedem jeden jeder jedes jetzt kann kein keine konnen kann mache machen man manche mein meine mich mir mit muss nach nicht nichts noch nun nur ob oder ohne sehr sein seine sich sie sind so solche soll sollte sondern um und uns unser unter viel vom von vor wann war waren warum was weg weil weiter welche welchem welchen welcher welches wenn wer werde werden wie wieder will wir wird wo woher wohin zu zum zur uber " +
    "flowplan bitte please hallo hello hi thanks danke geht gehts funktioniert"
  ).split(" "),
);

// Strips a few common German and English endings, so "Vorlagen" finds
// "Vorlage" and "exporting" finds "export". Applied to the docs and the
// question alike.
const SUFFIXES = ["ationen", "ation", "ungen", "ung", "ingen", "ing", "ern", "en", "er", "es", "ed", "e", "s", "n"];
export function stem(word: string) {
  if (word.length <= 4 || /\d/.test(word)) return word;
  for (const s of SUFFIXES) if (word.endsWith(s) && word.length - s.length >= 4) return word.slice(0, -s.length);
  return word;
}

// The folded words of a text (letters, digits, dots and dashes inside words).
export function words(text: string) {
  return fold(text)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 1 && w.length <= 40 && !STOP.has(w));
}
export const terms = (text: string) => words(text).map(stem);

// Each group is one meaning, in both languages.
export const SYNONYMS: string[][] = [
  ["login", "anmeldung", "anmelden", "einloggen", "signin"],
  ["logout", "abmelden", "abmeldung"],
  ["registrierung", "registrieren", "signup", "konto", "account"],
  ["env", "umgebungsvariable", "umgebungsvariablen", "variable", "konfiguration", "configuration", "config"],
  ["s3", "speicher", "storage", "bucket", "minio"],
  ["sso", "oidc", "openid", "keycloak", "authentik"],
  ["ki", "ai", "llm", "ollama", "kunstliche", "artificial"],
  ["backup", "backups", "sicherung", "datensicherung", "restore", "wiederherstellen"],
  ["passwort", "password", "kennwort"],
  ["2fa", "totp", "authenticator", "zwei", "two"],
  ["passkey", "passkeys", "webauthn"],
  ["export", "exportieren", "exporting"],
  ["import", "importieren", "importing", "umzug", "migration", "migrate"],
  ["berechtigung", "berechtigungen", "rechte", "permission", "permissions", "zugriff", "access", "freigabe", "share", "sharing", "teilen"],
  ["vorlage", "vorlagen", "template", "templates"],
  ["datenbank", "datenbanken", "database", "databases", "tabelle", "table"],
  ["tastenkurzel", "shortcut", "shortcuts", "hotkey", "keyboard", "tastatur"],
  ["benachrichtigung", "benachrichtigungen", "notification", "notifications", "push"],
  ["dunkel", "dark", "dunkler"],
  ["sprache", "sprachen", "language", "languages", "ubersetzung", "translation"],
  ["proxy", "nginx", "traefik", "caddy"],
  ["update", "updates", "aktualisieren", "aktualisierung", "upgrade"],
  ["papierkorb", "trash", "geloscht", "deleted"],
  ["seite", "seiten", "page", "pages", "dokument", "document"],
  ["whiteboard", "tafel", "canvas"],
  ["kalender", "calendar"],
  ["installation", "installieren", "install", "docker", "selbst", "self", "hosting", "selfhost"],
  ["suche", "suchen", "search"],
  ["offline", "sync", "synchronisation"],
];
const synonymIndex = new Map<string, Set<string>>();
for (const group of SYNONYMS) {
  const stems = group.map((w) => stem(fold(w)));
  for (const s of stems) {
    const set = synonymIndex.get(s) ?? new Set<string>();
    for (const t of stems) if (t !== s) set.add(t);
    synonymIndex.set(s, set);
  }
}
export const synonymsOf = (term: string) => [...(synonymIndex.get(term) ?? [])];
