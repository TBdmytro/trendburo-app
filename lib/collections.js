/**
 * Коллекции брендов (Dior Cruise 2027, Saint Laurent Winter 26…).
 * Появляются сами: кнопка «В Trend Büro» прогнала страницу коллекции на сайте бренда — запоминаем раздел,
 * а товары коллекции — это наши товары, у которых этот раздел есть в webSections (уже загруженные тоже, без дублей).
 * В админке: показывать / скрыть, закрепить первой, название, описание, срок показа.
 */
const COLL_RE = /(kollektion|collection|collezione|collectie|colecci[oó]n|cruise|resort|pre-?fall|spring|summer|fall|autumn|winter|herbst|fr[uü]hling|sommer|capsule|kapsel|holiday)/i;
const ALL_RE = /\b(alle|all|tout|tutti|todo)\b|\/(alle|all)-/i;

export const collKey = s => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);

/** Похоже ли на страницу коллекции (а не обычный раздел «Сумки» или «Alle Taschen»). */
export function isCollection(title, url) {
  const t = String(title || ""), u = String(url || "");
  return COLL_RE.test(t + " " + u) && !(ALL_RE.test(u) && !COLL_RE.test(t));
}

/** Для кого: по адресу и названию раздела. */
export function collGender(section, title = "") {
  const s = (section + " " + title).toLowerCase();
  if (/kinder|kids|enfant|bambin|children|baby/.test(s)) return "k";
  const w = /damen|women|woman|femme|donna|mujer|\/w\//.test(s), m = /herren|\bmen\b|\/men|homme|uomo|hombre|\/m\//.test(s);
  return w && !m ? "w" : m && !w ? "m" : "u";
}

/** «Dior Cruise 2027 Kollektion | DIOR» → «Cruise 2027». */
export function cleanTitle(title, brand = "") {
  let t = String(title || "").split(/\s[|–—-]\s/)[0];
  if (brand) t = t.replace(new RegExp("\\b" + String(brand).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "ig"), " ");
  t = t.replace(/\b(kollektion|collection|collezione|collectie|colección|die|the|la|le|neue|new|für damen|für herren|damen|herren|women|men)\b/ig, " ").replace(/\s+/g, " ").trim();
  return (t || String(title || "").trim()).slice(0, 60);
}

/** Прогон раздела кнопкой: если это коллекция — создать или обновить её запись. Правки из админки не затираем. */
export async function upsertCollection(store, { section, url, title, desc, brand, found = 0, translate = null, now = new Date() }) {
  if (!section || !isCollection(title, url || section)) return null;
  const id = "collection." + collKey(section), prev = await store.get(id);
  const at = now.toISOString();
  if (prev) {
    const set = { lastRun: at, found: found || prev.found || 0, url: url || prev.url || null };
    if (!prev.edited) { set.title = cleanTitle(title, brand) || prev.title; if (desc && !prev.desc) set.desc = await ruDesc(desc, translate); }
    await store.patchMany([id], set);
    return { ...prev, ...set };
  }
  const doc = { _id: id, _type: "collection", section, url: url || null, brand: brand || "", title: cleanTitle(title, brand), desc: desc ? await ruDesc(desc, translate) : "",
    g: collGender(section, title), on: true, pinned: false, until: new Date(now.getTime() + 60 * 864e5).toISOString().slice(0, 10), createdAt: at, lastRun: at, found };
  await store.put(doc);
  return doc;
}
async function ruDesc(desc, translate) {
  const d = String(desc || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!d || !translate) return d.slice(0, 160);
  try { return (await translate(d)).slice(0, 160); } catch { return d.slice(0, 160); }
}

/** Коллекции для витрины: только включённые и не просроченные, с товарами на витрине. */
export function activeCollections(colls, products, { now = new Date() } = {}) {
  const day = now.toISOString().slice(0, 10), out = [];
  for (const c of colls || []) {
    if (!c.on || (c.until && c.until < day)) continue;
    const mine = products.filter(p => p.status === "published" && (p.webSections || []).includes(c.section));
    if (!mine.length) continue;
    const imgs = mine.flatMap(p => (p.images || []).map(i => i.url)).filter(Boolean);
    const cover = c.cover || imgs.find(u => /LOOK_|media\.christiandior|_model|look/i.test(u)) || imgs[0] || null;
    out.push({ id: c._id.replace(/^collection\./, ""), brand: c.brand, title: c.title, desc: c.desc || "", g: c.g || "u", pinned: !!c.pinned, cover, n: mine.length, ids: mine.map(p => p._id), createdAt: c.createdAt });
  }
  return out.sort((a, b) => (b.pinned - a.pinned) || String(b.createdAt).localeCompare(String(a.createdAt)));
}
