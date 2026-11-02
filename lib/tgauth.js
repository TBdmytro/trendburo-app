/**
 * Вход через Telegram.
 * Мини-апп: Telegram подписывает initData токеном бота — проверяем подпись на сервере, подделать пользователя нельзя.
 * Сайт в браузере: виджет «Войти через Telegram» (нужен домен в @BotFather → /setdomain) — своя схема подписи.
 * Тестовый режим (только локально, DEV_AUTH=1): initData "dev:<id>:<имя>" — без Telegram, явно помечен.
 */
import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";

const MAX_AGE = 30 * 864e5; // подпись старше 30 дней не принимаем

const same = (a, b) => { const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex"); return x.length === y.length && timingSafeEqual(x, y); };
export const cleanUser = u => u && Number(u.id) > 0 ? {
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
  return verifyInitData(body.initData) || (body.login ? verifyLoginWidget(body.login) : null) || (body.sess ? verifySess(body.sess) : null);
}

/**
 * Вход на сайте через бота (без виджета и без настройки домена): сайт получает одноразовый код, клиент открывает
 * t.me/<бот>?start=login_<код> и нажимает «Войти на сайт» — бот отмечает код. Сайт забирает подписанную сессию.
 * Сессия подписана ключом, производным от токена бота (на сервере), живёт 30 дней.
 */
const sessKey = token => createHmac("sha256", "tbsess").update(String(token || "")).digest();
export function signSess(user, token = process.env.TELEGRAM_BOT_TOKEN, now = Date.now()) {
  if (!token || !user) return null;
  const p = Buffer.from(JSON.stringify({ id: user.id, username: user.username || "", name: user.name || "", photo: user.photo || "", exp: now + MAX_AGE })).toString("base64url");
  return p + "." + createHmac("sha256", sessKey(token)).update(p).digest("base64url");
}
export function verifySess(s, token = process.env.TELEGRAM_BOT_TOKEN, now = Date.now()) {
  if (!token || typeof s !== "string" || s.length > 2000) return null;
  const [p, h] = s.split(".");
  if (!p || !h) return null;
  const want = createHmac("sha256", sessKey(token)).update(p).digest(), got = Buffer.from(h, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let d; try { d = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
  if (!d || !(d.exp > now)) return null;
  return cleanUser({ id: d.id, username: d.username, first_name: d.name, photo_url: d.photo });
}
const CODE_TTL = 10 * 60e3;
const codeId = c => "weblogin." + c;
const okCode = c => /^[a-f0-9]{24}$/.test(String(c || ""));
export async function newLoginCode(store, now = Date.now()) {
  const code = randomBytes(12).toString("hex");
  await store.put({ _id: codeId(code), _type: "weblogin", status: "wait", exp: now + CODE_TTL });
  return code;
}
/** Бот: клиент нажал «Войти на сайт». from — пользователь Telegram из апдейта (его подлинность гарантирует Telegram). */
export async function confirmLoginCode(store, code, from, now = Date.now()) {
  if (!okCode(code)) return null;
  const d = await store.get(codeId(code));
  if (!d || d.status !== "wait" || d.exp < now) return null;
  const user = cleanUser(from);
  if (!user) return null;
  await store.put({ ...d, status: "ok", user });
  return user;
}
/** Сайт: ждёт подтверждения. Код одноразовый — после выдачи сессии удаляется. */
export async function pollLoginCode(store, code, { token = process.env.TELEGRAM_BOT_TOKEN, now = Date.now() } = {}) {
  if (!okCode(code)) return { status: "gone" };
  const d = await store.get(codeId(code));
  if (!d) return { status: "gone" };
  if (d.exp < now) { await store.del(codeId(code)); return { status: "expired" }; }
  if (d.status !== "ok") return { status: "wait" };
  await store.del(codeId(code));
  return { status: "ok", sess: signSess(d.user, token, now) };
}
