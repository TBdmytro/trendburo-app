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

test("словари с меняющимися ключами хранятся в базе с постоянными названиями полей", async () => {
  const { toDb, fromDb } = await import("../lib/store.js");
  const doc = { _id: "p", offers: [{ availability: { "3da379b8": { status: "online", price: 1 }, a1: { status: "out", price: 2 } } }], attempts: {}, categories: ["x"], coverage: { categories: { "womens-new": { pages: 1 } } } };
  const db = toDb(doc);
  assert.deepEqual(Object.keys(db.offers[0].availability), ["_kv"]);
  assert.equal(JSON.stringify(db).includes('"3da379b8":'), false);
  assert.deepEqual(db.categories, ["x"]);
  assert.deepEqual(fromDb(db), doc);
});

test("загрузка на сервере шагами: до конца, без дублей; «Остановить» прерывает; второй шаг одновременно не идёт", async () => {
  const { startLoad, runStep, stopLoad, loadState } = await import("../lib/catalogrun.js");
  const store = new MemoryStore();
  const { id } = await addSupplier(store, { url: "https://shop.example" }, { fetchImpl: f });
  let L = await startLoad(store, id);
  let r, steps = 0;
  do { r = await runStep(store, id, L.runId, { fetchImpl: f, stepMs: 1 }); steps++; } while (r.next && steps < 50);
  L = await loadState(store, id);
  assert.equal(L.status, "done");
  assert.equal(L.saved, 207);
  assert.equal((await store.list("product", {})).length, 207);
  // старый шаг (другой запуск) ничего не делает
  assert.equal((await runStep(store, id, "old", { fetchImpl: f })).next, false);
  // остановка
  L = await startLoad(store, id);
  await runStep(store, id, L.runId, { fetchImpl: f, stepMs: 1 });
  await stopLoad(store, id);
  assert.equal((await runStep(store, id, L.runId, { fetchImpl: f })).next, false);
  assert.equal((await loadState(store, id)).status, "stopped");
  assert.equal((await store.list("product", {})).length, 207);
  // аренда: пока шаг «жив», второй не стартует
  L = await startLoad(store, id, { resume: true });
  const s = await store.get("source." + id); await store.put({ ...s, load: { ...s.load, lease: { by: "x", until: new Date(Date.now() + 60000).toISOString() } } });
  assert.equal((await runStep(store, id, L.runId, { fetchImpl: f })).why, "busy");
});

test("категории: книги, коврики и бутылки Alo — «Другое», а не аксессуары; шарф — аксессуар", async () => {
  const { detectCategory } = await import("../lib/normalize.js");
  assert.equal(detectCategory("Accessories:Books", "Mindful Movement"), "other");
  assert.equal(detectCategory("Accessories:Yoga Mats", "Warrior Mat"), "other");
  assert.equal(detectCategory("Accessories:Water Bottles", "Alo Bottle"), "other");
  assert.equal(detectCategory("Accessories:Scarves", "Cashmere Scarf"), "accessories");
  assert.equal(detectCategory("Women:Leggings", "Airlift Legging"), "clothing");
  assert.equal(detectCategory("Accessories:Shoes:Sneakers", "Runner"), "shoes");
});

test("удалённые в админке товары не возвращаются при новой загрузке каталога (в том числе ночной)", async () => {
  const { rememberDeleted } = await import("../lib/catalogload.js");
  const store = new MemoryStore();
  const { id } = await addSupplier(store, { url: "https://shop.example" }, { fetchImpl: f });
  await loadCatalogPage(store, id, { page: 1, limit: 100, fetchImpl: f });
  const all = await store.list("product", {});
  const del = all.slice(0, 5).map(p => p._id);
  await store.delMany(del); await rememberDeleted(store, del);
  const r = await loadCatalogPage(store, id, { page: 1, limit: 100, fetchImpl: f });
  const after = await store.list("product", {});
  assert.equal(after.length, all.length - 5);
  assert.ok(!after.some(p => del.includes(p._id)));
  assert.equal(r.deleted, 5);
});
