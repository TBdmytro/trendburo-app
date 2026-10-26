/**
 * Товар, добавленный вручную: бренд, название, фото (свои), цена бутика.
 * Цена витрины считается теми же правилами, что и для сайтов брендов (Украина ×1,10, Европа/Дубай ×1,08).
 */
import { createHash } from "node:crypto";
import { computePricing } from "./publish.js";
import { CATEGORIES, canonBrand, detectSubcategory, SUBCATS, SUBVER } from "./normalize.js";

const key = s => createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
// вещь с сайта бренда, которую сейчас нельзя купить онлайн (предзаказ, лист ожидания, «только в бутике», размер распродан),
// у нас не прячется: «уточнить наличие» — менеджер найдёт и выкупит в бутике. Предзаказ отмечаем отдельно
const askOf = d => d.ask ? String(d.ask) : d.preorder ? "pre" : d.unavailable ? "wait" : d.noSizes ? "wait" : "";
const preSt = (st, ask) => !ask || st === "out" ? st : ask === "pre" ? (st === "online" || st === "ask" ? "preorder" : st) : (st === "online" ? "ask" : st);
const ASKS = ["preorder", "ask"];
const clean = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function validateManual(d) {
  const errors = [];
  if (!clean(d.brand)) errors.push("Укажите бренд");
  if (!clean(d.title)) errors.push("Укажите название");
  if (!CATEGORIES[d.category]) errors.push("Выберите категорию");
  const price = Number(d.boutique);
  if (!(price > 0 && price < 1e6)) errors.push("Укажите цену в бутике");
  const imgs = (d.images || []).filter(u => /^https:\/\//.test(u));
  if (!imgs.length) errors.push("Добавьте хотя бы одно фото");
  return errors;
}

/**
 * @param d {brand,title,category,gender,boutique,sizes[],color,colors[{name,image}],availability,images[],status,description,id?}
 */
export async function saveManualProduct(store, d, { by = "admin", pricingCfg = null, now = new Date().toISOString() } = {}) {
  const errors = validateManual(d);
  if (errors.length) throw new Error(errors.join(". "));
  const id = d.id && String(d.id).startsWith("product.manual.") ? d.id : "product.manual." + key(clean(d.brand) + "|" + clean(d.title) + "|" + now);
  const prev = await store.get(id);
  const images = d.images.filter(u => /^https:\/\//.test(u)).slice(0, 12).map(u => ({ url: u, sourceUrl: u, rights: "copied" }));
  const status = ["online", "boutique", "preorder", "out"].includes(d.availability) ? d.availability : "online";
  // наличие по размерам с сайта бренда (кнопка): ok:false — продано, иначе — в наличии
  const stock = new Map((Array.isArray(d.sizeStock) ? d.sizeStock : []).map(x => [clean(x && x.s, 20), x && x.pre ? "preorder" : x && x.ok === false ? "ask" : "online"]).filter(([k]) => k));
  const sizes = [...new Set([...(d.sizes || []).map(s => clean(s, 20)), ...stock.keys()].filter(Boolean))].slice(0, 40);
  if (d.fromWeb && !sizes.length && ["clothing", "shoes"].includes(d.category)) d = { ...d, noSizes: true }; // размеры не нашлись — «уточнить наличие»
  // цвета: [{name, image}] — у каждого цвета своё фото из загруженных; без списка — один цвет из поля «Цвет»
  const colorList = (Array.isArray(d.colors) ? d.colors : []).map(c => ({ name: clean(c && c.name, 60), image: c && images.find(i => i.url === c.image) })).filter(c => c.name).slice(0, 12);
  const color = colorList[0]?.name || clean(d.color, 60) || null;
  const cols = colorList.length > 1 ? colorList : [{ name: color, image: images[0] }];
  const variants = [];
  for (const c of cols) for (const sz of (sizes.length ? sizes : [null]))
    variants.push({ _key: key(id + "|" + (cols.length > 1 ? c.name + "|" : "") + (sz || "one")), sku: null, gtin: null, color: c.name || null, size: sz, material: null, images: c.image ? [c.image] : (sz ? [] : images.slice(0, 1)) });
  const offerKey = key(id + "|manual");
  const offer = {
    _key: offerKey, sourceId: "manual", sourceKind: "official", region: "DE", currency: "EUR",
    boutique: Math.round(Number(d.boutique) * 100) / 100, priceSource: "вручную", taxIncluded: true, purchase: null,
    availability: Object.fromEntries(variants.map(v => [v._key, { status: preSt(v.size && stock.has(v.size) && status === "online" ? stock.get(v.size) : status, askOf(d)), price: null }])),
    onlineOrder: false,
    staleHours: stock.size || askOf(d) ? 24 * 30 : undefined, // наличие с сайта бренда держим месяц (обновляется при следующем сборе)
    supplierLeadDays: null, checkedAt: now, errors: [], url: clean(d.url, 500) || null, completeness: 1,
    ...(Number(d.markupPct) > 0 && Number(d.markupPct) <= 100 ? { flatMarkup: Math.round(Number(d.markupPct)) / 100 } : {})
  };
  offer.onlineOrder = Object.values(offer.availability).some(a => a.status === "online");
  const product = {
    ...(prev || { _id: id, _type: "product", createdAt: now, overrides: {}, history: [] }),
    brand: canonBrand(clean(d.brand, 80)), title: clean(d.title, 120), sourceTitle: clean(d.title, 120),
    category: d.category, subcategory: (SUBCATS[d.category] || []).some(x => x[0] === d.subcategory) ? d.subcategory : detectSubcategory(d.category, d.title, d.sectionWords || String(d.section || "").toLowerCase().split(/[/_-]+/).reverse(), d.description), subVer: SUBVER, subFor: d.category, gender: ["w", "m", "u"].includes(d.gender) ? d.gender : "u",
    modelSku: clean(d.sku, 60) || null, gtin: null, colors: cols.length > 1 ? cols.map(c => c.name) : (color ? [color] : []), materials: [], sizes, sizeSystem: null,
    sourceUrl: clean(d.url, 500) || null, description: clean(d.description, 2000) || null,
    images, variants, offers: [offer], issues: [], manual: true, updatedAt: now,
    stock: d.stock && ["ua", "eu"].includes(d.stock.loc) ? { loc: d.stock.loc, city: clean(d.stock.city, 40) || (d.stock.loc === "ua" ? "Киев" : "Мюнхен"), size: clean(d.stock.size, 12) || undefined } : null
  };
  if (d.orig) product.orig = d.orig;
  if (d.tileImg) product.coverFrom = "tile"; // обложка уже как на плитке раздела бренда // немецкий оригинал и перевод (кнопка с немецкого сайта)
  product.hasPre = Object.values(offer.availability).some(a => ASKS.includes(a.status)); // в админке фильтр «Уточнить наличие»
  product.sizeDebug = sizes.length ? null : (clean(d.szDbg, 900) || null);
  if (d.section) product.webSections = [...new Set([...(product.webSections || []), clean(d.section, 200)])].slice(-12);
  // из раздела «Новинки» на сайте бренда — отмечаем новинкой на месяц (срок виден только в админке)
  if (d.isNew) product.overrides = { ...(product.overrides || {}), isNew: "on", newUntil: new Date(Date.parse(now) + 30 * 864e5).toISOString().slice(0, 10) };
  product.pricing = computePricing(product, pricingCfg);
  const was = prev?.status || null;
  product.status = d.status === "draft" ? "draft" : d.status === "incoming" ? "incoming" : "published"; // incoming — «Новые с сайтов», ещё не в «Товарах»
  if (product.status === "published" && was !== "published") product.publishedAt = now;
  product.history = [...(product.history || []).slice(-49), { at: now, by, action: prev ? "manual-edit" : "manual-create", from: was, to: product.status }];
  return store.put(product);
}

/**
 * Прогон раздела кнопкой: товар уже есть — обновляем цену бутика и наличие по размерам, статус на витрине и фото не трогаем.
 * Размер, которого больше нет на странице, — «продано»; новый размер — добавляется.
 */
export async function updateWebProduct(store, id, d, { by = "admin", pricingCfg = null, now = new Date().toISOString() } = {}) {
  const p = await store.get(id); if (!p) throw new Error("Товар не найден");
  const offer = (p.offers || [])[0]; if (!offer) throw new Error("У товара нет цены");
  offer.availability = offer.availability || {}; p.variants = p.variants || [];
  const changes = [], price = Math.round(Number(d.boutique) * 100) / 100;
  if (price > 0 && price !== offer.boutique) { changes.push({ field: "price", from: offer.boutique, to: price }); offer.boutique = price; }
  const stock = new Map((Array.isArray(d.sizeStock) ? d.sizeStock : []).map(x => [clean(x && x.s, 20), x && x.pre ? "preorder" : x && x.ok === false ? "ask" : "online"]).filter(([k]) => k));
  if (!stock.size && !(p.sizes || []).length && ["clothing", "shoes"].includes(p.overrides?.category || p.category)) d = { ...d, noSizes: true };
  if (stock.size) {
    const color = p.variants[0]?.color || null;
    for (const sz of stock.keys()) if (!p.variants.some(v => v.size === sz)) p.variants.push({ _key: key(id + "|" + sz), sku: null, gtin: null, color, size: sz, material: null, images: [] });
    p.sizes = [...new Set([...(p.sizes || []), ...stock.keys()])].slice(0, 40);
    // раньше размеров не было (вариант без размера) — теперь они нашлись: убираем пустой вариант
    for (const v of p.variants.filter(v => !v.size)) delete offer.availability[v._key];
    p.variants = p.variants.filter(v => v.size);
  }
  for (const v of p.variants) {
    const st = preSt(stock.size && v.size ? (stock.get(v.size) || "out") : "online", askOf(d));
    const was = offer.availability[v._key]?.status;
    if (was !== st) changes.push({ field: v.size ? "size " + v.size : "stock", from: was || null, to: st });
    offer.availability[v._key] = { status: st, price: null };
  }
  offer.onlineOrder = Object.values(offer.availability).some(a => a.status === "online");
  p.hasPre = Object.values(offer.availability).some(a => ASKS.includes(a.status));
  offer.checkedAt = now; offer.staleHours = 24 * 30;
  p.sizeDebug = (p.sizes || []).length ? null : (clean(d.szDbg, 900) || p.sizeDebug || null);
  if (d.section) p.webSections = [...new Set([...(p.webSections || []), clean(d.section, 200)])].slice(-12);
  if (!p.subcategory) p.subcategory = detectSubcategory(p.overrides?.category || p.category, p.title, String(d.section || "").toLowerCase().split(/[/_-]+/).reverse(), p.description) || null;
  if (d.isNew && p.overrides?.isNew !== "off" && p.overrides?.isNew !== "on") p.overrides = { ...(p.overrides || {}), isNew: "on", newUntil: new Date(Date.parse(now) + 30 * 864e5).toISOString().slice(0, 10) };
  p.pricing = computePricing(p, pricingCfg); p.updatedAt = now;
  if (changes.length) p.history = [...(p.history || []).slice(-49), { at: now, by, action: "web-update", changes: changes.slice(0, 12) }];
  await store.put(p);
  return { changes: changes.length, price: changes.some(c => c.field === "price") };
}

/** Товара больше нет в разделе на сайте бренда — все размеры «продано» (товар не удаляем, на витрине — «нет в наличии»). */
export async function markWebGone(store, ids, { by = "admin", pricingCfg = null, now = new Date().toISOString() } = {}) {
  let n = 0;
  for (const p of await store.getMany(ids)) {
    const offer = (p.offers || [])[0]; if (!offer) continue;
    offer.availability = Object.fromEntries((p.variants || []).map(v => [v._key, { status: "out", price: null }]));
    offer.onlineOrder = false; offer.checkedAt = now; offer.staleHours = 24 * 30;
    p.pricing = computePricing(p, pricingCfg); p.updatedAt = now;
    p.history = [...(p.history || []).slice(-49), { at: now, by, action: "web-gone" }];
    await store.put(p); n++;
  }
  return n;
}
