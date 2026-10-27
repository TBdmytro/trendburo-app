/**
 * Telegram-бот: настройка кнопки мини-аппа и ответы на команды.
 * Токен — только в переменной окружения TELEGRAM_BOT_TOKEN, в браузер и логи не попадает.
 *  /start — приветствие с картинкой и кнопками; /catalog, /orders, /manager, /how
 *  /admin — кнопка «Открыть админку» (сама админка по-прежнему под паролем)
 *  /id    — номер этого чата (для TELEGRAM_MANAGER_CHAT)
 */
import { createHash, timingSafeEqual } from "node:crypto";

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

const MANAGER = "https://t.me/trendburo_manager";
export const BOT_TEXT = {
  short: "Купим всё, что есть в наличии в бутиках Европы — найдём, выкупим, проверим и доставим.",
  about: "Trend Büro — ваш личный байер в Европе.\n\nКупим всё, что можно купить: если вещь есть в наличии в Европе — она будет у вас.\n\nLouis Vuitton, Dior, Saint Laurent, Prada и другие — из официальных бутиков, по европейским ценам.\n\n• Найдём модель, размер и цвет, даже если их нет онлайн\n• Выкупим в бутике и проверим каждую вещь\n• Доставим в Украину, Европу или Дубай\n\nБез поездок, очередей и переплат. Вы выбираете — мы делаем всё остальное.",
  welcome: "<b>Добро пожаловать в Trend Büro</b> ✦\n\nВаш личный байер в бутиках Европы. Купим всё, что можно купить и что есть в наличии.\n\nВы выбираете — мы делаем всё остальное:\n\n<b>1.</b> Выбираете вещь в каталоге или присылаете фото\n<b>2.</b> Подтверждаем наличие, размер и цену в бутике\n<b>3.</b> Выкупаем и проверяем каждую деталь\n<b>4.</b> Доставляем до двери — в Украину, Европу или Дубай\n\nБез поездок, очередей и переплат.",
  how: "<b>Как мы работаем</b>\n\n<b>Выбор.</b> Каталог обновляется каждую ночь прямо из бутиков. Нет нужной вещи — пришлите фото или ссылку менеджеру, найдём.\n\n<b>Подтверждение.</b> Менеджер проверяет наличие и размер в бутике и называет итоговую цену — без скрытых доплат.\n\n<b>Выкуп.</b> Покупаем в официальном бутике, проверяем вещь, комплектацию и чек.\n\n<b>Доставка.</b> Отправляем в Украину, Европу или Дубай. Маршрут посылки — в «Мои заказы».\n\nЭкономим ваше время и деньги — вам остаётся только выбрать.",
};
const kbMain = base => ({ inline_keyboard: [[{ text: "Открыть каталог", web_app: { url: base + "/#catalog" } }], [{ text: "Написать менеджеру", url: MANAGER }, { text: "Как мы работаем", callback_data: "how" }]] });

/** Настроить бота: описание, кнопка меню, команды, приём сообщений. Возвращает имя бота. */
export async function setupBot(base, opts = {}) {
  if (!/^https:\/\//.test(base)) throw new Error("Нужен адрес сайта https://");
  const me = await tg("getMe", {}, opts);
  await tg("setMyShortDescription", { short_description: BOT_TEXT.short }, opts);
  await tg("setMyDescription", { description: BOT_TEXT.about }, opts);
  await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть Trend Büro", web_app: { url: base + "/" } } }, opts);
  await tg("setMyCommands", { commands: [
    { command: "start", description: "Главное меню Trend Büro" },
    { command: "catalog", description: "Открыть каталог" },
    { command: "orders", description: "Мои заказы" },
    { command: "manager", description: "Написать менеджеру" },
  ] }, opts);
  await tg("setWebhook", { url: base + "/api/bot", secret_token: hookSecret(opts.token), allowed_updates: ["message", "callback_query"], drop_pending_updates: true }, opts);
  return { username: me.username, name: me.first_name };
}

/** Ответ на команду: { method, ...поля } — sendPhoto для приветствия, иначе sendMessage. */
export function replyFor(text, base, chatId) {
  const cmd = String(text || "").trim().split(/[\s@]/)[0].toLowerCase();
  if (cmd === "/admin") return { method: "sendMessage", text: "Админка Trend Büro. Вход по паролю.", reply_markup: { inline_keyboard: [[{ text: "Открыть админку", web_app: { url: base + "/admin.html" } }]] } };
  if (cmd === "/id") return { method: "sendMessage", text: `Номер этого чата: ${chatId}\nЧтобы заявки приходили сюда, впишите его в Vercel как TELEGRAM_MANAGER_CHAT.` };
  if (cmd === "/catalog") return { method: "sendMessage", text: "Каталог Trend Büro — новинки из бутиков Европы, обновляется каждую ночь.", reply_markup: { inline_keyboard: [[{ text: "Открыть каталог", web_app: { url: base + "/#catalog" } }]] } };
  if (cmd === "/orders") return { method: "sendMessage", text: "Ваши заказы и маршрут посылки — в личном кабинете.", reply_markup: { inline_keyboard: [[{ text: "Мои заказы", web_app: { url: base + "/#account" } }]] } };
  if (cmd === "/manager") return { method: "sendMessage", text: "Менеджер на связи: подберёт размер, найдёт вещь по фото и ответит на любой вопрос.", reply_markup: { inline_keyboard: [[{ text: "Написать менеджеру", url: MANAGER }]] } };
  if (cmd === "/how") return { method: "sendMessage", parse_mode: "HTML", text: BOT_TEXT.how, reply_markup: kbMain(base) };
  return { method: "sendPhoto", photo: base + "/brand/bot-welcome.jpg", caption: BOT_TEXT.welcome, parse_mode: "HTML", reply_markup: kbMain(base) };
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
  if (m?.chat?.id && typeof m.text === "string" && m.text.startsWith("/")) {
    try { await send(m.chat.id, replyFor(m.text, publicUrl(req), m.chat.id)); } catch {}
  } else if (cq?.id) {
    try { await tg("answerCallbackQuery", { callback_query_id: cq.id }); } catch {}
    if (cq.data === "how" && cq.message?.chat?.id) { try { await send(cq.message.chat.id, replyFor("/how", publicUrl(req), cq.message.chat.id)); } catch {} }
  }
  return done();
}
