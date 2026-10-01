// Локальный запуск без Vercel: node scripts/dev.js  → http://localhost:3000
// Без SANITY_* переменных работает в ДЕМО-режиме (данные в памяти, не сохраняются).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

if (!process.env.SANITY_PROJECT_ID) process.env.DEMO_MODE = "1";
process.env.ADMIN_PASSWORD ||= "demo";
const root = new URL("..", import.meta.url).pathname;
// ТЕСТОВЫЙ РЕЖИМ (только локально, FAKE_SHOP=1): магазин shop.test на Shopify с 40 товарами в долларах — для проверки админки без интернета
if (process.env.FAKE_SHOP === "1") {
  process.env.GEMINI_API_KEY ||= "fake-local-key";
  const { setDnsCheck } = await import("../lib/http.js"); setDnsCheck(false);
  const real = globalThis.fetch;
  const brands = ["Kith", "Fear of God", "The Row", "Amiri"], types = ["Hoodies", "Bags", "Sneakers", "Jackets"];
  const all = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, title: `${types[i % 4].replace(/s$/, "")} ${i + 1}`, handle: `item-${i + 1}`, vendor: brands[i % 4], product_type: types[i % 4], tags: [i % 3 ? "Mens" : "Womens"],
    options: [{ name: "Size" }], images: [1, 2, 3].map(k => ({ id: i * 10 + k, src: `https://cdn.shopify.com/fake/${i + 1}-${k}.jpg` })),
    variants: [{ sku: `S${i}-1`, option1: "S", price: String(150 + i * 25), available: i % 7 !== 0 }, { sku: `S${i}-2`, option1: "M", price: String(150 + i * 25), available: true }] }));
  const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.hostname.endsWith("shop.test")) {
      if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /cart", { headers: { "content-type": "text/plain" } });
      if (u.pathname === "/meta.json") return json({ name: "Test Shop", currency: "USD" });
      if (u.pathname === "/products.json") { const lim = +u.searchParams.get("limit") || 30, pg = +u.searchParams.get("page") || 1; return json({ products: all.slice((pg - 1) * lim, pg * lim) }); }
      return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
    }
    if (u.hostname === "generativelanguage.googleapis.com") {
      // имитация Gemini: по размеру картинки выдаём один из трёх товаров
      const body = JSON.parse(o.body); const n = body.contents[0].parts[0].inline_data.data.length % 3;
      const r = [{ isProduct: true, brand: "Louis Vuitton", title: "Keepall Bandoulière 50", price: 2600, currency: "EUR", color: "Monogram", sizes: [], sku: "M41416", category: "bags", gender: "m", box: [120, 60, 620, 940] },
        { isProduct: true, brand: "Louis Vuitton", title: "Keepall Bandoulière 50", price: 2600, currency: "EUR", color: "Monogram", sizes: [], sku: "M41416", category: "bags", gender: "m", box: [100, 40, 640, 960] },
        { isProduct: true, brand: "Kith", title: "Williams III Hoodie", price: 185, currency: "USD", color: "Black", sizes: ["S", "M", "L"], sku: "", category: "clothing", gender: "m", box: [80, 100, 560, 900] }][n];
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(r) }] } }] });
    }
    if (u.hostname.endsWith("ecb.europa.eu")) return new Response("<Cube currency='USD' rate='1.1700'/><Cube currency='GBP' rate='0.8600'/>", { headers: { "content-type": "text/xml" } });
    return real(url, o);
  };
}
const routes = { "/api/admin": "../api/admin.js", "/api/catalog": "../api/catalog.js", "/api/cron": "../api/cron.js", "/api/lead": "../api/lead.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (routes[u.pathname]) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    req.query = Object.fromEntries(u.searchParams);
    req.body = raw && /json/.test(req.headers["content-type"] || "") ? JSON.parse(raw) : raw;
    const mod = await import(new URL(routes[u.pathname], import.meta.url));
    return mod.default(req, res);
  }
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  try { const b = await readFile(join(root, file)); res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream"); res.end(b); }
  catch { res.statusCode = 404; res.end("not found"); }
}).listen(process.env.PORT || 3000, () => console.log("Trend Büro: http://localhost:" + (process.env.PORT || 3000) + "  (админка: /admin.html, пароль: " + (process.env.ADMIN_PASSWORD === "demo" ? "demo" : "из ADMIN_PASSWORD") + ")"));
