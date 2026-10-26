/** Публичный каталог для витрины: только опубликованные товары, без закупок и техданных. */
import { getStore } from "../lib/store.js";
import { toStorefront } from "../lib/catalog.js";
import { publicContent } from "../lib/cms.js";

/* Каталог собирается не чаще раза в 20 с на экземпляр сервера; одновременные запросы ждут одну сборку (база не получает толпу одинаковых запросов) */
const MEMO = [null, null];
const TTL = 20000;
export function _resetCatalogMemo() { MEMO[0] = MEMO[1] = null; }
async function catalogBody(compact) {
  const k = compact ? 1 : 0, m = MEMO[k];
  if (m && m.body && Date.now() - m.at < TTL) return m.body;
  if (m && m.wait) return m.wait;
  const wait = (async () => {
    const store = getStore();
    // без потолка в 5000: товаров на витрине стало больше — новые бренды (Saint Laurent) не попадали в каталог
    const list = await store.list("product", { status: "published" }, { order: "publishedAt desc", limit: 30000,
      fields: "_id, brand, title, sourceTitle, category, gender, images, variants, offers, pricing, overrides, status, publishedAt, stock, secPos" });
    const now = Date.now();
    const products = list.map(p => toStorefront(p, now, { compact })).filter(Boolean);
    let content = null; try { content = await publicContent(store, new Date(now)); } catch { content = null; }
    return JSON.stringify({ products, content, generatedAt: new Date(now).toISOString(), demo: !!store.demo });
  })();
  MEMO[k] = { ...(m || {}), wait };
  try { const body = await wait; MEMO[k] = { body, at: Date.now() }; return body; }
  catch (e) { MEMO[k] = m && m.body ? { body: m.body, at: m.at } : null; throw e; }
}

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
  const compact = /[?&]v=2\b/.test(String(req.url || ""));
  try {
    const body = await catalogBody(compact);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // кэш на CDN: свежий 30 с; дальше (до суток) отдаётся сразу из кэша, а обновление идёт в фоне — первый покупатель после простоя не ждёт сборку каталога
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=86400");
    res.statusCode = 200;
    res.end(body);
  } catch (e) {
    const last = MEMO[compact ? 1 : 0];
    if (last && last.body) { res.statusCode = 200; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "public, s-maxage=10"); return res.end(last.body); }
    res.statusCode = 503; res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Код причины без секретов — чтобы по ответу было видно, что чинить
    const m = String(e && e.message || "");
    const reason = /не настроена|не настроена|SANITY_PROJECT_ID/.test(m) ? "no-config"
      : /Sanity query (\d+)/.test(m) ? "sanity-" + m.match(/Sanity query (\d+)/)[1]
      : /fetch failed|ENOTFOUND|getaddrinfo/i.test(m) ? "sanity-unreachable" : "other";
    res.end(JSON.stringify({ products: [], error: "Каталог временно недоступен", reason }));
  }
}
