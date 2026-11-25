import { vcaModel, vcaLabel, isVca } from "./vca.js";
/**
 * Проекция товара для витрины: только то, что нужно клиенту.
 * Закупка, артикулы, исходные названия и техданные в витрину не попадают.
 */
import { effectiveAvailability } from "./match.js";
import { sized } from "./images.js";
import { isPosterImg } from "./imgorder.js";

const slug = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "").slice(0, 20);

// лёгкий формат: общий префикс адресов фото Shopify заменяется на «~» (витрина возвращает его обратно)
export const SHOP_PRE = "https://cdn.shopify.com/s/files/";
const short = u => typeof u === "string" && u.startsWith(SHOP_PRE) ? "~" + u.slice(SHOP_PRE.length) : u;

/**
 * Для кого: w — женское, m — мужское, k — детское, u — унисекс.
 * Ваша отметка в админке главнее; дальше — что пришло с сайта; если вещь «унисекс» или без отметки —
 * по разделам магазина, где она стоит: только в женском → женское, только в мужском → мужское, в обоих → унисекс, в детском → детское.
 * Одна запись товара — без дублей: унисекс показывается и в «Для неё», и в «Для него».
 */
const SEC_K = /(^|[-_])(kids?|children|child|boys?|girls?|kinder|baby|babies|junior|enfants?|bambin[oi])([-_]|$)/i, SEC_W = /(^|[-_])(women|womens|woman|ladies|damen|femme|donna)([-_]|$)/i, SEC_M = /(^|[-_])(men|mens|man|herren|homme|uomo)([-_]|$)/i;
const WOMEN_BRANDS = /^\s*(miu\s*miu|paris\s*texas|amina\s*muaddi|ren[eé]\s*caovilla)\s*$/i; // женские бренды
export function genderOf(p, o = p.overrides || {}) {
  const ov = o.gender; if (["w", "m", "k", "u"].includes(ov)) return ov;
  // Loro Piana: унисекса нет — пол по адресу товара (…/herren/… или …/damen/…), даже если вещь стоит в обоих разделах
  if (/loro\s*piana/i.test(String(o.brand || p.brand || ""))) { const u = String(p.sourceUrl || ""); if (/\/(herren|men|man|uomo)\//i.test(u)) return "m"; if (/\/(damen|women|woman|donna)\//i.test(u)) return "w"; if (p.gender === "m" || p.gender === "w") return p.gender; }
  // женские бренды: всё — «Для неё» (Miu Miu)
  if (WOMEN_BRANDS.test(String(o.brand || p.brand || ""))) return "w";
  // вещь есть и в мужском, и в женском разделе сайта бренда (кнопка прошла оба) — унисекс: видна и «Для него», и «Для неё»
  if (p.gender === "m" || p.gender === "w") { const ws = (p.webSections || []).flatMap(x => String(x).split("/")); if (ws.some(x => SEC_W.test(x)) && ws.some(x => SEC_M.test(x))) return "u"; }
  const g = p.gender; if (g === "w" || g === "m" || g === "k") return g;
  const secs = [...(p.sections || []), ...(p.secPos || []).map(x => x && x.s)].filter(Boolean).map(String);
  const K = secs.some(h => SEC_K.test(h)), W = secs.some(h => SEC_W.test(h)), M = secs.some(h => SEC_M.test(h));
  return K && !W && !M ? "k" : W && !M ? "w" : M && !W ? "m" : "u";
}
// все фото товара (короткие адреса, как в compact) — для карточки товара, когда в лёгком каталоге только первые
export function storefrontImages(p) { const o = p.overrides || {}; const imgs0 = noTransformDupes(orderWithOverrides(p.images || [], o)), imgsF = imgs0.filter(i => !isPosterImg(i.sourceUrl || i.url)), imgs = imgsF.length ? imgsF : imgs0; return imgs.slice(0, 12).map(i => short(i.url)); }
const SZC = { online: "", ask: "a", boutique: "b", preorder: "p", out: "x", unknown: "u" };
const szCode = st => !st ? "~n" : SZC[st] !== undefined ? (SZC[st] ? "~" + SZC[st] : "") : "~" + st;
export function toStorefront(p, now = Date.now(), { compact = false, lean = false } = {}) {
  const o = p.overrides || {};
  if (p.status !== "published" || o.hidden) return null;
  const pr = p.pricing || {};
  if (!(pr.ua > 0)) return null;
  const offer = (p.offers || []).find(x => x._key === pr.offerKey) || (p.offers || [])[0];
  // порядок фото — как сохранён (первое = обложка как на сайте бренда). Раньше здесь «убирались копии размеров» по пропорции —
  // это выкидывало настоящую обложку 1600×2000, если рядом было фото крупнее той же пропорции (вид сзади, деталь)
  // без заставок видео и рекламных кадров — но никогда не оставляем вещь совсем без фото
  const imgs0 = noTransformDupes(orderWithOverrides(p.images || [], o)), imgsF = imgs0.filter(i => !isPosterImg(i.sourceUrl || i.url)), imgs = imgsF.length ? imgsF : imgs0;
  const hermes = isHermesP(p);
  const variants = (p.variants || []).map(v => {
    const a = offer?.availability?.[v._key];
    const vu = v.images && v.images[0] && v.images[0].url;
    return { color: hermes && v.color ? hermesColor(v.color) : v.color, size: v.size, image: sized(vu || imgs[0]?.url, 400), idx: vu ? imgs.findIndex(i => i.url === vu) : -1, status: effectiveAvailability(a && a.status, offer?.checkedAt, now, offer?.staleHours || undefined) };
  });
  const colors = [];
  variants.forEach(v => { if (v.color && !colors.some(c => c.name === v.color)) colors.push({ name: v.color, image: v.image, idx: v.idx, available: variants.some(x => x.color === v.color && (x.status === "online" || x.status === "boutique")) }); });
  const statuses = variants.map(v => v.status);
  const sale = activeSale(o.sale, now);
  const cut = x => x > 0 && sale ? Math.round(x * (1 - sale.pct / 100)) : x;
  const summary = statuses.includes("online") ? "online" : statuses.includes("boutique") ? "boutique" : statuses.includes("preorder") ? "preorder" : statuses.includes("ask") ? "ask" : statuses.length && statuses.every(s => s === "out") ? "out" : "unknown";
  return {
    id: p._id, brand: p.brand, bk: slug(p.brand), title: hermes && !o.title ? hermesTitle(p.title || p.sourceTitle) : !o.title && /bulgari|bvlgari|tiffany/i.test(String(p.brand || "")) ? jewelTitleEn(p.title || p.sourceTitle) : o.title || p.title || p.sourceTitle,
    cat: o.category || p.category || "other", sub: (o.subcategory || ((o.category || p.category) === (p.subFor || p.category) ? p.subcategory : null)) || undefined, g: genderOf(p, o),
    // compact: только исходные адреса (до 12 фото) — размеры витрина подставляет сама; ответ в 2 раза легче
    ...(lean ? { im: imgs.slice(0, 2).map(i => short(i.url)), ...(imgs.length > 2 ? { imn: Math.min(imgs.length, 12) } : {}) } : compact ? { im: imgs.slice(0, 12).map(i => short(i.url)) } : { images: imgs.map(i => ({ src: sized(i.url, 1000), thumb: sized(i.url, 400), big: sized(i.url, 1600) })) }),
    colors: compact || lean ? colors.map(c => ({ ...c, image: short(c.image) })) : colors, ...(lean ? { sz: variants.filter(v => v.size && !/[~@]/.test(String(v.size))).map(v => String(v.size) + szCode(v.status) + (v.color ? "@" + v.color : "")) } : { sizes: variants.filter(v => v.size).map(v => ({ size: v.size, color: v.color, status: v.status })) }),
    price: { ua: cut(pr.ua), eu: cut(pr.eu), dxb: cut(pr.dxb) },
    mk: offer?.boutique > 0 && cut(pr.ua) > offer.boutique ? Math.round(cut(pr.ua) - offer.boutique) : undefined, // наша наценка — для скидки за 2+ вещи (наценка ≥ 80 € → −20 €)
    oldPrice: sale ? { ua: pr.ua, eu: pr.eu, dxb: pr.dxb } : undefined,
    sale: sale ? sale.pct : undefined, saleUntil: sale && sale.until ? sale.until : undefined,
    dims: o.dims || undefined, material: o.material || undefined,
    availability: summary, orderable: summary === "online",
    checkedAt: offer?.checkedAt || null,
    // новинка: отметка в админке (со сроком) или вещь в разделе «Новинки» у самого бренда (new arrivals); «off» в админке — не новинка
    isNew: o.isNew === "on" ? (!o.newUntil || now < endOf(o.newUntil)) : o.isNew !== "off" && (p.secPos || []).some(x => NEW_SEC.test(String(x && x.s || ""))),
    // место в бестселлерах бренда (раздел магазина поставщика) — для порядка «Популярное»
    best: (() => { const b = (p.secPos || []).find(x => /best.?sell/i.test(x.s)); return b ? b.p : undefined; })(),
    stock: cleanStock(o.stock || p.stock),
    // «другие цвета»: одна модель в разных цветах — один ключ семьи; цвет этой вещи
    fam: famKey(p, o), col: (isVca(p) && vcaLabel(p)) || colorOf(p, variants) || undefined,
    ct: colorTags(colors.map(c => c.name), p.colors || [], p.color || "", String(o.title || p.title || "").split(/\s[-–]\s/).slice(1)) || colorTags(o.title || p.title || p.sourceTitle || "") || undefined,
    // когда вещь появилась на нашей витрине — для «Новинок недели» на главной
    na: String(p.publishedAt || p.createdAt || "").slice(0, 10) || undefined,
    // Hermès: ремень-конструктор — пряжки, ремни, наборы и цены частей (цена пары = пряжка + ремень); base — цена бутика обложки для пересчёта нашей цены
    // Graff: камни к модели кольца [карат, цвет, чистота, цена бутика]; base — цена бутика «от» для пересчёта нашей цены
    dia: p.dia && Array.isArray(p.dia.list) && p.dia.list.length ? { base: offer?.boutique || p.dia.base, at: String(p.dia.at || "").slice(0, 10), list: p.dia.list.map(x => x.pair ? [x.ct, x.col, x.cla, x.p, x.pair] : [x.ct, x.col, x.cla, x.p]) } : undefined,
    kit: p.kit ? { w: p.kit.w, sizes: p.kit.sizes, def: p.kit.def, additive: !!p.kit.additive, base: offer?.boutique || p.kit.def?.p, buckles: Object.values(p.kit.buckles || {}).map(b => ({ c: b.c, n: b.name, p: b.p, k: b.k })), straps: Object.values(p.kit.straps || {}).map(x => ({ c: x.c, n: x.name, col: x.color, p: x.p, k: x.k })), combos: (p.kit.combos || []).map(x => [x.b, x.s, x.p, x.ok ? 1 : 0]) } : undefined
  };
}

// Van Cleef и др. (AEM): «…png.transform.vca-w350-1x.png» — уменьшенная копия того же снимка. Если оригинал есть — копию убираем; если нет — берём оригинал вместо мелкой
function noTransformDupes(list) { const base = u => { const m = String(u || "").split("?")[0].match(/^(.+?\.(?:png|jpe?g|webp))\.transform\./i); return m ? m[1] : null; };
  const have = new Set(list.map(i => String(i.url || "").split("?")[0])), seen = new Set(), out = [];
  for (const i of list) { const b = base(i.url); if (b && have.has(b)) continue; const x = b && /vancleefarpels\.com/.test(b) && /-w3\d\d-|w350/.test(String(i.url)) ? { ...i, url: b } : i; const k = String(x.url).split("?")[0]; if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out.length ? out : list; }
function orderWithOverrides(images, o) {
  // фото, убранные в админке (×), на витрину не идут
  const off = new Set(o.imgOff || []); let list = images.filter(x => !off.has(x.sourceUrl || x.url) && !off.has(x.url)); if (!list.length) list = images.slice();
  if (o.imageOrder && o.imageOrder.length) {
    const pos = new Map(o.imageOrder.map((u, i) => [u, i]));
    list.sort((a, b) => (pos.get(a.sourceUrl || a.url) ?? 999) - (pos.get(b.sourceUrl || b.url) ?? 999));
  }
  if (o.cover) { const i = list.findIndex(x => (x.sourceUrl || x.url) === o.cover || x.url === o.cover); if (i > 0) list.unshift(list.splice(i, 1)[0]); }
  return list;
}

/** «В наличии»: вещь уже выкуплена и лежит в Украине или Европе. */
function cleanStock(st) {
  if (!st || !st.loc) return null;
  return { loc: st.loc === "ua" ? "ua" : "eu", city: String(st.city || (st.loc === "ua" ? "Киев" : "Мюнхен")).slice(0, 40), size: st.size ? String(st.size).slice(0, 12) : undefined };
}

const NEW_SEC = /new.?arriv|new.?in\b|^new$|^new-|just.?in|whats.?new|novelt|neuheit|nouveaut|новинк/i;

/** Конец дня/минуты, до которой действует метка: «2026-10-15» — включительно весь день. */
function endOf(d) { const s = String(d); return Date.parse(s.length === 10 ? s + "T23:59:59" : s); }

/** Скидка действует, пока не наступила дата окончания; после — цена возвращается сама. */
export function activeSale(s, now = Date.now()) {
  if (!s || !(s.pct >= 1 && s.pct <= 90)) return null;
  if (s.until && !(now < endOf(s.until))) return null;
  return { pct: s.pct, until: s.until || null };
}

// одно фото в нескольких размерах (сайт бренда отдаёт 200, 400 … 2608 px): у хранилища размер в адресе — «-ШxВ».
// Оставляем только самый крупный кадр каждой пропорции; разные ракурсы одного размера остаются все.
export function dropSizeCopies(list) {
  const dim = i => { const m = String(i.url || "").match(/-(\d+)x(\d+)\.\w+(?:\?|$)/); return m ? [Number(m[1]), Number(m[2])] : null; };
  const ds = list.map(dim); if (ds.filter(Boolean).length < 2) return list;
  const best = new Map(); ds.forEach(d => { if (!d) return; const r = (d[0] / d[1]).toFixed(2), a = d[0] * d[1]; if (!best.has(r) || a > best.get(r)) best.set(r, a); });
  return list.filter((_, i) => { const d = ds[i]; return !d || d[0] * d[1] >= best.get((d[0] / d[1]).toFixed(2)) * 0.9; });
}

// семья цветов: бренд + название без слов-цветов; если у бренда артикул начинается с 6 цифр модели (Saint Laurent, Gucci) — ещё и номер модели,
// чтобы разные куртки с одинаковым названием «jacket in lambskin» не считались одной моделью
const COLOR_WORDS = /\b(black|white|off[- ]?white|ivory|cream|ecru|beige|camel|sand|brown|chocolate|tan|cognac|taupe|grey|gray|anthracite|silver|gold|golden|red|burgundy|bordeaux|wine|cherry|pink|rose|blush|nude|fuchsia|orange|coral|yellow|lemon|green|khaki|olive|sage|mint|emerald|blue|navy|denim|sky|cobalt|turquoise|teal|purple|lilac|lavender|violet|multicolou?r|multi|light|dark|pale|deep|neon|noir|nero|blanc|bianco|rouge|rosso|vert|verde|bleu|blu|marron|gris|grigio|rosa|schwarz|wei(ss|ß)|rot|grün|blau)\b/gi;
// модель без цвета — по артикулу сайта бренда: все цвета одной вещи в одной семье, как бы ни перевелось название
//   Dior 113J698A0531C888 / …C989 → 113J698A0531C (последние 3 знака — цвет); Gucci 133483 3G200 1160 → первые 11; Golden Goose GWF00117.F009344.12615 → без последних 5
const MODEL_RULES = { dior: c => c.length >= 10 ? c.slice(0, -3) : null, gucci: c => /^[0-9a-z]{15}$/.test(c) ? c.slice(0, 11) : null, goldengoose: c => c.length >= 18 ? c.slice(0, -5) : null, miumiu: c => c.length >= 15 ? c.slice(0, -9) : null /* 5BF131_AN88_F0009_V_OLO: модель+материал, цвет F0009 — вариант */, prada: c => c.length >= 15 ? c.slice(0, -9) : null, stoneisland: c => /^[a-z0-9]{10,}v[0-9a-z]{4}$/.test(c) ? c.slice(0, -5) : null, renecaovilla: c => /^[a-z]\d{5}[a-z0-9]{6,}$/.test(c) ? c.slice(0, -4) : null /* C12597R001105V741: модель+материал+каблук, последние 4 — цвет */, paristexasbr: c => (String(c).match(/^(px\d{2,5}x[a-z0-9]{4}|pxnl\d{2})/) || [])[1] || null /* модель+материал (4 знака), дальше цвет */ /* Paris Texas: PX836XVN01 + цвет → модель px836xvn, цвета — варианты */ /* L2S155100058S00HC + V0016: модель, цвет V0016 — вариант */ };
// Hermès: одна модель = одно название (все материалы и цвета вместе): «Sneakers Bouncing» и «Bouncing sneakers» — одно и то же
export function hermesTitleKey(t) { const SYN = { sandale: "sandal", sandales: "sandal", sandals: "sandal", sandalen: "sandal", mocassin: "loafer", mocassins: "loafer", mokassin: "loafer", mokassins: "loafer", loafers: "loafer", ballerine: "ballerina", ballerines: "ballerina", ballerinas: "ballerina", bottine: "boot", bottines: "boot", boots: "boot", stiefelette: "boot", stiefeletten: "boot", stiefel: "boot", botte: "boot", bottes: "boot", mule: "mule", mules: "mule", pantolette: "mule", pantoletten: "mule", escarpin: "pump", escarpins: "pump", pumps: "pump", ceinture: "belt", gurtel: "belt", belts: "belt", sac: "bag", tasche: "bag", bags: "bag", espadrilles: "espadrille", derbies: "derby", derbys: "derby", slingbacks: "slingback", sneaker: "", sneakers: "", baskets: "", basket: "" };
  const w = String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).map(x => x in SYN ? SYN[x] : x).filter(x => x && !/^(de|du|la|le|les|en|in|aus|mit|and|et|fur|pour|for|the)$/.test(x));
  return w.length ? [...new Set(w)].sort().join(" ") + (/sneaker|basket/i.test(t) ? " sneakers" : "") : ""; } /* синонимы FR/DE/EN: «Sandale Oran» = «Oran Sandalen» = «Oran sandal» */
// Loro Piana: одна и та же вещь под старым и новым артикулом — один товар с цветами (кашемировая кепка Storm System: FAF8520 → FXM0365)
const LP_SAME = { faf8520: "fxm0365" };
function modelOf(p) { const m = String(p._id || "").match(/^product\.manual\.([a-z0-9]+)-([a-z0-9]+)$/); if (/amina\s*muaddi/i.test(String(p.brand || ""))) { const am = String(p.sourceTitle || p.title || "").toLowerCase().match(/^(.*?\b\d{2,3})\b/); if (am) return "am:" + am[1].replace(/\s+/g, " ").trim(); } /* Amina Muaddi: модель = название до высоты каблука («Alexa Slipper 95»), дальше материал и цвет */ if (/van cleef/i.test(String(p.brand || ""))) { const vm = vcaModel(p); if (vm) return vm; } if (/loro\s*piana/i.test(String(p.brand || ""))) { const lp = String(p.modelSku || "").match(/^([A-Z]{3}\d{4})_[A-Z0-9]{3,5}(?:_[A-Z0-9]{1,4})?$/i); if (lp) { const k = lp[1].toLowerCase(); return "lp:" + (LP_SAME[k] || k); } } if (/herm[eè]s/i.test(String(p.brand || ""))) { const ht = hermesTitleKey(p.sourceTitle || p.title); if (ht) return "hm:" + (p.overrides?.gender || p.gender || "") + ":" + ht; } /* Hermès H241856ZHC9: модель H241856, дальше отдел и цвет — цвета одной модели вместе, разные модели «Sneakers Day» отдельно */ /* Loro Piana FAO3228_H0RP: модель FAO3228, цвет H0RP — все цвета одной модели вместе, разные модели с одинаковым названием («Mokassin Summer Walk» замша / лось / с ящерицей) — отдельно */ if (m && (m[1] === "miumiu" || m[1] === "prada")) { const u = String(p.sourceUrl || "").match(/\/([A-Z0-9]{4,8})_([A-Z0-9]{2,6})_[A-Z0-9]{4,6}(?:_|\/?$)/i); if (u) return m[1] + ":" + (u[1] + u[2]).toLowerCase(); } const f = m && MODEL_RULES[m[1]]; const k = f && f(m[2]); return k ? m[1] + ":" + k : null; }
export function famKey(p, o = p.overrides || {}) {
  const mk = modelOf(p); if (mk) { let h = 5381; const k = "m|" + mk; for (let i = 0; i < k.length; i++) h = ((h * 33) ^ k.charCodeAt(i)) >>> 0; return h.toString(36); }
  const t = String(o.title || (isHermesP(p) ? hermesTitle(p.sourceTitle || p.title) : p.sourceTitle || p.title) || "").toLowerCase().replace(/\s*[-–|,/]\s*(colou?r|цвет)?\s*[a-z ]{0,30}$/i, m => COLOR_WORDS.test(m) ? "" : m);
  COLOR_WORDS.lastIndex = 0;
  const base = t.replace(COLOR_WORDS, " ").replace(/[^a-z0-9а-яё]+/gi, " ").replace(/\s+/g, " ").trim();
  if (!base) return undefined;
  // номер модели из артикула — только для общих названий («jacket in lambskin»): если в названии есть имя модели заглавными («LE LOAFER supple in suede») — название и есть модель, артикулы у цветов бывают из разных линеек
  const sku = String(p.modelSku || ""), named = /\b[A-Z][A-Z0-9]{2,}\b/.test(String(o.title || p.title || p.sourceTitle || "")) || base.split(" ").length >= 5, model = !named && /^\d{6}[A-Z0-9]{5,}$/i.test(sku) ? sku.slice(0, 6) : "";
  const k = slug(p.brand) + "|" + base + (model ? "|" + model : ""); let h = 5381; for (let i = 0; i < k.length; i++) h = ((h * 33) ^ k.charCodeAt(i)) >>> 0;
  return h.toString(36); // короткий ключ — каталог не тяжелеет
}
// Hermès берём с двух сайтов (Франция и Германия) — цвет одной и той же вещи приходил как noir / Schwarz / Black, названия — «Sandales Oran», «Armband Maillon».
// Владелец (21.11): всё на английском, как у Hermès на английском сайте: «beige glaise» → «Clay Beige», «marron ébène» → «Ebony Brown», Schwarz → Black.
// Одна вещь = один артикул (id по коду), поэтому одинаковые вещи с двух сайтов не дублируются — переводим только подписи.
const HC_BASE = { "crème": "Cream", "éclipse": "Eclipse", "météore": "Meteor", "ébène": "Ebony",  noir: "Black", schwarz: "Black", black: "Black", blanc: "White", "weiß": "White", weiss: "White", white: "White", bleu: "Blue", blau: "Blue", blue: "Blue",
  vert: "Green", "grün": "Green", green: "Green", rouge: "Red", rot: "Red", red: "Red", rose: "Pink", rosa: "Pink", pink: "Pink", beige: "Beige", marron: "Brown", brun: "Brown", braun: "Brown", brown: "Brown",
  gris: "Grey", grau: "Grey", grey: "Grey", gray: "Grey", jaune: "Yellow", gelb: "Yellow", yellow: "Yellow", orange: "Orange", violet: "Purple", violett: "Purple", lila: "Lilac", multicolore: "Multicolor", bunt: "Multicolor", mehrfarbig: "Multicolor", multicolor: "Multicolor",
  naturel: "Natural", natur: "Natural", natural: "Natural", "écru": "Ecru", ecru: "Ecru", argent: "Silver", silber: "Silver", silver: "Silver", or: "Gold", gold: "Gold", chocolat: "Chocolate", chocolate: "Chocolate", marine: "Navy", navy: "Navy",
  parme: "Parma", craie: "Chalk", "étain": "Tin", taupe: "Taupe", camel: "Camel", champagne: "Champagne", kraft: "Kraft", miel: "Honey", "écorce": "Bark", terre: "Earth", "poussière": "Dust", ciel: "Sky", "étoupe": "Etoupe", etoupe: "Etoupe",
  ardoise: "Slate", bourgogne: "Burgundy", havane: "Havana", farblos: "Colorless", incolore: "Colorless", prunoir: "Prunoir", graphite: "Graphite", trench: "Trench", dune: "Dune", safari: "Safari", griolet: "Griolet", macassar: "Macassar", nata: "Nata", "vert-de-gris": "Verdigris" };
const HC_Q = { glaise: "Clay", argile: "Clay", sable: "Sand", esquisse: "Sketch", galet: "Pebble", "albâtre": "Alabaster", nude: "Nude", camel: "Camel", nomade: "Nomad", perlino: "Perlino", natura: "Natura",
  "ébène": "Ebony", "pécan": "Pecan", brique: "Brick", acacia: "Acacia", palissandre: "Rosewood", muschio: "Moss", "fumé": "Smoky", acajou: "Mahogany", "cèdre": "Cedar", toundra: "Tundra", jungle: "Jungle", olive: "Olive",
  "véronèse": "Veronese", "foncé": "Dark", clair: "Light", tonnerre: "Thunder", brume: "Mist", jeans: "Jeans", nuit: "Midnight", "tempête": "Storm", "argenté": "Silver", antique: "Antique", baie: "Berry", grenade: "Grenadine",
  palomino: "Palomino", amarante: "Amaranth", tomette: "Tomette", primaire: "Primary", antarctique: "Antarctic", flamme: "Flame", canyon: "Canyon", noisette: "Hazelnut", "d'orge": "Barley", mauve: "Mauve", "pâle": "Pale",
  piment: "Chili", "sésame": "Sesame", solaire: "Solar", aquatique: "Aquatic", hydra: "Hydra", "chaï": "Chai", "crème": "Cream", mat: "Matte", "béton": "Concrete", fauve: "Fawn", ombre: "Shadow", framboise: "Raspberry",
  racine: "Root", "minéral": "Mineral", "dragée": "Dragee", gomme: "Gum", porcelaine: "Porcelain", aquarelle: "Watercolor", "mélisse": "Lemon Balm", "éden": "Eden", "canopée": "Canopy", "mosaïque": "Mosaic", carbone: "Carbon",
  "café": "Coffee", quartz: "Quartz", brut: "Raw", radieux: "Radiant", "ocre": "Ochre", indigo: "Indigo", navy: "Navy", matcha: "Matcha", loden: "Loden", abysse: "Abyss", "étain": "Tin", craie: "Chalk", "poussière": "Dust", terre: "Earth", "écorce": "Bark",
  nuit: "Midnight", gris: "Grey", ardoise: "Slate", chocolat: "Chocolate", miel: "Honey", "écru": "Ecru", prunoir: "Prunoir", gold: "Gold" };
const tc = w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
function hcPart(part) {
  let s = part.trim(); if (!s) return s; if (/^bleu de france$/i.test(s)) return "Bleu de France"; if (/^(new )?rouge h$/i.test(s)) return s.replace(/^new/i, "New").replace(/rouge h/i, "Rouge H");
  s = s.replace(/\bde prusse\b/i, "prusse").replace(/\bde france\b/i, "defrance").replace(/\bjaune d'orge\b/i, "orge-jaune");
  const w = s.split(/\s+/), lw = w.map(x => x.toLowerCase());
  if (lw[0] === "multicolore" || lw[0] === "bunt") return "Multicolor" + (w.length > 1 ? " " + hcPart(w.slice(1).join(" ")) : "");
  if (lw.join(" ") === "orge-jaune") return "Barley Yellow";
  if (HC_BASE[lw[0]] && w.length > 1 && (!HC_BASE[lw[1]] || HC_Q[lw[1]])) { // французский порядок: «beige glaise» → «Clay Beige», «bleu de Prusse» → «Prussian Blue»
    const q = lw.slice(1).map(x => x === "prusse" ? "Prussian" : x === "defrance" ? "France" : HC_Q[x] || tc(w[lw.indexOf(x)])); return [...q, HC_BASE[lw[0]]].join(" ");
  }
  return w.map((x, k) => HC_BASE[lw[k]] || HC_Q[lw[k]] || tc(x)).join(" ");
}
export function hermesColor(c) { const s = String(c || "").trim(); return s ? s.split(/\s*\/\s*/).map(hcPart).join("/") : c; }
// названия с немецкого/французского сайта: «Armband Maillon» → «Maillon Bracelet», «Sandales Oran» → «Oran Sandals»
const HT = [[/^kappe\s+(.+)/i, "$1 Cap"], [/^mütze\s+(.+)/i, "$1 Beanie"], [/^hut\s+(.+)/i, "$1 Hat"], [/^schal\s+(.+)/i, "$1 Scarf"], [/^gürtel\s+(.+)/i, "$1 Belt"], [/^tasche\s+(.+)/i, "$1 Bag"], [/^stiefel\s+(.+)/i, "$1 Boots"], [/^sandalen\s+(.+)/i, "$1 Sandals"],
  [/^ballerines\s+(.+)/i, "$1 Ballet Flats"], [/^casquette\s+(.+)/i, "$1 Cap"], [/^chapeau\s+(.+)/i, "$1 Hat"], [/^bonnet\s+(.+)/i, "$1 Beanie"], [/^écharpe\s+(.+)/i, "$1 Scarf"], [/^sac\s+(.+)/i, "$1 Bag"], [/^armband\s+(.+)/i, "$1 Bracelet"], [/^handschuhe\s+(.+)/i, "$1 Gloves"], [/^halskette\s+(.+)/i, "$1 Necklace"], [/^ohrringe\s+(.+)/i, "$1 Earrings"], [/^(?:ring|bague)\s+(.+)/i, "$1 Ring"],
  [/^sandales\s+(.+)/i, "$1 Sandals"], [/^mocassins\s+(.+)/i, "$1 Loafers"], [/^bottines\s+(.+)/i, "$1 Ankle Boots"], [/^bottes\s+(?!\d)(.+)/i, "$1 Boots"], [/^escarpins\s+(.+)/i, "$1 Pumps"], [/^baskets\s+(.+)/i, "$1 Sneakers"],
  [/^collier\s+(?!de chien)(.+)/i, "$1 Necklace"], [/^bracelet\s+(.+)/i, "$1 Bracelet"], [/^ceinture\s+(.+)/i, "$1 Belt"], [/^gants\s+(.+)/i, "$1 Gloves"], [/^sneakers\s+(.+)/i, "$1 Sneakers"]];
// Bulgari (немецкий сайт): «Serpenti Viper Ohrringe» → «Serpenti Viper Earrings», «Bvlgari Bvlgari Armband» → «Bvlgari Bvlgari Bracelet»
const JT = [[/\bLargee\b/g, "Large"], [/\bGliederhalskette\b/gi, "Link Necklace"], [/\bGliederohrringe\b/gi, "Link Earrings"], [/\bGliederanh[äa]nger\b/gi, "Link Pendant"], [/\bWickelhalskette\s*/gi, "Wrap Necklace "], [/\bWickelarmband\b/gi, "Wrap Bracelet"], [/\bS[üu](ß|ss)wasserperlen\b/gi, "Freshwater Pearls"], [/\bin abgestuftem Design\b/gi, "Graduated"], [/\bmittelgro(ß|ss)en Gliedern\b/gi, "Medium Links"], [/\bextrakleinen Gliedern\b/gi, "Extra Small Links"], [/\bkleinen Gliedern\b/gi, "Small Links"], [/\bgro(ß|ss)en Gliedern\b/gi, "Large Links"], [/\bGlieder\b/gi, "Links"], [/\bDoppelte[rs]?\b/gi, "Double"], [/\bSchmales\b/gi, "Narrow"], [/\bKleine[sr]?\b/gi, "Small"], [/\bRos[ée]- and White Gold\b/gi, "Rose and White Gold"],
  [/\bGliederarmband\b/gi, "Link Bracelet"], [/\bGliederkette\b/gi, "Link Necklace"], [/\bCreolen\b/gi, "Hoop Earrings"], [/\bArmspange\b/gi, "Cuff"], [/\bManschette\b/gi, "Cuff"], [/\bPerlmutt\b/gi, "Mother-of-Pearl"], [/\bDiamanten\b/gi, "Diamonds"], [/\bDiamant\b/gi, "Diamond"], [/\bPlatin\b/gi, "Platinum"], [/\bEinzelner Ohrring\b/gi, "Single Earring"], [/\bOhrstecker\b/gi, "Stud Earrings"], [/\bOhrringe?\b/gi, "Earrings"], [/\bArmreif(en)?\b/gi, "Bangle"], [/\bAufklappbarer\b/gi, "Hinged"], [/\bwei(ß|ss)em\b/gi, "White"], [/\bschwarzem\b/gi, "Black"], [/\bSchmaler\b/gi, "Narrow"], [/\bBreiter\b/gi, "Wide"], [/\bArmb[äa]nder\b/gi, "Bracelets"], [/\bArmband\b/gi, "Bracelet"],
  [/\bHalsketten?\b/gi, "Necklace"], [/\bKetten?\b/gi, "Necklace"], [/\bAnh[äa]nger\b/gi, "Pendant"], [/\bCollier\b/gi, "Necklace"], [/\bRinge\b/gi, "Rings"], [/\bManschettenkn[öo]pfe\b/gi, "Cufflinks"],
  [/\bSchl[üu]sselanh[äa]nger\b/gi, "Key Holder"], [/\bBrosche\b/gi, "Brooch"], [/\bund\b/g, "and"], [/\bmit\b/g, "with"], [/\bGelbgold\b/gi, "Yellow Gold"], [/\bRos[ée]gold\b/gi, "Rose Gold"], [/\bWei(ß|ss)gold\b/gi, "White Gold"]];
export function jewelTitleEn(t) { let s = String(t || "").trim(); for (const [re, to] of JT) s = s.replace(re, to); return s; }

export function hermesTitle(t) { let s = String(t || "").trim(); for (const [re, to] of HT) if (re.test(s)) { s = s.replace(re, to); break; }
  // немецкие хвосты размера модели: «Olympe, kleines Modell Ring» → «Olympe, Small Model Ring»
  return s.replace(/\bkleines Modell\b/gi, "Small Model").replace(/\bmittleres Modell\b/gi, "Medium Model").replace(/\bgro(ß|ss)es Modell\b/gi, "Large Model").replace(/\bsehr kleines Modell\b/gi, "Mini Model"); }
const isHermesP = p => /herm[eè]s/i.test(String(p.overrides?.brand || p.brand || ""));
// Скрытые метки базового цвета для поиска (владелец, 21.11): «синие джинсы», «белые кроссовки», «чёрная кепка».
// Из названий цветов бренда (Midnight Garden, Seaweed, Etoupe, Schwarz, noir…) и названия товара → black / white / blue …;
// у многоцветной вещи несколько меток: кроссовки White/Black находятся и как белые, и как чёрные
const CT_RULES = [
  ["black", /\b(black|noir|schwarz|nero|negro|onyx|jet black|caviar|ink)\b/],
  ["white", /\b(white|blanc|wei(ß|ss)|bianco|blanco|ivory|cream|cr[eè]me|ecru|[eé]cru|off-?white|chalk|craie|milk|snow|optic|pearl|porcelain|gum white|latte|panna|gesso|lait)\b/],
  ["grey", /\b(gr[ae]y|gris|grau|grigio|charcoal|anthracite|graphite|slate|ardoise|ash|pewter|tin|[eé]tain|heather|melange|m[eé]lange|smoke|fog|concrete|steel grey|quartz|carbon|antarctic|storm|zinc)\b/],
  ["blue", /\b(blue|bleu|blau|blu|azul|navy|marine|indigo|denim|jeans|azure|cobalt|midnight|sky|ciel|ocean|aqua|turquoise|teal|cyan|royal|sapphire|petrol|baltic|celeste|cornflower|abyss|hydra|prussian|dragee|lagoon|riviera|blueberry)\b/],
  ["green", /\b(green|vert|gr(ü|ue)n|verde|olive|khaki|kaki|sage|mint|forest|emerald|moss|bottle green|military|kelp|seaweed|pistachio|matcha|cedar|loden|jungle|tundra|veronese|v[eé]ron[eè]se|eucalyptus|fern|lime|pine|jade|almond green|eden|canopy|mosaic)\b/],
  ["red", /\b(red|rouge|rot|rosso|rojo|burgundy|bordeaux|cherry|scarlet|wine|ruby|crimson|amaranth|tomato|carmine|garnet|merlot|chili|piment|rouge h|tomette|radiant red|primary red)\b/],
  ["pink", /\b(pink|rose|rosa|blush|fuchsia|magenta|peony|raspberry|framboise|berry|baie|powder|candy|salmon|flamingo|grenadine|grenade|watercolor pink|porcelain pink|palomino)\b/],
  ["beige", /\b(beige|sand|sable|nude|camel|taupe|[eé]toupe|desert|dune|dunes|oat|oatmeal|biscuit|natural|naturel|natur|stone|tan|champagne|straw|raffia|clay|glaise|argile|greige|mushroom|vanilla|alabaster|albâtre|sketch|esquisse|pebble|galet|perlino|cashew|wheat|ochre beige|nomad|trench|kraft|almond)\b/],
  ["brown", /\b(brown|marron|braun|marrone|brun|chocolate|chocolat|cognac|tobacco|coffee|caf[eé]|espresso|chestnut|mocha|caramel|ebony|[eé]b[eè]ne|walnut|havana|havane|bark|[eé]corce|umber|cocoa|mahogany|acajou|pecan|p[eé]can|hazelnut|noisette|truffle|rust|brick|brique|cuoio|whisky|cinnamon|toffee|earth|terre|macassar)\b/],
  ["yellow", /\b(yellow|jaune|gelb|giallo|mustard|lemon|honey|miel|ochre|ocre|butter|canary|saffron|sesame|s[eé]same|solar|solaire|barley|sun)\b/],
  ["orange", /\b(orange|apricot|tangerine|terracotta|copper|pumpkin|amber|coral|flame|flamme|canyon|papaya|peach)\b/],
  ["purple", /\b(purple|violet|violett|lilac|lila|lavender|mauve|plum|aubergine|parma|parme|prunoir|orchid|grape|amethyst|iris|wisteria)\b/],
  ["gold", /\b(gold|golden|dor[eé]|or jaune|yellow gold|brass)\b/],
  ["silver", /\b(silver|argent|argent[eé]|silber|argento|chrome|platinum|white gold|palladium)\b/],
  ["multicolor", /\b(multicolou?r|multicolore|multi|bunt|rainbow|camouflage|camo|leopard|python|print|imprim[eé])\b/]];
export function colorTags(...src) {
  const s = " " + src.flat().filter(Boolean).join(" ").toLowerCase().replace(/[\/,·|()-]+/g, " ") + " ";
  return CT_RULES.filter(([, re]) => re.test(s)).map(([k]) => k).join(" ");
}
function colorOf(p, variants) { let c = (variants || []).find(v => v.color)?.color || (p.colors || [])[0]; if (c && isHermesP(p)) c = hermesColor(c); return c ? String(c).slice(0, 40) : null; }
