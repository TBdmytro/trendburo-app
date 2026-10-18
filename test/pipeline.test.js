import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setDnsCheck, checkUrl, parseRobots, robotsAllows, isPrivateIp } from "../lib/http.js";
import { parseProductPage, mapAvailability } from "../lib/jsonld.js";
import { normalize, shortTitle, detectCategory } from "../lib/normalize.js";
import { findMatch, chooseOffer, leadMax, effectiveAvailability, mergeOffer } from "../lib/match.js";
import { MemoryStore } from "../lib/store.js";
import { createJob, tick, cancelJob } from "../lib/worker.js";
import { publishItems, setStatus, saveOverrides } from "../lib/publish.js";
import { toStorefront } from "../lib/catalog.js";
import { SOURCES } from "../lib/sources.js";

setDnsCheck(false);
const fx = n => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
const LV = "https://de.louisvuitton.com/deu-de/products/test-tote-nvprod1";

/** Поддельная сеть: карта адрес → ответ (ТЕСТОВЫЙ РЕЖИМ). */
function fakeFetch(routes, log = []) {
  return async (url, opts) => {
    log.push(url);
    const r = typeof routes === "function" ? routes(url) : routes[url];
    if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    if (r.status && r.status >= 300 && r.status < 400) return new Response(null, { status: r.status, headers: { location: r.location } });
    return new Response(r.body ?? "", { status: r.status || 200, headers: { "content-type": r.type || "text/html; charset=utf-8" } });
  };
}
const robots = { "https://de.louisvuitton.com/robots.txt": { body: "User-agent: *\nDisallow: /deu-de/search\n", type: "text/plain" } };
const noSleep = async () => {};

test("защита ссылок: только https, только домен источника, без IP и внутренних адресов", async () => {
  await assert.rejects(checkUrl("http://de.louisvuitton.com/x", ["louisvuitton.com"]), /https/);
  await assert.rejects(checkUrl("https://evil.com/x", ["louisvuitton.com"]), /не относится/);
  await assert.rejects(checkUrl("https://127.0.0.1/x", ["louisvuitton.com"]), /IP/);
  await assert.rejects(checkUrl("https://louisvuitton.com.evil.io/x", ["louisvuitton.com"]), /не относится/);
  assert.ok(isPrivateIp("10.0.0.1") && isPrivateIp("192.168.1.2") && isPrivateIp("::1") && !isPrivateIp("8.8.8.8"));
});

test("robots.txt: запреты соблюдаются", () => {
  const g = parseRobots("User-agent: *\nCrawl-delay: 1\nDisallow: /*sort=\nDisallow: *fashion/products/couture-*\nAllow: */mylv/newsletter");
  assert.equal(robotsAllows(g, "/de_de/fashion/products/couture-X1"), false);
  assert.equal(robotsAllows(g, "/de_de/fashion/products/M123"), true);
  assert.equal(robotsAllows(g, "/cat?sort=price"), false);
  assert.equal(g.delay, 1);
});

test("разбор страницы: группа вариантов, цвета, GTIN, наличие по вариантам", () => {
  const raw = parseProductPage(fx("brand-product.html"), LV);
  assert.equal(raw.modelSku, "TST001");
  assert.equal(raw.variants.length, 2);
  assert.equal(raw.variants[0].color, "Braun");
  assert.equal(raw.variants[1].offers[0].availability, "boutique");
  assert.equal(raw.variants[0].images.length, 4);
  assert.equal(mapAvailability("https://schema.org/PreOrder"), "preorder");
});
test("разбор: один Product с offers по размерам → варианты", () => {
  const raw = parseProductPage(fx("brand-shoe.html"), "https://www.dior.com/de_de/fashion/products/SHO9");
  assert.equal(raw.variants.length, 2);
  assert.equal(raw.variants[1].offers[0].availability, "out");
  assert.equal(raw.images[0], "https://www.dior.com/img/test/shoe1.jpg");
});

test("нормализация: категория, пол, короткое название, неполнота", () => {
  const n = normalize(parseProductPage(fx("brand-product.html"), LV), SOURCES["louis-vuitton"]);
  assert.equal(n.model.category, "bags"); assert.equal(n.model.gender, "w");
  assert.equal(n.model.title, "Test Tote MM Canvas");
  assert.equal(n.offer.region, "DE"); assert.equal(n.offer.currency, "EUR"); assert.equal(n.offer.boutique, 2150);
  assert.equal(shortTitle("Louis Vuitton Neverfull MM Monogram - Braun", "Louis Vuitton"), "Neverfull MM Monogram");
  assert.equal(detectCategory("Herren Schuhe"), "shoes");
});

test("дубли: только по точным идентификаторам", () => {
  const n = normalize(parseProductPage(fx("brand-product.html"), LV), SOURCES["louis-vuitton"]);
  assert.equal(findMatch(n, []).status, "new");
  assert.equal(findMatch(n, [{ _id: "x", brand: "Louis Vuitton", modelSku: "TST001" }]).status, "update");
  assert.equal(findMatch(n, [{ _id: "y", brand: "Other", variants: [{ gtin: "3000000000028" }] }]).by, "GTIN/EAN");
  assert.equal(findMatch(n, [{ _id: "z", brand: "Louis Vuitton", title: "Test Tote MM Canvas" }]).status, "possible-duplicate");
});

test("выбор предложения: поставщик в приоритете, 14 дней, конфликт цена/срок", () => {
  assert.equal(leadMax("10-20"), 20); assert.equal(leadMax(14), 14); assert.equal(leadMax(null), null);
  const off = { _key: "off", sourceKind: "official", final: 500, variantMatch: true };
  const a = { _key: "a", sourceKind: "eyewear-supplier", final: 400, supplierLeadDays: 14, variantMatch: true };
  const b = { _key: "b", sourceKind: "eyewear-supplier", final: 380, supplierLeadDays: "10-20", variantMatch: true };
  const c = { _key: "c", sourceKind: "eyewear-supplier", final: 350, supplierLeadDays: null, variantMatch: true };
  assert.equal(chooseOffer([off, a, b, c]).primary, "a");
  const d = { _key: "d", sourceKind: "eyewear-supplier", final: 390, supplierLeadDays: 7, variantMatch: true };
  const e = { _key: "e", sourceKind: "eyewear-supplier", final: 360, supplierLeadDays: 12, variantMatch: true };
  const r = chooseOffer([d, e]); assert.equal(r.conflict, true); assert.equal(r.primary, null);
  assert.equal(chooseOffer([d, e], { strategy: "cheaper" }).primary, "e");
  const f = { _key: "f", sourceKind: "eyewear-supplier", final: 350, supplierLeadDays: 5, variantMatch: true };
  assert.equal(chooseOffer([d, f]).primary, "f");
  assert.equal(chooseOffer([{ ...a, variantMatch: false }, off]).primary, "off");
});

