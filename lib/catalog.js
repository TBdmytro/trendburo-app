/**
 * Проекция товара для витрины: только то, что нужно клиенту.
 * Закупка, артикулы, исходные названия и техданные в витрину не попадают.
 */
import { effectiveAvailability } from "./match.js";
import { sized } from "./images.js";

const slug = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "").slice(0, 20);

export function toStorefront(p, now = Date.now()) {
  const o = p.overrides || {};
  if (p.status !== "published" || o.hidden) return null;
  const pr = p.pricing || {};
  if (!(pr.ua > 0)) return null;
  const offer = (p.offers || []).find(x => x._key === pr.offerKey) || (p.offers || [])[0];
  const imgs = orderWithOverrides(p.images || [], o);
  const variants = (p.variants || []).map(v => {
    const a = offer?.availability?.[v._key];
    return { color: v.color, size: v.size, image: sized((v.images && v.images[0] && v.images[0].url) || imgs[0]?.url, 400), status: effectiveAvailability(a && a.status, offer?.checkedAt, now) };
  });
  const colors = [];
  variants.forEach(v => { if (v.color && !colors.some(c => c.name === v.color)) colors.push({ name: v.color, image: v.image, available: variants.some(x => x.color === v.color && (x.status === "online" || x.status === "boutique")) }); });
  const statuses = variants.map(v => v.status);
  const sale = activeSale(o.sale, now);
  const cut = x => x > 0 && sale ? Math.round(x * (1 - sale.pct / 100)) : x;
  const summary = statuses.includes("online") ? "online" : statuses.includes("boutique") ? "boutique" : statuses.includes("preorder") ? "preorder" : statuses.length && statuses.every(s => s === "out") ? "out" : "unknown";
  return {
    id: p._id, brand: p.brand, bk: slug(p.brand), title: o.title || p.title || p.sourceTitle,
    cat: o.category || p.category || "other", g: (o.gender || p.gender) === "m" ? "m" : (o.gender || p.gender) === "w" ? "w" : "u",
    images: imgs.map(i => ({ src: sized(i.url, 1000), thumb: sized(i.url, 400), big: sized(i.url, 1600) })),
    colors, sizes: variants.filter(v => v.size).map(v => ({ size: v.size, color: v.color, status: v.status })),
    price: { ua: cut(pr.ua), eu: cut(pr.eu), dxb: cut(pr.dxb) },
    oldPrice: sale ? { ua: pr.ua, eu: pr.eu, dxb: pr.dxb } : undefined,
    sale: sale ? sale.pct : undefined, saleUntil: sale && sale.until ? sale.until : undefined,
    dims: o.dims || undefined, material: o.material || undefined,
    availability: summary, orderable: summary === "online",
    checkedAt: offer?.checkedAt || null,
    isNew: o.isNew === "on" && (!o.newUntil || now < endOf(o.newUntil)),
    stock: cleanStock(o.stock || p.stock)
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

/** Конец дня/минуты, до которой действует метка: «2026-10-15» — включительно весь день. */
function endOf(d) { const s = String(d); return Date.parse(s.length === 10 ? s + "T23:59:59" : s); }

/** Скидка действует, пока не наступила дата окончания; после — цена возвращается сама. */
export function activeSale(s, now = Date.now()) {
  if (!s || !(s.pct >= 1 && s.pct <= 90)) return null;
  if (s.until && !(now < endOf(s.until))) return null;
  return { pct: s.pct, until: s.until || null };
}
