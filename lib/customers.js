/**
 * Клиенты и их заказы.
 * Клиент — это аккаунт Telegram (id подтверждён подписью). Профиль: получатель, телефон, доставка Новой почтой.
 * Заказы — заявки (lead) с полем tgId; маршрут заказа заполняет менеджер в админке.
 */
import { createHash } from "node:crypto";
import { toStorefront } from "./catalog.js";

const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const NP_TYPES = { branch: "Отделение", locker: "Почтомат", courier: "Курьер" };

/** Профиль из формы: только известные поля, телефон в формате +380… */
export function cleanProfile(p = {}, ua = true) {
  let phone = String(p.phone || "").replace(/[^\d+]/g, "").slice(0, 16);
  // украинский номер без кода страны: 0956318179 / +0956318179 / 80956318179 / 956318179 → +380956318179
  const dg = phone.replace(/\D/g, "");
  // только для доставки по Украине; для Европы/Дубая номер пишут полностью с кодом страны
  if (!ua) {} else if (/^0\d{9}$/.test(dg)) phone = "+38" + dg; else if (/^80\d{9}$/.test(dg)) phone = "+3" + dg; else if (/^[1-9]\d{8}$/.test(dg) && !phone.startsWith("+")) phone = "+380" + dg;
  return {
    name: str(p.name, 80), phone: /^\+?\d{9,15}$/.test(phone) ? (phone.startsWith("+") ? phone : "+" + phone) : "",
    city: str(p.city, 60), npType: NP_TYPES[p.npType] ? p.npType : "branch",
    npPoint: str(p.npPoint, 80), address: str(p.address, 160), comment: str(p.comment, 300)
  };
}

export const customerId = tgId => "customer." + Number(tgId);

/** Открыл приложение — создаём или обновляем карточку клиента. */
export async function touchCustomer(store, user, now = new Date().toISOString()) {
  const id = customerId(user.id), prev = await store.get(id);
  const doc = { ...(prev || { _id: id, _type: "customer", createdAt: now, profile: cleanProfile({ name: user.name }) }), tg: { id: user.id, username: user.username, name: user.name, photo: user.photo }, lastSeen: now };
  return store.put(doc);
}

export async function saveProfile(store, user, profile, now = new Date().toISOString()) {
  const c = await touchCustomer(store, user, now);
  c.profile = cleanProfile(profile); c.updatedAt = now;
  return store.put(c);
}

/** Номер заказа по порядку: TB-1001, TB-1002… (счётчик с защитой от одновременной записи). */
export async function nextOrderNo(store) {
  for (let k = 0; k < 6; k++) {
    const cur = await store.get("counter.orders");
    const n = (cur?.n || 1000) + 1;
    const ok = await store.putIfRev({ ...(cur || { _id: "counter.orders", _type: "counter" }), n }, cur?._rev).catch(() => null);
    if (ok) return "TB-" + n;
  }
  return "TB-" + String(Date.now()).slice(-6);
}

/** Цены пересчитываем по каталогу: клиент не может прислать свою цену. */
export async function verifyItems(store, items, dest = "ua", now = Date.now()) {
  const out = [];
  for (const it of items) {
    const p = it.id ? await store.get(it.id) : null, sf = p ? toStorefront(p, now) : null;
    out.push(sf ? { ...it, brand: sf.brand, title: sf.title, price: sf.price[dest] ?? sf.price.ua, checked: true } : { ...it, checked: false });
  }
  const total = out.every(i => i.checked && i.price > 0) ? out.reduce((a, i) => a + i.price, 0) : null;
  return { items: out, total };
}

