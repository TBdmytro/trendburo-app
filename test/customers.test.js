import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../lib/store.js";
import { makeManualOrder, clientStats, ordersFor } from "../lib/customers.js";

test("ручной заказ через менеджера: номер, видно клиенту, считается в статистике", async () => {
  const store = new MemoryStore();
  const c = { _id: "customer.7", _type: "customer", tg: { id: 7, username: "anna", name: "Анна" } };
  await assert.rejects(() => makeManualOrder(store, c, {}), /бренд или название/);
  const l = await makeManualOrder(store, c, { brand: "Hermès", title: "Birkin 30", price: "12 500", cost: "10000", status: "paid", dest: "eu", photo: "javascript:x" });
  assert.match(l.number, /^TB-\d+/); assert.equal(l.source, "manager"); assert.equal(l.tgId, 7);
  assert.equal(l.items[0].photo, "");
  const l2 = await makeManualOrder(store, c, { brand: "Dior", title: "Book Tote", price: "3000", status: "work" });
  assert.equal(l2.total, 3000);
  const mine = await ordersFor(store, 7);
  assert.equal(mine.length, 2); assert.ok(mine.every(o => o.viaManager));
  const s = clientStats([l, l2, { kind: "order", status: "delivered", total: 1200, dest: "ua" }, { kind: "availability", status: "new" }], { ua: 0.2, eu: 0.2, dxb: 0.2 });
  assert.equal(s.orders, 3); assert.equal(s.viaManager, 2); assert.equal(s.requests, 1);
  assert.equal(s.spent, 13700); assert.equal(s.earned, 2500 + 200);
});

test("для кого: по разделам магазина, детское, ваша отметка главнее", async () => {
  const { genderOf } = await import("../lib/catalog.js");
  assert.equal(genderOf({ sections: ["womens-shop-all"] }), "w");
  assert.equal(genderOf({ sections: ["mens"] }), "m");
  assert.equal(genderOf({ sections: ["womens", "mens", "bestsellers"] }), "u");
  assert.equal(genderOf({ sections: ["kids"] }), "k");
  assert.equal(genderOf({ gender: "u", sections: ["women"] }), "w");
  assert.equal(genderOf({ gender: "m", sections: ["women"] }), "m");
  assert.equal(genderOf({ gender: "w", overrides: { gender: "k" } }), "k");
  assert.equal(genderOf({}), "u");
});

test("взять снова удалённые товары сайта", async () => {
  const { rememberDeleted, deletedSet, forgetDeleted } = await import("../lib/catalogload.js");
  const store = new MemoryStore();
  await rememberDeleted(store, ["product.manual.dior-a1", "product.manual.dior-b2", "product.manual.ysl-c3"]);
  assert.equal(await forgetDeleted(store, "product.manual.dior-"), 2);
  assert.deepEqual([...await deletedSet(store)], ["product.manual.ysl-c3"]);
});

test("заявка на вход: решили в одном чате — во всех чатах «✓ Доступ открыт — кто», без кнопок", async () => {
  const { notifyRequest, setAccess, NOTIFY_ID } = await import("../lib/access.js");
  const store = new MemoryStore(); const old = process.env.TELEGRAM_BOT_TOKEN; process.env.TELEGRAM_BOT_TOKEN = "x";
  await store.put({ _id: NOTIFY_ID, _type: "settings", chats: [{ id: 100 }, { id: 200 }, { id: 300 }] });
  const c = await store.put({ _id: "customer.9", _type: "customer", tg: { id: 9, name: "Ірина" }, access: "pending" });
  const calls = []; let mid = 1; const send = async (m, b) => { calls.push([m, b]); return { message_id: mid++ }; };
  await notifyRequest(store, c, { send });
  assert.equal(calls.filter(([m, b]) => m === "sendMessage" && b.reply_markup).length, 3);
  await setAccess(store, 9, "ok", { by: "@dmytro", send });
  const ed = calls.filter(([m]) => m === "editMessageText");
  assert.equal(ed.length, 3); assert.match(ed[0][1].text, /✓ Доступ открыт — @dmytro/); assert.equal(ed[0][1].reply_markup, undefined);
  await setAccess(store, 9, "ok", { by: "@x", send }); assert.equal(calls.filter(([m]) => m === "editMessageText").length, 3); // второй раз не трогаем
  process.env.TELEGRAM_BOT_TOKEN = old;
});
