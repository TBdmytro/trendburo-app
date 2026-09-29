/**
 * Разбор структурированных данных страницы товара (schema.org Product / ProductGroup в JSON-LD,
 * плюс мета-теги Open Graph как запасной вариант). HTML страницы не исполняется — только чтение текста.
 */

const AVAIL = {
  instock: "online", onlineonly: "online", limitedavailability: "online",
  instoreonly: "boutique", outofstock: "out", soldout: "out", discontinued: "out",
  preorder: "preorder", presale: "preorder", backorder: "preorder"
};
export function mapAvailability(v) {
  if (!v) return "unknown";
  const k = String(v).replace(/^https?:\/\/schema\.org\//i, "").toLowerCase();
  return AVAIL[k] || "unknown";
}

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[1].trim().replace(/^<!--|-->$/g, "").trim();
    try { out.push(JSON.parse(raw)); }
    catch { try { out.push(JSON.parse(decodeEntities(raw))); } catch { /* повреждённый блок пропускаем */ } }
  }
  const flat = [];
  const walk = n => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object") return;
    if (n["@graph"]) walk(n["@graph"]);
    flat.push(n);
  };
  out.forEach(walk);
  return flat;
}

const typeIs = (n, t) => [].concat(n["@type"] || []).some(x => String(x).toLowerCase() === t);
const str = v => (v === undefined || v === null ? null : typeof v === "object" ? (v.name || v["@value"] || null) : String(v).trim() || null);
const first = v => Array.isArray(v) ? v[0] : v;

function images(v) {
  const arr = [].concat(v || []);
  return arr.map(x => typeof x === "string" ? x : (x && (x.contentUrl || x.url)) || null).filter(Boolean)
    .map(u => u.startsWith("//") ? "https:" + u : u);
}

function offersOf(node) {
  const o = [].concat(node.offers || []);
  const res = [];
  for (const x of o) {
    if (!x) continue;
    if (typeIs(x, "aggregateoffer")) {
      res.push({ price: num(x.lowPrice ?? x.price), currency: str(x.priceCurrency), availability: mapAvailability(x.availability), sku: str(x.sku), url: str(x.url), aggregate: true });
      [].concat(x.offers || []).forEach(y => res.push({ price: num(y.price), currency: str(y.priceCurrency), availability: mapAvailability(y.availability), sku: str(y.sku), url: str(y.url) }));
    } else {
      const ps = x.priceSpecification ? first(x.priceSpecification) : null;
      res.push({
        price: num(x.price ?? ps?.price), currency: str(x.priceCurrency ?? ps?.priceCurrency),
        taxIncluded: ps && ps.valueAddedTaxIncluded !== undefined ? !!ps.valueAddedTaxIncluded : null,
        availability: mapAvailability(x.availability), sku: str(x.sku), url: str(x.url)
      });
    }
  }
  return res;
}
function num(v) { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; }
const gtinOf = n => str(n.gtin13 || n.gtin || n.gtin14 || n.gtin12 || n.gtin8 || n.ean);

function variantFrom(p) {
  return {
    sku: str(p.sku) || str(p.productID), gtin: gtinOf(p), mpn: str(p.mpn),
    color: str(p.color), size: str(p.size), material: str(p.material),
    images: images(p.image), offers: offersOf(p), url: str(p.url), name: str(p.name)
  };
}

/** Мета-теги og:* / product:* как запасной источник. */
export function extractMeta(html) {
  const meta = {};
  const re = /<meta\s+[^>]*(?:property|name)\s*=\s*["']([^"']+)["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/gi;
  let m; while ((m = re.exec(html))) { const k = m[1].toLowerCase(); if (!(k in meta)) meta[k] = decodeEntities(m[2]); }
  const re2 = /<meta\s+[^>]*content\s*=\s*["']([^"']*)["'][^>]*(?:property|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = re2.exec(html))) { const k = m[2].toLowerCase(); if (!(k in meta)) meta[k] = decodeEntities(m[1]); }
  return meta;
}

/**
 * Главный разбор. Возвращает сырую модель источника или null, если товара на странице нет.
 * {title, brand, description, category, modelSku, gtin, colors[], materials[], sizes[], images[], variants[], url, warnings[]}
 */
export function parseProductPage(html, pageUrl) {
  const nodes = extractJsonLd(html);
  const warnings = [];
  const group = nodes.find(n => typeIs(n, "productgroup"));
  const products = nodes.filter(n => typeIs(n, "product"));
  let base = group || products[0];
  const meta = extractMeta(html);

  if (!base) {
    if (!meta["og:title"]) return null;
    warnings.push("Нет структурированных данных schema.org — использованы только мета-теги, проверьте вручную");
    const price = num(meta["product:price:amount"] || meta["og:price:amount"]);
    return {
      title: meta["og:title"], brand: meta["product:brand"] || null, description: null, category: null,
      modelSku: meta["product:retailer_item_id"] || null, gtin: null, colors: [], materials: [], sizes: [],
      images: meta["og:image"] ? [meta["og:image"]] : [],
      variants: [{ sku: meta["product:retailer_item_id"] || null, color: meta["product:color"] || null, size: null, images: meta["og:image"] ? [meta["og:image"]] : [], offers: price ? [{ price, currency: meta["product:price:currency"] || meta["og:price:currency"] || null, availability: mapAvailability(meta["product:availability"]) }] : [] }],
      url: pageUrl, warnings, structured: false
    };
  }

  let variants;
  if (group && group.hasVariant) variants = [].concat(group.hasVariant).map(variantFrom);
  else if (products.length > 1 && !group) {
    const withSku = products.filter(p => p.sku || p.offers);
    variants = withSku.map(variantFrom);
  } else variants = [variantFrom(base)];
  if (!group) {
    // один Product: варианты могут быть в offers с разными sku
    const v = variants[0];
    if (v && v.offers.length > 1 && v.offers.every(o => o.sku)) {
      variants = v.offers.map(o => ({ ...v, sku: o.sku, offers: [o], images: v.images }));
    }
  }

  const title = str(base.name) || meta["og:title"] || null;
  const baseImages = images(base.image);
  const allImages = [...baseImages];
  variants.forEach(v => { if (!v.images.length) v.images = baseImages.slice(); v.images.forEach(i => { if (!allImages.includes(i)) allImages.push(i); }); });
  if (!allImages.length && meta["og:image"]) allImages.push(meta["og:image"]);

  const uniq = a => [...new Set(a.filter(Boolean))];
  return {
    title,
    brand: str(base.brand) || str(first(products)?.brand) || meta["product:brand"] || null,
    description: str(base.description),
    category: str(base.category) || null,
    modelSku: str(group?.productGroupID) || str(base.mpn) || str(base.sku) || (variants.length === 1 ? variants[0].sku : null),
    gtin: gtinOf(base),
    colors: uniq(variants.map(v => v.color).concat(str(base.color))),
    materials: uniq(variants.map(v => v.material).concat(str(base.material))),
    sizes: uniq(variants.map(v => v.size)),
    images: allImages,
    variants,
    url: str(base.url) || pageUrl,
    warnings, structured: true
  };
}

/** Разбор sitemap.xml / sitemap index: {sitemaps:[], urls:[]} */
export function parseSitemap(xml) {
  const locs = [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decodeEntities(m[1]));
  const isIndex = /<sitemapindex/i.test(xml);
  return isIndex ? { sitemaps: locs, urls: [] } : { sitemaps: [], urls: locs };
}
