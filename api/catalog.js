/** Публичный каталог для витрины: только опубликованные товары, без закупок и техданных. */
import { getStore } from "../lib/store.js";
import { toStorefront } from "../lib/catalog.js";

export default async function handler(req, res) {
  try {
    const store = getStore();
    const list = await store.list("product", { status: "published" }, { order: "publishedAt desc", limit: 5000 });
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
