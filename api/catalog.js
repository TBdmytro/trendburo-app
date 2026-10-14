/** Публичный каталог для витрины: только опубликованные товары, без закупок и техданных. */
import { getStore } from "../lib/store.js";
import { toStorefront } from "../lib/catalog.js";
import { publicContent } from "../lib/cms.js";

export default async function handler(req, res) {
  // Личный раздел «Мониторинг»: плитки отдаются только по коду владельца
  const wm = String(req.url || "").match(/[?&]watch=(\d{6})/);
  if (wm) {
    try {
      const w = await getStore().get("settings.watch");
      res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
      if (!w || w.code !== wm[1]) { await new Promise(r => setTimeout(r, 800)); res.statusCode = 404; return res.end(JSON.stringify({ error: "Неверный код" })); }
      res.statusCode = 200; return res.end(JSON.stringify({ tiles: w.tiles || [] }));
    } catch (e) { res.statusCode = 503; return res.end(JSON.stringify({ error: "Недоступно" })); }
  }
  try {
    const store = getStore();
    const list = await store.list("product", { status: "published" }, { order: "publishedAt desc", limit: 5000,
      fields: "_id, brand, title, sourceTitle, category, gender, images, variants, offers, pricing, overrides, status, publishedAt, stock, secPos" });
    const now = Date.now();
    const compact = /[?&]v=2\b/.test(String(req.url || ""));
    const products = list.map(p => toStorefront(p, now, { compact })).filter(Boolean);
    let content = null; try { content = await publicContent(store, new Date(now)); } catch { content = null; }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // кэш на CDN: свежий 30 с, дальше отдаётся сразу из кэша, а обновление идёт в фоне (без ожидания базы)
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=600");
    res.statusCode = 200;
    res.end(JSON.stringify({ products, content, generatedAt: new Date(now).toISOString(), demo: !!store.demo }));
  } catch (e) {
    res.statusCode = 503; res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Код причины без секретов — чтобы по ответу было видно, что чинить
    const m = String(e && e.message || "");
    const reason = /не настроена|не настроена|SANITY_PROJECT_ID/.test(m) ? "no-config"
      : /Sanity query (\d+)/.test(m) ? "sanity-" + m.match(/Sanity query (\d+)/)[1]
      : /fetch failed|ENOTFOUND|getaddrinfo/i.test(m) ? "sanity-unreachable" : "other";
    res.end(JSON.stringify({ products: [], error: "Каталог временно недоступен", reason }));
  }
}
