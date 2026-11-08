/**
 * Кабинет клиента. Аккаунт = аккаунт Telegram: один Telegram — одна учётная запись, по id (не по нику).
 * GET                                  → готов ли вход (есть ли токен бота) и имя бота для кнопки входа на сайте
 * POST {initData|login, a:"check"}     → есть ли уже учётная запись (ничего не создаёт)
 * POST {initData|login, a:"register", name} → создать учётную запись (или вернуть существующую)
 * POST {initData|login}                → войти: профиль и заказы
 * POST {initData|login, a:"save", profile} → сохранить данные доставки
 */
import { getStore } from "../lib/store.js";
import { userFrom, newLoginCode, pollLoginCode } from "../lib/tgauth.js";
import { touchCustomer, saveProfile, ordersFor, customerId, cleanProfile } from "../lib/customers.js";
import { tg } from "./bot.js";
import { accessSettings, accessOf, notifyRequest, optixRequest, optixOf } from "../lib/access.js";
import { allow, tooMany } from "../lib/ratelimit.js";

const send = (res, code, body) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
function readBody(req) { if (req.body && typeof req.body === "object") return req.body; try { return JSON.parse(req.body || "{}"); } catch { return {}; } }
let BOT = null; // имя бота кэшируем на время жизни функции

export default async function handler(req, res) {
  if (!allow(req, "me", 120, 60000)) return tooMany(res); // защита от флуда с одного адреса
  try {
    if (req.method === "GET") {
      // подборка от менеджера: по ссылке клиент видит выбранные вещи
      const selId = new URL(req.url, "http://x").searchParams.get("sel");
      if (selId) { if (!/^[a-z0-9]{10}$/.test(selId)) return send(res, 404, { error: "Подборка не найдена" }); const d = await getStore().get("selection." + selId); return d ? send(res, 200, { ids: d.ids || [], note: d.note || "", by: d.byName || "Trend Büro", at: d.at }) : send(res, 404, { error: "Подборка не найдена" }); }
      const ready = !!process.env.TELEGRAM_BOT_TOKEN || process.env.DEV_AUTH === "1";
      if (ready && !BOT && process.env.TELEGRAM_BOT_TOKEN) { try { BOT = (await tg("getMe", {})).username || null; } catch { BOT = null; } }
      return send(res, 200, { ready, bot: BOT });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Метод не поддерживается" });
    const body = readBody(req);
    if (!process.env.TELEGRAM_BOT_TOKEN && process.env.DEV_AUTH !== "1") return send(res, 503, { error: "Вход через Telegram ещё не подключён", code: "no_token" });
    if (body.a === "code") { const code = await newLoginCode(getStore()); if (!BOT) { try { BOT = (await tg("getMe", {})).username || null; } catch {} } return send(res, 200, { code, bot: BOT }); }
    if (body.a === "poll") return send(res, 200, await pollLoginCode(getStore(), body.code));
    const user = userFrom(body);
    if (!user) return send(res, 401, { error: "Telegram не подтвердил вход — откройте приложение заново", code: "bad_sign" });
    const store = getStore();
    const pub = { id: user.id, username: user.username, name: user.name, photo: user.photo, dev: !!user.dev };
    if (body.a === "check") {
      const c = await store.get(customerId(user.id));
      const acc = await accessSettings(store);
      return send(res, 200, { exists: !!c, user: pub, profile: c?.profile || null, closed: acc.closed, access: accessOf(c, acc) });
    }
    let c;
    // аккаунт удалён (или его ещё нет) — только через регистрацию, сам он не создаётся
    if (!body.a && !(await store.get(customerId(user.id)))) return send(res, 404, { error: "Аккаунт не найден — зарегистрируйтесь заново", code: "no_account" });
    if (body.a === "register") {
      c = await touchCustomer(store, user);
      const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (name) { c.profile = cleanProfile({ ...(c.profile || {}), name }); c.registeredAt = c.registeredAt || new Date().toISOString(); }
      // заявка на вход: Instagram и пара слов о себе — чтобы было по чему принять решение
      const insta = String(body.insta || "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[^\w.@]/g, "").replace(/^@?/, "@").slice(0, 40), note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (insta.length > 1 || note) c.apply = { insta: insta.length > 1 ? insta : "", note, at: new Date().toISOString() };
      c = await store.put(c);
    } else if (body.a === "save") c = await saveProfile(store, user, body.profile || {});
    else c = await touchCustomer(store, user);
    if (body.a === "sel") { // сотрудник (роль из админки) сохраняет подборку для клиента → ссылка
      if (!c.staff) return send(res, 403, { error: "Только для сотрудников Trend Büro" });
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => /^[\w.:-]{3,80}$/.test(x)))].slice(0, 40);
      if (!ids.length) return send(res, 400, { error: "Подборка пустая" });
      const { randomBytes } = await import("node:crypto"); const id = randomBytes(8).toString("hex").replace(/[^a-z0-9]/g, "").slice(0, 10).padEnd(10, "0");
      await store.put({ _id: "selection." + id, _type: "selection", ids, note: String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 300), by: String(user.id), byName: c.profile?.name || user.name || "Trend Büro", at: new Date().toISOString() });
      if (!BOT && process.env.TELEGRAM_BOT_TOKEN) { try { BOT = (await tg("getMe", {})).username || null; } catch {} }
      const site = "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "trendburo-app.vercel.app");
      return send(res, 200, { id, link: BOT ? `https://t.me/${BOT}?startapp=sel_${id}` : `${site}/?sel=${id}`, web: `${site}/?sel=${id}` });
    }
    if (body.a === "optix") { const st = await optixRequest(store, c); return send(res, 200, { optix: st }); } // заявка на доступ к OPTIX
    const acc = await accessSettings(store), access = accessOf(c, acc);
    if (access === "pending") await notifyRequest(store, c).catch(() => {});
    if (access !== "ok") return send(res, 200, { user: pub, profile: c.profile, orders: [], since: c.registeredAt || c.createdAt || null, closed: acc.closed, access, optix: optixOf(c), staff: !!c.staff });
    const orders = await ordersFor(store, user.id, body.client);
    return send(res, 200, { closed: acc.closed, access, optix: c.staff ? "ok" : optixOf(c), staff: !!c.staff, user: pub, profile: c.profile, orders, since: c.registeredAt || c.createdAt || null, loyalty: c.loyalty || null });
  } catch (e) {
    console.error("me:", e.message);
    return send(res, 500, { error: "Не удалось загрузить кабинет" });
  }
}
