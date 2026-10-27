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
