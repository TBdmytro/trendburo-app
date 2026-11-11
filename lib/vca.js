// Van Cleef & Arpels: у одной модели много версий (металл + камень) с одинаковым названием.
// Версию берём из описания («Vintage Alhambra ring, 18-karat yellow gold, onyx, round diamond; …») и пишем по-русски.
const W = [
  [/(18[- ]?(karat|kt|k)\s*)?(yellow gold|gelbgold)/i, "жёлтое золото"], [/(18[- ]?(karat|kt|k)\s*)?(white gold|wei(ß|ss)gold)/i, "белое золото"],
  [/(18[- ]?(karat|kt|k)\s*)?(rose gold|ros[ée]gold)/i, "розовое золото"], [/(grey|gray|graues|grauem)\s*(mother[- ]of[- ]pearl|perlmutt)/i, "серый перламутр"],
  [/(white|wei(ß|ss)(es|em)?)\s*(mother[- ]of[- ]pearl|perlmutt)/i, "белый перламутр"], [/mother[- ]of[- ]pearl|perlmutt/i, "перламутр"],
  [/onyx/i, "оникс"], [/carnelian|karneol/i, "сердолик"], [/malachit/i, "малахит"], [/chalcedon|chalzedon/i, "халцедон"], [/turquoise|t[üu]rkis/i, "бирюза"],
  [/lapis/i, "лазурит"], [/tiger'?s?[- ]?eye|tigerauge/i, "тигровый глаз"], [/guilloch/i, "гильоше"], [/coral|koralle/i, "коралл"], [/agate|achat/i, "агат"],
  [/amethyst/i, "аметист"], [/emerald|smaragd/i, "изумруд"], [/sapphire|saphir/i, "сапфир"], [/ruby|rubin/i, "рубин"], [/aventur/i, "авантюрин"], [/obsidian/i, "обсидиан"],
  [/pietersit/i, "питерсит"], [/rhodochrosit/i, "родохрозит"], [/wood|holz/i, "дерево"], [/steel|stahl/i, "сталь"], [/leather|leder/i, "кожа"],
  [/diamond|diamant/i, "бриллианты"], [/small model|kleines modell|petit mod/i, "малая модель"], [/large model|gro(ß|ss)es modell|grand mod/i, "большая модель"], [/textured|strukturiert|textur/i, "фактурное золото"]
];
export function vcaVersion(desc) {
  const D = String(desc || ""); // часы: «…case; …bezel; onyx dial; …» — металл корпуса + циферблат
  if (/\b(dial|zifferblatt)\b/i.test(D)) { const segs = D.split(/[;.]/), dial = segs.find(x => /\b(dial|zifferblatt)\b/i.test(x)) || "", cs = segs.find(x => /\b(case|geh[äa]use)\b/i.test(x)) || D;
    const mt = W.slice(0, 3).find(([re]) => re.test(cs)), st = W.slice(3).find(([re]) => re.test(dial.replace(/diamond|diamant/ig, ""))), out = [];
    if (mt) out.push(mt[1]); if (st) out.push("циферблат " + st[1]); if (/diamond|diamant/i.test(cs)) out.push("бриллианты"); if (out.length) return out.join(", "); }
  const d = String(desc || "").split(/[;]|\.(\s|$)/)[0]; const parts = d.split(/,|\s(?:and|und|in|aus)\s/i).slice(1).map(s => s.trim()).filter(Boolean);
  const out = []; for (const pt of parts) { const hit = W.find(([re]) => re.test(pt)); let v = hit ? hit[1] : null; if (v && /золото/.test(v) && /textured|strukturiert/i.test(pt)) v = "фактурное " + v; if (v && !out.includes(v)) out.push(v); }
  return out.length ? out.join(", ").slice(0, 60) : null;
}
export const isVca = p => /^product\.manual\.vancleefarpe-/.test(String(p && p._id || "")) || /van cleef/i.test(String(p && p.brand || ""));
// модель — по адресу (…/vcara41000---vintage-alhambra-ring.html): одинаково на немецком и английском
export const vcaModel = p => { const m = String(p && p.sourceUrl || "").match(/vcar[a-z0-9]+---([a-z0-9-]+)\.html/i); return m ? "vca:" + m[1].toLowerCase().replace(/-(extra-small|extra-large|small|medium|large|mini)-model$/, "").replace(/-\d+-rows?\b/, "").replace(/-\d+-motifs?\b/, "") : null; }; // одна модель: размеры на руку, малая/большая модель, 1 или 3 ряда, 5 или 10 мотивов — версии одной карточки
// название — из адреса (английское, одинаковое для любого рынка): «vintage-alhambra-bracelet-5-motifs» → «Vintage Alhambra Bracelet, 5 Motifs»
export const vcaTitle = url => { const m = String(url || "").match(/vcar[a-z0-9]+---([a-z0-9-]+)\.html/i); if (!m) return null;
  return m[1].split("-").map(w => /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(" ").replace(/ (\d+ (Motifs?|Rows?))$/i, ", $1").replace(/\bAnd\b/g, "and").replace(/\bOf\b/g, "of"); };
// Браслет VCA в разных размерах на руку (Extra Small … Extra Large Model) — на сайте отдельные артикулы с одинаковыми ценой и фото.
// У нас это один товар с размерами XS–XL.
const VSZ = { "extra small": "XS", small: "S", medium: "M", large: "L", "extra large": "XL" };
export function vcaSizeOf(title) { const m = String(title || "").match(/^(.*\bbracelet\b.*?)[,\s]+(extra small|extra large|small|medium|large)\s+model\s*$/i); return m ? { base: m[1].trim().replace(/,$/, ""), sz: VSZ[m[2].toLowerCase()] } : null; }
export const vcaPlainColor = c => String(c || "").replace(/,?\s*(большая|малая|средняя)\s+модель/g, "").trim();
// группы: одно название без размера + один металл/камень + одна цена; ≥2 размера
export function vcaSizeGroups(list, min = 2) { const g = new Map(); for (const p of list) { if (!isVca(p)) continue; const s = vcaSizeOf(p.title); if (!s) continue; const k = [s.base.toLowerCase(), vcaPlainColor((p.colors || [])[0]), (p.offers || [])[0]?.boutique || 0].join("|"); if (!g.has(k)) g.set(k, []); g.get(k).push({ p, ...s }); }
  return [...g.values()].filter(a => a.length >= min && new Set(a.map(x => x.sz)).size === a.length); }
// чем версии одной модели отличаются (кроме металла): «малая модель», «3 ряда», «10 мотивов» — из английского названия
const MRU = { "extra small": "очень малая модель", small: "малая модель", medium: "средняя модель", large: "большая модель", "extra large": "очень большая модель", mini: "мини-модель" };
const ru = (n, one, few, many) => { const a = n % 10, b = n % 100; return n + " " + (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many); };
export function vcaSpec(title) { const t = String(title || ""), out = [];
  const m = t.match(/\b(extra small|extra large|small|medium|large|mini)\s+model\b/i); if (m && !vcaSizeOf(t)) out.push(MRU[m[1].toLowerCase()]);
  const r = t.match(/\b(\d+)\s+rows?\b/i); if (r) out.push(ru(+r[1], "ряд", "ряда", "рядов"));
  const mo = t.match(/\b(\d+)\s+motifs?\b/i); if (mo) out.push(ru(+mo[1], "мотив", "мотива", "мотивов"));
  return out; }
// подпись версии в карточке: металл/камень + отличие модели
export const vcaLabel = p => { const c = vcaPlainColor((p.colors || [])[0]); return [c, ...vcaSpec(p.overrides?.title || p.title)].filter(Boolean).join(", ").slice(0, 60) || null; };