test("наличие: устаревшие данные → уточнить; ошибка не обнуляет цену", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  assert.equal(effectiveAvailability("online", "2026-09-29T00:00:00Z", now), "online");
  assert.equal(effectiveAvailability("online", "2026-09-20T00:00:00Z", now), "unknown");
  const prev = { boutique: 2000, availability: { v1: { status: "online" } }, errors: [] };
  const m = mergeOffer(prev, null, new Error("timeout"));
  assert.equal(m.boutique, 2000); assert.equal(m.availability.v1.status, "online"); assert.equal(m.errors.length, 1);
});

test("сквозной импорт: ссылка → предпросмотр → публикация → витрина; повтор без дубля", async () => {
  const store = new MemoryStore();
  const f = fakeFetch({ ...robots, [LV]: { body: fx("brand-product.html") } });
  const { job } = await createJob(store, { sourceId: "louis-vuitton", mode: "link", input: LV });
  const r = await tick(store, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, "done");
  const items = await store.list("importItem", { jobId: job._id });
  assert.equal(items.length, 1); assert.equal(items[0].kind, "new");
  assert.equal(items[0].pricing.ua, 2365); // 2150 × 1,10
  assert.equal(items[0].pricing.eu, 2325); // 2150 × 1,08 = 2322 → вверх до 2325
  const pub = await publishItems(store, [items[0]._id], { fetchImpl: f });
  assert.equal(pub[0].ok, true, pub[0].reason);
  const prod = await store.get(pub[0].productId);
  const sf = toStorefront(prod, Date.now());
  assert.equal(sf.brand, "Louis Vuitton"); assert.equal(sf.price.ua, 2365);
  assert.equal(sf.colors.length, 2);
  // разные цвета — разные фото
  assert.notEqual(sf.colors[0].image, sf.colors[1].image);
  // предметное фото — обложка, фото «на модели» в конце
  assert.ok(!/worn_model/.test(sf.images[0].src));
  // фото не скопированы: разрешения нет
  assert.equal(prod.images[0].rights, "source-link");
  // повторный импорт той же ссылки → обновление того же товара
  const j2 = (await createJob(store, { sourceId: "louis-vuitton", mode: "link", input: LV, now: new Date(Date.now() - 1000).toISOString() })).job;
  await tick(store, { fetchImpl: f, sleep: noSleep });
  const it2 = (await store.list("importItem", { jobId: j2._id }))[0];
  assert.equal(it2.kind, "update");
  await publishItems(store, [it2._id], { fetchImpl: f });
  assert.equal((await store.list("product")).length, 1);
});

test("идемпотентность: та же задача в очереди не создаётся дважды", async () => {
  const store = new MemoryStore();
  const a = await createJob(store, { sourceId: "louis-vuitton", mode: "link", input: LV });
  const b = await createJob(store, { sourceId: "louis-vuitton", mode: "link", input: LV + " " });
  assert.equal(b.existing, true); assert.equal(a.job._id, b.job._id);
});

test("защита от ботов: не обходим, задача останавливается с понятной причиной", async () => {
  const store = new MemoryStore();
  const urls = [1, 2, 3, 4].map(i => `https://de.louisvuitton.com/deu-de/products/p-${i}`);
  const f = fakeFetch(u => u.endsWith("robots.txt") ? robots["https://de.louisvuitton.com/robots.txt"] : { status: 403, body: fx("blocked.html") });
  await createJob(store, { sourceId: "louis-vuitton", mode: "links", input: urls.join("\n") });
  const r = await tick(store, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, "blocked");
  const j = (await store.list("importJob"))[0];
  assert.match(j.coverage.note, /обход не выполняется/);
  assert.equal(j.errors.length, 1); // первый же ответ защиты останавливает задачу — сайт не долбим
  const src = await store.get("source.louis-vuitton");
  assert.equal(src.check.state, "blocked");
  // повторный запуск сразу получает понятный отказ, без пустой задачи
  await assert.rejects(createJob(store, { sourceId: "louis-vuitton", mode: "link", input: urls[0] }), /не пускает автоматическую загрузку/);
});

test("удаление задачи и товаров: строки предпросмотра убираются, ссылки на удалённый товар снимаются", async () => {
  const { deleteJob } = await import("../lib/worker.js");
  const store = new MemoryStore();
  const csv = "brand;title;model_sku;sku;price;currency;region;availability;images;category\nDior;Сумка;B1;B1;4100;EUR;DE;in stock;https://x/1.jpg;bags";
  const { job } = await createJob(store, { sourceId: "file", mode: "file", input: csv });
  await tick(store, { sleep: noSleep });
  const [item] = await store.list("importItem", { jobId: job._id });
  const [{ productId }] = await publishItems(store, [item._id]);
  assert.equal(await store.count("importItem", { publishedAs: null, kind: ["new"] }), 0);
  await store.patchMany([item._id], { publishedAs: null });
  assert.equal(await store.count("importItem", { publishedAs: null, kind: ["new"] }), 1);
  await store.delMany([productId]);
  assert.equal(await store.get(productId), null);
  const r = await deleteJob(store, job._id);
  assert.equal(r.items, 1);
  assert.equal((await store.list("importItem")).length, 0); assert.equal(await store.get(job._id), null);
});

