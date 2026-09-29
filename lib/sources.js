/**
 * Реестр источников и адаптеры. Новый бренд или поставщик = новая запись здесь
 * (+ при необходимости свой адаптер), остальной конвейер не меняется.
 *
 * verified: что проверено о каждом источнике на момент написания (29.09.2026).
 * Значения, помеченные «не проверено», подтверждаются при первом живом запуске и видны в админке.
 */
import { safeFetch, parseRobots, robotsAllows, SourceBlocked, FetchError } from "./http.js";
import { parseProductPage, parseSitemap } from "./jsonld.js";

export const SOURCES = {
  "louis-vuitton": {
    id: "louis-vuitton", name: "Louis Vuitton", brand: "Louis Vuitton", kind: "official", adapter: "brand-site",
    region: "DE", currency: "EUR", domains: ["louisvuitton.com"],
    home: "https://de.louisvuitton.com/deu-de/homepage",
    productPattern: "/deu-de/products/", regionPath: "/deu-de/",
    sitemaps: ["https://de.louisvuitton.com/sitemap.xml"],
    imageDomains: ["louisvuitton.com"],
    imageRights: "source-link", rateMs: 3000,
    checks: [
      "Официального API и партнёрского фида нет — бренд продаёт только сам",
      "robots.txt (eu.louisvuitton.com): страницы товаров не закрыты, закрыты поиск, сортировка, MyLV",
      "Фото: по умолчанию показ по ссылке; копирование включается в админке с указанием основания (разрешение бренда)",
      "Адрес sitemap немецкого каталога не проверен из этого окружения"
    ]
  },
  "dior": {
    id: "dior", name: "Dior", brand: "Dior", kind: "official", adapter: "brand-site",
    region: "DE", currency: "EUR", domains: ["dior.com"],
    home: "https://www.dior.com/de_de/fashion",
    productPattern: "/de_de/fashion/products/", regionPath: "/de_de/",
    sitemaps: ["https://www.dior.com/sitemap.xml"],
    imageDomains: ["dior.com", "christiandior.com"],
    imageRights: "source-link", rateMs: 2000,
    checks: [
      "Партнёрская программа есть только у Dior Beauty; для моды фида нет",
      "robots.txt: crawl-delay 1 с, закрыты couture-товары, JSON-файлы, поиск — правила соблюдаются",
      "sitemap объявлен в robots.txt: https://www.dior.com/sitemap.xml",
      "Фото: по умолчанию показ по ссылке; копирование включается в админке с указанием основания (разрешение бренда)"
    ]
  },
  "gucci": {
    id: "gucci", name: "Gucci", brand: "Gucci", kind: "official", adapter: "brand-site",
    region: "DE", currency: "EUR", domains: ["gucci.com"],
    home: "https://www.gucci.com/de/de/",
    productPattern: "/de/de/pr/", regionPath: "/de/de/",
    sitemaps: ["https://www.gucci.com/sitemap.xml"],
    imageDomains: ["gucci.com"],
    imageRights: "source-link", rateMs: 3000,
    checks: [
      "Партнёрская программа существует в сетях (Rakuten/VigLink) — нужна одобренная заявка; фид с разрешёнными фото подключается как источник «Фид»",
      "Сайт: адрес sitemap и доступность страниц не проверены из этого окружения"
    ]
  },
  "optica-bassol": {
    id: "optica-bassol", name: "Optica Bassol", brand: null, kind: "eyewear-supplier", adapter: "shopify",
    region: "ES", currency: "EUR", domains: ["opticabassol.com"],
    home: "https://www.opticabassol.com",
    collections: ["gafas-de-sol-gucci", "gafas-de-sol-dior", "gafas-de-sol-saint-laurent", "gafas-de-sol-prada", "gafas-de-sol-miu-miu", "gafas-de-sol-bottega-veneta", "gafas-de-sol-cartier", "gafas-de-sol-celine", "chanel-gafas-de-sol"],
    imageDomains: ["opticabassol.com", "cdn.shopify.com"],
    imageRights: "source-link", rateMs: 1500,
    checks: [
      "Shopify: products.json разделов не запрещён robots.txt (запрещены только /collections/*sort_by*)",
      "Цена бутика = compare_at_price, закупка = price; если compare_at_price нет — цена требует проверки",
      "Срок поставки в products.json отсутствует → по правилам не подходит автоматически, пока не указан"
    ]
  },
  "opticalh": {
    id: "opticalh", name: "OpticalH", brand: null, kind: "eyewear-supplier", adapter: "none",
    region: null, currency: "EUR", domains: [], imageRights: "source-link", rateMs: 2000,
    checks: ["Нужен адрес сайта или файл выгрузки поставщика — подключение не выполнено"]
  },
  "file": {
    id: "file", name: "Файл CSV/JSON", brand: null, kind: "file", adapter: "file",
    region: null, currency: "EUR", domains: [], imageRights: "copy-allowed", rateMs: 0,
    checks: ["Загрузка файла из админки; регион и тип цен указываются при загрузке"]
  },
  "feed": {
    id: "feed", name: "Партнёрский фид", brand: null, kind: "official", adapter: "file",
    region: null, currency: "EUR", domains: [], imageRights: "copy-allowed", rateMs: 1000,
    checks: ["Фид партнёрской сети (CSV/XML/JSON). Нужен адрес фида после одобрения заявки"]
  }
};

