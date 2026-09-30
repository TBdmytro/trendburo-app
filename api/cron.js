/**
 * Фоновая обработка: продолжает задачи импорта и ставит плановые обновления цен и наличия.
 * Вызывается Vercel Cron и/или GitHub Actions (каждые 10 минут) с секретом CRON_SECRET.
 */
import { getStore } from "../lib/store.js";
import { tick, createJob, ACTIVE } from "../lib/worker.js";
import { SOURCES } from "../lib/sources.js";
import { allSourceIds } from "../lib/suppliers.js";
import { refreshFx } from "../lib/fx.js";

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) { res.statusCode = 401; return res.end("unauthorized"); }
  const store = getStore();
  await refreshFx(store).catch(() => {});
  const planned = await planRefresh(store);
  const results = [];
  const started = Date.now();
  while (Date.now() - started < 45000) {
    const r = await tick(store, { budgetMs: Math.max(5000, 45000 - (Date.now() - started)), owner: "cron" });
    results.push(r);
    if (!r.jobId || r.status === "waiting") break;
  }
  res.setHeader("Content-Type", "application/json"); res.statusCode = 200;
  res.end(JSON.stringify({ planned, results }));
}

/** Плановое обновление опубликованных товаров источника (цены и наличие) по расписанию. */
export async function planRefresh(store, now = Date.now()) {
  const planned = [];
  for (const id of await allSourceIds(store)) {
    const s = await store.get("source." + id);
    const def = SOURCES[id] || s?.custom;
    if (!s || !def || !s.schedule || s.schedule === "off" || def.adapter === "none" || def.adapter === "file") continue;
    const every = s.schedule === "weekly" ? 7 * 864e5 : 864e5;
    if (s.lastRefreshAt && now - Date.parse(s.lastRefreshAt) < every) continue;
    // после блокировки не повторяем чаще раза в сутки — ошибки не должны давать бесконечных запросов
    if (s.lastSync?.status === "blocked" && now - Date.parse(s.lastSync.at) < 864e5) continue;
    // поставщик-каталог: заново проходим весь магазин — новинки появляются скрытыми, у показанных обновляются цены и наличие
    if (def.catalog) {
      if ((await store.list("importJob", { sourceId: id, status: ACTIVE })).length) continue;
      const { job } = await createJob(store, { sourceId: id, mode: "full", createdBy: "расписание", meta: { refresh: true } });
      s.lastRefreshAt = new Date(now).toISOString(); await store.put(s);
      planned.push({ source: id, jobId: job._id, catalog: true });
      continue;
    }
    const products = (await store.list("product", { status: "published" })).filter(p => (p.offers || []).some(o => o.sourceId === id && o.url));
    const urls = [...new Set(products.flatMap(p => p.offers.filter(o => o.sourceId === id && o.url).map(o => o.url)))];
    if (!urls.length) continue;
    const active = (await store.list("importJob", { sourceId: id, status: ACTIVE })).length;
    if (active) continue;
    const { job } = await createJob(store, { sourceId: id, mode: "links", input: urls.join("\n"), createdBy: "расписание", meta: { refresh: true } });
    s.lastRefreshAt = new Date(now).toISOString(); await store.put(s);
    planned.push({ source: id, jobId: job._id, urls: urls.length });
  }
  return planned;
}
