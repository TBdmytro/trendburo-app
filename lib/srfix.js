// Sporty & Rich: детские вещи → «Детское»; обложка — фото самой вещи, а не модель в полный рост.
const PX = "product.manual.sportyandric";
export const srKid = d => /\bkids?\b|\btoddler|\bbaby\b/i.test(String(d.title || "")) || (d.sizes || d.variants || []).some(s => /\d+\s*\/\s*\d+\s*y(rs|ears)?\b|\d+\s*(yrs|years|y)\b/i.test(JSON.stringify(s)));
const fn = u => String(u || "").split("?")[0].split("/").pop();
export async function srFix(st, { apply = false, dump = false, cover = null } = {}) {
  const ids = (await st.list("product", {}, { limit: 60000, fields: "_id" })).filter(p => p._id.startsWith(PX)).map(p => p._id);
  const docs = await st.getMany(ids), patches = [], out = { n: docs.length, kids: [], cover: 0, ex: [] };
  for (const d of docs.filter(Boolean)) {
    const set = {};
    if (srKid(d) && d.gender !== "k") { set.gender = "k"; out.kids.push(d.title); }
    const im = d.images || [];
    if (dump && out.ex.length < 40) out.ex.push({ t: d.title, im: im.map(i => fn(i.sourceUrl || i.url)) });
    if (cover && im.length > 1) { const i = cover(im.map(x => fn(x.sourceUrl || x.url)), d); if (i > 0) { set.images = [im[i], ...im.filter((_, k) => k !== i)]; out.cover++; } }
    if (Object.keys(set).length) patches.push({ id: d._id, set });
  }
  if (apply && patches.length) await st.patchEach(patches);
  return { apply, ...out, kidsN: out.kids.length, kids: out.kids.slice(0, 30) };
}
export const srCover = () => -1;
