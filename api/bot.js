/**
 * Telegram-бот: настройка кнопки мини-аппа и ответы на команды.
 * Токен — только в переменной окружения TELEGRAM_BOT_TOKEN, в браузер и логи не попадает.
 *  /start — приветствие и кнопка «Открыть витрину»
 *  /admin — кнопка «Открыть админку» (сама админка по-прежнему под паролем)
 *  /id    — номер этого чата (для TELEGRAM_MANAGER_CHAT)
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const botToken = () => process.env.TELEGRAM_BOT_TOKEN || "";
export const hookSecret = (t = botToken()) => createHash("sha256").update("tbhook|" + t).digest("hex").slice(0, 40);
export const publicUrl = req => (process.env.PUBLIC_URL || "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "")).replace(/\/$/, "");

export async function tg(method, body, { token = botToken(), fetchImpl = fetch } = {}) {
  if (!token) throw new Error("Не задан TELEGRAM_BOT_TOKEN");
  const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error("Telegram: " + (j.description || "ошибка " + r.status));
  return j.result;
}

/** Настроить бота: кнопка меню «Витрина», команды, приём сообщений. Возвращает имя бота. */
export async function setupBot(base, opts = {}) {
  if (!/^https:\/\//.test(base)) throw new Error("Нужен адрес сайта https://");
  const me = await tg("getMe", {}, opts);
  await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Витрина", web_app: { url: base + "/" } } }, opts);
  await tg("setMyCommands", { commands: [{ command: "start", description: "Открыть витрину Trend Büro" }] }, opts);
  await tg("setWebhook", { url: base + "/api/bot", secret_token: hookSecret(opts.token), allowed_updates: ["message"], drop_pending_updates: true }, opts);
  return { username: me.username, name: me.first_name };
}

export function replyFor(text, base, chatId) {
  const cmd = String(text || "").trim().split(/[\s@]/)[0].toLowerCase();
  if (cmd === "/admin") return { text: "Админка Trend Büro. Вход по паролю.", reply_markup: { inline_keyboard: [[{ text: "Открыть админку", web_app: { url: base + "/admin.html" } }]] } };
  if (cmd === "/id") return { text: `Номер этого чата: ${chatId}\nЧтобы заявки приходили сюда, впишите его в Vercel как TELEGRAM_MANAGER_CHAT.` };
  return { text: "Trend Büro — выкуп люксовых вещей из бутиков Европы с доставкой в Украину, Европу и Дубай.\n\nОткройте витрину: новинки, вещи в наличии, заказ в пару касаний.", reply_markup: { inline_keyboard: [[{ text: "Открыть витрину", web_app: { url: base + "/" } }]] } };
}

export default async function handler(req, res) {
  const done = () => { res.statusCode = 200; res.setHeader("Content-Type", "application/json"); res.end("{}"); };
  if (req.method !== "POST" || !botToken()) return done();
  const got = Buffer.from(String(req.headers["x-telegram-bot-api-secret-token"] || "")), want = Buffer.from(hookSecret());
  if (got.length !== want.length || !timingSafeEqual(got, want)) { res.statusCode = 401; return res.end(); }
  let u = req.body; if (typeof u === "string") { try { u = JSON.parse(u); } catch { u = {}; } }
  const m = u?.message;
  if (m?.chat?.id && typeof m.text === "string" && m.text.startsWith("/")) {
    try { await tg("sendMessage", { chat_id: m.chat.id, ...replyFor(m.text, publicUrl(req), m.chat.id) }); } catch {}
  }
  return done();
}
