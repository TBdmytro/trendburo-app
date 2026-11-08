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
import { toStorefront, genderOf } from "../lib/catalog.js";
import { saveManualProduct, updateWebProduct, markWebGone } from "../lib/manual.js";
import { LEAD_STATUS, notifyClient } from "./lead.js";
import { makeManualOrder, clientStats, customerId } from "../lib/customers.js";
import { accessSettings, accessOf, setClosed, setAccess, adminLinkCode, adminUnlink, NOTIFY_ID, adminBotToken } from "../lib/access.js";
import { allSourceIds, detectSupplier, addSupplier, updateSupplier, removeSupplier, listCollections, saveCollections } from "../lib/suppliers.js";
import { getFx, refreshFx, saveManualFx } from "../lib/fx.js";
import { readScreen, screensEnabled, ScreenError } from "../lib/screens.js";
import { setupBot, botToken, publicUrl, tg, hookSecret } from "./bot.js";
import { listItems, saveItem, deleteItems, reorder, setActive, getSite, saveSite, seedRails, FEED_BLOCKS, TEXTS, KINDS, bannerStats, THEME_PRESETS, CAT_COLORS } from "../lib/cms.js";

const send = (res, code, body) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
const slim = j => { if (!j) return j; const { rows, seen, queue, attempts, catRoot, discover, ...rest } = j; return { ...rest, queued: j.queuedCount ?? (queue || []).length, discoverLeft: j.discoverLeft ?? (discover || []).length }; };
// Задачи без тяжёлых полей (строки файла, очередь ссылок) — список грузится мгновенно
const JOB_FIELDS = `..., "rows": null, "seen": null, "queue": null, "attempts": null, "catRoot": null, "discover": null, "queuedCount": count(queue), "discoverLeft": count(discover)`;

