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

/** Список адресов фото → упорядоченный (для Dior), без повторов одного кадра; max — сколько оставить. */
export function orderImages(urls, { max = 10 } = {}) {
  const list = [...new Set((urls || []).filter(Boolean).map(String))];
  const info = list.map(u => ({ u, k: diorKind(u) }));
  if (!info.some(x => x.k)) return list.slice(0, max); // не Dior — как пришло
  const sbg = new Set(info.filter(x => x.k?.kind === "sbg").map(x => x.k.key));
  const seen = new Set(), prod = [], model = [], other = [];
  for (const x of info) {
    const k = x.k;
    if (!k) { other.push(x); continue; }
    if (k.kind === "gh" && sbg.has(k.key)) continue; // тот же кадр мелко в рамке
    const dk = k.kind + ":" + k.key; if (seen.has(dk)) continue; seen.add(dk);
    if (k.kind === "model") model.push(x); else if (k.kind === "sbg" || k.kind === "gh") prod.push(x); else other.push(x);
  }
  prod.sort((a, b) => (a.k.e - b.k.e) || ((a.k.kind === "sbg" ? 0 : 1) - (b.k.kind === "sbg" ? 0 : 1)));
  // на модели — хотя бы 1–3 кадра, даже если ракурсов товара много
  const nModel = Math.min(model.length, 3), nProd = Math.max(1, max - nModel);
  const out = [...prod.slice(0, nProd), ...other].slice(0, max - nModel).concat(model.slice(0, nModel));
  return out.map(x => x.u).slice(0, max);
}

/** Есть ли что упорядочивать (Dior). */
export const needsOrder = urls => (urls || []).some(u => !!diorKind(String(u)));
