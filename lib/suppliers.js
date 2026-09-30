/**
 * Поставщики, подключённые из админки по ссылке на сайт (сейчас — магазины на Shopify).
 * Описание хранится в документе source.<id> в поле custom; реестр SOURCES в коде не меняется.
 */
import { safeFetch, parseRobots, robotsAllows, SourceBlocked } from "./http.js";
import { hash } from "./normalize.js";
import { SOURCES } from "./sources.js";
import { FX_CURRENCIES } from "./fx.js";

const REGION_BY_CUR = { EUR: "EU", USD: "US", GBP: "GB", CHF: "CH", AED: "AE", SEK: "SE", DKK: "DK", PLN: "PL", CAD: "CA", AUD: "AU", JPY: "JP" };
const slug = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Все источники: встроенные + подключённые из админки. */
export async function allSourceIds(store) {
  const custom = await store.list("sourceSettings", {}, { limit: 500, fields: "_id, sourceId, custom" });
  return [...Object.keys(SOURCES), ...custom.filter(s => s.custom && !SOURCES[s.sourceId]).map(s => s.sourceId)];
}

function originOf(input) {
  let u; try { u = new URL(/^https?:\/\//i.test(input) ? input : "https://" + String(input).trim()); } catch { throw new Error("Некорректная ссылка"); }
  if (u.protocol !== "https:") u.protocol = "https:";
  return u;
}

/**
 * Проверка сайта перед подключением: robots.txt, products.json, валюта магазина.
 * Ничего не сохраняет. Возвращает описание, которое админ подтверждает.
 */
export async function detectSupplier(input, { fetchImpl = fetch } = {}) {
  const u = originOf(input);
  const host = u.hostname.replace(/^www\./, "");
  const domains = [host, "cdn.shopify.com"];
  const origin = u.origin;
  // robots.txt: если каталог закрыт для роботов — не подключаем
  let robots = { rules: [], delay: null };
  try { robots = parseRobots((await safeFetch(origin + "/robots.txt", { domains, fetchImpl, types: ["text/plain", "text/html"] })).text); }
  catch (e) { if (e instanceof SourceBlocked) return { ok: false, origin, reason: "Сайт закрыл доступ для автоматических запросов (" + e.message + ")" }; }
  if (!robotsAllows(robots, "/products.json") || !robotsAllows(robots, "/products/x")) return { ok: false, origin, reason: "robots.txt сайта запрещает автоматическое чтение каталога — не подключаем" };

  let products;
  try {
    const r = await safeFetch(origin + "/products.json?limit=250", { domains, fetchImpl, types: ["application/json"], maxBytes: 8_000_000 });
    products = JSON.parse(r.text).products;
    if (!Array.isArray(products)) throw new Error("x");
  } catch (e) {
    if (e instanceof SourceBlocked) return { ok: false, origin, reason: "Сайт не пускает автоматическую загрузку (" + e.message + ")" };
    return { ok: false, origin, reason: "Это не магазин на Shopify или каталог закрыт: открытого списка товаров нет. Такой сайт — через скриншоты или файл." };
  }
  let shop = {};
  try { shop = JSON.parse((await safeFetch(origin + "/meta.json", { domains, fetchImpl, types: ["application/json"] })).text) || {}; } catch {}
  const currency = FX_CURRENCIES.includes(shop.currency) || shop.currency === "EUR" ? shop.currency : (shop.currency ? null : "EUR");
  const vendors = [...new Set(products.map(p => p.vendor).filter(Boolean))];
  const types = [...new Set(products.map(p => p.product_type).filter(Boolean))];
  const eyewear = products.filter(p => /(sunglass|gafas|eyewear|brille|lunettes|occhiali)/i.test([p.product_type, p.title, (p.tags || []).join(" ")].join(" "))).length > products.length / 2;
  return {
    ok: !!currency, origin, host, name: shop.name || host.split(".")[0].replace(/^\w/, c => c.toUpperCase()),
    currency: currency || shop.currency, reason: currency ? null : `Валюта магазина ${shop.currency} пока не поддерживается`,
    sample: products.length, more: products.length === 250, vendors: vendors.slice(0, 40), vendorCount: vendors.length, types: types.slice(0, 20),
    kind: eyewear ? "eyewear-supplier" : "retailer",
    preview: products.slice(0, 6).map(p => ({ title: p.title, vendor: p.vendor, price: p.variants?.[0]?.price || null, image: p.images?.[0]?.src || null }))
  };
}

export function cleanSupplier(d) {
  const kind = d.kind === "eyewear-supplier" ? "eyewear-supplier" : "retailer";
  const factor = Number(d.factor); const brands = (Array.isArray(d.brands) ? d.brands : String(d.brands || "").split(/[,\n]/)).map(s => String(s).trim()).filter(Boolean).slice(0, 200);
  return { name: String(d.name || "").trim().slice(0, 60), kind, factor: factor > 0.5 && factor < 3 ? Math.round(factor * 1000) / 1000 : 1, brands, cats: (Array.isArray(d.cats) ? d.cats : []).filter(c => typeof c === "string").slice(0, 12) };
}

/** Подключить: повторная проверка на сервере, затем запись в source.<id>. */
export async function addSupplier(store, data, { fetchImpl = fetch, by = "admin" } = {}) {
  const det = await detectSupplier(data.url, { fetchImpl });
  if (!det.ok) throw new Error(det.reason);
  const opts = cleanSupplier({ ...data, name: data.name || det.name, kind: data.kind || det.kind });
  const id = "s-" + (slug(det.host.split(".")[0]) || "shop") + "-" + hash(det.origin).slice(0, 4);
  const prev = await store.get("source." + id);
  const doc = {
    ...(prev || { _id: "source." + id, _type: "sourceSettings", sourceId: id, schedule: "daily", autoUpdate: true, createdAt: new Date().toISOString(), createdBy: by }),
    custom: {
      id, name: opts.name, brand: null, kind: opts.kind, adapter: "shopify", home: det.origin,
      region: REGION_BY_CUR[det.currency] || null, shopCurrency: det.currency, currency: "EUR",
      domains: [det.host, "cdn.shopify.com"], imageDomains: [det.host, "cdn.shopify.com"], collections: [],
      catalog: true, rateMs: 1500,
      checks: [`Магазин на Shopify, каталог открыт (products.json), robots.txt не запрещает`, `Валюта магазина: ${det.currency}${det.currency !== "EUR" ? " — цены пересчитываются в € по курсу" : ""}`, `Подключён ${new Date().toLocaleDateString("ru-RU")}`]
    },
    factor: opts.factor, brands: opts.brands, cats: opts.cats,
    check: { ok: true, state: "ok", text: `Каталог открыт: ${det.sample}${det.more ? "+" : ""} товаров на первой странице`, at: new Date().toISOString() }
  };
  await store.put(doc);
  return { id, source: doc };
}

export async function updateSupplier(store, id, data) {
  const s = await store.get("source." + id); if (!s?.custom) throw new Error("Поставщик не найден");
  const o = cleanSupplier({ ...s.custom, factor: s.factor, brands: s.brands, cats: s.cats, ...data });
  if (o.name) s.custom.name = o.name;
  s.custom.kind = o.kind; s.factor = o.factor; s.brands = o.brands; s.cats = o.cats;
  await store.put(s); return s;
}

/** Отключить поставщика. Товары: оставить скрытыми или удалить. */
export async function removeSupplier(store, id, { deleteProducts = false } = {}) {
  const s = await store.get("source." + id); if (!s?.custom) throw new Error("Можно отключить только поставщика, подключённого по ссылке");
  const products = (await store.list("product", {}, { limit: 50000, fields: "_id, status, offers[]{sourceId}" })).filter(p => (p.offers || []).some(o => o.sourceId === id));
  if (deleteProducts) await store.delMany(products.filter(p => (p.offers || []).every(o => o.sourceId === id)).map(p => p._id));
  else await store.patchMany(products.filter(p => p.status === "published").map(p => p._id), { status: "draft" });
  await store.del(s._id);
  return { products: products.length };
}
