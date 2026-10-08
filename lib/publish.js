/**
 * Публикация строк предпросмотра в товары витрины, снятие с публикации, ручные правки.
 * Данные источника и наши переопределения хранятся раздельно: синхронизация не трогает overrides.
 */
import { mergeOffer, chooseOffer } from "./match.js";
import { materializeImages } from "./images.js";
import { priceFor } from "./pipeline.js";
import { sourceWith } from "./sources.js";

const EDITABLE = ["title", "cover", "imageOrder", "hidden", "pinnedPrice", "category", "rejectMerge", "stock", "isNew", "gender", "newUntil", "sale", "dims", "material"];

export async function publishItems(store, itemIds, { status = "published", by = "admin", resolution = {}, fetchImpl = fetch, now = new Date().toISOString(), pricingCfg = null, items = null, catalog = false, src: srcIn = null } = {}) {
  const results = [];
  for (const id of itemIds) {
    // items — строки, ещё не записанные в базу (каталог поставщика: сразу в товары, без предпросмотра)
    const item = items?.[id] || await store.get(id);
    if (!item) { results.push({ id, ok: false, reason: "Строка предпросмотра не найдена" }); continue; }
    const r = resolution[id];
    if (item.kind === "error") { results.push({ id, ok: false, reason: "Ошибка данных — публикация невозможна" }); continue; }
    if (item.kind === "excluded") { results.push({ id, ok: false, reason: "Исключено правилами доставки" }); continue; }
    if (item.kind === "duplicate" && !r && !catalog) { results.push({ id, ok: false, reason: "Возможный дубль — выберите «создать отдельно» или «объединить»" }); continue; }
    if (status === "published" && item.pricing.blocked) { results.push({ id, ok: false, reason: item.pricing.reasons.join("; ") }); continue; }
    if (status === "published" && (item.pricing.needsReview || item.pricing.ua === null)) { results.push({ id, ok: false, reason: "Цена требует проверки — сохраните в черновики" }); continue; }
    if (status === "published" && !item.model.images.length) { results.push({ id, ok: false, reason: "Нет фото" }); continue; }

    // каталог: id товара постоянный (ссылка поставщика), чтобы ежедневное обновление не плодило копии
    const targetId = r === "merge" || item.kind === "update" ? item.match.matchId : item.model._id + (r === "new" && !catalog ? "." + id.slice(-6) : "");
    const prev = await store.get(targetId);
    const src = srcIn || sourceWith(await store.get("source." + item.sourceId), item.sourceId);

    // фото: копия в наше хранилище при разрешении, иначе ссылка источника
    const urlMap = new Map();
    const allUrls = [...new Set([...item.model.images.map(i => i.url), ...item.variants.flatMap(v => v.images.map(i => i.url))])];
    const prevByUrl = new Map((prev?.images || []).map(i => [i.sourceUrl || i.url, i]));
    const toFetch = allUrls.filter(u => !prevByUrl.has(u) || (src.imageRights === "copy-allowed" && prevByUrl.get(u).rights !== "copied"));
    const mat = await materializeImages(toFetch, src, store, { fetchImpl });
    mat.images.forEach(i => urlMap.set(i.sourceUrl, i));
    allUrls.forEach(u => { if (!urlMap.has(u) && prevByUrl.has(u)) urlMap.set(u, prevByUrl.get(u)); });
    const img = u => urlMap.get(u) || { url: u, sourceUrl: u, rights: "source-link" };

    const variants = mergeVariants(prev?.variants, item.variants.map(v => ({ ...v, images: v.images.map(i => img(i.url)) })));
    const offers = mergeOffers(prev?.offers, item.offer);
    const product = {
      ...(prev || { _id: targetId, _type: "product", createdAt: now, overrides: {}, history: [] }),
      brand: item.model.brand, sourceTitle: item.model.sourceTitle, title: item.model.title,
      category: item.model.category, subcategory: item.model.subcategory, gender: item.model.gender,
      modelSku: item.model.modelSku, gtin: item.model.gtin, colors: item.model.colors, materials: item.model.materials,
      sizes: item.model.sizes, sizeSystem: item.model.sizeSystem, sourceUrl: item.model.sourceUrl, description: item.model.description,
      images: item.model.images.map(i => img(i.url)), variants, offers,
      issues: item.issues, updatedAt: now
    };
    product.pricing = computePricing(product, pricingCfg);
    const was = prev?.status;
    product.status = status === "published" ? "published" : (was === "published" ? "published" : "draft");
    if (status === "published" && was !== "published") product.publishedAt = now;
    product.history = [...(product.history || []).slice(-49), { at: now, by, action: status === "published" ? "publish" : "draft", from: was || null, jobId: item.jobId }];
    await store.put(product);
    if (!items?.[id]) await store.put({ ...item, publishedAs: product._id, publishedAt: now, selected: false });
    results.push({ id, ok: true, productId: product._id, status: product.status, photoErrors: mat.errors });
  }
  return results;
}

