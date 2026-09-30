/**
 * Фоновые задачи импорта: очередь, пакеты, прогресс, точка продолжения, повторы с задержкой,
 * ограничение частоты, отмена, защита от параллельных запусков, идемпотентность.
 * Выполняется короткими «тиками» (крон / админка), каждый укладывается в бюджет времени.
 */
import { hash } from "./normalize.js";
import { sourceWith, ADAPTERS, makeNet } from "./sources.js";
import { SourceBlocked } from "./http.js";
import { buildItem } from "./pipeline.js";
import { parseCsv, rowsToRaw, parseJsonImport } from "./csv.js";
import { publishItems } from "./publish.js";
import { mergeOffer } from "./match.js";
import { getFx, refreshFx } from "./fx.js";

export const ACTIVE = ["queued", "running", "waiting"];
const MAX_ATTEMPTS = 3, BLOCK_STOP = 1; // защита от роботов — окончательный ответ, не долбим сайт повторно

export async function loadSettings(store, id) { return (await store.get("source." + id)) || null; }

/** Создание задачи. Та же задача, уже стоящая в очереди, не дублируется. */
export async function createJob(store, { sourceId, mode, input = "", category = null, createdBy = "admin", now = new Date().toISOString(), meta = {}, onlyCats = null, gender = null }) {
  const settings = await loadSettings(store, sourceId);
  const src = sourceWith(settings, sourceId);
  if (src.adapter === "none") throw new Error(`Источник «${src.name}» не подключён: ${src.checks[0]}`);
  onlyCats = Array.isArray(onlyCats) && onlyCats.length ? onlyCats.filter(c => typeof c === "string").slice(0, 20) : (src.cats?.length ? src.cats : null);
  const onlyBrands = src.brands?.length ? src.brands.map(b => String(b).toLowerCase()) : null;
  gender = ["w", "m"].includes(gender) ? gender : null;
  const idemKey = hash([sourceId, mode, String(input).trim(), category || "", (onlyCats || []).join(","), gender || ""].join("|"));
  // сайт уже ответил «защита от автоматизации» при последней проверке — не запускаем заведомо пустую загрузку
  if (src.adapter === "brand-site" && settings?.check?.state === "blocked" && Date.now() - Date.parse(settings.check.at || 0) < 7 * 864e5)
    throw new Error(`Сайт ${src.name} не пускает автоматическую загрузку (проверено ${new Date(settings.check.at).toLocaleDateString("ru-RU")}). Добавьте товары через «Новый товар», закладку «В Trend Büro» или файл CSV.`);
  const same = (await store.list("importJob", { idemKey }, { fields: "_id, status" })).find(j => ACTIVE.includes(j.status));
  if (same) return { job: await store.get(same._id), existing: true };

  const job = {
    _id: "job." + hash(idemKey + now), _type: "importJob", sourceId, mode, idemKey, category, createdBy, createdAt: now,
    status: "queued", phase: "items", queue: [], seen: [], rows: null, attempts: {}, nextRunAt: now,
    processed: 0, found: 0, errors: [], blockedCount: 0, lock: null, meta: { ...meta, catalog: !!src.catalog }, onlyCats, onlyBrands, gender, filtered: 0, labels: {},
    coverage: { startedAt: now, finishedAt: null, pages: 0, discovered: 0, sitemaps: 0, categories: {}, unavailable: [], excluded: [], complete: false, note: "" }
  };
  // строки вида «Название | https://…» — подпись раздела для отчёта; иначе просто ссылка
  const lines = [];
  for (const row of mode === "file" ? [] : String(input).split(/\n+/)) {
    const m = row.match(/^\s*([^|]*?)\s*\|\s*(\S+)\s*$/);
    if (m) { lines.push(m[2]); if (m[1]) job.labels[m[2]] = m[1]; }
    else row.split(/\s+/).map(x => x.trim()).filter(Boolean).forEach(x => lines.push(x));
  }
  if (mode === "link" || mode === "links") {
    const adapter = ADAPTERS[src.adapter];
    const urls = [...new Set(lines)];
    if (!urls.length) throw new Error("Нет ссылок");
    for (const u of urls) { try { new URL(u); } catch { throw new Error("Некорректная ссылка: " + u); } }
    job.queue = urls; job.found = urls.length;
    job.coverage.note = "Импорт по ссылкам — полнота каталога не оценивается";
    if (adapter && !urls.every(u => adapter.isProductUrl(src, u))) job.meta.warn = "Не все ссылки похожи на страницы товаров этого источника";
  } else if (mode === "category") {
    if (src.adapter === "shopify") job.discover = lines.length ? lines : (src.collections || []);
    else { if (!lines.length) throw new Error("Укажите ссылку на категорию"); job.discover = lines; }
    job.phase = "discover"; job.discoverPage = 1;
  } else if (mode === "full") {
    job.phase = "discover"; job.discoverPage = 1;
    job.discover = src.adapter === "shopify" ? (src.collections?.length ? src.collections : ["__all__"]) : (settings?.sitemaps || src.sitemaps || []);
    if (!job.discover.length) throw new Error("Для полного каталога нужен sitemap или список разделов источника");
    job.coverage.note = src.adapter === "shopify" ? "Все товары перечисленных разделов поставщика" : "По sitemap региона: полнота зависит от sitemap источника";
  } else if (mode === "file") {
    const raws = /^\s*[[{]/.test(input) ? parseJsonImport(input) : rowsToRaw(parseCsv(input));
    if (!raws.length) throw new Error("В файле нет строк товаров");
    job.rows = raws; job.queue = raws.map((_, i) => "row:" + i); job.found = raws.length;
    job.coverage.note = "Импорт файла — полнота соответствует файлу";
  } else throw new Error("Неизвестный режим: " + mode);
  await store.put(job);
  return { job, existing: false };
}

async function acquire(store, job, owner, now, ttlMs) {
  if (job.lock && Date.parse(job.lock.until) > now && job.lock.owner !== owner) return null;
  return store.putIfRev({ ...job, lock: { owner, until: new Date(now + ttlMs).toISOString() }, status: job.status === "queued" || job.status === "waiting" ? "running" : job.status }, job._rev);
}

/**
 * Один тик: берёт готовую к работе задачу и обрабатывает, пока есть время.
 * @returns {{jobId?:string, done:number, status?:string}}
 */
export async function tick(store, { budgetMs = 40000, owner = "w" + Math.random().toString(36).slice(2, 8), clock = () => Date.now(), fetchImpl = fetch, sleep } = {}) {
  const started = clock();
  const nowIso = () => new Date(clock()).toISOString();
  const candidates = (await store.list("importJob", { status: ACTIVE }, { order: "createdAt asc", limit: 20 }))
    .filter(j => Date.parse(j.nextRunAt || 0) <= clock());
  for (const cand of candidates) {
    let job = await acquire(store, cand, owner, clock(), budgetMs + 20000);
    if (!job) continue;
    const settings = await loadSettings(store, job.sourceId);
    const src = sourceWith(settings, job.sourceId);
    if (src.shopCurrency && src.shopCurrency !== "EUR") { await refreshFx(store, { fetchImpl }); src.fx = await getFx(store); }
    const adapter = ADAPTERS[src.adapter];
    const net = makeNet({ fetchImpl, now: clock, ...(sleep ? { sleep } : {}) });
    const pricingCfg = (await store.get("settings.pricing"))?.config || null;
    const cache = new Map();
    const existingFor = async brand => { const k = brand || "_"; if (!cache.has(k)) cache.set(k, await store.list("product", brand ? { brand } : {}, { fields: "_id, brand, modelSku, gtin, title, sourceTitle, overrides, pricing, variants[]{sku, gtin}" })); return cache.get(k); };
    let done = 0;
    const save = async () => { const cur = await store.get(job._id); if (cur && cur.status === "cancelled") { job.status = "cancelled"; return false; } const r = await store.put({ ...job, cancelRequested: cur?.cancelRequested }); job = r; return !cur?.cancelRequested; };

    while (clock() - started < budgetMs) {
      // отмена
      const fresh = await store.get(job._id);
      if (fresh?.cancelRequested) { job.status = "cancelled"; job.lock = null; job.finishedAt = nowIso(); await store.put(job); return { jobId: job._id, done, status: "cancelled" }; }

      if (job.phase === "discover") {
        if (!job.discover.length) { job.phase = "items"; await save(); continue; }
        const target = job.discover[0];
        try {
          if (src.adapter === "shopify") {
            const { raws, more } = await adapter.collectionPage(src, target, job.discoverPage || 1, net);
            job.coverage.pages++; const c = job.coverage.categories[target] ||= { pages: 0, items: 0, complete: false };
            c.pages++; c.items += raws.length;
            // каталог: в задаче держим только текущую страницу (до 250 товаров), а не весь магазин
            if (job.meta?.catalog) { job.rows = []; job.queue = []; }
            job.rows = job.rows || [];
            const seenSet = new Set(job.seen);
            for (const r of raws) if (!seenSet.has(r.url)) { seenSet.add(r.url); job.seen.push(r.url); job.rows.push(r); job.queue.push("row:" + (job.rows.length - 1)); job.found++; }
            if (more) job.discoverPage = (job.discoverPage || 1) + 1; else { c.complete = true; job.discover.shift(); job.discoverPage = 1; }
            if (job.meta?.catalog && job.queue.length) job.phase = "items";
          } else if (/sitemap/i.test(target) || /\.xml(\?|$)/.test(target)) {
            const r = await adapter.sitemap(src, target, net);
            job.coverage.sitemaps++;
            job.discover.shift();
            job.discover.push(...r.sitemaps.filter(s => !job.seen.includes(s)));
            r.sitemaps.forEach(s => job.seen.push(s));
            for (const u of r.products) if (!job.seen.includes(u)) { job.seen.push(u); job.queue.push(u); job.found++; }
          } else {
            const r = await adapter.category(src, target, net);
            job.coverage.pages++; const c = job.coverage.categories[job.labels?.[job.catRoot?.[target] || target] || job.category || job.catRoot?.[target] || target] ||= { pages: 0, items: 0, complete: false };
            c.pages++;
            let added = 0;
            for (const u of r.products) if (!job.seen.includes(u)) { job.seen.push(u); job.queue.push(u); job.found++; added++; }
            c.items += added;
            job.discover.shift();
            if (r.next && added > 0 && !job.seen.includes(r.next)) { job.seen.push(r.next); job.catRoot = job.catRoot || {}; job.catRoot[r.next] = job.catRoot[target] || target; job.discover.unshift(r.next); }
            else c.complete = !r.next; // страниц больше нет; если есть «следующая», но новых товаров нет — полноту не подтверждаем
            if (!c.complete && !r.next) c.complete = true;
          }
          job.coverage.discovered = job.found;
        } catch (e) {
          if (!onError(job, target, e, clock)) job.discover.shift();
          job.coverage.unavailable.push({ url: target, reason: e.message });
          if (e instanceof SourceBlocked && ++job.blockedCount >= BLOCK_STOP) return finish(store, job, "blocked", nowIso, done);
        }
        job.lastProgressAt = nowIso(); if (!(await save())) return { jobId: job._id, done, status: job.status };
        continue;
      }

      // фаза товаров
      const next = job.queue.shift();
      if (next === undefined && job.meta?.catalog && job.discover?.length) { job.phase = "discover"; await save(); continue; }
      if (next === undefined) return finish(store, job, job.errors.length && !job.processed ? "failed" : "done", nowIso, done);
      try {
        let raws, hints = next;
        if (next.startsWith("row:")) raws = [job.rows[Number(next.slice(4))]];
        else raws = await adapter.product(src, next, net);
        for (const raw of raws) {
          const existing = await existingFor(src.brand || raw.brand);
          const item = buildItem(raw, src, { existing, pricingCfg, now: nowIso(), jobId: job._id, urlHints: hints });
          // фильтр «только выбранные категории / пол»: остальное не сохраняем, только считаем
          if ((job.onlyCats && !job.onlyCats.includes(item.model.category)) || (job.gender && item.model.gender && item.model.gender !== job.gender && item.model.gender !== "u")
            || (job.onlyBrands && !job.onlyBrands.includes(String(item.model.brand || "").toLowerCase()))) {
            job.filtered = (job.filtered || 0) + 1; continue;
          }
          // поставщик-каталог: каждая позиция сразу становится товаром, скрытым с витрины; уже показанные обновляют цену и наличие
          if (job.meta?.catalog) {
            if (item.kind === "error" || item.kind === "excluded") { job.skipped = (job.skipped || 0) + 1; continue; }
            const r = await publishItems(store, [item._id], { status: "draft", by: job.meta?.refresh ? "обновление каталога" : "каталог поставщика", fetchImpl, pricingCfg, items: { [item._id]: item }, catalog: true, src });
            if (!r[0].ok) job.errors.push({ url: item.url, text: r[0].reason, at: nowIso() });
            else job.saved = (job.saved || 0) + 1;
            continue;
          }
          await store.put(item);
          // плановое обновление: цены и наличие уже опубликованных товаров применяются сразу (если не выключено)
          if (job.meta?.refresh && item.kind === "update" && settings?.autoUpdate !== false && !item.pricing.blocked) {
            const r = await publishItems(store, [item._id], { status: "published", by: "расписание", fetchImpl, pricingCfg });
            if (!r[0].ok) job.errors.push({ url: item.url, text: "Обновление не применено: " + r[0].reason, at: nowIso() });
          }
          // автопубликация новых позиций — только для настроенного источника и не при первом импорте
          else if (!job.meta?.refresh && item.kind === "new" && settings?.autoPublish && settings?.lastSync?.status === "done" && !item.issues.some(i => i.level === "error")) {
            await publishItems(store, [item._id], { status: "published", by: "автопубликация", fetchImpl, pricingCfg });
          }
          if (item.kind === "excluded") job.coverage.excluded.push({ url: item.url, reason: item.issues.find(i => i.code === "lead")?.text || "исключено" });
        }
        job.processed++; done++;
      } catch (e) {
        const retry = onError(job, next, e, clock);
        // ошибка обновления не удаляет товар и не обнуляет цену: пишем ошибку в предложение
        if (!retry && job.meta?.refresh) await noteOfferError(store, job.sourceId, next, e);
        if (e instanceof SourceBlocked && ++job.blockedCount >= BLOCK_STOP) { job.queue.unshift(next); return finish(store, job, "blocked", nowIso, done); }
      }
      job.lastProgressAt = nowIso();
      // большой каталог: прогресс сохраняем каждые 10 позиций (повтор позиции безопасен — товар перезаписывается)
      if (job.meta?.catalog && done % 10 && job.queue.length && job.status !== "waiting") continue;
      if (!(await save())) return { jobId: job._id, done, status: job.status };
      if (job.status === "waiting") break;
    }
    job.lock = null; job.status = job.queue.length || (job.discover && job.discover.length) ? (job.status === "waiting" ? "waiting" : "running") : job.status;
    await store.put(job);
    return { jobId: job._id, done, status: job.status };
  }
  return { done: 0 };
}

/** Ошибка позиции: повтор с растущей задержкой для временных ошибок, иначе запись в отчёт. true = поставлено на повтор. */
function onError(job, key, e, clock) {
  const n = (job.attempts[key] || 0) + 1; job.attempts[key] = n;
  if (e.retryable && n < MAX_ATTEMPTS) {
    if (job.phase === "items") job.queue.push(key);
    const delay = Math.min(60, 5 * 2 ** (n - 1)) * 1000; // 5 с, 10 с, 20 с …
    job.nextRunAt = new Date(clock() + delay).toISOString();
    job.status = "waiting";
    return true;
  }
  job.errors.push({ url: key, text: e.message, at: new Date(clock()).toISOString(), blocked: e instanceof SourceBlocked });
  return false;
}

async function finish(store, job, status, nowIso, done) {
  job.status = status; job.lock = null; job.finishedAt = nowIso();
  job.coverage.finishedAt = job.finishedAt;
  const cats = Object.values(job.coverage.categories);
  job.coverage.complete = status === "done" && job.mode !== "link" && job.mode !== "links" && job.coverage.unavailable.length === 0 && (cats.length === 0 || cats.every(c => c.complete));
  if (status === "blocked") job.coverage.note = "Источник блокирует автоматические запросы — обход не выполняется. Нужен файл или фид от источника.";
  const blockedErr = status === "blocked" ? [...job.errors].reverse().find(e => e.blocked) : null;
  if (job.meta?.catalog && status === "done" && job.coverage.complete && job.mode === "full" && !job.onlyCats && !job.onlyBrands && !job.gender) job.gone = await markGone(store, job);
  await store.put(job);
  const s = (await store.get("source." + job.sourceId)) || { _id: "source." + job.sourceId, _type: "sourceSettings", sourceId: job.sourceId };
  s.lastSync = { at: job.finishedAt, status, jobId: job._id, processed: job.processed, errors: job.errors.length };
  if (blockedErr) s.check = { ok: false, state: "blocked", text: "Сайт не пускает автоматическую загрузку с нашего сервера (" + blockedErr.text + ")", at: job.finishedAt };
  await store.put(s);
  return { jobId: job._id, done, status };
}

/** Полный проход каталога завершён: товары этого поставщика, которых больше нет на сайте, — «нет в наличии». */
async function markGone(store, job) {
  const seen = new Set(job.seen || []);
  const list = (await store.list("product", {}, { limit: 50000, fields: "_id, offers" })).filter(p => (p.offers || []).some(o => o.sourceId === job.sourceId && o.url && !seen.has(o.url)));
  for (const p of list) {
    const full = await store.get(p._id); if (!full) continue;
    full.offers = full.offers.map(o => o.sourceId === job.sourceId && o.url && !seen.has(o.url) ? { ...o, availability: Object.fromEntries(Object.keys(o.availability || { x: 1 }).map(k => [k, { status: "out", price: null }])), onlineOrder: false, errors: [...(o.errors || []).slice(-4), { at: new Date().toISOString(), text: "Товар исчез с сайта поставщика" }] } : o);
    await store.put(full);
  }
  return list.length;
}

async function noteOfferError(store, sourceId, url, e) {
  const list = (await store.list("product")).filter(p => (p.offers || []).some(o => o.sourceId === sourceId && o.url === url));
  for (const p of list) { p.offers = p.offers.map(o => o.sourceId === sourceId && o.url === url ? mergeOffer(o, null, e) : o); await store.put(p); }
}

export async function cancelJob(store, id) {
  const j = await store.get(id); if (!j) throw new Error("Задача не найдена");
  if (!ACTIVE.includes(j.status)) return j;
  if (!j.lock || Date.parse(j.lock.until) < Date.now()) { j.status = "cancelled"; j.finishedAt = new Date().toISOString(); j.lock = null; return store.put(j); }
  j.cancelRequested = true; return store.put(j);
}

/** Удаление задачи: останавливает её и убирает строки предпросмотра. Опубликованные товары не трогает. */
export async function deleteJob(store, id) {
  const j = await store.get(id); if (!j) return { ok: true };
  const items = await store.list("importItem", { jobId: id }, { limit: 50000, fields: "_id" });
  await store.delMany(items.map(i => i._id));
  await store.del(id);
  return { ok: true, items: items.length };
}
