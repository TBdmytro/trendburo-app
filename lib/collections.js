/**
 * Коллекции брендов (Dior Cruise 2027, Saint Laurent Winter 26…).
 * Появляются сами: кнопка «В Trend Büro» прогнала страницу коллекции на сайте бренда — запоминаем раздел,
 * а товары коллекции — это наши товары, у которых этот раздел есть в webSections (уже загруженные тоже, без дублей).
 * В админке: показывать / скрыть, закрепить первой, название, описание, срок показа.
 */
// сезон — отдельным словом («Winter 26», «Fall-Winter»), а не частью слова («Wintermützen», «Winterschals» — обычные разделы)
const COLL_RE = /(kollektion|collection|collezione|collectie|colecci[oó]n|cruise|resort|pre-?fall|\b(spring|summer|fall|autumn|winter|herbst|fr[uü]hling|sommer)\b|capsule|kapsel|holiday|\balps?\b|apr[eè]s[- ]?ski|\bski\b|edition|limited)/i;
// тематическая линия, названная именем бренда: «dior.com/…/damenmode/dior-alps», «…/dior-chez-moi», «…/gucci-lido»
const BRAND_LINE = /\/(dior|gucci|louis-vuitton|lv|saint-laurent|ysl|prada|celine|loewe|bottega-veneta|valentino|balenciaga|fendi|chanel|miu-miu|loro-piana)-(?!gifts?|geschenke|alle|all\b|herren|damen|men\b|women)[a-z0-9-]{3,40}\/?$/i;
// раздел новинок бренда («Neuheiten für Herren», «New Arrivals») — тоже баннер на главной: «Новинки Dior · для него»
const NEW_RE = /(neuheiten|new[- ]?arrivals?|nouveaut[eé]s?|novit[aà]|what'?s[- ]new|neu[- ]eingetroffen|\/new[-_]?in\b|\/neu\b)/i;
// раздел подарков к празднику («Festtagsgeschenke für Herren», «Holiday Gifts») — баннер «Подарки Dior · для него»
const GIFT_RE = /(geschenk|gifts?\b|gifting|cadeaux?|regal[io]|подар)/i;
export const isGifts = (title, url) => GIFT_RE.test(String(title || "") + " " + String(url || ""));
export const isNewArrivals = (title, url) => NEW_RE.test(String(title || "") + " " + String(url || ""));
const ALL_RE = /\b(alle|all|tout|tutti|todo)\b|\/(alle|all)-/i;

// …/c/10326EU/page/2 — та же подборка, что …/c/10326EU (кнопка прошла её до 2-й страницы)
export const secBase = s => String(s || "").replace(/\/page\/\d+\/?$/i, "");
export const inColl = (p, c) => (p.webSections || []).some(x => secBase(x) === secBase(c.section));
export const collKey = s => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);