test("временная ошибка: повтор с задержкой и продолжение с места остановки", async () => {
  const store = new MemoryStore();
  let calls = 0; let t = Date.parse("2026-09-29T10:00:00Z");
  const f = fakeFetch(u => u.endsWith("robots.txt") ? robots["https://de.louisvuitton.com/robots.txt"] : (++calls === 1 ? { status: 500, body: "err" } : { body: fx("brand-product.html") }));
  await createJob(store, { sourceId: "louis-vuitton", mode: "link", input: LV, now: new Date(t).toISOString() });
  const r1 = await tick(store, { fetchImpl: f, sleep: noSleep, clock: () => t });
  assert.equal(r1.status, "waiting");
  const r0 = await tick(store, { fetchImpl: f, sleep: noSleep, clock: () => t });
  assert.equal(r0.done, 0); // рано — ждём задержку
  t += 6000;
  const r2 = await tick(store, { fetchImpl: f, sleep: noSleep, clock: () => t });
  assert.equal(r2.status, "done");
  assert.equal((await store.list("importItem")).length, 1);
});

test("категория: все страницы, только товары своего региона, без повторов; отчёт покрытия", async () => {
  const store = new MemoryStore();
  const cat = "https://de.louisvuitton.com/deu-de/women/handbags";
  const prod = u => ({ body: fx("brand-product.html").replace("TST001", "TST-" + u.slice(-1)).replace(/TST001-/g, "X" + u.slice(-1) + "-").replace(/30000000000(\d)(\d)/g, "4" + u.slice(-1) + "0000000000$2") });
  const f = fakeFetch(u => u.endsWith("robots.txt") ? robots["https://de.louisvuitton.com/robots.txt"]
    : u === cat ? { body: fx("category-p1.html") } : u === cat + "?page=2" ? { body: fx("category-p2.html") } : /nvprod\d$/.test(u) ? prod(u) : null);
  const { job } = await createJob(store, { sourceId: "louis-vuitton", mode: "category", input: cat, category: "Сумки" });
  let r; for (let i = 0; i < 5 && (!r || r.status !== "done"); i++) r = await tick(store, { fetchImpl: f, sleep: noSleep });
  const j = await store.get(job._id);
  assert.equal(j.status, "done");
  assert.equal(j.found, 3); assert.equal(j.coverage.pages, 2);
  assert.equal(j.coverage.categories["Сумки"].complete, true);
  assert.equal((await store.list("importItem")).length, 3);
});

test("отмена задачи", async () => {
  const store = new MemoryStore();
  const { job } = await createJob(store, { sourceId: "louis-vuitton", mode: "links", input: [1, 2].map(i => LV + i).join(" ") });
  await cancelJob(store, job._id);
  assert.equal((await store.get(job._id)).status, "cancelled");
  assert.equal((await tick(store, { fetchImpl: fakeFetch({}), sleep: noSleep })).done, 0);
});

test("ручные правки не перезаписываются синхронизацией; история с автором", async () => {
  const store = new MemoryStore();
  const f = fakeFetch({ ...robots, [LV]: { body: fx("brand-product.html") } });
  await createJob(store, { sourceId: "louis-vuitton", mode: "link", input: LV });
  await tick(store, { fetchImpl: f, sleep: noSleep });
  const it = (await store.list("importItem"))[0];
  const [{ productId }] = await publishItems(store, [it._id], { fetchImpl: f });
  await saveOverrides(store, productId, { title: "Мой Tote", pinnedPrice: 2400 }, "Дмитрий");
  await createJob(store, { sourceId: "louis-vuitton", mode: "link", input: LV, now: new Date(Date.now() - 5000).toISOString() });
  await tick(store, { fetchImpl: f, sleep: noSleep });
  const it2 = (await store.list("importItem")).find(i => i._id !== it._id);
  await publishItems(store, [it2._id], { fetchImpl: f });
  const p = await store.get(productId);
  const sf = toStorefront(p);
  assert.equal(sf.title, "Мой Tote"); assert.equal(sf.price.ua, 2400);
  assert.ok(p.history.some(h => h.by === "Дмитрий" && h.field === "title"));
  // снятие с публикации
  await setStatus(store, [productId], "draft");
  assert.equal(toStorefront(await store.get(productId)), null);
});

test("фото копируются только при разрешении с основанием", async () => {
  const store = new MemoryStore();
  await store.put({ _id: "source.louis-vuitton", _type: "sourceSettings", photoCopy: { allowed: true, basis: "Письмо LV от 29.09.2026" } });
  const img = new Uint8Array([255, 216, 255, 0, 1, 2]);
  const f = async (url) => url.endsWith(".jpg") ? new Response(img, { headers: { "content-type": "image/jpeg" } })
    : fakeFetch({ ...robots, [LV]: { body: fx("brand-product.html") } })(url);
  await createJob(store, { sourceId: "louis-vuitton", mode: "link", input: LV });
  await tick(store, { fetchImpl: f, sleep: noSleep });
  const it = (await store.list("importItem"))[0];
  const [res] = await publishItems(store, [it._id], { fetchImpl: f });
  const p = await store.get(res.productId);
  assert.equal(p.images[0].rights, "copied");
  assert.match(p.images[0].url, /cdn\.sanity\.io/);
  assert.equal(p.images[0].sourceUrl.startsWith("https://de.louisvuitton.com"), true);
});

test("CSV-импорт: группировка вариантов, цена, правило очков у поставщика", async () => {
  const store = new MemoryStore();
  const csv = "brand;title;model_sku;sku;color;price;purchase;currency;availability;images;category;lead_days\nGucci;GG1169S Sunglasses;GG1169S;GG1169S-001;Black;330;240;EUR;in stock;https://x/1.jpg|https://x/2.jpg|https://x/3.jpg;sunglasses;7\nGucci;GG1169S Sunglasses;GG1169S;GG1169S-002;Havana;330;240;EUR;in stock;https://x/4.jpg;sunglasses;7";
  await store.put({ _id: "source.file", _type: "sourceSettings", kindOverride: null });
  const { job } = await createJob(store, { sourceId: "file", mode: "file", input: csv });
  await tick(store, { sleep: noSleep });
  const items = await store.list("importItem", { jobId: job._id });
  assert.equal(items.length, 1); assert.equal(items[0].variants.length, 2);
  assert.equal(items[0].model.category, "eyewear");
});

