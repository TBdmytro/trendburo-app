import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, setStore } from "../lib/store.js";
import { setDnsCheck } from "../lib/http.js";
import handler from "../api/admin.js";
import catalog from "../api/catalog.js";

setDnsCheck(false);
process.env.ADMIN_PASSWORD = "test-password-123";
const store = new MemoryStore(); setStore(store);

function call(h, { method = "GET", query = {}, body, headers = {} } = {}) {
  return new Promise(resolve => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b ? JSON.parse(b) : null }); } };
    h({ method, query, body, headers, url: "/api/admin?" + new URLSearchParams(query) }, res);
  });
}

test("без входа импорт недоступен", async () => {
  const r = await call(handler, { method: "POST", query: { a: "jobCreate" }, body: { sourceId: "louis-vuitton", mode: "link", input: "https://de.louisvuitton.com/deu-de/products/x" }, headers: { "x-tb": "1" } });
  assert.equal(r.status, 401);
});
test("неверный пароль не пускает", async () => {
  const r = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "nope" } });
  assert.equal(r.status, 401);
});
test("после входа: без защитного заголовка запись запрещена, с ним — задача создаётся", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123", name: "Дмитрий" } });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"].split(";")[0];
  const noHdr = await call(handler, { method: "POST", query: { a: "jobCreate" }, body: { sourceId: "louis-vuitton", mode: "link", input: "https://de.louisvuitton.com/deu-de/products/x" }, headers: { cookie } });
  assert.equal(noHdr.status, 403);
  const ok = await call(handler, { method: "POST", query: { a: "jobCreate" }, body: { sourceId: "louis-vuitton", mode: "link", input: "https://de.louisvuitton.com/deu-de/products/x" }, headers: { cookie, "x-tb": "1" } });
  assert.equal(ok.status, 200); assert.equal(ok.body.job.createdBy, "Дмитрий");
  const src = await call(handler, { query: { a: "sources" }, headers: { cookie } });
  assert.equal(src.body.sources.find(s => s.id === "opticalh").connected, false);
  const bad = await call(handler, { method: "POST", query: { a: "sourceSave" }, body: { id: "dior", photoCopy: { allowed: true, basis: "" } }, headers: { cookie, "x-tb": "1" } });
  assert.equal(bad.status, 400);
  const prev = await call(handler, { method: "POST", query: { a: "pricingSave" }, body: { config: {} }, headers: { cookie, "x-tb": "1" } });
  assert.equal(prev.status, 400); // без предпросмотра правила цен не сохраняются
});
test("публичный каталог не отдаёт черновики и закупку", async () => {
  await store.put({ _id: "product.t", _type: "product", status: "draft", brand: "Dior", title: "X", pricing: { ua: 100 }, images: [], variants: [], offers: [] });
  await store.put({ _id: "product.p", _type: "product", status: "published", brand: "Dior", title: "Y", pricing: { ua: 1100, eu: 1080, dxb: 1080, purchase: 700, offerKey: "k" }, images: [{ url: "https://cdn.sanity.io/images/p/d/a.jpg" }], variants: [], offers: [{ _key: "k", purchase: 700, checkedAt: new Date().toISOString(), availability: {} }] });
  const r = await call(catalog);
  assert.equal(r.body.products.length, 1);
  assert.ok(!JSON.stringify(r.body).includes("700"));
});
