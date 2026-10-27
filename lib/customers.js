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
export function cleanProfile(p = {}) {
  const phone = String(p.phone || "").replace(/[^\d+]/g, "").slice(0, 16);
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
    items: (l.items || []).map(i => ({ id: i.id, brand: i.brand, title: i.title, price: i.price, size: i.size, color: i.color, photo: i.photo || "" })), viaManager: l.source === "manager",
    route: { buyMode: l.buyMode || "boutique", buyCity: l.buyCity || "", buyDate: l.buyDate || "", uaCity: l.uaCity || "", shipDate: l.shipDate || "", npDate: l.npDate || "", track: l.track || "" },
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
  return mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(publicOrder);
}

export const PAID_ST = ["paid", "bought", "shipping", "np", "delivered"];
const num = (v, max = 1e6) => { const n = Math.round(Number(String(v ?? "").replace(/[\s\u00a0€]/g, "").replace(",", ".")) * 100) / 100; return n > 0 && n <= max ? n : 0; };

/** Заказ, оформленный менеджером вручную (вещи может не быть на сайте): видно в карточке клиента и в «Мои заказы». */
export async function makeManualOrder(store, customer, input = {}, by = "менеджер", now = new Date().toISOString()) {
  if (!customer?.tg?.id) throw new Error("Клиент не найден");
  const items = (Array.isArray(input.items) ? input.items : [input]).slice(0, 20).map(i => ({
    brand: str(i.brand, 60), title: str(i.title, 140), size: str(i.size, 20), color: str(i.color, 40),
    price: num(i.price), photo: /^https:\/\//.test(i.photo || "") ? String(i.photo).slice(0, 500) : "", url: /^https:\/\//.test(i.url || "") ? String(i.url).slice(0, 500) : "", checked: false, manual: true
  })).filter(i => i.title || i.brand);
  if (!items.length) throw new Error("Укажите вещь: бренд или название");
  const status = ["work", "paid", "bought", "shipping", "np", "delivered"].includes(input.status) ? input.status : "work";
  const total = num(input.total) || items.reduce((a, i) => a + i.price, 0) || null;
  const doc = {
    _id: "lead.m" + createHash("sha1").update(customer.tg.id + now + Math.random()).digest("hex").slice(0, 13), _type: "lead",
    kind: "order", source: "manager", number: await nextOrderNo(store), tgId: Number(customer.tg.id),
    tg: { id: customer.tg.id, username: customer.tg.username, name: customer.tg.name },
    items, total, cost: num(input.cost) || null, dest: ["ua", "eu", "dxb"].includes(input.dest) ? input.dest : "ua",
    note: str(input.note, 1000), status, createdAt: input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date + now.slice(10) : now,
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
