/**
 * Закрытый сайт: каталог видят только клиенты, которым вы открыли доступ.
 * Клиент входит через Telegram → заявка «ждёт доступа» → менеджер открывает доступ кнопкой в боте или в админке → клиенту приходит сообщение.
 * Пока сайт открыт, доступ есть у всех.
 */
import { customerId } from "./customers.js";
import { randomBytes } from "node:crypto";
import { tg } from "../api/bot.js";

export const ACCESS_ID = "settings.access";
let MEMO = null;
export const resetAccessMemo = () => { MEMO = null; };
export async function accessSettings(store, { fresh = false } = {}) {
  if (!fresh && MEMO && Date.now() - MEMO.at < 15e3) return MEMO.v;
  const d = await store.get(ACCESS_ID);
  const v = { closed: !!d?.closed };
  MEMO = { v, at: Date.now() };
  return v;
}
/** Статус клиента: ok — пускаем, pending — заявка ждёт, rejected — заявка отклонена, blocked — заблокирован (действует и на открытом сайте). */
export const ACCESS = ["ok", "pending", "rejected", "blocked"];
export const accessOf = (c, s) => (c?.access === "blocked" || c?.access === "rejected" ? c.access : !s.closed ? "ok" : c?.access === "ok" ? "ok" : "pending");

/** Включить/выключить закрытый режим. При включении все, кто уже есть в базе, получают доступ — чтобы не отрезать своих клиентов. */
export async function setClosed(store, closed, now = new Date().toISOString()) {
  const prev = await store.get(ACCESS_ID);
  await store.put({ ...(prev || { _id: ACCESS_ID, _type: "settings" }), closed: !!closed, updatedAt: now });
  let approved = 0;
  if (closed && !prev?.closed) {
    const cs = await store.list("customer", {}, { limit: 10000 });
    const ids = cs.filter(c => !c.access).map(c => c._id);
    if (ids.length) await store.patchMany(ids, { access: "ok", accessAt: now });
    approved = ids.length;
  }
  resetAccessMemo();
  return { closed: !!closed, approved };
}

const SITE = () => (process.env.PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "")).replace(/\/$/, "");

/** Открыть / закрыть доступ клиенту; при открытии — сообщение клиенту в Telegram (если бот может ему писать). */
export async function setAccess(store, tgId, access, { by = "", notify = true, now = new Date().toISOString(), send = tg } = {}) {
  const c = await store.get(customerId(tgId));
  if (!c || c._type !== "customer") return null;
  const was = c.access;
  c.access = ACCESS.includes(access) ? access : "pending";
  c.accessAt = now; c.accessBy = String(by || "").slice(0, 60);
  const saved = await store.put(c);
  if (notify && c.access === "ok" && was !== "ok" && process.env.TELEGRAM_BOT_TOKEN) {
    const url = SITE();
    try { await send("sendMessage", { chat_id: Number(tgId), text: "Доступ к приложению Trend Büro открыт ✦\n\nДобро пожаловать! Каталог, новинки бутиков и ваш кабинет уже доступны.", ...(url ? { reply_markup: { inline_keyboard: [[{ text: "Открыть Trend Büro", web_app: { url: url + "/" } }]] } } : {}) }); } catch {}
  }
  return saved;
}

/** Новая заявка (один раз): клиенту — «заявка принята», менеджеру — заявка с кнопками «Открыть доступ» / «Отклонить». */
export async function notifyRequest(store, c, { send = tg, now = new Date().toISOString() } = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN || c.accessAskedAt) return false;
  await store.patchMany([c._id], { accessAskedAt: now });
  const t = c.tg || {}, name = c.profile?.name || t.name || "Клиент", ap = c.apply || {};
  // клиенту (бот может написать, если человек хоть раз нажимал «Запустить»)
  try { await send("sendMessage", { chat_id: Number(t.id), text: "Заявка принята ✦\n\nСкоро откроем вам доступ к приложению Trend Büro — пришлём уведомление сюда." }); } catch {}
  await toAdmins(store, { text: `Заявка на вход в Trend Büro\n\n${name}${t.username ? " · @" + t.username : ""}${ap.insta ? "\nInstagram: " + ap.insta : ""}${ap.note ? "\n«" + ap.note + "»" : ""}\nTelegram id ${t.id}`,
    reply_markup: { inline_keyboard: [[{ text: "Открыть доступ", callback_data: "ac:ok:" + t.id }, { text: "Отклонить", callback_data: "ac:no:" + t.id }]] } }, send);
  return true;
}

/**
 * Уведомления админу в Telegram: админ (вошёл в админку по паролю) жмёт «Подключить мой Telegram» → одноразовая ссылка
 * t.me/<бот>?start=admin_<код> → бот запоминает этот чат. Туда приходят заявки на вход (с кнопками) и новые заказы.
 * Плюс старый способ — переменная TELEGRAM_MANAGER_CHAT.
 */
export const NOTIFY_ID = "settings.notify";
export async function adminChats(store) {
  const d = await store.get(NOTIFY_ID).catch(() => null);
  const ids = (d?.chats || []).map(c => String(c.id));
  const env = process.env.TELEGRAM_MANAGER_CHAT; if (env && !ids.includes(String(env))) ids.push(String(env));
  return ids;
}
export async function adminLinkCode(store, by = "", now = Date.now()) {
  const code = randomBytes(10).toString("hex");
  await store.put({ _id: "adminlink." + code, _type: "adminlink", by: String(by).slice(0, 60), exp: now + 15 * 60e3 });
  return code;
}
/** Бот: /start admin_<код> — подключить этот чат к уведомлениям. */
export async function adminLinkConfirm(store, code, chat, from, now = Date.now()) {
  if (!/^[a-f0-9]{20}$/.test(String(code || ""))) return null;
  const l = await store.get("adminlink." + code);
  if (!l || l.exp < now) return null;
  await store.del("adminlink." + code);
  const d = (await store.get(NOTIFY_ID)) || { _id: NOTIFY_ID, _type: "settings", chats: [] };
  const entry = { id: Number(chat.id), name: [from?.first_name, from?.last_name].filter(Boolean).join(" ") || chat.title || "Чат", username: from?.username || "", at: new Date(now).toISOString(), by: l.by };
  d.chats = (d.chats || []).filter(c => String(c.id) !== String(chat.id)).concat(entry).slice(-10);
  await store.put(d);
  return entry;
}
export async function adminUnlink(store, id) {
  const d = await store.get(NOTIFY_ID); if (!d) return;
  d.chats = (d.chats || []).filter(c => String(c.id) !== String(id)); await store.put(d);
}
/** Отправить всем подключённым админам. */
export async function toAdmins(store, body, send = tg) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return 0;
  let n = 0; for (const chat of await adminChats(store)) { try { await send("sendMessage", { chat_id: chat, ...body }); n++; } catch {} }
  return n;
}
