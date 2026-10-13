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

export async function loadCatalogPage(store, sourceId, { handle = "__all__", page = 1, limit = 50, fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  // база ещё готовится — этот вызов целиком уходит на подготовку, админка сразу попросит ту же страницу снова
  const mig = (await dbReady(store)) ? { ready: true } : await migrateDb(store);
  if (!mig.ready) return { found: 0, saved: 0, published: 0, filtered: 0, skipped: 0, errors: [], more: true, migrating: mig };
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
    // фильтр поставщика не пускает новые товары; уже загруженные обновляем (например, если поменялась категория)
    if (item.kind !== "update" && ((onlyCats && !onlyCats.includes(item.model.category)) || (onlyBrands && !onlyBrands.includes(String(item.model.brand || "").toLowerCase())))) { out.filtered++; continue; }
    if (item.kind === "error" || item.kind === "excluded") { out.skipped++; continue; }
    built.push(item);
  }
  if (!built.length) return out;

  // запись как до 13:45, когда сохранились первые 118: каждый товар читается и записывается отдельно, по очереди
  const auto = !!settings?.autoPublish, ready = i => i.pricing.ua > 0 && !i.pricing.blocked && !i.pricing.needsReview && i.model.images.length;
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
