/**
 * Дубли фото: сайт бренда отдаёт одно и то же фото в нескольких размерах (200, 400, 600 … 2608 px) — на витрине это
 * выглядело как повторы и мелкие размытые кадры. Сравниваем сами картинки: у хранилища Sanity берём копию 8×8,
 * считаем «отпечаток» (средняя яркость) и оставляем из одинаковых самое крупное фото. Порядок кадров сохраняется.
 */
import { inflateSync } from "node:zlib";

/** Мини-разбор PNG (8 бит, RGB/RGBA/серый) — только для крошечных копий 8×8. */
export function pngGray(buf) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let p = 8, w = 0, h = 0, ct = 0, bd = 0; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === "IDAT") idat.push(data); else if (type === "IEND") break;
    p += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct]; if (bd !== 8 || !bpp || !w || !h) return null;
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, out = new Uint8Array(w * h);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      line[x] = (line[x] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0; x < w; x++) { const i = x * bpp; out[y * w + x] = bpp >= 3 ? Math.round(line[i] * 0.299 + line[i + 1] * 0.587 + line[i + 2] * 0.114) : line[i]; }
    prev = line;
  }
  return { w, h, px: out };
}

const dims = u => { const m = String(u).match(/-(\d+)x(\d+)\.\w+(?:\?|$)/); return m ? [Number(m[1]), Number(m[2])] : null; };
async function hashOf(u, fetchImpl = fetch) {
  if (!/^https:\/\/cdn\.sanity\.io\/images\//.test(u)) return null;
  try {
    const r = await fetchImpl(u.split("?")[0] + "?w=24&h=30&fit=fill&fm=png");
    if (!r.ok) return null;
    const g = pngGray(Buffer.from(await r.arrayBuffer())); if (!g || g.px.length !== g.w * g.h || g.px.length < 64) return null;
    return { px: g.px };
  } catch { return null; }
}
// одно и то же фото в разных размерах после уменьшения почти совпадает попиксельно; разные ракурсы — заметно отличаются
const close = (a, b) => { if (a.px.length !== b.px.length) return false; let diff = 0; for (let i = 0; i < a.px.length; i++) diff += Math.abs(a.px[i] - b.px[i]); return diff / a.px.length < 4; };

/** Убирает повторы одного и того же фото (разные размеры). Возвращает список адресов без дублей. */
export async function dedupeImages(urls, { fetchImpl = fetch } = {}) {
  const list = [...new Set((urls || []).filter(Boolean))]; if (list.length < 2) return list;
  const hs = await Promise.all(list.map(u => hashOf(u, fetchImpl)));
  const groups = [];
  list.forEach((u, i) => {
    const d = dims(u), h = hs[i];
    // склеиваем только разные размеры (у двух разных кадров одного размера — никогда) с той же пропорцией
    const g = h && d && groups.find(x => x.h && x.d && (x.d[0] !== d[0] || x.d[1] !== d[1]) && !x.sizes.has(d[0] + "x" + d[1]) && Math.abs(x.d[0] / x.d[1] - d[0] / d[1]) < 0.03 && close(x.h, h));
    if (g) { g.sizes.add(d[0] + "x" + d[1]); if (d[0] * d[1] > g.d[0] * g.d[1]) { g.u = u; g.d = d; } } else groups.push({ u, d, h, sizes: new Set(d ? [d[0] + "x" + d[1]] : []) });
  });
  return groups.map(g => g.u);
}

/**
 * Обложка как на сайте бренда: фото с плитки раздела. Ищем такое же среди фото товара (попиксельно, в уменьшенном виде) и ставим первым;
 * если такого нет — добавляем фото с плитки первым. Делается один раз на товар (coverFrom).
 */
export async function coverFromTile(store, p, tileUrl, { fetchImpl = fetch, fetchBinary } = {}) {
  if (!p || !tileUrl || p.coverFrom || p.overrides?.cover) return false;
  const imgs = p.images || []; if (!imgs.length) return false;
  let up;
  try { const b = await fetchBinary(tileUrl, [new URL(tileUrl).hostname]); up = await store.uploadImage(b.buf, { filename: "tile-" + Date.now() + "." + (b.type.split("/")[1] || "jpg"), contentType: b.type, sourceUrl: tileUrl }); } catch { return false; }
  const th = await hashOf(up.url, fetchImpl); if (!th) return false;
  const hs = await Promise.all(imgs.map(i => hashOf(i.url, fetchImpl)));
  let best = -1, bd = 1e9;
  hs.forEach((h, i) => { if (!h || h.px.length !== th.px.length) return; let diff = 0; for (let k = 0; k < h.px.length; k++) diff += Math.abs(h.px[k] - th.px[k]); diff /= h.px.length; if (diff < bd) { bd = diff; best = i; } });
  if (best >= 0 && bd < 10) { if (best > 0) p.images = [imgs[best], ...imgs.filter((_, i) => i !== best)]; }
  else p.images = [{ url: up.url, sourceUrl: up.url, rights: "copied" }, ...imgs].slice(0, 12);
  p.coverFrom = "tile";
  return true;
}
