import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers";
import { docsIndex, docsTerms, forgetDocs, headingId, loadIndex, parseKeywords, parseLlms, pickSections, rank, refreshDocs, REFRESH_MS, splitPage, DOCS_BUDGET_CHARS } from "../lib/docs";
import { fold, terms } from "../lib/text";
import { clock } from "../lib/clock";
import { llms } from "./docs-mock";

const { docs } = await setup();

test("llms.txt: only Markdown pages directly below DOCS_URL/<locale>/", () => {
  const entries = parseLlms(llms(docs.base, "en"), docs.base, "en");
  assert.deepEqual(
    entries.map((e) => e.slug),
    ["first-steps", "backup", "self-hosting", "tricky", "user-management", "scim-and-ldap", "sign-in", "views"],
  );
  assert.equal(entries[0].mdUrl, `${docs.base}/en/first-steps.md`);
  assert.equal(parseLlms(llms(docs.base, "en"), docs.base, "de").length, 0);
});

test("heading ids match the docs site's", () => {
  assert.equal(headingId("Sign in or sign up"), "sign-in-or-sign-up");
  assert.equal(headingId("Restore from a backup (since 0.9.6)"), "restore-from-a-backup");
  assert.equal(headingId("Größe & Übersicht"), "groesse-uebersicht");
  assert.equal(headingId("Café"), "caf");
  assert.equal(headingId("`DATABASE_URL` and **more**"), "database-url-and-more");
  assert.equal(headingId("Konto & Sicherheit"), "konto-sicherheit");
});

