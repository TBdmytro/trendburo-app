/**
 * Простая загрузка каталога поставщика порциями — без фоновых задач, блокировок и очередей.
 * Админка просит «страницу N раздела R», сервер за один запрос: читает страницу у магазина,
 * собирает товары и сразу записывает их в «Товары». Остановка = админка просто не просит следующую.
 * Каждая порция независима: повтор безопасен (товар с тем же адресом перезаписывается, дублей нет).
 */
import { sourceWith, ADAPTERS, makeNet, assertEuPrices } from "./sources.js";
import { buildItem } from "./pipeline.js";
import { publishItems } from "./publish.js";
import { getFx, refreshFx } from "./fx.js";
import { upgradeEuSource } from "./suppliers.js";

/** Сколько разных названий полей занимает каждый тип документов (лимит Sanity — 2000 на всю базу). */
export async function dbStats(store) {
  if (!store.exportAll) return null;
  const docs = await store.exportAll();
  const all = new Set(), by = {};
  const walk = (o, p, set) => { if (Array.isArray(o)) o.forEach(x => walk(x, p + "[]", set)); else if (o && typeof o === "object") for (const k in o) walk(o[k], p + "." + k, set); else set.add(p + ":" + (o === null ? "null" : typeof o)); };
  for (const d of docs) { if (String(d._type || "").startsWith("sanity.") || String(d._id).startsWith("_.")) continue; const t = d._type || "?"; const set = by[t] ||= new Set(); walk(d, "", set); }
  for (const [t, set] of Object.entries(by)) set.forEach(x => all.add(t + x));
  return { total: all.size, docs: docs.length, byType: Object.entries(by).map(([t, set]) => ({ type: t, fields: set.size, docs: docs.filter(d => d._type === t).length })).sort((x, y) => y.fields - x.fields) };
}

/**
 * Разовый перевод базы на новый формат словарей (см. toDb в store.js) — по частям, не дольше budgetMs за вызов
 * (у сервера 60 секунд на запрос). Прогресс хранится в settings.dbv, следующий вызов продолжает с того же места.
 * База упёрлась в лимит 2000 названий полей, поэтому сначала только освобождаем место:
 *  1) удаляем служебные записи старых загрузок (задачи и их промежуточные позиции);
 *  2) товары записываем без наличия по размерам (новых названий не добавляет, старые уходят);
 *  3) товары записываем целиком уже в новом формате. Ни один товар не удаляется.
 */
/** Можно ли уже записывать новые товары: старые словари из базы убраны (шаг «full» только восстанавливает наличие у старых товаров). */
export async function dbReady(store) {
  const st = await store.get("settings.dbv");
  return !!st && (st.v >= 3 || ["full", "done"].includes(st.step));
}

export async function migrateDb(store, { budgetMs = 35000 } = {}) {
  const t0 = Date.now(), left = () => Date.now() - t0 < budgetMs;
  const st = (await store.get("settings.dbv")) || { _id: "settings.dbv", _type: "settings", v: 0 };
  if (st.v >= 3) return { done: true, ready: true };
  st.step ||= "clean"; st.removed ||= 0; st.fixed ||= 0;
  const save = () => store.put({ _id: st._id, _type: "settings", v: st.v || 0, step: st.step, removed: st.removed, fixed: st.fixed, cursor: st.cursor || "", at: new Date().toISOString() });
  const plain = d => { const { _rev, _createdAt, _updatedAt, ...x } = d; return x; };
  if (st.step === "clean") {
    for (const t of ["importJob", "importItem"]) {
      while (left()) { const ids = (await store.list(t, {}, { fields: "_id", limit: 200 })).map(x => x._id); if (!ids.length) break; await store.delMany(ids); st.removed += ids.length; }
    }
    if (left()) { st.step = "strip"; st.cursor = ""; }
    await save(); if (!left()) return { done: false, ready: false, step: st.step, removed: st.removed, fixed: st.fixed };
  }
  const ids = (await store.list("product", {}, { fields: "_id", limit: 50000, order: "_id asc" })).map(p => p._id);
  for (const step of ["strip", "full"]) {
    if (st.step !== step) continue;
    let i = st.cursor ? ids.findIndex(x => x > st.cursor) : 0; if (i < 0) i = ids.length;
    while (i < ids.length && left()) {
      const docs = await store.getMany(ids.slice(i, i + 25));
      // strip: наличие убираем из полей, но сохраняем строкой в _av (одно постоянное поле) — full вернёт его на место
      await store.putMany(docs.map(d => step === "strip" ? { ...plain(d), offers: (d.offers || []).map(({ availability, _av, ...o }) => availability !== undefined ? { ...o, _av: JSON.stringify(availability) } : (_av ? { ...o, _av } : o)) } : plain(d)));
      if (step === "full") st.fixed += docs.length;
      st.cursor = ids[Math.min(i + 25, ids.length) - 1]; i += 25;
    }
    if (i >= ids.length) { st.step = step === "strip" ? "full" : "done"; st.cursor = ""; if (st.step === "done") st.v = 3; }
    await save();
    if (!left() && st.step !== "done") return { done: false, ready: st.step === "full", step: st.step, removed: st.removed, fixed: st.fixed };
  }
  return { done: st.v >= 3, ready: st.v >= 3 || st.step === "full", step: st.step, removed: st.removed, fixed: st.fixed };
}

