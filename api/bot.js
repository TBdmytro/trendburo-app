/**
 * Telegram-бот: настройка кнопки мини-аппа и ответы на команды.
 * Токен — только в переменной окружения TELEGRAM_BOT_TOKEN, в браузер и логи не попадает.
 *  /start — приветствие с картинкой и кнопками; /catalog, /orders, /manager, /how
 *  /admin — кнопка «Открыть админку» (сама админка по-прежнему под паролем)
 *  /id    — номер этого чата (для TELEGRAM_MANAGER_CHAT)
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "../lib/store.js";
import { confirmLoginCode } from "../lib/tgauth.js";
import { setAccess, adminChats, adminLinkConfirm } from "../lib/access.js";

export const botToken = () => process.env.TELEGRAM_BOT_TOKEN || "";
export const hookSecret = (t = botToken()) => createHash("sha256").update("tbhook|" + t).digest("hex").slice(0, 40);
// основной адрес сайта: ночной запуск приходит на служебный адрес сборки, а он закрыт защитой Vercel — шаги загрузки туда не доходят
export const publicUrl = req => (process.env.PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "") || "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "")).replace(/\/$/, "");

export async function tg(method, body, { token = botToken(), fetchImpl = fetch } = {}) {
  if (!token) throw new Error("Не задан TELEGRAM_BOT_TOKEN");
  const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error("Telegram: " + (j.description || "ошибка " + r.status));
  return j.result;
}

const MANAGER = "https://t.me/trendburomanager";
export const BOT_TEXT = {
  short: "Шопінг став ще швидшим і зручнішим. Економте час і гроші разом із Trend Büro ✦",
  about: "Trend Büro ✦ шопінг став ще швидшим і зручнішим\n\nУ нашому застосунку ви економите головне — свій час і гроші. Без перельотів, черг і переплат.\n\n⚡️ В наявності — речі вже у нас, відправимо одразу\n🛍 З сайтів брендів — Louis Vuitton, Dior, Prada, Gucci, Miu Miu: замовимо для вас\n🤍 Офіційні бутики та перевірка кожної речі\n✈️ Доставка в Україну, Європу та Дубай\n💬 Немає потрібної моделі — напишіть менеджеру, пошукаємо\n\nВідкривайте каталог 👇",
  welcome: "<b>Ласкаво просимо до Trend Büro</b> ✦\n\nШопінг став ще швидшим і зручнішим: бутики Європи тепер у вашому телефоні. У нашому застосунку ви економите свій час і гроші — без перельотів, черг і переплат.\n\n<b>Що на вітрині</b>\n⚡️ В наявності — речі вже у нас, відправимо одразу\n🛍 З сайтів брендів — замовимо для вас в офіційному бутику\n\n<b>Як це працює</b>\n<b>1.</b> Обираєте річ у каталозі\n<b>2.</b> Менеджер підтверджує наявність і фінальну ціну\n<b>3.</b> Викуповуємо та перевіряємо кожну деталь\n<b>4.</b> Доставляємо в Україну, Європу або Дубай\n\nОплата — 100% передоплата, фінальна ціна без прихованих доплат ✨",
  how: "<b>Як ми працюємо</b>\n\n<b>Вибір.</b> Речі в наявності вже у нас — відправимо одразу. Решту замовимо з сайту бренду. Немає потрібної моделі — напишіть менеджеру, пошукаємо.\n\n<b>Підтвердження.</b> Менеджер перевіряє наявність і називає фінальну ціну — без прихованих доплат.\n\n<b>Викуп.</b> Купуємо в офіційному бутику, перевіряємо річ, комплектацію та чек.\n\n<b>Доставка.</b> Відправляємо в Україну, Європу або Дубай. Маршрут посилки — у «Моїх замовленнях».\n\nШопінг став ще швидшим і зручнішим — а ви економите час і гроші ✦",
};
const kbMain = base => ({ inline_keyboard: [[{ text: "Відкрити каталог", web_app: { url: base + "/#catalog" } }], [{ text: "Написати менеджеру", url: MANAGER }, { text: "Як ми працюємо", callback_data: "how" }]] });

/** Настроить бота: описание, кнопка меню, команды, приём сообщений. Возвращает имя бота. */
export async function setupBot(base, opts = {}) {
  if (!/^https:\/\//.test(base)) throw new Error("Нужен адрес сайта https://");
  const me = await tg("getMe", {}, opts);
  await tg("setMyShortDescription", { short_description: BOT_TEXT.short }, opts);
  await tg("setMyDescription", { description: BOT_TEXT.about }, opts);
  await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Відкрити Trend Büro", web_app: { url: base + "/" } } }, opts);
  await tg("setMyCommands", { commands: [
    { command: "start", description: "Головне меню Trend Büro" },
    { command: "catalog", description: "Відкрити каталог" },
    { command: "orders", description: "Мої замовлення" },
    { command: "manager", description: "Написати менеджеру" },
  ] }, opts);
  await tg("setWebhook", { url: base + "/api/bot", secret_token: hookSecret(opts.token), allowed_updates: ["message", "callback_query"], drop_pending_updates: true }, opts);
  return { username: me.username, name: me.first_name };
}

/** Ответ на команду: { method, ...поля } — sendPhoto для приветствия, иначе sendMessage. */
export function replyFor(text, base, chatId) {
  const cmd = String(text || "").trim().split(/[\s@]/)[0].toLowerCase();
  if (cmd === "/admin") return { method: "sendMessage", text: "Админка Trend Büro. Вход по паролю.", reply_markup: { inline_keyboard: [[{ text: "Открыть админку", web_app: { url: base + "/admin.html" } }]] } };
  if (cmd === "/id") return { method: "sendMessage", text: `Номер этого чата: ${chatId}\nЧтобы заявки приходили сюда, впишите его в Vercel как TELEGRAM_MANAGER_CHAT.` };
  if (cmd === "/catalog") return { method: "sendMessage", text: "Каталог Trend Büro — новинки бутиків Європи, оновлюється прямо з їхніх сайтів.", reply_markup: { inline_keyboard: [[{ text: "Відкрити каталог", web_app: { url: base + "/#catalog" } }]] } };
  if (cmd === "/orders") return { method: "sendMessage", text: "Ваші замовлення та маршрут посилки — в особистому кабінеті.", reply_markup: { inline_keyboard: [[{ text: "Мої замовлення", web_app: { url: base + "/#account" } }]] } };
  if (cmd === "/manager") return { method: "sendMessage", text: "Менеджер на зв’язку: питання про замовлення, наявність і доставку.", reply_markup: { inline_keyboard: [[{ text: "Написати менеджеру", url: MANAGER }]] } };
  if (cmd === "/how") return { method: "sendMessage", parse_mode: "HTML", text: BOT_TEXT.how, reply_markup: kbMain(base) };
  return { method: "sendPhoto", photo: base + "/brand/bot-welcome.jpg?v=3", caption: BOT_TEXT.welcome, parse_mode: "HTML", reply_markup: kbMain(base) };
}

async function send(chatId, r) {
  const { method, ...body } = r;
  try { return await tg(method, { chat_id: chatId, ...body }); }
  catch (e) { if (method === "sendPhoto") return tg("sendMessage", { chat_id: chatId, text: body.caption, parse_mode: body.parse_mode, reply_markup: body.reply_markup }); throw e; }
}

export default async function handler(req, res) {
  const done = () => { res.statusCode = 200; res.setHeader("Content-Type", "application/json"); res.end("{}"); };
  if (req.method !== "POST" || !botToken()) return done();
  const got = Buffer.from(String(req.headers["x-telegram-bot-api-secret-token"] || "")), want = Buffer.from(hookSecret());
  if (got.length !== want.length || !timingSafeEqual(got, want)) { res.statusCode = 401; return res.end(); }
  let u = req.body; if (typeof u === "string") { try { u = JSON.parse(u); } catch { u = {}; } }
  const m = u?.message, cq = u?.callback_query;
  const lg = m?.chat?.id && typeof m.text === "string" && m.text.match(/^\/start\s+login_([a-f0-9]{24})$/);
  const al = m?.chat?.id && typeof m.text === "string" && m.text.match(/^\/start\s+admin_([a-f0-9]{20})$/);
  if (al) {
    let ok = null; try { ok = await adminLinkConfirm(getStore(), al[1], m.chat, m.from); } catch {}
    try { await tg("sendMessage", { chat_id: m.chat.id, text: ok ? "✓ Готово. Сюда будут приходить уведомления Trend Büro: заявки на вход (с кнопками «Открыть доступ» / «Отклонить») и новые заказы." : "Ссылка устарела. Нажмите «Подключить мой Telegram» в админке ещё раз." }); } catch {}
    return done();
  }
  if (lg) {
    // вход на сайт: просим подтвердить кнопкой (а не сразу по ссылке) — так чужую ссылку случайно не подтвердить
    try { await tg("sendMessage", { chat_id: m.chat.id, text: "Вход на сайт Trend Büro\n\nНажмите кнопку, чтобы войти в свой кабинет на сайте. Если вы не входили — просто проигнорируйте сообщение.", reply_markup: { inline_keyboard: [[{ text: "Войти на сайт", callback_data: "lg:" + lg[1] }]] } }); } catch {}
  } else if (m?.chat?.id && typeof m.text === "string" && m.text.startsWith("/")) {
    try { await send(m.chat.id, replyFor(m.text, publicUrl(req), m.chat.id)); } catch {}
  } else if (cq?.id) {
    const ox = String(cq.data || "").match(/^ox:(ok|no):(\d{1,15})$/);
    if (ox) { let own = false; try { own = (await adminChats(getStore())).includes(String(cq.message?.chat?.id)); } catch {}
      const { setOptix } = await import("../lib/access.js"); let c = null; if (own) { try { c = await setOptix(getStore(), ox[2], ox[1] === "ok", { by: cq.from?.username ? "@" + cq.from.username : cq.from?.first_name || "бот" }); } catch {} }
      try { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: !own ? "Только из чата менеджера" : c ? (ox[1] === "ok" ? "OPTIX открыт" : "Отклонено") : "Клиент не найден" }); } catch {}
      if (own && c && cq.message?.chat?.id) { try { await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: (cq.message.text || "Заявка") + "\n\n" + (ox[1] === "ok" ? "✓ OPTIX открыт" : "✕ Отклонено") }); } catch {} }
      return done(); }
    if (!/^(lg|ac):/.test(cq.data || "")) { try { await tg("answerCallbackQuery", { callback_query_id: cq.id }); } catch {} }
    const ac = String(cq.data || "").match(/^ac:(ok|no):(\d{1,15})$/);
    if (ac) {
      // открыть доступ можно только из чата менеджера
      let own = false; try { own = (await adminChats(getStore())).includes(String(cq.message?.chat?.id)); } catch {}
      let c = null; if (own) { try { c = await setAccess(getStore(), ac[2], ac[1] === "ok" ? "ok" : "rejected", { by: cq.from?.username ? "@" + cq.from.username : cq.from?.first_name || "бот" }); } catch {} }
      try { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: !own ? "Только из чата менеджера" : c ? (ac[1] === "ok" ? "Доступ открыт" : "Заявка отклонена") : "Клиент не найден" }); } catch {}
      if (own && c && cq.message?.chat?.id) { try { await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: (cq.message.text || "Заявка") + "\n\n" + (ac[1] === "ok" ? "✓ Доступ открыт" : "✕ Отклонено") }); } catch {} }
      return done();
    }
    if (/^lg:[a-f0-9]{24}$/.test(cq.data || "")) {
      let ok = null; try { ok = await confirmLoginCode(getStore(), cq.data.slice(3), cq.from); } catch {}
      try { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: ok ? "Готово — вы вошли на сайте" : "Ссылка устарела. Нажмите «Войти» на сайте ещё раз." }); } catch {}
      if (ok && cq.message?.chat?.id) { try { await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: "✓ Вы вошли на сайте Trend Büro. Вернитесь на вкладку сайта — кабинет уже открыт." }); } catch {} }
      return done();
    }
    if (cq.data === "how" && cq.message?.chat?.id) { try { await send(cq.message.chat.id, replyFor("/how", publicUrl(req), cq.message.chat.id)); } catch {} }
  }
  return done();
}
