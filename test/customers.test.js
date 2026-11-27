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

test("клиент через менеджера без приложения: заказы с иконкой, личная ссылка переносит всё в аккаунт", async () => {
  const { createOfflineClient, linkInvite } = await import("../lib/customers.js");
  const store = new MemoryStore();
  await assert.rejects(() => createOfflineClient(store, {}), /Instagram, Telegram или телефон/);
  const off = await createOfflineClient(store, { name: "Олена К.", username: "@olena_k", phone: "+380671112233", city: "Київ", shoes: "38" }, "Дмитрий");
  assert.ok(off.offline); assert.match(off.invite, /^[a-z0-9]{12}$/); assert.equal(off.tg.username, "olena_k");
  const l = await makeManualOrder(store, off, { brand: "Chanel", title: "Classic Flap", price: "9800", icon: "bag", status: "bought" });
  assert.equal(l.cust, off._id); assert.equal(l.tgId, undefined); assert.equal(l.items[0].icon, "bag");
  assert.equal(await linkInvite(store, { id: 55, name: "Olena" }, "c_wrongtoken12"), null);
  // открыть ссылку ≠ получить заказы: только запрос, менеджер подтверждает
  const r = await linkInvite(store, { id: 55, username: "olena_k", name: "Olena" }, "c_" + off.invite);
  assert.equal(r.claim, true); assert.equal((await ordersFor(store, 55)).length, 0);
  assert.equal((await store.get(off._id)).claims[0].tgId, 55);
  // сотрудник, открывший ссылку клиента, запроса не создаёт
  await store.put({ _id: "customer.77", _type: "customer", tg: { id: 77 }, staff: true });
  assert.equal((await linkInvite(store, { id: 77 }, "c_" + off.invite)).staff, true);
  const { opClaim } = await import("../lib/staffops.js");
  const ok = await opClaim(store, { id: l._id, tgId: 55, ok: true }, "Дмитрий");
  assert.equal(ok.body.moved, 1); assert.equal(await store.get(off._id), null);
  const c = await store.get("customer.55"); assert.equal(c.profile.phone, "+380671112233"); assert.equal(c.sizes.shoes, "38");
  const mine = await ordersFor(store, 55);
  assert.equal(mine.length, 1); assert.equal(mine[0].items[0].icon, "bag");
  assert.equal(await linkInvite(store, { id: 55 }, "c_" + off.invite), null); // карточки больше нет
});

test("доставка, которую доплатил клиент, — не наш заработок; заказы с другим получателем — всё равно этого клиента", async () => {
  const s = clientStats([
    { kind: "order", status: "delivered", total: 22088, shipFee: 88, cost: 8000, dest: "eu", delivery: { name: "Sinkevych Svitlana" } },
    { kind: "order", status: "paid", total: 2422, shipFee: 48, cost: 2260, dest: "ua", delivery: { name: "Влада" } },
    { kind: "order", status: "delivered", total: 1048, shipFee: 48, dest: "ua", delivery: { name: "Охранник" } } // без закупки: оценка по наценке от суммы без доставки
  ], { ua: 0.25, eu: 0.25, dxb: 0.25 });
  assert.equal(s.orders, 3, "три заказа — все этого клиента, кому бы ни ехала посылка");
  assert.equal(s.spent, 22088 + 2422 + 1048, "клиент заплатил всё, включая доставку");
  assert.equal(s.earned, (22000 - 8000) + (2374 - 2260) + 200, "заработок без доставки");
  const { MemoryStore } = await import("../lib/store.js"); const { opLeads } = await import("../lib/staffops.js");
  const st = new MemoryStore();
  await st.put({ _id: "customer.513570559", _type: "customer", tg: { id: 513570559, name: "🌞", username: "clfemme" }, profile: { name: "Влада" } });
  await st.put({ _id: "lead.a", _type: "lead", kind: "order", status: "work", tgId: 513570559, tg: { id: 513570559, name: "🌞" }, delivery: { name: "Maria Nelep" }, items: [], createdAt: "2026-11-20T10:00:00Z" });
  const r = await opLeads(st, "");
  assert.equal(r.body.leads[0].cname, "Влада", "имя клиента — с его карточки, не получатель");
});
