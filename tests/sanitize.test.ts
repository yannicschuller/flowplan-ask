import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedLink, linksIn, MAX_ANSWER_CHARS, sanitizeAnswer } from "../lib/sanitize";

process.env.DOCS_URL = "https://docs.flowplan.org";
const clean = (s: string, locale: "de" | "en" = "en") => sanitizeAnswer(s, locale);

test("the link allow-list is exactly the docs, the website, Flowplan's GitHub repositories and the Discord invite", () => {
  const ok = [
    "https://docs.flowplan.org/en/backup#automatic-backups",
    "https://flowplan.org/de/download",
    "https://flowplan.org",
    "https://github.com/yannicschuller/flowplan/issues",
    "https://github.com/yannicschuller/flowplan-docs",
    "https://discord.gg/bCEdB6MPrR",
  ];
  for (const url of ok) assert.ok(allowedLink(url), url);
  const bad = [
    "http://docs.flowplan.org/en/backup",
    "https://docs.flowplan.org.evil.com/x",
    "https://evil.com/?https://docs.flowplan.org",
    "https://app.flowplan.org/",
    "https://github.com/yannicschuller/other",
    "https://github.com/evil/flowplan",
    "https://github.com/yannicschuller",
    "https://discord.gg/otherinvite",
    "https://discord.gg/bCEdB6MPrR?x=1",
    "https://user:pw@docs.flowplan.org/",
    "https://docs.flowplan.org:8443/",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//docs.flowplan.org/x",
    "/en/backup",
  ];
  for (const url of bad) assert.equal(allowedLink(url), null, url);
  // Parentheses can't break out of the Markdown link.
  assert.equal(allowedLink("https://docs.flowplan.org/a(b)"), "https://docs.flowplan.org/a%28b%29");
});

test("allowed links stay, others become plain text", () => {
  assert.equal(clean("See [Backups](https://docs.flowplan.org/en/backup)."), "See [Backups](https://docs.flowplan.org/en/backup).");
  assert.equal(clean("Click [here](https://evil.example/login) now"), "Click here now");
  assert.equal(clean("[x](javascript:alert(1))"), "x)");
  assert.equal(clean('[t](https://docs.flowplan.org/en/x "title")'), "[t](https://docs.flowplan.org/en/x)");
  assert.equal(clean("Go to https://evil.example/phish please"), "Go to [link removed] please");
  assert.equal(clean("Geh zu www.evil.example jetzt", "de"), "Geh zu [Link entfernt] jetzt");
  assert.equal(clean("Read https://docs.flowplan.org/en/backup."), "Read https://docs.flowplan.org/en/backup.");
  assert.equal(clean("![logo](https://evil.example/p.png) and ![x](https://docs.flowplan.org/a.png)"), "logo and x");
  assert.equal(clean("[a][1]\n\n[1]: https://evil.example"), "a");
  // A link whose text is a disallowed address.
  assert.equal(clean("[https://evil.example](https://docs.flowplan.org/en/x)"), "[[link removed]](https://docs.flowplan.org/en/x)");
});

test("HTML is stripped, Markdown is reduced to the subset", () => {
  assert.equal(clean("<script>alert(1)</script>Hi <b>there</b>"), "alert(1)Hi there");
  assert.equal(clean('<img src=x onerror="alert(1)">ok'), "ok");
  assert.equal(clean("<a href='https://evil.example'>click</a>"), "click");
  assert.equal(clean("a <!-- hidden --> b"), "a  b");
  assert.equal(clean("<https://evil.example/x>"), "[link removed]");
  assert.equal(clean("<https://docs.flowplan.org/en/x>"), "https://docs.flowplan.org/en/x");
  assert.equal(clean("# Big\n## Title\ntext"), "**Big**\n**Title**\ntext");
  assert.equal(clean("> quoted\n> > twice"), "quoted\ntwice");
  assert.equal(clean("a\n\n---\n\nb"), "a\n\nb");
  assert.equal(clean("| a | b |\n|---|---|\n| 1 | 2 |"), "| a | b |\n| 1 | 2 |");
  assert.equal(clean("- **bold** and *italic* and `code`\n1. step"), "- **bold** and *italic* and `code`\n1. step");
  assert.equal(clean("~~gone~~ ||spoiler||"), "gone spoiler");
  // Comparisons survive, tag starts are defused.
  assert.equal(clean("if a < b and b > c"), "if a < b and b > c");
  assert.equal(clean("a <iframe"), "a ‹iframe");
});

test("code keeps its content but cannot escape", () => {
  assert.equal(clean("```sh\ndocker compose up <x>\n```"), "```sh\ndocker compose up <x>\n```");
  assert.equal(clean("```\nunclosed https://evil.example"), "```\nunclosed https://evil.example\n```");
  assert.equal(clean("`<b>x</b>` and `https://evil.example`"), "`<b>x</b>` and `https://evil.example`");
  assert.equal(clean("```js\na ``` b\n```"), "```js\na ''' b\n```");
});

test("Discord mentions and invisible characters are defused", () => {
  assert.equal(clean("@everyone look"), "@​everyone look");
  assert.equal(clean("hi @here"), "hi @​here");
  assert.equal(clean("ping <@123456> <@&999> <#42> <:smile:77> <t:1700000000:R>"), "ping");
  assert.equal(clean("a‮b​c\u0007de"), "abcde");
  assert.equal(clean("-# small"), "small");
});

test("the answer is bounded, also inside a code block", () => {
  const long = "word ".repeat(2000);
  const out = clean(long);
  assert.ok(out.length <= MAX_ANSWER_CHARS, String(out.length));
  assert.ok(out.endsWith("…"));
  const code = clean("```\n" + "x".repeat(10_000));
  assert.ok(code.length <= MAX_ANSWER_CHARS + 4);
  assert.ok(code.endsWith("```"));
});

test("linksIn lists the links of an answer", () => {
  const a = clean("See [A](https://docs.flowplan.org/en/a#x) and https://docs.flowplan.org/en/b.");
  assert.deepEqual(linksIn(a), ["https://docs.flowplan.org/en/a#x", "https://docs.flowplan.org/en/b"]);
});

test("security review F1/F2: no protocol-relative escapes, link labels cleaned too", () => {
  for (const bad of [
    "https://docs.flowplan.org//evil.com/login",
    "https://docs.flowplan.org/%2F%2Fevil.com",
    "https://docs.flowplan.org/\\evil.com",
    "https://docs.flowplan.org@evil.com/",
    "https://docs.flowplan.org.evil.com/",
    "https://flowplan.org//evil.com",
  ])
    assert.equal(allowedLink(bad, "https://docs.flowplan.org"), null, bad);
  const out = sanitizeAnswer("[@everyone <b>hi</b>](https://docs.flowplan.org/en/install)", "en");
  assert.doesNotMatch(out, /@everyone/);
  assert.doesNotMatch(out, /<b>/);
});