test("плановое обновление: цена обновляется, ошибка источника не удаляет товар и не обнуляет цену", async () => {
  const { planRefresh } = await import("../api/cron.js");
  const store = new MemoryStore();
  let page = fx("brand-product.html");
  let fail = false;
  const f = async url => fail && !url.endsWith("robots.txt") ? new Response("x", { status: 500, headers: { "content-type": "text/html" } }) : fakeFetch({ ...robots, [LV]: { body: page } })(url);
  await createJob(store, { sourceId: "louis-vuitton", mode: "link", input: LV });
  await tick(store, { fetchImpl: f, sleep: noSleep });
  const [{ productId }] = await publishItems(store, [(await store.list("importItem"))[0]._id], { fetchImpl: f });
  await store.put({ _id: "source.louis-vuitton", _type: "sourceSettings", schedule: "daily" });
  // цена в источнике выросла
  page = page.replace(/2150\.00/g, "2300.00");
  const planned = await planRefresh(store);
  assert.equal(planned.length, 1);
  await tick(store, { fetchImpl: f, sleep: noSleep });
  assert.equal(toStorefront(await store.get(productId)).price.ua, 2530); // 2300 × 1,10
  // следующий день: источник падает
  fail = true;
  await store.put({ ...(await store.get("source.louis-vuitton")), lastRefreshAt: "2026-01-01T00:00:00Z" });
  await planRefresh(store);
  let t = Date.now();
  for (let i = 0; i < 4; i++) { t += 70000; await tick(store, { fetchImpl: f, sleep: noSleep, clock: () => t }); }
  const p = await store.get(productId);
  assert.equal(p.status, "published");
  assert.equal(toStorefront(p, t).price.ua, 2530);
  assert.ok(p.offers[0].errors.length >= 1);
});

test("закреплённая цена — для Украины; Европа пересчитывается от неё", async () => {
  const { priceFor } = await import("../lib/pipeline.js");
  const r = priceFor({ sourceKind: "official", boutique: 3000, purchase: null }, null, 3350);
  assert.equal(r.ua, 3350); assert.equal(r.eu, 3290); // 3350 × 1,08 / 1,10 = 3289,1 → 3290
});

test("фильтр категорий и пола: сохраняются только выбранные, остальное считается; размеры в вариантах", async () => {
  const store = new MemoryStore();
  const csv = [
    "brand;title;model_sku;sku;size;color;price;currency;region;availability;images;category;gender",
    "Dior;Жакет;J1;J1-48;48;Black;3400;EUR;DE;in stock;https://x/1.jpg;clothing;men",
    "Dior;Жакет;J1;J1-50;50;Black;3400;EUR;DE;out of stock;https://x/1.jpg;clothing;men",
    "Dior;Платье;D1;D1-36;36;Red;2900;EUR;DE;in stock;https://x/2.jpg;clothing;women",
    "Dior;Сумка;B1;B1;;Beige;4100;EUR;DE;in stock;https://x/3.jpg;bags;women"
  ].join("\n");
  const { job } = await createJob(store, { sourceId: "file", mode: "file", input: csv, onlyCats: ["clothing"], gender: "m" });
  await tick(store, { sleep: noSleep });
  const items = await store.list("importItem", { jobId: job._id });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].variants.map(v => v.size), ["48", "50"]);
  const j = await store.get(job._id);
  assert.equal(j.filtered, 2); assert.equal(j.status, "done");
  assert.deepEqual(j.labels, {}); // строки файла с «|» не принимаются за подписи разделов
});

test("разделы сайта: «Название | ссылка» даёт подпись раздела в отчёте", async () => {
  const store = new MemoryStore();
  const { job } = await createJob(store, { sourceId: "louis-vuitton", mode: "category", input: "Женские сумки | https://de.louisvuitton.com/deu-de/damen/handtaschen\nhttps://de.louisvuitton.com/deu-de/herren/taschen" });
  assert.deepEqual(job.discover, ["https://de.louisvuitton.com/deu-de/damen/handtaschen", "https://de.louisvuitton.com/deu-de/herren/taschen"]);
  assert.equal(job.labels["https://de.louisvuitton.com/deu-de/damen/handtaschen"], "Женские сумки");
});

test("ручная карточка: 3 фото, название, цена бутика → витрина с ценой ×1,10 и размерами", async () => {
  const { saveManualProduct } = await import("../lib/manual.js");
  const store = new MemoryStore();
  await assert.rejects(saveManualProduct(store, { brand: "Louis Vuitton", title: "Neverfull MM", category: "bags", boutique: 2200, images: [] }), /фото/);
  const p = await saveManualProduct(store, { brand: "Louis Vuitton", title: "Neverfull MM", category: "bags", gender: "w", boutique: 2200,
    images: ["https://cdn.sanity.io/images/x/y/1.jpg", "https://cdn.sanity.io/images/x/y/2.jpg", "https://cdn.sanity.io/images/x/y/3.jpg"], availability: "online" });
  assert.equal(p.status, "published"); assert.equal(p.pricing.ua, 2420); assert.equal(p.pricing.eu, 2380);
  const sf = toStorefront(p);
  assert.equal(sf.images.length, 3); assert.equal(sf.price.ua, 2420); assert.equal(sf.title, "Neverfull MM"); assert.equal(sf.orderable, true);
  const shoe = await saveManualProduct(store, { brand: "Dior", title: "B27", category: "shoes", gender: "m", boutique: 1150, sizes: ["40", "41"], images: ["https://cdn.sanity.io/images/x/y/4.jpg"] });
  assert.deepEqual(toStorefront(shoe).sizes.map(s => s.size), ["40", "41"]);
  // правка той же карточки не создаёт новую
  const again = await saveManualProduct(store, { id: p._id, brand: "Louis Vuitton", title: "Neverfull MM", category: "bags", boutique: 2300, images: p.images.map(i => i.url) });
  assert.equal(again._id, p._id); assert.equal(again.pricing.ua, 2530);
  assert.equal((await store.list("product")).length, 2);
});

/* ---------- Поставщик-каталог, подключённый по ссылке (Shopify, цены в долларах) ---------- */
import { detectSupplier, addSupplier, allSourceIds, removeSupplier } from "../lib/suppliers.js";
import { saveManualFx, toEur, parseEcb } from "../lib/fx.js";

