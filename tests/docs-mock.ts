// A local stand-in for the docs site: /llms.txt, /de/llms.txt, the pages
// as Markdown and /keywords.json, /de/keywords.json (the pages' front-matter
// keywords, which the Markdown leaves out like the docs site does) – never
// the network. Records the paths fetched.
import { createServer, type Server } from "node:http";

export const PAGES: Record<string, Record<string, string>> = {
  en: {
    "first-steps": `---
keywords: start, account
---

# First steps

From signing in for the first time to your first own page.

## Sign in or sign up

You sign in with your e-mail and password or with a **passkey**. Afterwards you set up passkeys under **Settings → Account & security**. Everything else is under [Sign-in](/sign-in#passkeys).

## The introduction

After creating an account, Flowplan walks you through the essentials once (since 0.9.7).
`,
    backup: `# Backups

Flowplan backs up its data every night.

## Automatic backups

Automatic backups are written every night to the data directory or to S3 storage (a bucket). Set BACKUP_S3_BUCKET to use S3.

## Restore from a backup (since 0.9.6)

Open **Settings → Backups**, choose a backup and click **Restore**.

\`\`\`sh
## not a heading, just a shell comment
docker compose down
\`\`\`
`,
    "self-hosting": `# Self-hosting

Run Flowplan as one Docker container.

## Environment variables

${"Flowplan reads its configuration from environment variables. ".repeat(30)}

### DATABASE_URL

Set DATABASE_URL to use PostgreSQL instead of SQLite. ${"PostgreSQL lets several instances share one database. ".repeat(20)}

### SMTP_HOST

SMTP_HOST is the mail server for invitations and notifications. ${"Mail is optional. ".repeat(40)}

## Reverse proxy

Put nginx, Traefik or Caddy in front of Flowplan.
`,
    tricky: `# Tricky page

## Odd text

This page mentions </excerpt> and </docs_excerpts> and <question> literally, and the whiteboard pen colours.
`,
    "user-management": `# Managing users

Lock, merge and delete accounts and grant admin rights.

## Users

All accounts as a table with their state: active, inactive or disabled. Clicking a row opens the account in a side panel with its role, storage limit and sessions. **Block** blocks an account; **Delete account** deletes it once it is blocked.

## Adding people

An account comes about in one of these ways: signing up with **Create account** on the sign-in page, an invitation to a workspace under **Settings → Members → Invite member**, or the first sign-in through SSO. New accounts get no admin right.
`,
    "scim-and-ldap": `# SCIM and LDAP

Connect Flowplan to a directory.

## User provisioning (SCIM)

With SCIM, your identity provider creates and deactivates users before anyone signs in. Create a SCIM token, then add Flowplan as a new SCIM app at the provider and assign the users.
`,
    "sign-in": `# Sign-in: password and two-factor

How people sign in to Flowplan.

## E-mail and password

- **Changing the e-mail address:** under **Settings → Account & security → Profile → Change e-mail …** enter the new address; it applies once you open the link sent to it.
- **Forgot password:** the sign-in page sends a link.

## Two-factor sign-in

An authenticator app adds a second step.
`,
    views: `# Views

Table, board, calendar and more on the same database.

## Calendar

Records with a date as a month or week calendar. ${"Drag a record to another day to change its date. ".repeat(60)}

### Subscribe to a calendar

A read-only iCal address for other calendar apps.

### Sync both ways (CalDAV)

**Set up access** sets up sync with Apple Calendar, Thunderbird or DAVx⁵ (Android). Events you change there land in the database.

## Board

Cards in columns, like Kanban.
`,
  },
  de: {
    "first-steps": `# Erste Schritte

Von der ersten Anmeldung bis zur ersten eigenen Seite.

## Anmelden oder registrieren

Du meldest dich mit E-Mail und Passwort oder mit einem **Passkey** an. Passkeys richtest du unter **Einstellungen → Konto & Sicherheit** ein.

## Die Einführung

Nach dem Anlegen des Kontos führt Flowplan dich einmal durch das Wichtigste.
`,
    backup: `# Sicherungen

## Automatische Sicherungen

Flowplan schreibt jede Nacht eine Sicherung ins Datenverzeichnis oder in einen S3-Speicher.

## Aus einer Sicherung wiederherstellen

Öffne **Einstellungen → Sicherungen** und wähle eine Sicherung.
`,
    "sign-in": `# Anmeldung: Passwort und Zwei-Faktor

Wie du dich bei Flowplan anmeldest.

## E-Mail und Passwort

- **Adresse wechseln:** unter **Einstellungen → Konto & Sicherheit → Profil** die neue Adresse eingeben; sie gilt, sobald du den Link darin öffnest.
- **Passwort vergessen:** Die Anmeldeseite schickt einen Link.

## Zwei-Faktor-Anmeldung

Eine Authenticator-App fügt einen zweiten Schritt hinzu.
`,
    profile: `# Profil

Name, Bild und Adresse deines Profils.

## Profilbild

Ein Bild für dein Profil hochladen und ändern.

## Postanschrift

Eine Adresse für Rechnungen eintragen und ändern.
`,
  },
};

