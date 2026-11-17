// Paris Texas: артикул из адреса товара, английские названия, женский пол, категория обуви.
// Только для скрытых (incoming) карточок paristexasbr-…; опубликованные не трогаем.

export const ptCode = url => {
  const h = (String(url || "").match(/\/products\/([^/?#]+)/) || [])[1];
  if (!h) return null;
  const m = h.toLowerCase().match(/(px(?:\d{2,5}x|nl\d{2})[a-z0-9-]+)$/);
  return m ? m[1].replace(/[^a-z0-9]/g, "").toUpperCase() : null;
};

// немецкие слова Paris Texas → английские (порядок важен: длинные раньше)
const W = [
  [/\bOVER-THE-KNEE VELOURSLEDERSTIEFEL\b/, "Over-the-Knee Suede Boots"], [/\bOVER-THE-KNEE LEDERSTIEFEL\b/, "Over-the-Knee Leather Boots"],
  [/\bVELOURSLEDERSTIEFEL\b/, "Suede Boots"], [/\bLEDERSTIEFELETTE\b/, "Leather Ankle Boot"], [/\bGLANZLEDERSTIEFEL\b/, "Glossy Leather Boots"],
  [/\bLEDERSTIEFEL\b/, "Leather Boots"], [/\bWESTERNSTIEFEL\b/, "Western Boots"], [/\bHAARCHALF-STIEFEL\b/, "Calf Hair Boots"],
  [/\bLACKLEDER-PANTOLETTEN\b/, "Patent Leather Mules"], [/\bSLINGBACK-PUMPS\b/, "Slingback Pumps"],
  [/\bAUS GEBÜRSTETEM LEDER\b/, "in Brushed Leather"], [/\bAUS LANGHAARIGEM KASCHMIR\b/, "in Long-Hair Cashmere"], [/\bAUS KIDASSIA-FELL\b/, "in Kidassia Fur"],
  [/\bAUS LACKLEDER\b/, "in Patent Leather"], [/\bAUS SPIEGELLEDER\b/, "in Mirror Leather"], [/\bAUS WILDLEDER\b/, "in Suede"], [/\bAUS LEDER\b/, "in Leather"],
  [/\bIN WEICHEM LEDER\b/, "in Soft Leather"], [/\bIN SCHILDPATT-OPTIK\b/, "with Tortoiseshell Effect"], [/\bIN KROKODILLEDER-OPTIK\b/, "with Crocodile Effect"],
  [/\bMIT LANGHAARIGEM KASCHMIRSTREIFEN\b/, "with Long-Hair Cashmere Strap"], [/\bMIT CUT-OUT-STICKEREI UND HERZ-INLAYS\b/, "with Cut-Out Embroidery and Heart Inlays"],
  [/\bMIT LEOPARDEN-PRINT, CUT-OUT-STICKEREI UND HERZ-INLAYS\b/, "with Leopard Print, Cut-Out Embroidery and Heart Inlays"],
  [/\bMIT KROKO-PRINT-STICKEREI\b/, "with Croco-Print Embroidery"], [/\bMIT PYTHON-PRINT-STICKEREI\b/, "with Python-Print Embroidery"],
  [/\bMIT JUWELEN-SCHNALLE\b/, "with Jewel Buckle"], [/\bMIT SCHLEIFEN-DETAIL\b/, "with Bow Detail"], [/\bMIT SHEARLING-INNENSOHLE\b/, "with Shearling Insole"],
  [/\bMIT METALLKAPPE\b/, "with Metal Toe Cap"], [/\bMIT VINTAGE-EFFEKT\b/, "with Vintage Effect"], [/\bMIT CUT-OUT-EFFEKT\b/, "with Cut-Out Effect"],
  [/\bUND LACKLEDER-DETAILS\b/, "and Patent Leather Details"],
  [/\bVELOURSLEDER\b/, "Suede"], [/\bNAPPALEDER\b/, "Nappa Leather"], [/\bLACKLEDER\b/, "Patent Leather"], [/\bKROKO-PRINT\b/, "Croco-Print"],
  [/\bLEDER\b/, "Leather"], [/\bSTIEFEL\b/, "Boots"], [/\bSANDALE\b/, "Sandal"], [/\bSAMT\b/, "Velvet"]
];
const SMALL = new Set(["in", "with", "and", "of", "the", "a"]);
const titleCase = s => s.toLowerCase().split(" ").map((w, i) => i && SMALL.has(w) ? w : w.replace(/(^|-)(\p{L})/gu, (_, a, b) => a + b.toUpperCase())).join(" ");

export function ptTitle(t) {
  let s = " " + String(t || "").toUpperCase().replace(/\s+/g, " ").trim() + " ";
  for (const [re, en] of W) s = s.replace(new RegExp(re.source, "g"), en.toUpperCase());
  s = s.trim();
  // «MULE IN PATENT LEATHER» → «PATENT LEATHER MULE» (как у бренда по-английски)
  const m = s.match(/^([A-Z-]+(?: [A-Z-]+)?) IN (PATENT LEATHER|MIRROR LEATHER|SUEDE|LEATHER|BRUSHED LEATHER)$/);
  if (m) s = m[2] + " " + m[1];
  return titleCase(s).replace(/Over-The-Knee/, "Over-the-Knee").replace(/^(Boots|Ankle Boot|Western Boots|Western Ankle Boot) in (Leather|Suede|Brushed Leather|Soft Leather)\b/, "$2 $1");
}

export const ptSub = t => /boot/i.test(t) ? "boots" : /slingback|pump/i.test(t) ? "pumps" : /sandal/i.test(t) ? "sandals" : /mule|sabot|clog|slide/i.test(t) ? "slides" : null;

export async function ptFix(st, { apply = false } = {}) {
  const px = "product.manual.paristexasbr-";
  const ids = (await st.list("product", {}, { limit: 60000, fields: "_id, status" })).filter(p => p._id.startsWith(px) && p.status === "incoming").map(p => p._id);
  const docs = await st.getMany(ids);
  const out = { n: docs.length, rename: [], dup: [], noCode: [], title: [], cat: 0, gender: 0 };
  const taken = new Set(ids);
  for (const d of docs) {
    const code = ptCode(d.sourceUrl || d.offers?.[0]?.url);
    const title = ptTitle(d.title), sub = ptSub(title);
    const set = {};
    if (title !== d.title) { set.title = title; set.sourceTitle = title; out.title.push(d.title + " → " + title); }
    if (d.overrides?.title && d.overrides.title !== title) set.overrides = { ...d.overrides, title };
    if (d.gender !== "w") { set.gender = "w"; out.gender++; }
    if (sub && (d.category !== "shoes" || d.subcategory !== sub)) { set.category = "shoes"; set.subcategory = sub; set.subFor = "shoes"; out.cat++; }
    if (!code) { out.noCode.push(d._id); continue; }
    if (d.modelSku !== code) set.modelSku = code;
    const nid = px + code.toLowerCase().slice(0, 30);
    if (nid !== d._id) {
      if (taken.has(nid)) { out.dup.push(d._id.slice(px.length) + " = " + nid.slice(px.length)); continue; }
      out.rename.push(d._id.slice(px.length) + " → " + nid.slice(px.length));
      if (apply) { const { _rev, _updatedAt, _createdAt, ...rest } = d; await st.put({ ...rest, ...set, _id: nid }); await st.del(d._id); }
      taken.add(nid);
    } else if (apply && Object.keys(set).length) await st.patchEach([{ id: d._id, set }]);
  }
  out.title = [...new Set(out.title)];
  return { apply, ...out };
}
