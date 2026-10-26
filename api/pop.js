/**
 * Популярность товаров на витрине: просмотры карточки (+1), избранное (+3), корзина (+5).
 * Витрина присылает пачкой раз в ~20 с. Счётчики — в одном документе stats.pop (атомарное прибавление в Sanity).
 * Личных данных нет: только номера товаров.
 */
import { getStore } from "../lib/store.js";
export const popKey = id => String(id).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80);
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.statusCode = 405; return res.end("{}"); }
  let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } } b = b || {};
  const ids = (k, w) => [...new Set((Array.isArray(b[k]) ? b[k] : []).map(String).filter(i => /^product\.[a-z0-9.-]{3,80}$/i.test(i)))].slice(0, 30).map(i => [popKey(i), w]);
  const inc = {}; for (const [k, w] of [...ids("v", 1), ...ids("f", 3), ...ids("c", 5)]) inc[k] = (inc[k] || 0) + w;
  const keys = Object.keys(inc);
  if (keys.length) {
    try {
      const store = getStore();
      if (store.mutate) await store.mutate([{ createIfNotExists: { _id: "stats.pop", _type: "stats", scores: {} } },
        { patch: { id: "stats.pop", setIfMissing: { scores: {}, ...Object.fromEntries(keys.map(k => ["scores." + k, 0])) }, inc: Object.fromEntries(keys.map(k => ["scores." + k, inc[k]])) } }]);
      else { const d = (await store.get("stats.pop")) || { _id: "stats.pop", _type: "stats", scores: {} }; for (const k of keys) d.scores[k] = (d.scores[k] || 0) + inc[k]; await store.put(d); }
    } catch (e) { console.log("POP err " + String(e.message).slice(0, 120)); }
  }
  res.statusCode = 200; res.end(JSON.stringify({ ok: true }));
}
