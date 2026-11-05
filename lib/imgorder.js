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
/**
 * Louis Vuitton: …/louis-vuitton-<название>--M26023_PM2_Front%20view.png?wid=2400&hei=2400
 *   один кадр приходит в 3 видах (…view.png?wid=490, …view.jpg, …_PM2_Front без «view» — у LV это пустая заглушка с монограммой);
 *   оставляем один, в большом размере; порядок: лицевой → бок → сзади → внутри → детали → на модели; баннеры раздела (MEN_BC_…) — не фото товара.
 */
const LV = /(^|\.)louisvuitton\.com$/;
const LV_ORDER = ["front", "side", "back", "interior", "detail", "closeup", "other"];
function lvKind(u) {
  let x; try { x = new URL(u); } catch { return null; }
  if (!LV.test(x.hostname)) return null;
  const name = decodeURIComponent(x.pathname.split("/").pop() || "");
  const m = name.match(/^(.*--([A-Z0-9]+)_([A-Z]{1,3}\d))_(.+?)\s+view(?:\.(?:png|jpe?g|webp))?$/i);
  if (!m) return /--[A-Z0-9]+_[A-Z]{1,3}\d_[^.]+$/i.test(name) ? { kind: "bad" } : { kind: "other", key: name.toUpperCase() };
  const view = m[4].toLowerCase(), dir = x.pathname.split("/").slice(0, -1).join("/");
  const big = x.origin + dir + "/" + encodeURIComponent(m[1] + "_" + m[4] + " view.png").replace(/%2F/gi, "/") + "?wid=2400&hei=2400";
  return { kind: /worn|look|model|ambiance|campaign|lifestyle|contextual|cropped/.test(view) ? "model" : "prod", sku: m[2].toUpperCase(), view, key: m[2].toUpperCase() + "_" + view, big };
}
function lvOrder(list, own, max) {
  const seen = new Set(), prod = [], model = [], other = [];
  // обувь LV: в названиях фото код модели, а не артикул — тогда «свой» код тот, у которого больше всего разных ракурсов
  { const cnt = {}; for (const u of list) { const k = lvKind(u); if (k && (k.kind === "prod" || k.kind === "model")) (cnt[k.sku] = cnt[k.sku] || new Set()).add(k.view); }
    if (!own || !cnt[own]) { let b = "", n = 0; for (const [c, s] of Object.entries(cnt)) if (s.size > n) { n = s.size; b = c; } if (b) own = b; } }
  for (const u of list) {
    const k = lvKind(u);
    if (!k || k.kind === "bad") continue;
    if (k.kind === "other") { other.push(u); continue; }
    if (own && k.sku !== own) continue; // фото другого товара (рекомендации, другие цвета)
    if (seen.has(k.key)) continue; seen.add(k.key);
    (k.kind === "model" ? model : prod).push(k);
  }
  const rank = v => { const i = LV_ORDER.findIndex(x => v.startsWith(x)); return i < 0 ? LV_ORDER.length - 1 : i; };
  prod.sort((a, b) => rank(a.view) - rank(b.view));
  // баннеры раздела — только если у товара вообще нет своих снимков
  return (prod.length || model.length ? [...prod, ...model].map(k => k.big) : other).slice(0, max);
}
/** Есть ли у Louis Vuitton снимки этого товара (по артикулу в названии). */
export const lvOwn = (u, sku) => { const k = lvKind(String(u || "")); return !!(k && (k.kind === "prod" || k.kind === "model") && k.sku === String(sku || "").toUpperCase().replace(/[^A-Z0-9]/g, "")); };
// Gucci: адрес фото задаёт размер и рамку («/style/DarkGray_Center_0_0_490x490/…», бывают баннеры 600x314 и 2400x1200) — всегда квадрат 1200×1200 на фирменном сером фоне: фото заполняет нашу рамку без полос, в хорошем качестве
export function gucciNorm(u) { return /^https:\/\/media\.gucci\.com\/style\/[^/]+\//.test(String(u || "")) ? String(u).replace(/(\/style\/)[^/]+\//, "$1DarkGray_Center_0_0_1200x1200/") : u; }
export function orderImages(urls, { max = 12, sku = "" } = {}) {
  urls = (urls || []).map(gucciNorm);
  // Gucci: только фото с media.gucci.com (без рекламных «LandscapeXL» с ctfassets), один кадр — один раз («…_001_100_0000_Light.jpg» с плитки = «…_001_…-название.jpg»), по номеру кадра
  if (urls.some(u => /^https:\/\/media\.gucci\.com\//.test(String(u)))) { const fk = u => (String(u).match(/\/([A-Z0-9]{6}_[A-Z0-9]{5}_\d{4}_\d{3})_/i) || [])[1] || u, seen = new Set(), out = [];
    for (const u of urls.map(String)) { if (!/^https:\/\/media\.gucci\.com\//.test(u)) continue; const k = fk(u); if (seen.has(k)) continue; seen.add(k); out.push(u); }
    const num = u => +((String(u).match(/_\d{4}_(\d{3})_/) || [])[1] || 999); return out.sort((a, b) => num(a) - num(b)).slice(0, max); }
  const own = String(sku || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if ((urls || []).some(u => lvKind(String(u)))) return lvOrder([...new Set((urls || []).filter(Boolean).map(String))], own, max);
  const seenK = new Set();
  const list = [...new Set((urls || []).filter(Boolean).map(String))].filter(u => !isJunkImg(u)).filter(u => { const k = imgKey(u); if (seenK.has(k)) return false; seenK.add(k); return true; });
  const info = list.map(u => ({ u, k: diorKind(u) }));
  if (!info.some(x => x.k)) { // не Dior: если у фото товара в адресе артикул (Golden Goose, Gucci…), картинки без него — баннеры и подборки со страницы, не берём
    const cmp = u => decodeURIComponent(String(u).split("?")[0]).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const mine = own.length >= 8 ? list.filter(u => cmp(u).includes(own)) : [];
    return (mine.length >= 2 ? mine : list).slice(0, max); }
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
