/**
 * Вход через Telegram.
 * Мини-апп: Telegram подписывает initData токеном бота — проверяем подпись на сервере, подделать пользователя нельзя.
 * Сайт в браузере: виджет «Войти через Telegram» (нужен домен в @BotFather → /setdomain) — своя схема подписи.
 * Тестовый режим (только локально, DEV_AUTH=1): initData "dev:<id>:<имя>" — без Telegram, явно помечен.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const MAX_AGE = 30 * 864e5; // подпись старше 30 дней не принимаем

const same = (a, b) => { const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex"); return x.length === y.length && timingSafeEqual(x, y); };
const cleanUser = u => u && Number(u.id) > 0 ? {
  id: Number(u.id), username: String(u.username || "").slice(0, 40),
  name: [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 80) || String(u.username || "Клиент").slice(0, 80),
  photo: /^https:\/\//.test(u.photo_url || "") ? String(u.photo_url).slice(0, 300) : ""
} : null;

/** Проверка initData мини-аппа. Возвращает пользователя или null. */
export function verifyInitData(initData, token = process.env.TELEGRAM_BOT_TOKEN, now = Date.now()) {
  const raw = String(initData || "");
  if (process.env.DEV_AUTH === "1" && raw.startsWith("dev:")) { const [, id, name] = raw.split(":"); return { ...cleanUser({ id: Number(id) || 1, first_name: name || "Тест" }), dev: true }; }
  if (!token || !raw) return null;
  const p = new URLSearchParams(raw), hash = p.get("hash") || "";
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  if (!same(createHmac("sha256", secret).update(check).digest("hex"), hash)) return null;
  if (now - Number(p.get("auth_date") || 0) * 1000 > MAX_AGE) return null;
  try { return cleanUser(JSON.parse(p.get("user") || "null")); } catch { return null; }
}

/** Проверка данных виджета «Войти через Telegram» на обычном сайте. */
export function verifyLoginWidget(d, token = process.env.TELEGRAM_BOT_TOKEN, now = Date.now()) {
  if (!token || !d || !/^[a-f0-9]{64}$/.test(d.hash || "")) return null;
  const check = Object.keys(d).filter(k => k !== "hash" && d[k] !== undefined && d[k] !== null).sort().map(k => `${k}=${d[k]}`).join("\n");
  const secret = createHash("sha256").update(token).digest();
  if (!same(createHmac("sha256", secret).update(check).digest("hex"), d.hash)) return null;
  if (now - Number(d.auth_date || 0) * 1000 > MAX_AGE) return null;
  return cleanUser(d);
}

/** Пользователь из запроса: initData мини-аппа или подписанные данные виджета. */
export function userFrom(body = {}) {
  return verifyInitData(body.initData) || (body.login ? verifyLoginWidget(body.login) : null);
}