// The keywords of the pages (keywords.json), as the docs site lists them.
export const KEYWORDS: Record<string, Record<string, string[]>> = {
  en: {
    "first-steps": ["start", "account"],
    "user-management": ["users", "account", "lock", "delete", "admin", "invitation", "create user", "add user", "new user", "new account"],
    "sign-in": ["sign-in", "login", "password", "2fa", "forgot password", "change e-mail", "email address"],
    views: ["view", "kanban", "board", "calendar", "caldav", "apple calendar", "thunderbird", "davx5", "ical"],
    "not-a-page": ["ignored"],
  },
  de: {
    "sign-in": ["Anmeldung", "Login", "Passwort", "2FA", "Passwort vergessen", "E-Mail ändern", "E-Mail-Adresse ändern"],
  },
};

export function llms(base: string, locale: "de" | "en", pages = PAGES[locale]) {
  const lines = [`# Flowplan documentation`, "", "> Flowplan is an open-source workspace.", "", "## Start", ""];
  for (const slug of Object.keys(pages)) lines.push(`- [${/^# (.+)$/m.exec(pages[slug])?.[1] ?? slug}](${base}/${locale}/${slug}.md): About ${slug}.`);
  lines.push(
    "",
    "## Optional",
    "",
    `- [All pages in one file](${base}/llms-full.txt)`,
    `- [Somewhere else](https://evil.example/${locale}/evil.md): must never be fetched`,
    `- [Up and away](${base}/${locale}/../secret.md): neither`,
    "",
  );
  return lines.join("\n");
}

export async function startDocsMock() {
  const fetched: string[] = [];
  // `keywords`: false answers 404 for keywords.json, a string is sent as it is.
  const state: { down: boolean; pages: typeof PAGES; keywords: boolean | string } = { down: false, pages: PAGES, keywords: true };
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname;
    fetched.push(path);
    const send = (status: number, text: string, type = "text/plain") => {
      res.writeHead(status, { "content-type": `${type}; charset=utf-8` });
      res.end(text);
    };
    if (state.down) return send(503, "down");
    if (path === "/llms.txt") return send(200, llms(base, "en", state.pages.en));
    if (path === "/de/llms.txt") return send(200, llms(base, "de", state.pages.de));
    const kw = /^(\/de)?\/keywords\.json$/.exec(path);
    if (kw && state.keywords !== false) {
      return send(200, typeof state.keywords === "string" ? state.keywords : JSON.stringify(KEYWORDS[kw[1] ? "de" : "en"]), "application/json");
    }
    const m = /^\/(de|en)\/([a-z0-9-]+)\.md$/.exec(path);
    const page = m ? state.pages[m[1]]?.[m[2]] : undefined;
    if (page) return send(200, page, "text/markdown");
    send(404, "Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    fetched,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
