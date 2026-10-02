/** Авторизация админки: пароль из переменной окружения, подписанная cookie (HttpOnly, SameSite=Strict). */
import { createHmac, timingSafeEqual, createHash } from "node:crypto";

const COOKIE = "tb_admin";
const TTL = 30 * 24 * 3600;

function secret(env = process.env) {
  if (env.ADMIN_SECRET) return env.ADMIN_SECRET;
  if (!env.ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD не задан");
  return createHash("sha256").update("tb|" + env.ADMIN_PASSWORD + "|" + (env.SANITY_TOKEN || "")).digest("hex");
}
const sign = (data, env) => createHmac("sha256", secret(env)).update(data).digest("base64url");

export function checkPassword(pw, env = process.env) {
  if (!env.ADMIN_PASSWORD) return false;
  const a = Buffer.from(String(pw || "").trim()), b = Buffer.from(String(env.ADMIN_PASSWORD).trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueCookie(name, env = process.env) {
  const payload = Buffer.from(JSON.stringify({ n: String(name || "admin").slice(0, 40), e: Math.floor(Date.now() / 1000) + TTL })).toString("base64url");
  return `${COOKIE}=${payload}.${sign(payload, env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** Возвращает {name} или null. */
export function readSession(req, env = process.env) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig) return null;
  let good; try { good = sign(payload, env); } catch { return null; }
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  const d = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (d.e < Date.now() / 1000) return null;
  return { name: d.n };
}