/** Похоже ли на страницу коллекции (а не обычный раздел «Сумки» или «Alle Taschen»). */
export function isCollection(title, url) {
  const t = String(title || ""), u = String(url || "");
  return (COLL_RE.test(t + " " + u) || NEW_RE.test(t + " " + u) || GIFT_RE.test(t + " " + u) || BRAND_LINE.test(u.split(/[?#]/)[0])) && !(ALL_RE.test(u) && !COLL_RE.test(t));
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
  // коллаборация «New Balance x Miu Miu» — название целиком
  { const c = t.replace(/\b(kollektion|collection)\b/ig, " ").replace(/\s+/g, " ").trim(); if (/\S\s+[x×]\s+\S/i.test(c)) return c.replace(/\s+[x×]\s+/i, " × ").slice(0, 60); }
  if (brand) t = t.replace(new RegExp("\\b" + String(brand).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "ig"), " ");
  t = t.replace(/\b(kollektion|collection|collezione|collectie|colección|die|the|la|le|neue|new|für damen|für herren|damen|herren|women|men)\b/ig, " ").replace(/\s+/g, " ").trim();
  // «Dior Alps» → не «Alps»: от названия линии остаётся одно слово — оставляем с брендом
  const orig = String(title || "").split(/\s[|–—-]\s/)[0].trim();
  if (t && !/\s/.test(t) && brand && new RegExp("\\b" + String(brand).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(orig) && !/\d/.test(t)) return orig.slice(0, 60);
  return (t || String(title || "").trim()).slice(0, 60);
}

/** Прогон раздела кнопкой: если это коллекция — создать или обновить её запись. Правки из админки не затираем. */
export async function upsertCollection(store, { section, url, title, desc, brand, found = 0, translate = null, now = new Date() }) {
  if (!section || !isCollection(title, url || section)) return null;
  section = secBase(section); if (url) url = secBase(url);
  const id = "collection." + collKey(section), prev = await store.get(id);
  const at = now.toISOString();
  if (prev) {
    const set = { lastRun: at, found: found || prev.found || 0, url: url || prev.url || null };
    if (!prev.edited && prev.kind !== "new" && prev.kind !== "gift") { set.title = cleanTitle(title, brand) || prev.title; if (desc && !prev.desc) set.desc = await ruDesc(desc, translate); }
    await store.patchMany([id], set);
    return { ...prev, ...set };
  }
  if (!brand) { const h = String(section).split("/")[0].replace(/^(www|de|shop|fr|it|en|us|uk)\./, "").split(".")[0], KN = { louisvuitton: "Louis Vuitton", goldengoose: "Golden Goose", brunellocucinelli: "Brunello Cucinelli", saintlaurent: "Saint Laurent", ysl: "Saint Laurent", sportyandrich: "Sporty & Rich", aloyoga: "Alo Yoga", bottegaveneta: "Bottega Veneta", miumiu: "Miu Miu", loropiana: "Loro Piana" };
    brand = KN[h] || (h ? h.charAt(0).toUpperCase() + h.slice(1) : ""); }
  const WOMEN_ONLY = /^miu miu$/i.test(brand || ""); // женский бренд — подборки только «для неё»
  const g0 = WOMEN_ONLY ? "w" : collGender(section, title), nw = isNewArrivals(title, url || section), gf = !nw && isGifts(title, url || section);
  const doc = { _id: id, _type: "collection", section, url: url || null, brand: brand || "", title: nw || gf ? ((nw ? "Новинки " : "Подарунки ") + (brand || "") + (g0 === "m" ? " · для нього" : g0 === "w" ? " · для неї" : "")).replace(/\s+/g, " ").trim() : (t1 => t1 && !/\s/.test(t1) && brand && !/\d/.test(t1) ? brand + " " + t1 : t1)(cleanTitle(title, brand)) /* «Holiday» → «Miu Miu Holiday» */, kind: nw ? "new" : gf ? "gift" : "coll", desc: desc ? await ruDesc(desc, translate) : "",
    g: g0, on: true, pinned: false, until: new Date(now.getTime() + 60 * 864e5).toISOString().slice(0, 10), createdAt: at, lastRun: at, found };
  await store.put(doc);
  return doc;
}
async function ruDesc(desc, translate) {
  const d = String(desc || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!d || !translate) return d.slice(0, 160);
  try { return (await translate(d)).slice(0, 160); } catch { return d.slice(0, 160); }
}

/** Коллекции для витрины: только включённые и не просроченные, с товарами на витрине. */
const JHOUSE = /cartier|van cleef|bulgari|bvlgari|tiffany|chaumet|boucheron|graff|messika|pomellato|chopard|piaget/i;
const normT = t => String(t || "").replace(/[ӨΘ]/g, "O").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const STOPW = new Set(["collection", "collections", "jewelry", "jewellery", "watches", "watch", "the", "and", "de", "du", "des", "la", "le", "les", "un", "une", "et", "van", "cleef", "arpels", "cartier", "new", "bands", "rings"]);
function collKeys(title, brand) { const b = new Set(normT(brand).split(/[^a-z0-9]+/)); return normT(title).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOPW.has(w) && !b.has(w)); }
export function activeCollections(colls, products, { now = new Date() } = {}) {
  const day = now.toISOString().slice(0, 10), out = [];
  for (const c of colls || []) {
    if (!c.on || (c.until && c.until < day)) continue;
    let mine = products.filter(p => p.status === "published" && inColl(p, c));
    // проверка данных: у ювелирного дома вещь попадает в коллекцию, только если название коллекции есть в названии вещи
    // (на странице «Panthère» бывают рекомендации из других линий — браслет Juste un Clou не должен стать «коллекцией Panthère»)
    if (JHOUSE.test(c.brand || "")) { const keys = collKeys(c.title, c.brand); if (keys.length) { const f = mine.filter(p => { const t = normT(p.overrides?.title || p.title); return keys.some(k => t.includes(k)); }); if (f.length || mine.length < 3) mine = f; } } // название раздела общее («Wedding bands») — ни одна вещь его не повторяет: оставляем раздел как есть
    if (!mine.length) continue;
    // ювелирный дом (Van Cleef, Cartier…): обложка — украшение, не часы; одежда/обувь — снимок на модели, если есть
    const cat = p => p.overrides?.category || p.category, jw = mine.filter(p => cat(p) === "jewelry"), base = jw.length && jw.length >= mine.filter(p => cat(p) === "watches").length ? jw : mine;
    const imgs = base.flatMap(p => (p.images || []).map(i => i.url)).filter(Boolean);
    // правило владельца для баннеров: сначала сумка, потом обувь, потом верхняя одежда; из аксессуаров — только головной убор; юбки, брелоки и пр. — нет
    const rank = p => { const k = cat(p), sub = p.overrides?.subcategory || p.subcategory || "", t = String(p.title || "");
      if (k === "bags") return 0; if (k === "shoes") return 1;
      if (k === "clothing" && (/^(coats|jackets|outerwear)$/.test(sub) || /\b(coat|jacket|parka|puffer|down jacket|trench|blouson|bomber|caban|peacoat|overcoat|cape)\b/i.test(t))) return 2;
      if (/^hats?$/.test(sub) || /\b(hat|cap|beanie|beret|bucket)\b/i.test(t)) return 3; return 9; };
    const pick = jw.length && base === jw ? null : mine.map(p => [rank(p), p]).filter(x => x[0] < 9 && x[1].images?.[0]?.url).sort((a, b) => a[0] - b[0])[0];
    const cover = c.cover || (pick ? pick[1].images[0].url : null) || imgs.find(u => /LOOK_|media\.christiandior|_model|look/i.test(u)) || imgs[0] || null;
    out.push({ id: c._id.replace(/^collection\./, ""), brand: c.brand, title: c.title, desc: c.desc || "", g: c.g || "u", pinned: !!c.pinned, cover, n: mine.length, ids: mine.map(p => p._id), createdAt: c.createdAt });
  }
  return out.sort((a, b) => (b.pinned - a.pinned) || String(b.createdAt).localeCompare(String(a.createdAt)));
}