function mergeVariants(prev = [], next = []) {
  const map = new Map(prev.map(v => [v._key, v]));
  next.forEach(v => map.set(v._key, { ...(map.get(v._key) || {}), ...v }));
  return [...map.values()];
}
function mergeOffers(prev = [], offer) {
  const i = prev.findIndex(o => o._key === offer._key);
  if (i < 0) return [...prev, offer];
  const out = prev.slice(); out[i] = mergeOffer(prev[i], offer); return out;
}

/** Цены витрины по основному предложению (с учётом закреплённой цены). */
export function computePricing(product, pricingCfg) {
  const pinned = product.overrides?.pinnedPrice || null;
  const priced = (product.offers || []).map(o => ({ o, p: priceFor(o, pricingCfg, pinned) }));
  const choice = chooseOffer(priced.map(({ o, p }) => ({ _key: o._key, sourceKind: o.sourceKind, final: p.ua, supplierLeadDays: o.supplierLeadDays, variantMatch: true, blocked: p.blocked })), { strategy: product.overrides?.offerStrategy || "manual" });
  const pickKey = product.overrides?.primaryOffer || choice.primary;
  const main = priced.find(x => x.o._key === pickKey);
  return main ? { offerKey: main.o._key, ua: main.p.ua, eu: main.p.eu, dxb: main.p.dxb, rule: main.p.rule, boutique: main.p.boutique, purchase: main.p.purchase, spread: main.p.spread, region: main.o.region, currency: main.o.currency, explain: choice.explain, conflict: choice.conflict, blocked: main.p.blocked }
    : { offerKey: null, ua: null, eu: null, dxb: null, explain: choice.explain, conflict: choice.conflict };
}

export async function setStatus(store, productIds, status, by = "admin") {
  const out = [];
  for (const id of productIds) {
    const p = await store.get(id); if (!p) continue;
    const from = p.status; p.status = status;
    p.history = [...(p.history || []).slice(-49), { at: new Date().toISOString(), by, action: "status", from, to: status }];
    await store.put(p); out.push({ id, status });
  }
  return out;
}

/** Ручные правки: сохраняются в overrides, в истории — автор, поле, было/стало. */
export async function saveOverrides(store, id, changes, by = "admin", pricingCfg = null) {
  const p = await store.get(id); if (!p) throw new Error("Товар не найден");
  p.overrides = p.overrides || {};
  const now = new Date().toISOString();
  for (let [k, v] of Object.entries(changes)) {
    if (!EDITABLE.includes(k) && k !== "primaryOffer" && k !== "offerStrategy") throw new Error("Поле нельзя менять: " + k);
    v = cleanOverride(k, v);
    const from = p.overrides[k] ?? null;
    if (JSON.stringify(from) === JSON.stringify(v)) continue;
    if (v === null || v === "") delete p.overrides[k]; else p.overrides[k] = v;
    p.history = [...(p.history || []).slice(-49), { at: now, by, action: "edit", field: k, from, to: v }];
  }
  p.pricing = computePricing(p, pricingCfg);
  return store.put(p);
}

/** Скидка: процент 1–90 и (необязательно) дата окончания; новинка — до какой даты; размер изделия и материал — короткий текст. */
export function cleanOverride(k, v) {
  if (v === null || v === undefined || v === "") return null;
  const day = x => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(x || "")) ? String(x) : null;
  if (k === "sale") {
    const pct = Math.round(Number(v && v.pct));
    if (!(pct >= 1 && pct <= 90)) return null;
    return { pct, until: day(v.until) };
  }
  if (k === "newUntil") return day(v);
  if (k === "dims" || k === "material") return String(v).replace(/\s+/g, " ").trim().slice(0, 48) || null;
  return v;
}
