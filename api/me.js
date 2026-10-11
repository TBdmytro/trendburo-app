/**
 * Кабинет клиента. Все запросы POST с подписью Telegram (initData мини-аппа или данные виджета входа).
 * {initData}                       → профиль и заказы
 * {initData, a:"save", profile}    → сохранить данные для доставки
 */
import { getStore } from "../lib/store.js";
import { userFrom } from "../lib/tgauth.js";
import { touchCustomer, saveProfile, ordersFor } from "../lib/customers.js";

const send = (res, code, body) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
function readBody(req) { if (req.body && typeof req.body === "object") return req.body; try { return JSON.parse(req.body || "{}"); } catch { return {}; } }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return send(res, 405, { error: "Метод не поддерживается" });
    const body = readBody(req), user = userFrom(body);
    if (!user) return send(res, 401, { error: "Войдите через Telegram" });
    const store = getStore();
    const c = body.a === "save" ? await saveProfile(store, user, body.profile || {}) : await touchCustomer(store, user);
    const orders = await ordersFor(store, user.id, body.client);
    return send(res, 200, { user: { id: user.id, username: user.username, name: user.name, photo: user.photo, dev: !!user.dev }, profile: c.profile, orders });
  } catch (e) {
    console.error("me:", e.message);
    return send(res, 500, { error: "Не удалось загрузить кабинет" });
  }
}
