// Sporty & Rich: детские вещи → «Детское»; обложка — фото самой вещи, а не модель в полный рост.
const PX = "product.manual.sportyandric";
export const srKid = d => /\bkids?\b|\btoddler/i.test(String(d.title || "")) || (d.sizes || d.variants || []).some(s => /\d+\s*\/\s*\d+\s*y(rs|ears)?\b|\d+\s*(yrs|years|y)\b/i.test(JSON.stringify(s)));
const fn = u => String(u || "").split("?")[0].split("/").pop();
export async function srFix(st, { apply = false, dump = false, cover = null } = {}) {
  const ids = (await st.list("product", {}, { limit: 60000, fields: "_id" })).filter(p => p._id.startsWith(PX)).map(p => p._id);
  const docs = await st.getMany(ids), patches = [], out = { n: docs.length, kids: [], cover: 0, ex: [] };
  for (const d of docs.filter(Boolean)) {
    const set = {};
    if (srKid(d) && (d.gender !== "k" || (d.overrides?.gender && d.overrides.gender !== "k"))) { set.gender = "k"; if (d.overrides?.gender) set.overrides = { ...d.overrides, gender: "k" }; out.kids.push(d.title); }
    const im = d.images || [];
    if (dump && out.ex.length < 40) out.ex.push({ t: d.title, im: im.map(i => fn(i.sourceUrl || i.url)) });
    if (cover && im.length > 1) { const i = cover(im.map(x => fn(x.sourceUrl || x.url)), d); if (i > 0) { set.images = [im[i], ...im.filter((_, k) => k !== i)]; out.cover++; } }
    if (Object.keys(set).length) patches.push({ id: d._id, set });
  }
  if (apply && patches.length) await st.patchEach(patches);
  return { apply, ...out, kidsN: out.kids.length, kids: out.kids.slice(0, 30) };
}

// список фото для проверки в браузере: [{id, u:[адреса]}]
const PXS = { sr: PX, rc: "product.manual.renecaovil", am: "product.manual.aminamuaddi" };
export async function srUrls(st, b = "sr") {
  const px = PXS[b] || PX, ids = (await st.list("product", {}, { limit: 60000, fields: "_id" })).filter(p => p._id.startsWith(px)).map(p => p._id);
  return (await st.getMany(ids)).filter(Boolean).map(d => ({ id: d._id, u: (d.images || []).map(i => i.sourceUrl || i.url) }));
}
// обложка по результату проверки: set = "id:индекс,id:индекс"
export async function srSetCover(st, set, { apply = false } = {}) {
  const M = new Map(String(set || "").split(",").map(x => x.split(":")).filter(x => x.length === 2).map(([a, b]) => [(a.startsWith("product.") ? "" : PX) + a, +b]));
  const docs = await st.getMany([...M.keys()]), patches = [];
  for (const d of docs.filter(Boolean)) { const i = M.get(d._id), im = d.images || []; if (i > 0 && i < im.length) patches.push({ id: d._id, set: { images: [im[i], ...im.filter((_, k) => k !== i)] } }); }
  if (apply && patches.length) await st.patchEach(patches);
  return { apply, asked: M.size, fix: patches.length };
}

// бренд целиком в один пол (Rene Caovilla, Amina Muaddi — женские)
export async function brandGender(st, b, g, { apply = false } = {}) {
  const px = PXS[b]; if (!px || !["w", "m", "k", "u"].includes(g)) return { err: "bad" };
  const ids = (await st.list("product", {}, { limit: 60000, fields: "_id" })).filter(p => p._id.startsWith(px)).map(p => p._id);
  const docs = (await st.getMany(ids)).filter(Boolean), patches = [];
  for (const d of docs) { const o = d.overrides || {}, set = {}; if (d.gender !== g) set.gender = g; if (o.gender && o.gender !== g) set.overrides = { ...o, gender: g }; if (Object.keys(set).length) patches.push({ id: d._id, set }); }
  if (apply && patches.length) await st.patchEach(patches);
  return { apply, n: docs.length, fix: patches.length };
}

// новые с сайтов: сколько и чьи (только чтение)
export async function incomingStat(st) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, status, brand" })).filter(p => p.status === "incoming"), M = {};
  for (const p of L) { const k = (p.brand || "?") + " · " + p._id.split("-")[0].split(".").slice(0, 3).join("."); M[k] = (M[k] || 0) + 1; }
  return { n: L.length, by: M };
}
export async function urlsByBrand(st, brand, status) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, status, brand" })).filter(p => String(p.brand || "").toLowerCase() === String(brand).toLowerCase() && (!status || p.status === status));
  return (await st.getMany(L.map(p => p._id))).filter(Boolean).map(d => ({ id: d._id, u: (d.images || []).map(i => i.sourceUrl || i.url) }));
}

