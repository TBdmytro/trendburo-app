// Graff: помолвочное кольцо = одна модель, внутри (поле dia) — все камни, которые сайт Graff предлагает к покупке
// («Select your diamond»): карат, цвет, чистота, цена бутика. Размеры колец не берём — на сайте они не совпадают с бутиком.
// Камни группируем вниз до ступени: 0.55 → 0.5, 0.80 → 0.7, 1.01 и 1.33 → 1, 1.52 → 1.5, 2.01 → 2.
export const DIA_STEPS = [0.3, 0.4, 0.5, 0.7, 0.9, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
export const diaGroup = ct => { let g = null; for (const s of DIA_STEPS) if (ct + 1e-9 >= s) g = s; return g ?? Math.floor(ct * 10) / 10; };

// цвет: D–M (белые) или фантазийные жёлтые Graff — F.Y / F.I.Y / F.V.Y (Fancy / Intense / Vivid Yellow);
// у рубинов, сапфиров, изумрудов цвета и чистоты нет («null») — камень всё равно берём (карат + цена)
const COL = /^([D-M]|F(\.[A-Z]){1,3}|FANCY.*)$/i, CLA = /^(FL|IF|VVS[12]|VS[12]|SI[12]|I[123])$/i, NUL = v => !v || /^(null|undefined|-|n\/a)$/i.test(v);
// Graff местами путает подписи «Colour» и «Clarity» — разбираем по значению
export function normStone(x) {
  const ct = Math.round(Number(x && x.ct) * 100) / 100, p = Math.round(Number(x && x.p));
  let a = String(x && x.col || "").trim().toUpperCase(), b = String(x && x.cla || "").trim().toUpperCase();
  if (!COL.test(a) && COL.test(b)) [a, b] = [b, a];
  if (NUL(a) && NUL(b)) a = b = ""; // цветной камень без характеристик
  const id = String(x && x.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  if (!(ct > 0 && ct < 50) || !(p > 0 && p < 1e7) || !id || ((a || b) && (!COL.test(a) || !CLA.test(b)))) return null;
  return { id, ct, col: a, cla: b, p };
}

const cap = t => String(t || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/(^|[\s,(/-])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase()).replace(/ (And|With|Of) /g, w => w.toLowerCase());
/** d: {name, sub, mpn, sku, url, description, imgs[], st[], price, g} — то, что прочитано со страницы модели Graff.
 *  Помолвочное кольцо — со списком камней (st). Обручальное кольцо (band) — без камней, одна цена (price). */
export async function buildDiaProduct(store, d, { pricingCfg = null, by = "button", now = new Date().toISOString() } = {}) {
  const { saveManualProduct } = await import("./manual.js");
  const seen = new Set(), list = [];
  for (const x of Array.isArray(d.st) ? d.st : []) { const s = normStone(x); if (s && !seen.has(s.id)) { seen.add(s.id); list.push(s); } }
  const fixed = Math.round(Number(d.price) || 0);
  if (!list.length && !(fixed > 0)) throw new Error("Нет камней: откройте «Select your diamond» и нажмите ещё раз");
  list.sort((a, b) => a.p - b.p || a.ct - b.ct);
  const code = String(d.key || d.mpn || d.sku || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 30); // key — если у двух страниц один номер модели (разные металлы)
  if (!code) throw new Error("Нет кода модели");
  const id = "product.manual.graff-" + code, prev = await store.get(id), min = list.length ? list[0].p : fixed;
  const title = (String(d.name || "").trim() + (d.sub ? ", " + cap(d.sub) : "")).slice(0, 140);
  const g = /^(m|w|u)$/.test(d.g) ? d.g : "w";
  const sub2 = /^(rings|earrings|bracelets|necklaces|brooches)$/.test(d.cat2) ? d.cat2 : d.cat2 === "" ? null : "rings"; // по умолчанию — кольца (помолвочные/обручальные)
  const imgs = (Array.isArray(d.imgs) ? d.imgs : []).filter(u => /^https:\/\/www\.graff\.com\//.test(u)).map(u => String(u).split("?")[0] + "?sw=1600&sh=1600").slice(0, 8);
  if (!prev) await saveManualProduct(store, { id, brand: "Graff", title, category: "jewelry", subcategory: sub2, gender: g, boutique: min, currency: "EUR", images: imgs, description: d.description, url: d.url, sku: d.sku, status: "incoming", fromWeb: true, noStock: true }, { by, pricingCfg, now });
  else if (prev.offers?.[0] && prev.offers[0].boutique !== min) { // цена «от» = самый дешёвый камень сейчас
    const { computePricing } = await import("./publish.js");
    const p = { ...prev, offers: [{ ...prev.offers[0], boutique: min, checkedAt: now }, ...prev.offers.slice(1)] }; p.pricing = computePricing(p, pricingCfg);
    await store.patchEach([{ id, set: { offers: p.offers, pricing: p.pricing } }]);
  }
  if (prev && prev.status === "incoming" && prev.title !== title) await store.patchEach([{ id, set: { title } }]); // пока не опубликовано — название обновляем
  const groups = {}; for (const s of list) { const k = diaGroup(s.ct); groups[k] = (groups[k] || 0) + 1; }
  await store.patchEach([{ id, set: { dia: list.length ? { at: now, base: min, list } : null } }]);
  return { id, n: list.length, groups, created: !prev, price: min };
}
