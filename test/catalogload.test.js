// Загрузка каталога из админки порциями: каждая страница сразу в «Товарах», повтор не задваивает, распроданное не берём
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../lib/store.js";
import { addSupplier } from "../lib/suppliers.js";
import { loadCatalogPage } from "../lib/catalogload.js";
import { setDnsCheck } from "../lib/http.js";
setDnsCheck(false);

const prods = Array.from({ length: 230 }, (_, i) => ({ id: i + 1, title: `Hoodie ${i + 1}`, handle: `h-${i + 1}`, vendor: "Kith", product_type: "Hoodies", tags: [],
  options: [{ name: "Size" }], images: [{ id: i * 10, src: `https://cdn.shopify.com/x/${i}.jpg` }],
  variants: [{ sku: `K${i}-S`, option1: "S", price: "100", available: i % 10 !== 0 }, { sku: `K${i}-M`, option1: "M", price: "100", available: i % 10 !== 0 }] }));
const J = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const f = async url => {
  const u = new URL(url);
  if (u.pathname === "/robots.txt") return new Response("User-agent: *\n", { headers: { "content-type": "text/plain" } });
  if (u.pathname === "/meta.json") return J({ name: "Shop", currency: "EUR" });
  if (u.pathname === "/products.json") { const pg = +u.searchParams.get("page"), lim = +u.searchParams.get("limit"); return J({ products: prods.slice((pg - 1) * lim, pg * lim) }); }
  return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
};

test("каталог порциями: всё в наличии сохранено, повтор без дублей", async () => {
  const store = new MemoryStore();
  const { id } = await addSupplier(store, { url: "https://shop.example" }, { fetchImpl: f });
  let page = 1, saved = 0, r;
  do { r = await loadCatalogPage(store, id, { page, limit: 100, fetchImpl: f }); saved += r.saved; page++; } while (r.more);
  assert.equal(page - 1, 3);
  assert.equal(saved, 207); // 23 распроданных не берём
  const n = (await store.list("product", {})).length;
  assert.equal(n, 207);
  await loadCatalogPage(store, id, { page: 1, limit: 100, fetchImpl: f });
  assert.equal((await store.list("product", {})).length, n);
});
