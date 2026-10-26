import { createHash, randomBytes } from "node:crypto";
/**
 * API админки. Один обработчик на все действия (?a=…), чтобы укладываться в лимит функций Vercel.
 * Все действия, кроме входа, требуют авторизации; изменяющие — ещё и заголовок X-TB (защита от CSRF).
 */
import { kickWorker } from "../lib/chain.js";
import { loadCatalogPage, dbStats, rememberDeleted, deletedSet, fixBrands, askNoSizes } from "../lib/catalogload.js";
import { brandKey } from "../lib/normalize.js";
import { startLoad, stopLoad, loadState, kickCatalog, STALE_MS } from "../lib/catalogrun.js";
import { repriceAll, ensurePrices, PRICE_VER } from "../lib/reprice.js";
import { getStore } from "../lib/store.js";
import { checkPassword, issueCookie, clearCookie, readSession } from "../lib/auth.js";
import { SOURCES, sourceWith, makeNet } from "../lib/sources.js";
import { SourceBlocked } from "../lib/http.js";
import { createJob, tick, cancelJob, deleteJob, ACTIVE } from "../lib/worker.js";
import { publishItems, setStatus, saveOverrides, computePricing } from "../lib/publish.js";
import { priceOffer, mergeConfig, PRICING_DEFAULTS } from "../lib/pricing.js";
import { toStorefront } from "../lib/catalog.js";
import { saveManualProduct, updateWebProduct, markWebGone } from "../lib/manual.js";
import { LEAD_STATUS, notifyClient } from "./lead.js";
import { allSourceIds, detectSupplier, addSupplier, updateSupplier, removeSupplier, listCollections, saveCollections } from "../lib/suppliers.js";
import { getFx, refreshFx, saveManualFx } from "../lib/fx.js";
import { readScreen, screensEnabled, ScreenError } from "../lib/screens.js";
import { setupBot, botToken, publicUrl, tg } from "./bot.js";
import { listItems, saveItem, deleteItems, reorder, setActive, getSite, saveSite, seedRails, FEED_BLOCKS, TEXTS, KINDS, bannerStats, THEME_PRESETS, CAT_COLORS } from "../lib/cms.js";

const send = (res, code, body) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
const slim = j => { if (!j) return j; const { rows, seen, queue, attempts, catRoot, discover, ...rest } = j; return { ...rest, queued: j.queuedCount ?? (queue || []).length, discoverLeft: j.discoverLeft ?? (discover || []).length }; };
// Задачи без тяжёлых полей (строки файла, очередь ссылок) — список грузится мгновенно
const JOB_FIELDS = `..., "rows": null, "seen": null, "queue": null, "attempts": null, "catRoot": null, "discover": null, "queuedCount": count(queue), "discoverLeft": count(discover)`;

