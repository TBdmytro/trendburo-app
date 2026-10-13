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

/** Копия документа без служебных полей базы, с корректным текстом и ключами — на случай, если база отказала. */
function clean(doc) {
  const fix = (v, top) => {
    if (typeof v === "string") return v.toWellFormed ? v.toWellFormed() : v;
    if (Array.isArray(v)) return v.filter(x => x !== null && x !== undefined).map(x => fix(x));
    if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) { if (x === undefined) continue; if (top && ["_rev", "_createdAt", "_updatedAt"].includes(k)) continue; if (k.startsWith("$")) continue; o[k] = fix(x); } return o; }
    return typeof v === "number" && !Number.isFinite(v) ? null : v;
  };
  return fix(doc, true);
}

export async function loadCatalogPage(store, sourceId, { handle = "__all__", page = 1, limit = 100, fetchImpl = fetch, now = new Date().toISOString() } = {}) {
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

  // одно чтение уже сохранённых, одна пачечная запись; при сбое пачки — по одному, чтобы ничего не терять
  const ids = [...new Set(built.map(i => i.kind === "update" ? i.match.matchId : i.model._id))];
  const prevs = new Map((await store.getMany(ids)).map(d => [d._id, d]));
  const collect = [];
  const auto = !!settings?.autoPublish, ready = i => i.pricing.ua > 0 && !i.pricing.blocked && !i.pricing.needsReview && i.model.images.length;
  const opts = { by: auto ? "автовыгрузка" : "каталог поставщика", fetchImpl, pricingCfg, items: Object.fromEntries(built.map(i => [i._id, i])), catalog: true, src, prevs, collect, now };
  const pubIds = auto ? built.filter(ready).map(i => i._id) : [], draftIds = built.map(i => i._id).filter(id => !pubIds.includes(id));
  const r = [...await publishItems(store, pubIds, { ...opts, status: "published" }), ...await publishItems(store, draftIds, { ...opts, status: "draft" })];
  const failed = new Set();
  // один и тот же товар мог встретиться на странице дважды (женская и мужская карточка) — пишем один раз, последнюю версию
  const uniq = [...new Map(collect.map(d => [d._id, d])).values()]; collect.length = 0; collect.push(...uniq);
  try { await store.putMany(collect.map(clean)); }
  catch { for (const d of collect) { try { await store.put(clean(d)); } catch (e) { try { await store.put(clean({ ...d, history: (d.history || []).slice(-20) })); } catch (e2) { failed.add(d._id); out.errors.push("Не сохранён " + (d.title || d._id) + ": " + e2.message); } } } }
  for (const x of r) {
    if (!x.ok) { if (x.reason) out.errors.push(x.reason); continue; }
    if (failed.has(x.productId)) continue;
    out.saved++; if (x.status === "published") out.published++;
  }
  // отметка для админки: когда и сколько загружено
  if (settings) { await store.patchMany([settings._id], { lastCatalogAt: now }).catch(() => {}); }
  out.errors = out.errors.slice(0, 5);
  return out;
}
