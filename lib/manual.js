/**
 * Товар, добавленный вручную: бренд, название, фото (свои), цена бутика.
 * Цена витрины считается теми же правилами, что и для сайтов брендов (Украина ×1,10, Европа/Дубай ×1,08).
 */
import { createHash } from "node:crypto";
import { computePricing } from "./publish.js";
import { CATEGORIES } from "./normalize.js";

const key = s => createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
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
 * @param d {brand,title,category,gender,boutique,sizes[],color,availability,images[],status,description,id?}
 */
export async function saveManualProduct(store, d, { by = "admin", pricingCfg = null, now = new Date().toISOString() } = {}) {
  const errors = validateManual(d);
  if (errors.length) throw new Error(errors.join(". "));
  const id = d.id && String(d.id).startsWith("product.manual.") ? d.id : "product.manual." + key(clean(d.brand) + "|" + clean(d.title) + "|" + now);
  const prev = await store.get(id);
  const images = d.images.filter(u => /^https:\/\//.test(u)).slice(0, 12).map(u => ({ url: u, sourceUrl: u, rights: "copied" }));
  const status = ["online", "boutique", "preorder", "out"].includes(d.availability) ? d.availability : "online";
  const sizes = [...new Set((d.sizes || []).map(s => clean(s, 20)).filter(Boolean))].slice(0, 40);
  const color = clean(d.color, 60) || null;
  const variants = (sizes.length ? sizes : [null]).map(sz => ({ _key: key(id + "|" + (sz || "one")), sku: null, gtin: null, color, size: sz, material: null, images: sz ? [] : images.slice(0, 1) }));
  const offerKey = key(id + "|manual");
  const offer = {
    _key: offerKey, sourceId: "manual", sourceKind: "official", region: "DE", currency: "EUR",
    boutique: Math.round(Number(d.boutique) * 100) / 100, priceSource: "вручную", taxIncluded: true, purchase: null,
    availability: Object.fromEntries(variants.map(v => [v._key, { status, price: null }])), onlineOrder: status === "online",
    supplierLeadDays: null, checkedAt: now, errors: [], url: clean(d.url, 500) || null, completeness: 1
  };
  const product = {
    ...(prev || { _id: id, _type: "product", createdAt: now, overrides: {}, history: [] }),
    brand: clean(d.brand, 80), title: clean(d.title, 120), sourceTitle: clean(d.title, 120),
    category: d.category, subcategory: null, gender: ["w", "m", "u"].includes(d.gender) ? d.gender : "u",
    modelSku: clean(d.sku, 60) || null, gtin: null, colors: color ? [color] : [], materials: [], sizes, sizeSystem: null,
    sourceUrl: clean(d.url, 500) || null, description: clean(d.description, 2000) || null,
    images, variants, offers: [offer], issues: [], manual: true, updatedAt: now
  };
  product.pricing = computePricing(product, pricingCfg);
  const was = prev?.status || null;
  product.status = d.status === "draft" ? "draft" : "published";
  if (product.status === "published" && was !== "published") product.publishedAt = now;
  product.history = [...(product.history || []).slice(-49), { at: now, by, action: prev ? "manual-edit" : "manual-create", from: was, to: product.status }];
  return store.put(product);
}
