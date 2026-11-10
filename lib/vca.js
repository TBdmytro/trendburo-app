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
  [/diamond|diamant/i, "бриллианты"]
];
export function vcaVersion(desc) {
  const d = String(desc || "").split(/[;.]/)[0]; const parts = d.split(",").slice(1).map(s => s.trim()).filter(Boolean);
  const out = []; for (const pt of parts) { const hit = W.find(([re]) => re.test(pt)); const v = hit ? hit[1] : null; if (v && !out.includes(v)) out.push(v); }
  return out.length ? out.join(", ").slice(0, 60) : null;
}
export const isVca = p => /^product\.manual\.vancleefarpe-/.test(String(p && p._id || "")) || /van cleef/i.test(String(p && p.brand || ""));
// модель — по адресу (…/vcara41000---vintage-alhambra-ring.html): одинаково на немецком и английском
export const vcaModel = p => { const m = String(p && p.sourceUrl || "").match(/vcar[a-z0-9]+---([a-z0-9-]+)\.html/i); return m ? "vca:" + m[1].toLowerCase() : null; };
// название — из адреса (английское, одинаковое для любого рынка): «vintage-alhambra-bracelet-5-motifs» → «Vintage Alhambra Bracelet, 5 Motifs»
export const vcaTitle = url => { const m = String(url || "").match(/vcar[a-z0-9]+---([a-z0-9-]+)\.html/i); if (!m) return null;
  return m[1].split("-").map(w => /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(" ").replace(/ (\d+ (Motifs?|Rows?))$/i, ", $1").replace(/\bAnd\b/g, "and").replace(/\bOf\b/g, "of"); };
