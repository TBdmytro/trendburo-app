/**
 * Поставщики, подключённые из админки по ссылке на сайт (сейчас — магазины на Shopify).
 * Описание хранится в документе source.<id> в поле custom; реестр SOURCES в коде не меняется.
 */
import { safeFetch, parseRobots, robotsAllows, SourceBlocked } from "./http.js";
import { hash } from "./normalize.js";
import { SOURCES, EU_COOKIE, EN_LANG, pageCurrency } from "./sources.js";
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
  try { robots = parseRobots((await safeFetch(origin + "/robots.txt", { domains, fetchImpl, lang: EN_LANG, types: ["text/plain", "text/html"] })).text); }
  catch (e) { if (e instanceof SourceBlocked) return { ok: false, origin, reason: "Сайт закрыл доступ для автоматических запросов (" + e.message + ")" }; }
  if (!robotsAllows(robots, "/products.json") || !robotsAllows(robots, "/products/x")) return { ok: false, origin, reason: "robots.txt сайта запрещает автоматическое чтение каталога — не подключаем" };

  let products;
  try {
    const r = await safeFetch(origin + "/products.json?limit=250", { domains, fetchImpl, lang: EN_LANG, types: ["application/json"], maxBytes: 8_000_000 });
    products = JSON.parse(r.text).products;
    if (!Array.isArray(products)) throw new Error("x");
  } catch (e) {
    if (e instanceof SourceBlocked) return { ok: false, origin, reason: "Сайт не пускает автоматическую загрузку (" + e.message + ")" };
    return { ok: false, origin, reason: "Это не магазин на Shopify или каталог закрыт: открытого списка товаров нет. Такой сайт — через скриншоты или файл." };
  }
  let shop = {};
  try { shop = JSON.parse((await safeFetch(origin + "/meta.json", { domains, fetchImpl, lang: EN_LANG, types: ["application/json"] })).text) || {}; } catch {}
  let currency = FX_CURRENCIES.includes(shop.currency) || shop.currency === "EUR" ? shop.currency : (shop.currency ? null : "EUR");
  // Магазин не в евро — ищем его европейский раздел (Shopify Markets: /en-de/…), чтобы брать цены для Европы
  let market = "", baseCurrency = null, geoEu = false, euAjax = false;
  if (shop.currency && shop.currency !== "EUR") {
    const eu = await findEuMarket(origin, products, robots, { domains, fetchImpl });
    if (eu) { market = eu.market; baseCurrency = shop.currency; currency = "EUR"; products = eu.products; }
    else {
      // отдельного раздела нет — магазин выбирает Европу по стране посетителя (как у Sporty & Rich)
      const g = await findGeoEu(origin, products, robots, { domains, fetchImpl });
      if (g) { geoEu = true; euAjax = !!g.ajax; baseCurrency = shop.currency; currency = "EUR"; products = g.products; }
    }
  }
  const vendors = [...new Set(products.map(p => p.vendor).filter(Boolean))];
  const types = [...new Set(products.map(p => p.product_type).filter(Boolean))];
  const eyewear = products.filter(p => /(sunglass|gafas|eyewear|brille|lunettes|occhiali)/i.test([p.product_type, p.title, (p.tags || []).join(" ")].join(" "))).length > products.length / 2;
  return {
    ok: !!currency, origin, host, market, baseCurrency, geoEu, euAjax, euPrices: currency === "EUR", name: shop.name || host.split(".")[0].replace(/^\w/, c => c.toUpperCase()),
    currency: currency || shop.currency, reason: currency ? null : `Валюта магазина ${shop.currency} пока не поддерживается`,
    sample: products.length, more: products.length === 250, vendors: vendors.slice(0, 40), vendorCount: vendors.length, types: types.slice(0, 20),
    kind: eyewear ? "eyewear-supplier" : "retailer",
    preview: products.slice(0, 6).map(p => ({ title: p.title, vendor: p.vendor, price: p.variants?.[0]?.price || null, image: p.images?.[0]?.src || null }))
  };
}

