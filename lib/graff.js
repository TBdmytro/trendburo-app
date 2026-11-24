// Graff: помолвочное кольцо = одна модель, внутри (поле dia) — все камни, которые сайт Graff предлагает к покупке
// («Select your diamond»): карат, цвет, чистота, цена бутика. Размеры колец не берём — на сайте они не совпадают с бутиком.
// Камни группируем вниз до ступени: 0.55 → 0.5, 0.80 → 0.7, 1.01 и 1.33 → 1, 1.52 → 1.5, 2.01 → 2.
export const DIA_STEPS = [0.3, 0.4, 0.5, 0.7, 0.9, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
export const diaGroup = ct => { let g = null; for (const s of DIA_STEPS) if (ct + 1e-9 >= s) g = s; return g ?? Math.floor(ct * 10) / 10; };

const COL = /^([D-M]|FANCY.*)$/i, CLA = /^(FL|IF|VVS[12]|VS[12]|SI[12]|I[123])$/i;
// Graff местами путает подписи «Colour» и «Clarity» — разбираем по значению
export function normStone(x) {
  const ct = Math.round(Number(x && x.ct) * 100) / 100, p = Math.round(Number(x && x.p));
  let a = String(x && x.col || "").trim().toUpperCase(), b = String(x && x.cla || "").trim().toUpperCase();
  if (!COL.test(a) && COL.test(b)) [a, b] = [b, a];
  const id = String(x && x.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  if (!(ct > 0 && ct < 50) || !(p > 0 && p < 1e7) || !COL.test(a) || !CLA.test(b) || !id) return null;
  return { id, ct, col: a, cla: b, p };
}

/** d: {name, mpn, sku, url, description, imgs[], st[]} — то, что прочитано с открытой страницы модели Graff */
export async function buildDiaProduct(store, d, { pricingCfg = null, by = "button", now = new Date().toISOString() } = {}) {
  const { saveManualProduct } = await import("./manual.js");
  const seen = new Set(), list = [];
  for (const x of Array.isArray(d.st) ? d.st : []) { const s = normStone(x); if (s && !seen.has(s.id)) { seen.add(s.id); list.push(s); } }
  if (!list.length) throw new Error("Нет камней: откройте «Select your diamond» и нажмите ещё раз");
  list.sort((a, b) => a.p - b.p || a.ct - b.ct);
  const code = String(d.mpn || d.sku || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 30);
  if (!code) throw new Error("Нет кода модели");
  const id = "product.manual.graff-" + code, prev = await store.get(id), min = list[0].p;
  const imgs = (Array.isArray(d.imgs) ? d.imgs : []).filter(u => /^https:\/\/www\.graff\.com\//.test(u)).map(u => String(u).split("?")[0] + "?sw=1600&sh=1600").slice(0, 8);
  if (!prev) await saveManualProduct(store, { id, brand: "Graff", title: String(d.name || "").slice(0, 120), category: "jewelry", subcategory: "rings", gender: "w", boutique: min, currency: "EUR", images: imgs, description: d.description, url: d.url, sku: d.sku, status: "incoming", fromWeb: true, noStock: true }, { by, pricingCfg, now });
  else if (prev.offers?.[0] && prev.offers[0].boutique !== min) { // цена «от» = самый дешёвый камень сейчас
    const { computePricing } = await import("./publish.js");
    const p = { ...prev, offers: [{ ...prev.offers[0], boutique: min, checkedAt: now }, ...prev.offers.slice(1)] }; p.pricing = computePricing(p, pricingCfg);
    await store.patchEach([{ id, set: { offers: p.offers, pricing: p.pricing } }]);
  }
  const groups = {}; for (const s of list) { const g = diaGroup(s.ct); groups[g] = (groups[g] || 0) + 1; }
  await store.patchEach([{ id, set: { dia: { at: now, base: min, list } } }]);
  return { id, n: list.length, groups, created: !prev };
}
