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
      if (selId) { if (!/^[a-z0-9]{10}$/.test(selId)) return send(res, 404, { error: "Добірку не знайдено" }); const d = await getStore().get("selection." + selId);
        if (!d) return send(res, 404, { error: "Добірку не знайдено" });
        if (d.exp && d.exp < Date.now()) return send(res, 410, { error: "Термін дії добірки минув", expired: true, by: d.byName || "Trend Büro" });
        return send(res, 200, { ids: d.ids || [], items: d.items || [], title: d.title || "", note: d.note || "", by: d.byName || "Trend Büro", at: d.at, exp: d.exp || null }); }
      const ready = !!process.env.TELEGRAM_BOT_TOKEN || process.env.DEV_AUTH === "1";
      if (ready && !BOT && process.env.TELEGRAM_BOT_TOKEN) { try { BOT = (await tg("getMe", {})).username || null; } catch { BOT = null; } }
      return send(res, 200, { ready, bot: BOT });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Метод не поддерживается" });
    const body = readBody(req);
    if (!process.env.TELEGRAM_BOT_TOKEN && process.env.DEV_AUTH !== "1") return send(res, 503, { error: "Вхід через Telegram ще не підключено", code: "no_token" });
    if (body.a === "code") { const code = await newLoginCode(getStore()); if (!BOT) { try { BOT = (await tg("getMe", {})).username || null; } catch {} } return send(res, 200, { code, bot: BOT }); }
    if (body.a === "poll") return send(res, 200, await pollLoginCode(getStore(), body.code));
    if (body.a === "selpick") { // клиент отметил понравившееся в добірці → сообщение менеджеру в Telegram (вход не обязателен)
      if (!allow(req, "selpick", 6, 60000)) return tooMany(res);
      const id = String(body.id || ""); if (!/^[a-z0-9]{10}$/.test(id)) return send(res, 404, { error: "Добірку не знайдено" });
      const store = getStore(), d = await store.get("selection." + id);
      if (!d) return send(res, 404, { error: "Добірку не знайдено" });
      if (d.exp && d.exp < Date.now()) return send(res, 410, { error: "Термін дії добірки минув", expired: true });
      const picks = [...new Set((Array.isArray(body.picks) ? body.picks : []).map(String))].filter(x => (d.ids || []).includes(x)).slice(0, 40);
      if (!picks.length) return send(res, 400, { error: "Оберіть хоча б одну річ" });
      const who = userFrom(body), cl = who ? await store.get(customerId(who.id)).catch(() => null) : null;
      const esc = t => String(t || "").replace(/[<&>]/g, m => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[m]));
      const items = picks.map(x => (d.items || []).find(i => i.id === x) || { id: x });
      const contact = String(body.contact || "").replace(/\s+/g, " ").trim().slice(0, 60);
      const client = who ? `${esc(cl?.profile?.name || who.name || "Клієнт")}${who.username ? " @" + esc(who.username) : ` (<a href="tg://user?id=${who.id}">написати</a>)`}` : (contact ? esc(contact) + " (без входу)" : "клієнт без входу — уточніть у чаті, кому надсилали");
      const text = `❤️ <b>Вибір з добірки «${esc(d.title || "Добірка")}»</b>\n${items.map(i => `• ${esc(i.b || "")} — ${esc(i.n || i.id)}${i.p ? " — " + esc(i.p) : ""}`).join("\n")}\n\nКлієнт: ${client}${body.msg ? "\nКоментар: " + esc(String(body.msg).slice(0, 300)) : ""}`;
      let sent = 0; try { await tg("sendMessage", { chat_id: Number(d.by), text, parse_mode: "HTML" }); sent++; } catch {}
      try { const { toAdmins } = await import("../lib/access.js"); sent += await toAdmins(store, { text, parse_mode: "HTML" }); } catch {}
      await store.put({ ...d, picks: [...(d.picks || []), { ids: picks, by: who ? String(who.id) : "", at: new Date().toISOString() }].slice(-20) }).catch(() => {});
      return send(res, 200, { ok: true, sent });
    }
    const user = userFrom(body);
    if (!user) return send(res, 401, { error: "Telegram не підтвердив вхід — відкрийте застосунок знову", code: "bad_sign" });
    const store = getStore();
    const pub = { id: user.id, username: user.username, name: user.name, photo: user.photo, dev: !!user.dev };
    if (body.a === "check") {
      const c = await store.get(customerId(user.id));
      const acc = await accessSettings(store);
      return send(res, 200, { exists: !!c, user: pub, profile: c?.profile || null, closed: acc.closed, access: accessOf(c, acc) });
    }
    let c;
    // аккаунт удалён (или его ещё нет) — только через регистрацию, сам он не создаётся
    if (!body.a && !(await store.get(customerId(user.id)))) return send(res, 404, { error: "Акаунт не знайдено — зареєструйтеся знову", code: "no_account" });
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
    if (body.a === "sels") { // сотрудник: мои активные добірки (живут 24 часа)
      if (!c.staff) return send(res, 403, { error: "Только для сотрудников Trend Büro" });
      if (!BOT && process.env.TELEGRAM_BOT_TOKEN) { try { BOT = (await tg("getMe", {})).username || null; } catch {} }
      const now = Date.now(), L = (await store.list("selection", {}, { limit: 500 })).filter(x => String(x.by) === String(user.id) && (x.exp || 0) > now).sort((a, b) => (b.exp || 0) - (a.exp || 0)).slice(0, 20);
      return send(res, 200, { sels: L.map(x => { const id = x._id.slice(10); return { id, title: x.title || "Добірка", n: (x.ids || []).length, exp: x.exp, picks: (x.picks || []).length, img: (x.items || []).find(i => i.img)?.img || "", link: BOT ? `https://t.me/${BOT}?startapp=sel_${id}` : `https://trendburo.com.ua/?sel=${id}`, web: `https://trendburo.com.ua/?sel=${id}` }; }) });
    }
    if (body.a === "sel") { // сотрудник (роль из админки) сохраняет подборку для клиента → ссылка
      if (!c.staff) return send(res, 403, { error: "Только для сотрудников Trend Büro" });
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => /^[\w.:-]{3,80}$/.test(x)))].slice(0, 40);
      if (!ids.length) return send(res, 400, { error: "Подборка пустая" });
      const { randomBytes } = await import("node:crypto"); const id = randomBytes(8).toString("hex").replace(/[^a-z0-9]/g, "").slice(0, 10).padEnd(10, "0");
      const str = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n), now = Date.now();
      const items = (Array.isArray(body.items) ? body.items : []).filter(i => i && ids.includes(String(i.id))).slice(0, 40).map(i => ({ id: String(i.id), b: str(i.b, 40), n: str(i.n, 120), p: str(i.p, 24), img: /^https:\/\//.test(String(i.img || "")) ? String(i.img).slice(0, 600) : "" }));
      // добірка живёт 24 часа; просроченные удаляем при создании новой — в базе не копятся
      try { const old = (await store.list("selection", {}, { limit: 500 })).filter(x => (x.exp || (Date.parse(x.at) + 864e5)) < now).map(x => x._id); if (old.length) await store.delMany(old); } catch {}
      await store.put({ _id: "selection." + id, _type: "selection", ids, items, title: str(body.title, 60), note: str(body.note, 300), by: String(user.id), byName: c.profile?.name || user.name || "Trend Büro", at: new Date(now).toISOString(), exp: now + 864e5 });
      if (!BOT && process.env.TELEGRAM_BOT_TOKEN) { try { BOT = (await tg("getMe", {})).username || null; } catch {} }
      const site = "https://trendburo.com.ua";
      return send(res, 200, { id, link: BOT ? `https://t.me/${BOT}?startapp=sel_${id}` : `${site}/?sel=${id}`, web: `${site}/?sel=${id}` });
    }
    if (body.a === "optix") { const st = await optixRequest(store, c); return send(res, 200, { optix: st }); } // заявка на доступ к OPTIX
    const acc = await accessSettings(store), access = accessOf(c, acc);
    // OPTIX: общий переключатель в админке («OPTIX открыт для всех»). Выключен — закрыт у всех (и у сотрудников), кроме тех, кому вы открыли вручную
    let oxAll = false; try { const { getSite } = await import("../lib/cms.js"); oxAll = !!(await getSite(store)).optix?.open; } catch {}
    const ox = oxAll ? "ok" : optixOf(c);
    if (access === "pending") await notifyRequest(store, c).catch(() => {});
    if (access !== "ok") return send(res, 200, { user: pub, profile: c.profile, orders: [], since: c.registeredAt || c.createdAt || null, closed: acc.closed, access, optix: ox, staff: !!c.staff });
    const orders = await ordersFor(store, user.id, body.client);
    return send(res, 200, { closed: acc.closed, access, optix: ox, staff: !!c.staff, user: pub, profile: c.profile, orders, since: c.registeredAt || c.createdAt || null, loyalty: c.loyalty || null });
  } catch (e) {
    console.error("me:", e.message);
    return send(res, 500, { error: "Не вдалося завантажити кабінет" });
  }
}
