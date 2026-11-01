/**
 * Пустые поля вокруг фото (ровные полосы одного цвета: фото на модели, вставленное в широкий серый/белый холст,
 * или мелкий кадр «в рамке»). Находим их по уменьшенной копии из нашего хранилища и обрезаем через параметр rect
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

/** Прямоугольник обрезки "x,y,w,h" в пикселях оригинала или null (полей нет / слишком мало / подозрительно много). */
export function rectFor(g, W, H, { pad = 0.05, min = 0.04 } = {}) {
  const m = flatMargins(g);
  const cw = g.w - m.l - m.r, ch = g.h - m.t - m.b;
  if (cw <= 0 || ch <= 0) return null;
  if (cw * ch < g.w * g.h * 0.02) return null; // почти всё ровное — пустой кадр, не трогаем
  if ((m.t + m.b) / g.h < min && (m.l + m.r) / g.w < min) return null; // полей почти нет
  // трогаем только явные случаи: широкий холст с полосами по бокам (фото на модели) или мелкий товар в большой рамке.
  // Обычный снимок товара на ровном фоне (товар занимает больше половины кадра) оставляем как есть
  const wide = W / H > 1.15 && (m.l + m.r) / g.w > 0.1, tiny = (cw * ch) / (g.w * g.h) < 0.45;
  if (!wide && !tiny) return null;
  const k = W / g.w, px = Math.round(Math.max(cw, ch) * pad);
  const x0 = Math.max(0, m.l - px), y0 = Math.max(0, m.t - px), x1 = Math.min(g.w, g.w - m.r + px), y1 = Math.min(g.h, g.h - m.b + px);
  const x = Math.round(x0 * k), y = Math.round(y0 * (H / g.h)), w = Math.min(W - x, Math.round((x1 - x0) * k)), h = Math.min(H - y, Math.round((y1 - y0) * (H / g.h)));
  if (w >= W * 0.97 && h >= H * 0.97) return null;
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
