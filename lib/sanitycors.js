/**
 * Разрешённые адреса (CORS) у проекта Sanity: без них браузер не показывает фото с cdn.sanity.io,
 * когда сайт просит их «с разрешением» (crossorigin — нужно, чтобы подобрать фон под фото).
 * У нового проекта Trend Büro их не было — фото Saint Laurent на витрине не появлялись.
 * Добавляем свой адрес сайта, если его нет (токен из переменных окружения сервера; если прав не хватает — пишем в журнал).
 */
let DONE = false, FAILAT = 0;
export async function ensureSanityCors(env = process.env, { origins } = {}) {
  if (DONE) return { ok: true, cached: true };
  if (Date.now() - FAILAT < 36e5) return { ok: false, reason: "recent-fail" }; // не хватает прав — не стучимся каждый раз
  const id = String(env.NEW_SANITY_PROJECT_ID || env.SANITY_PROJECT_ID || "").trim(), token = String(env.NEW_SANITY_TOKEN || env.SANITY_TOKEN || "").trim();
  if (!/^[a-z0-9]{6,12}$/.test(id) || !token) return { ok: false, reason: "no-config" };
  const want = origins || [...new Set([String(env.PUBLIC_URL || "").replace(/\/$/, ""), "https://trendburo-app.vercel.app"].filter(u => /^https:\/\//.test(u)))];
  const base = `https://api.sanity.io/v2021-06-07/projects/${id}/cors`, H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const r = await fetch(base, { headers: H });
    if (!r.ok) { FAILAT = Date.now(); console.log("CORSFIX list " + r.status); return { ok: false, reason: "list-" + r.status }; }
    const have = new Set((await r.json()).map(x => String(x.origin).replace(/\/$/, "")));
    const add = want.filter(o => !have.has(o)), out = { ok: true, added: [], failed: [] };
    for (const origin of add) {
      const p = await fetch(base, { method: "POST", headers: H, body: JSON.stringify({ origin, allowCredentials: false }) });
      (p.ok ? out.added : out.failed).push(origin + (p.ok ? "" : " " + p.status));
    }
    console.log("CORSFIX " + JSON.stringify(out));
    if (!out.failed.length) DONE = true; else FAILAT = Date.now();
    return out;
  } catch (e) { console.log("CORSFIX err " + String(e.message).slice(0, 120)); return { ok: false, reason: "error" }; }
}
