/**
 * API админки. Один обработчик на все действия (?a=…), чтобы укладываться в лимит функций Vercel.
 * Все действия, кроме входа, требуют авторизации; изменяющие — ещё и заголовок X-TB (защита от CSRF).
 */
import { getStore } from "../lib/store.js";
import { checkPassword, issueCookie, clearCookie, readSession } from "../lib/auth.js";
import { SOURCES, sourceWith, makeNet } from "../lib/sources.js";
import { SourceBlocked } from "../lib/http.js";
import { createJob, tick, cancelJob, deleteJob, ACTIVE } from "../lib/worker.js";
import { publishItems, setStatus, saveOverrides, computePricing } from "../lib/publish.js";
import { priceOffer, mergeConfig, PRICING_DEFAULTS } from "../lib/pricing.js";
import { toStorefront } from "../lib/catalog.js";
import { saveManualProduct } from "../lib/manual.js";
import { LEAD_STATUS, notifyClient } from "./lead.js";
import { allSourceIds, detectSupplier, addSupplier, updateSupplier, removeSupplier } from "../lib/suppliers.js";
import { getFx, refreshFx, saveManualFx } from "../lib/fx.js";
import { readScreen, screensEnabled, ScreenError } from "../lib/screens.js";
import { listItems, saveItem, deleteItems, reorder, setActive, getSite, saveSite, seedRails, FEED_BLOCKS, TEXTS, KINDS } from "../lib/cms.js";

const send = (res, code, body) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
const slim = j => { if (!j) return j; const { rows, seen, queue, attempts, catRoot, discover, ...rest } = j; return { ...rest, queued: j.queuedCount ?? (queue || []).length, discoverLeft: j.discoverLeft ?? (discover || []).length }; };
// Задачи без тяжёлых полей (строки файла, очередь ссылок) — список грузится мгновенно
const JOB_FIELDS = `..., "rows": null, "seen": null, "queue": null, "attempts": null, "catRoot": null, "discover": null, "queuedCount": count(queue), "discoverLeft": count(discover)`;