// список товаров для «Товаров», брендов и фильтров: держим 30 с в памяти, чтобы админка открывалась быстро.
// Любое изменение (кроме потока загрузки с кнопки) сбрасывает — после «На сайт», правок и удаления список свежий.
let PCACHE = null;
// только лёгкие поля: размеры и наличие по размерам дочитываются для открытой страницы (до 120 товаров), а не для всех тысяч
// фото с сайта бренда → в наше хранилище, в том же порядке (первое — обложка как на плитке бренда). Без «склейки похожих»: перед и зад сумки похожи, их нельзя объединять
const BLOCKED = new Map();
async function copyWebImages(store, list, id = "") {
  const { fetchBinary } = await import("../lib/images.js");
  // битые ссылки (обрывок srcset, склеенный с адресом раздела: «…/schuhe/5000&wid=1334…») не берём
  const sane = u => { try { const x = new URL(u); return x.protocol === "https:" && !/&/.test(x.pathname) && (!/=/.test(x.pathname) || /^\/cdn-cgi\/image\//.test(x.pathname)); } catch { return false; } }; // /cdn-cgi/image/width=…/ — нормальный адрес фото (Dior: фото на модели)
  // Contentful (On и др.): оригиналы — PNG 4000×4000 по 10+ МБ, не влезают; берём ту же картинку в 1600 px JPEG
  const fit = u => { try { const x = new URL(u); if (x.hostname === "images.ctfassets.net") return x.origin + x.pathname + "?w=1600&h=1600&fm=jpg&q=85&fit=pad&bg=rgb:ffffff"; } catch {} return u; };
  // порядок: лицевой кадр первым, на модели — в конце (Dior: без мелкого дубля «в рамке»), до 10 фото
  const { orderImages } = await import("../lib/imgorder.js");
  const urls = orderImages([...new Set((Array.isArray(list) ? list : []).map(String).filter(sane).map(fit))], { max: 12, sku: String(id).replace(/^product\.manual\.[a-z0-9]+-/, "") });
  let copied = 0; const srcOf = {}; // наша копия → адрес фото на сайте бренда (по нему потом можно навести порядок)
  const images = (await Promise.all(urls.map(async u => {
    const host = new URL(u).hostname;
    if (BLOCKED.get(host) > Date.now()) return u; // сервер фото недавно ответил «запрещено» — не стучимся повторно (фото показываем по ссылке бренда)
    try { const b = await Promise.race([fetchBinary(u, [new URL(u).hostname]), new Promise((_, no) => setTimeout(() => no(new Error("долго")), 20000))]);
      const up = await store.uploadImage(b.buf, { filename: "web-" + Date.now() + "." + (b.type.split("/")[1] || "jpg"), contentType: b.type, sourceUrl: u }); copied++; const { trimUrl } = await import("../lib/imgtrim.js"); const tu = await trimUrl(up.url).catch(() => up.url); srcOf[tu] = u; return tu; }
    catch (e) { if (/\b403\b/.test(String(e.message))) BLOCKED.set(host, Date.now() + 6 * 36e5); console.log("IMGURL fail " + JSON.stringify({ host, why: String(e.message).slice(0, 120) })); return u; }
  }))).filter(Boolean);
  // не скачалось — ссылку сайта бренда оставляем, только если других фото нет (иначе на витрине пустая обложка)
  const ok = images.filter(u => /^https:\/\/cdn\.sanity\.io\//.test(u));
  return { images: ok.length ? ok : images, copied, srcOf };
}
const PFIELDS = "_id, brand, title, sourceTitle, modelSku, overrides, category, subcategory, status, images[0...1]{url}, pricing{ua, eu, dxb}, updatedAt, createdAt, \"issuesN\": count(issues), gender, sections, secPos, webSections, sourceUrl, offers[]{sourceId, onlineOrder}, \"chk\": offers[0].checkedAt, \"stAt\": offers[0].stockAt, stock, hasPre, \"nSz\": count(sizes), \"nIm\": count(images), imgVer, soldOld";
let FIXOBJ = false, FIXMIU = false, FIXPRE = false, FIXOTHER = false, FIXDIOR = false, FIXLV = false, FIXGUCCI = false, FIXGG = false, FIXLVSOLD = false, FIXLVSOLD2 = false, COLLSCAN_AT = 0;
// версия набора фото: 3 — с галереей страницы (фото на модели) для сайтов, где у таких кадров нет артикула в адресе
const IMGV = id => /^product\.manual\.dior-/.test(id) ? 5 : /^product\.manual\.on-/.test(id) ? 3 : 2; // dior 5: все фото страницы товара (все кадры на модели)
/** После удаления: бренд, у которого не осталось ни одного товара, — в «не брать»; поставщик без товаров — ночное обновление выключаем. */
async function blockEmptied(store, removed) {
  const brands = new Set(removed.map(p => String(p.brand || "").trim()).filter(Boolean)), srcs = new Set(removed.flatMap(p => (p.offers || []).map(o => o.sourceId)).filter(s => s && s !== "manual"));
  if (!brands.size && !srcs.size) return {};
  const left = await store.list("product", {}, { limit: 60000, fields: "_id, brand, offers[]{sourceId}" });
  const { brandKey } = await import("../lib/normalize.js");
  const keepB = new Set(left.map(p => brandKey(p.brand))), keepS = new Set(left.flatMap(p => (p.offers || []).map(o => o.sourceId)));
  const goneB = [...brands].filter(b => !keepB.has(brandKey(b))), goneS = [...srcs].filter(s => !keepS.has(s));
  if (goneB.length) { const d = (await store.get("settings.blockedBrands")) || { _id: "settings.blockedBrands", _type: "settings", list: [] };
    const set = new Set(d.list || []); goneB.forEach(b => set.add(brandKey(b))); await store.put({ _id: d._id, _type: "settings", list: [...set], at: new Date().toISOString() }); }
  for (const s of goneS) { const doc = await store.get("source." + s); if (doc && doc.schedule !== "off") await store.patchMany([doc._id], { schedule: "off", pausedBy: "deleted", pausedAt: new Date().toISOString() }); }
  return { blockedBrands: goneB, pausedSources: goneS };
}
async function allProducts(store) {
  // 5 минут: список всех товаров — самый тяжёлый запрос к базе; после любой правки PCACHE сбрасывается
  if (PCACHE && Date.now() - PCACHE.at < 5 * 60e3) return PCACHE.data;
  const data = await store.list("product", {}, { order: "updatedAt desc", limit: 50000, fields: PFIELDS });
  PCACHE = { at: Date.now(), data }; return data;
}
// ключ кнопки «В Trend Büro»: даёт только загрузку товаров с сайтов брендов (скрытыми), без доступа к остальной админке.
// Хранится на сервере только отпечаток (sha256); сам ключ — внутри закладки пользователя
const KEY_ACTIONS = new Set(["me", "knownProducts", "webImport", "webUpdate", "sectionKnown", "sectionSync", "markNew", "imageUpload", "subcats", "snapSave"]);
const keyHash = k => createHash("sha256").update(String(k)).digest("hex");
async function keySession(req, a, store) {
  const k = String(req.headers["x-tb-key"] || ""); if (!/^[a-f0-9]{48}$/.test(k) || !KEY_ACTIONS.has(a)) return null;
  const d = await store.get("settings.importKeys"); const h = keyHash(k);
  return (d?.list || []).some(x => x.h === h) ? { name: "Кнопка", key: true } : null;
}
let FIXAT = 0; // приводить бренды/подразделы при открытии «Товаров» — не чаще раза в 30 минут (ночью — всегда, в cron)

let COLLP = null, COLLP_AT = 0;
async function collProds(store) {
  if (COLLP && Date.now() - COLLP_AT < 120000) return COLLP;
  const L = await store.list("product", {}, { limit: 60000, fields: "_id, status, webSections, images[0...1]{url}" });
  COLLP = L.filter(p => (p.webSections || []).length); COLLP_AT = Date.now(); return COLLP;
}
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
    if (req.method !== "GET" && !["webImport", "webUpdate", "imageUpload", "imageFromUrl", "snapSave"].includes(a)) PCACHE = null;
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
        // вы сами запустили загрузку поставщика — его бренды снова можно брать, ночное обновление снова включено
        try { const sd = await store.get("source." + String(body.sourceId || "")); const { brandKey } = await import("../lib/normalize.js"); const bb = await store.get("settings.blockedBrands");
          const mine = [sd?.brand, sd?.custom?.brand, ...(sd?.brands || []), ...(sd?.custom?.brands || [])].filter(Boolean).map(brandKey);
          if (bb?.list?.length && mine.length) await store.put({ _id: bb._id, _type: "settings", list: bb.list.filter(b => !mine.includes(b)), at: new Date().toISOString() });
          if (sd?.pausedBy === "deleted") await store.patchMany([sd._id], { schedule: "daily", pausedBy: null }); } catch {}
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
        const was = (await store.getMany(ids)).filter(Boolean);
        await store.delMany(ids);
        // запоминаем удалённые — загрузка каталога поставщика (в том числе ночная) не вернёт их скрытыми
        await rememberDeleted(store, ids);
        // удалили бренд или поставщика целиком — ночная загрузка его больше не приносит (новые товары тоже)
        const off = await blockEmptied(store, was);
        return send(res, 200, { ok: true, deleted: ids.length, ...off });
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
        const ids = all.filter(p => (!Q.sec || (p.sections || []).includes(Q.sec) || (p.webSections || []).includes(Q.sec)) && (!Q.avail || (p.offers || []).some(o => o.onlineOrder)) && (!Q.noavail || !(p.offers || []).some(o => o.onlineOrder)) && (!q || [p.brand, p.title, p.sourceTitle, p.modelSku, p.overrides?.title].join(" ").toLowerCase().includes(q)) && (Q.status ? p.status === Q.status : p.status !== "incoming")
          && (!Q.source || (p.offers || []).some(o => o.sourceId === Q.source)) && (!Q.brand || p.brand === Q.brand) && (!Q.cat || (p.overrides?.category || p.category) === Q.cat)).map(p => p._id);
        return send(res, 200, { ids });
      }

      case "webProgress": {
        // ход прогона кнопки (где стоит, сколько нашла и проверила) — последние 30 отметок по сайтам; читается в диагностике
        if (req.method === "GET") return send(res, 200, (await store.get("settings.webProgress")) || { list: [] });
        const p = body.p && typeof body.p === "object" ? body.p : null; if (!p) return send(res, 400, { error: "Нет данных" });
        const clean = Object.fromEntries(Object.entries(p).filter(([k, v]) => /^[a-zA-Z]{1,12}$/.test(k) && (typeof v === "number" || (typeof v === "string" && v.length <= 160))));
        const d = (await store.get("settings.webProgress")) || { _id: "settings.webProgress", _type: "settings", list: [] };
        d.list = [{ ...clean, at: new Date().toISOString() }, ...(d.list || [])].slice(0, 30); delete d._rev; delete d._createdAt; delete d._updatedAt;
        await store.put(d); return send(res, 200, { ok: true });
      }
      case "knownProducts": {
        // какие товары с этого сайта уже есть (на витрине или скрыты) — кнопка «В Trend Büro» их не берёт повторно
        const px = "product.manual." + String(req.query.prefix || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) + "-";
        if (px.length < 18) return send(res, 400, { error: "Нет сайта" });
        const all = await allProducts(store);
        // fresh — проверены кнопкой за последние 12 часов: при повторном прогоне их не открываем заново (быстрее)
        const status = {}, fresh = {}, since = Math.max(Date.now() - 24 * 36e5, px === "product.manual.de-" ? Date.parse("2026-11-07T22:40:00Z") : /^product\.manual\.(prada|miumiu)-$/.test(px) ? Date.parse("2026-11-08T12:30:00Z") : 0); // Prada / Miu Miu: до кнопки v99 наличие читалось неверно (всё «уточнить») — проверяем заново // LV: наличие читается только с кнопки v67 — всё, что проверено раньше, проверяем заново
        for (const id of await deletedSet(store)) if (id.startsWith(px)) status[id.slice(px.length).toUpperCase()] = "rejected"; // вы удалили — кнопка не вернёт
        for (const p of all) if (p._id.startsWith(px)) { const k = p._id.slice(px.length).toUpperCase(); status[k] = p.status || "draft"; const ck = p.chk || p.offers?.[0]?.checkedAt; const needSz = ["shoes", "clothing"].includes(p.overrides?.category || p.category) && !p.nSz; if (ck && Date.parse(ck) > since && !needSz && p.imgVer === IMGV(p._id) && /^https:\/\/(cdn\.sanity\.io|[a-z]+\.louisvuitton\.com)\//.test(p.images?.[0]?.url || "") && (p.nIm || 0) >= 2 && (px !== "product.manual.de-" || Date.parse(p.stAt || "") > Date.now() - 3 * 864e5)) fresh[k] = 1; } // LV: «свежий» — только если и наличие читали недавно // фото не скопировано — открываем снова // без размеров — проверяем снова
        // когда у товара последний раз читали наличие (открытая страница как у покупателя) — кнопка проверяет сначала самые давние
        const stockAt = {}; for (const p of all) if (p._id.startsWith(px)) { const t = Date.parse(p.stAt || ""); if (t) stockAt[p._id.slice(px.length).toUpperCase()] = t; }
        return send(res, 200, { status, fresh, stockAt });
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
        // один раз: «уточнить наличие» пересчитываем по новому правилу (только если ни один размер не купить)
        if (!FIXPRE) { FIXPRE = true; try { const fl = await store.get("settings.fixPre"); if (!fl) { const { needAsk } = await import("../lib/manual.js");
          const L = await store.list("product", { hasPre: true }, { limit: 20000, fields: "_id, offers[]{availability}" });
          const ch = L.filter(p => !needAsk(p.offers?.[0]?.availability)).map(p => ({ id: p._id, set: { hasPre: false } }));
          for (let i = 0; i < ch.length; i += 200) await store.patchEach(ch.slice(i, i + 200));
          await store.put({ _id: "settings.fixPre", _type: "settings", at: new Date().toISOString(), fixed: ch.length }); PCACHE = null; console.log("FIXPRE " + ch.length); } } catch (e) { FIXPRE = false; console.log("FIXPRE fail " + String(e.message).slice(0, 120)); } }
        // один раз: фото Dior — убрать фото других товаров (рекомендации со страницы), лицевой кадр первым, на модели — в конце (ваш порядок/обложку из админки не трогаем)
        if (!FIXDIOR) { FIXDIOR = true; try { if (!(await store.get("settings.fixDiorImg2"))) { const { orderImages } = await import("../lib/imgorder.js");
          const L = (await store.list("product", {}, { limit: 20000, fields: "_id, images, overrides, coverFrom" })).filter(p => p._id.startsWith("product.manual.dior-") && !p.overrides?.cover && !(p.overrides?.imageOrder || []).length);
          const ch = []; for (const p of L) { const im = p.images || [], src = im.map(i => i.sourceUrl || i.url), ord = orderImages(src, { max: 12, sku: p._id.replace(/^product\.manual\.dior-/, "") }); const next = ord.map(u => im[src.indexOf(u)]).filter(Boolean);
            if (next.length && next.map(i => i.url).join("|") !== im.map(i => i.url).join("|")) ch.push({ id: p._id, set: { images: next, coverFrom: null } }); }
          for (let i = 0; i < ch.length; i += 100) await store.patchEach(ch.slice(i, i + 100));
          await store.put({ _id: "settings.fixDiorImg2", _type: "settings", at: new Date().toISOString(), fixed: ch.length }); if (ch.length) PCACHE = null; console.log("FIXDIOR " + ch.length); } } catch (e) { FIXDIOR = false; console.log("FIXDIOR fail " + String(e.message).slice(0, 120)); } }
        // один раз: сумки LV, у которых на сайте видна только «Сообщить о поступлении» (прочитано кнопкой до v88), — распроданы: скрытые удаляем, на витрине — «продано»
        if (!FIXLVSOLD) { FIXLVSOLD = true; try { if (!(await store.get("settings.fixLvSold1"))) {
          const L = (await store.list("product", {}, { limit: 20000, fields: "_id, status, sizes, sizeDebug, offers[0...1]{availability}" })).filter(p => p._id.startsWith("product.manual.de-") && !(p.sizes || []).length && /buy:wait/.test(String(p.sizeDebug || "")) && Object.values(p.offers?.[0]?.availability || {}).every(a => a.status === "ask"));
          const del = L.filter(p => p.status !== "published").map(p => p._id), pub = L.filter(p => p.status === "published").map(p => p._id);
          if (del.length) await store.delMany(del); if (pub.length) await markWebGone(store, pub, { by: "система", pricingCfg });
          await store.put({ _id: "settings.fixLvSold1", _type: "settings", at: new Date().toISOString(), del: del.length, sold: pub.length }); PCACHE = null; console.log("FIXLVSOLD " + del.length + "/" + pub.length); } } catch (e) { FIXLVSOLD = false; console.log("FIXLVSOLD fail " + String(e.message).slice(0, 120)); } }
        // один раз (новое правило): распроданные у LV сумки — новинка → «уточнить наличие» (остаётся на витрине); старая → «Распродано у бренда», с витрины в «Новые с сайтов»
        if (!FIXLVSOLD2) { FIXLVSOLD2 = true; try { if (!(await store.get("settings.fixLvSold2"))) { const { saveOverrides } = await import("../lib/publish.js");
          const L = (await store.list("product", {}, { limit: 20000, fields: "_id, status, sizes, sizeDebug, overrides, variants, offers" })).filter(p => p._id.startsWith("product.manual.de-") && /buy:wait/.test(String(p.sizeDebug || "")) && Object.values(p.offers?.[0]?.availability || {}).every(a => a.status === "out" || a.status === "ask"));
          let nw = 0, old = 0; const ch = [];
          for (const p of L) { const o = p.offers[0], av = Object.fromEntries(Object.keys(o.availability || {}).map(k => [k, { status: "ask", price: null }])); const isNew = p.overrides?.isNew === "on";
            ch.push({ id: p._id, set: { offers: [{ ...o, availability: av, onlineOrder: false }], hasPre: true, soldOld: !isNew, ...(isNew ? {} : { status: "incoming" }) } }); isNew ? nw++ : old++; }
          for (let i = 0; i < ch.length; i += 100) await store.patchEach(ch.slice(i, i + 100));
          await store.put({ _id: "settings.fixLvSold2", _type: "settings", at: new Date().toISOString(), nw, old }); PCACHE = null; console.log("FIXLVSOLD2 new " + nw + " old " + old); } } catch (e) { FIXLVSOLD2 = false; console.log("FIXLVSOLD2 fail " + String(e.message).slice(0, 120)); } }
        // один раз: Golden Goose — убрать со страниц подборки «co-creation» (фото не этого товара)
        // один раз: Miu Miu — обложка не фото на модели: товар спереди первым, «на модели» в конце; ваш порядок и обложку не трогаем
        if (!FIXOBJ) { FIXOBJ = true; try { if (!(await store.get("settings.fixObjPm1"))) { const { objCategory } = await import("../lib/normalize.js");
          const L = (await store.list("product", {}, { limit: 20000, fields: "_id, title, sourceTitle, category, overrides" })).filter(p => /^product\.manual\.(miumiu|prada)-/.test(p._id) && !p.overrides?.category && !["jewelry", "eyewear"].includes(p.category));
          const ch = []; for (const p of L) { const oc = objCategory(p.sourceTitle) || objCategory(p.title); if (oc && oc !== p.category) ch.push({ id: p._id, set: { category: oc, subcategory: null } }); }
          for (let i = 0; i < ch.length; i += 100) await store.patchEach(ch.slice(i, i + 100));
          await store.put({ _id: "settings.fixObjPm1", _type: "settings", at: new Date().toISOString(), fixed: ch.length }); if (ch.length) PCACHE = null; console.log("FIXOBJ " + ch.length); } } catch (e) { FIXOBJ = false; } }
        if (!FIXMIU) { FIXMIU = true; try { if (!(await store.get("settings.fixMiuImg3"))) { const { orderImages } = await import("../lib/imgorder.js");
          const L = (await store.list("product", {}, { limit: 20000, fields: "_id, images, overrides" })).filter(p => /^product\.manual\.(miumiu|prada)-/.test(p._id) && !p.overrides?.cover && !(p.overrides?.imageOrder || []).length);
          const ch = []; for (const p of L) { const im = p.images || [], src = i => i.sourceUrl || i.url, ord = orderImages(im.map(src), { max: 12 }); if (ord.length && ord.join("|") !== im.map(src).join("|")) ch.push({ id: p._id, set: { images: ord.map(u => im.find(i => src(i) === u)), coverFrom: null, coverTile: null } }); }
          for (let i = 0; i < ch.length; i += 100) await store.patchEach(ch.slice(i, i + 100));
          await store.put({ _id: "settings.fixMiuImg3", _type: "settings", at: new Date().toISOString(), fixed: ch.length }); if (ch.length) PCACHE = null; console.log("FIXMIU " + ch.length); } } catch (e) { FIXMIU = false; console.log("FIXMIU fail " + String(e.message).slice(0, 120)); } }
        if (!FIXGG) { FIXGG = true; try { if (!(await store.get("settings.fixGgImg3"))) { const { orderImages } = await import("../lib/imgorder.js");
          // 2: обложка — вид сбоку (кадр без номера), не плитка раздела; ваша обложка/порядок из админки — не трогаем
          const L = (await store.list("product", {}, { limit: 20000, fields: "_id, images, overrides" })).filter(p => p._id.startsWith("product.manual.goldengoose-") && !p.overrides?.cover && !(p.overrides?.imageOrder || []).length);
          const ch = []; for (const p of L) { const im = p.images || [], ord = orderImages(im.map(i => i.url), { max: 12, sku: p._id.replace(/^product\.manual\.goldengoose-/, "") }); if (ord.length && ord.join("|") !== im.map(i => i.url).join("|")) ch.push({ id: p._id, set: { images: ord.map(u => im.find(i => i.url === u)), coverFrom: null, coverTile: null } }); }
          for (let i = 0; i < ch.length; i += 100) await store.patchEach(ch.slice(i, i + 100));
          await store.put({ _id: "settings.fixGgImg3", _type: "settings", at: new Date().toISOString(), fixed: ch.length }); if (ch.length) PCACHE = null; console.log("FIXGG " + ch.length); } } catch (e) { FIXGG = false; console.log("FIXGG fail " + String(e.message).slice(0, 120)); } }
        // один раз: фото Gucci — квадрат 1200×1200 вместо мелких 490 и баннеров 600x314 / 2400x1200 (белые полосы), без дублей; ваш порядок и обложку сохраняем
        if (!FIXGUCCI) { FIXGUCCI = true; try { if (!(await store.get("settings.fixGucciImg2"))) { const { orderImages } = await import("../lib/imgorder.js");
          // 2: плитка раздела больше не обложка (белый фон и рекламные LandscapeXL), дубли кадра убраны, кадры по порядку (001 — лицевой — первым); ваша обложка/порядок из админки — не трогаем
          const L = (await store.list("product", {}, { limit: 20000, fields: "_id, images, overrides" })).filter(p => p._id.startsWith("product.manual.gucci-") && !p.overrides?.cover && !(p.overrides?.imageOrder || []).length);
          const ch = []; for (const p of L) { const ord = orderImages((p.images || []).map(i => i.url), { max: 12 }); if (ord.length) ch.push({ id: p._id, set: { images: ord.map(u => ({ url: u, sourceUrl: u, rights: "copied" })), coverFrom: null, coverTile: null } }); }
          for (let i = 0; i < ch.length; i += 100) await store.patchEach(ch.slice(i, i + 100));
          await store.put({ _id: "settings.fixGucciImg2", _type: "settings", at: new Date().toISOString(), fixed: ch.length }); if (ch.length) PCACHE = null; console.log("FIXGUCCI " + ch.length); } } catch (e) { FIXGUCCI = false; console.log("FIXGUCCI fail " + String(e.message).slice(0, 120)); } }
        // один раз: фото Louis Vuitton — убрать дубли и пустые заглушки, лицевой кадр первым, баннеры раздела не обложка (ваш порядок/обложку из админки не трогаем)
        if (!FIXLV) { FIXLV = true; try { if (!(await store.get("settings.fixLvImg2"))) { const { orderImages } = await import("../lib/imgorder.js");
          const L = (await store.list("product", {}, { limit: 20000, fields: "_id, images, overrides, coverFrom, coverTile" })).filter(p => p._id.startsWith("product.manual.de-") && !p.overrides?.cover && !(p.overrides?.imageOrder || []).length);
          const ch = []; for (const p of L) { const im = p.images || [], src = im.map(i => i.sourceUrl || i.url); if (!src.some(u => /louisvuitton\.com/.test(u))) continue; const ord = orderImages(src, { max: 12, sku: p._id.replace(/^product\.manual\.de-/, "") });
            if (ord.length && ord.join("|") !== im.map(i => i.url).join("|")) ch.push({ id: p._id, set: { images: ord.map(u => ({ url: u, sourceUrl: u, rights: "copied" })), coverFrom: null, coverTile: null } }); }
          for (let i = 0; i < ch.length; i += 100) await store.patchEach(ch.slice(i, i + 100));
          await store.put({ _id: "settings.fixLvImg2", _type: "settings", at: new Date().toISOString(), fixed: ch.length }); if (ch.length) PCACHE = null; console.log("FIXLV " + ch.length); } } catch (e) { FIXLV = false; console.log("FIXLV fail " + String(e.message).slice(0, 120)); } }
        // один раз: товары с сайтов брендов, оставшиеся «Другое» из-за немецких слов (Gürtel, Accessoires, Schmuck…) — в свою категорию
        if (!FIXOTHER) { FIXOTHER = true; try { if (!(await store.get("settings.fixOther"))) { const { detectCategory, detectSubcategory } = await import("../lib/normalize.js");
          const L = (await store.list("product", { category: "other" }, { limit: 20000, fields: "_id, title, sourceTitle, description, webSections, orig, overrides" })).filter(p => p._id.startsWith("product.manual.") && !p.overrides?.category);
          const ch = []; for (const p of L) { let ot = ""; try { ot = typeof p.orig === "string" ? JSON.parse(p.orig).title || "" : p.orig?.title || ""; } catch {} const t = [ot, p.title, p.sourceTitle].filter(Boolean).join(" "), sec = (p.webSections || []).join(" ").replace(/[-_/]+/g, " "); const c = detectCategory(t, sec, p.description); if (c && c !== "other") ch.push({ id: p._id, set: { category: c, subcategory: detectSubcategory(c, t, sec.toLowerCase().split(" ").reverse(), p.description) || null } }); }
          for (let i = 0; i < ch.length; i += 200) await store.patchEach(ch.slice(i, i + 200));
          await store.put({ _id: "settings.fixOther", _type: "settings", at: new Date().toISOString(), fixed: ch.length }); if (ch.length) PCACHE = null; console.log("FIXOTHER " + ch.length); } } catch (e) { FIXOTHER = false; console.log("FIXOTHER fail " + String(e.message).slice(0, 120)); } }
        const all = await allProducts(store);
        const Q = req.query, q = String(Q.q || "").toLowerCase();
        const cat = p => p.overrides?.category || p.category;
        // фильтры применяются по очереди; списки для выпадающих меню строятся по остальным фильтрам
        const base = all.filter(p => (!q || [p.brand, p.title, p.sourceTitle, p.modelSku, p.overrides?.title].join(" ").toLowerCase().includes(q))
          && (Q.status ? p.status === Q.status : p.status !== "incoming") && (!Q.source || (p.offers || []).some(o => o.sourceId === Q.source))
          && (!Q.avail || (p.offers || []).some(o => o.onlineOrder))
          && (!Q.pre || !!p.hasPre)
          // «Новинки»: отметка стоит и срок не истёк
          && (!Q.nw || (p.overrides?.isNew === "on" && (!p.overrides?.newUntil || p.overrides.newUntil >= new Date().toISOString().slice(0, 10))))
          // «В наличии»: вещь уже выкуплена и лежит у нас (ua — Украина, eu — Европа, any — любая)
          && (!Q.stock || (l => Q.stock === "any" ? !!l : l === Q.stock)((p.overrides?.stock || p.stock)?.loc || "")));
        // вкладка раздела магазина (Бестселлеры, Женское…) — в том же порядке, что на сайте бренда
        const pos = p => (p.secPos || []).find(x => x.s === Q.sec)?.p ?? 1e9;
        const gen = p => genderOf(p);
        const list = base.filter(p => (!Q.brand || p.brand === Q.brand) && (!Q.cat || cat(p) === Q.cat) && (!Q.g || gen(p) === Q.g) && (!Q.sec || (p.sections || []).includes(Q.sec) || (p.webSections || []).includes(Q.sec)));
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
          products: page.map(p => ({ _id: p._id, g: genderOf(p), stock: (p.overrides?.stock || p.stock)?.loc || null, brand: p.brand, title: p.overrides?.title || p.title, category: p.overrides?.category || p.category, status: p.status, cover: p.overrides?.cover || (p.overrides?.imageOrder || [])[0] || (p.images || [])[0]?.url || null, price: p.pricing, updatedAt: p.updatedAt, issues: p.issuesN ?? (p.issues || []).length, hidden: !!p.overrides?.hidden, source: (p.offers || [])[0]?.sourceId || null, avail: (p.offers || []).some(o => o.onlineOrder), pre: !!p.hasPre, gender: p.gender || null, sizes: sizeList(det.get(p._id) || p), createdAt: p.createdAt || null, soldOld: !!p.soldOld, newTill: p.overrides?.isNew === "on" && (!p.overrides?.newUntil || p.overrides.newUntil >= new Date().toISOString().slice(0, 10)) ? (p.overrides?.newUntil || "—") : null })) });
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
        // ваша обложка из админки остаётся, если это фото есть на странице бренда
        // фото заново с сайта бренда — один раз (imgVer 2): прежняя «склейка похожих фото» могла заменить перед сумки на вид сзади. Ваши обложка/порядок фото из админки — не трогаем
        if (Array.isArray(it.images) && it.images.length) { try { const p0 = await store.get(id);
          // фото чужого цвета: на странице есть снимки с артикулом этого товара, а у нас их нет — берём заново (Brunello: цвета одной модели с одинаковым фото)
          const own = id.replace(/^product\.manual\.[a-z0-9]+-/, "").toUpperCase(), hasOwn = a => own.length >= 8 && a.some(u => String(u || "").toUpperCase().includes(own));
          // LV: у нас фото другой модели (код в названии фото не совпадает с тем, что сейчас на странице товара) — берём заново
          const lvc = a => new Set(a.map(u => (String(u || "").match(/--([A-Z0-9]+)_[A-Z]{1,3}\d_/) || [])[1]).filter(Boolean)), lvNew = lvc(it.images), lvOld = p0 ? lvc((p0.images || []).map(i => i.sourceUrl || i.url)) : new Set();
          const lvWrong = lvNew.size > 0 && lvOld.size > 0 && ![...lvNew].some(c => lvOld.has(c));
          const wrongColor = !!p0 && (lvWrong || (hasOwn(it.images) && !hasOwn((p0.images || []).map(i => i.sourceUrl || i.url)) && !hasOwn([p0.coverTile])));
          if (p0 && (wrongColor || p0.imgVer !== IMGV(id) || (p0.images || []).length < Math.min(3, it.images.length) || !/^https:\/\/cdn\.sanity\.io\//.test(p0.images?.[0]?.url || "") || it.images.length > (p0.images || []).length) && (!p0.overrides?.cover || it.images.includes(p0.overrides.cover)) && !(p0.overrides?.imageOrder || []).length) { const { images, copied, srcOf } = await copyWebImages(store, it.images, id); const dior = /^product\.manual\.dior-/.test(id);
            const hadCopies = /^https:\/\/cdn\.sanity\.io\//.test(p0.images?.[0]?.url || "");
            // скопировать к себе не вышло (сайт не отдаёт фото серверу), а на странице фото больше, чем у нас, — показываем все по ссылке сайта
            if (images.length && (copied || wrongColor || !hadCopies || images.length > (p0.images || []).length)) { await store.patchMany([id], { images: images.map(u => ({ url: u, sourceUrl: srcOf[u] || u, rights: "copied" })), imgVer: IMGV(id), ...(it.tileImg && !dior ? { coverFrom: "tile", coverTile: String(it.tileImg).slice(0, 600) } : {}) }); PCACHE = null; } else if (images.length) await store.patchMany([id], { imgVer: IMGV(id) }); } } catch (e) { console.log("IMGREF fail " + String(e.message).slice(0, 100)); } }
        // ещё не разобранные «Новые с сайтов»: категория и пол — по новым правилам кнопки (ваши правки из админки важнее)
        try { const p1 = await store.get(id); const { CATEGORIES } = await import("../lib/normalize.js"); const set = {};
          if (p1 && p1.status === "incoming") { const { detectCategory, headCategory } = await import("../lib/normalize.js");
            // та же логика, что при первой загрузке: главное слово названия важнее раздела; «other» не затирает уже найденную категорию
            let cat = it.category; if (!cat || cat === "other") { const c = detectCategory(it.title || p1.sourceTitle, String(it.section || "").replace(/[-_/]+/g, " "), (it.crumbs || []).join(" "), it.description); if (c && c !== "other") cat = c; }
            const hc = headCategory(it.title) || headCategory(p1.sourceTitle) || headCategory(p1.title); if (hc) cat = hc;
            { const { objCategory } = await import("../lib/normalize.js"); const oc = objCategory(it.title) || objCategory(p1.sourceTitle); if (oc && oc !== cat && !["jewelry", "eyewear"].includes(cat)) cat = oc; } // предмет в названии решает (кепка из раздела «сумки» — аксессуар)
            if (CATEGORIES[cat] && !(cat === "other" && p1.category && p1.category !== "other") && !p1.overrides?.category && p1.category !== cat) { set.category = cat; set.subcategory = null; } if (["w", "m"].includes(it.gender) && !p1.overrides?.gender && p1.gender !== it.gender) set.gender = it.gender; }
          if (Object.keys(set).length) { await store.patchMany([id], set); PCACHE = null; } } catch {}
        // немецкий/нидерландский текст у уже загруженного товара — переводим один раз
        try { const p2 = await store.get(id); if (p2 && !p2.orig && !p2.overrides?.title) { const { englishItem, looksGerman } = await import("../lib/translate.js"); if (looksGerman(p2.title, p2.description)) { const en = await englishItem({ title: p2.title, description: p2.description, colors: (p2.colors || []).map(c => ({ name: c })) }, null); if (en.orig) { await store.patchMany([id], { title: en.title, sourceTitle: en.title, description: en.description || p2.description, orig: en.orig }); PCACHE = null; } } } } catch (e) { console.log("TR upd fail " + String(e.message).slice(0, 100)); }
        // обложка как на плитке раздела бренда (один раз на товар)
        // Dior: на плитке раздела часто фото на модели — обложкой не ставим
        if (!/^product\.manual\.(dior|gucci|goldengoose|miumiu|prada)-/.test(id) && /^https:\/\/[^/]+\/[^&=]*(\?|$)/.test(String(it.tileImg || ""))) { try { const p0 = await store.get(id); const { coverFromTile } = await import("../lib/imgdedupe.js"); const { fetchBinary } = await import("../lib/images.js"); if (p0 && await coverFromTile(store, p0, String(it.tileImg), { fetchBinary })) { await store.patchMany([id], { images: p0.images, coverFrom: "tile", coverTile: p0.coverTile }); PCACHE = null; } } catch (e) { console.log("COVER fail " + String(e.message).slice(0, 100)); } }
        return send(res, 200, await updateWebProduct(store, id, { boutique: it.boutique, sizeStock: it.sizeStock, preorder: !!it.preorder, unavailable: !!it.unavailable, ask: ["pre", "wait", "store"].includes(it.ask) ? it.ask : "", isNew: !!it.isNew, section: it.section, szDbg: it.szDbg, noStock: !!it.noStock, stockRead: !!it.stockRead, soldOld: !!it.soldOld }, { by: me.name, pricingCfg }));
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
        const list = (await allProducts(store)).filter(p => p._id.startsWith(px) && (p.webSections || []).includes(section) && p.sourceUrl).slice(0, 3000).map(p => ({ code: p._id.slice(px.length).toUpperCase(), url: p.sourceUrl }));
        return send(res, 200, { list });
      }
      case "sectionSync": {
        // прогон: товары этого раздела, которых больше нет на сайте бренда, — «продано». Если раздел загрузился меньше чем на 80% (не дожали «Ещё товары») — ничего не трогаем
        const px = "product.manual." + String(body.prefix || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) + "-", section = String(body.section || "").slice(0, 200);
        const codes = new Set((Array.isArray(body.codes) ? body.codes : []).map(c => String(c).toLowerCase().replace(/[^a-z0-9]/g, "")));
        if (px.length < 18 || !section) return send(res, 400, { error: "Нет раздела" });
        let allPx = (await store.list("product", {}, { limit: 60000, fields: "_id, webSections, status" })).filter(p => p._id.startsWith(px));
        // полностью распроданные на сайте бренда (все размеры «нет»): скрытые — удаляем совсем (не в «удалённые»: вернётся в продажу — кнопка возьмёт снова), на витрине — «продано»
        let soldDel = 0; { const so = new Set((Array.isArray(body.soldOut) ? body.soldOut : []).slice(0, 2000).map(c => String(c).toLowerCase().replace(/[^a-z0-9]/g, "")));
          if (so.size) { const hit = allPx.filter(p => so.has(p._id.slice(px.length))), del = hit.filter(p => p.status !== "published").map(p => p._id), pub = hit.filter(p => p.status === "published").map(p => p._id);
            if (del.length) { await store.delMany(del); soldDel = del.length; PCACHE = null; } if (pub.length) await markWebGone(store, pub, { by: me.name, pricingCfg });
            allPx = allPx.filter(p => !del.includes(p._id)); } }
        // товары, которые есть на этой странице, но пришли из другого раздела (или недавно проверены и пропущены), — тоже отмечаем этим разделом:
        // так коллекция («Cruise 2027») собирает и уже загруженные вещи, без дублей
        { const add = allPx.filter(p => codes.has(p._id.slice(px.length)) && !(p.webSections || []).includes(section)).map(p => ({ id: p._id, set: { webSections: [...new Set([...(p.webSections || []), section])].slice(-12) } }));
          for (let i = 0; i < add.length; i += 200) await store.patchEach(add.slice(i, i + 200)); add.forEach(a => { const p = allPx.find(x => x._id === a.id); if (p) p.webSections = a.set.webSections; }); }
        const mine = allPx.filter(p => (p.webSections || []).includes(section));
        const gone = mine.filter(p => !codes.has(p._id.slice(px.length))).map(p => p._id);
        if (mine.length && codes.size < mine.length * 0.8) { await rememberSection(store, { section, url: body.url, title: body.title, found: codes.size, inSection: mine.length, gone: 0, partial: true, complete: !!body.complete, health: body.stats && typeof body.stats === "object" ? { links: Math.min(5000, +body.stats.links || 0), tried: Math.min(5000, +body.stats.tried || 0), read: Math.min(5000, +body.stats.read || 0) } : null }); return send(res, 200, { gone: 0, skipped: true, inSection: mine.length, found: codes.size }); }
        const goneN = gone.length && !(mine.length && codes.size < mine.length * 0.8) ? await markWebGone(store, gone.slice(0, 500), { by: me.name, pricingCfg }) : 0;
        // отчёт о сайте (что кнопка прочитала) + категории товаров раздела + образец страницы товара для разбора
        const st = body.stats && typeof body.stats === "object" ? Object.fromEntries(["links", "tried", "read", "price", "newN", "img", "needSz", "sz"].map(k => [k, Math.max(0, Math.min(5000, Number(body.stats[k]) || 0))])) : null;
        if (st) { const all = await allProducts(store), ids = new Set(mine.map(p => p._id)), cats = { total: 0 }; for (const p of all) if (ids.has(p._id)) { const c = p.overrides?.category || p.category || "other"; cats[c] = (cats[c] || 0) + 1; cats.total++; } st.cats = cats; }
        if (body.sample && typeof body.sample === "object") { const host = String(body.host || "").replace(/[^a-z0-9.-]/gi, "").slice(0, 80); if (host) { const sd = (await store.get("settings.webSamples")) || { _id: "settings.webSamples", _type: "settings", list: {} }; sd.list = sd.list || {}; sd.list[host.replace(/\./g, "_")] = { host, at: new Date().toISOString(), sample: JSON.stringify(body.sample).length < 24000 ? body.sample : { title: String(body.sample.title || "").slice(0, 200), url: String(body.sample.url || "").slice(0, 300), tooBig: true, moreCap: body.sample.moreCap } }; delete sd._rev; delete sd._createdAt; delete sd._updatedAt; try { await store.put(sd); } catch {} } }
        const clean = a => (Array.isArray(a) ? a : []).map(c => String(c).toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).slice(0, 400);
        await rememberSection(store, { section, url: body.url, title: body.title, found: codes.size, inSection: mine.length, gone: goneN, health: st, complete: !!body.complete, px, rej: clean(body.rejected), failed: clean(body.failed) });
        // страница коллекции бренда (Cruise 2027, Winter 26…) — создаём/обновляем коллекцию; её товары — товары этого раздела
        try { const { upsertCollection, isCollection } = await import("../lib/collections.js");
          if (isCollection(body.title, body.url || section)) { const any = mine.length ? (await store.getMany([mine[0]._id]))[0] : null;
            const { translateRu } = await import("../lib/translate.js");
            await upsertCollection(store, { section, url: body.url, title: String(body.h1 || body.title || "").slice(0, 200), desc: String(body.desc || "").slice(0, 600), brand: any?.brand || "", found: codes.size, translate: t => translateRu(t) }); } } catch (e) { console.log("COLL fail " + String(e.message).slice(0, 120)); }
        return send(res, 200, { gone: goneN, inSection: mine.length });
      }
      case "forgetDeleted": {
        const site = String(body.site || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
        if (!site) return send(res, 400, { error: "Нет сайта" });
        const { forgetDeleted } = await import("../lib/catalogload.js");
        return send(res, 200, { restored: await forgetDeleted(store, "product.manual." + site + "-") });
      }
      case "webSections": {
        // разделы сайтов брендов, где нажимали кнопку: ссылка, когда прогоняли, что нашли
        const d = await store.get("settings.webSections");
        // сколько удалённых вами товаров по каждому сайту (кнопка их больше не берёт — можно разрешить снова)
        const del = {}; for (const id of await deletedSet(store)) { const m = id.match(/^product\.manual\.([a-z0-9]+)-/); if (m) del[m[1]] = (del[m[1]] || 0) + 1; }
        return send(res, 200, { sections: Object.values(d?.list || {}).sort((a, b) => String(a.lastRun).localeCompare(String(b.lastRun))), deleted: del, arrivals: (await store.get("settings.newArrivals"))?.mode || "publish" });
      }
      case "undeleteSection": {
        // вернуть удалённые вами товары одного раздела: кнопка снова их возьмёт (скрытыми, на проверку)
        const d = await store.get("settings.webSections"), x = d?.list?.[secKey(String(body.section || ""))];
        if (!x || !x.px || !(x.rej || []).length) return send(res, 200, { restored: 0 });
        const want = new Set(x.rej.map(c => x.px + c)), dd = await store.get("settings.deleted");
        const keep = (dd?.ids || []).filter(i => !want.has(i)), n = (dd?.ids || []).length - keep.length;
        if (n) await store.put({ _id: "settings.deleted", _type: "settings", ids: keep, at: new Date().toISOString() });
        x.rej = []; const { _rev, _createdAt, _updatedAt, ...save } = d; await store.put(save);
        return send(res, 200, { restored: n });
      }
      case "dbCleanup": {
        // уборка базы: копии страниц (по несколько МБ), просроченные одноразовые коды входа
        const now = Date.now(), del = [];
        for (const t of ["snap", "weblogin", "adminlink"]) for (const d of await store.list(t, {}, { limit: 5000, fields: "_id, exp, at" })) if (t === "snap" ? !(now - Date.parse(d.at) < 7 * 864e5) : !(d.exp > now)) del.push(d._id);
        for (let i = 0; i < del.length; i += 500) await store.delMany(del.slice(i, i + 500));
        // фото товаров с сайтов брендов: один кадр в двух размерах и баннеры («запись в бутик») — убираем
        let tidied = 0;
        try { const { imgKey, isJunkImg } = await import("../lib/imgorder.js");
          const L = (await store.list("product", {}, { limit: 60000, fields: "_id, images" })).filter(p => p._id.startsWith("product.manual.") && (p.images || []).length);
          const ch = [];
          for (const p of L) { const seen = new Set(); const keep = p.images.filter(i => { const u = i.sourceUrl || i.url; if (isJunkImg(u) || isJunkImg(i.url)) return false; const k = imgKey(u); if (seen.has(k)) return false; seen.add(k); return true; });
            if (keep.length && keep.length < p.images.length) ch.push({ id: p._id, set: { images: keep } }); }
          for (let i = 0; i < ch.length; i += 200) await store.patchEach(ch.slice(i, i + 200));
          tidied = ch.length; if (tidied) PCACHE = null;
        } catch (e) { console.log("TIDY fail " + String(e.message).slice(0, 120)); }
        let stats = null; try { stats = store.stats ? await store.stats() : null; } catch {}
        return send(res, 200, { deleted: del.length, tidied, stats });
      }
      case "snapSave": {
        // копии страниц больше не храним: каждая — несколько МБ в базе, а автопроверку кнопки делаем без них
        // храним не больше одной копии на сайт и неделю (для разбора, если кнопка что-то взяла не так); остальное не пишем
        if (!process.env.TB_SNAPS) { const h0 = String(body.host || "").replace(/[^a-z0-9.-]/gi, "").slice(0, 80); const ex = (await store.list("snap", { host: h0 }, { limit: 5, fields: "_id, section, at" })).filter(x => Date.now() - Date.parse(x.at) < 7 * 864e5);
          if (ex.length && !ex.some(x => x.section === String(body.section || "").slice(0, 200))) return send(res, 200, { ok: true, skipped: true }); }
        // копии страниц сайта бренда (раздел + до 3 товаров, сжатые) и что кнопка из них прочитала — для автопроверки новых версий кнопки
        const host = String(body.host || "").replace(/[^a-z0-9.-]/gi, "").slice(0, 80), section = String(body.section || "").slice(0, 200);
        if (!host || !section) return send(res, 400, { error: "Нет раздела" });
        const pg = x => x && typeof x.gz === "string" && x.gz.length < 2.5e6 && /^[A-Za-z0-9+/=]+$/.test(x.gz) ? { url: String(x.url || "").slice(0, 500), gz: x.gz, got: x.got && typeof x.got === "object" && JSON.stringify(x.got).length < 20000 ? x.got : null } : null;
        let list = pg(body.list), pages = (Array.isArray(body.pages) ? body.pages : []).slice(0, 3).map(pg).filter(Boolean);
        if (!list && !pages.length) return send(res, 400, { error: "Пусто" });
        const sid = "snap." + secKey(section);
        if (body.part === "page") { // части одного прогона: раздел приходит первым, товары — следом
          const prev = await store.get(sid); const idx = Math.max(0, Math.min(2, Number(body.idx) || 0));
          const fresh = prev && Date.now() - Date.parse(prev.at) < 30 * 60e3; list = fresh ? prev.list : null;
          const all = fresh ? [...(prev.pages || [])] : []; all[idx] = pages[0]; pages = all.filter(Boolean);
        }
        await store.put({ _id: sid, _type: "snap", host, section, ver: String(body.ver || "").slice(0, 10), at: new Date().toISOString(), list, pages, meta: { n: pages.length, lg: list?.got || null, pg: pages.map(x => ({ url: x.url, got: x.got })) } });
        return send(res, 200, { ok: true, pages: pages.length });
      }
      case "hotlinked": {
        // товары с фото по ссылке сайта бренда (не скопированы к нам) — админка проверит, открываются ли они
        const L = await store.list("product", {}, { limit: 60000, fields: "_id, images[]{url}" });
        const list = L.filter(p => p._id.startsWith("product.manual.")).map(p => { const all = (p.images || []).map(i => i.url), urls = all.filter(u => /^https:\/\//.test(u) && !/^https:\/\/cdn\.sanity\.io\//.test(u)); return { id: p._id, urls, sanity: all.length - urls.length, sig: String(all.length) + ":" + urls.join("|").length }; }).filter(p => p.urls.length).slice(0, 5000);
        return send(res, 200, { list });
      }
      case "imgDrop": {
        // убрать из товара фото, которые не открываются (проверила админка); последнее фото не убираем
        // swap: { старый адрес: рабочий } — тот же кадр без версии в адресе (Dior «…_E02-8» → «…_E02»)
        const id = String(body.id || ""), bad = new Set((Array.isArray(body.urls) ? body.urls : []).map(String));
        const swap = Object.fromEntries(Object.entries(body.swap && typeof body.swap === "object" ? body.swap : {}).filter(([a, b]) => /^https:\/\//.test(a) && /^https:\/\//.test(String(b)) && new URL(a).hostname === new URL(String(b)).hostname).slice(0, 20));
        if (!/^product\.manual\.[a-z0-9]+-[a-z0-9]+$/.test(id) || (!bad.size && !Object.keys(swap).length)) return send(res, 400, { error: "Нет товара" });
        const p = await store.get(id); if (!p) return send(res, 404, { error: "Товар не найден" });
        const sw = u => swap[u] || u, keep = (p.images || []).filter(i => !bad.has(i.url)).map(i => swap[i.url] ? { ...i, url: swap[i.url], sourceUrl: swap[i.url] } : i);
        if (!keep.length || (keep.length === (p.images || []).length && !Object.keys(swap).length)) return send(res, 200, { dropped: 0 });
        const o = p.overrides || {}, set = { images: keep };
        if (o.cover && (bad.has(o.cover) || swap[o.cover])) set.overrides = { ...o, cover: bad.has(o.cover) ? null : sw(o.cover) };
        if ((o.imageOrder || []).some(u => bad.has(u) || swap[u])) set.overrides = { ...(set.overrides || o), imageOrder: o.imageOrder.filter(u => !bad.has(u)).map(sw) };
        await store.patchMany([id], set); PCACHE = null;
        return send(res, 200, { dropped: (p.images || []).length - keep.length, cover: (set.overrides ? set.overrides.cover : o.cover) || keep[0]?.url || null });
      }
      case "trPending": {
        // товары с сайтов брендов, оставшиеся на немецком (перевод упёрся в лимит), — переводим пачками по 8, пока лимит не кончится
        const { translateBatch, looksGerman, trHash } = await import("../lib/translate.js");
        const L = (await store.list("product", {}, { limit: 60000, fields: "_id, title, description, colors, orig, overrides" })).filter(p => p._id.startsWith("product.manual.") && !p.orig && !p.overrides?.title && looksGerman(p.title, p.description, (p.colors || []).join(" ")));
        let done = 0, err = null; const t0 = Date.now();
        for (let i = 0; i < L.length && Date.now() - t0 < 40000; i += 8) {
          const part = L.slice(i, i + 8);
          let en; try { en = await translateBatch(part.map(p => ({ title: p.title, description: p.description, colors: p.colors || [] }))); } catch (e) { err = String(e.message).slice(0, 160); break; }
          await store.patchEach(part.map((p, k) => ({ id: p._id, set: { title: en[k].title || p.title, sourceTitle: en[k].title || p.title, description: en[k].description || p.description || null,
            ...(en[k].colors?.length && (p.colors || []).length === en[k].colors.length ? { colors: en[k].colors } : {}),
            orig: JSON.stringify({ lang: "auto", h: trHash(p.title, p.description, p.colors || []), title: p.title, description: p.description || null, colors: p.colors || [], en: en[k] }) } })));
          done += part.length;
        }
        if (done) PCACHE = null;
        if (err) console.log("TRPENDING stop " + JSON.stringify({ done, err }));
        return send(res, 200, { done, left: L.length - done, limited: /429/.test(err || ""), err });
      }
      case "collList": { const { inColl } = await import("../lib/collections.js");
        // коллекции брендов: список с числом вещей (всего и на витрине)
        // уже пройденные разделы, которые оказались коллекциями (новые правила узнавания: «Dior Alps» и т.п.), — заводим коллекцию
        // (не чаще раза в 10 минут; бренд — по адресу сайта, без перебора всех товаров: раньше список коллекций открывался 4–5 с)
        if (Date.now() - COLLSCAN_AT > 10 * 60e3) { COLLSCAN_AT = Date.now(); try { const { upsertCollection, isCollection, collKey } = await import("../lib/collections.js"); const ws = (await store.get("settings.webSections"))?.list || {};
          for (const x of Object.values(ws)) { if (!x?.section || !isCollection(x.title, x.url || x.section)) continue; if (await store.get("collection." + collKey(x.section))) continue;
            await upsertCollection(store, { section: x.section, url: x.url, title: x.title || "", brand: "", found: x.found || 0 }); } } catch (e) { console.log("COLLSCAN " + String(e.message).slice(0, 100)); } }
        const [colls, L] = await Promise.all([store.list("collection", {}, { limit: 500 }), collProds(store)]);
        const list = colls.map(c => { const mine = L.filter(p => inColl(p, c)); return { ...c, n: mine.length, live: mine.filter(p => p.status === "published").length, newN: 0, cover: c.cover || mine.map(p => p.images?.[0]?.url).find(Boolean) || null }; })
          .sort((a, b) => (b.pinned - a.pinned) || String(b.createdAt).localeCompare(String(a.createdAt)));
        return send(res, 200, { list });
      }
      case "collSave": {
        const id = String(body.id || ""); if (!/^collection\.[A-Za-z0-9_-]{1,180}$/.test(id)) return send(res, 400, { error: "Нет коллекции" });
        const c = await store.get(id); if (!c) return send(res, 404, { error: "Коллекция не найдена" });
        const set = {}, s = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
        if ("on" in body) set.on = !!body.on;
        if ("pinned" in body) { set.pinned = !!body.pinned; if (set.pinned) { const others = (await store.list("collection", { pinned: true }, { limit: 50, fields: "_id" })).map(x => x._id).filter(x => x !== id); if (others.length) await store.patchMany(others, { pinned: false }); } }
        if ("title" in body) { set.title = s(body.title, 60) || c.title; set.edited = true; }
        if ("desc" in body) { set.desc = s(body.desc, 200); set.edited = true; }
        if ("brand" in body) set.brand = s(body.brand, 60) || c.brand;
        if ("g" in body && ["w", "m", "u", "k"].includes(body.g)) set.g = body.g;
        if ("until" in body) set.until = /^\d{4}-\d{2}-\d{2}$/.test(String(body.until)) ? String(body.until) : null;
        if ("cover" in body) set.cover = /^https:\/\//.test(String(body.cover || "")) ? String(body.cover).slice(0, 600) : null;
        await store.patchMany([id], set);
        return send(res, 200, { ok: true });
      }
      case "collDel": {
        const id = String(body.id || ""); if (!/^collection\.[A-Za-z0-9_-]{1,180}$/.test(id)) return send(res, 400, { error: "Нет коллекции" });
        await store.del(id); return send(res, 200, { ok: true });
      }
      case "arrivalsSet": {
        // новинки бренда (появились в уже пройденном разделе): сразу на сайт или сначала в «Новые с сайтов»
        const mode = body.mode === "incoming" ? "incoming" : "publish";
        await store.put({ _id: "settings.newArrivals", _type: "settings", mode, by: me.name, at: new Date().toISOString() });
        return send(res, 200, { mode });
      }
      case "webSectionDel": {
        const d = await store.get("settings.webSections"); if (d?.list) { delete d.list[secKey(body.section)]; delete d.list[String(body.section || "")]; await store.put(d); }
        return send(res, 200, { ok: true });
      }
      case "markNew": {
        // товары, которые уже есть, но снова встретились в разделе «Новинки» сайта бренда — отмечаем новинками на месяц
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(i => /^product\.manual\.[a-z0-9]+-[a-z0-9]+$/.test(i)).slice(0, 500);
        const until = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10); let marked = 0;
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
        if (!["w", "m", "u", "k"].includes(body.gender)) return send(res, 400, { error: "Нет такого значения" });
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
        if (it.revive) { const dd = await store.get("settings.deleted"); if (dd && (dd.ids || []).includes(id)) { dd.ids = dd.ids.filter(x => x !== id); delete dd._rev; delete dd._createdAt; delete dd._updatedAt; await store.put(dd); } } // открыли товар сами и нажали кнопку — снова берём
        const { images, copied, srcOf } = await copyWebImages(store, it.images, id);
        if (!images.length) return send(res, 400, { error: "Нет фото" });
        // немецкий сайт (LV и др.) — название, описание и цвета переводим на английский; ошибка перевода не мешает загрузке
        let itEn = it;
        try { const { englishItem } = await import("../lib/translate.js"); itEn = await englishItem(it, await store.get(id)); } catch (e) { console.log("TR fail " + JSON.stringify({ id, why: String(e.message).slice(0, 120) })); }
        // категория не определилась на стороне админки — пробуем по немецким/французским словам (Gürtel, Accessoires, Schmuck…)
        { const { detectCategory, headCategory } = await import("../lib/normalize.js");
          if (!it.category || it.category === "other") { const c = detectCategory(it.title, String(it.section || "").replace(/[-_/]+/g, " "), (it.crumbs || []).join(" "), it.description); if (c && c !== "other") itEn = { ...itEn, category: c }; }
          // главное слово названия важнее описания: «Ausgestellter Rock» с «Anhänger» в описании — юбка, а не украшение
          const hc = headCategory(it.title) || headCategory(itEn.title); if (hc && itEn.category !== hc) itEn = { ...itEn, category: hc, subcategory: null };
          // и наоборот: «Knitted Runners» — обувь, хотя «knit» похоже на трикотаж
          else if (!hc && itEn.category === "clothing") { const tc = detectCategory(itEn.title) || detectCategory(it.title); if (tc === "shoes" || tc === "bags") itEn = { ...itEn, category: tc, subcategory: null }; } }
          // предмет в названии решает окончательно (ремень из денима — аксессуар, «Koffer» — сумка, «Uhrenetui» — аксессуар)
          { const { objCategory } = await import("../lib/normalize.js"); const oc = objCategory(it.title) || objCategory(itEn.title); if (oc && oc !== itEn.category && !["jewelry", "eyewear"].includes(itEn.category)) itEn = { ...itEn, category: oc, subcategory: null }; }
        // новинка бренда: раздел уже был пройден целиком, а этого товара в нём не было — значит, вышел новым.
        // Такие товары сразу на витрине с отметкой «Новинка» (или в «Новых с сайтов», если так выбрано в админке). Первый прогон раздела — всё в «Новые с сайтов» на ваш отбор
        const novelty = await isNovelty(store, it.section);
        const arrivals = novelty ? ((await store.get("settings.newArrivals"))?.mode || "publish") : null;
        const product = await saveManualProduct(store, { ...itEn, ...(/^product\.manual\.(dior|gucci|goldengoose|miumiu|prada)-/.test(id) ? { tileImg: "" } : {}), id, images, imageSrc: srcOf, imgVer: IMGV(id), availability: "online", status: !it.soldOld && novelty && arrivals === "publish" ? "published" : "incoming", isNew: !!it.isNew || novelty, boutique: Number(it.boutique), fromWeb: true }, { by: me.name, pricingCfg });
        if (novelty) PCACHE = null;
        return send(res, 200, { id: product._id, images: images.length, copied, price: product.pricing?.eu || null, novelty, status: product.status });
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
        // клиенты из Telegram: профиль, заказы с сайта и через менеджера, оплачено, заработок, лояльность
        const [cs, ls] = await Promise.all([store.list("customer", {}, { order: "lastSeen desc", limit: 1000 }), store.list("lead", {}, { limit: 5000, fields: "_id, tgId, number, kind, source, status, total, cost, dest, createdAt, items[]{brand, title, price, size}" })]);
        const mk = mergeConfig(pricingCfg).official.markup, acc = await accessSettings(store, { fresh: true });
        const by = {}; ls.forEach(l => { if (l.tgId) (by[l.tgId] = by[l.tgId] || []).push(l); });
        const list = cs.map(c => { const o = (by[c.tg?.id] || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
          return { id: c._id, tg: c.tg, profile: c.profile, apply: c.apply || null, registeredAt: c.registeredAt || null, createdAt: c.createdAt, lastSeen: c.lastSeen, note: c.note || "", loyalty: c.loyalty || null, access: accessOf(c, acc), accessAt: c.accessAt || null, accessBy: c.accessBy || "", ...clientStats(o, mk), leads: o.slice(0, 30) }; });
        const sum = k => list.reduce((a, c) => a + (c[k] || 0), 0);
        return send(res, 200, { closed: acc.closed, customers: list, totals: { clients: list.length, buyers: list.filter(c => c.spent > 0).length, repeat: list.filter(c => c.orders > 1).length, orders: sum("orders"), viaManager: sum("viaManager"), spent: sum("spent"), earned: sum("earned"), active30: list.filter(c => c.lastSeen && Date.now() - Date.parse(c.lastSeen) < 30 * 864e5).length } });
      }
      case "manualOrder": {
        const c = await store.get(String(body.customer || ""));
        if (!c || c._type !== "customer") return send(res, 404, { error: "Клиент не найден" });
        return send(res, 200, { lead: await makeManualOrder(store, c, body, me.name) });
      }
      case "accessMode": {
        // закрытый сайт: включить/выключить; при включении все текущие клиенты получают доступ
        return send(res, 200, await setClosed(store, !!body.closed));
      }
      case "accessSetMany": {
        // заявки пачкой: принять / отклонить выбранных
        const ids = (Array.isArray(body.customers) ? body.customers : []).map(x => String(x).replace(/^customer\./, "")).filter(x => /^\d{1,15}$/.test(x)).slice(0, 200);
        let n = 0; for (const id of ids) if (await setAccess(store, id, body.access, { by: me.name })) n++;
        return send(res, 200, { n });
      }
      case "accessPending": {
        // новые заявки на вход — для счётчика и уведомления в админке
        const acc = await accessSettings(store, { fresh: true });
        if (!acc.closed) return send(res, 200, { closed: false, n: 0, latest: [] });
        const cs = await store.list("customer", {}, { limit: 5000, fields: "_id, tg, profile, access, registeredAt, createdAt" });
        const p = cs.filter(c => accessOf(c, acc) === "pending").sort((a, b) => String(b.registeredAt || b.createdAt).localeCompare(String(a.registeredAt || a.createdAt)));
        return send(res, 200, { closed: true, n: p.length, latest: p.slice(0, 5).map(c => ({ id: c._id, name: c.profile?.name || c.tg?.name || "Клиент", username: c.tg?.username || "", at: c.registeredAt || c.createdAt })) });
      }
      case "notifyGet": {
        const d = await store.get(NOTIFY_ID);
        const ab = { token: !!adminBotToken(), hook: !!d?.adminHook };
        if (ab.token) { try { const T = { token: adminBotToken() }; ab.username = (await tg("getMe", {}, T)).username; const h = await tg("getWebhookInfo", {}, T); ab.hook = !!h.url && h.url.endsWith("/api/adminbot"); ab.busy = !!h.url && !ab.hook ? new URL(h.url).host : ""; } catch (e) { ab.error = String(e.message).slice(0, 120); } }
        return send(res, 200, { chats: (d?.chats || []).map(c => ({ id: String(c.id), name: c.name, username: c.username, at: c.at })), env: !!process.env.TELEGRAM_MANAGER_CHAT, token: !!process.env.TELEGRAM_BOT_TOKEN, adminBot: ab });
      }
      case "notifyLink": {
        // одноразовая ссылка в бота: открыть её может только тот, кто вошёл в админку
        if (!process.env.TELEGRAM_BOT_TOKEN) return send(res, 400, { error: "Бот не подключён" });
        const code = await adminLinkCode(store, me.name), nd = await store.get(NOTIFY_ID);
        // ссылка ведёт в админ-бот, если он подключён с кнопками; иначе — в бот магазина (уведомления всё равно пойдут через админ-бот)
        const useAdmin = adminBotToken() && nd?.adminHook;
        let bot = ""; try { bot = (await tg("getMe", {}, useAdmin ? { token: adminBotToken() } : undefined)).username; } catch {}
        if (!bot) return send(res, 502, { error: "Telegram не ответил, попробуйте ещё раз" });
        return send(res, 200, { url: `https://t.me/${bot}?start=admin_${code}` });
      }
      case "adminBotSetup": {
        // вебхук админ-бота → /api/adminbot (кнопки «Открыть доступ» прямо в чате). Если бот уже привязан к другому сервису — не трогаем без явного «всё равно».
        const tok = adminBotToken(); if (!tok) return send(res, 400, { error: "Добавьте в Vercel TELEGRAM_ADMIN_BOT_TOKEN и сделайте Redeploy" });
        const T = { token: tok };
        try {
          const h = await tg("getWebhookInfo", {}, T);
          if (h.url && !h.url.endsWith("/api/adminbot") && !body.force) return send(res, 409, { error: "Этот бот уже подключён к другому сервису: " + new URL(h.url).host, busy: new URL(h.url).host });
          await tg("setWebhook", { url: publicUrl(req) + "/api/adminbot", secret_token: hookSecret(tok), allowed_updates: ["message", "callback_query"], drop_pending_updates: true }, T);
          const d = (await store.get(NOTIFY_ID)) || { _id: NOTIFY_ID, _type: "settings", chats: [] };
          d.adminHook = true; await store.put(d);
          return send(res, 200, { ok: true, username: (await tg("getMe", {}, T)).username });
        } catch (e) { return send(res, 400, { error: e.message }); }
      }
      case "notifyUnlink": {
        await adminUnlink(store, String(body.id || "")); return send(res, 200, { ok: true });
      }
      case "customerDelete": {
        // удалить аккаунт: человек выйдет и при следующем входе заново пройдёт регистрацию (и заявку, если вход по заявкам). Заказы остаются.
        const id = String(body.customer || "");
        const c = await store.get(id);
        if (!c || c._type !== "customer") return send(res, 404, { error: "Клиент не найден" });
        await store.del(id);
        return send(res, 200, { ok: true });
      }
      case "accessSet": {
        const id = String(body.customer || "").replace(/^customer\./, "");
        if (!/^\d{1,15}$/.test(id)) return send(res, 400, { error: "Нет клиента" });
        const c = await setAccess(store, id, body.access, { by: me.name });
        if (!c) return send(res, 404, { error: "Клиент не найден" });
        return send(res, 200, { access: c.access });
      }
      case "customerNote": {
        const c = await store.get(String(body.customer || ""));
        if (!c || c._type !== "customer") return send(res, 404, { error: "Клиент не найден" });
        c.note = String(body.note || "").slice(0, 2000); c.updatedAt = new Date().toISOString();
        await store.put(c); return send(res, 200, { ok: true });
      }
      case "finance": {
        const days = { week: 7, month: 31, quarter: 92, year: 366 }[req.query.period] || 31;
        const since = new Date(Date.now() - days * 864e5).toISOString();
        const all = (await store.list("lead", { kind: "order" }, { order: "createdAt desc", limit: 5000, fields: "createdAt, status, total, cost, dest, items[]{brand, price}" })).filter(l => l.status !== "cancelled");
        const inPeriod = all.filter(l => l.createdAt >= since);
        const done = inPeriod.filter(l => ["paid", "bought", "shipping", "np", "delivered"].includes(l.status));
        const mk = mergeConfig(pricingCfg).official.markup;
        const margin = l => l.cost ? (l.total || 0) - l.cost : (l.total || 0) - (l.total || 0) / (1 + (l.dest === "ua" || !l.dest ? mk.ua : l.dest === "eu" ? mk.eu : mk.dxb));
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

// ключ в базе — только буквы, цифры, «_» и «-» (Sanity не принимает «.» и «/» в именах полей: «on.com/en-de/shop/shoes» ронял сохранение)
// раздел сайта бренда уже проходили целиком? (кэш на 30 с — товары раздела приходят пачкой)
let SECC = null;
async function isNovelty(store, section) {
  if (!section) return false;
  if (!SECC || Date.now() - SECC.at > 30e3) SECC = { at: Date.now(), d: await store.get("settings.webSections").catch(() => null) };
  return !!SECC.d?.list?.[secKey(section)]?.complete;
}
const secKey = s => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);
async function rememberSection(store, x) {
  const d = (await store.get("settings.webSections")) || { _id: "settings.webSections", _type: "settings", list: {} };
  d.list = d.list || {}; const k = secKey(x.section), prev = d.list[k] || {};
  const url = /^https:\/\//.test(String(x.url || "")) ? String(x.url).slice(0, 500) : (prev.url || null);
  d.list[k] = { section: x.section, url, title: String(x.title || prev.title || "").replace(/\s*[|–-]\s*[^|–-]*$/, "").slice(0, 120), lastRun: new Date().toISOString(), found: x.found, inSection: x.inSection, gone: x.gone, partial: !!x.partial, health: x.health || prev.health || null,
    // раздел хоть раз пройден целиком — дальше всё, что в нём появляется, это новинки бренда (новая коллекция)
    complete: !!(x.complete || prev.complete), completeAt: prev.completeAt || (x.complete ? new Date().toISOString() : null),
    // чего из раздела нет у нас и почему: удалены вами (кнопка их не берёт) / страница не прочиталась — видно в «Сайтах брендов», ничего не пропадает молча
    px: x.px || prev.px || null, rej: Array.isArray(x.rej) ? x.rej : (prev.rej || []), failed: Array.isArray(x.failed) ? x.failed : (prev.failed || []) };
  for (const kk of Object.keys(d.list)) if (!/^[a-zA-Z0-9_-]+$/.test(kk)) delete d.list[kk]; // старые неправильные ключи
  const { _rev, _createdAt, _updatedAt, ...save } = d; await store.put(save);
}
