/** Диагностика плавности с телефона: витрина присылает замеры (паузы кадров, события Telegram, память) — пишем в журнал сервера.
 *  Без личных данных: только техника устройства и замеры. Включается вводом «#diag» в поиске каталога. */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // проверка доступности сайта Mytheresa для честной загрузки: robots.txt, карта сайта, страница товара — без обхода защиты
  if (req.method === "GET" && /[?&]probe=mytheresa\b/.test(String(req.url || ""))) return probeMytheresa(res);
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
        challenge: /captcha|px-captcha|perimeterx|_abck|akamai|access denied|cf-chl|are you a human/i.test(t), head: t.slice(0, 160).replace(/\s+/g, " ") }; return t; }
    catch (e) { out[name] = { error: String(e && e.message || e).slice(0, 200) }; return ""; }
  };
  const rb = await look("robots", H + "/robots.txt", ["text/plain", "text/html"]);
  if (rb) { const R = parseRobots(rb); out.robotsRules = rb.split("\n").filter(l => /^(user-agent|disallow|allow|sitemap|crawl-delay)/i.test(l.trim())).slice(0, 60);
    out.allowed = { women: robotsAllows(R, "/euro/en/women/clothing"), product: robotsAllows(R, "/euro/en/women/x-p00123456") }; }
  const sm = (rb.match(/sitemap:\s*(\S+)/i) || [])[1];
  if (sm) await look("sitemap", sm, ["application/xml", "text/xml", "text/plain"]);
  const cat = await look("category", H + "/euro/en/women/clothing", ["text/html"]);
  const purl = (cat.match(/href="(\/euro\/en\/women\/[^"]*-p\d{8}[^"]*)"/) || [])[1];
  if (purl) await look("product", H + purl, ["text/html"]);
  console.log("PROBE " + JSON.stringify(out).slice(0, 12000));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}