/**
 * Место в базе: у бесплатной базы есть предел числа записей. Служебные записи загрузок (строки предпросмотра уже опубликованных
 * товаров, старые задачи) удаляем — товары, баннеры и заказы не трогаем. В журнал — сколько чего лежит в базе.
 */
/** Удалённые в админке товары: запоминаем, чтобы ночная и ручная загрузка каталога не возвращала их снова (скрытыми). */
export async function rememberDeleted(store, ids) {
  if (!ids?.length) return;
  const d = (await store.get("settings.deleted")) || { _id: "settings.deleted", _type: "settings", ids: [] };
  const set = new Set(d.ids || []); ids.forEach(i => set.add(i));
  await store.put({ _id: d._id, _type: "settings", ids: [...set].slice(-30000), at: new Date().toISOString() });
}
export async function deletedSet(store) { return new Set(((await store.get("settings.deleted")) || {}).ids || []); }

export async function freeSpace(store, { budgetMs = 15000 } = {}) {
  const t0 = Date.now(), left = () => Date.now() - t0 < budgetMs; let removed = 0;
  const week = new Date(Date.now() - 7 * 864e5).toISOString(), day = new Date(Date.now() - 864e5).toISOString();
  try {
    if (store.q) console.log("DBCOUNT " + JSON.stringify(await store.q(`{"all":count(*),"product":count(*[_type=="product" && _id in path("product.**")]),"foreignProduct":count(*[_type=="product" && !(_id in path("product.**"))]),"importItem":count(*[_type=="importItem"]),"importJob":count(*[_type=="importJob"]),"asset":count(*[_type=="sanity.imageAsset"]),"drafts":count(*[_id in path("drafts.**")]),"lead":count(*[_type=="lead"])}`)));
    // строки предпросмотра: уже опубликованные, отменённые — и всё старше недели (кроме ожидающих проверки свежих)
    const items = store.q
      ? await store.q(`*[_type=="importItem" && (defined(publishedAs) || createdAt < $week || kind in ["error","excluded"])][0...4000]._id`, { week })
      : (await store.list("importItem", {}, { fields: "_id, publishedAs, createdAt, kind" })).filter(i => i.publishedAs || i.createdAt < week || ["error", "excluded"].includes(i.kind)).map(i => i._id);
    for (let i = 0; i < items.length && left(); i += 200) { await store.delMany(items.slice(i, i + 200)); removed += Math.min(200, items.length - i); }
    const jobs = (await store.list("importJob", {}, { fields: "_id, status, finishedAt, createdAt" })).filter(j => ["done", "cancelled", "failed"].includes(j.status) && (j.finishedAt || j.createdAt || "") < day).map(j => j._id);
    if (jobs.length && left()) { await store.delMany(jobs.slice(0, 200)); removed += Math.min(200, jobs.length); }
  } catch (e) { console.log("DBCLEAN error " + String(e && e.message || e).slice(0, 200)); }
  console.log("DBCLEAN " + JSON.stringify({ removed, ms: Date.now() - t0 }));
  return removed;
}