export function sourceWith(settings, id) {
  const base = SOURCES[id];
  if (!base) throw new Error("Неизвестный источник: " + id);
  const s = settings || {};
  const src = { ...base, ...s, domains: s.domains || base.domains, imageDomains: s.imageDomains || base.imageDomains || base.domains };
  // Копирование фото — только если включено и указано основание (кто и когда разрешил)
  src.imageRights = s.photoCopy && s.photoCopy.allowed && String(s.photoCopy.basis || "").trim().length >= 5 ? "copy-allowed" : (base.kind === "file" ? "copy-allowed" : "source-link");
  return src;
}

/** Контекст сети: соблюдение robots.txt и паузы между запросами одного источника. */
export function makeNet({ fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const robots = new Map(); const last = new Map();
  async function get(src, url, opts = {}) {
    const u = new URL(url);
    if (!robots.has(u.origin)) {
      try { const r = await safeFetch(u.origin + "/robots.txt", { domains: src.domains, fetchImpl, types: ["text/plain", "text/html"] }); robots.set(u.origin, parseRobots(r.text)); }
      catch (e) { if (e instanceof SourceBlocked) throw e; robots.set(u.origin, { rules: [], delay: null }); }
    }
    const rb = robots.get(u.origin);
    if (!robotsAllows(rb, u.pathname + u.search)) throw new FetchError("Путь запрещён robots.txt — не загружаем", 0, false);
    const gap = Math.max(src.rateMs || 0, (rb.delay || 0) * 1000);
    const wait = (last.get(src.id) || 0) + gap - now();
    if (wait > 0) await sleep(wait);
    last.set(src.id, now());
    return safeFetch(url, { domains: src.domains, fetchImpl, ...opts });
  }
  return { get };
}

/* ---------------- Адаптер: сайт бренда (schema.org на страницах товара) ---------------- */
export const brandSite = {
  isProductUrl(src, url) { try { const u = new URL(url); return u.pathname.includes(src.productPattern); } catch { return false; } },
  inRegion(src, url) { try { return new URL(url).pathname.startsWith(src.regionPath); } catch { return false; } },
  async product(src, url, net) {
    const r = await net.get(src, url);
    const raw = parseProductPage(r.text, r.url);
    if (!raw) throw new FetchError("На странице нет данных товара", r.status, false);
    return [raw];
  },
  /** Страница категории: ссылки на товары + следующая страница. */
  async category(src, url, net) {
    const r = await net.get(src, url);
    const links = new Set(); let next = null;
    for (const m of r.text.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
      let h; try { h = new URL(m[1].replace(/&amp;/g, "&"), r.url).href; } catch { continue; }
      if (this.isProductUrl(src, h) && this.inRegion(src, h)) links.add(h.split("?")[0]);
    }
    const nm = r.text.match(/<link[^>]+rel\s*=\s*["']next["'][^>]*href\s*=\s*["']([^"']+)["']/i) || r.text.match(/<a[^>]+rel\s*=\s*["']next["'][^>]*href\s*=\s*["']([^"']+)["']/i);
    if (nm) try { next = new URL(nm[1].replace(/&amp;/g, "&"), r.url).href; } catch {}
    return { products: [...links], next };
  },
  async sitemap(src, url, net) {
    const r = await net.get(src, url, { types: ["application/xml", "text/xml", "text/plain"] });
    const sm = parseSitemap(r.text);
    return { sitemaps: sm.sitemaps.filter(s => { try { return new URL(s).hostname.endsWith(src.domains[0]); } catch { return false; } }),
      products: sm.urls.filter(u => this.isProductUrl(src, u) && this.inRegion(src, u)) };
  }
};

/* ---------------- Адаптер: Shopify-магазин поставщика ---------------- */
export const shopify = {
  isProductUrl(src, url) { return /\/products\//.test(url); },
  async product(src, url, net) {
    const u = new URL(url); const handle = u.pathname.split("/products/")[1]?.split("/")[0];
    if (!handle) throw new FetchError("Не удалось определить товар по ссылке", 0, false);
    const r = await net.get(src, `${u.origin}/products/${handle}.json`, { types: ["application/json"] });
    return [shopifyToRaw(JSON.parse(r.text).product, u.origin)];
  },
  /** Раздел: products.json постранично, пока страницы не кончатся. */
  async collectionPage(src, handle, page, net) {
    const origin = src.home.replace(/\/$/, "");
    const r = await net.get(src, `${origin}/collections/${handle}/products.json?limit=250&page=${page}`, { types: ["application/json"] });
    const items = (JSON.parse(r.text).products || []);
    return { raws: items.map(p => shopifyToRaw(p, origin)), more: items.length === 250 };
  }
};

export function shopifyToRaw(p, origin) {
  const imgs = (p.images || []).map(i => i.src);
  const byId = Object.fromEntries((p.images || []).map(i => [i.id, i.src]));
  const optName = i => (p.options || [])[i]?.name?.toLowerCase() || "";
  const variants = (p.variants || []).map(v => {
    const opt = [v.option1, v.option2, v.option3];
    const color = opt.find((_, i) => /(color|colour|farbe|color)/.test(optName(i))) || null;
    const size = opt.find((_, i) => /(size|talla|talla|calibre|größe)/.test(optName(i))) || null;
    const compare = v.compare_at_price ? Number(v.compare_at_price) : null;
    return {
      sku: v.sku || null, gtin: v.barcode || null, color, size,
      images: v.image_id && byId[v.image_id] ? [byId[v.image_id], ...imgs.filter(x => x !== byId[v.image_id])] : imgs,
      offers: [{ price: compare, currency: "EUR", availability: v.available ? "online" : "out", purchase: Number(v.price) || null }]
    };
  });
  const purchase = variants.map(v => v.offers[0].purchase).filter(Boolean).sort((a, b) => a - b)[0] || null;
  return {
    title: p.title, brand: p.vendor || null, category: [p.product_type, (p.tags || []).join(" ")].join(" "),
    modelSku: null, gtin: null, colors: [...new Set(variants.map(v => v.color).filter(Boolean))], materials: [],
    sizes: [...new Set(variants.map(v => v.size).filter(Boolean))], images: imgs, variants,
    url: `${origin}/products/${p.handle}`, description: null, structured: true, warnings: [], purchase, leadDays: null,
    categoryOverride: "eyewear"
  };
}

export const ADAPTERS = { "brand-site": brandSite, "shopify": shopify };
