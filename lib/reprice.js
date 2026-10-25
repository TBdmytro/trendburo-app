/**
 * Пересчёт цен уже загруженных товаров по текущим правилам — быстро (точечные правки пачками) и частями по времени.
 * Автоматически — только скрытые товары (их клиенты не видят). Товары на витрине пересчитываются
 * только после того, как администратор посмотрел предпросмотр и нажал «Сохранить правила».
 */
import { computePricing } from "./publish.js";
import { mergeConfig } from "./pricing.js";

// номер версии правил цен в коде; растёт, когда меняется сама формула (тогда скрытые товары пересчитываются сами)
export const PRICE_VER = 6; // 6: у товаров с кнопки +10% учитывается минимальная наценка по категории

export async function pricingConfig(store) { return mergeConfig((await store.get("settings.pricing"))?.config || null); }

export async function repriceAll(store, cfg, { onlyDrafts = false, budgetMs = 40000, cursor = "" } = {}) {
  const t0 = Date.now();
  const all = await store.list("product", {}, { limit: 50000, order: "_id asc", fields: "_id, status, brand, title, category, overrides, offers, pricing, sourceUrl, _updatedAt" });
  const todo = all.filter(p => p._id > cursor && (!onlyDrafts || p.status !== "published"));
  const stats = { checked: 0, changed: 0, examples: [], empty: 0, emptySample: [] };
  let i = 0;
  while (i < todo.length && Date.now() - t0 < budgetMs) {
    const chunk = todo.slice(i, i + 200), patches = [];
    for (const p of chunk) {
      const next = computePricing(p, cfg);
      stats.checked++;
      // запись без предложений/цены бутика — считать нечего (для разбора пишем в журнал несколько примеров)
      if (next.ua == null && p.pricing?.ua == null) { stats.empty++; if (stats.emptySample.length < 5) stats.emptySample.push({ id: p._id, title: p.title ?? null, offers: (p.offers || []).length, url: p.sourceUrl || null, at: p._updatedAt }); continue; }
      const same = k => (next[k] ?? null) === (p.pricing?.[k] ?? null);
      if (!same("ua") || !same("eu") || !same("dxb")) {
        patches.push({ id: p._id, set: { pricing: { ...(p.pricing || {}), ...next } } });
        stats.changed++;
        if (stats.examples.length < 8) stats.examples.push({ title: p.overrides?.title || p.title, cat: p.overrides?.category || p.category, boutique: next.boutique, before: p.pricing?.ua ?? null, after: next.ua });
      }
    }
    await store.patchEach(patches);
    i += chunk.length;
    cursor = chunk[chunk.length - 1]._id;
  }
  return { done: i >= todo.length, cursor, ...stats };
}

/** Если формула в коде новее, чем пересчитанные цены, — пересчитать скрытые товары (частями). */
export async function ensurePrices(store, { budgetMs = 20000, log = () => {} } = {}) {
  const st = (await store.get("settings.priceVer")) || { _id: "settings.priceVer", _type: "settings", v: 0, cursor: "" };
  if (st.v >= PRICE_VER) return { done: true };
  const r = await repriceAll(store, await pricingConfig(store), { onlyDrafts: true, budgetMs, cursor: st.cursor || "" });
  log({ reprice: { done: r.done, checked: r.checked, changed: r.changed, examples: r.examples } });
  await store.put({ _id: st._id, _type: "settings", v: r.done ? PRICE_VER : st.v, cursor: r.done ? "" : r.cursor, at: new Date().toISOString(), lastChanged: r.changed });
  return r;
}
