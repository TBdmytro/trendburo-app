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
const clrKey = c => { const W = { noir: "black", schwarz: "black", nero: "black", blanc: "white", weiss: "white", weib: "white", bianco: "white", rouge: "red", rot: "red", rosso: "red", bleu: "blue", blau: "blue", blu: "blue", vert: "green", grun: "green", verde: "green", marron: "brown", braun: "brown", gris: "grey", grau: "grey", gray: "grey", grigio: "grey", rosa: "pink", jaune: "yellow", gelb: "yellow", naturel: "natural", natur: "natural" };
  return String(c || "").toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter(Boolean).map(w => W[w] || w).sort().join(" "); }; /* строго: все слова цвета (rose palomino ≠ rose sakura), только перевод отдельных слов */
export async function brandDups(st, brand, { apply = false, onlyNew = false } = {}) {
  const { hermesTitleKey } = await import("./catalog.js"), lc = v => String(v || "").toLowerCase();
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => ["published", "incoming", "draft"].includes(p.status) && lc(p.overrides?.brand || p.brand) === lc(brand));
  const docs = (await st.getMany(L.map(p => p._id))).filter(Boolean), G = new Map();
  const isH = /herm/i.test(brand);
  for (const d of docs) { const cc = isH ? String(d.modelSku || "").toUpperCase().slice(-2) : ""; /* Hermès: последние 2 знака кода — цвет; тот же цвет-код = та же расцветка */ const k = [d.overrides?.gender || d.gender || "", hermesTitleKey(d.overrides?.title || d.sourceTitle || d.title), isH ? "c" + cc : clrKey(d.color || d.variants?.[0]?.color), d.pricing?.boutique || ""].join("|"); if (!G.has(k)) G.set(k, []); G.get(k).push(d); }
  const rank = d => (d.status === "published" ? 0 : d.status === "draft" ? 1 : 2), del = [], hide = [], ex = [];
  for (const [k, arr] of G) { if (arr.length < 2) continue; arr.sort((a, b) => rank(a) - rank(b) || String(a._createdAt).localeCompare(String(b._createdAt)));
    const keep = arr[0]; for (const d of arr.slice(1)) { if (d.status === "incoming") del.push(d._id); else if (d.status === "published") hide.push(d._id); }
    if (ex.length < 40) ex.push(k + " → оставить " + keep._id.slice(15) + " (" + keep.status + "), лишние: " + arr.slice(1).map(d => d._id.slice(15) + " " + d.status).join(", ")); }
  if (apply) { if (hide.length && !onlyNew) { const { setStatus } = await import("./publish.js"); await setStatus(st, hide, "draft", "Claude: дубль"); } if (del.length) await st.delMany(del); }
  return { apply, n: docs.length, groups: G.size, del: del.length, hide: hide.length, ex };
}

// Дубли по артикулу на фото: одна и та же вещь (тот же артикул в адресе фото LV «…--BR9U1PMX02_PM2…») загружена дважды под разными номерами.
// Оставляем вещь с бо́льшим числом размеров, при равенстве — более раннюю; лишние только скрываем (в черновики), не удаляем
export async function skuDups(st, brand, { apply = false } = {}) {
  const lc = v => String(v || "").toLowerCase();
  const L = (await st.list("product", { status: "published" }, { limit: 60000, fields: "_id, brand, overrides" })).filter(p => lc(p.overrides?.brand || p.brand) === lc(brand));
  const G = new Map();
  for (let i = 0; i < L.length; i += 200) for (const d of (await st.getMany(L.slice(i, i + 200).map(p => p._id))).filter(Boolean)) {
    const m = decodeURIComponent((d.images || []).map(x => String(x.sourceUrl || x.url || "")).join(" ")).match(/--([A-Z0-9]{6,12})_/); if (!m) continue;
    const k = m[1] + "|" + (d.overrides?.gender || d.gender || ""); if (!G.has(k)) G.set(k, []); G.get(k).push(d);
  }
  const hide = [], ex = [];
  for (const [k, arr] of G) { if (arr.length < 2) continue;
    arr.sort((a, b) => (b.variants || []).length - (a.variants || []).length || String(a._createdAt).localeCompare(String(b._createdAt)));
    hide.push(...arr.slice(1).map(d => d._id));
    if (ex.length < 30) ex.push(k + " · " + (arr[0].overrides?.title || arr[0].title) + " → оставить " + arr[0]._id.slice(15) + " (" + (arr[0].variants || []).length + " разм.), скрыть " + arr.slice(1).map(d => d._id.slice(15) + " (" + (d.variants || []).length + ")").join(", ")); }
  if (apply && hide.length) { const { setStatus } = await import("./publish.js"); for (let i = 0; i < hide.length; i += 200) await setStatus(st, hide.slice(i, i + 200), "draft", "Claude: дубль по артикулу"); }
  return { apply, n: L.length, hide: hide.length, ids: hide.map(x => x.slice(15)), ex };
}

