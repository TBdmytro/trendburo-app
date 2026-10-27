/**
 * Кабинет клиента. Аккаунт = аккаунт Telegram: один Telegram — одна учётная запись, по id (не по нику).
 * GET                                  → готов ли вход (есть ли токен бота) и имя бота для кнопки входа на сайте
 * POST {initData|login, a:"check"}     → есть ли уже учётная запись (ничего не создаёт)
 * POST {initData|login, a:"register", name} → создать учётную запись (или вернуть существующую)
 * POST {initData|login}                → войти: профиль и заказы
 * POST {initData|login, a:"save", profile} → сохранить данные доставки
 */
import { getStore } from "../lib/store.js";
import { userFrom } from "../lib/tgauth.js";
import { touchCustomer, saveProfile, ordersFor, customerId, cleanProfile } from "../lib/customers.js";
import { tg } from "./bot.js";

const send = (res, code, body) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
function readBody(req) { if (req.body && typeof req.body === "object") return req.body; try { return JSON.parse(req.body || "{}"); } catch { return {}; } }
let BOT = null; // имя бота кэшируем на время жизни функции

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const ready = !!process.env.TELEGRAM_BOT_TOKEN || process.env.DEV_AUTH === "1";
      if (ready && !BOT && process.env.TELEGRAM_BOT_TOKEN) { try { BOT = (await tg("getMe", {})).username || null; } catch { BOT = null; } }
      return send(res, 200, { ready, bot: BOT });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Метод не поддерживается" });
    const body = readBody(req);
    if (!process.env.TELEGRAM_BOT_TOKEN && process.env.DEV_AUTH !== "1") return send(res, 503, { error: "Вход через Telegram ещё не подключён", code: "no_token" });
    const user = userFrom(body);
    if (!user) return send(res, 401, { error: "Telegram не подтвердил вход — откройте приложение заново", code: "bad_sign" });
    const store = getStore();
    const pub = { id: user.id, username: user.username, name: user.name, photo: user.photo, dev: !!user.dev };
    if (body.a === "check") {
      const c = await store.get(customerId(user.id));
      return send(res, 200, { exists: !!c, user: pub, profile: c?.profile || null });
    }
    let c;
    if (body.a === "register") {
      c = await touchCustomer(store, user);
      const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (name) { c.profile = cleanProfile({ ...(c.profile || {}), name }); c.registeredAt = c.registeredAt || new Date().toISOString(); c = await store.put(c); }
    } else if (body.a === "save") c = await saveProfile(store, user, body.profile || {});
    else c = await touchCustomer(store, user);
    const orders = await ordersFor(store, user.id, body.client);
    return send(res, 200, { user: pub, profile: c.profile, orders, since: c.registeredAt || c.createdAt || null, loyalty: c.loyalty || null });
  } catch (e) {
    console.error("me:", e.message);
    return send(res, 500, { error: "Не удалось загрузить кабинет" });
  }
}
