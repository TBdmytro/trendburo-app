/**
 * Простая загрузка каталога поставщика порциями — без фоновых задач, блокировок и очередей.
 * Админка просит «страницу N раздела R», сервер за один запрос: читает страницу у магазина,
 * собирает товары и сразу записывает их в «Товары». Остановка = админка просто не просит следующую.
 * Каждая порция независима: повтор безопасен (товар с тем же адресом перезаписывается, дублей нет).
 */
import { sourceWith, ADAPTERS, makeNet } from "./sources.js";
import { buildItem } from "./pipeline.js";
import { publishItems } from "./publish.js";
import { getFx, refreshFx } from "./fx.js";

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
 * Разовый перевод базы на новый формат словарей (см. toDb в store.js).
 * База упёрлась в лимит 2000 названий полей, поэтому порядок важен — сначала только освобождаем место:
 *  1) удаляем служебные записи старых загрузок (задачи и их промежуточные позиции — в них тоже словари с кодами размеров);
 *  2) каждый товар записываем без наличия по размерам (новых названий не добавляет, старые уходят);
 *  3) записываем товары целиком уже в новом формате. Ни один товар не удаляется.
 */
export async function migrateDb(store) {
  if ((await store.get("settings.dbv"))?.v >= 3) return { done: false };
  let removed = 0;
  for (const t of ["importJob", "importItem"]) {
    for (;;) { const ids = (await store.list(t, {}, { fields: "_id", limit: 1000 })).map(x => x._id); if (!ids.length) break; await store.delMany(ids); removed += ids.length; }
  }
  const ids = (await store.list("product", {}, { fields: "_id", limit: 50000 })).map(p => p._id);
  const docs = [];
  for (let i = 0; i < ids.length; i += 50) docs.push(...await store.getMany(ids.slice(i, i + 50)));
  const plain = d => { const { _rev, _createdAt, _updatedAt, ...x } = d; return x; };
  const par = async (list, fn) => { for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map(fn)); };
  await par(docs, d => store.put({ ...plain(d), offers: (d.offers || []).map(({ availability, ...o }) => o) }));
  await par(docs, d => store.put(plain(d)));
  await store.put({ _id: "settings.dbv", _type: "settings", v: 3, at: new Date().toISOString(), removed, productsFixed: docs.length });
  return { done: true, removed, fixed: docs.length };
}

export async function loadCatalogPage(store, sourceId, { handle = "__all__", page = 1, limit = 50, fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  await migrateDb(store);
  const settings = await store.get("source." + sourceId);
  const src = sourceWith(settings, sourceId);
  if (src.adapter !== "shopify" || !src.catalog) throw new Error("Порционная загрузка — только для поставщиков, подключённых по ссылке");
  if (src.shopCurrency && src.shopCurrency !== "EUR") { await refreshFx(store, { fetchImpl }).catch(() => {}); src.fx = await getFx(store); }
  const net = makeNet({ fetchImpl });
  const { raws, more } = await ADAPTERS.shopify.collectionPage(src, String(handle || "__all__"), Math.max(1, Number(page) || 1), net, Math.min(250, Math.max(20, Number(limit) || 100)));

  const pricingCfg = (await store.get("settings.pricing"))?.config || null;
  const onlyCats = src.cats?.length ? src.cats : null;
  const onlyBrands = src.brands?.length ? src.brands.map(b => String(b).toLowerCase()) : null;
  const cache = new Map();
  const existingFor = async brand => { const k = brand || "_"; if (!cache.has(k)) cache.set(k, await store.list("product", brand ? { brand } : {}, { fields: "_id, brand, modelSku, gtin, title, sourceTitle, overrides, pricing, variants[]{sku, gtin}" })); return cache.get(k); };

  const out = { found: raws.length, saved: 0, published: 0, filtered: 0, skipped: 0, errors: [], more: !!more };
  const built = [];
  for (const raw of raws) {
    const item = buildItem(raw, src, { existing: await existingFor(src.brand || raw.brand), pricingCfg, now, jobId: "catalog", urlHints: handle === "__all__" ? "" : handle });
    if ((onlyCats && !onlyCats.includes(item.model.category)) || (onlyBrands && !onlyBrands.includes(String(item.model.brand || "").toLowerCase()))) { out.filtered++; continue; }
    if (item.kind === "error" || item.kind === "excluded") { out.skipped++; continue; }
    built.push(item);
  }
  if (!built.length) return out;

  // запись как до 13:45, когда сохранились первые 118: каждый товар читается и записывается отдельно, по очереди
  const auto = !!settings?.autoPublish, ready = i => i.pricing.ua > 0 && !i.pricing.blocked && !i.pricing.needsReview && i.model.images.length;
  const opts = { by: auto ? "автовыгрузка" : "каталог поставщика", fetchImpl, pricingCfg, items: Object.fromEntries(built.map(i => [i._id, i])), catalog: true, src, now };
  const pubIds = auto ? built.filter(ready).map(i => i._id) : [], draftIds = built.map(i => i._id).filter(id => !pubIds.includes(id));
  const r = [];
  for (const [ids, status] of [[pubIds, "published"], [draftIds, "draft"]]) for (const id of ids) {
    try { r.push(...await publishItems(store, [id], { ...opts, status })); }
    catch (e) { r.push({ id, ok: false, reason: "Не сохранён " + (built.find(i => i._id === id)?.model.title || "") + ": " + e.message }); }
  }
  for (const x of r) {
    if (!x.ok) { if (x.reason) out.errors.push(x.reason); continue; }
    out.saved++; if (x.status === "published") out.published++;
  }
  // отметка для админки: когда и сколько загружено
  if (settings) { await store.patchMany([settings._id], { lastCatalogAt: now }).catch(() => {}); }
  out.errors = out.errors.slice(0, 5);
  return out;
}