// Louis Vuitton: порядок по разборам владельца (23.11).
// 1) раздел: пошет с ремнём/цепочкой и мужские клатчи — сумки; ключницы, органайзеры, пенал — аксессуары.
//    Только точные модели (начало названия) и только из того раздела, где они лежат по ошибке; решение закрепляется в overrides (ручной выбор не пересчитается при обновлении)
// 2) немецкие слова в названиях — английские, как на сайте LV
const LV_TO_BAGS = [[/^pochette (voyage|kasai|to-go)\b/i, "clutches"], [/^pochette (f[eé]licie|accessoires|hills)\b/i, "clutches"], [/^(greenwich|nil travel|fl[aâ]nerie)\b/i, null]];
const LV_TO_ACC = [[/^(key pouch|bag organi[sz]er|pocket organi[sz]er)\b/i, "wallets"], [/^charlotte pencil pouch\b/i, null],
  // 24.11: дорожные косметички из раздела «Reisen» — сервер видит «Pouch» и кладёт в клатчи, «Trunk» — в сумки
  [/^(lv x tm )?(cosmetic (lipstick )?pouch|nice\b|(cruiser |trio )?poche toilette|.*toiletry pouch|(mini |locker )?dopp kit|100 ml travel case)/i, null]];
// предмет, который сервер принял за одежду (адресная бирка — не одежда)
const LV_CLOTH_TO_ACC = [[/\baddress tag$/i, null]];
const LV_DE = [[/\bTaschen-?organizer\b/gi, "Pocket Organizer"], [/\bKare?tenetui\b/gi, "Card Holder"], [/\bGeldb[öo]rse\b/gi, "Wallet"], [/\bSchl[üu]sseletui\b/gi, "Key Pouch"],
  [/\bReisepassh[üu]lle\b/gi, "Passport Cover"], [/\bKosmetikt[äa]schchen\b/gi, "Cosmetic Pouch"], [/\bReiseetui\b/gi, "Travel Case"], [/\bKoffer\b/gi, "Suitcase"],
  [/\bSchulterriemen\b/gi, "Shoulder Strap"], [/\bPantolette\b/gi, "Mule"], [/\bFischerhut\b/gi, "Bucket Hat"], [/\bWendeg[üu]rtel\b/gi, "Reversible Belt"], [/\bSchultertasche\b/gi, "Shoulder Bag"],
  [/\bSchal\b/g, "Scarf"], [/^Etui für (\d+) Uhren$/i, "$1-Watch Case"], [/^Etui für\s+Uhren$/i, "Watch Case"], [/\bSneaker-Anh[äa]nger im Set\b/i, "Sneaker Charm Set"], [/^Kleine\s+/, "Small "], [/^Verstellbarer\s+/, "Adjustable "], [/\bMonogramm\b/g, "Monogram"]];
