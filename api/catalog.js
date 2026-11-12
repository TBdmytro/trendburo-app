/** Публичный каталог для витрины: только опубликованные товары, без закупок и техданных. */
import { getStore } from "../lib/store.js";
import { toStorefront } from "../lib/catalog.js";
import { publicContent } from "../lib/cms.js";
import { popKey } from "./pop.js";
import { userFrom } from "../lib/tgauth.js";
import { customerId } from "../lib/customers.js";
import { accessSettings, accessOf } from "../lib/access.js";
import { readSession } from "../lib/auth.js";
import { allow, tooMany } from "../lib/ratelimit.js";

/* Каталог собирается не чаще раза в 20 с на экземпляр сервера; одновременные запросы ждут одну сборку (база не получает толпу одинаковых запросов) */
const MEMO = [null, null];
const TTL = 3 * 60e3; // 3 минуты: правки видны чуть позже, зато база не собирает каталог по каждому заходу
export function _resetCatalogMemo() { MEMO[0] = MEMO[1] = null; CUST.clear(); }
// доступ клиента — из памяти на 2 минуты (без запроса к базе при каждом открытии приложения)
const CUST = new Map();
async function custCached(store, id) { const m = CUST.get(id); if (m && Date.now() - m.at < 120e3) return m.c; const c = await store.get(customerId(id)); if (CUST.size > 5000) CUST.clear(); if (c?.access === "ok") CUST.set(id, { c, at: Date.now() }); return c; } // помним только «пускаем» — одобренный только что попадает сразу
// готовый каталог хранится и в базе (сжатым): новый экземпляр сервера (после выкладки или простоя) отдаёт его сразу,
// а не собирает 23 000 товаров 10–15 с — раньше в это время сайт «висел» на заставке
let SAVED_AT = 0;
async function savedCatalog(store, k) { try { const d = await store.get("settings.catcache" + k); if (!d || !d.gz || Date.now() - Date.parse(d.at) > 12 * 3600e3) return null; const { gunzipSync } = await import("node:zlib"); return { body: gunzipSync(Buffer.from(d.gz, "base64")).toString("utf8"), at: Date.parse(d.at) }; } catch { return null; } }
async function saveCatalog(store, k, body) { if (Date.now() - SAVED_AT < 5 * 60e3) return; SAVED_AT = Date.now(); try { const { gzipSync } = await import("node:zlib"); await store.put({ _id: "settings.catcache" + k, _type: "settings", at: new Date().toISOString(), gz: gzipSync(Buffer.from(body)).toString("base64") }); } catch {} }
async function catalogBody(compact) {
  const k = compact ? 1 : 0; let m = MEMO[k];
  if (m && m.body && Date.now() - m.at < TTL) return m.body;
  if (!m) { const sv = await savedCatalog(getStore(), k); if (sv) { MEMO[k] = m = { body: sv.body, at: 0 }; } }
  if (m && m.wait) return m.body || m.wait; // сборка уже идёт — отдаём прежний каталог, не ждём
  const wait = (async () => {
    const store = getStore();
    // без потолка в 5000: товаров на витрине стало больше — новые бренды (Saint Laurent) не попадали в каталог
    const list = await store.list("product", { status: "published" }, { order: "publishedAt desc", limit: 30000,
      fields: "_id, brand, title, sourceTitle, category, subcategory, subFor, modelSku, colors, gender, images, variants, offers, pricing, overrides, status, publishedAt, stock, secPos, webSections, sourceUrl, kit" });
    const now = Date.now();
    const products = list.map(p => toStorefront(p, now, { compact })).filter(Boolean);
    // популярность у покупателей (просмотры, избранное, корзина) — витрина ставит такие товары выше
    try { const pop = (await store.get("stats.pop"))?.scores || {}; for (const x of products) { const v = pop[popKey(x.id)]; if (v > 0) x.pop = v; } } catch {}
    let content = null; try { content = await publicContent(store, new Date(now)); } catch { content = null; }
    // коллекции брендов (включённые в админке): товары — по разделу сайта бренда, где их брала кнопка
    let collections = []; try { const { activeCollections } = await import("../lib/collections.js"); const shown = new Set(products.map(x => x.id)); collections = activeCollections(await store.list("collection", {}, { limit: 500 }), list, { now: new Date(now) }).map(c => ({ ...c, ids: c.ids.filter(i => shown.has(i)) })).filter(c => c.ids.length).map(c => ({ ...c, n: c.ids.length })); } catch { collections = []; }
    return JSON.stringify({ products, content, collections, generatedAt: new Date(now).toISOString(), demo: !!store.demo });
  })();
  MEMO[k] = { ...(m || {}), wait };
  const done = wait.then(body => { MEMO[k] = { body, at: Date.now() }; saveCatalog(getStore(), k, body); return body; }, e => { MEMO[k] = m && m.body ? { body: m.body, at: m.at } : null; throw e; });
  if (m && m.body) { done.catch(() => {}); return m.body; } // есть прежний каталог — отдаём сразу, свежий соберётся в фоне
  try { const body = await done; return body; }
  catch (e) { MEMO[k] = m && m.body ? { body: m.body, at: m.at } : null; throw e; }
}