export default async function handler(req, res) {
  const a = (req.query && req.query.a) || new URL(req.url, "http://x").searchParams.get("a");
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  try {
    if (a === "login" && req.method === "POST") {
      if (!checkPassword(body.password)) { await new Promise(r => setTimeout(r, 1200)); return send(res, 401, { error: "Неверный пароль" }); }
      res.setHeader("Set-Cookie", issueCookie(body.name || "admin"));
      return send(res, 200, { ok: true, name: body.name || "admin" });
    }
    const me = readSession(req);
    if (!me) return send(res, 401, { error: "Нужен вход" });
    if (req.method !== "GET" && req.headers["x-tb"] !== "1") return send(res, 403, { error: "Запрос отклонён" });
    const store = getStore();
    const pricingCfg = (await store.get("settings.pricing"))?.config || null;

    switch (a) {
      case "logout": res.setHeader("Set-Cookie", clearCookie()); return send(res, 200, { ok: true });
      case "me": { await seedRails(store, me.name).catch(() => {}); return send(res, 200, { name: me.name, store: store.kind, demo: !!store.demo }); }

      case "overview": {
        const [published, draft, hidden, jobs, waiting, leadsNew] = await Promise.all([
          store.count("product", { status: "published" }), store.count("product", { status: "draft" }), store.count("product", { status: "hidden" }),
          store.list("importJob", {}, { order: "createdAt desc", limit: 8, fields: JOB_FIELDS }),
          store.count("importItem", { publishedAs: null, kind: ["new", "update", "duplicate"] }),
          store.count("lead", { status: "new" })
        ]);
        const [orders, cms, srcs] = await Promise.all([
          store.list("lead", { kind: "order", status: ["work", "paid", "bought", "shipping"] }, { limit: 500, fields: "status" }),
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
            schedule: settings?.schedule || "off", autoUpdate: settings?.autoUpdate !== false, autoPublish: !!settings?.autoPublish,
            sitemaps: settings?.sitemaps || src.sitemaps || [], collections: src.collections || [],
            lastSync: settings?.lastSync || null, check: settings?.check || null, home: src.home || null, lastJob: slim(last), running: jobs.some(j => j.sourceId === id && ACTIVE.includes(j.status)),
            stats: { found: mine.length, published: mine.filter(p => p.status === "published").length },
            categories: [...new Set(mine.map(p => p.category).filter(Boolean))],
            custom: !!src.custom, catalog: !!src.catalog, shopCurrency: src.shopCurrency || null, factor: src.factor || 1, brands: src.brands || [], cats: src.cats || [],
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
        if (Array.isArray(body.sitemaps)) cur.sitemaps = body.sitemaps.filter(s => /^https:\/\//.test(s)).slice(0, 20);
        await store.put(cur);
        return send(res, 200, { ok: true });
      }

      case "supplierDetect": return send(res, 200, { result: await detectSupplier(String(body.url || "")) });
      case "supplierAdd": return send(res, 200, await addSupplier(store, body, { by: me.name }));
      case "supplierRemove": return send(res, 200, await removeSupplier(store, String(body.id || ""), { deleteProducts: !!body.deleteProducts }));
      case "fxGet": return send(res, 200, await getFx(store));
      case "fxRefresh": { const r = await refreshFx(store, { force: true }); return send(res, 200, { ...(await getFx(store)), refresh: r }); }
      case "fxSave": return send(res, 200, await saveManualFx(store, body.manual || {}, me.name));

      case "jobCreate": {
        const { job, existing } = await createJob(store, { sourceId: body.sourceId, mode: body.mode, input: body.input || "", category: body.category || null, createdBy: me.name, onlyCats: body.onlyCats || null, gender: body.gender || null });
        return send(res, 200, { job: slim(job), existing });
      }
      case "jobs": return send(res, 200, { jobs: (await store.list("importJob", {}, { order: "createdAt desc", limit: 50, fields: JOB_FIELDS })).map(slim) });
      case "job": return send(res, 200, { job: slim((await store.list("importJob", { _id: String(req.query.id || "") }, { limit: 1, fields: JOB_FIELDS }))[0] || null) });
      case "jobCancel": return send(res, 200, { job: slim(await cancelJob(store, body.id)) });
      case "jobDelete": {
        const j = await store.get(body.id);
        if (j && ACTIVE.includes(j.status)) { await cancelJob(store, body.id); await store.patchMany([body.id], { status: "cancelled", lock: null }); }
        return send(res, 200, await deleteJob(store, body.id));
      }
      case "tick": return send(res, 200, await tick(store, { budgetMs: 9000, owner: "admin-" + me.name }));
      case "productDelete": {
        const ids = (body.ids || []).filter(i => typeof i === "string" && i.startsWith("product.")).slice(0, 2000);
        const linked = await store.list("importItem", { publishedAs: ids }, { limit: 20000, fields: "_id" });
        if (linked.length) await store.patchMany(linked.map(i => i._id), { publishedAs: null, publishedAt: null });
        await store.delMany(ids);
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
        const all = await store.list("product", {}, { limit: 50000, fields: "_id, brand, title, sourceTitle, modelSku, overrides, category, status, offers[]{sourceId}" });
        const Q = req.query, q = String(Q.q || "").toLowerCase();
        const ids = all.filter(p => (!q || [p.brand, p.title, p.sourceTitle, p.modelSku, p.overrides?.title].join(" ").toLowerCase().includes(q)) && (!Q.status || p.status === Q.status)
          && (!Q.source || (p.offers || []).some(o => o.sourceId === Q.source)) && (!Q.brand || p.brand === Q.brand) && (!Q.cat || (p.overrides?.category || p.category) === Q.cat)).map(p => p._id);
        return send(res, 200, { ids });
      }

      case "products": {
        const all = await store.list("product", {}, { order: "updatedAt desc", limit: 50000, fields: "_id, brand, title, sourceTitle, modelSku, overrides, category, status, images[0...1]{url}, pricing, updatedAt, issues, offers[]{sourceId, onlineOrder}" });
        const Q = req.query, q = String(Q.q || "").toLowerCase();
        const cat = p => p.overrides?.category || p.category;
        // фильтры применяются по очереди; списки для выпадающих меню строятся по остальным фильтрам
        const base = all.filter(p => (!q || [p.brand, p.title, p.sourceTitle, p.modelSku, p.overrides?.title].join(" ").toLowerCase().includes(q))
          && (!Q.status || p.status === Q.status) && (!Q.source || (p.offers || []).some(o => o.sourceId === Q.source)));
        const list = base.filter(p => (!Q.brand || p.brand === Q.brand) && (!Q.cat || cat(p) === Q.cat));
        const facet = (arr, f) => { const m = {}; arr.forEach(p => { const k = f(p); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })); };
        const offset = Math.max(0, Number(Q.offset) || 0), limit = Math.min(300, Math.max(1, Number(Q.limit) || 120));
        return send(res, 200, { total: list.length, offset,
          facets: { brands: facet(base.filter(p => !Q.cat || cat(p) === Q.cat), p => p.brand), cats: facet(base.filter(p => !Q.brand || p.brand === Q.brand), cat), sources: facet(all, p => (p.offers || [])[0]?.sourceId) },
          shown: list.filter(p => p.status === "published").length,
          products: list.slice(offset, offset + limit).map(p => ({ _id: p._id, brand: p.brand, title: p.overrides?.title || p.title, category: p.overrides?.category || p.category, status: p.status, cover: (p.images || [])[0]?.url || null, price: p.pricing, updatedAt: p.updatedAt, issues: (p.issues || []).length, hidden: !!p.overrides?.hidden, source: (p.offers || [])[0]?.sourceId || null, avail: (p.offers || []).some(o => o.onlineOrder) })) });
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
        const up = await store.uploadImage(buf, { filename: "manual-" + Date.now() + "." + type.split("/")[1], contentType: type });
        return send(res, 200, { url: up.url });
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
      case "pricePreview": {
        const { priceFor } = await import("../lib/pipeline.js");
        const p = priceFor({ sourceKind: "official", boutique: Number(body.boutique) || null, region: "DE", currency: "EUR" }, pricingCfg, Number(body.pinned) || null);
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
        if (changed && body.notify !== false) l.clientNotified = await notifyClient(l, l.status);
        l.updatedAt = now; l.manager = me.name;
        return send(res, 200, { lead: await store.put(l) });
      }
      case "finance": {
        const days = { week: 7, month: 31, quarter: 92, year: 366 }[req.query.period] || 31;
        const since = new Date(Date.now() - days * 864e5).toISOString();
        const all = (await store.list("lead", { kind: "order" }, { order: "createdAt desc", limit: 5000, fields: "createdAt, status, total, dest, items[]{brand, price}" })).filter(l => l.status !== "cancelled");
        const inPeriod = all.filter(l => l.createdAt >= since);
        const done = inPeriod.filter(l => ["paid", "bought", "shipping", "delivered"].includes(l.status));
        const mk = mergeConfig(pricingCfg).official.markup;
        const margin = l => (l.total || 0) - (l.total || 0) / (1 + (l.dest === "ua" || !l.dest ? mk.ua : l.dest === "eu" ? mk.eu : mk.dxb));
        const sum = (a, f) => Math.round(a.reduce((s, x) => s + (f(x) || 0), 0));
        const byBrand = {};
        done.forEach(l => (l.items || []).forEach(i => { if (i.brand) byBrand[i.brand] = (byBrand[i.brand] || 0) + (i.price || 0); }));
        const buckets = 6, step = days * 864e5 / buckets, start = Date.now() - days * 864e5;
        const series = Array.from({ length: buckets }, (_, k) => sum(done.filter(l => { const t = Date.parse(l.createdAt); return t >= start + k * step && t < start + (k + 1) * step; }), l => l.total));
        return send(res, 200, {
          revenue: sum(done, l => l.total), margin: sum(done, margin), orders: done.length, avg: done.length ? Math.round(sum(done, l => l.total) / done.length) : 0, series,
          pipeline: { awaiting: sum(all.filter(l => ["new", "work"].includes(l.status)), l => l.total), paid: sum(all.filter(l => l.status === "paid"), l => l.total), moving: sum(all.filter(l => ["bought", "shipping"].includes(l.status)), l => l.total) },
          brands: Object.entries(byBrand).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([brand, total]) => ({ brand, total: Math.round(total) }))
        });
      }
      case "leadDelete": { const ids = (body.ids || []).filter(i => String(i).startsWith("lead.")).slice(0, 200); await store.delMany(ids); return send(res, 200, { deleted: ids.length }); }
      case "cmsList": {
        const kind = String(req.query.kind || "");
        if (!KINDS.includes(kind)) return send(res, 400, { error: "Неизвестный тип" });
        return send(res, 200, { items: await listItems(store, kind) });
      }
      case "cmsSave": return send(res, 200, { item: await saveItem(store, body.kind, body.item || {}, me.name) });
      case "cmsDelete": return send(res, 200, { deleted: await deleteItems(store, body.ids) });
      case "cmsReorder": return send(res, 200, { ok: await reorder(store, body.kind, body.ids) });
      case "cmsActive": return send(res, 200, { ok: await setActive(store, body.ids, body.active) });
      case "siteGet": { await seedRails(store, me.name); return send(res, 200, { site: await getSite(store), blocks: FEED_BLOCKS, texts: TEXTS }); }
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
          { kind: "eyewear-supplier", boutique: 330, purchase: 240 }, { kind: "eyewear-supplier", boutique: 400, purchase: 300 },
          { kind: "eyewear-supplier", boutique: 460, purchase: 300 }, { kind: "eyewear-supplier", boutique: 1000, purchase: 800 },
          { kind: "eyewear-supplier", boutique: 1000, purchase: 900 }, { kind: "official", boutique: null }
        ]).slice(0, 50);
        // влияние на опубликованные товары: сколько цен изменится
        let changes = [];
        if (body.config) {
          const pub = await store.list("product", { status: "published" }, { limit: 5000 });
          changes = pub.map(p => ({ id: p._id, title: p.title, brand: p.brand, before: p.pricing?.ua ?? null, after: computePricing(p, body.config).ua })).filter(x => x.before !== x.after).slice(0, 300);
        }
        return send(res, 200, { results: cases.map(c => ({ input: c, ...priceOffer(c, cfg) })), changes });
      }
      case "pricingSave": {
        if (!body.confirmPreview) return send(res, 400, { error: "Сначала посмотрите предпросмотр изменений цен" });
        const cfg = mergeConfig(body.config);
        await store.put({ _id: "settings.pricing", _type: "settings", config: cfg, by: me.name, at: new Date().toISOString() });
        // пересчёт опубликованных товаров по новым правилам
        const pub = await store.list("product", {}, { limit: 5000 });
        for (const p of pub) { p.pricing = computePricing(p, cfg); await store.put(p); }
        return send(res, 200, { ok: true, updated: pub.length });
      }
      default: return send(res, 404, { error: "Неизвестное действие" });
    }
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
