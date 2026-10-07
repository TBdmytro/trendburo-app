/**
 * Заявки с витрины: заказ из корзины, «уточнить наличие», консьерж, поездка, ресейл, запрос под заказ.
 * POST — сохранить заявку (и, если настроено, сразу написать менеджеру в Telegram).
 * GET ?client=… — статусы заявок этого клиента (для «Мои заказы»).
 */
import { getStore } from "../lib/store.js";
import { addBannerStats } from "../lib/cms.js";
import { createHash } from "node:crypto";

export const LEAD_KINDS = { order: "Заказ", availability: "Уточнить наличие", concierge: "Консьерж", travel: "Поездка", resale: "Ресейл", request: "Запрос под заказ", optix: "OPTIX" };
export const LEAD_STATUS = ["new", "work", "paid", "bought", "shipping", "delivered", "cancelled"];
/** Что бот пишет клиенту при смене статуса заказа. */
export const CLIENT_TEXT = {
  work: n => `Заказ ${n} принят менеджером. Скоро напишем по деталям.`,
  paid: n => `Оплата по заказу ${n} получена, спасибо! Выкупаем.`,
  bought: n => `Заказ ${n} выкуплен в бутике. Готовим к отправке.`,
  shipping: (n, track) => `Заказ ${n} в пути.${track ? " Трек-номер: " + track : ""}`,
  delivered: n => `Заказ ${n} доставлен. Спасибо, что выбрали Trend Büro!`,
  cancelled: n => `Заказ ${n} отменён. Если это ошибка — напишите менеджеру.`
};
/** Сообщение клиенту в Telegram от бота (если клиент открывал мини-апп из бота и токен задан). */
export async function notifyClient(lead, status) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = lead.tg?.id;
  const text = CLIENT_TEXT[status]?.(lead.number, lead.track);
  if (!token || !chat || !text) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text }) });
    return r.ok;
  } catch { return false; }
}
const str = (v, n) => String(v ?? "").slice(0, n);

const send = (res, code, body) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
function readBody(req) { if (req.body && typeof req.body === "object") return req.body; try { return JSON.parse(req.body || "{}"); } catch { return {}; } }

export function cleanLead(b) {
  const kind = LEAD_KINDS[b.kind] ? b.kind : "request";
  const client = /^[a-z0-9]{16,48}$/i.test(b.client || "") ? b.client : null;
  if (!client) return { error: "Нет ключа клиента" };
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map(i => ({ id: str(i.id, 60), brand: str(i.brand, 60), title: str(i.title, 120), price: Number(i.price) > 0 ? Math.round(Number(i.price)) : null, size: str(i.size, 20), color: str(i.color, 40) }));
  const tg = b.tg && typeof b.tg === "object" ? { id: Number(b.tg.id) || null, username: str(b.tg.username, 40), name: str([b.tg.first_name, b.tg.last_name].filter(Boolean).join(" "), 80) } : null;
  return {
    lead: {
      kind, client, number: /^[A-Z0-9-]{4,16}$/.test(b.number || "") ? b.number : "TB-" + String(Date.now()).slice(-5),
      message: str(b.message, 3000), items, dest: ["ua", "eu", "dxb"].includes(b.dest) ? b.dest : null,
      total: Number(b.total) > 0 ? Math.round(Number(b.total)) : null, tg, contact: str(b.contact, 120)
    }
  };
}

async function notify(lead) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_MANAGER_CHAT;
  if (!token || !chat) return false;
  const who = lead.tg ? (lead.tg.username ? "@" + lead.tg.username : lead.tg.name || "клиент") : "клиент";
  const text = `🛍 ${LEAD_KINDS[lead.kind]} ${lead.number} от ${who}\n\n${lead.message}`.slice(0, 3900);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
    return r.ok;
  } catch { return false; }
}

export default async function handler(req, res) {
  try {
    const store = getStore();
    if (req.method === "GET") {
      const client = new URL(req.url, "http://x").searchParams.get("client") || "";
      if (!/^[a-z0-9]{16,48}$/i.test(client)) return send(res, 400, { error: "Нет ключа клиента" });
      const list = await store.list("lead", { client }, { order: "createdAt desc", limit: 50, fields: "number, kind, status, createdAt, total, track, items[]{title, brand}" });
      return send(res, 200, { leads: list });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Метод не поддерживается" });
    if (new URL(req.url, "http://x").searchParams.get("a") === "bnstat") { await addBannerStats(store, readBody(req)); return send(res, 200, { ok: true }); }
    const { lead, error } = cleanLead(readBody(req));
    if (error) return send(res, 400, { error });
    // защита от спама: не больше 20 заявок в час с одного устройства
    const recent = await store.list("lead", { client: lead.client }, { order: "createdAt desc", limit: 20, fields: "createdAt" });
    if (recent.length >= 20 && Date.now() - Date.parse(recent[19].createdAt) < 3600e3) return send(res, 429, { error: "Слишком много заявок, попробуйте позже" });
    const now = new Date().toISOString();
    const doc = { _id: "lead." + createHash("sha1").update(lead.client + now + Math.random()).digest("hex").slice(0, 14), _type: "lead", ...lead, status: "new", createdAt: now, history: [{ at: now, status: "new", by: "клиент" }] };
    doc.notified = await notify(doc);
    await store.put(doc);
    return send(res, 200, { ok: true, number: doc.number, notified: doc.notified });
  } catch (e) {
    return send(res, 503, { error: "Не удалось отправить заявку" });
  }
}
