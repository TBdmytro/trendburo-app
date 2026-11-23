import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, setStore } from "../lib/store.js";
import catalog, { _resetCatalogMemo } from "../api/catalog.js";

// Каталог пересобирается только когда сменился «отпечаток» базы; телефон с той же меткой получает одну строку
const store = new MemoryStore(); setStore(store);
function call(url) {
  return new Promise(resolve => {
    let body = "";
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { body = b || ""; resolve({ status: this.statusCode, headers: this.headers, text: body, body: body ? JSON.parse(body) : null }); } };
    catalog({ method: "GET", headers: {}, url }, res);
  });
}
const prod = (id, title) => ({ _id: id, _type: "product", status: "published", brand: "Dior", title, pricing: { ua: 1100, eu: 1080 }, images: [{ url: "https://cdn.sanity.io/images/x/y/a.jpg" }], variants: [], offers: [] });

test("каталог: без смены отпечатка не пересобирается; смена — пересборка; метка «тот же»", async () => {
  await store.put(prod("product.s1", "Lady Dior"));
  let stamp = "s1", lists = 0, stampCalls = 0;
  store.catStamp = async () => { stampCalls++; return stamp; };
  const list0 = store.list.bind(store); store.list = async (type, ...a) => { if (type === "product") lists++; return list0(type, ...a); };
  const realNow = Date.now;
  try {
    _resetCatalogMemo();
    const a = await call("/api/catalog?v=3");
    assert.equal(a.body.products.length, 1); assert.equal(lists, 1);
    const tag = a.headers["x-cat-tag"]; assert.match(tag, /^[a-f0-9]{16}$/);
    // через 10 минут (раньше пересобирали каждые 3) — отпечаток тот же, сборки нет
    const t0 = realNow(); Date.now = () => t0 + 10 * 60e3;
    const b = await call("/api/catalog?v=3"); assert.equal(b.body.products.length, 1); assert.equal(lists, 1, "без изменений каталог не пересобирается");
    assert.ok(stampCalls >= 2, "отпечаток проверяется");
    // телефон прислал ту же метку — короткий ответ
    const c = await call("/api/catalog?v=3&h=" + tag); assert.deepEqual(c.body, { same: true, tag }); assert.ok(c.text.length < 100);
    // правка в базе — новый отпечаток: пересборка, новая метка, старая метка получает полный каталог
    await store.put(prod("product.s2", "Book Tote")); stamp = "s2";
    Date.now = () => t0 + 12 * 60e3;
    await call("/api/catalog?v=3"); // первый после правки получает прежний каталог, свежий собирается в фоне
    let d = null; for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 10)); d = await call("/api/catalog?v=3&h=" + tag); if (d.body.products) break; }
    assert.equal(d.body.products.length, 2); assert.equal(lists, 2); assert.notEqual(d.headers["x-cat-tag"], tag);
  } finally { Date.now = realNow; delete store.catStamp; store.list = list0; _resetCatalogMemo(); }
});
