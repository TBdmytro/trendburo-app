/**
 * Закрытый сайт: каталог видят только клиенты, которым вы открыли доступ.
 * Клиент входит через Telegram → заявка «ждёт доступа» → менеджер открывает доступ кнопкой в боте или в админке → клиенту приходит сообщение.
 * Пока сайт открыт, доступ есть у всех.
 */
import { customerId } from "./customers.js";
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
    try { await send("sendMessage", { chat_id: Number(tgId), text: "Доступ к Trend Büro открыт ✦\n\nДобро пожаловать — каталог и ваш кабинет уже доступны.", ...(url ? { reply_markup: { inline_keyboard: [[{ text: "Открыть Trend Büro", web_app: { url: url + "/" } }]] } } : {}) }); } catch {}
  }
  return saved;
}

/** Новая заявка: один раз сообщаем менеджеру с кнопками «Открыть доступ» / «Отклонить». */
export async function notifyRequest(store, c, { send = tg, now = new Date().toISOString() } = {}) {
  const chat = process.env.TELEGRAM_MANAGER_CHAT;
  if (!chat || !process.env.TELEGRAM_BOT_TOKEN || c.accessAskedAt) return false;
  await store.patchMany([c._id], { accessAskedAt: now });
  const t = c.tg || {}, name = c.profile?.name || t.name || "Клиент", ap = c.apply || {};
  try {
    await send("sendMessage", { chat_id: chat, text: `Заявка на вход в Trend Büro\n\n${name}${t.username ? " · @" + t.username : ""}${ap.insta ? "\nInstagram: " + ap.insta : ""}${ap.note ? "\n«" + ap.note + "»" : ""}\nTelegram id ${t.id}`,
      reply_markup: { inline_keyboard: [[{ text: "Открыть доступ", callback_data: "ac:ok:" + t.id }, { text: "Отклонить", callback_data: "ac:no:" + t.id }]] } });
    return true;
  } catch { return false; }
}
