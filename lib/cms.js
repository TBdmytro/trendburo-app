/**
 * Наполнение витрины из админки: баннеры, сторис, новости, подборки (ленты товаров) и настройки сайта.
 * Каждый элемент — отдельный документ `cms` с полем kind; порядок — поле order, видимость — active и даты.
 */
import { createHash } from "node:crypto";
import { sized } from "./images.js";

export const KINDS = ["banner", "story", "news", "rail"];
export const ACTION_TYPES = ["none", "product", "brand", "category", "service", "url", "new"];
export const SERVICES = ["concierge", "travel", "resale", "stylist", "optix"];
export const RAIL_RULES = ["new", "category", "brand", "manual", "stock"];
const CATS = ["bags", "shoes", "clothing", "eyewear", "accessories", "jewelry", "watches", "fragrance", "other"];

const str = (v, n = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const text = (v, n = 1200) => String(v ?? "").replace(/\r/g, "").trim().slice(0, n);
const url = v => { const s = str(v, 600); return /^https:\/\//.test(s) ? s : ""; };
const date = v => { const s = str(v, 30); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString().slice(0, 10) : null; };
const id = () => createHash("sha1").update(String(Date.now()) + Math.random()).digest("hex").slice(0, 12);

export function cleanAction(a) {
  const type = ACTION_TYPES.includes(a?.type) ? a.type : "none";
  let value = str(a?.value, 600);
  if (type === "url" && !/^https:\/\//.test(value)) return { type: "none", value: "" };
  if (type === "category" && !CATS.includes(value)) return { type: "none", value: "" };
  if (type === "service" && !SERVICES.includes(value)) return { type: "none", value: "" };
  if (type === "product" && !value.startsWith("product.")) return { type: "none", value: "" };
  if (type === "none" || type === "new") value = "";
  return { type, value };
}

/** Проверка и нормализация элемента. Возвращает {doc, errors}. */
export function cleanItem(kind, d) {
  const errors = [];
  const base = { kind, active: d.active !== false, from: date(d.from), to: date(d.to) };
  let doc;
  if (kind === "banner") {
    doc = { ...base, image: url(d.image), title: str(d.title, 80), subtitle: str(d.subtitle, 160), button: str(d.button, 30), theme: d.theme === "light" ? "light" : "dark", action: cleanAction(d.action) };
    if (!doc.image && !doc.title) errors.push("Добавьте фото или заголовок баннера");
  } else if (kind === "story") {
    const slides = (Array.isArray(d.slides) ? d.slides : []).slice(0, 12).map(s => ({ _key: str(s._key, 20) || id(), image: url(s.image), caption: str(s.caption, 40), title: str(s.title, 80), text: str(s.text, 200), button: str(s.button, 30), action: cleanAction(s.action) }))
      .filter(s => s.image || s.title);
    doc = { ...base, title: str(d.title, 24), cover: url(d.cover) || slides[0]?.image || "", slides };
    if (!doc.title) errors.push("Укажите подпись сторис (под кружком)");
    if (!slides.length) errors.push("Добавьте хотя бы один слайд с фото или заголовком");
  } else if (kind === "news") {
    doc = { ...base, image: url(d.image), tag: str(d.tag, 24), title: str(d.title, 100), text: text(d.text, 600), brand: str(d.brand, 60), action: cleanAction(d.action) };
    if (!doc.title) errors.push("Укажите заголовок новости");
  } else if (kind === "rail") {
    const rule = RAIL_RULES.includes(d.rule) ? d.rule : "new";
    doc = { ...base, title: str(d.title, 60), rule, value: str(d.value, 60), gender: ["w", "m"].includes(d.gender) ? d.gender : "", maxPrice: Number(d.maxPrice) > 0 ? Math.round(Number(d.maxPrice)) : null,
      limit: Math.min(24, Math.max(3, Number(d.limit) || 12)), ids: (Array.isArray(d.ids) ? d.ids : []).filter(x => typeof x === "string" && x.startsWith("product.")).slice(0, 40), band: !!d.band };
    if (!doc.title) errors.push("Укажите заголовок подборки");
    if (rule === "category" && !CATS.includes(doc.value)) errors.push("Выберите категорию");
    if (rule === "brand" && !doc.value) errors.push("Выберите бренд");
    if (rule === "manual" && !doc.ids.length) errors.push("Добавьте товары в подборку");
  } else errors.push("Неизвестный тип");
  if (doc && doc.from && doc.to && doc.from > doc.to) errors.push("Дата окончания раньше даты начала");
  return { doc, errors };
}

export async function listItems(store, kind) {
  return store.list("cms", { kind }, { order: "order asc", limit: 200 });
}

export async function saveItem(store, kind, data, by = "admin") {
  if (!KINDS.includes(kind)) throw new Error("Неизвестный тип");
  const { doc, errors } = cleanItem(kind, data || {});
  if (errors.length) throw new Error(errors.join(". "));
  const now = new Date().toISOString();
  const prev = data._id && String(data._id).startsWith("cms." + kind + ".") ? await store.get(data._id) : null;
  let order = prev?.order;
  if (order === undefined) { const all = await listItems(store, kind); order = all.length ? Math.max(...all.map(x => x.order || 0)) + 1 : 0; }
  return store.put({ ...(prev || { _id: `cms.${kind}.${id()}`, _type: "cms", createdAt: now, createdBy: by }), ...doc, order, updatedAt: now, updatedBy: by });
}

export async function deleteItems(store, ids) {
  const ok = (ids || []).filter(x => typeof x === "string" && /^cms\.(banner|story|news|rail)\./.test(x)).slice(0, 200);
  await store.delMany(ok);
  return ok.length;
}

export async function reorder(store, kind, ids) {
  const list = await listItems(store, kind);
  const known = new Set(list.map(x => x._id));
  const order = (ids || []).filter(x => known.has(x));
  list.forEach(x => { if (!order.includes(x._id)) order.push(x._id); });
  for (let i = 0; i < order.length; i++) await store.patchMany([order[i]], { order: i });
  return order.length;
}

export async function setActive(store, ids, active) {
  const ok = (ids || []).filter(x => typeof x === "string" && x.startsWith("cms.")).slice(0, 200);
  await store.patchMany(ok, { active: !!active });
  return ok.length;
}

/* ---------- Настройки сайта ---------- */
export const SITE_DEFAULTS = {
  contacts: [
    { label: "Менеджер · Telegram", handle: "@trendburo_manager", url: "https://t.me/trendburo_manager" },
    { label: "Instagram · женское", handle: "@trendburo.women", url: "https://instagram.com/trendburo.women" },
    { label: "Instagram · мужское", handle: "@trendburo.men", url: "https://instagram.com/trendburo.men" },
    { label: "Канал-витрина", handle: "@trendburo", url: "https://t.me/trendburo" }
  ],
  shipWeekday: 5,
  announce: { on: false, text: "" },
  optix: { on: true, url: "https://trendburoglasses.vercel.app/" },
  stockBlock: true,
  brandStories: true
};
export function cleanSite(d = {}) {
  const contacts = (Array.isArray(d.contacts) ? d.contacts : []).slice(0, 8).map(c => ({ label: str(c.label, 40), handle: str(c.handle, 40), url: url(c.url) })).filter(c => c.label && c.url);
  return {
    contacts: contacts.length ? contacts : SITE_DEFAULTS.contacts,
    shipWeekday: [1, 2, 3, 4, 5, 6, 0].includes(Number(d.shipWeekday)) ? Number(d.shipWeekday) : 5,
    announce: { on: !!d.announce?.on, text: str(d.announce?.text, 140) },
    optix: { on: d.optix?.on !== false, url: url(d.optix?.url) || SITE_DEFAULTS.optix.url },
    stockBlock: d.stockBlock !== false,
    brandStories: d.brandStories !== false
  };
}
export async function getSite(store) { const s = await store.get("settings.site"); return cleanSite(s || SITE_DEFAULTS); }
export async function saveSite(store, d, by = "admin") { const s = cleanSite(d); await store.put({ _id: "settings.site", _type: "settings", ...s, by, at: new Date().toISOString() }); return s; }

/** Наполнение для витрины: только включённые элементы, попадающие в даты показа. */
export async function publicContent(store, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const all = await store.list("cms", { active: true }, { order: "order asc", limit: 400 });
  const live = x => (!x.from || x.from <= today) && (!x.to || x.to >= today);
  const pick = k => all.filter(x => x.kind === k && live(x));
  const img = (u, w) => u ? sized(u, w) : "";
  return {
    banners: pick("banner").map(b => ({ id: b._id, image: img(b.image, 1200), title: b.title, subtitle: b.subtitle, button: b.button, theme: b.theme, action: b.action })),
    stories: pick("story").map(s => ({ id: s._id, title: s.title, cover: img(s.cover, 300), slides: s.slides.map(x => ({ image: img(x.image, 1080), caption: x.caption, title: x.title, text: x.text, button: x.button, action: x.action })) })),
    news: pick("news").map(n => ({ id: n._id, image: img(n.image, 900), tag: n.tag, title: n.title, text: n.text, brand: n.brand, action: n.action, at: n.createdAt })),
    rails: pick("rail").map(r => ({ id: r._id, title: r.title, rule: r.rule, value: r.value, gender: r.gender, maxPrice: r.maxPrice, limit: r.limit, ids: r.ids, band: r.band })),
    site: await getSite(store)
  };
}
