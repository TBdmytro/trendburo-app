/**
 * Приведение данных источника к единой структуре: модель → варианты → предложения.
 * Ничего не выдумываем: чего нет в источнике, остаётся null и попадает в список неполноты.
 */
import { createHash } from "node:crypto";

export const CATEGORIES = {
  bags: "Сумки", shoes: "Обувь", clothing: "Одежда", eyewear: "Очки", accessories: "Аксессуары",
  jewelry: "Украшения", watches: "Часы", fragrance: "Ароматы", other: "Другое"
};

const CAT_RULES = [
  ["eyewear", /(sunglass|sonnenbrill|eyewear|brille|lunettes|occhiali|optical)/i],
  ["bags", /(bag|tasche|handtasch|tote|clutch|backpack|rucksack|shopper|pochette|sac\b|borse|luggage|gep[aä]ck|reisegep)/i],
  ["shoes", /(shoe|schuh|sneaker|loafer|slipper|pump|sandal|boot|stiefel|mules?|ballerin|espadrill|chaussure|scarpe)/i],
  ["jewelry", /(jewel|schmuck|ring|necklace|kette|bracelet|armband|earring|ohrring|bijou|gioiell)/i],
  ["watches", /(watch|uhr\b|uhren|montre|orolog)/i],
  ["fragrance", /(fragrance|parfum|perfume|duft|eau de)/i],
  ["accessories", /(accessor|wallet|geldb[oö]rse|belt|g[uü]rtel|scarf|schal|tuch|cardholder|kartenetui|keychain|schl[uü]ssel|small leather|kleinlederwaren|hat|m[uü]tze|cap|glove|handschuh|tie|krawatte)/i],
  ["clothing", /(ready-to-wear|pr[eê]t|kleidung|apparel|clothing|dress|kleid|jacket|jacke|coat|mantel|shirt|hemd|t-shirt|pullover|knit|strick|trouser|hose|jeans|skirt|rock|blazer|hoodie|sweat)/i]
];

export function detectCategory(...hints) {
  const text = hints.filter(Boolean).join(" ");
  for (const [cat, re] of CAT_RULES) if (re.test(text)) return cat;
  return null;
}
export function detectGender(...hints) {
  const t = hints.filter(Boolean).join(" ").toLowerCase();
  const w = /(women|damen|femme|donna|\/w\/|woman)/.test(t), m = /(\bmen\b|herren|homme|uomo|\/m\/|\bman\b|\/men)/.test(t);
  if (w && !m) return "w"; if (m && !w) return "m"; if (w && m) return "u"; return null;
}

/** Короткое название 2–5 слов на основе реального названия: убираем бренд и хвост с цветом/материалом. */
export function shortTitle(title, brand) {
  if (!title) return null;
  let t = String(title);
  if (brand) t = t.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "");
  t = t.split(/\s[-–|]\s|,/)[0].replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean);
  if (!words.length) return String(title).trim();
  return words.slice(0, 5).join(" ");
}

export const hash = s => createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
const slug = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * @param raw   результат parseProductPage / строки CSV
 * @param src   описание источника {id, kind, brand, region, currency, imageRights}
 */
export function normalize(raw, src, { now = new Date().toISOString(), urlHints = "" } = {}) {
  const brand = src.brand || raw.brand || null;
  const issues = [];
  const cat = raw.categoryOverride || detectCategory(raw.category, urlHints, raw.title) || null;
  if (!cat) issues.push({ level: "warn", code: "no-category", text: "Категорию не удалось определить" });
  const gender = raw.gender || detectGender(raw.category, urlHints, raw.title);

  const variants = (raw.variants && raw.variants.length ? raw.variants : [{}]).map((v, i) => ({
    _key: hash((v.sku || "") + "|" + (v.color || "") + "|" + (v.size || "") + "|" + i),
    sku: v.sku || null, gtin: v.gtin || null, color: v.color || null, size: v.size || null, material: v.material || null,
    images: (v.images || []).slice(0, 12).map(url => ({ url, rights: src.imageRights || "source-link" }))
  }));

  // Предложение источника: цены по вариантам в валюте и регионе источника, без конвертации
  const perVariant = {};
  let boutique = null, currency = null, taxIncluded = null;
  (raw.variants || []).forEach((v, i) => {
    const o = (v.offers || [])[0];
    const key = variants[i]._key;
    perVariant[key] = { status: o ? o.availability : "unknown", price: o ? o.price : null };
    if (o && o.price && (boutique === null || o.price < boutique)) boutique = o.price;
    if (o && o.currency) currency = o.currency;
    if (o && o.taxIncluded !== undefined && o.taxIncluded !== null) taxIncluded = o.taxIncluded;
  });
  if (raw.price && !boutique) boutique = raw.price;
  if (raw.currency) currency = raw.currency;

  if (!boutique) issues.push({ level: "error", code: "no-price", text: "Нет цены в источнике" });
  if (currency && src.currency && currency !== src.currency) issues.push({ level: "error", code: "currency", text: `Валюта источника ${currency}, ожидалась ${src.currency} — конвертация не выполняется` });
  const onlineOrder = Object.values(perVariant).some(x => x.status === "online");

  const imgCount = new Set(variants.flatMap(v => v.images.map(i => i.url))).size || (raw.images || []).length;
  if (!imgCount) issues.push({ level: "error", code: "no-photo", text: "Нет фотографий" });
  else if (imgCount < 3) issues.push({ level: "warn", code: "few-photos", text: `Фото: ${imgCount} из рекомендуемых 3` });
  if (!raw.modelSku && !variants.some(v => v.sku || v.gtin)) issues.push({ level: "warn", code: "no-ids", text: "Нет артикула и GTIN — дубли определить нельзя" });
  if (raw.structured === false) issues.push({ level: "warn", code: "meta-only", text: "Только мета-теги, без структурированных данных" });

  const key = raw.modelSku ? slug(brand) + "." + slug(raw.modelSku) : "u." + hash(raw.url || raw.title);
  const model = {
    _id: "product." + key,
    brand, sourceTitle: raw.title || null, title: shortTitle(raw.title, brand),
    category: cat, subcategory: raw.subcategory || null, gender,
    modelSku: raw.modelSku || null, gtin: raw.gtin || null,
    colors: raw.colors || [], materials: raw.materials || [], sizes: raw.sizes || [], sizeSystem: raw.sizeSystem || null,
    images: (raw.images || []).slice(0, 16).map(url => ({ url, rights: src.imageRights || "source-link" })),
    sourceUrl: raw.url || null, description: raw.description || null
  };
  const offer = {
    _key: hash(src.id + "|" + (raw.url || key)),
    sourceId: src.id, sourceKind: src.kind, region: src.region || null, currency: currency || null,
    boutique, priceSource: src.kind === "official" ? "официальный сайт" : src.kind === "eyewear-supplier" ? "поставщик" : (raw.priceSource || "файл"),
    taxIncluded, purchase: raw.purchase ?? null, availability: perVariant, onlineOrder,
    supplierLeadDays: raw.leadDays ?? null, checkedAt: now, errors: [], url: raw.url || null,
    completeness: Math.max(0, 1 - issues.filter(i => i.level === "error").length * 0.34 - issues.filter(i => i.level === "warn").length * 0.1)
  };
  return { model, variants, offer, issues, warnings: raw.warnings || [] };
}
