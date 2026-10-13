/**
 * Разделы магазина поставщика (как на его сайте): «Бестселлеры», «Женское», «Мужское», «Аксессуары»…
 * После загрузки каталога сервер проходит выбранные разделы магазина и отмечает у товаров,
 * в каких разделах они стоят и на каком месте (sections / secPos) — в админке это вкладки с тем же порядком, что у бренда.
 * Названия полей постоянные (лимит полей базы): sections — список строк, secPos — [{ _key, s, p }].
 */
import { sourceWith, makeNet } from "./sources.js";
import { listCollections } from "./suppliers.js";

export const handleOf = url => { try { return new URL(url).pathname.split("/").filter(Boolean).pop().toLowerCase(); } catch { return null; } };

// вкладки по умолчанию: ищем в разделах магазина бестселлеры, женское, мужское, аксессуары, новинки
const PICK = [
  [/best.?sell/i, "Бестселлеры"],
  [/^(shop-)?(all-)?(women|womens|woman|ladies)(-all|-shop-all)?$/i, "Женское"],
  [/^(shop-)?(all-)?(men|mens|man)(-all|-shop-all)?$/i, "Мужское"],
  [/^(all-)?accessor(y|ies)$|^accessor/i, "Аксессуары"],
  [/^new(-arrivals?)?$|new-arrivals?/i, "Новинки"]
];
export function defaultTabs(collections) {
  const out = [];
  for (const [re, title] of PICK) {
    const c = collections.find(x => re.test(x.handle) && !out.some(o => o.h === x.handle));
    if (c) out.push({ h: c.handle, t: title });
  }
  return out;
}

/** Выбрать вкладки: заданные в «Разделах» или подобранные автоматически. */
export async function resolveTabs(store, sourceId, { fetchImpl = fetch } = {}) {
  const s = await store.get("source." + sourceId);
  const c = s?.custom; if (!c || sourceWith(s, sourceId).adapter !== "shopify") return [];
  if (c.collections?.length) return c.collections.map(h => ({ h, t: c.sectionTitles?.[c.collections.indexOf(h)] || h }));
  try { return defaultTabs((await listCollections(store, sourceId, { fetchImpl })).collections); } catch { return []; }
}

/**
 * Часть работы по раскладке (вызывается из шага загрузки). state: { tabs, ti, tpage, reset }.
 * Возвращает новое состояние; done — когда все вкладки пройдены.
 */
export async function sortStep(store, sourceId, state, { fetchImpl = fetch, left = () => true } = {}) {
  let { tabs = [], ti = 0, tpage = 1, reset = false } = state;
  if (!tabs.length) return { ...state, done: true };
  const settings = await store.get("source." + sourceId);
  const src = sourceWith(settings, sourceId);
  const net = makeNet({ fetchImpl });
  // товары этого поставщика: по адресу товара находим запись в базе
  const prods = (await store.list("product", {}, { limit: 50000, fields: "_id, sourceUrl, sections, secPos, offers[]{sourceId, url}" })).filter(p => (p.offers || []).some(o => o.sourceId === sourceId));
  const byHandle = new Map();
  for (const p of prods) for (const u of [p.sourceUrl, ...(p.offers || []).filter(o => o.sourceId === sourceId).map(o => o.url)]) { const h = handleOf(u); if (h && !byHandle.has(h)) byHandle.set(h, p); }
  // в начале раскладки старые отметки снимаем (товар мог уйти из раздела)
  if (!reset) {
    const dirty = prods.filter(p => p.sections?.length || p.secPos?.length);
    await store.patchEach(dirty.map(p => ({ id: p._id, set: { sections: [], secPos: [] } })));
    dirty.forEach(p => { p.sections = []; p.secPos = []; });
    reset = true;
  }
  const origin = src.home.replace(/\/$/, ""), mk = src.market || "";
  do {
    if (ti >= tabs.length) return { tabs, ti, tpage, reset, done: true };
    const h = tabs[ti].h;
    const r = await net.get(src, `${origin}${mk}/collections/${h}/products.json?limit=250&page=${tpage}`, { types: ["application/json"], maxBytes: 12_000_000 });
    const items = JSON.parse(r.text).products || [];
    const upd = new Map();
    items.forEach((it, i) => {
      const p = byHandle.get(String(it.handle || "").toLowerCase()); if (!p) return;
      if (!(p.sections || []).includes(h)) {
        p.sections = [...(p.sections || []), h];
        p.secPos = [...(p.secPos || []), { _key: h, s: h, p: (tpage - 1) * 250 + i }];
        upd.set(p._id, { sections: p.sections, secPos: p.secPos });
      }
    });
    await store.patchEach([...upd].map(([id, set]) => ({ id, set })));
    if (items.length === 250) tpage++; else { ti++; tpage = 1; }
  } while (left());
  return { tabs, ti, tpage, reset, done: ti >= tabs.length };
}
