/**
 * Фоновая обработка: продолжает задачи импорта и ставит плановые обновления цен и наличия.
 * Вызывается Vercel Cron и/или GitHub Actions (каждые 10 минут) с секретом CRON_SECRET.
 */
import { getStore } from "../lib/store.js";
import { tick, createJob, ACTIVE } from "../lib/worker.js";
import { SOURCES } from "../lib/sources.js";
import { allSourceIds } from "../lib/suppliers.js";
import { refreshFx } from "../lib/fx.js";
import { kickWorker, CHAIN_MAX } from "../lib/chain.js";
import { publicUrl } from "./bot.js";
import { runStep, kickCatalog, startLoad, STALE_MS } from "../lib/catalogrun.js";
import { ensurePrices } from "../lib/reprice.js";

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) { res.statusCode = 401; return res.end("unauthorized"); }
  const store = getStore();
  const qp = new URL(req.url, "http://x").searchParams;
  // шаг загрузки каталога поставщика (запущен кнопкой в админке или предыдущим шагом)
  if (qp.get("catalog")) {
    const src = qp.get("catalog"), run = qp.get("run") || "", n = Number(qp.get("n")) || 1;
    const r = await runStep(store, src, run, { log: x => console.log("[load]", JSON.stringify({ src, n, ...x })) });
    if (r.next) await kickCatalog(publicUrl(req), src, run, n + 1);
    res.setHeader("Content-Type", "application/json"); res.statusCode = 200;
    return res.end(JSON.stringify(r));
  }
  // ночной запуск: загрузки каталога, у которых оборвалась цепочка, продолжаем
  if (!qp.get("chain")) {
    for (const s of await store.list("sourceSettings", {}, { limit: 500, fields: "sourceId, load" }).catch(() => [])) {
      if (s.load?.status === "running" && Date.now() - Date.parse(s.load.updatedAt || 0) > STALE_MS) await kickCatalog(publicUrl(req), s.sourceId, s.load.runId, 1);
    }
  }
  const step = Math.max(0, Math.min(CHAIN_MAX + 1, Number(req.query?.chain || new URL(req.url, "http://x").searchParams.get("chain")) || 0));
  // шаг цепочки — только продолжение задач; курсы и плановые обновления — в обычном (ночном) запуске
  if (!step) await refreshFx(store).catch(() => {});
  if (!step) await ensurePrices(store, { budgetMs: 15000, log: x => console.log("[price]", JSON.stringify(x)) }).catch(() => {});
  const planned = step ? [] : await planRefresh(store);
  for (const p of planned) if (p.catalog) await kickCatalog(publicUrl(req), p.source, p.runId, 1);
  const results = [];
  const started = Date.now();
  while (Date.now() - started < 45000) {
    const r = await tick(store, { budgetMs: Math.max(5000, 45000 - (Date.now() - started)), owner: "cron" });
    results.push(r);
    if (r.jobId && r.status !== "waiting") continue;
    // сейчас делать нечего: задача на паузе после ошибки или занята админкой — ждём, если пауза короче оставшегося времени
    const act = await store.list("importJob", { status: ACTIVE }, { limit: 20, fields: "_id, nextRunAt, lock" });
    if (!act.length) break;
    const soon = Math.min(...act.map(j => Math.max(Date.parse(j.nextRunAt || 0), Date.parse(j.lock?.until || 0))));
    const wait = soon - Date.now();
    if (wait > 45000 - (Date.now() - started) - 2000) break;
    await new Promise(t => setTimeout(t, Math.max(800, wait)));
  }
  // работа осталась — запускаем следующий шаг, не дожидаясь админки
  const left = (await store.list("importJob", { status: ACTIVE }, { limit: 5, fields: "_id" })).length;
  let next = false;
  if (left && step < CHAIN_MAX) next = await kickWorker(publicUrl(req), step + 1);
  res.setHeader("Content-Type", "application/json"); res.statusCode = 200;
  res.end(JSON.stringify({ planned, results, left, next }));
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
      // тем же механизмом, что и кнопка «Загрузить каталог» (шаги на сервере)
      if (s.load?.status === "running") continue;
      const L = await startLoad(store, id);
      await store.patchMany([s._id], { lastRefreshAt: new Date(now).toISOString() });
      planned.push({ source: id, runId: L.runId, catalog: true });
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