export async function loadCatalogPage(store, sourceId, { handle = "__all__", page = 1, limit = 50, fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  // база ещё готовится — этот вызов целиком уходит на подготовку, админка сразу попросит ту же страницу снова
  const mig = (await dbReady(store)) ? { ready: true } : await migrateDb(store);
  if (!mig.ready) return { found: 0, saved: 0, published: 0, filtered: 0, skipped: 0, errors: [], more: true, migrating: mig };
  // первая страница: сначала освобождаем место в базе от служебных записей прошлых загрузок
  if ((Number(page) || 1) === 1) await freeSpace(store);
  let settings = await store.get("source." + sourceId);
  // магазин в долларах: на первой странице проверяем, отдаёт ли он цены Германии (тогда — европейский прайс без курса)
  if ((Number(page) || 1) === 1) settings = await upgradeEuSource(store, sourceId, settings, { fetchImpl });
  const src = sourceWith(settings, sourceId);
  if (src.adapter !== "shopify" || !src.catalog) throw new Error("Порционная загрузка — только для поставщиков, подключённых по ссылке");
  if (src.shopCurrency && src.shopCurrency !== "EUR") { await refreshFx(store, { fetchImpl }).catch(() => {}); src.fx = await getFx(store); }
  const net = makeNet({ fetchImpl });
  // Европа по стране посетителя: на первой странице раздела убеждаемся, что магазин отдаёт евро
  if (src.geoEu && (Number(page) || 1) === 1) await assertEuPrices(src, net);
  const nonEu = !!(src.shopCurrency && src.shopCurrency !== "EUR");
  const { raws, more } = await ADAPTERS.shopify.collectionPage(src, String(handle || "__all__"), Math.max(1, Number(page) || 1), net, Math.min(250, Math.max(20, Number(limit) || 100)));

  const pricingCfg = (await store.get("settings.pricing"))?.config || null;
  const onlyCats = src.cats?.length ? src.cats : null;
  const onlyBrands = src.brands?.length ? src.brands.map(b => String(b).toLowerCase()) : null;
  const cache = new Map();
  const existingFor = async brand => { const k = brand || "_"; if (!cache.has(k)) cache.set(k, await store.list("product", brand ? { brand } : {}, { fields: "_id, brand, modelSku, gtin, title, sourceTitle, overrides, pricing, variants[]{sku, gtin}" })); return cache.get(k); };

  const out = { found: raws.length, saved: 0, published: 0, filtered: 0, skipped: 0, errors: [], more: !!more };
  const gone = await deletedSet(store);  // удалённые админом — не возвращаем
  const built = [];
  for (const raw of raws) {
    const item = buildItem(raw, src, { existing: await existingFor(src.brand || raw.brand), pricingCfg, now, jobId: "catalog", urlHints: handle === "__all__" ? "" : handle });
    // фильтр поставщика не пускает новые товары; уже загруженные обновляем (например, если поменялась категория)
    if (item.kind !== "update" && ((onlyCats && !onlyCats.includes(item.model.category)) || (onlyBrands && !onlyBrands.includes(String(item.model.brand || "").toLowerCase())))) { out.filtered++; continue; }
    if (item.kind === "error" || item.kind === "excluded") { out.skipped++; continue; }
    if (item.kind !== "update" && gone.has(item.model._id)) { out.skipped++; out.deleted = (out.deleted || 0) + 1; continue; }
    built.push(item);
  }
  if (!built.length) return out;
  // поставщик только что перешёл на прайс Германии: цены уже опубликованных товаров не меняем сами — обновления ждут проверки
  if (settings?.custom?.euReview && settings?.autoUpdate === false) {
    const live = new Set();
    for (const it of built) if (it.kind === "update" && it.match?.matchId) { const pr = await store.get(it.match.matchId).catch(() => null); if (pr && pr.status === "published") live.add(it._id); }
    if (live.size) { for (const it of built.filter(i => live.has(i._id))) await store.put(it); out.held = (out.held || 0) + live.size; built.splice(0, built.length, ...built.filter(i => !live.has(i._id))); }
    if (!built.length) return out;
  }

  // запись как до 13:45, когда сохранились первые 118: каждый товар читается и записывается отдельно, по очереди
  const auto = !!settings?.autoPublish && !nonEu, ready = i => i.pricing.ua > 0 && !i.pricing.blocked && !i.pricing.needsReview && i.model.images.length;
  const opts = { by: auto ? "автовыгрузка" : "каталог поставщика", fetchImpl, pricingCfg, items: Object.fromEntries(built.map(i => [i._id, i])), catalog: true, src, now };
  const pubIds = auto ? built.filter(ready).map(i => i._id) : [], draftIds = built.map(i => i._id).filter(id => !pubIds.includes(id));
  // по 6 товаров одновременно, каждый — отдельной записью; чтобы уложиться в 60 секунд сервера
  const r = [], jobs = [...pubIds.map(id => [id, "published"]), ...draftIds.map(id => [id, "draft"])];
  const one = async ([id, status]) => {
    try { r.push(...await publishItems(store, [id], { ...opts, status })); }
    catch (e) { r.push({ id, ok: false, reason: "Не сохранён " + (built.find(i => i._id === id)?.model.title || "") + ": " + e.message }); }
  };
  for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map(one));
  for (const x of r) {
    if (!x.ok) { if (x.reason) out.errors.push(x.reason); continue; }
    out.saved++; if (x.status === "published") out.published++;
  }
  // отметка для админки: когда и сколько загружено
  if (settings) { await store.patchMany([settings._id], { lastCatalogAt: now }).catch(() => {}); }
  out.errors = out.errors.slice(0, 5);
  return out;
}