export const lvTitleEn = t => LV_DE.reduce((a, [re, to]) => a.replace(re, to), String(t || "")).replace(/\s{2,}/g, " ").trim();
export async function lvFix(st, { apply = false } = {}) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, title, category, overrides" })).filter(p => /^louis vuitton$/i.test(String(p.overrides?.brand || p.brand || "")) && ["published", "incoming", "draft"].includes(p.status));
  const cat = [], ttl = [];
  for (const p of L) {
    const o = p.overrides || {}, t = String(o.title || p.title || ""), c = o.category || p.category;
    let to = null;
    if (c === "accessories") for (const [re, sub] of LV_TO_BAGS) if (re.test(t)) { to = ["bags", sub]; break; }
    if (c === "bags") for (const [re, sub] of LV_TO_ACC) if (re.test(t)) { to = ["accessories", sub]; break; }
    if (c === "clothing") for (const [re, sub] of LV_CLOTH_TO_ACC) if (re.test(t)) { to = ["accessories", sub]; break; }
    if (to) cat.push({ p, to, t });
    const en = lvTitleEn(t); if (en && en !== t) ttl.push({ p, en, t });
  }
  if (apply) {
    const ids = [...new Set([...cat, ...ttl].map(x => x.p._id))], full = new Map();
    for (let i = 0; i < ids.length; i += 200) for (const d of (await st.getMany(ids.slice(i, i + 200))).filter(Boolean)) full.set(d._id, d);
    const set = new Map();
    for (const { p, to } of cat) { const d = full.get(p._id); if (!d) continue; const s = set.get(p._id) || {}; s.overrides = { ...(s.overrides || d.overrides || {}), category: to[0], subcategory: to[1] || null }; s.category = to[0]; s.subcategory = to[1] || null; s.subFor = to[0]; set.set(p._id, s); }
    for (const { p, en } of ttl) { const d = full.get(p._id); if (!d) continue; const s = set.get(p._id) || {}; const ov = { ...(s.overrides || d.overrides || {}) };
      if (ov.title) ov.title = lvTitleEn(ov.title); s.overrides = ov; s.title = lvTitleEn(d.title); s.sourceTitle = lvTitleEn(d.sourceTitle || d.title); set.set(p._id, s); }
    if (set.size) await st.patchEach([...set].map(([id, s]) => ({ id, set: s })));
  }
  return { apply, n: L.length, cat: cat.length, ttl: ttl.length,
    catEx: cat.map(x => x.p.status.slice(0, 3) + " " + (x.p.overrides?.category || x.p.category) + "→" + x.to[0] + (x.to[1] ? "/" + x.to[1] : "") + " | " + x.t),
    ttlEx: ttl.map(x => x.t + " → " + x.en) };
}

// LV: цвета на немецком (Schwarz, Braun…) → английский, как названия; фильтр по цвету их и так понимал, это для подписи в карточке
const DE_COL = { schwarz: "Black", braun: "Brown", rosa: "Pink", rot: "Red", blau: "Blue", "grün": "Green", grun: "Green", grau: "Grey", "weiß": "White", weiss: "White", gelb: "Yellow", lila: "Purple", violett: "Purple",
  silberfarben: "Silver", goldfarben: "Gold", mehrfarbig: "Multicolor", bunt: "Multicolor", dunkelblau: "Navy", marineblau: "Navy", hellblau: "Light Blue", dunkelbraun: "Dark Brown", hellbraun: "Light Brown",
  dunkelgrau: "Dark Grey", hellgrau: "Light Grey", dunkelgrün: "Dark Green", hellrosa: "Light Pink", cremeweiß: "Cream", creme: "Cream", kamel: "Camel", bordeaux: "Burgundy", orange: "Orange", beige: "Beige", farblos: "Monogram", "türkis": "Turquoise", khaki: "Khaki", "elfenbein": "Ivory", "silber": "Silver", "gold": "Gold" };
export const lvColorEn = c => { const t = String(c || "").trim(), k = t.toLowerCase(); if (!t) return t; if (DE_COL[k]) return DE_COL[k];
  return t.split(/(\s*\/\s*|\s+und\s+|\s*,\s*)/).map(w => DE_COL[w.trim().toLowerCase()] || (/\s+und\s+/.test(w) ? " / " : w)).join(""); };