export default async function handler(req, res) {
  if (!allow(req, "cat", 60, 60000)) return tooMany(res); // защита от флуда с одного адреса
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
  // закрытый сайт: каталог только клиентам с открытым доступом (подпись Telegram в заголовке x-tb-auth)
  let closed = false;
  try {
    const store = getStore(), acc = await accessSettings(store);
    // закрытый сайт — всегда; открытый — только запросы со входом (чтобы заблокированный не видел каталог в своём кабинете)
    if (acc.closed || req.headers["x-tb-auth"]) {
      closed = true;
      let b = null; try { b = JSON.parse(decodeURIComponent(String(req.headers["x-tb-auth"] || ""))); } catch {}
      const u = b ? userFrom(b) : null, c = u ? await custCached(store, u.id) : null;
      // администратор (вход в админку в этом же браузере) видит витрину как клиент — для проверки
      let adm = null; try { adm = readSession(req); } catch {}
      if (!adm && accessOf(c, acc) !== "ok") { res.statusCode = 403; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); return res.end(JSON.stringify({ error: "Доступ по приглашению", code: "closed", access: c ? accessOf(c, acc) : "none" })); }
    }
  } catch (e) { console.error("catalog access:", e.message); res.statusCode = 503; res.setHeader("Cache-Control", "no-store"); return res.end(JSON.stringify({ error: "Недоступно" })); }
  const compact = /[?&]v=2\b/.test(String(req.url || ""));
  try {
    const body = await catalogBody(compact);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // кэш на CDN: свежий 30 с; дальше (до суток) отдаётся сразу из кэша, а обновление идёт в фоне — первый покупатель после простоя не ждёт сборку каталога
    res.setHeader("Cache-Control", closed ? "private, no-store" : "public, s-maxage=120, stale-while-revalidate=86400");
    if (closed) res.setHeader("Vary", "x-tb-auth");
    res.statusCode = 200;
    res.end(body);
  } catch (e) {
    const last = MEMO[compact ? 1 : 0];
    if (last && last.body) { res.statusCode = 200; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", closed ? "private, no-store" : "public, s-maxage=10"); return res.end(last.body); }
    res.statusCode = 503; res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Код причины без секретов — чтобы по ответу было видно, что чинить
    const m = String(e && e.message || "");
    const reason = /не настроена|не настроена|SANITY_PROJECT_ID/.test(m) ? "no-config"
      : /Sanity query (\d+)/.test(m) ? "sanity-" + m.match(/Sanity query (\d+)/)[1]
      : /fetch failed|ENOTFOUND|getaddrinfo/i.test(m) ? "sanity-unreachable" : "other";
    let adm = null; try { adm = readSession(req); } catch {}
    console.log("CATALOG fail " + m.replace(/postgres(ql)?:\/\/\S+/gi, "[db]").slice(0, 300));
    // администратору — текст ошибки (без адресов и ключей), чтобы сразу было видно, что чинить
    res.end(JSON.stringify({ products: [], error: "Каталог временно недоступен", reason, ...(adm ? { detail: m.replace(/postgres(ql)?:\/\/\S+/gi, "[db]").replace(/(key|token|secret|password)=\S+/gi, "$1=[…]").slice(0, 300) } : {}) }));
  }
}
