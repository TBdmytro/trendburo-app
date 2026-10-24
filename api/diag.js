/** Диагностика плавности с телефона: витрина присылает замеры (паузы кадров, события Telegram, память) — пишем в журнал сервера.
 *  Без личных данных: только техника устройства и замеры. Включается вводом «#diag» в поиске каталога. */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  let j = null;
  try {
    if (req.body && typeof req.body === "object") j = req.body;
    else if (typeof req.body === "string") j = JSON.parse(req.body.slice(0, 20000));
    else { let body = ""; for await (const c of req) { body += c; if (body.length > 20000) break; } j = JSON.parse(body.slice(0, 20000)); } console.log("DIAG " + JSON.stringify(j).slice(0, 15000)); } catch { console.log("DIAG bad"); }
  res.statusCode = 204; res.end();
}
