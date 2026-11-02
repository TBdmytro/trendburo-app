/**
 * Служебный бот для админов (TELEGRAM_ADMIN_BOT_TOKEN, например @tb_admin0021_bot): сюда приходят заявки на вход и заказы.
 * Вебхук ставится из админки («Ещё → Telegram-бот → Подключить кнопки»), только если бот не занят другим сервисом.
 *  /start admin_<код> — подключить этот чат к уведомлениям (ссылка из админки, одноразовая)
 *  кнопки «Открыть доступ» / «Отклонить» — работают только из подключённых чатов
 */
import { timingSafeEqual } from "node:crypto";
import { getStore } from "../lib/store.js";
import { tg, hookSecret } from "./bot.js";
import { adminBotToken, adminChats, adminLinkConfirm, setAccess } from "../lib/access.js";

export default async function handler(req, res) {
  const done = () => { res.statusCode = 200; res.setHeader("Content-Type", "application/json"); res.end("{}"); };
  const token = adminBotToken();
  if (req.method !== "POST" || !token) return done();
  const got = Buffer.from(String(req.headers["x-telegram-bot-api-secret-token"] || "")), want = Buffer.from(hookSecret(token));
  if (got.length !== want.length || !timingSafeEqual(got, want)) { res.statusCode = 401; return res.end(); }
  const T = { token };
  let u = req.body; if (typeof u === "string") { try { u = JSON.parse(u); } catch { u = {}; } }
  const m = u?.message, cq = u?.callback_query, store = getStore();
  if (m?.chat?.id && typeof m.text === "string") {
    const al = m.text.match(/^\/start\s+admin_([a-f0-9]{20})$/);
    if (al) {
      let ok = null; try { ok = await adminLinkConfirm(store, al[1], m.chat, m.from); } catch {}
      try { await tg("sendMessage", { chat_id: m.chat.id, text: ok ? "✓ Готово. Сюда будут приходить уведомления Trend Büro: заявки на вход с кнопками «Открыть доступ» / «Отклонить» и новые заказы." : "Ссылка устарела. Нажмите «Подключить мой Telegram» в админке ещё раз." }, T); } catch {}
    } else if (m.text.startsWith("/")) {
      let own = false; try { own = (await adminChats(store)).includes(String(m.chat.id)); } catch {}
      try { await tg("sendMessage", { chat_id: m.chat.id, text: own ? "Уведомления Trend Büro подключены — заявки и заказы приходят сюда." : "Служебный бот Trend Büro. Чтобы получать уведомления, нажмите «Подключить мой Telegram» в админке." }, T); } catch {}
    }
    return done();
  }
  if (cq?.id) {
    const ac = String(cq.data || "").match(/^ac:(ok|no):(\d{1,15})$/);
    if (!ac) { try { await tg("answerCallbackQuery", { callback_query_id: cq.id }, T); } catch {} return done(); }
    let own = false; try { own = (await adminChats(store)).includes(String(cq.message?.chat?.id)); } catch {}
    let c = null; if (own) { try { c = await setAccess(store, ac[2], ac[1] === "ok" ? "ok" : "rejected", { by: cq.from?.username ? "@" + cq.from.username : cq.from?.first_name || "бот" }); } catch {} }
    try { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: !own ? "Только из подключённого чата" : c ? (ac[1] === "ok" ? "Доступ открыт" : "Заявка отклонена") : "Клиент не найден" }, T); } catch {}
    if (own && c && cq.message?.chat?.id) { try { await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: (cq.message.text || "Заявка") + "\n\n" + (ac[1] === "ok" ? "✓ Доступ открыт" : "✕ Отклонено") }, T); } catch {} }
  }
  return done();
}
