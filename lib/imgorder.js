/**
 * Порядок фото товара с сайта бренда: первым — лицевой кадр товара, дальше остальные ракурсы, в конце — на модели.
 * Dior (assets.christiandior.com / media.christiandior.com):
 *   {SKU}_E01?$default_GH$…   — тот же кадр, что {SKU}_SBG_E01, но мелко в большой рамке → берём только если SBG-версии нет
 *   {SKU}_SBG_E01…E11         — ракурсы товара (меньший номер — лицевой)
 *   LOOK_…_E19 / media…/pm_…  — на модели (образ)
 */
const DIOR = /(^|\.)christiandior\.com$/;

function diorKind(u) {
  let x; try { x = new URL(u); } catch { return null; }
  if (!DIOR.test(x.hostname)) return null;
  if (x.hostname.startsWith("media.")) return { kind: "model", key: x.pathname };
  const name = decodeURIComponent(x.pathname.split("/").pop() || "");
  if (/^LOOK_/i.test(name)) return { kind: "model", key: name.toUpperCase() };
  const m = name.match(/^([A-Z0-9]+?)(_SBG)?_E(\d+)(?:-\d+)?$/i);
  if (!m) return { kind: "other", key: name.toUpperCase() };
  return { kind: m[2] ? "sbg" : "gh", sku: m[1].toUpperCase(), e: +m[3], key: m[1].toUpperCase() + "_E" + m[3] };
}

/** Список адресов фото → упорядоченный (для Dior), без повторов одного кадра; max — сколько оставить (все кадры страницы товара, до 12). */
/** Один и тот же кадр в разных размерах (Cloudinary: …/upload/w_900…/v123/NAME.jpg и …/w_1400…/NAME.jpg) — один ключ. */
export function imgKey(u) {
  try { const x = new URL(u), name = x.pathname.split("/").pop(); return /\/upload\//.test(x.pathname) ? x.hostname + "/" + name : x.hostname + x.pathname; } catch { return String(u); }
}
/** Не фото товара: баннеры («PrenotaAppuntamento_2560x590» — запись в бутик), логотипы, широкие полосы. */
export function isJunkImg(u) {
  const n = (() => { try { return decodeURIComponent(String(u).split("?")[0].split("/").pop() || ""); } catch { return ""; } })();
  if (/(prenota|appuntamento|appointment|banner|newsletter|placeholder|logo|sprite|icon[-_])/i.test(n)) return true;
  const m = n.match(/(\d{3,4})x(\d{2,4})/); return !!(m && Number(m[1]) / Number(m[2]) > 2);
}
export function orderImages(urls, { max = 12, sku = "" } = {}) {
  const own = String(sku || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const seenK = new Set();
  const list = [...new Set((urls || []).filter(Boolean).map(String))].filter(u => !isJunkImg(u)).filter(u => { const k = imgKey(u); if (seenK.has(k)) return false; seenK.add(k); return true; });
  const info = list.map(u => ({ u, k: diorKind(u) }));
  if (!info.some(x => x.k)) return list.slice(0, max); // не Dior — как пришло
  const sbg = new Set(info.filter(x => x.k?.kind === "sbg").map(x => x.k.key));
  const seen = new Set(), prod = [], model = [], other = [];
  for (const x of info) {
    const k = x.k;
    if (!k) { other.push(x); continue; }
    // фото другого товара со страницы (рекомендации «носят вместе», другие цвета: футболка на странице кепки) — не берём
    if (own && (k.kind === "gh" || k.kind === "sbg") && k.sku.replace(/[^A-Z0-9]/g, "") !== own) continue;
    if (k.kind === "gh" && sbg.has(k.key)) continue; // тот же кадр мелко в рамке
    const dk = k.kind + ":" + k.key; if (seen.has(dk)) continue; seen.add(dk);
    if (k.kind === "model") model.push(x); else if (k.kind === "sbg" || k.kind === "gh") prod.push(x); else other.push(x);
  }
  prod.sort((a, b) => (a.k.e - b.k.e) || ((a.k.kind === "sbg" ? 0 : 1) - (b.k.kind === "sbg" ? 0 : 1)));
  // берём все кадры с сайта; если их больше лимита — ракурсов товара до 7, остальное место — фото на модели (все)
  const nModel = Math.min(model.length, max - Math.min(prod.length + other.length, 7)), nProd = Math.max(1, max - nModel);
  const out = [...prod.slice(0, nProd), ...other].slice(0, max - nModel).concat(model.slice(0, nModel));
  return out.map(x => x.u).slice(0, max);
}

/** Есть ли что упорядочивать (Dior). */
export const needsOrder = urls => (urls || []).some(u => !!diorKind(String(u)));
