import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_TOKEN, DOCS_ORIGIN, admin, body, call, callPublic, req, setup } from "./helpers";
import { adminRoute, askRoute, botRoute } from "../lib/routes";
import { all } from "../lib/db";

await setup();
const SUBJECT = "a3f1c0ffee0123456789abcdef0123456789abcdef0123456789abcdef012345";
const bot = (name: string, json: unknown, init: { token?: string; origin?: string } = {}) =>
  call(() => botRoute(req(`/api/bot/${name}`, { json, bot: init.token ?? BOT_TOKEN, origin: init.origin }), name));
const ask = () => {
  const make = () => req("/api/ask", { json: { source: "discord", locale: "en", subject: SUBJECT, question: "How do backups work?" }, bot: BOT_TOKEN });
  return callPublic(make(), () => askRoute(make()));
};
const list = async () => (await body(await call(() => adminRoute(admin("/api/admin/blocklist"), "blocklist")))).entries as any[];

test("the bot blocks and unblocks a Discord user by its subject; the answer is the admin's short hash", async () => {
  const blocked = await body(await bot("block", { subject: SUBJECT, note: "spam in #help", actor: "discord-mod" }));
  assert.match(blocked.short, /^[A-Za-z0-9]{12}$/);
  assert.deepEqual(Object.keys(blocked), ["short"]);
  const entries = await list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].subject, blocked.short);
  assert.equal(entries[0].source, "discord");
  assert.equal(entries[0].note, "spam in #help");
  assert.ok(!JSON.stringify(all("SELECT * FROM blocklist")).includes(SUBJECT), "never in clear");
  assert.equal((await ask()).status, 429);
  // Again: an upsert (the note changes).
  assert.equal((await body(await bot("block", { subject: SUBJECT, note: "again", actor: "hashed-moderator-0123" }))).short, blocked.short);
  assert.equal((await list())[0].note, "again");
  assert.deepEqual(await body(await bot("unblock", { subject: SUBJECT, actor: "discord-mod" })), { short: blocked.short });
  assert.equal((await list()).length, 0);
  assert.equal((await ask()).status, 200);
  assert.equal((await bot("unblock", { subject: SUBJECT })).status, 404);
});

test("bot API: token, server to server, valid subject and actor", async () => {
  assert.equal((await bot("block", { subject: SUBJECT }, { token: "x".repeat(40) })).status, 401);
  assert.equal((await bot("block", { subject: SUBJECT }, { origin: DOCS_ORIGIN })).status, 403);
  assert.equal((await body(await bot("block", { subject: "short" }))).error, "invalid_subject");
  assert.equal((await body(await bot("block", { subject: SUBJECT, actor: "Yannic S." }))).error, "invalid_actor");
  assert.equal((await bot("ban", { subject: SUBJECT })).status, 404);
  const saved = process.env.ASK_BOT_TOKEN;
  delete process.env.ASK_BOT_TOKEN;
  assert.equal((await bot("block", { subject: SUBJECT })).status, 404);
  process.env.ASK_BOT_TOKEN = saved;
  assert.equal((await list()).length, 0);
});
