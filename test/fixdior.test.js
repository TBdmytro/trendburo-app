import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, setStore } from "../lib/store.js";
import handler from "../api/admin.js";
process.env.ADMIN_PASSWORD = "test-password-123";
const store = new MemoryStore(); setStore(store);
function call(h, { method = "GET", query = {}, body, headers = {} } = {}) {
  return new Promise(resolve => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b ? JSON.parse(b) : null }); } };
    h({ method, query, body, headers, url: "/api/admin?" + new URLSearchParams(query) }, res); });
}
test("один раз: фото уже загруженных Dior — лицевой первым, мелкий дубль убран, на модели в конце; ваш порядок не трогаем", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0];
  const A = "https://assets.christiandior.com/is/image/diorprod/";
  const im = [A + "LOOK_H_1_E19?x", A + "1AB_E01?$default_GH$", A + "1AB_SBG_E03?r", A + "1AB_SBG_E01?r"].map(u => ({ url: u, sourceUrl: u }));
  await store.put({ _id: "product.manual.dior-1ab", _type: "product", brand: "Dior", title: "Bag", category: "bags", status: "published", images: im, coverFrom: "tile", offers: [] });
  await store.put({ _id: "product.manual.dior-1cd", _type: "product", brand: "Dior", title: "Bag 2", category: "bags", status: "published", images: im, overrides: { imageOrder: [im[0].url] }, offers: [] });
  const r = await call(handler, { query: { a: "products" }, headers: { cookie } }); assert.equal(r.status, 200);
  const p = await store.get("product.manual.dior-1ab");
  assert.deepEqual(p.images.map(i => i.url.replace(A, "")), ["1AB_SBG_E01?r", "1AB_SBG_E03?r", "LOOK_H_1_E19?x"]); assert.equal(p.coverFrom, null);
  assert.equal((await store.get("product.manual.dior-1cd")).images.length, 4);
});