function shopFixture(n, { drop = [] } = {}) {
  const products = [];
  for (let i = 1; i <= n; i++) if (!drop.includes(i)) products.push({
    id: i, title: `Hoodie ${i}`, handle: `hoodie-${i}`, vendor: i % 2 ? "Kith" : "Fear of God", product_type: "Hoodies", tags: ["Mens", "Apparel"],
    options: [{ name: "Size" }], images: [{ id: 10 + i, src: `https://cdn.shopify.com/s/files/h${i}-1.jpg` }, { id: 20 + i, src: `https://cdn.shopify.com/s/files/h${i}-2.jpg` }, { id: 30 + i, src: `https://cdn.shopify.com/s/files/h${i}-3.jpg` }],
    variants: [{ sku: `K${i}-S`, option1: "S", price: "234.00", available: true }, { sku: `K${i}-M`, option1: "M", price: "234.00", available: false }]
  });
  return products;
}
function shopFetch(state) {
  return fakeFetch(u => {
    if (u.endsWith("/robots.txt")) return { body: "User-agent: *\nDisallow: /cart\n", type: "text/plain" };
    if (u.includes("/meta.json")) return { body: JSON.stringify({ name: "Kith", currency: "USD" }), type: "application/json" };
    const m = u.match(/\/products\.json\?limit=(\d+)(?:&page=(\d+))?/);
    if (m) { const page = Number(m[2] || 1), all = shopFixture(state.n, state), lim = Number(m[1]); return { body: JSON.stringify({ products: all.slice((page - 1) * lim, page * lim) }), type: "application/json" }; }
    return null;
  });
}

test("fx: курс ЕЦБ читается, пересчёт в евро с коэффициентом", () => {
  assert.equal(parseEcb("<Cube currency='USD' rate='1.1700'/><Cube currency='GBP' rate='0.8700'/>").USD, 1.17);
  assert.equal(toEur(234, "USD", { rates: { USD: { rate: 1.17 } } }), 200);
  assert.equal(toEur(234, "USD", { rates: { USD: { rate: 1.17 } } }, 1.1), 220);
  assert.equal(toEur(100, "EUR", null), 100);
});

test("поставщик по ссылке: проверка, подключение, весь каталог скрытыми товарами, повтор без дублей, исчезнувшие — нет в наличии", async () => {
  const store = new MemoryStore(); const state = { n: 3 };
  await saveManualFx(store, { USD: 1.17 });
  const det = await detectSupplier("kith.com", { fetchImpl: shopFetch(state) });
  assert.ok(det.ok, det.reason); assert.equal(det.currency, "USD"); assert.equal(det.kind, "retailer"); assert.equal(det.sample, 3);
  const { id } = await addSupplier(store, { url: "https://kith.com" }, { fetchImpl: shopFetch(state) });
  assert.ok((await allSourceIds(store)).includes(id));
  const { job } = await createJob(store, { sourceId: id, mode: "full" });
  for (let i = 0; i < 10; i++) { const r = await tick(store, { fetchImpl: shopFetch(state), sleep: noSleep }); if (!r.jobId) break; }
  const j1 = await store.get(job._id);
  assert.equal(j1.status, "done", JSON.stringify(j1.errors)); assert.equal(j1.saved, 3);
  let prods = await store.list("product");
  assert.equal(prods.length, 3); assert.ok(prods.every(p => p.status === "draft"), "новые товары скрыты с витрины");
  const p1 = prods.find(p => p.title.includes("Hoodie 1"));
  assert.equal(p1.offers[0].boutique, 200, "234 $ / 1.17 = 200 €"); assert.equal(p1.pricing.ua, 235, "магазин: 200 + минимум 25 € за одежду + 10 € доставки");
  assert.equal(p1.category, "clothing"); assert.equal(p1.gender, "m"); assert.deepEqual(p1.sizes, ["S", "M"]);
  assert.equal((await store.list("importItem")).length, 0, "каталог не засоряет предпросмотр");
  // показываем один товар, затем поставщик убрал товар 3 и добавил 4
  await setStatus(store, [p1._id], "published");
  state.n = 4; state.drop = [3];
  const { job: job2 } = await createJob(store, { sourceId: id, mode: "full", meta: { refresh: true } });
  for (let i = 0; i < 10; i++) { const r = await tick(store, { fetchImpl: shopFetch(state), sleep: noSleep }); if (!r.jobId) break; }
  assert.equal((await store.get(job2._id)).status, "done");
  prods = await store.list("product");
  assert.equal(prods.length, 4, "без дублей: 3 прежних + 1 новый");
  assert.equal((await store.get(p1._id)).status, "published", "показанный товар остаётся на витрине");
  const gone = prods.find(p => p.title.includes("Hoodie 3"));
  assert.ok(Object.values(gone.offers[0].availability).every(a => a.status === "out"), "исчезнувший товар — нет в наличии");
  assert.equal(toStorefront(await store.get(p1._id)).price.ua, 235);
  // отключение: показанные товары скрываются
  await removeSupplier(store, id);
  assert.equal((await store.get(p1._id)).status, "draft");
  assert.ok(!(await allSourceIds(store)).includes(id));
});

test("поставщик по ссылке: robots.txt запрещает или нет каталога — не подключаем", async () => {
  const f1 = fakeFetch(u => u.endsWith("/robots.txt") ? { body: "User-agent: *\nDisallow: /products\n", type: "text/plain" } : null);
  assert.equal((await detectSupplier("https://closed.example", { fetchImpl: f1 })).ok, false);
  const f2 = fakeFetch(u => u.endsWith("/robots.txt") ? { body: "", type: "text/plain" } : { body: "<html></html>" });
  const d2 = await detectSupplier("https://nocatalog.example", { fetchImpl: f2 });
  assert.equal(d2.ok, false); assert.match(d2.reason, /не магазин на Shopify/);
});

