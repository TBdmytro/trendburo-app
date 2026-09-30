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
  assert.equal(items[0].pricing.eu, 2320); // 2150 × 1,08 = 2322 → 2320
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
  assert.equal(p.status, "published"); assert.equal(p.pricing.ua, 2420); assert.equal(p.pricing.eu, 2375);
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
  assert.equal(p1.offers[0].boutique, 200, "234 $ / 1.17 = 200 €"); assert.equal(p1.pricing.ua, 220, "Украина ×1,10");
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
  assert.equal(toStorefront(await store.get(p1._id)).price.ua, 220);
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