/** Разовое выравнивание названий брендов у уже загруженных товаров (см. canonBrand): «Sporty-&-Rich» → «Sporty & Rich». */
export async function fixBrands(store, { limit = 5000 } = {}) {
  const { canonBrand } = await import("./normalize.js");
  const { singleBrand } = await import("./suppliers.js");
  const all = await store.list("product", {}, { limit: 60000, fields: "_id, brand, offers[0...1]{sourceId}" });
  // сайт одного бренда (Sporty & Rich, Alo): у поставщика один бренд — у всех его товаров он же
  const want = new Map();
  for (const s of await store.list("sourceSettings", {}, { limit: 500, fields: "_id, sourceId, custom" }).catch(() => [])) {
    if (!s.custom) continue;
    const mine = all.filter(p => (p.offers || [])[0]?.sourceId === s.sourceId);
    let b = s.custom.brand || null;
    if (!b && mine.length >= 20) { b = singleBrand(mine.map(p => p.brand)); if (b) { const doc = await store.get(s._id); if (doc?.custom && !doc.custom.brand) { doc.custom.brand = b; await store.put(doc); } } }
    if (b) for (const p of mine) want.set(p._id, b);
  }
  const target = p => want.get(p._id) || canonBrand(p.brand);
  const items = all.filter(p => p.brand && target(p) !== p.brand).slice(0, limit).map(p => ({ id: p._id, set: { brand: target(p) } }));
  // товары с кнопки «В Trend Büro», ошибочно попавшие в одежду (раньше «coated canvas» считалось «coat»): сумка по описанию → «Сумки»
  const BAG = /\b(bags?|handbags?|totes?|clutch(es)?|crossbody|shoulder bag|hobo|cabas|pouch(es)?|backpacks?)\b/i, CLOTH = /\b(dress(es)?|coats?|jackets?|pants|trousers|jeans|knitwear|sweaters?|shirts?|t-shirts?|skirts?|shorts|blazers?|suits?|swimwear)\b/i;
  const web = await store.list("product", {}, { limit: 60000, fields: "_id, title, description, category, overrides" });
  for (const p of web) if (/^product\.manual\.[a-z0-9]+-/.test(p._id) && (p.overrides?.category || p.category) === "clothing" && !p.overrides?.category && BAG.test((p.title || "") + " " + (p.description || "")) && !CLOTH.test(p.title || "")) items.push({ id: p._id, set: { category: "bags" } });
  // подраздел (кроссовки, тоуты, леггинсы…) у товаров, где его ещё нет — по названию и описанию
  const { detectSubcategory } = await import("./normalize.js");
  const subs = await store.list("product", {}, { limit: 60000, fields: "_id, title, sourceTitle, description, category, subcategory, overrides" });
  for (const p of subs) if (!p.subcategory) { const c = p.overrides?.category || p.category; const sub = detectSubcategory(c, p.sourceTitle || p.title, p.description); if (sub) { const ex = items.find(x => x.id === p._id); if (ex) ex.set.subcategory = sub; else items.push({ id: p._id, set: { subcategory: sub } }); } }
  if (items.length && store.patchEach) await store.patchEach(items);
  if (items.length) console.log("BRANDFIX " + JSON.stringify({ fixed: items.length, sample: [...new Set(all.filter(p => p.brand && target(p) !== p.brand).map(p => p.brand + " → " + target(p)))].slice(0, 10) }));
  return items.length;
}
