/**
 * Наполнение витрины из админки: баннеры, сторис, новости, подборки (ленты товаров) и настройки сайта.
 * Каждый элемент — отдельный документ `cms` с полем kind; порядок — поле order, видимость — active и даты.
 */
import { createHash } from "node:crypto";
import { sized } from "./images.js";

export const KINDS = ["banner", "story", "news", "rail"];
export const ACTION_TYPES = ["none", "product", "brand", "category", "service", "url", "new"];
export const SERVICES = ["concierge", "travel", "resale", "stylist", "optix"];
export const RAIL_RULES = ["new", "all", "category", "brand", "manual", "stock"];
const CATS = ["bags", "shoes", "clothing", "eyewear", "accessories", "jewelry", "watches", "fragrance", "other"];
/* Где можно показать баннер: Лента сверху, Лента между подборками, каталог, начало категории, корзина, экран после заказа */
export const BANNER_PLACES = ["feed", "feed_mid", "catalog", "cart", "after", ...CATS.map(c => "cat:" + c)];
export const cleanPlaces = v => { const out = [...new Set((Array.isArray(v) ? v : []).filter(x => BANNER_PLACES.includes(x)))]; return out.length ? out : ["feed"]; };

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
    doc = { ...base, image: url(d.image), title: str(d.title, 80), subtitle: str(d.subtitle, 160), button: str(d.button, 30), theme: d.theme === "light" ? "light" : "dark", action: cleanAction(d.action),
      places: cleanPlaces(d.places), aud: ["w", "m"].includes(d.aud) ? d.aud : "all" };
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

