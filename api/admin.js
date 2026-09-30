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
      case "me": return send(res, 200, { name: me.name, store: store.kind, demo: !!store.demo });

      case "overview": {
        const [published, draft, hidden, jobs, waiting] = await Promise.all([
          store.count("product", { status: "published" }), store.count("product", { status: "draft" }), store.count("product", { status: "hidden" }),
          store.list("importJob", {}, { order: "createdAt desc", limit: 8, fields: JOB_FIELDS }),
          store.count("importItem", { publishedAs: null, kind: ["new", "update", "duplicate"] })
        ]);
        return send(res, 200, { published, draft, hidden, waiting, jobs: jobs.map(slim), active: jobs.filter(j => ACTIVE.includes(j.status)).length });
      }
      case "sourceCheck": {
        // Проверка доступа с нашего сервера: robots.txt + главная страница источника. Без обхода защиты.
        const id = body.id; if (!SOURCES[id]) return send(res, 400, { error: "Неизвестный источник" });
        const settings = await store.get("source." + id);
        const src = sourceWith(settings, id);
        let check;
        if (!src.home) check = { ok: false, state: "none", text: "У источника нет адреса сайта — используйте файл" };
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
        for (const id of Object.keys(SOURCES)) {
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
            categories: [...new Set(mine.map(p => p.category).filter(Boolean))]
          });
        }
        return send(res, 200, { sources: out });
      }
      case "sourceSave": {
        const id = body.id; if (!SOURCES[id]) return send(res, 400, { error: "Неизвестный источник" });
        const cur = (await store.get("source." + id)) || { _id: "source." + id, _type: "sourceSettings", sourceId: id };
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
      case "status": return send(res, 200, { results: await setStatus(store, body.ids || [], ["published", "draft", "hidden"].includes(body.status) ? body.status : "draft", me.name) });

      case "products": {
        let list = await store.list("product", {}, { order: "updatedAt desc", limit: 5000 });
        const q = String(req.query.q || "").toLowerCase();
        if (q) list = list.filter(p => [p.brand, p.title, p.sourceTitle, p.modelSku].join(" ").toLowerCase().includes(q));
        if (req.query.status) list = list.filter(p => p.status === req.query.status);
        return send(res, 200, { products: list.slice(0, 300).map(p => ({ _id: p._id, brand: p.brand, title: p.overrides?.title || p.title, category: p.overrides?.category || p.category, status: p.status, cover: (p.images || [])[0]?.url || null, price: p.pricing, updatedAt: p.updatedAt, issues: (p.issues || []).length, hidden: !!p.overrides?.hidden })), total: list.length });
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