// список товаров для «Товаров», брендов и фильтров: держим 30 с в памяти, чтобы админка открывалась быстро.
// Любое изменение (кроме потока загрузки с кнопки) сбрасывает — после «На сайт», правок и удаления список свежий.
let PCACHE = null;
// только лёгкие поля: размеры и наличие по размерам дочитываются для открытой страницы (до 120 товаров), а не для всех тысяч
const PFIELDS = "_id, brand, title, sourceTitle, modelSku, overrides, category, subcategory, status, images[0...1]{url}, pricing{ua, eu, dxb}, updatedAt, createdAt, \"issuesN\": count(issues), gender, sections, secPos, webSections, sourceUrl, offers[]{sourceId, onlineOrder}, \"chk\": offers[0].checkedAt, stock, hasPre, \"nSz\": count(sizes)";
async function allProducts(store) {
  if (PCACHE && Date.now() - PCACHE.at < 30000) return PCACHE.data;
  const data = await store.list("product", {}, { order: "updatedAt desc", limit: 50000, fields: PFIELDS });
  PCACHE = { at: Date.now(), data }; return data;
}
// ключ кнопки «В Trend Büro»: даёт только загрузку товаров с сайтов брендов (скрытыми), без доступа к остальной админке.
// Хранится на сервере только отпечаток (sha256); сам ключ — внутри закладки пользователя
const KEY_ACTIONS = new Set(["me", "knownProducts", "webImport", "webUpdate", "sectionKnown", "sectionSync", "markNew", "imageUpload", "subcats"]);
const keyHash = k => createHash("sha256").update(String(k)).digest("hex");
async function keySession(req, a, store) {
  const k = String(req.headers["x-tb-key"] || ""); if (!/^[a-f0-9]{48}$/.test(k) || !KEY_ACTIONS.has(a)) return null;
  const d = await store.get("settings.importKeys"); const h = keyHash(k);
  return (d?.list || []).some(x => x.h === h) ? { name: "Кнопка", key: true } : null;
}
let FIXAT = 0; // приводить бренды/подразделы при открытии «Товаров» — не чаще раза в 30 минут (ночью — всегда, в cron)
export default async function handler(req, res) {
  const a = (req.query && req.query.a) || new URL(req.url, "http://x").searchParams.get("a");
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  try {
    if (a === "login" && req.method === "POST") {
      if (!process.env.ADMIN_PASSWORD) return send(res, 500, { error: "На сервере не задан пароль: добавьте ADMIN_PASSWORD в Vercel и сделайте Redeploy" });
      if (!checkPassword(body.password)) { await new Promise(r => setTimeout(r, 1200)); return send(res, 401, { error: "Неверный пароль" }); }
      res.setHeader("Set-Cookie", issueCookie(body.name || "admin"));
      return send(res, 200, { ok: true, name: body.name || "admin" });
    }
    let me = readSession(req);
    if (!me && req.headers["x-tb-key"]) me = await keySession(req, a, getStore());
    if (!me) return send(res, 401, { error: "Нужен вход" });
    if (req.method !== "GET" && req.headers["x-tb"] !== "1") return send(res, 403, { error: "Запрос отклонён" });
    const store = getStore();
    if (req.method !== "GET" && !["webImport", "webUpdate", "imageUpload", "imageFromUrl"].includes(a)) PCACHE = null;
    const pricingCfg = (await store.get("settings.pricing"))?.config || null;

    switch (a) {
      case "logout": res.setHeader("Set-Cookie", clearCookie()); return send(res, 200, { ok: true });
      case "importKey": {
        // новый ключ для закладки (страница кнопки берёт его, когда вы вошли в админку); храним 10 последних
        if (me.key) return send(res, 403, { error: "Нет доступа" });
        const key = randomBytes(24).toString("hex"), d = (await store.get("settings.importKeys")) || { _id: "settings.importKeys", _type: "settings", list: [] };
        d.list = [{ h: keyHash(key), at: new Date().toISOString() }, ...(d.list || [])].slice(0, 10); delete d._rev; delete d._createdAt; delete d._updatedAt;
        await store.put(d); return send(res, 200, { key });
      }
      case "me": { if (!me.key) await seedRails(store, me.name).catch(() => {});
        if (!me.key) { const { ensureSanityCors } = await import("../lib/sanitycors.js"); await ensureSanityCors().catch(() => {}); } // фото с хранилища должны открываться на сайте
        return send(res, 200, { name: me.name, store: store.kind, demo: !!store.demo }); }

      case "overview": {
        const [published, draft, hidden, jobs, waiting, leadsNew] = await Promise.all([
          store.count("product", { status: "published" }), store.count("product", { status: "draft" }), store.count("product", { status: "hidden" }),
          store.list("importJob", {}, { order: "createdAt desc", limit: 8, fields: JOB_FIELDS }),
          store.count("importItem", { publishedAs: null, kind: ["new", "update", "duplicate"] }),
          store.count("lead", { status: "new" })
        ]);
        const [orders, cms, srcs] = await Promise.all([
          store.list("lead", { kind: "order", status: ["work", "paid", "bought", "shipping", "np"] }, { limit: 500, fields: "status" }),
          store.list("cms", { active: true }, { limit: 400, fields: "_id, kind, title, to" }),
          store.list("sourceSettings", {}, { limit: 200, fields: "sourceId, custom, check, lastSync" })
        ]);
        const soon = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
        const attention = [];
        if (leadsNew) attention.push({ level: "err", text: `${leadsNew} — новые заявки ждут ответа`, go: "leads:new" });
        const paid = orders.filter(o => o.status === "paid").length;
        if (paid) attention.push({ level: "warn", text: `${paid} — оплачены, ждут выкупа`, go: "leads:paid" });
        cms.filter(x => x.to && x.to >= today && x.to <= soon).forEach(x => attention.push({ level: "info", text: `«${x.title || "Без названия"}» снимется с витрины ${x.to.split("-").reverse().slice(0, 2).join(".")}`, go: "show:" + x.kind }));
        srcs.filter(s => s.custom && s.check && s.check.state !== "ok").forEach(s => attention.push({ level: "warn", text: `${s.custom.name}: ${s.check.text}`, go: "sources" }));
        srcs.filter(s => s.custom && s.lastSync && ["failed", "blocked"].includes(s.lastSync.status)).forEach(s => attention.push({ level: "warn", text: `${s.custom.name}: последнее обновление каталога не удалось`, go: "sources" }));
        return send(res, 200, { published, draft, hidden, waiting, leadsNew, ordersActive: orders.length, ordersPaid: paid, attention: attention.slice(0, 8), jobs: jobs.map(slim), active: jobs.filter(j => ACTIVE.includes(j.status)).length });
      }
      case "sourceCheck": {
        // Проверка доступа с нашего сервера: robots.txt + главная страница источника. Без обхода защиты.
        const id = body.id;
        const settings = await store.get("source." + id);
        if (!SOURCES[id] && !settings?.custom) return send(res, 400, { error: "Неизвестный источник" });
        const src = sourceWith(settings, id);
        let check;
        if (src.custom) {
          const d = await detectSupplier(src.home);
          check = d.ok ? { ok: true, state: "ok", text: `Каталог открыт: ${d.sample}${d.more ? "+" : ""} товаров на первой странице, валюта ${d.currency}` } : { ok: false, state: /не пускает|закрыл/.test(d.reason) ? "blocked" : "error", text: d.reason };
        }
        else if (!src.home) check = { ok: false, state: "none", text: "У источника нет адреса сайта — используйте файл" };
        else {
          const t0 = Date.now();
          try {
            const r = await makeNet().get(src, src.home);
            const hasProducts = r.text.includes(src.productPattern || "/products/");
            check = { ok: true, state: "ok", text: `Сайт открывается с сервера (${r.status}, ${Math.round((Date.now() - t0) / 100) / 10} с)` + (hasProducts ? "" : ". Ссылок на товары на главной не видно — возможно, каталог подгружается скриптом") };
          } catch (e) {
            check = e instanceof SourceBlocked
              ? { ok: false, state: "blocked", text: "Сайт не пускает автоматическую загрузку с нашего сервера (" + e.message + "). Обход защиты не выполняется — используйте файл или фид." }
              : { ok: false, state: "error", text: e.message };
          }
        }
        check.at = new Date().toISOString();
        const cur = settings || { _id: "source." + id, _type: "sourceSettings", sourceId: id };
        cur.check = check; await store.put(cur);
        return send(res, 200, { check });
      }
      case "sources": {
        const jobs = await store.list("importJob", {}, { order: "createdAt desc", limit: 200, fields: "_id, sourceId, status, mode, createdAt, processed, found, errors, filtered" });
        const products = await store.list("product", {}, { fields: "status, category, offers[]{sourceId}" });
        const out = [];
        const fx = await getFx(store);
        for (const id of await allSourceIds(store)) {
          const settings = await store.get("source." + id);
          const src = sourceWith(settings, id);
          const mine = products.filter(p => (p.offers || []).some(o => o.sourceId === id));
          const last = jobs.find(j => j.sourceId === id);
          out.push({
            id, name: src.name, kind: src.kind, adapter: src.adapter, region: src.region, currency: src.currency,
            connected: src.adapter !== "none", checks: src.checks, imageRights: src.imageRights,
            photoCopy: settings?.photoCopy || { allowed: false, basis: "" },
            schedule: settings?.schedule || "off", autoUpdate: settings?.autoUpdate !== false, autoPublish: !!settings?.autoPublish, onlyAvailable: settings?.onlyAvailable !== false,
            sitemaps: settings?.sitemaps || src.sitemaps || [], collections: src.collections || [],
            lastSync: settings?.lastSync || null, check: settings?.check || null, home: src.home || null, lastJob: slim(last), running: jobs.some(j => j.sourceId === id && ACTIVE.includes(j.status)),
            stats: { found: mine.length, published: mine.filter(p => p.status === "published").length },
            categories: [...new Set(mine.map(p => p.category).filter(Boolean))],
            custom: !!src.custom, catalog: !!src.catalog, shopCurrency: src.shopCurrency || null, market: src.market || "", geoEu: !!src.geoEu, factor: src.factor || 1, brands: src.brands || [], cats: src.cats || [],
            fx: src.shopCurrency && src.shopCurrency !== "EUR" ? fx.rates[src.shopCurrency] : null
          });
        }
        return send(res, 200, { sources: out });
      }
      case "sourceSave": {
        const id = body.id;
        let cur = (await store.get("source." + id)) || { _id: "source." + id, _type: "sourceSettings", sourceId: id };
        if (!SOURCES[id] && !cur.custom) return send(res, 400, { error: "Неизвестный источник" });
        if (cur.custom && (body.factor !== undefined || body.brands !== undefined || body.cats !== undefined || body.name || body.kind)) cur = await updateSupplier(store, id, { factor: body.factor ?? cur.factor, brands: body.brands ?? cur.brands, cats: body.cats ?? cur.cats, name: body.name, kind: body.kind });
        if (body.photoCopy) {
          const allowed = !!body.photoCopy.allowed, basis = String(body.photoCopy.basis || "").trim();
          if (allowed && basis.length < 5) return send(res, 400, { error: "Укажите основание: кто и когда разрешил использовать фото" });
          cur.photoCopy = { allowed, basis, by: me.name, at: new Date().toISOString() };
        }
        if (body.schedule) cur.schedule = ["off", "daily", "weekly"].includes(body.schedule) ? body.schedule : "off";
        if (body.autoUpdate !== undefined) cur.autoUpdate = !!body.autoUpdate;
        if (body.autoPublish !== undefined) cur.autoPublish = !!body.autoPublish;
        if (body.onlyAvailable !== undefined) cur.onlyAvailable = !!body.onlyAvailable;
        if (Array.isArray(body.sitemaps)) cur.sitemaps = body.sitemaps.filter(s => /^https:\/\//.test(s)).slice(0, 20);
        await store.put(cur);
        return send(res, 200, { ok: true });
      }

      case "supplierDetect": return send(res, 200, { result: await detectSupplier(String(body.url || "")) });
      case "supplierAdd": return send(res, 200, await addSupplier(store, body, { by: me.name }));
      case "supplierCollections": return send(res, 200, await listCollections(store, String(req.query.id || body.id || "")));
      case "supplierSections": return send(res, 200, await saveCollections(store, String(body.id || ""), body.collections, body.titles));
      case "supplierRemove": return send(res, 200, await removeSupplier(store, String(body.id || ""), { deleteProducts: !!body.deleteProducts }));
      case "fxGet": return send(res, 200, await getFx(store));
      case "fxRefresh": { const r = await refreshFx(store, { force: true }); return send(res, 200, { ...(await getFx(store)), refresh: r }); }
      case "fxSave": return send(res, 200, await saveManualFx(store, body.manual || {}, me.name));

      case "jobCreate": {
        const { job, existing } = await createJob(store, { sourceId: body.sourceId, mode: body.mode, input: body.input || "", category: body.category || null, createdBy: me.name, onlyCats: body.onlyCats || null, gender: body.gender || null });
        // загрузка идёт на сервере сама, даже если админку закрыть
        if (!existing) await kickWorker(publicUrl(req), 1);
        return send(res, 200, { job: slim(job), existing });
      }
      case "jobs": return send(res, 200, { jobs: (await store.list("importJob", {}, { order: "createdAt desc", limit: 50, fields: JOB_FIELDS })).map(slim) });
      case "job": return send(res, 200, { job: slim((await store.list("importJob", { _id: String(req.query.id || "") }, { limit: 1, fields: JOB_FIELDS }))[0] || null) });
      case "catalogPage": {
        // упёрлись в лимит полей базы — к ошибке добавляем, кто именно занимает место (чтобы чинить по факту, а не наугад)
        const why = async () => { const st = await dbStats(store).catch(() => null); return st ? ` [всего полей ${st.total}: ` + st.byType.slice(0, 4).map(t => `${t.type} ${t.fields} (${t.docs} шт.)`).join(", ") + "]" : ""; };
        let r; const t0 = Date.now();
        try { r = await loadCatalogPage(store, String(body.sourceId || ""), { handle: body.handle, page: body.page, limit: body.limit }); }
        catch (e) { if (/attribute/i.test(e.message)) e.message += await why(); console.log("[catalog] FAIL", JSON.stringify({ src: body.sourceId, page: body.page, ms: Date.now() - t0, error: e.message.slice(0, 400) })); throw e; }
        if (r.errors.some(x => /attribute/i.test(x))) r.errors[0] += await why();
        // строка в журнал сервера (без ключей и личных данных) — чтобы видеть ход загрузки в логах Vercel
        console.log("[catalog]", JSON.stringify({ src: body.sourceId, page: body.page, ms: Date.now() - t0, found: r.found, saved: r.saved, filtered: r.filtered, skipped: r.skipped, more: r.more, migrating: r.migrating || undefined, errors: r.errors.slice(0, 2) }));
        return send(res, 200, r);
      }
      // загрузка каталога на сервере: старт / стоп / состояние (админка опрашивает раз в несколько секунд)
      case "catalogStart": {
        const L = await startLoad(store, String(body.sourceId || ""), { resume: !!body.resume, mode: body.mode === "sort" ? "sort" : "full" });
        await kickCatalog(publicUrl(req), String(body.sourceId), L.runId, 1);
        return send(res, 200, { load: L });
      }
      case "catalogStop": return send(res, 200, { load: await stopLoad(store, String(body.sourceId || "")) });
      case "catalogState": {
        const id = String(req.query.sourceId || ""); let L = await loadState(store, id);
        // цепочка шагов оборвалась (нет движения дольше 90 с) — продолжаем с того же места
        if (L?.status === "running" && Date.now() - Date.parse(L.updatedAt || 0) > STALE_MS && !(L.lease && Date.parse(L.lease.until) > Date.now())) {
          L = await startLoad(store, id, { resume: true }); await kickCatalog(publicUrl(req), id, L.runId, 1);
        }
        return send(res, 200, { load: L });
      }
      // пересчитать скрытые товары, если формула цен в коде новее (вызывает админка при открытии «Товаров»)
      case "ensurePrices": return send(res, 200, await ensurePrices(store, { budgetMs: 40000, log: x => console.log("[price]", JSON.stringify(x)) }));
      case "dbStats": return send(res, 200, await dbStats(store));
      case "jobCancel": return send(res, 200, { job: slim(await cancelJob(store, body.id)) });
      case "jobDelete": {
        const j = await store.get(body.id);
        if (j && ACTIVE.includes(j.status)) { await cancelJob(store, body.id); await store.patchMany([body.id], { status: "cancelled", lock: null }); }
        return send(res, 200, await deleteJob(store, body.id));
      }
      case "tick": return send(res, 200, await tick(store, { budgetMs: 25000, owner: "admin-" + me.name }));
      case "productDelete": {
        const ids = (body.ids || []).filter(i => typeof i === "string" && i.startsWith("product.")).slice(0, 2000);
        const linked = await store.list("importItem", { publishedAs: ids }, { limit: 20000, fields: "_id" });
        if (linked.length) await store.patchMany(linked.map(i => i._id), { publishedAs: null, publishedAt: null });
        await store.delMany(ids);
        // запоминаем удалённые — загрузка каталога поставщика (в том числе ночная) не вернёт их скрытыми
        await rememberDeleted(store, ids);
        return send(res, 200, { ok: true, deleted: ids.length });
      }

      case "items": {
        const where = { jobId: req.query.jobId }; if (req.query.kind) where.kind = req.query.kind;
        const items = await store.list("importItem", where, { limit: 2000 });
        const counts = {}; (await store.list("importItem", { jobId: req.query.jobId }, { limit: 20000, fields: "kind" })).forEach(i => counts[i.kind] = (counts[i.kind] || 0) + 1);
        return send(res, 200, { items, counts });
      }
      case "publish": {
        const r = await publishItems(store, body.ids || [], { status: body.status === "draft" ? "draft" : "published", by: me.name, resolution: body.resolution || {}, pricingCfg });
        return send(res, 200, { results: r });
      }
      case "status": return send(res, 200, { results: await setStatus(store, (body.ids || []).slice(0, 5000), ["published", "draft", "hidden"].includes(body.status) ? body.status : "draft", me.name) });
      case "productIds": {
        // все товары по текущему фильтру — для «Показать все найденные»
        const all = await allProducts(store);
        const Q = req.query, q = String(Q.q || "").toLowerCase();
        const ids = all.filter(p => (!Q.sec || (p.sections || []).includes(Q.sec)) && (!Q.avail || (p.offers || []).some(o => o.onlineOrder)) && (!Q.noavail || !(p.offers || []).some(o => o.onlineOrder)) && (!q || [p.brand, p.title, p.sourceTitle, p.modelSku, p.overrides?.title].join(" ").toLowerCase().includes(q)) && (Q.status ? p.status === Q.status : p.status !== "incoming")
          && (!Q.source || (p.offers || []).some(o => o.sourceId === Q.source)) && (!Q.brand || p.brand === Q.brand) && (!Q.cat || (p.overrides?.category || p.category) === Q.cat)).map(p => p._id);
        return send(res, 200, { ids });
      }

      case "knownProducts": {
        // какие товары с этого сайта уже есть (на витрине или скрыты) — кнопка «В Trend Büro» их не берёт повторно
        const px = "product.manual." + String(req.query.prefix || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) + "-";
        if (px.length < 18) return send(res, 400, { error: "Нет сайта" });
        const all = await allProducts(store);
        // fresh — проверены кнопкой за последние 12 часов: при повторном прогоне их не открываем заново (быстрее)
        const status = {}, fresh = {}, since = Date.now() - 12 * 36e5;
        for (const id of await deletedSet(store)) if (id.startsWith(px)) status[id.slice(px.length).toUpperCase()] = "rejected"; // вы удалили — кнопка не вернёт
        for (const p of all) if (p._id.startsWith(px)) { const k = p._id.slice(px.length).toUpperCase(); status[k] = p.status || "draft"; const ck = p.chk || p.offers?.[0]?.checkedAt; const needSz = ["shoes", "clothing"].includes(p.overrides?.category || p.category) && !p.nSz; if (ck && Date.parse(ck) > since && !needSz) fresh[k] = 1; } // без размеров — проверяем снова
        return send(res, 200, { status, fresh });
      }
      case "brandBoard": {
        // бренды, которые у нас есть: сколько товаров, что на витрине, разбивка по категориям, 4 обложки («Новые с сайтов» — отдельно)
        const every = await allProducts(store), all = every.filter(p => p.status !== "incoming"), incoming = every.length - all.length;
        const m = new Map();
        for (const p of all) {
          const name = String(p.brand || "").trim(); if (!name) continue;
          const k = brandKey(name); let b = m.get(k);
          if (!b) { b = { brand: name, n: 0, pub: 0, cats: {}, covers: [] }; m.set(k, b); }
          b.n++; if (p.status === "published") b.pub++;
          const c = p.overrides?.category || p.category || "other"; b.cats[c] = (b.cats[c] || 0) + 1;
          const u = (p.images || [])[0]?.url; if (u && b.covers.length < 4 && p.status === "published") b.covers.push(u);
        }
        for (const p of all) { const b = m.get(brandKey(p.brand)); const u = (p.images || [])[0]?.url; if (b && u && b.covers.length < 4 && !b.covers.includes(u)) b.covers.push(u); }
        const brands = [...m.values()].sort((a, b) => b.n - a.n);
        return send(res, 200, { brands, total: all.length, incoming });
      }
      case "products": {
        const all = await allProducts(store);
        const Q = req.query, q = String(Q.q || "").toLowerCase();
        const cat = p => p.overrides?.category || p.category;
        // фильтры применяются по очереди; списки для выпадающих меню строятся по остальным фильтрам
        const base = all.filter(p => (!q || [p.brand, p.title, p.sourceTitle, p.modelSku, p.overrides?.title].join(" ").toLowerCase().includes(q))
          && (Q.status ? p.status === Q.status : p.status !== "incoming") && (!Q.source || (p.offers || []).some(o => o.sourceId === Q.source))
          && (!Q.avail || (p.offers || []).some(o => o.onlineOrder))
          && (!Q.pre || !!p.hasPre)
          // «В наличии»: вещь уже выкуплена и лежит у нас (ua — Украина, eu — Европа, any — любая)
          && (!Q.stock || (l => Q.stock === "any" ? !!l : l === Q.stock)((p.overrides?.stock || p.stock)?.loc || "")));
        // вкладка раздела магазина (Бестселлеры, Женское…) — в том же порядке, что на сайте бренда
        const pos = p => (p.secPos || []).find(x => x.s === Q.sec)?.p ?? 1e9;
        const gen = p => p.overrides?.gender || p.gender || "u";
        const list = base.filter(p => (!Q.brand || p.brand === Q.brand) && (!Q.cat || cat(p) === Q.cat) && (!Q.g || gen(p) === Q.g) && (!Q.sec || (p.sections || []).includes(Q.sec)));
        if (Q.sec) list.sort((a, b) => pos(a) - pos(b));
        const srcDoc = Q.source ? await store.get("source." + Q.source) : null;
        const secCounts = {}; base.forEach(p => (p.sections || []).forEach(h => secCounts[h] = (secCounts[h] || 0) + 1));
        const facet = (arr, f) => { const m = {}; arr.forEach(p => { const k = f(p); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })); };
        const offset = Math.max(0, Number(Q.offset) || 0), limit = Math.min(300, Math.max(1, Number(Q.limit) || 120));
        const page = list.slice(offset, offset + limit);
        const det = new Map((await store.list("product", { _id: page.map(p => p._id) }, { limit: 400, fields: "_id, variants[]{_key, size}, offers[]{availability, _av}" })).map(d => [d._id, d]));
        const incoming = all.filter(p => p.status === "incoming" && (!Q.brand || p.brand === Q.brand)).length;
        return send(res, 200, { total: list.length, incoming, offset, tabs: (srcDoc?.tabs || []).map(t => ({ ...t, n: secCounts[t.h] || 0 })), baseTotal: base.length,
          facets: { brands: facet(base.filter(p => !Q.cat || cat(p) === Q.cat), p => p.brand), cats: facet(base.filter(p => !Q.brand || p.brand === Q.brand), cat), sources: facet(all, p => (p.offers || [])[0]?.sourceId), genders: facet(base.filter(p => (!Q.brand || p.brand === Q.brand) && (!Q.cat || cat(p) === Q.cat)), gen) },
          shown: list.filter(p => p.status === "published").length,
          products: page.map(p => ({ _id: p._id, g: p.overrides?.gender || p.gender || "u", stock: (p.overrides?.stock || p.stock)?.loc || null, brand: p.brand, title: p.overrides?.title || p.title, category: p.overrides?.category || p.category, status: p.status, cover: (p.images || [])[0]?.url || null, price: p.pricing, updatedAt: p.updatedAt, issues: p.issuesN ?? (p.issues || []).length, hidden: !!p.overrides?.hidden, source: (p.offers || [])[0]?.sourceId || null, avail: (p.offers || []).some(o => o.onlineOrder), pre: !!p.hasPre, gender: p.gender || null, sizes: sizeList(det.get(p._id) || p), createdAt: p.createdAt || null })) });
      }
      case "product": {
        const p = await store.get(req.query.id); if (!p) return send(res, 404, { error: "Не найден" });
        return send(res, 200, { product: p, storefront: toStorefront(p) });
      }
      case "imageUpload": {
        // Фото для ручной карточки: только JPEG/PNG/WebP до 3,5 МБ (браузер заранее уменьшает до 1600 px)
        const buf = Buffer.from(String(body.data || ""), "base64");
        if (!buf.length) return send(res, 400, { error: "Пустой файл" });
        if (buf.length > 3.5e6) return send(res, 400, { error: "Фото больше 3,5 МБ" });
        const type = buf[0] === 0xff && buf[1] === 0xd8 ? "image/jpeg" : buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : buf.slice(8, 12).toString() === "WEBP" ? "image/webp" : null;
        if (!type) return send(res, 400, { error: "Нужен JPEG, PNG или WebP" });
        if (!store.uploadImage) return send(res, 400, { error: "Хранилище фото не подключено" });
        try { const up = await store.uploadImage(buf, { filename: "manual-" + Date.now() + "." + type.split("/")[1], contentType: type }); return send(res, 200, { url: up.url }); }
        catch (e) { console.log("IMGUP fail " + JSON.stringify({ bytes: buf.length, why: String(e.message).slice(0, 200) })); return send(res, 502, { error: "Фото не сохранилось в хранилище: " + String(e.message).slice(0, 120) }); }
      }
      case "imageFromUrl": {
        // фото по ссылке магазина (если браузер не смог передать сам файл): сервер скачивает картинку и кладёт в наше хранилище
        const u = String(body.url || ""); let host = "";
        try { const x = new URL(u); if (x.protocol !== "https:") throw 0; host = x.hostname; } catch { return send(res, 400, { error: "Нужна ссылка https" }); }
        if (!store.uploadImage) return send(res, 400, { error: "Хранилище фото не подключено" });
        try { const { fetchBinary } = await import("../lib/images.js"); const bin = await fetchBinary(u, [host]);
          const up = await store.uploadImage(bin.buf, { filename: "web-" + Date.now() + "." + (bin.type.split("/")[1] || "jpg"), contentType: bin.type, sourceUrl: u }); return send(res, 200, { url: up.url }); }
        catch (e) { console.log("IMGURL fail " + JSON.stringify({ host, why: String(e.message).slice(0, 200) })); return send(res, 502, { error: "Не удалось скачать фото: " + String(e.message).slice(0, 120) }); }
      }
      case "botStatus": {
        if (!botToken()) return send(res, 200, { token: false });
        try { const me = await tg("getMe"); const hook = await tg("getWebhookInfo"); return send(res, 200, { token: true, username: me.username, name: me.first_name, ready: !!hook.url && hook.url.endsWith("/api/bot"), manager: !!process.env.TELEGRAM_MANAGER_CHAT, url: publicUrl(req) }); }
        catch (e) { return send(res, 200, { token: true, error: e.message }); }
      }
      case "botSetup": {
        try { return send(res, 200, await setupBot(publicUrl(req))); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      case "screenStatus": return send(res, 200, { enabled: screensEnabled() });
      case "screenRead": {
        // Скриншот → данные товара (Gemini). Сам скриншот нигде не сохраняется.
        const data = String(body.data || "");
        const buf = Buffer.from(data, "base64");
        if (!buf.length || buf.length > 3.5e6) return send(res, 400, { error: "Скриншот пустой или больше 3,5 МБ" });
        const type = buf[0] === 0xff && buf[1] === 0xd8 ? "image/jpeg" : buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : buf.slice(8, 12).toString() === "WEBP" ? "image/webp" : null;
        if (!type) return send(res, 400, { error: "Нужен JPEG, PNG или WebP" });
        try { return send(res, 200, { item: await readScreen(data, type, { fx: await getFx(store) }) }); }
        catch (e) { if (e instanceof ScreenError) return send(res, e.status === 429 ? 429 : 422, { error: e.message, retryAfter: e.retryAfter }); throw e; }
      }
      case "manualSave": return send(res, 200, { product: await saveManualProduct(store, body, { by: me.name, pricingCfg }) });
      case "webUpdate": {
        // прогон: товар уже есть — обновить цену и наличие по размерам
        const id = String(body.id || ""), it = body.item || {};
        if (!/^product\.manual\.[a-z0-9]{1,12}-[a-z0-9]{1,30}$/.test(id)) return send(res, 400, { error: "Нет артикула товара" });
        // обложка как на плитке раздела бренда (один раз на товар)
        if (/^https:\/\//.test(String(it.tileImg || ""))) { try { const p0 = await store.get(id); const { coverFromTile } = await import("../lib/imgdedupe.js"); const { fetchBinary } = await import("../lib/images.js"); if (p0 && await coverFromTile(store, p0, String(it.tileImg), { fetchBinary })) { await store.patchMany([id], { images: p0.images, coverFrom: "tile", coverTile: p0.coverTile }); PCACHE = null; } } catch (e) { console.log("COVER fail " + String(e.message).slice(0, 100)); } }
        return send(res, 200, await updateWebProduct(store, id, { boutique: it.boutique, sizeStock: it.sizeStock, preorder: !!it.preorder, unavailable: !!it.unavailable, ask: ["pre", "wait", "store"].includes(it.ask) ? it.ask : "", isNew: !!it.isNew, section: it.section, szDbg: it.szDbg }, { by: me.name, pricingCfg }));
      }
      case "fixBrands": {
        // выравнивание брендов и подразделов — отдельным запросом в фоне (админка не ждёт его, чтобы «Товары» открывались сразу)
        if (Date.now() - FIXAT < 10 * 60e3) return send(res, 200, { fixed: 0, recent: true });
        FIXAT = Date.now(); const fixed = await fixBrands(store) + await askNoSizes(store).catch(e => { console.log("ASKNOSZ err", e.message); return 0; }); if (fixed) PCACHE = null;
        return send(res, 200, { fixed });
      }
      case "imgDedupe": {
        // у уже загруженных товаров с сайтов брендов: убрать повторы одного фото в разных размерах (частями, с места остановки)
        const { dedupeAll } = await import("../lib/catalogload.js");
        const r = await dedupeAll(store, { budgetMs: 40000 }); if (r.changed) PCACHE = null;
        return send(res, 200, r);
      }
      case "sectionKnown": {
        // товары этого раздела у нас (артикул + ссылка): кнопка перепроверит по странице те, что не видны в разделе, — прежде чем считать «продано»
        const px = "product.manual." + String(req.query.prefix || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) + "-", section = String(req.query.section || "").slice(0, 200);
        if (px.length < 18 || !section) return send(res, 400, { error: "Нет раздела" });
        const list = (await allProducts(store)).filter(p => p._id.startsWith(px) && (p.webSections || []).includes(section) && p.sourceUrl).slice(0, 600).map(p => ({ code: p._id.slice(px.length).toUpperCase(), url: p.sourceUrl }));
        return send(res, 200, { list });
      }
      case "sectionSync": {
        // прогон: товары этого раздела, которых больше нет на сайте бренда, — «продано». Если раздел загрузился меньше чем наполовину — ничего не трогаем
        const px = "product.manual." + String(body.prefix || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) + "-", section = String(body.section || "").slice(0, 200);
        const codes = new Set((Array.isArray(body.codes) ? body.codes : []).map(c => String(c).toLowerCase().replace(/[^a-z0-9]/g, "")));
        if (px.length < 18 || !section) return send(res, 400, { error: "Нет раздела" });
        const mine = (await store.list("product", {}, { limit: 60000, fields: "_id, webSections" })).filter(p => p._id.startsWith(px) && (p.webSections || []).includes(section));
        const gone = mine.filter(p => !codes.has(p._id.slice(px.length))).map(p => p._id);
        if (mine.length && codes.size < mine.length * 0.5) { await rememberSection(store, { section, url: body.url, title: body.title, found: codes.size, inSection: mine.length, gone: 0, partial: true }); return send(res, 200, { gone: 0, skipped: true, inSection: mine.length, found: codes.size }); }
        const goneN = gone.length && !(mine.length && codes.size < mine.length * 0.5) ? await markWebGone(store, gone.slice(0, 500), { by: me.name, pricingCfg }) : 0;
        // отчёт о сайте (что кнопка прочитала) + категории товаров раздела + образец страницы товара для разбора
        const st = body.stats && typeof body.stats === "object" ? Object.fromEntries(["links", "tried", "read", "price", "newN", "img", "needSz", "sz"].map(k => [k, Math.max(0, Math.min(5000, Number(body.stats[k]) || 0))])) : null;
        if (st) { const all = await allProducts(store), ids = new Set(mine.map(p => p._id)), cats = { total: 0 }; for (const p of all) if (ids.has(p._id)) { const c = p.overrides?.category || p.category || "other"; cats[c] = (cats[c] || 0) + 1; cats.total++; } st.cats = cats; }
        if (body.sample && typeof body.sample === "object") { const host = String(body.host || "").replace(/[^a-z0-9.-]/gi, "").slice(0, 80); if (host) { const sd = (await store.get("settings.webSamples")) || { _id: "settings.webSamples", _type: "settings", list: {} }; sd.list = sd.list || {}; sd.list[host.replace(/\./g, "_")] = { host, at: new Date().toISOString(), sample: JSON.stringify(body.sample).length < 24000 ? body.sample : { title: String(body.sample.title || "").slice(0, 200), url: String(body.sample.url || "").slice(0, 300), tooBig: true } }; delete sd._rev; delete sd._createdAt; delete sd._updatedAt; try { await store.put(sd); } catch {} } }
        await rememberSection(store, { section, url: body.url, title: body.title, found: codes.size, inSection: mine.length, gone: goneN, health: st });
        return send(res, 200, { gone: goneN, inSection: mine.length });
      }
      case "webSections": {
        // разделы сайтов брендов, где нажимали кнопку: ссылка, когда прогоняли, что нашли
        const d = await store.get("settings.webSections");
        return send(res, 200, { sections: Object.values(d?.list || {}).sort((a, b) => String(a.lastRun).localeCompare(String(b.lastRun))) });
      }
      case "webSectionDel": {
        const d = await store.get("settings.webSections"); if (d?.list) { delete d.list[String(body.section || "")]; await store.put(d); }
        return send(res, 200, { ok: true });
      }
      case "markNew": {
        // товары, которые уже есть, но снова встретились в разделе «Новинки» сайта бренда — отмечаем новинками на месяц
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(i => /^product\.manual\.[a-z0-9]+-[a-z0-9]+$/.test(i)).slice(0, 500);
        const until = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10); let marked = 0;
        for (const id of ids) { try { await saveOverrides(store, id, { isNew: "on", newUntil: until }, me.name, pricingCfg); marked++; } catch {} }
        return send(res, 200, { marked });
      }
      case "bulkSubcategory": {
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(i => i.startsWith("product.")).slice(0, 2000);
        let changed = 0;
        for (const id of ids) { try { await saveOverrides(store, id, { subcategory: String(body.subcategory || "") || null }, me.name, pricingCfg); changed++; } catch {} }
        return send(res, 200, { changed });
      }
      case "subcats": { const { SUBCATS } = await import("../lib/normalize.js"); return send(res, 200, { subcats: Object.fromEntries(Object.entries(SUBCATS).map(([c, l]) => [c, l.map(([k, n]) => ({ k, n }))])) }); }
      case "bulkGender": {
        // для кого: w — женское, m — мужское, u — унисекс (у выбранных товаров)
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(i => i.startsWith("product.")).slice(0, 2000);
        if (!["w", "m", "u"].includes(body.gender)) return send(res, 400, { error: "Нет такого значения" });
        let changed = 0;
        for (const id of ids) { try { await saveOverrides(store, id, { gender: body.gender }, me.name, pricingCfg); changed++; } catch {} }
        PCACHE = null;
        return send(res, 200, { changed });
      }
      case "bulkCategory": {
        // смена категории у выбранных товаров (правка администратора, как в карточке товара)
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(i => i.startsWith("product.")).slice(0, 2000);
        const { CATEGORIES } = await import("../lib/normalize.js");
        if (!CATEGORIES[body.category]) return send(res, 400, { error: "Нет такой категории" });
        let changed = 0;
        for (const id of ids) { try { await saveOverrides(store, id, { category: body.category }, me.name, pricingCfg); changed++; } catch {} }
        return send(res, 200, { changed });
      }
      case "webImport": {
        // товар с кнопки «В Trend Büro» одним запросом: сервер сам скачивает фото по ссылкам (параллельно) и сохраняет товар скрытым
        const it = body.item || {}, id = String(body.id || "");
        if (!/^product\.manual\.[a-z0-9]{1,12}-[a-z0-9]{1,30}$/.test(id)) return send(res, 400, { error: "Нет артикула товара" });
        const { fetchBinary } = await import("../lib/images.js");
        const urls = [...new Set((Array.isArray(it.images) ? it.images : []).map(String).filter(u => /^https:\/\//.test(u)))].slice(0, 8);
        let copied = 0;
        if (it.revive) { const dd = await store.get("settings.deleted"); if (dd && (dd.ids || []).includes(id)) { dd.ids = dd.ids.filter(x => x !== id); delete dd._rev; delete dd._createdAt; delete dd._updatedAt; await store.put(dd); } } // открыли товар сами и нажали кнопку — снова берём
        const images = (await Promise.all(urls.map(async u => {
          try { const b = await Promise.race([fetchBinary(u, [new URL(u).hostname]), new Promise((_, no) => setTimeout(() => no(new Error("долго")), 20000))]);
            const up = await store.uploadImage(b.buf, { filename: "web-" + Date.now() + "." + (b.type.split("/")[1] || "jpg"), contentType: b.type, sourceUrl: u }); copied++; return up.url; }
          catch (e) { console.log("IMGURL fail " + JSON.stringify({ host: new URL(u).hostname, why: String(e.message).slice(0, 120) })); return u; } // не скачалось — ставим ссылку магазина
        }))).filter(Boolean);
        if (!images.length) return send(res, 400, { error: "Нет фото" });
        try { const { dedupeImages } = await import("../lib/imgdedupe.js"); const uniq = await dedupeImages(images); if (uniq.length) images.splice(0, images.length, ...uniq); } catch {} // одно фото в нескольких размерах — оставляем крупное
        // немецкий сайт (LV и др.) — название, описание и цвета переводим на английский; ошибка перевода не мешает загрузке
        let itEn = it;
        try { const { englishItem } = await import("../lib/translate.js"); itEn = await englishItem(it, await store.get(id)); } catch (e) { console.log("TR fail " + JSON.stringify({ id, why: String(e.message).slice(0, 120) })); }
        const product = await saveManualProduct(store, { ...itEn, id, images, availability: "online", status: "incoming", boutique: Number(it.boutique), fromWeb: true }, { by: me.name, pricingCfg });
        return send(res, 200, { id: product._id, images: images.length, copied, price: product.pricing?.eu || null });
      }
      case "pricePreview": {
        const { priceFor } = await import("../lib/pipeline.js");
        const p = priceFor({ sourceKind: "official", boutique: Number(body.boutique) || null, region: "DE", currency: "EUR" }, pricingCfg, Number(body.pinned) || null, body.category || null);
        return send(res, 200, { ua: p.ua, eu: p.eu, dxb: p.dxb });
      }
      case "watchGet": {
        let w = await store.get("settings.watch");
        if (!w) { w = { _id: "settings.watch", _type: "settings", code: String(Math.floor(100000 + Math.random() * 900000)), tiles: [] }; await store.put(w); }
        return send(res, 200, { code: w.code, tiles: w.tiles || [] });
      }
      case "watchSave": {
        const w = (await store.get("settings.watch")) || { _id: "settings.watch", _type: "settings", code: String(Math.floor(100000 + Math.random() * 900000)) };
        w.tiles = (body.tiles || []).slice(0, 40).map((t, i) => ({ id: String(t.id || "t" + Date.now() + i).slice(0, 30), title: String(t.title || "").trim().slice(0, 60), brand: String(t.brand || "").trim().slice(0, 40), url: String(t.url || "").trim().slice(0, 600) }))
          .filter(t => t.title && /^https:\/\//.test(t.url));
        if (body.newCode) w.code = String(Math.floor(100000 + Math.random() * 900000));
        w.by = me.name; w.at = new Date().toISOString();
        await store.put(w);
        return send(res, 200, { code: w.code, tiles: w.tiles });
      }
      case "leads": {
        const where = LEAD_STATUS.includes(req.query.status) ? { status: req.query.status } : {};
        const [leads, fresh] = await Promise.all([store.list("lead", where, { order: "createdAt desc", limit: 300 }), store.count("lead", { status: "new" })]);
        return send(res, 200, { leads, fresh });
      }
      case "leadSave": {
        const l = await store.get(body.id); if (!l || l._type !== "lead") return send(res, 404, { error: "Заявка не найдена" });
        const now = new Date().toISOString();
        if (body.status && LEAD_STATUS.includes(body.status) && body.status !== l.status) { l.history = [...(l.history || []).slice(-30), { at: now, status: body.status, by: me.name }]; l.status = body.status; }
        const changed = body.status && LEAD_STATUS.includes(body.status) && l.history?.[l.history.length - 1]?.at === now;
        if (body.note !== undefined) l.note = String(body.note).slice(0, 2000);
        if (body.track !== undefined) l.track = String(body.track).replace(/[^\w\- ]/g, "").slice(0, 40);
        // маршрут заказа для клиента: где выкупили, когда отправка в Украину, когда Новая почта
        if (body.buyMode !== undefined) l.buyMode = body.buyMode === "online" ? "online" : "boutique";
        for (const k of ["buyCity", "buyDate", "shipDate", "npDate", "uaCity"]) if (body[k] !== undefined) l[k] = String(body[k]).replace(/\s+/g, " ").trim().slice(0, 40);
        if (changed && body.notify !== false) l.clientNotified = await notifyClient(l, l.status);
        l.updatedAt = now; l.manager = me.name;
        return send(res, 200, { lead: await store.put(l) });
      }
      case "customers": {
        // клиенты из Telegram: профиль доставки, сколько заказов и на какую сумму, когда заходили
        const [cs, ls] = await Promise.all([store.list("customer", {}, { order: "lastSeen desc", limit: 1000 }), store.list("lead", {}, { limit: 5000, fields: "_id, tgId, number, kind, status, total, createdAt, items[]{brand, title}" })]);
        const by = {}; ls.forEach(l => { if (l.tgId) (by[l.tgId] = by[l.tgId] || []).push(l); });
        return send(res, 200, { customers: cs.map(c => { const o = (by[c.tg?.id] || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), paid = o.filter(l => l.kind === "order" && ["paid", "bought", "shipping", "np", "delivered"].includes(l.status));
          return { id: c._id, tg: c.tg, profile: c.profile, createdAt: c.createdAt, lastSeen: c.lastSeen, orders: o.filter(l => l.kind === "order").length, requests: o.filter(l => l.kind !== "order").length, spent: paid.reduce((a, l) => a + (l.total || 0), 0), leads: o.slice(0, 30) }; }) });
      }
      case "finance": {
        const days = { week: 7, month: 31, quarter: 92, year: 366 }[req.query.period] || 31;
        const since = new Date(Date.now() - days * 864e5).toISOString();
        const all = (await store.list("lead", { kind: "order" }, { order: "createdAt desc", limit: 5000, fields: "createdAt, status, total, dest, items[]{brand, price}" })).filter(l => l.status !== "cancelled");
        const inPeriod = all.filter(l => l.createdAt >= since);
        const done = inPeriod.filter(l => ["paid", "bought", "shipping", "np", "delivered"].includes(l.status));
        const mk = mergeConfig(pricingCfg).official.markup;
        const margin = l => (l.total || 0) - (l.total || 0) / (1 + (l.dest === "ua" || !l.dest ? mk.ua : l.dest === "eu" ? mk.eu : mk.dxb));
        const sum = (a, f) => Math.round(a.reduce((s, x) => s + (f(x) || 0), 0));
        const byBrand = {};
        done.forEach(l => (l.items || []).forEach(i => { if (i.brand) byBrand[i.brand] = (byBrand[i.brand] || 0) + (i.price || 0); }));
        const buckets = 6, step = days * 864e5 / buckets, start = Date.now() - days * 864e5;
        const series = Array.from({ length: buckets }, (_, k) => sum(done.filter(l => { const t = Date.parse(l.createdAt); return t >= start + k * step && t < start + (k + 1) * step; }), l => l.total));
        return send(res, 200, {
          revenue: sum(done, l => l.total), margin: sum(done, margin), orders: done.length, avg: done.length ? Math.round(sum(done, l => l.total) / done.length) : 0, series,
          pipeline: { awaiting: sum(all.filter(l => ["new", "work"].includes(l.status)), l => l.total), paid: sum(all.filter(l => l.status === "paid"), l => l.total), moving: sum(all.filter(l => ["bought", "shipping", "np"].includes(l.status)), l => l.total) },
          brands: Object.entries(byBrand).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([brand, total]) => ({ brand, total: Math.round(total) }))
        });
      }
      case "leadDelete": { const ids = (body.ids || []).filter(i => String(i).startsWith("lead.")).slice(0, 200); await store.delMany(ids); return send(res, 200, { deleted: ids.length }); }
      case "cmsList": {
        const kind = String(req.query.kind || "");
        if (!KINDS.includes(kind)) return send(res, 400, { error: "Неизвестный тип" });
        return send(res, 200, { items: await listItems(store, kind), ...(kind === "banner" ? { stats: await bannerStats(store) } : {}) });
      }
      case "cmsSave": return send(res, 200, { item: await saveItem(store, body.kind, body.item || {}, me.name) });
      case "cmsDelete": return send(res, 200, { deleted: await deleteItems(store, body.ids) });
      case "cmsReorder": return send(res, 200, { ok: await reorder(store, body.kind, body.ids) });
      case "cmsActive": return send(res, 200, { ok: await setActive(store, body.ids, body.active) });
      case "siteGet": { await seedRails(store, me.name); return send(res, 200, { site: await getSite(store), blocks: FEED_BLOCKS, texts: TEXTS, presets: THEME_PRESETS, catColors: CAT_COLORS }); }
      case "siteSave": return send(res, 200, { site: await saveSite(store, body.site || {}, me.name) });
      case "brands": {
        const list = await store.list("product", {}, { limit: 5000, fields: "brand" });
        return send(res, 200, { brands: [...new Set(list.map(p => p.brand).filter(Boolean))].sort() });
      }
      case "productPick": {
        // быстрый поиск товаров для баннеров и подборок
        const q = String(req.query.q || "").toLowerCase(), ids = String(req.query.ids || "").split(",").filter(Boolean);
        let list = await store.list("product", {}, { limit: 5000, order: "updatedAt desc", fields: "_id, brand, title, overrides, status, images[0...1]{url}, pricing{ua}" });
        if (ids.length) list = list.filter(p => ids.includes(p._id));
        else if (q) list = list.filter(p => [p.brand, p.overrides?.title, p.title].join(" ").toLowerCase().includes(q));
        return send(res, 200, { products: list.slice(0, 40).map(p => ({ _id: p._id, brand: p.brand, title: p.overrides?.title || p.title, status: p.status, cover: p.images?.[0]?.url || null, price: p.pricing?.ua ?? null })) });
      }
      case "productSave": return send(res, 200, { product: await saveOverrides(store, body.id, body.changes || {}, me.name, pricingCfg) });

      case "pricing": return send(res, 200, { config: mergeConfig(pricingCfg), defaults: PRICING_DEFAULTS });
      case "pricingPreview": {
        const cfg = mergeConfig(body.config || pricingCfg);
        const cases = (body.cases && body.cases.length ? body.cases : [
          { kind: "official", boutique: 3000, dest: "ua" }, { kind: "official", boutique: 3000, dest: "eu" },
          { kind: "official", boutique: 50, dest: "ua", category: "clothing" }, { kind: "official", boutique: 340, dest: "ua", category: "clothing" },
          { kind: "official", boutique: 200, dest: "ua", category: "shoes" }, { kind: "official", boutique: 500, dest: "ua", category: "shoes" },
          { kind: "official", boutique: 20, dest: "ua", category: "accessories" }, { kind: "official", boutique: 95, dest: "ua", category: "other" }, { kind: "official", boutique: 338, dest: "ua", category: "clothing" },
          { kind: "official", retailer: true, boutique: 270, dest: "ua", category: "clothing" }, { kind: "official", retailer: true, boutique: 100, dest: "ua", category: "clothing" },
          { kind: "official", retailer: true, boutique: 450, dest: "ua", category: "clothing" }, { kind: "official", retailer: true, boutique: 270, dest: "ua", category: "shoes" },
          { kind: "eyewear-supplier", boutique: 330, purchase: 240 }, { kind: "eyewear-supplier", boutique: 400, purchase: 300 },
          { kind: "eyewear-supplier", boutique: 460, purchase: 300 }, { kind: "eyewear-supplier", boutique: 1000, purchase: 800 },
          { kind: "eyewear-supplier", boutique: 1000, purchase: 900 }, { kind: "official", boutique: null }
        ]).slice(0, 50);
        // влияние на опубликованные товары: сколько цен изменится
        let changes = [];
        if (body.config) {
          const pub = await store.list("product", { status: "published" }, { limit: 50000 });
          changes = pub.map(p => ({ id: p._id, title: p.title, brand: p.brand, before: p.pricing?.ua ?? null, after: computePricing(p, body.config).ua })).filter(x => x.before !== x.after).slice(0, 300);
        }
        const { unifiedPrice } = await import("../lib/pricing.js");
        return send(res, 200, { results: cases.map(c => ({ input: c, ...(cfg.unified?.on && c.kind !== "eyewear-supplier" ? unifiedPrice(c.boutique, c.category || null, cfg) : priceOffer(c, cfg)) })), changes });
      }
      case "pricingSave": {
        if (!body.confirmPreview) return send(res, 400, { error: "Сначала посмотрите предпросмотр изменений цен" });
        const cfg = mergeConfig(body.config);
        await store.put({ _id: "settings.pricing", _type: "settings", config: cfg, by: me.name, at: new Date().toISOString() });
        // пересчёт всех товаров (и на витрине — предпросмотр уже посмотрели) точечными правками пачками
        let r = { done: false, cursor: "" }, changed = 0; const t0 = Date.now();
        while (!r.done && Date.now() - t0 < 45000) { r = await repriceAll(store, cfg, { cursor: r.cursor, budgetMs: 45000 - (Date.now() - t0) }); changed += r.changed; }
        if (r.done) await store.put({ _id: "settings.priceVer", _type: "settings", v: PRICE_VER, cursor: "", at: new Date().toISOString() });
        console.log("[price] save", JSON.stringify({ changed, done: r.done }));
        return send(res, 200, { ok: true, updated: changed, done: r.done });
      }
      default: return send(res, 404, { error: "Неизвестное действие" });
    }
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
}
/** Размеры товара с наличием у поставщика: [{s:"M", ok:true}] */
function sizeList(p) {
  const out = new Map(), av = Object.assign({}, ...(p.offers || []).map(o => o.availability || {}));
  for (const v of p.variants || []) if (v.size) { const ok = ["online", "boutique"].includes(av[v._key]?.status); out.set(v.size, out.get(v.size) || ok); }
  return [...out].map(([s, ok]) => ({ s, ok })).slice(0, 14);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

async function rememberSection(store, x) {
  const d = (await store.get("settings.webSections")) || { _id: "settings.webSections", _type: "settings", list: {} };
  const url = /^https:\/\//.test(String(x.url || "")) ? String(x.url).slice(0, 500) : (d.list[x.section]?.url || null);
  d.list = d.list || {};
  d.list[x.section] = { section: x.section, url, title: String(x.title || d.list[x.section]?.title || "").replace(/\s*[|–-]\s*[^|–-]*$/, "").slice(0, 120), lastRun: new Date().toISOString(), found: x.found, inSection: x.inSection, gone: x.gone, partial: !!x.partial, health: x.health || d.list[x.section]?.health || null };
  const { _rev, _createdAt, _updatedAt, ...save } = d; await store.put(save);
}