test("pages are cut into sections at ## (long ones at ###), with absolute links and anchors", async () => {
  const index = await loadIndex(docs.base);
  const en = index.locales.en!;
  const de = index.locales.de!;
  assert.equal(en.pages, 8);
  assert.equal(de.pages, 4);
  const urls = en.sections.map((s) => s.url);
  assert.ok(urls.includes(`${docs.base}/en/first-steps`), "the page intro");
  assert.ok(urls.includes(`${docs.base}/en/first-steps#sign-in-or-sign-up`));
  assert.ok(urls.includes(`${docs.base}/en/backup#restore-from-a-backup`));
  // The long "Environment variables" section is split at its ### headings.
  assert.ok(urls.includes(`${docs.base}/en/self-hosting#database-url`));
  assert.ok(urls.includes(`${docs.base}/en/self-hosting#smtp-host`));
  // A short section keeps its ### parts.
  const restore = en.sections.find((s) => s.url.endsWith("#restore-from-a-backup"))!;
  assert.match(restore.text, /## not a heading/, "a # line inside a code block is no heading");
  const signIn = en.sections.find((s) => s.url.endsWith("#sign-in-or-sign-up"))!;
  assert.match(signIn.text, new RegExp(`\\(${docs.base}/en/sign-in#passkeys\\)`));
  assert.equal(signIn.pageTitle, "First steps");
  // Nothing outside DOCS_URL was fetched.
  assert.ok(!docs.fetched.some((p) => p.includes("evil") || p.includes("secret") || p.includes("llms-full")), docs.fetched.join(","));
});

test("ranking: English and German, synonyms, the page hint and the budget", async () => {
  const index = await loadIndex(docs.base);
  const top = (q: string, locale: "de" | "en", page?: string) => rank(index, q, locale, page)[0]?.section.url;
  assert.equal(top("How do I set up a passkey?", "en"), `${docs.base}/en/first-steps#sign-in-or-sign-up`);
  assert.equal(top("Wie richte ich Passkeys ein?", "de"), `${docs.base}/de/first-steps#anmelden-oder-registrieren`);
  assert.equal(top("restore a backup", "en"), `${docs.base}/en/backup#restore-from-a-backup`);
  // "Sicherung" finds the English backup pages through the synonyms, too.
  assert.match(top("sicherung", "en")!, /\/en\/backup/);
  assert.equal(top("DATABASE_URL postgres", "en"), `${docs.base}/en/self-hosting#database-url`);
  assert.equal(top("nginx", "en"), `${docs.base}/en/self-hosting#reverse-proxy`);
  assert.deepEqual(rank(index, "the and of", "en"), []);
  const picked = pickSections(index, "environment variables database smtp mail backup", "en");
  const size = picked.reduce((n, s) => n + s.text.length, 0);
  assert.ok(picked.length >= 2 && picked.length <= 6);
  assert.ok(size <= DOCS_BUDGET_CHARS);
  assert.ok(pickSections(index, "environment variables database smtp mail backup", "en", undefined, 1500).length < picked.length);
  // A language without pages falls back to the other.
  const enOnly = { ...index, locales: { en: index.locales.en } };
  assert.match(rank(enOnly, "passkey", "de")[0].section.url, /\/en\//);
});

test("topics: only words of the docs are counted", async () => {
  const index = await loadIndex(docs.base);
  assert.deepEqual(docsTerms(index, "Hi, I'm Zacharias from Hamburg: how do backups to S3 work?"), ["backups"]);
});

test("the index is cached, refreshed after a few hours and kept when the docs are down", async () => {
  forgetDocs();
  const t0 = Date.now();
  clock.now = () => t0;
  const first = await docsIndex();
  assert.ok(first);
  const fetches = docs.fetched.length;
  assert.equal(await docsIndex(), first);
  assert.equal(docs.fetched.length, fetches, "cached");
  // Down: the old index keeps answering.
  docs.state.down = true;
  clock.now = () => t0 + REFRESH_MS + 1000;
  assert.equal(await docsIndex(), first, "stale index served while refreshing");
  await refreshDocs();
  assert.equal(await docsIndex(), first);
  docs.state.down = false;
  // Back up: a new index once the retry pause is over.
  clock.now = () => t0 + REFRESH_MS + 10 * 60_000;
  await docsIndex();
  await refreshDocs();
  const second = await docsIndex();
  assert.notEqual(second, first);
  assert.equal(second!.locales.en!.pages, 8);
  clock.now = () => Date.now();
});

test("splitPage keeps front matter out and names the intro after the page", () => {
  const sections = splitPage("---\nkeywords: x\n---\n# Title\n\nIntro text.\n\n## A\n\nBody.", { title: "T", slug: "p", mdUrl: "", summary: "Summary." }, "https://d", "en");
  assert.deepEqual(
    sections.map((s) => [s.url, s.heading, s.pageTitle]),
    [
      ["https://d/en/p", "", "Title"],
      ["https://d/en/p#a", "A", "Title"],
    ],
  );
  assert.doesNotMatch(sections[0].text, /keywords/);
});

test("keywords.json: the pages' keywords are loaded with the lists and lift their pages", async () => {
  const index = await loadIndex(docs.base);
  assert.ok(docs.fetched.includes("/keywords.json") && docs.fetched.includes("/de/keywords.json"));
  const top = (q: string, locale: "de" | "en") => rank(index, q, locale)[0]?.section.url;
  // The page says "Adresse wechseln"; its keywords say "E-Mail-Adresse ändern".
  assert.equal(top("E-Mail-Adresse ändern", "de"), `${docs.base}/de/sign-in#e-mail-und-passwort`);
  assert.equal(top("CalDAV planned", "en"), `${docs.base}/en/views#sync-both-ways-caldav`);
  // "Adding people" never says "user"; the page's keywords "create user, new user" do.
  assert.equal(top("how can I create a new user", "en"), `${docs.base}/en/user-management#adding-people`);
  assert.ok(pickSections(index, "how can I create a new user", "en").some((s) => s.url.endsWith("#adding-people")));
  // Keywords of a page that is not in llms.txt count for nothing.
  assert.ok(!index.locales.en!.keywords.has("not-a-page"));
  assert.ok(!index.vocabulary.has("ignored"));
  // Keywords are words of the docs for the topics statistics, too.
  assert.ok(index.vocabulary.has("davx5"));

  // Without the keywords the same questions land elsewhere: they are what made the difference.
  docs.state.keywords = false;
  try {
    const plain = await loadIndex(docs.base);
    assert.equal(plain.locales.en!.keywords.size, 0);
    assert.notEqual(rank(plain, "how can I create a new user", "en")[0]?.section.url, `${docs.base}/en/user-management#adding-people`);
    assert.notEqual(rank(plain, "E-Mail-Adresse ändern", "de")[0]?.section.url, `${docs.base}/de/sign-in#e-mail-und-passwort`);
  } finally {
    docs.state.keywords = true;
  }
});

test("keywords.json missing or broken: Flo ranks on the pages alone", async () => {
  for (const broken of [false, "not json", "[1,2]", '{"views": "caldav", "../x": ["a"], "sign-in": [1, ""]}']) {
    docs.state.keywords = broken;
    try {
      const index = await loadIndex(docs.base);
      assert.equal(index.locales.en!.pages, 8, String(broken));
      assert.equal(index.locales.en!.keywords.size, 0, String(broken));
      assert.equal(rank(index, "restore a backup", "en")[0]?.section.url, `${docs.base}/en/backup#restore-from-a-backup`);
    } finally {
      docs.state.keywords = true;
    }
  }
  assert.deepEqual([...parseKeywords('{"a-b": ["x", 2, "y"], "Bad Slug": ["z"]}')], [["a-b", ["x", "y"]]]);
  assert.equal(parseKeywords(JSON.stringify({ p: Array.from({ length: 100 }, (_, i) => `k${i}`) })).get("p")!.length, 40);
  assert.equal(parseKeywords(null).size, 0);
});

test("DAVx⁵ is davx5: compatibility forms are folded (NFKD)", async () => {
  assert.equal(fold("DAVx⁵"), "davx5");
  assert.equal(fold("ﬁle Café Straße"), "file cafe strasse");
  assert.deepEqual(terms("DAVx⁵ (Android)"), ["davx5", "android"]);
  const index = await loadIndex(docs.base);
  assert.equal(rank(index, "davx5", "en")[0]?.section.url, `${docs.base}/en/views#sync-both-ways-caldav`);
  assert.equal(rank(index, "DAVx⁵", "en")[0]?.section.url, `${docs.base}/en/views#sync-both-ways-caldav`);
  // Through the text alone, too (the page's keywords say davx5 as well).
  docs.state.keywords = false;
  try {
    assert.equal(rank(await loadIndex(docs.base), "davx5", "en")[0]?.section.url, `${docs.base}/en/views#sync-both-ways-caldav`);
  } finally {
    docs.state.keywords = true;
  }
});