/* Показы и нажатия баннеров: витрина присылает пачкой раз в несколько секунд; одна пачка — не больше 50 на баннер */
const BN_ID = /^cms\.banner\.[a-z0-9]{6,24}$/;
export async function addBannerStats(store, d = {}) {
  const clean = o => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([k, n]) => BN_ID.test(k) && Number(n) > 0).slice(0, 40).map(([k, n]) => [k, Math.min(50, Math.floor(Number(n)))]));
  const v = clean(d.v), c = clean(d.c);
  if (!Object.keys(v).length && !Object.keys(c).length) return false;
  const s = (await store.get("stats.banners")) || { _id: "stats.banners", _type: "stats", views: {}, clicks: {} };
  const views = { ...(s.views || {}) }, clicks = { ...(s.clicks || {}) };
  for (const [k, n] of Object.entries(v)) views[k] = (views[k] || 0) + n;
  for (const [k, n] of Object.entries(c)) clicks[k] = (clicks[k] || 0) + n;
  await store.put({ ...s, views, clicks, at: new Date().toISOString() });
  return true;
}
export async function bannerStats(store) { const s = await store.get("stats.banners"); return { views: s?.views || {}, clicks: s?.clicks || {} }; }

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
/* Тексты витрины, которые меняются из админки (раздел «Тексты»). Пусто — остаётся текст по умолчанию. */
export const TEXTS = [
  ["Сервисы", "svc.concierge.cap", "Консьерж — метка", "Консьєрж Trend Büro"], ["Сервисы", "svc.concierge.title", "Консьерж — заголовок", "Усе для вас — організуємо"],
  ["Сервисы", "svc.concierge.text", "Консьерж — описание на карточке", "Покупки з доставкою вам у руки, готелі, перельоти, трансфери, бронювання найкращих ресторанів — і все, що ви забажаєте, ми зробимо"],
  ["Сервисы", "svc.concierge.long", "Консьерж — текст на странице сервиса", "Те, що не вміщається в каталог. Опишіть завдання — менеджер повернеться з варіантами, термінами й вартістю."],
  ["Сервисы", "svc.travel.cap", "Путешествия — метка", "Подорожі"], ["Сервисы", "svc.travel.title", "Путешествия — заголовок", "Подорожі під ключ"],
  ["Сервисы", "svc.travel.text", "Путешествия — описание на карточке", "Готелі, перельоти, джети, трансфери, ресторани, охорона"],
  ["Сервисы", "svc.travel.long", "Путешествия — текст на странице сервиса", "Готелі, перельоти, джети, трансфери, ресторани й охорона — зберемо подорож повністю і будемо на звʼязку весь час."],
  ["Сервисы", "svc.resale.cap", "Ресейл — метка", "Ресейл"], ["Сервисы", "svc.resale.title", "Ресейл — заголовок", "Речі з історією"],
  ["Сервисы", "svc.resale.text", "Ресейл — описание на карточке", "Перевіряємо й ведемо угоду"],
  ["Сервисы", "svc.stylist.cap", "ИИ-стилист — метка", "AI-стилист"], ["Сервисы", "svc.stylist.title", "ИИ-стилист — заголовок", "Образ із вітрини"],
  ["Сервисы", "svc.stylist.text", "ИИ-стилист — описание", "Привід, стиль і бюджет — підбір за хвилину"],
  ["Как мы работаем", "how.title", "Заголовок блока", "Як ми працюємо"],
  ["Как мы работаем", "how.1.t", "Шаг 1", "Вибір"], ["Как мы работаем", "how.1.d", "Шаг 1 — пояснение", "У застосунку, сторіс або на сайті бренду"],
  ["Как мы работаем", "how.2.t", "Шаг 2", "Повідомлення"], ["Как мы работаем", "how.2.d", "Шаг 2 — пояснение", "Менеджеру в Telegram або в Direct"],
  ["Как мы работаем", "how.3.t", "Шаг 3", "Викуп"], ["Как мы работаем", "how.3.d", "Шаг 3 — пояснение", "Бутики Європи та онлайн"],
  ["Как мы работаем", "how.4.t", "Шаг 4", "Доставка"],
  ["Цена и доставка", "price.title", "Заголовок блока", "Ціна й доставка"],
  ["Цена и доставка", "price.1.t", "Строка 1", "Ціна в застосунку"], ["Цена и доставка", "price.1.d", "Строка 1 — пояснение", "Вже включає викуп, пакування й комплімент до замовлення"],
  ["Цена и доставка", "price.2.t", "Строка 2", "Доставка в Україну"],
  ["Цена и доставка", "price.3.t", "Строка 3", "Доставка по Європі та в Дубай"], ["Цена и доставка", "price.3.d", "Строка 3 — пояснение", "За тарифом перевізника"],
  ["Доставка в карточке", "dl.ua.days", "Украина — когда отправка", "щосуботи"],
  ["Доставка в карточке", "dl.ua.note", "Украина — пояснение на билете", "Викуповуємо в бутиках Європи та регулярно відправляємо в Україну. Точний маршрут і дату відправки менеджер вкаже у вашому замовленні."],
  ["Доставка в карточке", "dl.ua.np", "Украина — Новая почта", "Нова пошта по Україні — 1–3 дні"],
  ["Доставка в карточке", "dl.eu.days", "Европа и Дубай — дни отправки", "пн – пт"],
  ["Доставка в карточке", "dl.eu.note", "Европа и Дубай — пояснение", "Доставка за чеком перевізника або вже в ціні — уточніть у менеджера."],
  ["Как мы работаем (карточка)", "ch.1.t", "Шаг 1", "Шукаємо за вашим запитом"], ["Как мы работаем (карточка)", "ch.1.d", "Шаг 1 — пояснение", "Знаходимо потрібну модель, розмір і колір."],
  ["Как мы работаем (карточка)", "ch.2.t", "Шаг 2", "Викуповуємо в Європі"], ["Как мы работаем (карточка)", "ch.2.d", "Шаг 2 — пояснение", "Купуємо речі особисто в бутиках Європи."],
  ["Как мы работаем (карточка)", "ch.3.t", "Шаг 3", "Перевірка та пакування"], ["Как мы работаем (карточка)", "ch.3.d", "Шаг 3 — пояснение", "Перевіряємо й дбайливо пакуємо ваше замовлення."],
  ["Как мы работаем (карточка)", "ch.5.t", "Оплата", "Оплата"], ["Как мы работаем (карточка)", "ch.5.d", "Оплата — пояснение", "Менеджер підтверджує наявність і розмір, після цього — оплата зручним способом."]
].map(([group, key, label, def]) => ({ group, key, label, def }));
/* сайт переведён на украинский: старые русские тексты по умолчанию, сохранённые в настройках, заменяем новыми */
const RU_OLD = new Set(["name: \"Ваши бренды\", title: \"Ваши бренды", "name: \"Новости брендов\", title: \"Новости брендов", "name: \"Отправки в Украину\", title: \"Отправки в Украину", "Бутики Европы и онлайн", "В приложении, сторис или на сайте бренда", "Вещи с историей", "Всё для вас — организуем", "Выбор", "Выкуп", "Выкупаем в Европе", "Выкупаем в бутиках Европы и регулярно отправляем в Украину. Точный маршрут и дату отправки менеджер укажет в вашем заказе.", "Доставка в Украину", "Доставка по Европе и в Дубай", "Доставка по чеку перевозчика или уже в цене — уточните у менеджера.", "Ищем по вашему запросу", "Как мы работаем", "Консьерж Trend Büro", "Менеджер подтверждает наличие и размер, после этого — оплата удобным способом.", "Менеджеру в Telegram или в Direct", "Находим нужную модель, размер и цвет.", "Новая почта по Украине — 1–3 дня", "Образ из витрины", "Оплата", "Отели, перелёты, джеты, трансферы, рестораны и охрана — соберём поездку целиком и будем на связи всё время.", "Отели, перелёты, джеты, трансферы, рестораны, охрана", "По тарифу перевозчика", "Повод, стиль и бюджет — подбор за минуту", "Поездки под ключ", "Покупаем вещи лично в бутиках Европы.", "Покупки с доставкой вам в руки, отели, перелёты, трансферы, бронь лучших ресторанов — и всё, что вы загадаете, мы сделаем", "Проверка и упаковка", "Проверяем и бережно упаковываем ваш заказ.", "Проверяем и ведём сделку", "Путешествия", "Сообщение", "То, что не помещается в каталог. Опишите задачу — менеджер вернётся с вариантами, сроками и стоимостью.", "Уже включает выкуп, упаковку и комплимент к заказу", "Цена в приложении", "Цена и доставка", "каждую субботу"]);
export const SERVICE_IDS = ["concierge", "travel", "resale", "stylist"];

