/**
 * Уменьшенная копия PNG (n×n, серый, на белом фоне) — чтобы сравнить два снимка одной вещи.
 * Van Cleef & Arpels: в данных товара одно и то же фото изделия бывает дважды (мелкое и крупное) — мелкое убираем.
 */
import { inflateSync } from "node:zlib";

export function pngSmall(buf, n = 16) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let p = 8, w = 0, h = 0, ct = 0, bd = 0, il = 0; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
    else if (type === "IDAT") idat.push(data); else if (type === "IEND") break;
    p += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct]; if (bd !== 8 || !bpp || !w || !h || il) return null;
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp;
  const sum = new Float64Array(n * n), cnt = new Float64Array(n * n);
  let prev = new Uint8Array(stride), line = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], o = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      line[x] = (raw[o + x] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    const cy = Math.min(n - 1, Math.floor(y * n / h));
    for (let x = 0; x < w; x++) {
      const i = x * bpp; let g = bpp >= 3 ? line[i] * 0.299 + line[i + 1] * 0.587 + line[i + 2] * 0.114 : line[i];
      const al = ct === 6 ? line[i + 3] / 255 : ct === 4 ? line[i + 1] / 255 : 1; g = g * al + 255 * (1 - al);
      const k = cy * n + Math.min(n - 1, Math.floor(x * n / w)); sum[k] += g; cnt[k]++;
    }
    const t = prev; prev = line; line = t;
  }
  const px = new Uint8Array(n * n); for (let k = 0; k < n * n; k++) px[k] = Math.round(sum[k] / (cnt[k] || 1));
  return { w, h, px };
}

/** Средняя разница яркости двух копий (0 — одинаковые, >10 — разные снимки). */
export function smallDiff(a, b) { if (!a || !b || a.px.length !== b.px.length) return 999; let d = 0; for (let i = 0; i < a.px.length; i++) d += Math.abs(a.px[i] - b.px[i]); return d / a.px.length; }