// сначала английские разделы Европы: названия товаров нужны на английском; немецкие — только если английских нет
const EU_MARKETS = ["/en-de", "/en-eu", "/en-fr", "/en-it", "/en-es", "/en-nl", "/en-at", "/eu", "/de-de", "/de"];
/** Европейский раздел магазина: products.json открыт и robots.txt не запрещает, страница товара показывает цены в EUR. */
export async function findEuMarket(origin, products, robots, { domains, fetchImpl = fetch } = {}) {
  const handle = products.find(p => p.handle)?.handle; if (!handle) return null;
  for (const m of EU_MARKETS) {
    if (!robotsAllows(robots, m + "/products.json") || !robotsAllows(robots, m + "/products/x")) continue;
    try {
      const page = await safeFetch(`${origin}${m}/products/${handle}`, { domains, fetchImpl, lang: EN_LANG, types: ["text/html"], maxBytes: 4_000_000 });
      const cur = (page.text.match(/Shopify\.currency\s*=\s*\{"active":"([A-Z]{3})"/) || page.text.match(/"currencyCode"\s*:\s*"([A-Z]{3})"/) || [])[1];
      if (cur !== "EUR") continue;
      const r = await safeFetch(`${origin}${m}/products.json?limit=250`, { domains, fetchImpl, lang: EN_LANG, types: ["application/json"], maxBytes: 8_000_000 });
      const list = JSON.parse(r.text).products;
      if (Array.isArray(list) && list.length) return { market: m, products: list };
    } catch { /* следующий вариант */ }
  }
  return null;
}

/** Цена на странице товара (то, что видит покупатель): og:price:amount или schema.org. */
export function pagePrice(html) {
  const m = String(html).match(/og:price:amount"\s+content="([^"]+)"/) || String(html).match(/"price"\s*:\s*"?([\d.,]+)"?/);
  if (!m) return null;
  let t = m[1].replace(/[^\d.,]/g, "");
  // 1.234,50 / 1,234.50 / 120,00 → число
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", "."); else t = t.replace(/,/g, "");
  const n = Number(t); return n > 0 ? n : null;
}

/**
 * Европа по стране посетителя: выбираем Германию (как переключатель страны на сайте) и проверяем,
 * что страница товара в евро и products.json отдаёт ту же цену, что видит покупатель. Иначе — null.
 */
export async function findGeoEu(origin, products, robots, { domains, fetchImpl = fetch } = {}) {
  const p0 = products.find(p => p.handle && p.variants?.length);
  const log = (step, x) => { try { console.log("EUCHECK " + JSON.stringify({ origin, handle: p0?.handle, step, ...x })); } catch {} };
  if (!p0 || !robotsAllows(robots, "/products/x")) { log("no-product-or-robots", {}); return null; }
  try {
    const page = await safeFetch(`${origin}/products/${p0.handle}`, { domains, fetchImpl, lang: EN_LANG, types: ["text/html"], maxBytes: 4_000_000, cookie: EU_COOKIE });
    const pc = pageCurrency(page.text), shown = pagePrice(page.text);
    log("page", { pageCurrency: pc, shown, baseJsonPrice: p0.variants?.[0]?.price });
    if (pc !== "EUR") return null;
    if (!shown) return null;
    const r = await safeFetch(`${origin}/products.json?limit=250`, { domains, fetchImpl, lang: EN_LANG, types: ["application/json"], maxBytes: 8_000_000, cookie: EU_COOKIE });
    const list = JSON.parse(r.text).products;
    const same = Array.isArray(list) && list.find(p => p.handle === p0.handle);
    log("products.json+cookie", { price: same?.variants?.[0]?.price });
    if (same && (same.variants || []).some(v => Math.abs(Number(v.price) - shown) <= shown * 0.01)) return { products: list };
    // products.json отдаёт базовую валюту магазина (доллары) — берём цены Германии со страницы товара в формате магазина (/products/…js),
    // это то же, что видит покупатель из Германии: евро, без пересчёта по курсу
    const js = JSON.parse((await safeFetch(`${origin}/products/${p0.handle}.js`, { domains, fetchImpl, lang: EN_LANG, types: ["application/json", "text/javascript"], maxBytes: 2_000_000, cookie: EU_COOKIE })).text);
    const eur = (js.variants || []).map(v => Number(v.price) / 100);
    log("product.js+cookie", { prices: eur.slice(0, 3), currency: js.currency || null });
    if (!eur.some(x => Math.abs(x - shown) <= shown * 0.01)) return null;
    return { products: Array.isArray(list) ? list : products, ajax: true };
  } catch (e) { log("error", { error: String(e && e.message || e).slice(0, 200) }); return null; }
}

/**
 * Уже подключённый магазин в долларах (как Sporty & Rich): один раз проверяем, отдаёт ли он цены Германии по товарам.
 * Если да — запоминаем, и дальше товары грузятся с европейским прайсом, без пересчёта по курсу.
 */
export async function upgradeEuSource(store, sourceId, settings, { fetchImpl = fetch } = {}) {
  const c = settings?.custom;
  if (c && c.adapter === "shopify") console.log("EUCHECK " + JSON.stringify({ id: sourceId, step: "state", shopCurrency: c.shopCurrency, geoEu: !!c.geoEu, euAjax: !!c.euAjax, market: c.market || "" }));
  if (!c || c.adapter !== "shopify" || c.euAjax || !c.shopCurrency || c.shopCurrency === "EUR") return settings;
  const origin = String(c.home || "").replace(/\/$/, ""), domains = c.domains;
  try {
    const robots = parseRobots((await safeFetch(origin + "/robots.txt", { domains, fetchImpl, types: ["text/plain", "text/html"] })).text);
    const list = JSON.parse((await safeFetch(origin + "/products.json?limit=30", { domains, fetchImpl, lang: EN_LANG, types: ["application/json"], maxBytes: 8_000_000 })).text).products || [];
    const g = await findGeoEu(origin, list, robots, { domains, fetchImpl });
    console.log("EUCHECK " + JSON.stringify({ origin, step: "upgrade", result: g ? (g.ajax ? "ajax" : "products.json") : "no" }));
    if (!g) return settings;
    // цены товаров поменяются (было: доллары по курсу, стало: прайс Германии) — сами на витрине их не меняем:
    // автообновление и автовыгрузка выключаются, обновлённые цены ждут проверки в админке («К проверке»), пока их не включат снова
    const next = { ...settings, autoUpdate: false, autoPublish: false, custom: { ...c, geoEu: true, euAjax: !!g.ajax, shopCurrency: "EUR", region: "EU", euReview: true,
      checks: [...(c.checks || []).filter(x => !/Цены Европы/.test(x)), "Цены Европы: магазин отдаёт цены Германии в евро по каждому товару — без пересчёта по курсу",
        "Цены переведены на прайс Германии: новые цены уже опубликованных товаров ждут проверки. Автообновление включите после проверки"] } };
    await store.put(next);
    return next;
  } catch (e) { console.log("EUCHECK " + JSON.stringify({ origin, step: "upgrade-error", error: String(e && e.message || e).slice(0, 200) })); return settings; }
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
      id, name: opts.name, brand: null, kind: opts.kind, adapter: "shopify", home: det.origin, market: det.market || "",
      region: det.market || det.geoEu ? "EU" : (REGION_BY_CUR[det.currency] || null), shopCurrency: det.currency, currency: "EUR", geoEu: !!det.geoEu, euAjax: !!det.euAjax,
      domains: [det.host, "cdn.shopify.com"], imageDomains: [det.host, "cdn.shopify.com"], collections: prev?.custom?.collections || [],
      catalog: true, rateMs: 1500,
      checks: [`Магазин на Shopify, каталог открыт (products.json), robots.txt не запрещает`, det.market ? `Цены Европы: раздел магазина ${det.market} (вместо ${det.baseCurrency}), в евро` : det.geoEu ? `Цены Европы: магазин выбирает страну по посетителю — выбрана Германия, цены в евро (вместо ${det.baseCurrency})` : det.currency !== "EUR" ? `⚠ Европейских цен нет: цены ${det.currency} пересчитаны в € по курсу. Товары не публикуются автоматически — только после проверки` : `Валюта магазина: EUR`, `Подключён ${new Date().toLocaleDateString("ru-RU")}`]
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

/** Разделы магазина (как на его сайте): Бестселлеры, Женское, Мужское… — из открытого collections.json. */
export async function listCollections(store, id, { fetchImpl = fetch } = {}) {
  const s = await store.get("source." + id); if (!s?.custom) throw new Error("Поставщик не найден");
  const c = s.custom, base = c.home.replace(/\/$/, ""), mk = c.market || "", domains = c.domains;
  let robots = { rules: [] };
  try { robots = parseRobots((await safeFetch(base + "/robots.txt", { domains, fetchImpl, lang: EN_LANG, types: ["text/plain", "text/html"] })).text); } catch {}
  if (!robotsAllows(robots, mk + "/collections.json")) throw new Error("Магазин закрыл список разделов для автоматического чтения");
  const out = [];
  for (let page = 1; page <= 8; page++) {
    const r = await safeFetch(`${base}${mk}/collections.json?limit=250&page=${page}`, { domains, fetchImpl, lang: EN_LANG, types: ["application/json"], maxBytes: 8_000_000 });
    const list = JSON.parse(r.text).collections || [];
    list.forEach(x => out.push({ handle: x.handle, title: x.title, count: x.products_count ?? null }));
    if (list.length < 250) break;
  }
  const rank = h => /best.?sell|bestseller/i.test(h) ? 0 : /(^|-)(women|womens)(-|$)/i.test(h) ? 1 : /(^|-)(men|mens)(-|$)/i.test(h) ? 2 : /new/i.test(h) ? 3 : 9;
  const collections = out.filter(x => x.count !== 0).sort((a, b) => rank(a.handle) - rank(b.handle));
  // ничего не выбрано — предлагаем вкладки по умолчанию (бестселлеры, женское, мужское, аксессуары, новинки)
  const { defaultTabs } = await import("./sections.js");
  return { selected: c.collections?.length ? c.collections : defaultTabs(collections).map(t => t.h), collections };
}

/** Выбранные разделы: каталог грузится только из них, по порядку (первым — то, что выбрано первым). */
export async function saveCollections(store, id, handles, titles = []) {
  const s = await store.get("source." + id); if (!s?.custom) throw new Error("Поставщик не найден");
  const clean = (Array.isArray(handles) ? handles : []).map((h, i) => [String(h).toLowerCase().replace(/[^a-z0-9-]/g, ""), String((titles || [])[i] || "").slice(0, 60)]).filter(([h]) => h).slice(0, 12);
  s.custom.collections = clean.map(x => x[0]);
  s.custom.sectionTitles = clean.map(x => x[1] || x[0]);
  // вкладки видны сразу; товары в них разложит раскладка на сервере
  // точечная правка, чтобы не затереть состояние идущей загрузки
  await store.patchMany([s._id], { custom: s.custom, tabs: clean.map(([h, t]) => ({ h, t: t || h })) });
  return { collections: s.custom.collections };
}