/* Блоки «Ленты» в порядке показа. title — заголовок блока на витрине (где он есть). */
export const FEED_BLOCKS = [
  { id: "announce", name: "Объявление" },
  { id: "stories", name: "Сторис" },
  { id: "banners", name: "Обложка: баннеры и коллекции" },
  { id: "newweek", name: "Новинки недели" },
  { id: "newsec", name: "Новое в разделах" },
  { id: "rows", name: "Кроссовки и верхняя одежда" },
  { id: "ship", name: "Отправки в Украину", title: "Відправки в Україну" },
  { id: "optix", name: "OPTIX" },
  { id: "stock", name: "В наличии" },
  { id: "news", name: "Новости брендов", title: "Новини брендів" },
  { id: "follow", name: "Ваши бренды", title: "Ваші бренди" },
  { id: "rails", name: "Подборки товаров" }
];
export function cleanFeed(list, legacy = {}) {
  const ids = FEED_BLOCKS.map(b => b.id), seen = new Set(), out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || !ids.includes(x.id) || seen.has(x.id)) continue; seen.add(x.id);
    const def = FEED_BLOCKS.find(b => b.id === x.id);
    out.push({ id: x.id, on: x.on !== false, ...(def.title !== undefined ? { title: (t => !t || RU_OLD.has(t) ? def.title : t)(str(x.title, 60)) } : {}) });
  }
  // новый блок — на своё место по умолчанию (после соседа сверху), а не в конец ленты
  for (const [i, b] of FEED_BLOCKS.entries()) if (!seen.has(b.id)) { let at = 0; for (let k = i - 1; k >= 0; k--) { const j = out.findIndex(x => x.id === FEED_BLOCKS[k].id); if (j >= 0) { at = j + 1; break; } } out.splice(at, 0, { id: b.id, on: b.id === "announce" ? !!legacy.announce : b.id === "optix" ? legacy.optix !== false : b.id === "stock" ? legacy.stock !== false : true, ...(b.title !== undefined ? { title: b.title } : {}) }); }
  return out;
}

