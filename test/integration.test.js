// Полный путь загрузки каталога на имитации настоящей базы Sanity (лимит 2000 полей, ревизии, задержка сети):
// старая база у лимита → кнопка «Загрузить каталог» → цепочка шагов на сервере → товары в базе, старые товары целы.
import test from "node:test";
import assert from "node:assert/strict";
import { SanityStore } from "../lib/store.js";
import { addSupplier } from "../lib/suppliers.js";
import { startLoad, runStep, stopLoad, loadState } from "../lib/catalogrun.js";
import { loadCatalogPage } from "../lib/catalogload.js";
import { setDnsCheck } from "../lib/http.js";
import { fakeSanity } from "./fakesanity.js";
setDnsCheck(false);

const SIZES = ["XS", "S", "M", "L", "XL"];
// магазин в духе Alo: 5 размеров, часть распродана, служебные позиции, мужские/женские дубли по артикулам
const shopProducts = n => Array.from({ length: n }, (_, i) => ({
  id: 1000 + i, title: `Airlift Legging ${i}`, handle: `airlift-${i}`, vendor: "Alo Yoga", product_type: i % 50 === 7 ? "Internal" : i % 3 ? "Women:Leggings" : "Men:Shorts", tags: [],
  options: [{ name: "Size" }, { name: "Color" }], images: Array.from({ length: 5 }, (_, k) => ({ id: i * 10 + k, src: `https://cdn.shopify.com/s/files/x/${i}-${k}.jpg` })),
  variants: SIZES.map((sz, k) => ({ sku: `ALO${i % 400}-${sz}`, option1: sz, option2: "Black", price: String(98 + (i % 7) * 10), available: i % 9 !== 0 && k !== 4 }))
}));
const shop = items => async (url, o) => {
  const u = new URL(url);
  const J = x => new Response(JSON.stringify(x), { headers: { "content-type": "application/json" } });
  if (u.pathname === "/robots.txt") return new Response("User-agent: *\n", { headers: { "content-type": "text/plain" } });
  if (u.pathname === "/meta.json") return J({ name: "Alo Yoga", currency: "EUR" });
  // разделы магазина: бестселлеры (свой порядок), женское, мужское
  const cols = { bestsellers: items.slice(0, 40).reverse(), womens: items.filter(p => /^Women/.test(p.product_type)), mens: items.filter(p => /^Men/.test(p.product_type)) };
  if (u.pathname === "/collections.json") return J({ collections: [{ handle: "bestsellers", title: "Bestsellers", products_count: 40 }, { handle: "womens", title: "Women", products_count: 1 }, { handle: "mens", title: "Men", products_count: 1 }, { handle: "sale-xyz", title: "Sale", products_count: 3 }] });
  const cm = u.pathname.match(/\/collections\/([a-z-]+)\/products\.json$/);
  if (cm) { const pg = +u.searchParams.get("page") || 1, lim = +u.searchParams.get("limit") || 30; return J({ products: (cols[cm[1]] || []).slice((pg - 1) * lim, pg * lim) }); }
  if (u.pathname.endsWith("/products.json")) { const pg = +u.searchParams.get("page") || 1, lim = +u.searchParams.get("limit") || 30; return J({ products: items.slice((pg - 1) * lim, pg * lim) }); }
  return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
};
const rnd = () => Math.random().toString(16).slice(2, 18);

