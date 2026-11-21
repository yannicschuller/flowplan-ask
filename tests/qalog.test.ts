// The Q&A log's anonymiser (#1): links from the answers' allow-list stay
// readable; tokens in their query, e-mail addresses and long random strings
// are still masked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub } from "../lib/qalog";

const RANDOM = "Zk3mP9qR7tW2xY5vB8nC1dF4gH6jK0LqWe";

test("allowed links stay readable in the log", () => {
  for (const link of [
    "https://github.com/yannicschuller/flowplan",
    "https://github.com/yannicschuller/flowplan/issues/new/choose",
    "https://docs.flowplan.org/en/sign-in#changing-the-e-mail-address",
    "https://flowplan.org/download",
  ])
    assert.equal(scrub(`Siehe ${link}.`), `Siehe ${link}.`, link);
  // The example from the issue, in brackets.
  assert.equal(
    scrub("stelle die Frage als Issue auf GitHub (https://github.com/yannicschuller/flowplan)."),
    "stelle die Frage als Issue auf GitHub (https://github.com/yannicschuller/flowplan).",
  );
});

test("a token in an allowed link's query is still masked", () => {
  const out = scrub(`https://docs.flowplan.org/en/api?token=${RANDOM}`);
  assert.ok(out.startsWith("https://docs.flowplan.org/en/api?"), out);
  assert.ok(!out.includes(RANDOM) && out.includes("[secret]"), out);
});

test("other links, e-mail addresses and random strings are masked as before", () => {
  for (const other of [`https://evil.example/${RANDOM}`, `https://github.com/someone/${RANDOM}`]) {
    const out = scrub(other);
    assert.ok(!out.includes(RANDOM) && out.includes("[secret]"), out);
  }
  assert.equal(scrub("Schreib an jemand@example.org"), "Schreib an [e-mail]");
  assert.equal(scrub(`Schlüssel ${RANDOM}`), "Schlüssel [secret]");
  assert.equal(scrub("sk-ant-api03-abc"), "[secret]");
  // Placeholder characters in the input cannot forge a kept link.
  assert.equal(scrub("a0b"), "a0b");
});
