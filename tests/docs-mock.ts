// A local stand-in for the docs site: /llms.txt, /de/llms.txt and the pages
// as Markdown – never the network. Records the paths fetched.
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
  const state = { down: false, pages: PAGES };
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
