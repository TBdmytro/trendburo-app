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
import { touchCustomer, saveProfile, ordersFor, customerId, cleanProfile, linkInvite, INVITE_RE } from "../lib/customers.js";
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
      // чтобы было понятно, что за вещь: ссылка на страницу бренда, артикул, фото; и чья это добірка — когда и кто создал, ссылка на неё
      const prods = await Promise.all(items.map(i => store.get(i.id).catch(() => null)));
      const code = id => String(id || "").replace(/^product\.(manual\.)?[a-z0-9]+-/, "").toUpperCase();
      const hm = t => { try { return new Date(t).toLocaleString("uk-UA", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
      const lines = items.map((i, k) => { const p = prods[k], u = p && /^https:\/\//.test(String(p.sourceUrl || "")) ? p.sourceUrl : "", col = p && (p.colors || [])[0];
        return `• <b>${esc(i.b || "")}</b> — ${esc(i.n || i.id)}${i.p ? " — " + esc(i.p) : ""}\n   Арт. <code>${esc(code(i.id))}</code>${col ? " · " + esc(col) : ""}${u ? ` · <a href="${esc(u)}">на сайті бренду</a>` : ""}`; });
      const text = `❤️ <b>Вибір з добірки «${esc(d.title || "Добірка")}»</b>\n${lines.join("\n")}\n\nКлієнт: ${client}${body.msg ? "\nКоментар: " + esc(String(body.msg).slice(0, 300)) : ""}\nДобірка: створена ${esc(hm(d.at))} · ${esc(d.byName || "")}${d.note ? " · " + esc(d.note) : ""}\n<a href="https://trendburo.com.ua/?sel=${id}">Відкрити добірку</a>`;
      const one = items.length === 1 && /^https:\/\//.test(String(items[0].img || "")) && text.length < 1000 ? items[0].img : "";
      const body1 = one ? { photo: one, caption: text, parse_mode: "HTML" } : { text, parse_mode: "HTML", disable_web_page_preview: true };
      let sent = 0; try { await tg(one ? "sendPhoto" : "sendMessage", { chat_id: Number(d.by), ...body1 }); sent++; } catch { try { await tg("sendMessage", { chat_id: Number(d.by), text, parse_mode: "HTML" }); sent++; } catch {} }
      try { const { toAdmins } = await import("../lib/access.js"); sent += await toAdmins(store, body1, undefined, "", one ? "sendPhoto" : "sendMessage"); } catch {}
      // выбрано несколько вещей — фото каждой отдельным сообщением (до 8), чтобы сразу видеть, что выбрали
      if (items.length > 1) for (const i of items.filter(i => /^https:\/\//.test(String(i.img || ""))).slice(0, 8)) {
        const ph = { photo: i.img, caption: `${i.b ? i.b + " — " : ""}${i.n || ""}${i.p ? " — " + i.p : ""}`.slice(0, 900) };
        try { await tg("sendPhoto", { chat_id: Number(d.by), ...ph }); } catch {}
        try { const { toAdmins } = await import("../lib/access.js"); await toAdmins(store, ph, undefined, "", "sendPhoto"); } catch {}
      }
      await store.put({ ...d, picks: [...(d.picks || []), { ids: picks, by: who ? String(who.id) : "", at: new Date().toISOString() }].slice(-20) }).catch(() => {});
      return send(res, 200, { ok: true, sent });
    }
    const user = userFrom(body);
    if (!user) return send(res, 401, { error: "Telegram не підтвердив вхід — відкрийте застосунок знову", code: "bad_sign" });
    const store = getStore();
    const pub = { id: user.id, username: user.username, name: user.name, photo: user.photo, dev: !!user.dev };
    // личная ссылка от менеджера (startapp=c_…): заказы, сделанные через менеджера, переносятся в этот аккаунт; регистрация и заявка не нужны
    let linked = null;
    if (INVITE_RE.test(String(body.invite || ""))) { try { linked = await linkInvite(store, user, body.invite); } catch (e) { console.error("invite:", e.message); }
      if (linked) { try { const { toAdmins } = await import("../lib/access.js"); const e = t => String(t || "").replace(/[<&>]/g, m => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[m]));
        await toAdmins(store, { text: `🔗 <b>${e(linked.name || user.name)}</b> відкрив(ла) особисте посилання${user.username ? " · @" + e(user.username) : ""}\nЗамовлень перенесено в акаунт: ${linked.moved}`, parse_mode: "HTML" }); } catch {} } }
    if (body.a === "check") {
      const c = await store.get(customerId(user.id));
      const acc = await accessSettings(store);
      return send(res, 200, { exists: !!c, user: pub, profile: c?.profile || null, closed: acc.closed, access: accessOf(c, acc), ...(linked ? { linked: { moved: linked.moved, name: linked.name } } : {}) });
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
    if (body.a === "st") { // сотрудник в приложении: заказы (как в админке, без закупочных цен)
      if (!c.staff) return send(res, 403, { error: "Только для сотрудников Trend Büro" });
      const S = await import("../lib/staffops.js"), d = body.d && typeof body.d === "object" ? body.d : {}, by = (c.profile?.name || user.name || "сотрудник") + " · приложение";
      const r = body.op === "leads" ? await S.opLeads(store, d.status, { lite: true }) : body.op === "save" ? await S.opLeadSave(store, d, by) : body.op === "bulk" ? await S.opLeadBulk(store, d, by)
        : body.op === "driver" ? await S.opDriverList(store, d.days) : body.op === "clients" ? await S.opClientsLite(store) : body.op === "order" ? await S.opManualOrder(store, d, by) : body.op === "client" ? await S.opClientCreate(store, d, by) : { code: 400, body: { error: "Неизвестное действие" } };
      if (r.body && r.body.lead) { const { cost, ...l } = r.body.lead; r.body.lead = l; }
      return send(res, r.code, r.body);
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
    // бета-версия сайта (/beta.html) — для команды: сотрудники и те, кто подключён к уведомлениям админки (владелец)
    let beta = !!c.staff; if (!beta) { try { const { adminChats } = await import("../lib/access.js"); beta = (await adminChats(store)).includes(String(user.id)); } catch {} }
    // OPTIX: общий переключатель в админке («OPTIX открыт для всех»). Выключен — закрыт у всех (и у сотрудников), кроме тех, кому вы открыли вручную
    let oxAll = false; try { const { getSite } = await import("../lib/cms.js"); oxAll = !!(await getSite(store)).optix?.open; } catch {}
    const ox = oxAll ? "ok" : optixOf(c);
    if (access === "pending") await notifyRequest(store, c).catch(() => {});
    if (access !== "ok") return send(res, 200, { user: pub, profile: c.profile, orders: [], since: c.registeredAt || c.createdAt || null, closed: acc.closed, access, optix: ox, staff: !!c.staff, beta });
    const orders = await ordersFor(store, user.id, body.client);
    return send(res, 200, { closed: acc.closed, access, optix: ox, staff: !!c.staff, beta, user: pub, profile: c.profile, orders, since: c.registeredAt || c.createdAt || null, loyalty: c.loyalty || null, ...(linked ? { linked: { moved: linked.moved, name: linked.name } } : {}) });
  } catch (e) {
    console.error("me:", e.message);
    return send(res, 500, { error: "Не вдалося завантажити кабінет" });
  }
}
