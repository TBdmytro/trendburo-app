/**
 * Проекция товара для витрины: только то, что нужно клиенту.
 * Закупка, артикулы, исходные названия и техданные в витрину не попадают.
 */
import { effectiveAvailability } from "./match.js";
import { sized } from "./images.js";

const slug = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "").slice(0, 20);

// лёгкий формат: общий префикс адресов фото Shopify заменяется на «~» (витрина возвращает его обратно)
export const SHOP_PRE = "https://cdn.shopify.com/s/files/";
const short = u => typeof u === "string" && u.startsWith(SHOP_PRE) ? "~" + u.slice(SHOP_PRE.length) : u;

export function toStorefront(p, now = Date.now(), { compact = false } = {}) {
  const o = p.overrides || {};
  if (p.status !== "published" || o.hidden) return null;
  const pr = p.pricing || {};
  if (!(pr.ua > 0)) return null;
  const offer = (p.offers || []).find(x => x._key === pr.offerKey) || (p.offers || [])[0];
  // порядок фото — как сохранён (первое = обложка как на сайте бренда). Раньше здесь «убирались копии размеров» по пропорции —
  // это выкидывало настоящую обложку 1600×2000, если рядом было фото крупнее той же пропорции (вид сзади, деталь)
  const imgs = orderWithOverrides(p.images || [], o);
  const variants = (p.variants || []).map(v => {
    const a = offer?.availability?.[v._key];
    const vu = v.images && v.images[0] && v.images[0].url;
    return { color: v.color, size: v.size, image: sized(vu || imgs[0]?.url, 400), idx: vu ? imgs.findIndex(i => i.url === vu) : -1, status: effectiveAvailability(a && a.status, offer?.checkedAt, now, offer?.staleHours || undefined) };
  });
  const colors = [];
  variants.forEach(v => { if (v.color && !colors.some(c => c.name === v.color)) colors.push({ name: v.color, image: v.image, idx: v.idx, available: variants.some(x => x.color === v.color && (x.status === "online" || x.status === "boutique")) }); });
  const statuses = variants.map(v => v.status);
  const sale = activeSale(o.sale, now);
  const cut = x => x > 0 && sale ? Math.round(x * (1 - sale.pct / 100)) : x;
  const summary = statuses.includes("online") ? "online" : statuses.includes("boutique") ? "boutique" : statuses.includes("preorder") ? "preorder" : statuses.includes("ask") ? "ask" : statuses.length && statuses.every(s => s === "out") ? "out" : "unknown";
  return {
    id: p._id, brand: p.brand, bk: slug(p.brand), title: o.title || p.title || p.sourceTitle,
    cat: o.category || p.category || "other", sub: (o.subcategory || ((o.category || p.category) === (p.subFor || p.category) ? p.subcategory : null)) || undefined, g: (o.gender || p.gender) === "m" ? "m" : (o.gender || p.gender) === "w" ? "w" : "u",
    // compact: только исходные адреса (до 12 фото) — размеры витрина подставляет сама; ответ в 2 раза легче
    ...(compact ? { im: imgs.slice(0, 12).map(i => short(i.url)) } : { images: imgs.map(i => ({ src: sized(i.url, 1000), thumb: sized(i.url, 400), big: sized(i.url, 1600) })) }),
    colors: compact ? colors.map(c => ({ ...c, image: short(c.image) })) : colors, sizes: variants.filter(v => v.size).map(v => ({ size: v.size, color: v.color, status: v.status })),
    price: { ua: cut(pr.ua), eu: cut(pr.eu), dxb: cut(pr.dxb) },
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
    fam: famKey(p, o), col: colorOf(p, variants) || undefined
  };
}

function orderWithOverrides(images, o) {
  let list = images.slice();
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
export function famKey(p, o = p.overrides || {}) {
  const t = String(o.title || p.title || p.sourceTitle || "").toLowerCase().replace(/\s*[-–|,/]\s*(colou?r|цвет)?\s*[a-z ]{0,30}$/i, m => COLOR_WORDS.test(m) ? "" : m);
  COLOR_WORDS.lastIndex = 0;
  const base = t.replace(COLOR_WORDS, " ").replace(/[^a-z0-9а-яё]+/gi, " ").replace(/\s+/g, " ").trim();
  if (!base) return undefined;
  // номер модели из артикула — только для общих названий («jacket in lambskin»): если в названии есть имя модели заглавными («LE LOAFER supple in suede») — название и есть модель, артикулы у цветов бывают из разных линеек
  const sku = String(p.modelSku || ""), named = /\b[A-Z][A-Z0-9]{2,}\b/.test(String(o.title || p.title || p.sourceTitle || "")) || base.split(" ").length >= 5, model = !named && /^\d{6}[A-Z0-9]{5,}$/i.test(sku) ? sku.slice(0, 6) : "";
  const k = slug(p.brand) + "|" + base + (model ? "|" + model : ""); let h = 5381; for (let i = 0; i < k.length; i++) h = ((h * 33) ^ k.charCodeAt(i)) >>> 0;
  return h.toString(36); // короткий ключ — каталог не тяжелеет
}
function colorOf(p, variants) { const c = (variants || []).find(v => v.color)?.color || (p.colors || [])[0]; return c ? String(c).slice(0, 40) : null; }