/** Что видит клиент в «Мои заказы»: этапы и маршрут, без заметок менеджера. */
export function publicOrder(l) {
  return {
    number: l.number, kind: l.kind, status: l.status, createdAt: l.createdAt, total: l.total, dest: l.dest,
    items: (l.items || []).map(i => ({ id: i.id, brand: i.brand, title: i.title, price: i.price, size: i.size, color: i.color, photo: i.photo || "", icon: i.icon || "" })), viaManager: l.source === "manager", payLater: !!l.payLater, paidAt: l.paidAt || "", prepaid: l.prepaid || 0,
    origin: l.origin || "", delivery: (() => { const d = l.delivery || {}, ph = String(d.phone || ""); return d.city || d.name ? { carrier: (l.dest || "ua") === "ua" ? "np" : "dhl", name: d.name || "", phone: ph ? ph.slice(0, 6) + " ••• •• " + ph.slice(-2) : "", city: d.city || "", npType: d.npType || "", npPoint: d.npPoint || "", address: d.address || "" } : null; })(),
    route: { buyMode: l.buyMode || "boutique", buyCity: l.buyCity || "", buyDate: l.buyDate || "", uaCity: l.uaCity || "", shipDate: l.shipDate || "", npDate: l.npDate || "", track: l.dest && l.dest !== "ua" ? l.track || "" : "" },
    history: (l.history || []).map(h => ({ at: h.at, status: h.status }))
  };
}

export async function ordersFor(store, tgId, client) {
  const mine = await store.list("lead", { tgId: Number(tgId) }, { order: "createdAt desc", limit: 100 });
  // заявки, оставленные до входа с этого же устройства, привязываем к аккаунту
  if (/^[a-z0-9]{16,48}$/i.test(client || "")) {
    const old = (await store.list("lead", { client }, { order: "createdAt desc", limit: 50 })).filter(l => !l.tgId);
    for (const l of old) { l.tgId = Number(tgId); await store.put(l); mine.push(l); }
  }
  // автоматика этапов («Запаковано» в пятницу, «Отримано» через 3 дня после Новой почты)
  try { const { autoAdvance } = await import("./orderflow.js"), { notifyClient } = await import("../api/lead.js"); for (const l of mine) if (await autoAdvance(l, notifyClient)) await store.put(l); } catch (e) { console.log("[auto]", e.message); }
  return mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(publicOrder);
}

export const PAID_ST = ["paid", "bought", "received", "packed", "ready", "shipping", "inua", "np", "delivered"];
const num = (v, max = 1e6) => { const n = Math.round(Number(String(v ?? "").replace(/[\s\u00a0€]/g, "").replace(",", ".")) * 100) / 100; return n > 0 && n <= max ? n : 0; };

/** Заказ, оформленный менеджером вручную (вещи может не быть на сайте): видно в карточке клиента и в «Мои заказы». */
export const ITEM_ICONS = ["bag", "shoes", "clothes", "acc", "jewelry", "watch", "eyewear", "beauty"];
/** Вещи заказа: бренд, модель, размер, цвет, цена, фото, ссылка; id — если вещь из нашего каталога. */
export const cleanItems = arr => (Array.isArray(arr) ? arr : []).slice(0, 20).map(i => ({
    brand: str(i.brand, 60), title: str(i.title, 140), size: str(i.size, 20), color: str(i.color, 40),
    price: num(i.price), photo: /^https:\/\//.test(i.photo || "") ? String(i.photo).slice(0, 500) : "", icon: ITEM_ICONS.includes(i.icon) ? i.icon : "", url: /^https:\/\//.test(i.url || "") ? String(i.url).slice(0, 500) : "", note: str(i.note, 200), cost: num(i.cost), checked: false, manual: true, ...(/^product\.[\w.:-]{3,120}$/.test(String(i.id || "")) ? { id: String(i.id), manual: false } : {})
  })).filter(i => i.title || i.brand);