test("скриншоты: ответ Gemini чистится, цена в USD пересчитывается, мусор отбрасывается", async () => {
  const { cleanReading, readScreen } = await import("../lib/screens.js");
  const fx = { rates: { USD: { rate: 1.17 } } };
  const r = cleanReading({ isProduct: true, brand: " Kith ", title: "Hoodie", price: "185", currency: "usd", sizes: ["S", "M"], category: "clothing", gender: "m", box: [100, 50, 600, 950] }, fx);
  assert.equal(r.currency, "USD"); assert.equal(r.priceEur, 158.12); assert.deepEqual(r.box, [100, 50, 600, 950]); assert.equal(r.brand, "Kith");
  const bad = cleanReading({ isProduct: true, brand: "X", title: "Y", price: -5, currency: "XYZ", category: "rockets", gender: "q", box: [0, 0, 5, 5] }, fx);
  assert.equal(bad.price, null); assert.equal(bad.category, "other"); assert.equal(bad.gender, "u"); assert.equal(bad.box, null); assert.equal(bad.currencyKnown, false);
  await assert.rejects(readScreen("AAAA", "image/jpeg", { fx, key: "" }), /GEMINI_API_KEY/);
  const f429 = async () => new Response("{}", { status: 429 });
  await assert.rejects(readScreen("AAAA", "image/jpeg", { fx, key: "k", fetchImpl: f429 }), e => e.retryAfter > 0);
  let sentKeyInUrl = null;
  const fok = async (url, o) => { sentKeyInUrl = String(url).includes("k-secret"); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ isProduct: true, brand: "LV", title: "Keepall", price: 2600, currency: "EUR", category: "bags", gender: "m", box: [0, 0, 900, 900] }) }] } }] }), { status: 200 }); };
  const ok = await readScreen("AAAA", "image/jpeg", { fx, key: "k-secret", fetchImpl: fok });
  assert.equal(ok.priceEur, 2600); assert.equal(sentKeyInUrl, false);
});

test("витрина: раскладка Ленты, тексты и стандартные подборки", async () => {
  const { cleanSite, seedRails, listItems, getSite } = await import("../lib/cms.js");
  const s = cleanSite({ feed: [{ id: "rails" }, { id: "optix", on: false }, { id: "hack" }, { id: "rails" }], texts: { "how.title": " Как это работает ", evil: "<script>" }, hiddenServices: ["travel", "x"] });
  assert.equal(s.feed[0].id, "rails"); assert.equal(s.feed.length, 9); assert.equal(s.optix.on, false);
  assert.deepEqual(s.texts, { "how.title": "Как это работает" }); assert.deepEqual(s.hiddenServices, ["travel"]);
  const store = new MemoryStore();
  assert.equal(await seedRails(store), true); assert.equal((await listItems(store, "rail")).length, 3);
  assert.equal(await seedRails(store), false); assert.equal((await getSite(store)).railsSeeded, true);
});

test("telegram bot: replies and setup", async () => {
  const { replyFor, hookSecret, setupBot } = await import("../api/bot.js");
  const base = "https://shop.example";
  assert.equal(replyFor("/start", base, 1).reply_markup.inline_keyboard[0][0].web_app.url, base + "/");
  assert.equal(replyFor("/admin@tb_bot", base, 1).reply_markup.inline_keyboard[0][0].web_app.url, base + "/admin.html");
  assert.match(replyFor("/id", base, 42).text, /42/);
  assert.equal(hookSecret("a").length, 40); assert.notEqual(hookSecret("a"), hookSecret("b"));
  const calls = [];
  const fetchImpl = async (url, o) => { const m = url.split("/").pop(); calls.push([m, JSON.parse(o.body)]); return { json: async () => ({ ok: true, result: m === "getMe" ? { username: "tb_bot", first_name: "TB" } : true }) }; };
  const r = await setupBot(base, { token: "T", fetchImpl });
  assert.equal(r.username, "tb_bot");
  assert.equal(calls.find(c => c[0] === "setChatMenuButton")[1].menu_button.web_app.url, base + "/");
  assert.equal(calls.find(c => c[0] === "setWebhook")[1].secret_token, hookSecret("T"));
  await assert.rejects(() => setupBot("http://x", { token: "T", fetchImpl }));
});

test("banners: places, audience, stats; site theme", async () => {
  const { cleanItem, cleanSite, addBannerStats, bannerStats } = await import("../lib/cms.js");
  const { MemoryStore } = await import("../lib/store.js");
  const d = cleanItem("banner", { title: "x", places: ["feed_mid", "cat:bags", "bad", "feed_mid"], aud: "m" }).doc;
  assert.deepEqual(d.places, ["feed_mid", "cat:bags"]); assert.equal(d.aud, "m");
  assert.deepEqual(cleanItem("banner", { title: "x" }).doc.places, ["feed"]);
  assert.equal(cleanSite({ theme: { preset: "olive" } }).theme.accent, "#4e6340");
  assert.equal(cleanSite({ theme: { accent: "#123456", cats: { bags: ["#ffffff", "#000000"], zzz: ["#fff", "#000"] } } }).theme.preset, "custom");
  assert.deepEqual(Object.keys(cleanSite({ theme: { cats: { bags: ["#ffffff", "#000000"], zzz: ["#ffffff", "#000000"] } } }).theme.cats), ["bags"]);
  const store = new MemoryStore();
  await addBannerStats(store, { v: { "cms.banner.abc123def456": 3, "evil": 9 }, c: { "cms.banner.abc123def456": 999 } });
  await addBannerStats(store, { v: { "cms.banner.abc123def456": 1 } });
  const s = await bannerStats(store);
  assert.equal(s.views["cms.banner.abc123def456"], 4); assert.equal(s.clicks["cms.banner.abc123def456"], 50); assert.equal(s.views.evil, undefined);
});

test("скидка и «Новинка» со сроком: заканчиваются сами, размер и материал попадают на витрину", () => {
  const base = { _id: "p1", status: "published", brand: "Louis Vuitton", title: "Keepall 50", category: "bags", pricing: { ua: 2860, eu: 2700, dxb: 2700 }, offers: [], variants: [], images: [] };
  const now = Date.parse("2026-10-10T12:00:00Z");
  const p = { ...base, overrides: { sale: { pct: 10, until: "2026-10-17" }, isNew: "on", newUntil: "2026-10-12", dims: "50 × 29 × 23 см", material: "Канва и кожа" } };
  const sf = toStorefront(p, now);
  assert.equal(sf.price.ua, 2574); assert.equal(sf.oldPrice.ua, 2860); assert.equal(sf.sale, 10);
  assert.equal(sf.isNew, true); assert.equal(sf.dims, "50 × 29 × 23 см"); assert.equal(sf.material, "Канва и кожа");
  const later = toStorefront(p, Date.parse("2026-10-18T12:00:00Z"));
  assert.equal(later.price.ua, 2860); assert.equal(later.oldPrice, undefined); assert.equal(later.isNew, false);
  assert.equal(toStorefront({ ...base, overrides: {} }, now).isNew, false); // без метки — не новинка
});

