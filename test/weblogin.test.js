import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../lib/store.js";
import { newLoginCode, confirmLoginCode, pollLoginCode, signSess, verifySess, userFrom } from "../lib/tgauth.js";

const T = "123:test-token";

test("вход на сайте через бота: код → подтверждение → одноразовая сессия", async () => {
  const store = new MemoryStore(), now = Date.now();
  const code = await newLoginCode(store, now);
  assert.match(code, /^[a-f0-9]{24}$/);
  assert.deepEqual(await pollLoginCode(store, code, { token: T, now }), { status: "wait" });
  const u = await confirmLoginCode(store, code, { id: 77, first_name: "Анна", username: "anna" }, now);
  assert.equal(u.id, 77);
  assert.equal(await confirmLoginCode(store, code, { id: 99, first_name: "Чужой" }, now), null, "второй раз не подтверждается");
  const r = await pollLoginCode(store, code, { token: T, now });
  assert.equal(r.status, "ok");
  const me = verifySess(r.sess, T, now);
  assert.equal(me.id, 77); assert.equal(me.name, "Анна");
  assert.equal((await pollLoginCode(store, code, { token: T, now })).status, "gone", "код одноразовый");
});

test("код устаревает, сессия не подделывается и истекает", async () => {
  const store = new MemoryStore(), now = Date.now();
  const code = await newLoginCode(store, now);
  assert.equal(await confirmLoginCode(store, code, { id: 5, first_name: "X" }, now + 11 * 60e3), null);
  assert.equal((await pollLoginCode(store, code, { token: T, now: now + 11 * 60e3 })).status, "expired");
  assert.equal(await confirmLoginCode(store, "../x", { id: 5 }, now), null);
  const s = signSess({ id: 5, name: "X" }, T, now);
  assert.equal(verifySess(s, "other:token", now), null);
  const [p, h] = s.split("."); const forged = Buffer.from(JSON.stringify({ id: 6, name: "Y", exp: now + 1e9 })).toString("base64url") + "." + h;
  assert.equal(verifySess(forged, T, now), null);
  assert.equal(verifySess(s, T, now + 31 * 864e5), null);
  process.env.TELEGRAM_BOT_TOKEN = T;
  try { assert.equal(userFrom({ sess: s }).id, 5); } finally { delete process.env.TELEGRAM_BOT_TOKEN; }
});

test("бот: /start login_<код> просит подтвердить, кнопка отмечает код", async () => {
  const { setStore } = await import("../lib/store.js");
  const bot = (await import("../api/bot.js")).default, { hookSecret } = await import("../api/bot.js");
  const store = new MemoryStore(); setStore(store);
  process.env.TELEGRAM_BOT_TOKEN = T;
  const calls = [], f0 = globalThis.fetch;
  globalThis.fetch = async (url, o) => { calls.push({ m: String(url).split("/").pop(), b: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; };
  const run = body => new Promise(res => { const r = { statusCode: 0, setHeader() {}, end() { res(r); } }; bot({ method: "POST", headers: { "x-telegram-bot-api-secret-token": hookSecret(T), host: "x.test" }, body }, r); });
  try {
    const code = await newLoginCode(store);
    await run({ message: { chat: { id: 1 }, from: { id: 1, first_name: "Анна" }, text: "/start login_" + code } });
    const ask = calls.find(c => c.m === "sendMessage");
    assert.equal(ask.b.reply_markup.inline_keyboard[0][0].callback_data, "lg:" + code);
    assert.equal((await pollLoginCode(store, code, { token: T })).status, "wait", "одна ссылка ещё не входит");
    await run({ callback_query: { id: "q", data: "lg:" + code, from: { id: 1, first_name: "Анна" }, message: { chat: { id: 1 }, message_id: 3 } } });
    assert.ok(calls.some(c => c.m === "editMessageText"));
    const r = await pollLoginCode(store, code, { token: T });
    assert.equal(r.status, "ok"); assert.equal(verifySess(r.sess, T).id, 1);
  } finally { globalThis.fetch = f0; delete process.env.TELEGRAM_BOT_TOKEN; setStore(null); }
});
