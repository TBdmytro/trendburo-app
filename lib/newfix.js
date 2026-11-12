/**
 * «Новинка» = только то, что бренд сам отмечает новинкой (плашка New на сайте или раздел «Новинки»), или что вы отметили в админке.
 * Раньше любой впервые загруженный товар получал отметку на 90 дней — снимаем такие отметки.
 */
const NEW_SEC = /new.?arriv|new.?in\b|^new$|^new-|\/new\b|just.?in|whats.?new|novelt|neuheit|nouveaut|novit|новинк/i;
const DAY = 864e5;

export function autoNew(p) {
  const o = p.overrides || {};
  if (o.isNew !== "on" || !o.newUntil || !p.createdAt) return false;
  if ((p.history || []).some(h => h && h.field === "isNew")) return false; // отмечали руками в админке
  const secs = [...(p.webSections || []), ...(p.sections || []), ...(p.secPos || []).map(x => x && x.s)].filter(Boolean).map(String);
  if (secs.some(s => NEW_SEC.test(s))) return false; // раздел новинок бренда
  const gap = (Date.parse(o.newUntil) - Date.parse(String(p.createdAt).slice(0, 10))) / DAY;
  return gap >= 88 && gap <= 92; // ровно «3 месяца с первой загрузки» — так ставила только старая автоотметка
}

export async function fixAutoNew(store, { dry = false } = {}) {
  const L = (await store.list("product", {}, { limit: 60000, fields: "_id, brand, createdAt, overrides, history, webSections, sections, secPos" })).filter(p => String(p._id).startsWith("product.manual."));
  const hit = L.filter(autoNew), keep = L.filter(p => p.overrides?.isNew === "on" && !autoNew(p));
  const by = {}; for (const p of hit) by[p.brand || "?"] = (by[p.brand || "?"] || 0) + 1;
  const kb = {}; for (const p of keep) kb[p.brand || "?"] = (kb[p.brand || "?"] || 0) + 1;
  if (!dry && hit.length) await store.patchEach(hit.map(p => { const o = { ...p.overrides }; delete o.isNew; delete o.newUntil; return { id: p._id, set: { overrides: o } }; }));
  return { dry, cleared: hit.length, clearedByBrand: by, keptNew: keep.length, keptByBrand: kb };
}
