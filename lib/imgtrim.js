/**
 * Фото во всю вертикальную рамку 4:5: убираем пустые поля (ровные полосы одного цвета вокруг снимка, мелкий товар
 * в большой рамке) и широкие кадры показываем вертикально, как на сайте бренда. Находим их по уменьшенной копии из нашего хранилища и обрезаем через параметр rect
 * хранилища Sanity — сам файл не меняется. Полосы ровного цвета — это не часть снимка, поэтому лицо, ноги или
 * товар обрезаться не могут; вокруг содержимого оставляем небольшой отступ.
 */
import { pngGray } from "./imgdedupe.js";

const dims = u => { const m = String(u).match(/-(\d+)x(\d+)\.\w+(?:\?|$)/); return m ? [Number(m[1]), Number(m[2])] : null; };
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/** Поля по уменьшенной серой копии: { t, r, b, l } в её пикселях. */
export function flatMargins(g, { tol = 5 } = {}) {
  const { w, h, px } = g;
  const row = y => px.subarray(y * w, y * w + w), col = x => { const c = new Uint8Array(h); for (let y = 0; y < h; y++) c[y] = px[y * w + x]; return c; };
  const flat = (line, ref) => { for (let i = 0; i < line.length; i++) if (Math.abs(line[i] - ref) > tol) return false; return true; };
  const side = (n, get) => { const ref = median(get(0)); let k = 0; while (k < n - 1 && flat(get(k), ref)) k++; return k; };
  const t = side(h, y => row(y)), b = side(h, y => row(h - 1 - y)), l = side(w, x => col(x)), r = side(w, x => col(w - 1 - x));
  return { t, r, b, l };
}

/**
 * Каждое фото — вертикальный кадр 4:5 во всю рамку, без полос и пустых полей (как у Dior на сайте).
 *  • снимок во всю высоту (крупный план, на модели) шире 4:5 — по центру 4:5 на всю высоту: высота целиком (лицо и ноги на месте), по бокам — немного фона;
 *  • товар на ровном фоне — кадр 4:5 вокруг товара с запасом; товар не режется никогда (не помещается — оставляем как есть);
 *  • уже вертикальный кадр без полей — не трогаем.
 * Возвращает "x,y,w,h" в пикселях оригинала или null.
 */
export function rectFor(g, W, H, { pad = 0.12 } = {}) {
  const m = flatMargins(g), R = 0.8; // 4:5
  const cw = g.w - m.l - m.r, ch = g.h - m.t - m.b;
  if (cw <= 0 || ch <= 0 || cw * ch < g.w * g.h * 0.02) return null; // пустой кадр — не трогаем
  const kx = W / g.w, ky = H / g.h;
  let x0 = m.l * kx, y0 = m.t * ky, x1 = (g.w - m.r) * kx, y1 = (g.h - m.b) * ky; // содержимое в пикселях оригинала
  const photo = m.t <= 1 && m.b <= 1; // снимок упирается в верх и низ — это фото (крупный план, на модели), а не товар на фоне
  if (photo) {
    if ((x1 - x0) / (y1 - y0) <= R + 0.02) { if (m.l + m.r < 2) return null; } // уже вертикальный: только полосы по бокам
    else { const bw = (y1 - y0) * R, cx = (x0 + x1) / 2; x0 = cx - bw / 2; x1 = cx + bw / 2; } // по центру 4:5, высота целиком
  } else {
    // товар на ровном фоне: 4:5 вокруг товара с запасом
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, iw = x1 - x0, ih = y1 - y0;
    let bw = Math.max(iw * (1 + 2 * pad), ih * (1 + 2 * pad) * R), bh = bw / R;
    if (bh > H) { bh = H; bw = bh * R; } if (bw > W) { bw = W; bh = bw / R; }
    const nx0 = Math.min(Math.max(0, cx - bw / 2), W - bw), ny0 = Math.min(Math.max(0, cy - bh / 2), H - bh);
    if (nx0 <= x0 + 1 && ny0 <= y0 + 1 && nx0 + bw >= x1 - 1 && ny0 + bh >= y1 - 1) { x0 = nx0; y0 = ny0; x1 = nx0 + bw; y1 = ny0 + bh; }
    else return null; // товар во всю ширину — в 4:5 целиком не влезает, резать нельзя: оставляем как есть
  }
  const x = Math.max(0, Math.round(x0)), y = Math.max(0, Math.round(y0)), w = Math.min(W - x, Math.round(x1 - x0)), h = Math.min(H - y, Math.round(y1 - y0));
  if (w >= W * 0.98 && h >= H * 0.98) return null;
  return `${x},${y},${w},${h}`;
}

/** Адрес фото из хранилища → тот же адрес с обрезкой пустых полей (или как был). */
export async function trimUrl(u, { fetchImpl = fetch } = {}) {
  if (!/^https:\/\/cdn\.sanity\.io\/images\//.test(u) || /[?&]rect=/.test(u)) return u;
  const d = dims(u); if (!d) return u;
  try {
    const r = await fetchImpl(u.split("?")[0] + "?w=200&fm=png");
    if (!r.ok) return u;
    const g = pngGray(Buffer.from(await r.arrayBuffer())); if (!g || g.w < 20 || g.h < 20) return u;
    const rect = rectFor(g, d[0], d[1]);
    return rect ? u.split("?")[0] + "?rect=" + rect : u;
  } catch { return u; }
}
