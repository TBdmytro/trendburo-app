// Hermès: ремень-конструктор (пряжка + ремень). Сайт продаёт готовые наборы «U_BELT_32_HOMME-<пряжка>-<ремень><размер>».
// Из наборов собираем, какие пряжки и ремни есть для каждой ширины, и цену любой пары:
// цена набора = цена пряжки + цена ремня, поэтому по известным наборам цена считается и для пар, которых в разделе не было
// (если пряжка и ремень связаны через другие наборы). Фото пары рисует сам сервер фото Hermès по двум кодам.

const KIT_RE = /^U_BELT_(\d{2})_(HOMME|FEMME)-(H[0-9A-Z]{10})-(H[0-9A-Z]{10})(\d{3})$/;
export const kitImg = (w, b, s, side = "103", wid = 1200) => `https://assets.hermes.com/is/image/hermesproduct/beltkits-${w}-f34?$leatherstrap=${String(s).replace(/^H/, "")}_composite_${side}&$buckle=${String(b).replace(/^H/, "")}_composite_103&wid=${wid}&extend=0,0,0,0&align=0,0`;
const bName = t => (String(t || "").split(" & ")[0] || "").replace(/^(Wendbare\s+)?Gürtelschließe\s*/i, "").trim() || "Hermès";
const sName = t => (String(t || "").split(" & ")[1] || "").replace(/\s*\d+\s*mm\s*$/i, "").trim();
const DE_RU = { schwarz: "чёрный", braun: "коричневый", grün: "зелёный", grau: "серый", rot: "красный", blau: "синий", beige: "бежевый", "beige/natur": "бежевый", weiß: "белый", orange: "оранжевый", rosa: "розовый", gelb: "жёлтый" };

export function kitModel(kitsObj) {
  const out = {};
  for (const k of Object.values(kitsObj || {})) {
    const m = String(k && k.sku || "").match(KIT_RE); if (!m || !(k.price > 0)) continue;
    const [, w, g, b, s, size] = m, key = w + (g === "FEMME" ? "w" : "");
    const M = out[key] = out[key] || { w: +w, g: g === "FEMME" ? "w" : "m", buckles: {}, straps: {}, combos: [], sizes: new Set() };
    M.buckles[b] = M.buckles[b] || { c: b, name: bName(k.title) };
    const st = M.straps[s] = M.straps[s] || { c: s, name: sName(k.title), cols: {} };
    const col = String(k.color || "").toLowerCase(); if (col) st.cols[col] = (st.cols[col] || 0) + 1;
    M.sizes.add(String(+size));
    M.combos.push({ b, s, p: +k.price, ok: k.stock !== false, url: k.url || "" });
  }
  for (const M of Object.values(out)) {
    // цены частей — по модели (первые 7 знаков: H064544 — пряжка H, H073967 — двусторонний ремень 32 мм): цвет и отделка цену обычно не меняют.
    // Обход связей модель пряжки — модель ремня; первая пряжка компоненты = 0, остальное — разницей. Сумма пары от этого выбора не зависит
    const bp = {}, sp = {}, comp = {}, mb = c => c.slice(0, 7), ms = c => c.slice(0, 7); let ci = 0, bad = 0;
    for (const b0 of Object.keys(M.buckles).map(mb)) { if (b0 in bp) continue; ci++; bp[b0] = 0; comp["b" + b0] = ci; const q = [["b", b0]];
      while (q.length) { const [t, c] = q.shift(); for (const x of M.combos) { const xb = mb(x.b), xs = ms(x.s);
        if (t === "b" && xb === c) { if (!(xs in sp)) { sp[xs] = x.p - bp[c]; comp["s" + xs] = ci; q.push(["s", xs]); } else if (Math.abs(bp[c] + sp[xs] - x.p) > 1) bad++; }
        if (t === "s" && xs === c) { if (!(xb in bp)) { bp[xb] = x.p - sp[c]; comp["b" + xb] = ci; q.push(["b", xb]); } else if (Math.abs(bp[xb] + sp[c] - x.p) > 1) bad++; } } } }
    M.bad = bad;
    M.additive = bad === 0;
    for (const b of Object.values(M.buckles)) { b.p = bp[mb(b.c)]; b.k = comp["b" + mb(b.c)]; }
    for (const s of Object.values(M.straps)) { s.p = sp[ms(s.c)]; s.k = comp["s" + ms(s.c)]; const top = Object.entries(s.cols).sort((a, b) => b[1] - a[1])[0]; s.color = top ? (DE_RU[top[0]] || top[0]) : ""; delete s.cols; }
    // размеры ремня: как у Hermès — 70…120 с шагом 5 (плюс те, что встретились в наборах)
    const sz = new Set(M.sizes); for (let x = 70; x <= 120; x += 5) sz.add(String(x)); M.sizes = [...sz].map(Number).sort((a, b) => a - b).map(String);
    // обложка: классика — пряжка H и чёрный ремень (первый набор с пряжкой «H»), иначе первый набор
    const cover = M.combos.find(x => M.buckles[x.b].name === "H" && /чёрн|schwarz/i.test(M.straps[x.s].color)) || M.combos.find(x => M.buckles[x.b].name === "H") || M.combos[0];
    M.def = cover ? { b: cover.b, s: cover.s, p: cover.p } : null;
  }
  return out;
}

// цена пары: сначала готовый набор, иначе сумма частей (только если части связаны и цены сходятся); null — цену уточнит менеджер
export function kitPrice(M, b, s) {
  const hit = M.combos.find(x => x.b === b && x.s === s); if (hit) return hit.p;
  const B = M.buckles[b], S = M.straps[s];
  return M.additive && B && S && B.k === S.k && B.p != null && S.p != null ? B.p + S.p : null;
}
