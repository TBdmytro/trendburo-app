import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../lib/store.js";
import * as W from "../lib/wishlist.js";

test("вишлист: клиент создаёт список, друг дарит частью и целиком, менеджер подтверждает деньги", async () => {
  const st = new MemoryStore();
  await st.put({ _id: "product.a", _type: "product", status: "published", title: "Keepall 45", brand: "Louis Vuitton", images: [{ url: "https://cdn.sanity.io/a.jpg" }], pricing: { ua: 3780 } });
  await st.put({ _id: "product.h", _type: "product", status: "draft", title: "Hidden", brand: "X", pricing: { ua: 10 } });
  const c = "customer.1";
  const s = await W.wlSave(st, c, "Анна Коваль", { title: "Мій день народження", occasion: "birthday", date: "2026-12-12", term: "date" });
  assert.equal(s.code, 200); const code = s.body.list.code; assert.match(code, /^[a-z2-9]{8}$/);
  assert.equal((await W.wlItem(st, c, { code, pid: "product.h" })).code, 404, "скрытый товар не добавляется");
  const it = (await W.wlItem(st, c, { code, pid: "product.a", size: "", note: "дуже хочу" })).body.list.items[0];
  assert.equal(it.price, 3780); assert.equal(it.left, 3780);
  assert.equal((await W.wlItem(st, "customer.2", { code, pid: "product.a" })).code, 404, "чужой список не правится");

  const pub = (await W.wlPublic(st, code)).body; assert.equal(pub.owner, "Анна"); assert.equal(pub.items[0].left, 3780);
  assert.equal((await W.wlGift(st, { code, k: it.k, amount: 100, name: "Марія" })).code, 400, "без контакта нельзя");
  const g1 = await W.wlGift(st, { code, k: it.k, amount: 100, name: "Марія", contact: "@maria", msg: "З днем!" });
  assert.equal(g1.code, 200); assert.equal(g1.body.amount, 100);
  const full = await W.wlGift(st, { code, k: it.k, full: true, anon: true, name: "Ольга", contact: "+380" });
  assert.equal(full.body.amount, 3680, "целиком — только то, что ещё не занято заявками");
  assert.equal((await W.wlGift(st, { code, k: it.k, full: true, name: "X", contact: "@x" })).code, 409, "второй раз целиком нельзя");

  const q = (await W.wlQueue(st)).body; assert.equal(q.counts.link, 2);
  const gid = q.gifts.find(g => g.amount === 100).id;
  assert.equal((await W.wlGiftSet(st, { id: gid, link: "http://bad" }, "Олена")).code, 400);
  await W.wlGiftSet(st, { id: gid, link: "https://pay.example/abc" }, "Олена");
  let status = (await W.wlGiftStatus(st, g1.body.token)).body; assert.equal(status.st, "link"); assert.equal(status.link, "https://pay.example/abc");
  await W.wlClaim(st, g1.body.token); assert.equal((await W.wlGiftStatus(st, g1.body.token)).body.st, "claimed");
  const paid = await W.wlGiftSet(st, { id: gid, st: "paid" }, "Олена"); assert.equal(paid.body.item.got, 100); assert.equal(paid.body.item.left, 3680);
  await W.wlGiftSet(st, { id: gid, st: "paid" }, "Олена"); assert.equal((await st.get("wl." + code)).items[0].got, 100, "повторное подтверждение не удваивает");

  // сюрприз до даты: клиент видит сумму, но не имена
  await W.wlSave(st, c, "Анна", { code, opts: { surprise: true } });
  const mine = (await W.wlMine(st, c)).body.lists[0]; assert.equal(mine.total, 100); assert.equal(mine.gifts.length, 0); assert.equal(mine.surprise, true);
  await W.wlSave(st, c, "Анна", { code, opts: { surprise: false } });
  assert.equal((await W.wlMine(st, c)).body.lists[0].gifts[0].name, "Марія");

  const top = await W.wlTopup(st, c, { code, k: it.k }); assert.equal(top.body.gift.amount, 3680);
  assert.equal((await W.wlItem(st, c, { code, del: it.k })).code, 400, "вещь с подарками не удаляется");
});

test("вишлист: просроченная ссылка — 410; плохие коды — 404", async () => {
  const st = new MemoryStore();
  await st.put({ _id: "wl.abcdefgh", _type: "wl", code: "abcdefgh", owner: "customer.1", title: "x", until: "2020-01-01T00:00:00Z", items: [] });
  assert.equal((await W.wlPublic(st, "abcdefgh")).code, 410);
  assert.equal((await W.wlPublic(st, "../../x")).code, 404);
  assert.equal((await W.wlGiftStatus(st, "zz")).code, 404);
});