export async function lvColors(st, { apply = false } = {}) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => /^louis vuitton$/i.test(String(p.overrides?.brand || p.brand || "")) && ["published", "incoming", "draft"].includes(p.status));
  const fix = [], ex = new Map();
  for (let i = 0; i < L.length; i += 200) for (const d of (await st.getMany(L.slice(i, i + 200).map(p => p._id))).filter(Boolean)) {
    const set = {}; const c0 = d.color, c1 = lvColorEn(c0); if (c0 && c1 !== c0) { set.color = c1; ex.set(c0, c1); }
    if (Array.isArray(d.variants) && d.variants.some(v => v.color && lvColorEn(v.color) !== v.color)) { set.variants = d.variants.map(v => v.color ? { ...v, color: lvColorEn(v.color) } : v); d.variants.forEach(v => v.color && lvColorEn(v.color) !== v.color && ex.set(v.color, lvColorEn(v.color))); }
    if (d.overrides?.color && lvColorEn(d.overrides.color) !== d.overrides.color) { set.overrides = { ...d.overrides, color: lvColorEn(d.overrides.color) }; ex.set(d.overrides.color, set.overrides.color); }
    if (Object.keys(set).length) fix.push({ id: d._id, set });
  }
  if (apply) for (let i = 0; i < fix.length; i += 200) await st.patchEach(fix.slice(i, i + 200));
  return { apply, n: L.length, fix: fix.length, map: Object.fromEntries([...ex].slice(0, 80)) };
}

// кто и когда менял статус (история товара) — чтобы не вернуть на витрину то, что владелец скрыл сам
export async function statusHist(st, ids) {
  const docs = (await st.getMany(ids.slice(0, 200).map(i => i.startsWith("product.") ? i : "product.manual." + i))).filter(Boolean);
  return docs.map(d => ({ id: d._id.slice(15), st: d.status, t: d.overrides?.title || d.title, at: d._createdAt, h: (d.history || []).filter(x => x.action === "status").slice(-4).map(x => x.at.slice(0, 16) + " " + x.by + " " + x.from + "→" + x.to) }));
}

// семьи моделей бренда: сколько вариантов в каждой (по ключу витрины)
export async function brandFams(st, brand) {
  const { famKey } = await import("./catalog.js"), lc = v => String(v || "").toLowerCase();
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => ["published", "incoming"].includes(p.status) && lc(p.overrides?.brand || p.brand) === lc(brand));
  const docs = (await st.getMany(L.map(p => p._id))).filter(Boolean), F = new Map();
  for (const d of docs) { const k = famKey(d); if (!F.has(k)) F.set(k, { k, t: new Set(), n: 0, g: d.overrides?.gender || d.gender, src: new Set(), br: new Set(), st: new Set() }); const f = F.get(k); f.n++; f.t.add(d.overrides?.title || d.title); f.src.add(d.sourceTitle || ""); f.br.add(d.brand); f.st.add(d.status + ":" + (d.gender || "") + "/" + (d.overrides?.gender || "")); }
  const arr = [...F.values()].map(f => ({ k: f.k, n: f.n, g: f.g, t: [...f.t].slice(0, 4), src: [...f.src].slice(0, 3), br: [...f.br], st: [...f.st].slice(0, 4) })).sort((a, b) => b.n - a.n);
  const byTitle = new Map(); for (const f of arr) for (const t of f.t) { const k = f.g + "|" + String(t).toLowerCase(); byTitle.set(k, (byTitle.get(k) || 0) + 1); }
  const sp = new Set([...byTitle].filter(([, v]) => v > 1).map(([k]) => k)); return { n: docs.length, fams: arr.length, top: arr.slice(0, 25).map(({ src, br, st, ...r }) => r), splitN: sp.size, split: arr.filter(f => f.t.some(t => sp.has(f.g + "|" + String(t).toLowerCase()))).slice(0, 24) };
}

