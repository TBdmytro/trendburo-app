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
