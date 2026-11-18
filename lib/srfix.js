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
const PXS = { sr: PX, rc: "product.manual.renecaovil", am: "product.manual.aminamuaddi", ls: "product.manual.lesilla" };
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

// детские вещи бренда (Kids в названии или размеры «2/4yrs») → «Детское», все статусы
export async function kidsFix(st, brand, { apply = false } = {}) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, overrides" })).filter(p => String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase());
  const docs = (await st.getMany(L.map(p => p._id))).filter(Boolean), patches = [];
  for (const d of docs) if (srKid(d)) { const o = d.overrides || {}, set = {}; if (d.gender !== "k") set.gender = "k"; if (o.gender && o.gender !== "k") set.overrides = { ...o, gender: "k" }; if (Object.keys(set).length) patches.push({ id: d._id, set, t: d.title, st: d.status }); }
  if (apply && patches.length) await st.patchEach(patches.map(({ id, set }) => ({ id, set })));
  return { apply, n: docs.length, fix: patches.length, ex: patches.slice(0, 40).map(p => p.st + " | " + p.t) };
}

export async function incList(st, brand) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => p.status === "incoming" && String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase());
  const docs = (await st.getMany(L.map(p => p._id))).filter(Boolean);
  const okSz = d => (d.variants || []).filter(v => v.available !== false && v.ok !== false).length;
  return { n: docs.length, noPrice: docs.filter(d => !(d.pricing?.ua > 0)).length, noSizes: docs.filter(d => !okSz(d)).length, cats: docs.reduce((a, d) => (a[d.category] = (a[d.category] || 0) + 1, a), {}),
    ex: docs.slice(0, 60).map(d => `${d.title} | ${d.pricing?.ua || "-"} € | sz ${okSz(d)}/${(d.variants || []).length} | ${d.category}`) };
}

const POZ = n => n + (n % 10 === 1 && n % 100 !== 11 ? " позиція" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? " позиції" : " позицій");
// опубликовать скрытые (incoming) бренда — только с ценой
export async function pubBrand(st, brand, { apply = false } = {}) {
  const { setStatus } = await import("./publish.js");
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides, pricing" })).filter(p => p.status === "incoming" && String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase());
  const ok = L.filter(p => p.pricing?.ua > 0).map(p => p._id);
  if (apply && ok.length) await setStatus(st, ok, "published", "Claude (по слову владельца)");
  return { apply, incoming: L.length, publish: ok.length };
}
// «Що додано нового»: строка про бренд (число — опубликованные позиции бренда); старые строки сохраняются, всего до 5
export async function wnAdd(st, brand, text, { apply = false, from = "", until = "" } = {}) {
  const { cleanSite } = await import("./cms.js");
  const n = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => p.status === "published" && String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase()).length;
  const cur = (await st.get("settings.site")) || {}, w = cur.whatsnew || { on: true, items: [] };
  const item = { t: brand, s: String(text || "").replace("{n}", POZ(n)), b: brand };
  const items = [item, ...(w.items || []).filter(i => i.t !== brand)].slice(0, 5);
  const wn = { ...w, on: true, from: from || w.from, until: until || w.until, items };
  if (apply) await st.put({ ...cur, _id: "settings.site", _type: "settings", whatsnew: cleanSite({ ...cur, whatsnew: wn }).whatsnew });
  return { apply, wn };
}

