/** Публичный каталог для витрины: только опубликованные товары, без закупок и техданных. */
import { getStore } from "../lib/store.js";
import { toStorefront } from "../lib/catalog.js";
import { SOURCES, makeNet } from "../lib/sources.js";

export default async function handler(req, res) {
  // Временная проверка: пускают ли сайты брендов наш сервер (только код ответа главной страницы, кэш 10 минут)
  if (/[?&]probe=brands/.test(req.url || "")) {
    const out = {};
    await Promise.all(["louis-vuitton", "dior", "gucci"].map(async id => {
      const t0 = Date.now();
      try { const r = await makeNet().get(SOURCES[id], SOURCES[id].home); out[id] = { ok: true, status: r.status, ms: Date.now() - t0, bytes: r.text.length, productLinks: (r.text.match(new RegExp(SOURCES[id].productPattern.replace(/[/]/g, "\\/"), "g")) || []).length }; }
      catch (e) { out[id] = { ok: false, error: e.message, status: e.status || null, ms: Date.now() - t0 }; }
    }));
    res.statusCode = 200; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "public, s-maxage=600");
    return res.end(JSON.stringify(out));
  }
  try {
    const store = getStore();
    const list = await store.list("product", { status: "published" }, { order: "publishedAt desc", limit: 5000,
      fields: "_id, brand, title, sourceTitle, category, gender, images, variants, offers, pricing, overrides, status, publishedAt, stock" });
    const now = Date.now();
    const products = list.map(p => toStorefront(p, now)).filter(Boolean);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.statusCode = 200;
    res.end(JSON.stringify({ products, generatedAt: new Date(now).toISOString(), demo: !!store.demo }));
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
