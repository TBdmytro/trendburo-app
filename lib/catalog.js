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
  const summary = statuses.includes("online") ? "online" : statuses.includes("boutique") ? "boutique" : statuses.includes("preorder") ? "preorder" : statuses.length && statuses.every(s => s === "out") ? "out" : "unknown";
  return {
    id: p._id, brand: p.brand, bk: slug(p.brand), title: o.title || p.title || p.sourceTitle,
    cat: o.category || p.category || "other", g: p.gender === "m" ? "m" : p.gender === "w" ? "w" : "u",
    images: imgs.map(i => ({ src: sized(i.url, 800), thumb: sized(i.url, 400) })),
    colors, sizes: variants.filter(v => v.size).map(v => ({ size: v.size, color: v.color, status: v.status })),
    price: { ua: pr.ua, eu: pr.eu, dxb: pr.dxb },
    availability: summary, orderable: summary === "online",
    checkedAt: offer?.checkedAt || null, isNew: p.publishedAt ? now - Date.parse(p.publishedAt) < 14 * 864e5 : false,
    stock: p.stock || null
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