test("правки скидки чистятся: процент 1–90, лишнее отбрасывается", async () => {
  const { cleanOverride } = await import("../lib/publish.js");
  assert.deepEqual(cleanOverride("sale", { pct: "15", until: "2026-10-20T18:00" }), { pct: 15, until: "2026-10-20T18:00" });
  assert.equal(cleanOverride("sale", { pct: 0 }), null);
  assert.equal(cleanOverride("sale", { pct: 95 }), null);
  assert.deepEqual(cleanOverride("sale", { pct: 10, until: "завтра" }), { pct: 10, until: null });
  assert.equal(cleanOverride("dims", "  50 ×   29 см "), "50 × 29 см");
});

test("ручной товар с несколькими цветами: у каждого цвета своё фото, витрина знает номер фото", async () => {
  const { saveManualProduct } = await import("../lib/manual.js");
  const store = new MemoryStore();
  const imgs = ["https://cdn.sanity.io/a.jpg", "https://cdn.sanity.io/b.jpg", "https://cdn.sanity.io/c.jpg"];
  const p = await saveManualProduct(store, { brand: "Louis Vuitton", title: "Mini Bastille", category: "bags", boutique: 1500, images: imgs,
    colors: [{ name: "Black", image: imgs[0] }, { name: "Ebène", image: imgs[2] }] });
  assert.deepEqual(p.colors, ["Black", "Ebène"]);
  const sf = toStorefront({ ...p, status: "published" });
  assert.equal(sf.colors.length, 2);
  assert.equal(sf.colors[1].name, "Ebène"); assert.equal(sf.colors[1].idx, 2);
  const one = await saveManualProduct(store, { brand: "Dior", title: "Saddle", category: "bags", boutique: 3000, images: imgs, color: "Blue" });
  assert.deepEqual(one.colors, ["Blue"]);
});

test("поставщик в долларах с европейским разделом (/en-de): берём цены Европы в евро, ссылки без дублей", async () => {
  const store = new MemoryStore();
  const eu = fx => fx.map(p => ({ ...p, variants: p.variants.map(v => ({ ...v, price: "220.00" })) }));
  const f = fakeFetch(u => {
    if (u.endsWith("/robots.txt")) return { body: "User-agent: *\nDisallow: /*/cart.js\n", type: "text/plain" };
    if (u.includes("/meta.json")) return { body: JSON.stringify({ name: "Alo", currency: "USD" }), type: "application/json" };
    if (/\/en-de\/products\/hoodie-1$/.test(u)) return { body: '<script>Shopify.currency = {"active":"EUR","rate":"0.92"};</script>', type: "text/html" };
    const m = u.match(/(\/en-de)?\/products\.json\?limit=(\d+)(?:&page=(\d+))?/);
    if (m) { const page = Number(m[3] || 1), all = shopFixture(2), lim = Number(m[2]); const list = m[1] ? eu(all) : all; return { body: JSON.stringify({ products: list.slice((page - 1) * lim, page * lim) }), type: "application/json" }; }
    return null;
  });
  const det = await detectSupplier("aloyoga.com", { fetchImpl: f });
  assert.ok(det.ok, det.reason); assert.equal(det.market, "/en-de"); assert.equal(det.currency, "EUR"); assert.equal(det.baseCurrency, "USD");
  const { id, source } = await addSupplier(store, { url: "https://aloyoga.com" }, { fetchImpl: f });
  assert.equal(source.custom.market, "/en-de"); assert.equal(source.custom.region, "EU");
  await createJob(store, { sourceId: id, mode: "full" });
  for (let i = 0; i < 10; i++) { const r = await tick(store, { fetchImpl: f, sleep: noSleep }); if (!r.jobId) break; }
  const p = (await store.list("product")).find(x => x.title.includes("Hoodie 1"));
  assert.equal(p.offers[0].boutique, 220, "цена из европейского раздела, без пересчёта по курсу");
  assert.ok(!String(p.offers[0].url || p.url || "").includes("/en-de"), "адрес товара прежний — без дублей");
});

test("поставщик в долларах, Европа по стране посетителя (Sporty & Rich): выбираем Германию, цены в евро", async () => {
  const store = new MemoryStore(); const st = { de: true, seen: [] };
  const eu = fx => fx.map(p => ({ ...p, variants: p.variants.map(v => ({ ...v, price: "230.00" })) }));
  const f = (url, opts) => { const c = opts?.headers?.Cookie || ""; st.seen.push(c); return fakeFetch(u => {
    const de = st.de && c.includes("localization=DE");
    if (u.endsWith("/robots.txt")) return { body: "User-agent: *\nDisallow: /cart\n", type: "text/plain" };
    if (u.includes("/meta.json")) return { body: JSON.stringify({ name: "Sporty & Rich", currency: "USD" }), type: "application/json" };
    if (/\/products\/hoodie-1$/.test(u)) return { body: de ? '<meta property="og:price:amount" content="230,00"><script>Shopify.currency = {"active":"EUR","rate":"0.9"};</script>' : '<meta property="og:price:amount" content="190.00"><script>Shopify.currency = {"active":"USD","rate":"1.0"};</script>', type: "text/html" };
    if (/\/$/.test(u)) return { body: de ? '<script>Shopify.currency = {"active":"EUR","rate":"0.9"};</script>' : '<script>Shopify.currency = {"active":"USD","rate":"1.0"};</script>', type: "text/html" };
    const m = u.match(/\/products\.json\?limit=(\d+)(?:&page=(\d+))?/);
    if (m) { const page = Number(m[2] || 1), lim = Number(m[1]), all = de ? eu(shopFixture(2)) : shopFixture(2); return { body: JSON.stringify({ products: all.slice((page - 1) * lim, page * lim) }), type: "application/json" }; }
    return null;
  })(url, opts); };
  const det = await detectSupplier("sportyandrich.com", { fetchImpl: f });
  assert.ok(det.ok, det.reason); assert.equal(det.geoEu, true); assert.equal(det.currency, "EUR"); assert.equal(det.market, "");
  const { id, source } = await addSupplier(store, { url: "https://sportyandrich.com" }, { fetchImpl: f });
  assert.equal(source.custom.region, "EU"); assert.equal(source.custom.shopCurrency, "EUR"); assert.equal(source.custom.geoEu, true);
  await createJob(store, { sourceId: id, mode: "full" });
  for (let i = 0; i < 10; i++) { const r = await tick(store, { fetchImpl: f, sleep: noSleep }); if (!r.jobId) break; }
  const p = (await store.list("product")).find(x => x.title.includes("Hoodie 1"));
  assert.equal(p.offers[0].boutique, 230, "цена Германии в евро, без пересчёта долларов по курсу");
  // магазин перестал отдавать евро — загрузка останавливается, витрина не трогается
  st.de = false;
  const j = await createJob(store, { sourceId: id, mode: "full" });
  const r = await tick(store, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, "failed");
  assert.match((await store.get(j._id || j.id || r.jobId)).errors.at(-1).text, /не в евро/);
});