// Sporty & Rich «90s Streetwear»: товары загружены с разделом без сайта — приводим раздел к общему виду и заводим коллекцию
export async function srColl(st, { apply = false } = {}) {
  const OLD = "collections/90s-streetwear", SEC = "sportyandrich.com/collections/90s-streetwear";
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, title, status, webSections, images" })).filter(p => (p.webSections || []).some(x => x === OLD || x === SEC));
  const fix = L.filter(p => (p.webSections || []).includes(OLD));
  const cov = L.find(p => /Pilot Jacket - Faded Black/i.test(p.title)) || L.find(p => /Jacket|Puffer/i.test(p.title)) || L[0];
  const cover = cov && (cov.images || [])[0] && cov.images[0].url;
  if (apply) {
    for (const p of fix) await st.patchMany([p._id], { webSections: [...new Set((p.webSections || []).map(x => x === OLD ? SEC : x))] });
    const { upsertCollection } = await import("./collections.js");
    await upsertCollection(st, { section: SEC, url: "https://sportyandrich.com/collections/90s-streetwear", title: "90s Streetwear Collection", brand: "Sporty & Rich", found: L.length });
    const { collKey } = await import("./collections.js");
    await st.patchMany(["collection." + collKey(SEC)], { title: "90s Streetwear", desc: "Нова колекція Sporty & Rich у дусі 90-х: камуфляж, пілоти й пуховики, худі, спортивні костюми та аксесуари", edited: true, g: "u", ...(cover ? { cover } : {}) });
  }
  return { apply, n: L.length, fix: fix.length, live: L.filter(p => p.status === "published").length, cover };
}

