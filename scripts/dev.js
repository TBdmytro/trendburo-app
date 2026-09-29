// Локальный запуск без Vercel: node scripts/dev.js  → http://localhost:3000
// Без SANITY_* переменных работает в ДЕМО-режиме (данные в памяти, не сохраняются).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

if (!process.env.SANITY_PROJECT_ID) process.env.DEMO_MODE = "1";
process.env.ADMIN_PASSWORD ||= "demo";
const root = new URL("..", import.meta.url).pathname;
const routes = { "/api/admin": "../api/admin.js", "/api/catalog": "../api/catalog.js", "/api/cron": "../api/cron.js" };
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