export const SITE_DEFAULTS = {
  contacts: [
    { label: "Менеджер · Telegram", handle: "@trendburomanager", url: "https://t.me/trendburomanager" },
    { label: "Trend Büro · Instagram", handle: "@trendburo_ua", url: "https://www.instagram.com/trendburo_ua" },
    { label: "Men · Instagram", handle: "@trendburo_men", url: "https://www.instagram.com/trendburo_men" },
    { label: "Канал · Telegram", handle: "@trendburo1", url: "https://t.me/trendburo1" },
    { label: "Unique · Telegram", handle: "@trendburounique", url: "https://t.me/trendburounique" }
  ],
  shipWeekday: 5,
  announce: { on: false, text: "" },
  optix: { on: true, url: "https://trendburoglasses.vercel.app/" },
  stockBlock: true,
  // блок «В наличии в Украине» в каталоге: скрыт, пока администратор не включит его в разделе «В наличии»
  stockUa: false,
  brandStories: true,
  theme: { preset: "graphite", accent: "#1f2125", cats: {} }
};
/* Цвета приложения: акцент (кнопки, активное меню, тёмные полосы) и мягкие цвета плиток категорий */
export const THEME_PRESETS = { graphite: "#1f2125", sand: "#7a5a3a", olive: "#4e6340", bordeaux: "#6b2b34", night: "#2f4a66" };
export const CAT_COLORS = { bags: ["#efe7dd", "#7a5a3a"], clothing: ["#e5eaf0", "#3e5670"], shoes: ["#e8ece4", "#4e6340"], accessories: ["#f0e6e6", "#7a4646"], jewelry: ["#eee9f2", "#5e4c78"], watches: ["#e9e9eb", "#45474c"], fragrance: ["#f3ece4", "#7a5f45"], other: ["#ececee", "#45474c"], eyewear: ["#e3e9ef", "#2f4a66"] };
const hex = v => /^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toLowerCase() : null;
export function cleanTheme(t = {}) {
  const preset = THEME_PRESETS[t.preset] ? t.preset : (hex(t.accent) ? "custom" : "graphite");
  const accent = hex(t.accent) || THEME_PRESETS[preset] || THEME_PRESETS.graphite;
  const cats = {};
  for (const [k, v] of Object.entries(t.cats && typeof t.cats === "object" ? t.cats : {})) if (CAT_COLORS[k] && Array.isArray(v) && hex(v[0]) && hex(v[1])) cats[k] = [hex(v[0]), hex(v[1])];
  return { preset, accent, cats };
}
export function cleanSite(d = {}) {
  const s = cleanSiteBase(d);
  s.feed = cleanFeed(d.feed, { announce: s.announce.on, optix: s.optix.on, stock: s.stockBlock });
  const known = new Set(TEXTS.map(t => t.key)), texts = {};
  for (const [k, v] of Object.entries(d.texts && typeof d.texts === "object" ? d.texts : {})) { const t = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 300); if (known.has(k) && t && !RU_OLD.has(t)) texts[k] = t; }
  s.texts = texts;
  s.hiddenServices = (Array.isArray(d.hiddenServices) ? d.hiddenServices : []).filter(x => SERVICE_IDS.includes(x));
  if (Array.isArray(d.feed)) { const on = id => s.feed.find(b => b.id === id).on; s.announce.on = on("announce"); s.optix.on = on("optix"); s.stockBlock = on("stock"); }
  return s;
}
// старые ники-заглушки (trendburo.women / trendburo.men / t.me/trendburo) убираем, настоящие каналы добавляем, если их нет
const OLD_C = /instagram\.com\/trendburo\.(women|men)\b|t\.me\/trendburo\/?$/i;
function fixContacts(list) {
  if (!list.length) return SITE_DEFAULTS.contacts.map(c => ({ ...c }));
  if (!list.some(c => OLD_C.test(c.url || ""))) return list;
  const l = list.filter(c => !OLD_C.test(c.url || ""));
  for (const c of SITE_DEFAULTS.contacts) if (!l.some(x => String(x.url || "").replace(/\/$/, "").toLowerCase() === c.url.toLowerCase())) l.push({ ...c });
  return l.slice(0, 8);
}
function cleanSiteBase(d = {}) {
  const contacts = (Array.isArray(d.contacts) ? d.contacts : []).slice(0, 8).map(c => ({ label: str(c.label, 40), handle: str(c.handle, 40).replace(/trendburo_manager/gi, "trendburomanager"), url: url(String(c.url || "").replace(/trendburo_manager/gi, "trendburomanager")) })).filter(c => c.label && c.url); // менеджер — тот же, что в OPTIX
  return {
    contacts: fixContacts(contacts),
    shipWeekday: [1, 2, 3, 4, 5, 6, 0].includes(Number(d.shipWeekday)) ? Number(d.shipWeekday) : 5,
    announce: { on: !!d.announce?.on, text: str(d.announce?.text, 140) },
    optix: { on: d.optix?.on !== false, url: url(d.optix?.url) || SITE_DEFAULTS.optix.url },
    stockBlock: d.stockBlock !== false,
    stockUa: d.stockUa === true,
    brandStories: d.brandStories !== false,
    railsSeeded: !!d.railsSeeded,
    theme: cleanTheme(d.theme)
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
    banners: pick("banner").map(b => ({ id: b._id, image: img(b.image, 1200), title: b.title, subtitle: b.subtitle, button: b.button, theme: b.theme, action: b.action, places: cleanPlaces(b.places), aud: b.aud || "all" })),
    stories: pick("story").map(s => ({ id: s._id, title: s.title, cover: img(s.cover, 300), slides: s.slides.map(x => ({ image: img(x.image, 1080), caption: x.caption, title: x.title, text: x.text, button: x.button, action: x.action })) })),
    news: pick("news").map(n => ({ id: n._id, image: img(n.image, 900), tag: n.tag, title: n.title, text: n.text, brand: n.brand, action: n.action, at: n.createdAt })),
    rails: pick("rail").map(r => ({ id: r._id, title: r.title, rule: r.rule, value: r.value, gender: r.gender, maxPrice: r.maxPrice, limit: r.limit, ids: r.ids, band: r.band })),
    site: await getSite(store)
  };
}

/** Один раз создать три стандартные подборки (раньше были вшиты в витрину) — теперь их можно править и удалять. */
export async function seedRails(store, by = "admin") {
  const site = await getSite(store);
  if (site.railsSeeded) return false;
  const existing = await listItems(store, "rail");
  if (!existing.length) {
    await saveItem(store, "rail", { title: "Новинки недели", rule: "new", limit: 10, band: true }, by);
    await saveItem(store, "rail", { title: "Сумки до 3 000 €", rule: "category", value: "bags", maxPrice: 3000, limit: 12 }, by);
    await saveItem(store, "rail", { title: "Для него", rule: "all", gender: "m", limit: 12 }, by);
  }
  await saveSite(store, { ...site, railsSeeded: true }, by);
  return true;
}