// проверка бренда перед выкладкой: по каждому товару — адрес, размеры с наличием, фото, обложка, цена, категория, пол
export async function brandAudit(st, brand) {
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides" })).filter(p => String(p.overrides?.brand || p.brand || "").toLowerCase() === String(brand).toLowerCase());
  const out = [];
  for (let i = 0; i < L.length; i += 200) for (const d of (await st.getMany(L.slice(i, i + 200).map(p => p._id))).filter(Boolean)) {
    const o = (d.offers || [])[0] || {}, ov = d.overrides || {};
    out.push({ id: d._id.replace(/^product\.manual\./, ""), st: d.status, t: ov.title || d.title, h: (String(d.sourceUrl || o.url || "").match(/\/products\/([^/?#]+)/) || [])[1] || "", c: ov.category || d.category, sc: ov.subcategory || d.subcategory || "", g: ov.gender || d.gender || "",
      b: d.pricing?.boutique || null, ua: d.pricing?.ua || null, col: d.color || (d.colors || [])[0] || "",
      sz: (d.variants || []).map(v => [v.size || "", (o.availability || {})[v._key]?.status || "-"]),
      im: (d.images || []).map(x => String(x.sourceUrl || x.url || "")), cov: ov.cover || "", tile: d.tileImg || "", at: d._createdAt });
  }
  return out;
}

// Le Silla (Shopify): сверка с сайтом бренда частями — цена и размеры с наличием, недостающие фото, обложка = первое фото товара на сайте.
// Скрытые на сайте бренда вещи (метка hidden — закрытая распродажа) не трогаем, только считаем
export async function shopifySync(st, { host = "www.lesilla.com", path = "/en-int", px = "product.manual.lesilla-", from = 0, n = 150, apply = false } = {}) {
  const all = []; for (let pg = 1; pg <= 15; pg++) { const r = await fetch(`https://${host}${path}/products.json?limit=250&page=${pg}`, { headers: { "User-Agent": "Mozilla/5.0" } }); if (!r.ok) throw new Error("site " + r.status); const j = await r.json(); if (!j.products?.length) break; all.push(...j.products); }
  const byH = new Map(all.map(p => [p.handle, p])), H = u => (String(u || "").match(/\/products\/([^/?#]+)/) || [])[1] || "", fn = u => String(u || "").split("?")[0].split("/").pop().toLowerCase();
  const ids = (await st.list("product", {}, { limit: 60000, fields: "_id" })).map(p => p._id).filter(i => i.startsWith(px)).sort();
  const part = ids.slice(from, from + n), docs = (await st.getMany(part)).filter(Boolean);
  const pricingCfg = (await st.get("settings.pricing"))?.config || null, { updateWebProduct } = await import("./manual.js");
  const rep = { total: ids.length, from, done: 0, hidden: 0, noSite: 0, imgs: 0, cover: 0, siteCount: all.length };
  for (const d of docs) {
    const sp = byH.get(H(d.sourceUrl || d.offers?.[0]?.url)); if (!sp) { rep.noSite++; continue; } if ((sp.tags || []).includes("hidden")) { rep.hidden++; continue; }
    const site = sp.images.map(i => i.src.includes("?") ? i.src + "&width=3200" : i.src + "?width=3200");
    let im = d.images || [], set = null;
    if (im.length < Math.min(3, site.length) || (!d.overrides?.cover && !(d.overrides?.imageOrder || []).length && (!im.some(i => fn(i.sourceUrl || i.url) === fn(site[0])) || im.some(i => /_(grande|large|medium|small)\.(jpe?g|png|webp)/i.test(String(i.sourceUrl || i.url)))))) { /* мало фото, нет первого фото сайта или мелкие копии (…_grande.jpg — 600 px) — берём все фото с сайта в полном размере */ im = site.slice(0, 12).map(u => ({ url: u, sourceUrl: u, rights: "copied" })); set = { images: im, coverFrom: null, coverTile: null }; rep.imgs++; }
    if (!d.overrides?.cover && !(d.overrides?.imageOrder || []).length) { const f0 = fn(site[0]), j = im.findIndex(i => fn(i.sourceUrl || i.url) === f0); if (j > 0 || (j === 0 && d.coverTile)) { im = j > 0 ? [im[j], ...im.slice(0, j), ...im.slice(j + 1)] : im; set = { ...(set || {}), images: im, coverFrom: null, coverTile: null }; rep.cover++; } }
    // цвет — из адреса товара на сайте бренда («colette-boot-120-mm-black-crystal-4251b…» → Black Crystal): у Le Silla в названии цвета нет, а все цвета модели — одна карточка
    { const t = String(sp.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); let h = sp.handle.replace(/-[0-9a-z]{16,20}$/, "");
      h = h.startsWith(t) ? h.slice(t.length) : (h.match(/-mm-(.+)$/) || [, ""])[1]; h = h.replace(/^-+/, "");
      // у модели бывает один цвет в разных материалах (Black — лак, замша, атлас): материал из описания бренда, чтобы цвета в карточке различались
      const MAT = [[/patent/i, "лак"], [/suede/i, "замша"], [/satin/i, "атлас"], [/crystal|strass|rhinestone/i, "кристали"], [/mesh|net\b|fishnet/i, "сітка"], [/velvet/i, "оксамит"], [/mirror|metallic|laminated/i, "металік"], [/pvc|vinyl|plexi/i, "PVC"], [/lurex|lamé|lame\b/i, "люрекс"], [/nappa/i, "наппа"], [/glove/i, "м'яка шкіра"], [/stretch/i, "стрейч"], [/leather|calfskin/i, "шкіра"]];
      const dsc = String(sp.body_html || "").replace(/<[^>]+>/g, " "), mt = (MAT.find(([re]) => re.test(dsc)) || [])[1] || "";
      const cn0 = h ? h.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "", cn = cn0 && mt ? cn0 + " · " + mt : cn0;
      if (cn && cn.length < 40 && ((d.colors || [])[0] !== cn || (d.variants || []).some(v => v.color !== cn))) { set = { ...(set || {}), colors: [cn] }; rep.color = (rep.color || 0) + 1; if (apply) await st.patchMany([d._id], { variants: (d.variants || []).map(v => ({ ...v, color: cn })) }); } }
    if (apply) { if (set) await st.patchMany([d._id], set);
      await updateWebProduct(st, d._id, { boutique: Number(sp.variants[0].price), sizeStock: sp.variants.map(v => ({ s: String(v.option1), ok: !!v.available })), stockRead: true, isNew: (sp.tags || []).includes("new") }, { by: "Claude (сверка с сайтом)", pricingCfg }); }
    rep.done++;
  }
  return rep;
}

// Дубли во всех брендах (владелец, 20.11): одна и та же вещь (бренд + название + цвет) несколько раз — в скрытых, в «Новых с сайтов» и на витрине.
// Разные настоящие артикулы (LV M46234, BV 741511V4P…) — разные вещи; мужская и женская версия — тоже разные. Оставляем одну: витринную, иначе самую свежую скрытую.
// Лишние скрытые/новые — удаляем (и запоминаем, чтобы загрузка не вернула); лишние витринные — только при pubs=1. По ?apply=1
export async function allDups(st, brand = "*", { apply = false, pubs = false } = {}) {
  const { hermesTitleKey } = await import("./catalog.js"), lc = v => String(v || "").toLowerCase().trim();
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, title, sourceTitle, overrides, color, gender, modelSku, _createdAt, _updatedAt" }))
    .filter(p => ["published", "incoming", "draft", "hidden"].includes(p.status) && (brand === "*" || lc(p.overrides?.brand || p.brand) === lc(brand)));
  const realSku = s => { s = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return s.length >= 5 && s.length <= 24 && /\d/.test(s) && !/[A-Z]{7,}/.test(s) ? s : ""; };
  const G = new Map();
  for (const d of L) { const tk = hermesTitleKey(d.overrides?.title || d.title || d.sourceTitle); if (!tk) continue; const k = lc(d.overrides?.brand || d.brand) + "|" + tk + "|" + clrKey(d.color); if (!G.has(k)) G.set(k, []); G.get(k).push(d); }
  const del = [], hidePub = [], per = {}, ex = [];
  const pick = arr => arr.slice().sort((a, b) => (a.status === "published" ? 0 : a.status === "draft" ? 1 : 2) - (b.status === "published" ? 0 : b.status === "draft" ? 1 : 2) || String(b._updatedAt).localeCompare(String(a._updatedAt)));
  for (const [k, arr0] of G) { if (arr0.length < 2) continue;
    // разные настоящие артикулы — разные вещи; без артикула — к группе витринной вещи
    const bySku = new Map(); for (const d of arr0) { const s = realSku(d.modelSku) || "?"; if (!bySku.has(s)) bySku.set(s, []); bySku.get(s).push(d); }
    if (bySku.size > 1 && bySku.has("?")) { const nos = bySku.get("?"); bySku.delete("?"); const tgt = [...bySku.values()].find(a => a.some(d => d.status === "published")); if (tgt && bySku.size === 1) tgt.push(...nos); else bySku.set("?", nos); }
    for (const part of bySku.values()) {
      const gs = new Set(part.map(d => d.overrides?.gender || d.gender).filter(g => /^[mwk]$/.test(g)));
      const parts = gs.size > 1 ? [...gs].map(g => part.filter(d => (d.overrides?.gender || d.gender) === g)) : [part];
      if (gs.size > 1) { const rest = part.filter(d => !/^[mwk]$/.test(d.overrides?.gender || d.gender || "")); if (rest.length) parts.push(rest); }
      for (const grp of parts) { if (grp.length < 2) continue; const s = pick(grp), keep = s[0], b = lc(keep.overrides?.brand || keep.brand);
        per[b] = per[b] || { del: 0, pub: 0 };
        for (const d of s.slice(1)) { if (d.status === "published") { hidePub.push(d._id); per[b].pub++; } else { del.push(d._id); per[b].del++; } }
        if (ex.length < 30) ex.push(k.slice(0, 70) + " → " + keep._id.slice(8) + " (" + keep.status + "); лишние: " + s.slice(1).map(d => d._id.slice(8) + " " + d.status).join(", ")); } } }
  if (apply) { const ids = [...del, ...(pubs ? hidePub : [])];
    for (let i = 0; i < ids.length; i += 200) { const ch = ids.slice(i, i + 200); const linked = await st.list("importItem", { publishedAs: ch }, { limit: 20000, fields: "_id" }).catch(() => []); if (linked.length) await st.patchMany(linked.map(x => x._id), { publishedAs: null, publishedAt: null });
      await st.delMany(ch); try { const { rememberDeleted } = await import("./catalogload.js"); await rememberDeleted(st, ch); } catch {} } }
  return { apply, pubs, n: L.length, del: del.length, pubDup: hidePub.length, per: Object.entries(per).sort((a, b) => b[1].del + b[1].pub - a[1].del - a[1].pub), ex, pubIds: hidePub.slice(0, 60) };
}

// Скрытые копии витринных вещей во всех брендах: тот же адрес товара на сайте бренда (без языка/параметров) или тот же настоящий артикул,
// что у вещи на витрине (с тем же полом или без пола). Лишние скрытые/новые — удаляем (и запоминаем). Среди скрытых между собой — оставляем свежую. По ?apply=1
export async function hiddenTwins(st, { apply = false, brand = "*" } = {}) {
  const lc = v => String(v || "").toLowerCase().trim();
  const L = (await st.list("product", {}, { limit: 60000, fields: "_id, brand, status, overrides, gender, modelSku, sourceUrl, _updatedAt" }))
    .filter(p => ["published", "incoming", "draft", "hidden"].includes(p.status) && (brand === "*" || lc(p.overrides?.brand || p.brand) === lc(brand)));
  const realSku = s => { s = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return s.length >= 5 && s.length <= 24 && /\d/.test(s) && !/[A-Z]{7,}/.test(s) ? s : ""; };
  const url = u => { u = String(u || "").toLowerCase().split(/[?#]/)[0].replace(/^https?:\/\/(www\.)?/, "").replace(/\/(en|de|fr|it|uk|us|eu|ua)(-[a-z]{2})?\//, "/").replace(/\/+$/, ""); return u.length > 12 ? u : ""; };
  const gOf = p => p.overrides?.gender || p.gender || "", bOf = p => lc(p.overrides?.brand || p.brand);
  const pubK = new Map(); const keys = p => [url(p.sourceUrl) && "u:" + bOf(p) + ":" + url(p.sourceUrl), realSku(p.modelSku) && "s:" + bOf(p) + ":" + realSku(p.modelSku)].filter(Boolean);
  for (const p of L.filter(p => p.status === "published")) for (const k of keys(p)) { if (!pubK.has(k)) pubK.set(k, []); pubK.get(k).push(p); }
  const del = [], per = {}, ex = [], seen = new Map();
  const hid = L.filter(p => p.status !== "published").sort((a, b) => String(b._updatedAt).localeCompare(String(a._updatedAt)));
  for (const p of hid) { const ks = keys(p); if (!ks.length) continue; const g = gOf(p);
    const tw = ks.flatMap(k => pubK.get(k) || []).find(q => !g || !gOf(q) || gOf(q) === g || !/^[mwk]$/.test(g) || !/^[mwk]$/.test(gOf(q)));
    const dupH = !tw && ks.map(k => seen.get(k + "|" + g)).find(Boolean);
    if (tw || dupH) { del.push(p._id); const b = bOf(p); per[b] = (per[b] || 0) + 1; if (ex.length < 25) ex.push(p._id.slice(8) + " " + p.status + " = " + (tw || dupH)._id.slice(8) + " " + (tw || dupH).status); }
    else ks.forEach(k => seen.set(k + "|" + g, p)); }
  if (apply) for (let i = 0; i < del.length; i += 200) { const ch = del.slice(i, i + 200); const linked = await st.list("importItem", { publishedAs: ch }, { limit: 20000, fields: "_id" }).catch(() => []); if (linked.length) await st.patchMany(linked.map(x => x._id), { publishedAs: null, publishedAt: null });
    await st.delMany(ch); try { const { rememberDeleted } = await import("./catalogload.js"); await rememberDeleted(st, ch); } catch {} }
  const cnt = {}; L.forEach(p => { const b = bOf(p); cnt[b] = cnt[b] || { pub: 0, hid: 0 }; p.status === "published" ? cnt[b].pub++ : cnt[b].hid++; });
  return { apply, n: L.length, del: del.length, per: Object.entries(per).sort((a, b) => b[1] - a[1]), ex, cnt };
}