async function setup({ oldBloated = 150, oldClean = 1500, items = 600, latencyMs = 0 } = {}) {
  const fs = fakeSanity({ latencyMs });
  const net = shop(shopProducts(items));
  const route = (u, o) => (new URL(u).hostname.endsWith("api.sanity.io") ? fs.fetchImpl(u, o) : net(u, o));
  const store = new SanityStore({ projectId: "test", token: "t", fetchImpl: route });
  const { id } = await addSupplier(store, { url: "https://www.alo.example" }, { fetchImpl: route });
  // старая база: товары со словарями наличия по кодам размеров (именно они съели лимит), задачи и позиции старых загрузок
  for (let i = 0; i < oldBloated; i++) fs.db.set("product.old" + i, { _id: "product.old" + i, _type: "product", _rev: "x", brand: "Other", title: "Old " + i, status: "published", overrides: i === 3 ? { title: "Моё название" } : {}, variants: SIZES.map(s => ({ _key: rnd(), size: s })), offers: [{ _key: "o", sourceId: "old", availability: {} }] });
  for (const d of fs.db.values()) if (d._id.startsWith("product.old")) d.offers[0].availability = Object.fromEntries(d.variants.map(v => [v._key, { status: "online", price: 100 }]));
  for (let i = 0; i < oldClean; i++) fs.db.set("product.clean" + i, { _id: "product.clean" + i, _type: "product", _rev: "x", brand: "Other", title: "Clean " + i, status: "draft", overrides: {}, variants: [], offers: [] });
  for (let i = 0; i < 20; i++) fs.db.set("job." + i, { _id: "job." + i, _type: "importJob", _rev: "x", status: "done", attempts: { [rnd()]: 1 } });
  for (let i = 0; i < 30; i++) fs.db.set("item." + i, { _id: "item." + i, _type: "importItem", _rev: "x", offer: { availability: { [rnd()]: { status: "out" } } } });
  return { fs, store, id, route };
}
async function chain(store, id, runId, route, { stepMs = 2000, max = 400 } = {}) {
  const steps = [];
  for (let n = 0; n < max; n++) { const t = Date.now(); const r = await runStep(store, id, runId, { fetchImpl: route, stepMs }); steps.push(Date.now() - t); if (!r.next) return { r, steps }; }
  throw new Error("цепочка не закончилась");
}

test("старая база у лимита полей: загрузка доходит до конца без единого отказа базы, старые товары целы", { timeout: 120000 }, async () => {
  const { fs, store, id, route } = await setup();
  assert.ok(fs.countPaths() > 1500, "исходная база должна быть близко к лимиту, сейчас " + fs.countPaths());
  const L0 = await startLoad(store, id);
  const { r } = await chain(store, id, L0.runId, route);
  const L = await loadState(store, id);
  assert.equal(r.done, true); assert.equal(L.status, "done");
  assert.equal(fs.stats.rejected, 0, "база ни разу не должна отказать");
  assert.ok(fs.stats.peak <= 2000);
  const prods = [...fs.db.values()].filter(d => d._type === "product");
  const alo = prods.filter(d => d.brand === "Alo Yoga");
  assert.ok(L.saved > 300, "сохранено " + L.saved);
  assert.equal(alo.length > 0, true);
  // все старые товары на месте, правки целы, наличие по размерам восстановлено
  assert.equal(prods.filter(d => d._id.startsWith("product.old")).length, 150);
  assert.equal(prods.filter(d => d._id.startsWith("product.clean")).length, 1500);
  const o3 = await store.get("product.old3");
  assert.deepEqual(o3.overrides, { title: "Моё название" });
  assert.equal(Object.keys(o3.offers[0].availability).length, 5);
  // у новых товаров наличие по размерам читается
  const a = await store.get(alo[0]._id);
  assert.ok(Object.keys(a.offers[0].availability).length >= 4);
  // служебные позиции и полностью распроданные не загружены
  assert.equal(alo.some(d => /Internal/.test(d.category || "")), false);
  // в базе больше нет полей с кодами размеров в названии
  assert.ok(fs.countPaths() < 800, "полей после загрузки: " + fs.countPaths());
});

test("повторная загрузка не плодит дубли; «Остановить» и «Продолжить» идут с того же места", { timeout: 120000 }, async () => {
  const { fs, store, id, route } = await setup({ oldBloated: 0, oldClean: 0 });
  let L = await startLoad(store, id); await chain(store, id, L.runId, route);
  const n1 = [...fs.db.values()].filter(d => d._type === "product").length;
  L = await startLoad(store, id); await chain(store, id, L.runId, route);
  assert.equal([...fs.db.values()].filter(d => d._type === "product").length, n1);
  // остановка посередине
  L = await startLoad(store, id);
  await runStep(store, id, L.runId, { fetchImpl: route, stepMs: 1 });
  const mid = await loadState(store, id);
  await stopLoad(store, id);
  assert.equal((await runStep(store, id, L.runId, { fetchImpl: route })).next, false);
  const st = await loadState(store, id); assert.equal(st.status, "stopped"); assert.equal(st.page, mid.page);
  // продолжение — та же позиция, дальше до конца
  L = await startLoad(store, id, { resume: true });
  assert.equal(L.page, mid.page); assert.equal(L.runId, mid.runId);
  await chain(store, id, L.runId, route);
  assert.equal((await loadState(store, id)).status, "done");
  assert.equal([...fs.db.values()].filter(d => d._type === "product").length, n1);
});