/** Себестоимость вещей из нашего каталога — по цене закупки (поставщик) или цене бутика; вписанную вручную не трогаем. */
export async function fillCosts(store, items) {
  for (const i of items || []) { if (i.cost || !/^product\./.test(String(i.id || ""))) continue;
    const p = await store.get(i.id).catch(() => null), c = Number(p?.pricing?.purchase) || Number(p?.pricing?.boutique) || 0;
    if (c > 0) { i.cost = Math.round(c); i.costAuto = true; } }
  return items;
}
export async function makeManualOrder(store, customer, input = {}, by = "менеджер", now = new Date().toISOString()) {
  if (!customer?.tg?.id && !customer?.offline) throw new Error("Клиент не найден");
  const items = await fillCosts(store, cleanItems(Array.isArray(input.items) ? input.items : [input]));
  if (!items.length) throw new Error("Укажите вещь: бренд или название");
  const status = ["work", "paid", "bought", "received", "packed", "ready", "shipping", "inua", "np", "delivered"].includes(input.status) ? input.status : "work";
  const total = num(input.total) || items.reduce((a, i) => a + i.price, 0) || null;
  const doc = {
    _id: "lead.m" + createHash("sha1").update(String(customer.tg?.id || customer._id) + now + Math.random()).digest("hex").slice(0, 13), _type: "lead",
    kind: "order", source: "manager", number: await nextOrderNo(store), ...(customer.offline ? { cust: customer._id } : { tgId: Number(customer.tg.id) }),
    tg: { ...(customer.tg?.id ? { id: customer.tg.id } : {}), username: customer.tg?.username || "", name: customer.tg?.name || customer.profile?.name || "" },
    items, total, cost: num(input.cost) || items.reduce((a, i) => a + (i.cost || 0), 0) || null, dest: ["ua", "eu", "dxb"].includes(input.dest) ? input.dest : "ua",
    ...(input.payLater || input.pay === "later" || input.pay === "prepay" ? { payLater: true } : {}), ...(input.pay === "prepay" && num(input.prepaid) ? { prepaid: num(input.prepaid) } : {}), ...(input.pay === "paid" ? { paidAt: now } : {}),
    ...(input.origin ? { origin: str(input.origin, 40) } : {}),
    // получатель на Новой почте / DHL — может быть не сам клиент; нет данных — «пришлёт позже»
    ...(input.delivery && typeof input.delivery === "object" && Object.values(input.delivery).some(v => String(v || "").trim()) ? { delivery: cleanProfile(input.delivery, !["eu", "dxb"].includes(input.dest)) } : {}), ...(input.noAddress ? { noAddress: true } : {}),
    view: tok(12), note: str(input.note, 1000), status, createdAt: input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date + now.slice(10) : now,
    history: [{ at: now, status, by }], manager: by
  };
  return store.put(doc);
}

/** Сводка по клиенту: заказы (с сайта и через менеджера), оплачено, заработок. markup — наценки по направлениям. */
export function clientStats(leads, markup = { ua: 0.2, eu: 0.2, dxb: 0.2 }) {
  const orders = leads.filter(l => l.kind === "order" && l.status !== "cancelled"), paid = orders.filter(l => PAID_ST.includes(l.status));
  const earn = l => l.cost ? (l.total || 0) - l.cost : (l.total || 0) - (l.total || 0) / (1 + (markup[l.dest] ?? markup.ua ?? 0));
  const spent = Math.round(paid.reduce((a, l) => a + (l.total || 0), 0));
  return {
    orders: orders.length, viaManager: orders.filter(l => l.source === "manager").length, requests: leads.filter(l => l.kind !== "order").length,
    spent, earned: Math.round(paid.reduce((a, l) => a + earn(l), 0)), avg: paid.length ? Math.round(spent / paid.length) : 0,
    lastOrder: orders.map(l => l.createdAt).sort().pop() || null
  };
}

/* ---------- Клиенты без приложения (пишут менеджеру в Telegram) ----------
 * Карточку заводит менеджер: customer.x… с offline:true и личной ссылкой-приглашением (invite).
 * Заказы такого клиента — lead с cust = id карточки (без tgId).
 * Клиент открыл ссылку t.me/<бот>?startapp=c_<invite> → Telegram подтвердил его id → всё переносится в его аккаунт customer.<tgId>. */