test("поставщик в долларах без цен Европы: предупреждение, автопубликация выключена", async () => {
  const store = new MemoryStore(); const state = { n: 2 };
  await saveManualFx(store, { USD: 1.17 });
  const det = await detectSupplier("kith.com", { fetchImpl: shopFetch(state) });
  assert.ok(det.ok); assert.equal(det.euPrices, false); assert.equal(det.geoEu, false);
  const { id, source } = await addSupplier(store, { url: "https://kith.com" }, { fetchImpl: shopFetch(state) });
  assert.ok(source.custom.checks.some(c => /Европейских цен нет/.test(c)));
  const doc = await store.get("source." + id); await store.put({ ...doc, autoPublish: true });
  await createJob(store, { sourceId: id, mode: "full" });
  for (let i = 0; i < 10; i++) { const r = await tick(store, { fetchImpl: shopFetch(state), sleep: noSleep }); if (!r.jobId) break; }
  const prods = await store.list("product");
  assert.ok(prods.length > 0); assert.ok(prods.every(p => p.status !== "published"), "цены США на витрину сами не попадают");
});

test("цена на странице товара: разные форматы", async () => {
  const { pagePrice } = await import("../lib/suppliers.js");
  assert.equal(pagePrice('<meta property="og:price:amount" content="1.234,50">'), 1234.5);
  assert.equal(pagePrice('<meta property="og:price:amount" content="1,234.50">'), 1234.5);
  assert.equal(pagePrice('<meta property="og:price:amount" content="230,00">'), 230);
  assert.equal(pagePrice('<meta property="og:price:amount" content="230">'), 230);
});

test("поставщик: загрузка выбранных разделов не помечает остальные товары «нет в наличии»", async () => {
  const store = new MemoryStore(); const state = { n: 3 };
  await saveManualFx(store, { USD: 1.17 });
  const f = shopFetch(state);
  const f2 = fakeFetch(u => /\/collections\/bestsellers\/products\.json/.test(u) ? { body: JSON.stringify({ products: shopFixture(1) }), type: "application/json" } : null);
  const both = async (u, o) => { const r = await f2(u, o); return r.status === 404 ? f(u, o) : r; };
  const { id } = await addSupplier(store, { url: "https://kith.com" }, { fetchImpl: f });
  await createJob(store, { sourceId: id, mode: "full" });
  for (let i = 0; i < 10; i++) { const r = await tick(store, { fetchImpl: f, sleep: noSleep }); if (!r.jobId) break; }
  const { saveCollections } = await import("../lib/suppliers.js");
  await saveCollections(store, id, ["bestsellers"]);
  const { job } = await createJob(store, { sourceId: id, mode: "full" });
  for (let i = 0; i < 10; i++) { const r = await tick(store, { fetchImpl: both, sleep: noSleep }); if (!r.jobId) break; }
  const j = await store.get(job._id);
  assert.equal(j.status, "done", JSON.stringify(j.errors)); assert.ok(j.partial); assert.ok(!j.gone, "ничего не помечено исчезнувшим");
  const p3 = (await store.list("product")).find(p => p.title.includes("Hoodie 3"));
  assert.ok(Object.values(p3.offers[0].availability).some(a => a.status !== "out"));
});

test("магазины: запросы просят английский язык, Германия выбирается только для «Европы по стране»", async () => {
  const { makeNet } = await import("../lib/sources.js");
  const seen = [];
  const f = async (url, opts) => { seen.push(opts.headers); return new Response(url.endsWith("robots.txt") ? "" : "{}", { status: 200, headers: { "content-type": url.endsWith("robots.txt") ? "text/plain" : "application/json" } }); };
  const net = makeNet({ fetchImpl: f, sleep: async () => {} });
  await net.get({ id: "a", adapter: "shopify", domains: ["shop.example"], geoEu: true }, "https://shop.example/products.json", { types: ["application/json"] });
  const h = seen.at(-1); assert.match(h["Accept-Language"], /^en/); assert.match(h.Cookie, /localization=DE/);
  await net.get({ id: "b", adapter: "shopify", domains: ["eur.example"] }, "https://eur.example/products.json", { types: ["application/json"] });
  assert.equal(seen.at(-1).Cookie, undefined, "магазинам в евро страну не меняем");
});

test("админка: список «В наличии» — фильтр товаров по месту (Украина / Европа)", async () => {
  const { saveManualProduct } = await import("../lib/manual.js");
  const store = new MemoryStore();
  const imgs = ["https://cdn.sanity.io/a.jpg"];
  const a = await saveManualProduct(store, { brand: "Louis Vuitton", title: "Speedy 25", category: "bags", boutique: 1500, images: imgs, stock: { loc: "ua", city: "Киев" } });
  await saveManualProduct(store, { brand: "Dior", title: "Saddle", category: "bags", boutique: 3000, images: imgs, stock: { loc: "eu" } });
  await saveManualProduct(store, { brand: "Gucci", title: "Jackie", category: "bags", boutique: 2800, images: imgs });
  assert.equal(a.stock.loc, "ua");
  const all = await store.list("product", {}, {});
  const pick = loc => all.filter(p => (l => loc === "any" ? !!l : l === loc)((p.overrides?.stock || p.stock)?.loc || "")).map(p => p.brand);
  assert.deepEqual(pick("ua"), ["Louis Vuitton"]); assert.deepEqual(pick("eu"), ["Dior"]); assert.equal(pick("any").length, 2);
});