// бренд-дубль (например «Amina Muaddi France») → основной бренд; дубли вещей по названию — показать
export async function brandMerge(st, from, to, { apply = false } = {}) {
  const L = await st.list("product", {}, { limit: 60000, fields: "_id, brand, title, status, overrides" });
  const lc = v => String(v || "").trim().toLowerCase(), bOf = p => p.overrides?.brand || p.brand;
  const src = L.filter(p => lc(bOf(p)) === lc(from) || lc(p.brand) === lc(from)), dst = L.filter(p => lc(bOf(p)) === lc(to));
  const out = src.map(p => ({ id: p._id, title: p.title, status: p.status, same: dst.filter(d => lc(d.title) === lc(p.title)).map(d => d._id + " " + d.status) }));
  if (apply) for (const p of src) { const set = { brand: to }; if (p.overrides?.brand) set.overrides = { ...p.overrides, brand: to }; await st.patchEach([{ id: p._id, set }]); }
  return { apply, n: src.length, items: out };
}

export async function brandList(st, q) {
  const L = await st.list("product", {}, { limit: 60000, fields: "_id, brand, overrides, status" }), M = {};
  for (const p of L) for (const b of new Set([p.brand, p.overrides?.brand].filter(Boolean))) if (String(b).toLowerCase().includes(String(q).toLowerCase())) { const k = JSON.stringify(b) + " " + p.status; M[k] = (M[k] || 0) + 1; }
  return M;
}

// пересчёт цен бренда (все статусы) по текущим правилам; ex — что меняется
export async function brandReprice(st, brand, { apply = false, onlyRule = "" } = {}) {
  const { computePricing } = await import("./publish.js"), { pricingConfig } = await import("./reprice.js"), cfg = await pricingConfig(st);
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, status, brand, title, category, subcategory, subFor, overrides, offers, pricing, sourceUrl, materials, description" })).filter(p => String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase());
  const patches = [], ex = [], byRule = {};
  for (const p of L) { const n = computePricing(p, cfg); if (onlyRule && !String(n.rule || "").includes(onlyRule)) continue; byRule[n.rule] = (byRule[n.rule] || 0) + 1;
    if (n.ua != null && (n.ua !== p.pricing?.ua || n.eu !== p.pricing?.eu)) { patches.push({ id: p._id, set: { pricing: { ...(p.pricing || {}), ...n } } }); if (ex.length < 40) ex.push({ id: p._id, st: p.status, t: String(p.overrides?.title || p.title).slice(0, 50), b: n.boutique, before: p.pricing?.ua, after: n.ua, rule: n.rule }); } }
  if (apply && patches.length) await st.patchEach(patches);
  return { apply, n: L.length, change: patches.length, byRule, ex };
}

// Sporty & Rich: новые (incoming) против того, что уже есть (по адресу товара и по названию)
export async function srDup(st) {
  const L = await st.list("product", {}, { limit: 60000, fields: "_id, status, brand, title, sourceUrl, gender, overrides, category" });
  const sr = L.filter(p => /sporty/i.test(String(p.overrides?.brand || p.brand || "")));
  const h = u => (String(u || "").match(/\/products\/([^/?#]+)/) || [])[1] || "", t = p => String(p.overrides?.title || p.title || "").toLowerCase().replace(/\s+/g, " ").trim();
  const inc = sr.filter(p => p.status === "incoming"), pub = sr.filter(p => p.status === "published"), dr = sr.filter(p => p.status === "draft");
  const byH = new Map(), byT = new Map(); for (const p of [...pub, ...dr]) { if (h(p.sourceUrl)) byH.set(h(p.sourceUrl), p); byT.set(t(p), p); }
  const out = { incoming: inc.length, published: pub.length, draft: dr.length, onSite: [], hidden: [], fresh: [], incDupSelf: [], kids: { inc: 0, pub: 0, pubNotK: [] } };
  const seen = new Map();
  for (const p of inc) { const m = byH.get(h(p.sourceUrl)) || byT.get(t(p)); const k = h(p.sourceUrl) || t(p); if (seen.has(k)) out.incDupSelf.push(p._id); seen.set(k, p._id);
    if (m && m.status === "published") out.onSite.push(p._id + " = " + m._id); else if (m) out.hidden.push(p._id); else out.fresh.push(p._id + " | " + p.title); }
  const kid = p => /\bkids?\b|toddler/i.test(String(p.title || ""));
  for (const p of sr) if (kid(p)) { if (p.status === "incoming") out.kids.inc++; if (p.status === "published") { out.kids.pub++; if ((p.overrides?.gender || p.gender) !== "k") out.kids.pubNotK.push(p._id); } }
  const pubNotOnBrand = pub.filter(p => !inc.some(i => (h(i.sourceUrl) && h(i.sourceUrl) === h(p.sourceUrl)) || t(i) === t(p)));
  return { ...out, onSiteN: out.onSite.length, hiddenN: out.hidden.length, freshN: out.fresh.length, pubNotInNewN: pubNotOnBrand.length, pubNotInNew: pubNotOnBrand.slice(0, 40).map(p => p._id + " | " + p.title), onSite: out.onSite.slice(0, 10), fresh: out.fresh };
}
