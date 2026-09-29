/** CSV/JSON импорт: разбор и приведение строк к сырому формату, как у страниц источников. */

export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  const s = String(text).replace(/^﻿/, "");
  const delim = (s.split("\n")[0].match(/;/g) || []).length > (s.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  return rows.filter(r => r.some(x => x.trim())).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== "") return o[k]; return null; };
const n = v => { if (v === null) return null; const x = Number(String(v).replace(/[^\d.,-]/g, "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
const list = v => v ? String(v).split(/[|;]/).map(s => s.trim()).filter(Boolean) : [];

/**
 * Строки CSV/JSON → сырые модели. Строки с одинаковым артикулом модели группируются в варианты.
 * Колонки (регистр не важен): brand, title|name, model_sku|sku_model, sku, gtin|ean, color, size, material,
 * category, gender, price|boutique_price, currency, purchase, availability, lead_days, images (через |), url
 */
export function rowsToRaw(rows) {
  const groups = new Map();
  for (const r of rows) {
    const modelSku = pick(r, "model_sku", "sku_model", "style", "model");
    const key = modelSku || pick(r, "sku", "gtin", "ean", "url", "title", "name");
    if (!groups.has(key)) groups.set(key, {
      title: pick(r, "title", "name"), brand: pick(r, "brand"), category: pick(r, "category"), gender: pick(r, "gender"),
      modelSku, gtin: null, colors: [], materials: [], sizes: [], images: [], variants: [], url: pick(r, "url", "link"),
      description: pick(r, "description"), structured: true, warnings: [],
      purchase: n(pick(r, "purchase", "cost", "purchase_price")), leadDays: pick(r, "lead_days", "delivery_days"), region: pick(r, "region", "country")
    });
    const g = groups.get(key);
    const imgs = list(pick(r, "images", "image", "image_link"));
    imgs.forEach(i => { if (!g.images.includes(i)) g.images.push(i); });
    const v = { sku: pick(r, "sku", "variant_sku"), gtin: pick(r, "gtin", "ean"), color: pick(r, "color", "colour"), size: pick(r, "size"), material: pick(r, "material"), images: imgs,
      offers: [{ price: n(pick(r, "price", "boutique_price", "rrp")), currency: pick(r, "currency"), availability: mapAv(pick(r, "availability", "stock")) }] };
    g.variants.push(v);
    ["color", "material", "size"].forEach(k => { const val = v[k]; const arr = k === "color" ? g.colors : k === "material" ? g.materials : g.sizes; if (val && !arr.includes(val)) arr.push(val); });
  }
  return [...groups.values()];
}
function mapAv(v) {
  if (!v) return "unknown";
  const s = String(v).toLowerCase();
  if (/(in.?stock|online|available|yes|есть)/.test(s)) return "online";
  if (/(boutique|store|бутик)/.test(s)) return "boutique";
  if (/(pre.?order|предзаказ)/.test(s)) return "preorder";
  if (/(out|sold|нет|no\b)/.test(s)) return "out";
  return "unknown";
}

export function parseJsonImport(text) {
  const data = JSON.parse(text);
  const rows = Array.isArray(data) ? data : (data.items || data.products || []);
  return rowsToRaw(rows.map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join("|") : v]))));
}
