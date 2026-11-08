/**
 * Защита от флуда на уровне функции: не больше N запросов с одного адреса за окно.
 * Память живёт в экземпляре функции (у Vercel их несколько) — это вторая линия защиты;
 * первая — автоматическая защита Vercel от DDoS и правила файрвола проекта.
 */
const B = new Map();
export function ipOf(req) {
  const h = req.headers || {};
  return String(h["x-real-ip"] || String(h["x-forwarded-for"] || "").split(",")[0] || req.socket?.remoteAddress || "?").trim().slice(0, 64);
}
/** true — можно; false — слишком часто. */
export function allow(req, bucket, limit, windowMs, now = Date.now()) {
  const ip = ipOf(req); if (ip === "?") return true; // без адреса (локальный запуск, тесты) — не считаем
  const k = bucket + "|" + ip;
  let e = B.get(k);
  if (!e || now - e.t > windowMs) { e = { t: now, n: 0 }; B.set(k, e); }
  e.n++;
  if (B.size > 20000) for (const [kk, v] of B) { if (now - v.t > 3600e3) B.delete(kk); if (B.size < 15000) break; }
  return e.n <= limit;
}
export function tooMany(res, sec = 60) {
  res.statusCode = 429; res.setHeader("Retry-After", String(sec)); res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: "Слишком много запросов — подождите минуту" }));
}