export const SR_JUNK = /(iphone|phone case|\bcase\b|keychain|key ?ring|gift bag|yoga block|cork|resistance band|jump rope|bottle|candle|hand cream|cleanser|body oil|\bbalm\b|face mist|beauty kit|\bpouch\b|wellness book|\bbook\b|lip |serum|deodorant|perfume|fragrance)/i;
// план по Sporty & Rich: пары новая ↔ старая, старые без пары, мусор
export async function srPlan(st) {
  const L = await st.list("product", {}, { limit: 60000, fields: "_id, status, brand, title, sourceUrl, overrides" });
  const sr = L.filter(p => /sporty/i.test(String(p.overrides?.brand || p.brand || "")));
  const h = u => (String(u || "").match(/\/products\/([^/?#]+)/) || [])[1] || "", t = p => String(p.overrides?.title || p.title || "").toLowerCase().replace(/\s+/g, " ").trim();
  const inc = sr.filter(p => p.status === "incoming"), old = sr.filter(p => p.status !== "incoming");
  const byH = new Map(), byT = new Map(); for (const p of old) { if (h(p.sourceUrl)) byH.set(h(p.sourceUrl), p); if (!byT.has(t(p))) byT.set(t(p), p); }
  const pairs = [], fresh = [], used = new Set();
  for (const p of inc) { const m = byH.get(h(p.sourceUrl)) || byT.get(t(p)); if (m) { pairs.push([p._id, m._id, m.status, h(p.sourceUrl), SR_JUNK.test(p.title) ? 1 : 0]); used.add(m._id); } else fresh.push([p._id, h(p.sourceUrl), p.title, SR_JUNK.test(p.title) ? 1 : 0]); }
  const lone = old.filter(p => !used.has(p._id)).map(p => [p._id, p.status, h(p.sourceUrl), p.title, SR_JUNK.test(p.title) ? 1 : 0]);
  return { pairs, fresh, lone };
}
// действие над списком: pub | hide | del (по слову владельца)
export async function srAct(st, act, ids, { apply = false } = {}) {
  ids = String(ids || "").split(",").map(x => x.trim()).filter(x => /^product\.[a-z0-9._-]+$/.test(x)).slice(0, 60);
  if (!apply) return { apply, act, n: ids.length };
  if (act === "pub" || act === "hide") { const { setStatus } = await import("./publish.js"); await setStatus(st, ids, act === "pub" ? "published" : "draft", "Claude (по слову владельца)"); }
  else if (act === "del") { const linked = await st.list("importItem", { publishedAs: ids }, { limit: 20000, fields: "_id" }).catch(() => []); if (linked.length) await st.patchMany(linked.map(i => i._id), { publishedAs: null, publishedAt: null });
    await st.delMany(ids); try { const { rememberDeleted } = await import("./catalogload.js"); await rememberDeleted(st, ids); } catch {} }
  return { apply, act, n: ids.length };
}

export async function brandSample(st, brand, n = 12) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => p.status === "published" && String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase());
  const docs = (await st.getMany(L.slice(0, 400).map(p => p._id))).filter(Boolean);
  const pick = docs.filter((_, i) => i % Math.max(1, Math.floor(docs.length / n)) === 0).slice(0, n);
  const rules = {}; docs.forEach(d => { const r = d.pricing?.rule || "?"; rules[r] = (rules[r] || 0) + 1; });
  const cur = {}; docs.forEach(d => (d.offers || []).forEach(o => { const k = (o.currency || "?") + " " + (o.region || "?") + " " + (o.sourceKind || "?") + " " + String(o.url || d.sourceUrl || "").split("/")[2]; cur[k] = (cur[k] || 0) + 1; }));
  return { n: docs.length, rules, cur, ex: pick.map(d => ({ t: d.title, cat: d.category, boutique: d.pricing?.boutique, ua: d.pricing?.ua, rule: d.pricing?.rule, steps: d.pricing?.steps, flat: (d.offers || [])[0]?.flatMarkup, url: d.sourceUrl })) };
}

// размеры Sporty & Rich (опубликованные + на рассмотрении): адрес товара, наличие по размерам (из предложения), дата проверки
export async function srSizes(st) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => ["published", "incoming"].includes(p.status) && /sporty/i.test(String(p.overrides?.brand || p.brand || "")));
  const docs = (await st.getMany(L.map(p => p._id))).filter(Boolean);
  return docs.map(d => { const o = (d.offers || []).find(x => /sportyandrich\.com/.test(String(x.url || ""))) || (d.offers || [])[0] || {};
    return { id: d._id, st: d.status, h: (String(d.sourceUrl || o.url || "").match(/\/products\/([^/?#]+)/) || [])[1] || "", at: o.checkedAt || null, v: (d.variants || []).map(v => [v.size || "", (o.availability || {})[v._key]?.status || "-"]) }; });
}
// наличие с сайта бренда: list = id|размеры в наличии через запятую ; …  (остальные размеры → out); дата проверки — сейчас
export async function srSetAvail(st, list, { apply = false } = {}) {
  const now = new Date().toISOString(), out = [];
  for (const row of String(list || "").split(";").filter(Boolean)) { const [id, ons] = row.split("|"); const on = new Set(String(ons || "").split(",").map(decodeURIComponent).filter(Boolean));
    const d = await st.get(id); if (!d) continue; let changed = 0;
    const offers = (d.offers || []).map((o, i) => { if (i && !/sportyandrich\.com/.test(String(o.url || ""))) return o; const av = { ...(o.availability || {}) };
      for (const v of d.variants || []) { const nst = on.has(String(v.size || "")) || (!v.size && on.has("*")) ? "online" : "out"; if (av[v._key]?.status !== nst) changed++; av[v._key] = { ...(av[v._key] || {}), status: nst }; }
      return { ...o, availability: av, checkedAt: now }; });
    out.push({ id, on: [...on], changed }); if (apply) await st.patchEach([{ id, set: { offers } }]); }
  return { apply, n: out.length, changed: out.filter(x => x.changed).length, ex: out.filter(x => x.changed).slice(0, 5) };
}

// категория по названию для бренда (например, кроссовки Adidas × Sporty & Rich попали в «другое»)
export async function brandSetCat(st, brand, re, cat, { apply = false, from = "" } = {}) {
  const R = new RegExp(re, "i");
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, title, category, overrides" })).filter(p => String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase() && R.test(String(p.overrides?.title || p.title || "")) && p.category !== cat && (!from || p.category === from));
  if (apply && L.length) await st.patchEach(L.map(p => ({ id: p._id, set: { category: cat, subcategory: null, subFor: cat } })));
  return { apply, n: L.length, ex: L.slice(0, 30).map(p => p.category + " | " + p.title) };
}

// размеры любого бренда (по имени бренда; статусы published+incoming): адрес, наличие по размерам, дата проверки
export async function sizesByBrand(st, brand) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => ["published", "incoming"].includes(p.status) && String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase());
  const docs = (await st.getMany(L.map(p => p._id))).filter(Boolean);
  return docs.map(d => { const o = (d.offers || [])[0] || {};
    return { id: d._id, st: d.status, h: (String(d.sourceUrl || o.url || "").match(/\/products\/([^/?#]+)/) || [])[1] || "", at: o.checkedAt || null, v: (d.variants || []).map(v => [v.size || "", (o.availability || {})[v._key]?.status || "-"]) }; });
}

// убрать уменьшенные копии фото Shopify (…_grande.jpg рядом с оригиналом) у бренда
export async function dropSmallCopies(st, brand, { apply = false } = {}) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, overrides" })).filter(p => String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase());
  const docs = (await st.getMany(L.map(p => p._id))).filter(Boolean), patches = [];
  const nm = i => String(i.sourceUrl || i.url || "").split("?")[0].split("/").pop(), SM = /_(grande|large|medium|small|compact|thumb|\d+x\d*|\d*x\d+)(?=\.[a-z]+$)/i;
  for (const d of docs) { const im = d.images || [], names = new Set(im.map(nm)); const keep = im.filter(i => { const n = nm(i); return !(SM.test(n) && names.has(n.replace(SM, ""))); }); if (keep.length && keep.length < im.length) patches.push({ id: d._id, set: { images: keep } }); }
  if (apply && patches.length) await st.patchEach(patches);
  return { apply, n: docs.length, fix: patches.length };
}

// поиск вещей бренда по названию (все статусы): код, адрес, цена, пол
export async function findBrand(st, brand, re) {
  const R = new RegExp(re, "i"), lc = v => String(v || "").toLowerCase();
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, title, overrides" })).filter(p => lc(p.overrides?.brand || p.brand) === lc(brand) && R.test(String(p.overrides?.title || p.title || "")));
  const docs = (await st.getMany(L.slice(0, 80).map(p => p._id))).filter(Boolean);
  return docs.map(d => ({ id: d._id, st: d.status, t: d.title, g: d.overrides?.gender || d.gender, sku: d.modelSku || d.sku || null, color: d.color || d.variants?.[0]?.color || null, url: d.sourceUrl, b: d.pricing?.boutique, ua: d.pricing?.ua, img: String((d.images || [])[0]?.sourceUrl || (d.images || [])[0]?.url || "").split("/").pop().slice(0, 60), at: d._createdAt }));
}

// дубли: то же название (без порядка слов), тот же цвет (на любом языке), та же цена бутика, тот же пол → одна вещь.
// оставляем опубликованную (самую раннюю); остальные: «новые с сайтов» — удалить, опубликованные — скрыть
const CLR = [[/\b(noir|schwarz|black|nero)\b/, "black"], [/\b(blanc|wei(ss|ß)|white|bianco)\b/, "white"], [/\b(rouge|rot|red|rosso)\b/, "red"], [/\b(bleu|blau|blue|blu)\b/, "blue"], [/\b(vert|gr(u|ü)n|green|verde)\b/, "green"], [/\b(beige)\b/, "beige"], [/\b(marron|braun|brown|chocolat)\b/, "brown"], [/\b(gris|grau|grey|gray|grigio)\b/, "grey"], [/\b(rose|rosa|pink)\b/, "pink"], [/\b(orange)\b/, "orange"], [/\b(jaune|gelb|yellow)\b/, "yellow"], [/\b(naturel|natur|natural)\b/, "natural"], [/\b(ecru|écru)\b/, "ecru"]];
const clrKey = c => { const t = String(c || "").toLowerCase(); const hit = CLR.filter(([r]) => r.test(t)).map(x => x[1]); return hit.length ? hit.sort().join("+") : t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]+/g, " ").trim(); };
export async function brandDups(st, brand, { apply = false } = {}) {
  const { hermesTitleKey } = await import("./catalog.js"), lc = v => String(v || "").toLowerCase();
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => ["published", "incoming", "draft"].includes(p.status) && lc(p.overrides?.brand || p.brand) === lc(brand));
  const docs = (await st.getMany(L.map(p => p._id))).filter(Boolean), G = new Map();
  for (const d of docs) { const k = [d.overrides?.gender || d.gender || "", hermesTitleKey(d.overrides?.title || d.sourceTitle || d.title), clrKey(d.color || d.variants?.[0]?.color), d.pricing?.boutique || ""].join("|"); if (!G.has(k)) G.set(k, []); G.get(k).push(d); }
  const rank = d => (d.status === "published" ? 0 : d.status === "draft" ? 1 : 2), del = [], hide = [], ex = [];
  for (const [k, arr] of G) { if (arr.length < 2) continue; arr.sort((a, b) => rank(a) - rank(b) || String(a._createdAt).localeCompare(String(b._createdAt)));
    const keep = arr[0]; for (const d of arr.slice(1)) { if (d.status === "incoming") del.push(d._id); else if (d.status === "published") hide.push(d._id); }
    if (ex.length < 40) ex.push(k + " → оставить " + keep._id.slice(15) + " (" + keep.status + "), лишние: " + arr.slice(1).map(d => d._id.slice(15) + " " + d.status).join(", ")); }
  if (apply) { if (hide.length) { const { setStatus } = await import("./publish.js"); await setStatus(st, hide, "draft", "Claude: дубль"); } if (del.length) await st.delMany(del); }
  return { apply, n: docs.length, groups: G.size, del: del.length, hide: hide.length, ex };
}