test("два шага одновременно: работает только один (защита ревизией)", { timeout: 60000 }, async () => {
  const { store, id, route } = await setup({ oldBloated: 0, oldClean: 0, items: 120 });
  const L = await startLoad(store, id);
  const [a, b] = await Promise.all([runStep(store, id, L.runId, { fetchImpl: route }), runStep(store, id, L.runId, { fetchImpl: route })]);
  assert.ok([a.why, b.why].some(w => w === "race" || w === "busy"), JSON.stringify([a, b]));
});

test("время: страница из 50 товаров укладывается с запасом при задержке базы 250 мс на запрос", { timeout: 120000 }, async () => {
  const { store, id, route } = await setup({ oldBloated: 0, oldClean: 300, items: 50, latencyMs: 250 });
  // база уже подготовлена
  await store.put({ _id: "settings.dbv", _type: "settings", v: 3 });
  const t = Date.now();
  const r = await loadCatalogPage(store, id, { page: 1, limit: 50, fetchImpl: route });
  const ms = Date.now() - t;
  assert.ok(r.saved > 30, "сохранено " + r.saved);
  assert.ok(ms < 25000, "страница заняла " + ms + " мс");
});

test("база как сейчас на сервере (перевод остановился на последнем шаге): загрузка идёт сразу, перевод доделывается после", { timeout: 120000 }, async () => {
  const { fs, store, id, route } = await setup({ oldBloated: 0, oldClean: 400 });
  await store.put({ _id: "settings.dbv", _type: "settings", v: 2, step: "full", cursor: "product.clean0200" });
  const L0 = await startLoad(store, id);
  // первый же шаг грузит товары, а не готовит базу
  await runStep(store, id, L0.runId, { fetchImpl: route, stepMs: 1 });
  assert.ok((await loadState(store, id)).saved > 0);
  await chain(store, id, L0.runId, route);
  assert.equal((await loadState(store, id)).status, "done");
  assert.equal((await store.get("settings.dbv")).v, 3);
  assert.equal(fs.stats.rejected, 0);
});

test("раскладка по разделам магазина: вкладки по умолчанию, порядок как у бренда, повторная раскладка", { timeout: 120000 }, async () => {
  const { store, id, route } = await setup({ oldBloated: 0, oldClean: 0, items: 300 });
  const L0 = await startLoad(store, id); await chain(store, id, L0.runId, route);
  const src = await store.get("source." + id);
  assert.deepEqual(src.tabs.map(t => t.t), ["Бестселлеры", "Женское", "Мужское"]);
  const prods = await store.list("product", {}, { limit: 5000 });
  const best = prods.filter(p => (p.sections || []).includes("bestsellers"));
  assert.ok(best.length >= 25, "в бестселлерах " + best.length);
  // порядок: в магазине бестселлеры идут от 39-го товара к 0-му
  const pos = p => p.secPos.find(x => x.s === "bestsellers").p;
  const first = best.sort((a, b) => pos(a) - pos(b))[0];
  assert.match(first.sourceUrl, /airlift-3[0-9]$/);
  assert.ok(prods.some(p => (p.sections || []).includes("womens")) && prods.some(p => (p.sections || []).includes("mens")));
  // выбрали свои разделы — раскладка заново, старые отметки сняты
  const { saveCollections } = await import("../lib/suppliers.js");
  await saveCollections(store, id, ["mens"], ["Мужское"]);
  const L1 = await startLoad(store, id, { mode: "sort" }); await chain(store, id, L1.runId, route);
  const after = await store.list("product", {}, { limit: 5000 });
  assert.equal(after.some(p => (p.sections || []).includes("bestsellers")), false);
  assert.ok(after.some(p => (p.sections || []).includes("mens")));
  assert.equal((await loadState(store, id)).status, "done");
});