const tok = n => { const a = "abcdefghjkmnpqrstuvwxyz23456789"; let s = ""; const b = createHash("sha256").update(String(Math.random()) + Date.now()).digest(); for (let i = 0; i < n; i++) s += a[b[i] % a.length]; return s; };
export const INVITE_RE = /^c_([a-z0-9]{12})$/;
/* ссылка на один заказ (startapp=o_…): кто откроет — видит только этот заказ (как трек посылки), без доступа к остальным и без привязки к аккаунту */
export const VIEW_RE = /^o_([a-z0-9]{12})$/;
export async function ensureView(store, l) { if (!l.view) { l.view = tok(12); await store.put(l); } return l.view; }
export async function orderByView(store, t) { if (!/^[a-z0-9]{12}$/.test(String(t || ""))) return null; const [l] = await store.list("lead", { view: String(t) }, { limit: 1 }); return l && l._type === "lead" && l.status !== "cancelled" ? l : null; }
/** Ник в Instagram: «@name», ссылка или просто name → «name» (маленькими). По нему потом узнаём клиента. */
export const normInsta = v => String(v || "").trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "").replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 30);
export async function createOfflineClient(store, input = {}, by = "", now = new Date().toISOString()) {
  const username = String(input.username || "").replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").replace(/[^\w]/g, "").slice(0, 40);
  const insta = normInsta(input.insta), phone = cleanProfile({ phone: input.phone }).phone;
  // хватит одного: Instagram, Telegram или телефон — имя необязательно
  const name = str(input.name, 80) || (insta ? "@" + insta : username ? "@" + username : phone); if (!name) throw new Error("Укажите Instagram, Telegram или телефон клиента");
  const doc = { _id: "customer.x" + tok(10), _type: "customer", offline: true, ...(insta ? { insta } : {}), invite: tok(12), createdAt: now, createdBy: str(by, 60),
    tg: { username, name }, profile: cleanProfile({ name, phone: input.phone, city: input.city, npType: input.npType, npPoint: input.npPoint, address: input.address }),
    sizes: { shoes: str(input.shoes, 20), clothes: str(input.clothes, 20) }, note: String(input.note || "").slice(0, 2000) };
  return store.put(doc);
}
/** Клиент открыл личную ссылку (startapp=c_…). Заказы САМИ НЕ переносятся: любой, у кого ссылка, иначе увидел бы чужие заказы.
 *  Открывший получает доступ в приложение, а у карточки клиента появляется запрос «это я» — менеджер подтверждает (mergeOffline). Сотрудники запросов не создают. */
export async function linkInvite(store, user, invite, now = new Date().toISOString()) {
  const m = INVITE_RE.exec(String(invite || "")); if (!m || !user?.id) return null;
  const [off] = await store.list("customer", { invite: m[1] }, { limit: 1 });
  if (!off || !off.offline) return null;
  const c = await touchCustomer(store, user, now);
  if (c.staff) return { staff: true, name: off.profile?.name || "" };
  if (!c.access || c.access === "pending") { c.access = "ok"; c.accessAt = now; c.accessBy = "посилання від менеджера"; c.registeredAt = c.registeredAt || now; await store.put(c); }
  const claims = (off.claims || []).filter(x => String(x.tgId) !== String(user.id));
  claims.push({ tgId: Number(user.id), username: user.username || "", name: user.name || "", at: now });
  off.claims = claims.slice(-5); await store.put(off);
  return { claim: true, name: off.profile?.name || off.tg?.name || "" };
}
/** Менеджер подтвердил: карточка без приложения (off) — это этот Telegram. Заказы, доставка, заметки переносятся в аккаунт. */
export async function mergeOffline(store, user, off, now = new Date().toISOString()) {
  let c = await touchCustomer(store, user, now);
  const pr = c.profile || {}, op = off.profile || {};
  c.profile = cleanProfile({ ...op, ...Object.fromEntries(Object.entries(pr).filter(([, v]) => v)) });
  c.registeredAt = c.registeredAt || now; c.access = "ok"; c.accessAt = now; c.accessBy = "посилання від менеджера";
  if (off.note) c.note = [c.note, off.note].filter(Boolean).join("\n");
  if (off.insta && !c.insta) c.insta = off.insta;
  if (off.sizes && (off.sizes.shoes || off.sizes.clothes)) c.sizes = { ...off.sizes, ...(c.sizes || {}) };
  c.linkedFrom = off._id; c.linkedAt = now;
  c = await store.put(c);
  const leads = await store.list("lead", { cust: off._id }, { limit: 500 });
  for (const l of leads) { l.tgId = Number(user.id); l.tg = { id: user.id, username: user.username, name: user.name }; l.linkedAt = now; await store.put(l); }
  await store.del(off._id);
  return { customer: c, moved: leads.length, name: op.name || off.tg?.name || "" };
}
