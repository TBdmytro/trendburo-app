/** Диагностика плавности с телефона: витрина присылает замеры (паузы кадров, события Telegram, память) — пишем в журнал сервера.
 *  Без личных данных: только техника устройства и замеры. Включается вводом «#diag» в поиске каталога. */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // проверка доступности сайта Mytheresa для честной загрузки: robots.txt, карта сайта, страница товара — без обхода защиты
  if (req.method === "GET" && /[?&]probe=mytheresa\b/.test(String(req.url || ""))) return probeMytheresa(res);
  if (req.method === "GET" && /[?&]probe=shops\b/.test(String(req.url || ""))) return probeShops(res, (String(req.url).match(/[?&]part=(\d)/) || [])[1] | 0);
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  let j = null;
  try {
    if (req.body && typeof req.body === "object") j = req.body;
    else if (typeof req.body === "string") j = JSON.parse(req.body.slice(0, 20000));
    else { let body = ""; for await (const c of req) { body += c; if (body.length > 20000) break; } j = JSON.parse(body.slice(0, 20000)); } console.log("DIAG " + JSON.stringify(j).slice(0, 15000)); } catch { console.log("DIAG bad"); }
  res.statusCode = 204; res.end();
}

import { safeFetch, parseRobots, robotsAllows } from "../lib/http.js";
async function probeMytheresa(res) {
  const H = "https://www.mytheresa.com", domains = ["www.mytheresa.com", "mytheresa.com"], out = { at: new Date().toISOString() };
  const look = async (name, url, types) => {
    try { const r = await safeFetch(url, { domains, types, maxBytes: 6_000_000, lang: "en-GB,en;q=0.9" });
      const t = r.text || ""; out[name] = { status: r.status, type: r.type, bytes: t.length, ldjson: (t.match(/application\/ld\+json/g) || []).length, product: /"@type"\s*:\s*"Product"/.test(t), price: (t.match(/"price"\s*:\s*"?([\d.,]+)/) || [])[1] || null, currency: (t.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/) || [])[1] || null,
        title: (t.match(/<title[^>]*>([^<]{0,160})/i) || [])[1] || null, text: t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400), scripts: (t.match(/<script[^>]*src="([^"]+)"/gi) || []).slice(0, 6).map(x => x.replace(/.*src="/, "").slice(0, 120)),
        challenge: /captcha|px-captcha|perimeterx|_abck|akamai|access denied|cf-chl|are you a human/i.test(t), head: t.slice(0, 160).replace(/\s+/g, " ") }; return t; }
    catch (e) { out[name] = { error: String(e && e.message || e).slice(0, 200) }; return ""; }
  };
  const rb = await look("robots", H + "/robots.txt", ["text/plain", "text/html"]);
  if (rb) { const R = parseRobots(rb); out.robotsRules = rb.split("\n").filter(l => /^(user-agent|disallow|allow|sitemap|crawl-delay)/i.test(l.trim())).slice(0, 60);
    out.allowed = { women: robotsAllows(R, "/euro/en/women/clothing"), product: robotsAllows(R, "/euro/en/women/x-p00123456") }; }
  const sm = (rb.match(/sitemap:\s*(\S+)/i) || [])[1];
  const smx = sm ? await look("sitemap", sm, ["application/xml", "text/xml", "text/plain"]) : "";
  const locs = (smx.match(/<loc>([^<]+)<\/loc>/g) || []).map(x => x.slice(5, -6)); out.sitemapLocs = locs.slice(0, 80); out.sitemapCount = locs.length;
  const psm = locs.find(u => /euro|en-de|de-en/i.test(u) && /product/i.test(u) && !/\.gz$/.test(u)) || locs.find(u => /product/i.test(u) && !/\.gz$/.test(u));
  let firstProduct = null;
  if (psm) { const px = await look("productSitemap", psm, ["application/xml", "text/xml", "text/plain"]); const pl = (px.match(/<loc>([^<]+)<\/loc>/g) || []).map(x => x.slice(5, -6)); out.productSitemapCount = pl.length; out.productSitemapSample = pl.slice(0, 5); firstProduct = pl.find(u => /-p\d{6,}/.test(u)) || pl[0] || null; }
  const cat = await look("category", H + "/euro/en/women/clothing", ["text/html"]);
  const purl = (cat.match(/href="(\/euro\/en\/women\/[^"]*-p\d{8}[^"]*)"/) || [])[1];
  const prod = purl ? H + purl : firstProduct;
  if (prod && domains.some(d => prod.includes("//" + d + "/"))) { const pt = await look("product", prod, ["text/html"]); out.productUrl = prod;
    const lds = (pt.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []).map(x => x.replace(/^<script[^>]*>|<\/script>$/gi, "")); out.productLd = lds.map(x => x.slice(0, 1500)); out.nextData = /__NEXT_DATA__/.test(pt); }
  console.log("PROBE " + JSON.stringify(out).slice(0, 12000));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

// какие европейские мультибренды отдают открытый каталог (как Sporty & Rich): фиксированный список, только чтение, через обычную проверку поставщика
import { detectSupplier } from "../lib/suppliers.js";
const SHOP_CANDIDATES = [
  ["smets.lu", "voostore.com", "andreas-murkudis.com", "jades24.com", "apropos-store.com", "lodenfrey.com", "julian-fashion.com", "antonioli.eu", "coltortiboutique.com", "giglio.com", "baseblu.com", "tizianafausti.com"],
  ["genteroma.com", "leam.com", "biffi.com", "dante5.com", "suitnegozi.com", "eraldo.com", "wiseboutique.com", "nugnes1920.com", "thedoublef.com", "vitkac.com", "eleonorabonucci.com", "modes.com"],
  ["lyst.com", "cettire.com", "24s.com", "luisaviaroma.com", "ssense.com", "brownsfashion.com", "theluxurycloset.com", "zalando-lounge.de", "breuninger.com", "ekseption.es", "stefaniamode.com", "boutiquematerfamilias.com"]
];
async function probeShops(res, part) {
  const list = SHOP_CANDIDATES[part] || SHOP_CANDIDATES[0], t0 = Date.now();
  const out = await Promise.all(list.map(async h => {
    try { const r = await Promise.race([detectSupplier("https://" + h), new Promise(r => setTimeout(r, 45000, { ok: false, reason: "долго не отвечает" }))]);
      return { host: h, ok: !!r.ok, currency: r.currency || null, eu: !!r.euPrices, market: r.market || null, geoEu: !!r.geoEu, sample: r.sample || 0, vendors: (r.vendors || []).slice(0, 25), vendorCount: r.vendorCount || 0, reason: r.reason || null };
    } catch (e) { return { host: h, ok: false, reason: String(e && e.message || e).slice(0, 160) }; }
  }));
  console.log("PROBE shops " + JSON.stringify(out.map(o => [o.host, o.ok, o.currency, o.vendorCount])).slice(0, 3000));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify({ ms: Date.now() - t0, out }, null, 1));
}
