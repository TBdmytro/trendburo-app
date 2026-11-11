/** Диагностика плавности с телефона: витрина присылает замеры (паузы кадров, события Telegram, память) — пишем в журнал сервера.
 *  Без личных данных: только техника устройства и замеры. Включается вводом «#diag» в поиске каталога. */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // проверка доступности сайта Mytheresa для честной загрузки: robots.txt, карта сайта, страница товара — без обхода защиты
  if (req.method === "GET" && /[?&]probe=mytheresa\b/.test(String(req.url || ""))) return probeMytheresa(res);
  // переезд в Postgres (Neon): шаги копирования документов из Sanity — только количество, без содержимого
  // копии страниц брендов для автопроверки кнопки: список и одна страница (сжатая) — только для разработки кнопки
  // пустые поля вокруг фото из нашего хранилища: что обрезали бы (только cdn.sanity.io)
  if (req.method === "GET" && /[?&]probe=trim\b/.test(String(req.url || ""))) return (async () => { const u = decodeURIComponent((String(req.url).match(/[?&]u=([^&]+)/) || [])[1] || ""); const out = { u };
    if (/^https:\/\/cdn\.sanity\.io\/images\//.test(u)) { const { pngGray } = await import("../lib/imgdedupe.js"); const { flatMargins, trimUrl } = await import("../lib/imgtrim.js"); try { const r = await fetch(u.split("?")[0] + "?w=200&fm=png"); const g = pngGray(Buffer.from(await r.arrayBuffer())); out.small = g && [g.w, g.h]; out.m = g && flatMargins(g); out.trimmed = await trimUrl(u); } catch (e) { out.err = String(e.message).slice(0, 100); } }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(out)); })();
  if (req.method === "GET" && /[?&]probe=snaps\b/.test(String(req.url || ""))) return (async () => { const L = await getStore().list("snap", {}, { limit: 500, fields: "_id, host, section, at, ver, meta" }); res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(L.map(x => ({ _id: x._id, host: x.host, section: x.section, at: x.at, ver: x.ver, ...(x.meta || {}) }))));  })();
  if (req.method === "GET" && /[?&]probe=snap\b/.test(String(req.url || ""))) return (async () => { const id = (String(req.url).match(/[?&]id=(snap\.[A-Za-z0-9_-]{1,180})/) || [])[1], i = +((String(req.url).match(/[?&]i=(\d)/) || [])[1] || -1); const d = id ? await getStore().get(id) : null; const x = !d ? null : i < 0 ? d.list : (d.pages || [])[i]; res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.statusCode = x ? 200 : 404; if (x && /[?&]sum=1/.test(String(req.url))) { try { const J = JSON.parse(require("zlib").gunzipSync(Buffer.from(x.gz, "base64")).toString("utf8")); const H = J.hits || []; res.setHeader("Content-Type", "application/json; charset=utf-8"); return res.end(JSON.stringify({ top: Object.keys(J), meta: Object.fromEntries(Object.entries(J).filter(([k, v]) => k !== "hits" && (typeof v !== "object" || v === null))), hit0: H[0] ? Object.keys(H[0]) : [], hits: H.map(h => ({ id: h.identifier, n: String(h.name || "").slice(0, 40), sz: h.size || null, u: String(h.url || "").slice(-60), v: Array.isArray(h.variants) ? h.variants.length : undefined, sk: h.skuList || h.colors || undefined })) })); } catch (e) { return res.end("ERR " + e.message); } } res.end(x ? x.gz : ""); })(); /* sum=1 — разбор снимка ответа LV: какие товары в нём */
  if (req.method === "GET" && /[?&]pgmig=run\b/.test(String(req.url || ""))) return pgRunPage(res);
  if (req.method === "GET" && /[?&]pgmig=(step|delta|verify|stats)\b/.test(String(req.url || ""))) return pgMig(res, String(req.url).match(/pgmig=(step|delta|verify|stats)/)[1]);
  if (req.method === "GET" && /[?&]migrate=(step|verify)\b/.test(String(req.url || ""))) return migrate(res, String(req.url).match(/migrate=(step|verify)/)[1]);
  if (req.method === "GET" && /[?&]probe=mockimgs\b/.test(String(req.url || ""))) return probeMockImgs(res);
  if (req.method === "GET" && /[?&]probe=photo\b/.test(String(req.url || ""))) return probePhoto(res);
  if (req.method === "GET" && /[?&]probe=db\b/.test(String(req.url || ""))) return probeDb(res);
  if (req.method === "GET" && /[?&]probe=pimg\b/.test(String(req.url || ""))) return (async () => { const id = (String(req.url).match(/[?&]id=(product\.manual\.[a-z0-9-]+)/) || [])[1]; const p = id ? await getStore().get(id) : null; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify({ id, images: (p?.images || []).map(i => ({ url: i.url, src: i.sourceUrl, w: i.width, h: i.height })) }, null, 1)); })();
  if (req.method === "GET" && /[?&]probe=cors\b/.test(String(req.url || ""))) return (async () => { const id = String(process.env.NEW_SANITY_PROJECT_ID || "").trim(), t = String(process.env.NEW_SANITY_TOKEN || "").trim(); let list = null, st = 0; try { const r = await fetch(`https://api.sanity.io/v2021-06-07/projects/${id}/cors`, { headers: { Authorization: `Bearer ${t}` } }); st = r.status; if (r.ok) list = (await r.json()).map(x => x.origin); } catch {} res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify({ status: st, origins: list })); })();
  if (req.method === "GET" && /[?&]probe=sites\b/.test(String(req.url || ""))) return (async () => { const st = getStore(); const [a, b] = await Promise.all([st.get("settings.webSections"), st.get("settings.webSamples")]); res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify({ sections: Object.values(a?.list || {}).map(x => ({ section: x.section, lastRun: x.lastRun, found: x.found, health: x.health })), samples: b?.list || {} }, null, 1)); })();
  // проверка перевода на фиксированных примерах (свой текст сюда не передать — это не открытый переводчик)
  if (req.method === "GET" && /[?&]probe=trdemo\b/.test(String(req.url || ""))) return (async () => { const { englishItem } = await import("../lib/translate.js"); const S = [
    { title: "Neverfull MM", description: "Die Neverfull MM Tasche aus Monogram Canvas mit Besätzen aus naturbelassenem Rindsleder. Geräumiges Innenfach, abnehmbare Reißverschlusstasche. Maße: 31 x 28 x 14 cm (Länge x Höhe x Breite).", colors: [{ name: "Monogram" }] },
    { title: "LV Trainer Sneaker", description: "Sneaker aus Kalbsleder und Wildleder mit Monogram-Blumen am Absatz. Gummisohle.", colors: [{ name: "Schwarz" }, { name: "Weiß" }] },
    { title: "Monogram Shawl Schal", description: "Schal aus Seide und Wolle mit Monogram-Muster.", colors: [{ name: "Grau" }] }];
  const out = []; for (const it of S) { try { const e = await englishItem(it); out.push({ de: it.title, en: e.title, desc: e.description, colors: (e.colors || []).map(c => c.name) }); } catch (e) { out.push({ de: it.title, error: String(e.message).slice(0, 120) }); } }
  res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(out, null, 1)); })();
  // последние товары с кнопки: пол, размеры, отладка размеров — без цен и личных данных
  if (req.method === "GET" && /[?&]probe=szcheck\b/.test(String(req.url || ""))) return (async () => { const L = (await getStore().list("product", {}, { limit: 30000, fields: "_id, category, status, webSections, variants[]{size}, offers[0]{checkedAt}" })).filter(p => /^product\.manual\.(prada|miumiu)-/.test(p._id) && p.category === "shoes");
    const out = {}; for (const p of L) { const b = p._id.split(".")[2].split("-")[0], sz = (p.variants || []).map(v => String(v.size || "")), ok = sz.length && sz.every(x => /^\d{2}(\.5)?$/.test(x) && +x >= 33 && +x <= 50); const sec = (p.webSections || [])[0] || "-"; const k = b + " " + sec; out[k] = out[k] || { good: 0, bad: 0, ex: [] }; if (ok) out[k].good++; else { out[k].bad++; if (out[k].ex.length < 2) out[k].ex.push(p._id + " " + sz.slice(0, 4).join("/") + " " + String(p.offers?.[0]?.checkedAt || "").slice(0, 16)); } }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(out, null, 1)); })();
  // товары без прочитанного наличия (offers[0].stockAt пусто): по полу/категории — чтобы понять, почему кнопка их не взяла
  // probe=brandlist&b=loro — вещи одного бренда кратко (пол, категория, размеры, модель/цвет, раздел)
  if (req.method === "GET" && /[?&]probe=brandlist\b/.test(String(req.url || ""))) return (async () => { const q = String(req.url), b = decodeURIComponent((q.match(/[?&]b=([^&]{2,40})/) || [])[1] || "").toLowerCase();
    const L = (await getStore().list("product", {}, { limit: 30000, fields: "_id, title, brand, gender, category, subcategory, status, sizes, modelSku, colors, webSections, overrides, \"u\": offers[0].url, \"bq\": offers[0].boutique, \"ck\": offers[0].checkedAt" + (/[?&]im=1/.test(q) ? ", images" : "") + (/[?&]h=1/.test(q) ? ", history" : "") })).filter(p => String(p.brand || "").toLowerCase().includes(b));
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(L.map(p => ({ id: p._id, t: p.title, g: p.gender, og: p.overrides?.gender || null, c: p.category, sc: p.subcategory, st: p.status, sz: p.sizes, m: p.modelSku, col: p.colors, sec: (p.webSections || []).slice(-2), u: p.u, bq: p.bq, ck: p.ck, ...(p.history ? { hl: (p.history || []).slice(-1)[0] || null } : {}), ...(p.images ? { im: p.images.slice(0, 10).map(i => i.sourceUrl || i.url), oc: !!(p.overrides?.cover || (p.overrides?.imageOrder || []).length) } : {}) })))); })();
  if (req.method === "GET" && /[?&]probe=nostock\b/.test(String(req.url || ""))) return (async () => { const q = String(req.url), px = "product.manual." + ((q.match(/[?&]p=([a-z0-9]{1,16})/) || [])[1] || "de") + "-", g = (q.match(/[?&]g=([a-z])/) || [])[1] || "", c = (q.match(/[?&]c=([a-z]+)/) || [])[1] || "";
    const L = (await getStore().list("product", {}, { limit: 30000, fields: "_id, title, gender, category, status, webSections, \"sa\": offers[0].stockAt, \"ca\": offers[0].checkedAt, \"u\": offers[0].url, updatedAt, createdAt" })).filter(p => p._id.startsWith(px) && (!g || p.gender === g) && (!c || p.category === c));
    const before = (q.match(/[?&]before=([0-9T:.\-Z]{10,30})/) || [])[1] || ""; // before=ISO — считать «не прочитано» и то, что прочитано раньше этого времени
    const no = L.filter(p => !p.sa || (before && String(p.sa) < before)), bySec = {}; for (const p of no) for (const w of (p.webSections && p.webSections.length ? p.webSections : ["—"])) { const b = String(w).replace(/\/page\/\d+\/?$/, ""); bySec[b] = (bySec[b] || 0) + 1; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ total: L.length, noStock: no.length, bySec, items: no.slice(0, 400).map(p => ({ id: p._id.slice(px.length), t: p.title, st: p.status, ca: p.ca, cr: p.createdAt, u: p.u, sec: (p.webSections || []).length })) })); })();
  if (req.method === "GET" && /[?&]probe=bstat\b/.test(String(req.url || ""))) return (async () => { const px = "product.manual." + ((String(req.url).match(/[?&]p=([a-z0-9]{1,16})/) || [])[1] || "de") + "-";
    const L = (await getStore().list("product", {}, { limit: 30000, fields: "_id, category, subcategory, gender, status, hasPre, soldOld, webSections, \"nIm\": count(images), \"nV\": count(variants), \"sa\": offers[0].stockAt, \"ca\": offers[0].checkedAt" })).filter(p => p._id.startsWith(px));
    const now = Date.now(), G = {}, S = {}; for (const p of L) { const k = (p.gender || "u") + " " + (p.category || "?"); const g = G[k] = G[k] || { n: 0, pub: 0, hid: 0, img3: 0, img1: 0, sz: 0, stock: 0, stock3d: 0, ask: 0, sold: 0 };
      g.n++; if (p.status === "published") g.pub++; else g.hid++; if (p.nIm >= 3) g.img3++; if (p.nIm <= 1) g.img1++; if (p.nV > 1) g.sz++; if (p.sa) g.stock++; if (p.sa && now - Date.parse(p.sa) < 3 * 864e5) g.stock3d++; if (p.hasPre) g.ask++; if (p.soldOld) g.sold++;
      for (const w of p.webSections || []) { const b = w.replace(/\/page\/\d+\/?$/, ""); const x = S[b] = S[b] || { n: 0, last: "" }; x.n++; if ((p.ca || "") > x.last) x.last = p.ca || ""; } }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ total: L.length, G, S }, null, 1)); })();
  if (req.method === "GET" && /[?&]probe=recent\b/.test(String(req.url || ""))) return (async () => { const L = (await getStore().list("product", {}, { limit: 30000, fields: "_id, brand, title, category, gender, sizes, sizeDebug, sourceUrl, webSections, status, createdAt, hasPre, manual, coverTile, coverFrom, imgVer, \"nIm\": count(images), \"im0\": images[0].url" }).catch(() => [])).filter(p => p.manual && p.sourceUrl);
    const q = decodeURIComponent((String(req.url).match(/[?&]q=([^&]+)/) || [])[1] || "").toLowerCase();
    const out = L.filter(p => !q || (p._id + " " + p.brand + " " + p.title + " " + (p.webSections || []).join(" ")).toLowerCase().includes(q)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 25).map(p => ({ id: p._id, t: p.title, b: p.brand, c: p.category, g: p.gender, st: p.status, n: (p.sizes || []).length, pre: p.hasPre, dbg: p.sizeDebug ? String(p.sizeDebug).slice(0, 300) : null, url: p.sourceUrl, sec: (p.webSections || []).slice(-1)[0], at: p.createdAt, tile: p.coverTile, cf: p.coverFrom, iv: p.imgVer, nIm: p.nIm, im0: p.im0 }));
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(out, null, 1)); })();
  // дубли: товары одного артикула под разными записями, по бренду (только названия и адреса)
  if (req.method === "GET" && /[?&]probe=dups\b/.test(String(req.url || ""))) return (async () => { const L = await getStore().list("product", {}, { limit: 30000, fields: "_id, brand, title, category, status, sourceUrl, modelSku, createdAt, gender, images[0]{url}" }).catch(() => []);
    const b = decodeURIComponent((String(req.url).match(/[?&]b=([^&]+)/) || [])[1] || "saint laurent").toLowerCase();
    const mine = L.filter(p => String(p.brand || "").toLowerCase().includes(b)); const by = {};
    for (const p of mine) { const k = (String(p.sourceUrl || "").match(/([A-Z0-9]{10,})\.html/i) || [])[1] || p.modelSku || p._id; (by[k.toUpperCase()] = by[k.toUpperCase()] || []).push(p); }
    const d = Object.entries(by).filter(([, l]) => l.length > 1);
    const cats = {}; mine.forEach(p => { const k = p.category + ":" + p.status; cats[k] = (cats[k] || 0) + 1; });
    const last = mine.slice().sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).slice(0, 8).map(p => [p._id, p.title, p.status, p.createdAt, p.gender]);
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ total: mine.length, cats, dupGroups: d.length, dupSample: d.slice(0, 6).map(([k, l]) => ({ k, recs: l.map(p => [p._id, p.status, p.createdAt, p.brand]) })), last }, null, 1)); })();
  // уменьшенная копия фото из нашего хранилища (base64) — проверить обложку глазами; только наши картинки
  if (req.method === "GET" && /[?&]probe=imgb\b/.test(String(req.url || ""))) return (async () => { const id = (String(req.url).match(/[?&]id=(product\.manual\.[a-z0-9-]+)/) || [])[1]; const p = id ? await getStore().get(id) : null; const out = [];
    const n = Math.min(4, Number((String(req.url).match(/[?&]n=(\d)/) || [])[1]) || 1); for (const im of (p?.images || []).slice(0, n)) { const u = String(im.url || ""); if (!/^https:\/\/cdn\.sanity\.io\/images\//.test(u)) { out.push({ u, b64: null }); continue; } try { const r = await fetch(u + "?w=220&fm=jpg&q=55"); out.push({ u, b64: Buffer.from(await r.arrayBuffer()).toString("base64") }); } catch { out.push({ u, b64: null }); } }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(out)); })();
  // фото как «картинка из букв» (светлое — пробел, тёмное — #): видно ракурс и крупность без скачивания
  if (req.method === "GET" && /[?&]probe=imgascii\b/.test(String(req.url || ""))) return (async () => { const id = (String(req.url).match(/[?&]id=(product\.manual\.[a-z0-9-]+)/) || [])[1]; const p = id ? await getStore().get(id) : null; const { pngGray } = await import("../lib/imgdedupe.js"); const out = [];
    for (const im of (p?.images || []).slice(0, 4)) { const u = String(im.url || ""); if (!/^https:\/\/cdn\.sanity\.io\/images\//.test(u)) { out.push({ u }); continue; } try { const r = await fetch(u + "?w=32&h=40&fit=fill&fm=png"); const g = pngGray(Buffer.from(await r.arrayBuffer())); const ch = " .:-=+*#%@"; const rows = []; for (let y = 0; y < g.h; y++) { let row = ""; for (let x = 0; x < g.w; x++) row += ch[Math.min(9, Math.floor((255 - g.px[y * g.w + x]) / 25.6))]; rows.push(row); } out.push({ u: u.slice(-40), rows }); } catch (e) { out.push({ u, err: String(e.message) }); } }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(out, null, 1)); })();
  // проверка всех товаров: по брендам — фото обновлены, мало фото, нет размеров у одежды/обуви, нет цены
  if (req.method === "GET" && /[?&]probe=audit\b/.test(String(req.url || ""))) return (async () => { const L = await getStore().list("product", {}, { limit: 30000, fields: "_id, brand, category, status, imgVer, sourceUrl, \"nIm\": count(images), \"nSz\": count(sizes), \"pr\": pricing.ua, overrides{category}" }).catch(() => []);
    const by = {}; for (const p of L) { if (!/^product\.manual\./.test(p._id) || !p.sourceUrl) continue; const b = p.brand || "?"; const r = by[b] = by[b] || { total: 0, onSite: 0, oldPhotos: 0, onePhoto: 0, noSizes: 0, noPrice: 0 }; const cat = p.overrides?.category || p.category;
      r.total++; if ((p.nIm || 0) <= 1) { r.one = r.one || []; if (r.one.length < 60) r.one.push([cat, p.imgVer === 2 ? "new" : "old", String(p.sourceUrl).split("/").pop()]); } if (p.status === "published") r.onSite++; if (p.imgVer !== 2) r.oldPhotos++; if ((p.nIm || 0) <= 1) r.onePhoto++; if (["clothing", "shoes"].includes(cat) && !p.nSz) r.noSizes++; if (!p.pr) r.noPrice++; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(by, null, 1)); })();
  if (req.method === "GET" && /[?&]probe=src\b/.test(String(req.url || ""))) return (async () => { const id = (String(req.url).match(/[?&]id=([a-z0-9-]+)/) || [])[1]; const s = id ? await getStore().get("source." + id) : null; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(s ? { schedule: s.schedule || null, lastRefreshAt: s.lastRefreshAt || null, load: s.load ? { status: s.load.status, updatedAt: s.load.updatedAt } : null, lastSync: s.lastSync ? { status: s.lastSync.status, at: s.lastSync.at } : null, catalog: !!(s.custom && s.custom.catalog) } : null)); })();
  if (req.method === "GET" && /[?&]probe=fam\b/.test(String(req.url || ""))) return (async () => { const q = decodeURIComponent((String(req.url).match(/[?&]q=([^&]+)/) || [])[1] || "").toLowerCase(); const { toStorefront } = await import("../lib/catalog.js");
    const list = await getStore().list("product", { status: "published" }, { limit: 30000, fields: "_id, brand, title, sourceTitle, category, subcategory, subFor, modelSku, colors, gender, images, variants, offers, pricing, overrides, status, stock, secPos" });
    const out = list.filter(p => String(p.title || "").toLowerCase().includes(q)).slice(0, 40).map(p => { const sf = toStorefront(p, Date.now(), { compact: true }); return sf && { t: sf.title, fam: sf.fam, col: sf.col, colors: (sf.colors || []).map(c => c.name), sku: p.modelSku, src: (p.offers || [])[0]?.sourceId, cat: sf.cat, sz: (sf.sizes || []).map(s => s.size + ":" + s.status).join(" "), nv: (p.variants || []).length, url: (p.offers || [])[0]?.url, chk: (p.offers || [])[0]?.checkedAt }; }).filter(Boolean);
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1)); })();
  if (req.method === "GET" && /[?&]probe=img\b/.test(String(req.url || ""))) return probeImg(res, decodeURIComponent((String(req.url).match(/[?&]u=([^&]+)/) || [])[1] || ""));
  if (req.method === "GET" && /[?&]probe=cat\b/.test(String(req.url || ""))) return probeCat(res);
  if (req.method === "GET" && /[?&]probe=sizes\b/.test(String(req.url || ""))) return probeSizes(res, (String(req.url).match(/[?&]host=([a-z0-9.-]+)/) || [])[1] || "ysl.com", (String(req.url).match(/[?&]cat=([a-z]+)/) || [])[1] || "clothing");
  if (req.method === "GET" && /[?&]probe=ysl\b/.test(String(req.url || ""))) return probeYsl(res);
  if (req.method === "GET" && /[?&]probe=count\b/.test(String(req.url || ""))) return probeCount(res, (String(req.url).match(/[?&]host=([a-z0-9.-]+)/) || [])[1] || "");
  if (req.method === "GET" && /[?&]probe=shops\b/.test(String(req.url || ""))) return probeShops(res, (String(req.url).match(/[?&]part=(\d)/) || [])[1] | 0);
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  let j = null;
  try {
    if (req.body && typeof req.body === "object") j = req.body;
    else if (typeof req.body === "string") j = JSON.parse(req.body.slice(0, 20000));
    else { let body = ""; for await (const c of req) { body += c; if (body.length > 20000) break; } j = JSON.parse(body.slice(0, 20000)); } console.log("DIAG " + JSON.stringify(j).slice(0, 15000)); } catch { console.log("DIAG bad"); }
  res.statusCode = 204; res.end();
}

import { safeFetch, parseRobots, robotsAllows } from "../lib/http.js";
async function probeMytheresa(res) {
  const H = "https://www.mytheresa.com", domains = ["www.mytheresa.com", "mytheresa.com"], out = { at: new Date().toISOString() };
  const look = async (name, url, types) => {
    try { const r = await safeFetch(url, { domains, types, maxBytes: 6_000_000, lang: "en-GB,en;q=0.9" });
      const t = r.text || ""; out[name] = { status: r.status, type: r.type, bytes: t.length, ldjson: (t.match(/application\/ld\+json/g) || []).length, product: /"@type"\s*:\s*"Product"/.test(t), price: (t.match(/"price"\s*:\s*"?([\d.,]+)/) || [])[1] || null, currency: (t.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/) || [])[1] || null,
        title: (t.match(/<title[^>]*>([^<]{0,160})/i) || [])[1] || null, text: t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400), scripts: (t.match(/<script[^>]*src="([^"]+)"/gi) || []).slice(0, 6).map(x => x.replace(/.*src="/, "").slice(0, 120)),
        challenge: /captcha|px-captcha|perimeterx|_abck|akamai|access denied|cf-chl|are you a human/i.test(t), head: t.slice(0, 160).replace(/\s+/g, " ") }; return t; }
    catch (e) { out[name] = { error: String(e && e.message || e).slice(0, 200) }; return ""; }
  };
  const rb = await look("robots", H + "/robots.txt", ["text/plain", "text/html"]);
  if (rb) { const R = parseRobots(rb); out.robotsRules = rb.split("\n").filter(l => /^(user-agent|disallow|allow|sitemap|crawl-delay)/i.test(l.trim())).slice(0, 60);
    out.allowed = { women: robotsAllows(R, "/euro/en/women/clothing"), product: robotsAllows(R, "/euro/en/women/x-p00123456") }; }
  const sm = (rb.match(/sitemap:\s*(\S+)/i) || [])[1];
  const smx = sm ? await look("sitemap", sm, ["application/xml", "text/xml", "text/plain"]) : "";
  const locs = (smx.match(/<loc>([^<]+)<\/loc>/g) || []).map(x => x.slice(5, -6)); out.sitemapLocs = locs.slice(0, 80); out.sitemapCount = locs.length;
  const psm = locs.find(u => /euro|en-de|de-en/i.test(u) && /product/i.test(u) && !/\.gz$/.test(u)) || locs.find(u => /product/i.test(u) && !/\.gz$/.test(u));
  let firstProduct = null;
  if (psm) { const px = await look("productSitemap", psm, ["application/xml", "text/xml", "text/plain"]); const pl = (px.match(/<loc>([^<]+)<\/loc>/g) || []).map(x => x.slice(5, -6)); out.productSitemapCount = pl.length; out.productSitemapSample = pl.slice(0, 5); firstProduct = pl.find(u => /-p\d{6,}/.test(u)) || pl[0] || null; }
  const cat = await look("category", H + "/euro/en/women/clothing", ["text/html"]);
  const purl = (cat.match(/href="(\/euro\/en\/women\/[^"]*-p\d{8}[^"]*)"/) || [])[1];
  const prod = purl ? H + purl : firstProduct;
  if (prod && domains.some(d => prod.includes("//" + d + "/"))) { const pt = await look("product", prod, ["text/html"]); out.productUrl = prod;
    const lds = (pt.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []).map(x => x.replace(/^<script[^>]*>|<\/script>$/gi, "")); out.productLd = lds.map(x => x.slice(0, 1500)); out.nextData = /__NEXT_DATA__/.test(pt); }
  console.log("PROBE " + JSON.stringify(out).slice(0, 12000));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

// какие европейские мультибренды отдают открытый каталог (как Sporty & Rich): фиксированный список, только чтение, через обычную проверку поставщика
import { detectSupplier } from "../lib/suppliers.js";
const SHOP_CANDIDATES = [
  ["smets.lu", "voostore.com", "andreas-murkudis.com", "jades24.com", "apropos-store.com", "lodenfrey.com", "julian-fashion.com", "antonioli.eu", "coltortiboutique.com", "giglio.com", "baseblu.com", "tizianafausti.com"],
  ["genteroma.com", "leam.com", "biffi.com", "dante5.com", "suitnegozi.com", "eraldo.com", "wiseboutique.com", "nugnes1920.com", "thedoublef.com", "vitkac.com", "eleonorabonucci.com", "modes.com"],
  ["lyst.com", "cettire.com", "24s.com", "luisaviaroma.com", "ssense.com", "brownsfashion.com", "theluxurycloset.com", "zalando-lounge.de", "breuninger.com", "ekseption.es", "stefaniamode.com", "boutiquematerfamilias.com"]
];
async function probeShops(res, part) {
  const list = SHOP_CANDIDATES[part] || SHOP_CANDIDATES[0], t0 = Date.now();
  const out = await Promise.all(list.map(async h => {
    try { const r = await Promise.race([detectSupplier("https://" + h), new Promise(r => setTimeout(r, 45000, { ok: false, reason: "долго не отвечает" }))]);
      return { host: h, ok: !!r.ok, currency: r.currency || null, eu: !!r.euPrices, market: r.market || null, geoEu: !!r.geoEu, sample: r.sample || 0, vendors: (r.vendors || []).slice(0, 25), vendorCount: r.vendorCount || 0, reason: r.reason || null };
    } catch (e) { return { host: h, ok: false, reason: String(e && e.message || e).slice(0, 160) }; }
  }));
  console.log("PROBE shops " + JSON.stringify(out.map(o => [o.host, o.ok, o.currency, o.vendorCount])).slice(0, 3000));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify({ ms: Date.now() - t0, out }, null, 1));
}

// сколько товаров ключевых брендов у открытого магазина (только из списка выше): листаем products.json, считаем товары в наличии
const KEY_BRANDS = { gucci: "Gucci", prada: "Prada", "saint laurent": "Saint Laurent", "miu miu": "Miu Miu", loewe: "Loewe", "bottega veneta": "Bottega Veneta", "the row": "The Row", balenciaga: "Balenciaga", valentino: "Valentino", "valentino garavani": "Valentino", fendi: "Fendi", "brunello cucinelli": "Brunello Cucinelli", "loro piana": "Loro Piana", "loropiana": "Loro Piana", khaite: "Khaite", "phoebe philo": "Phoebe Philo", celine: "Celine", "alaïa": "Alaïa", alaia: "Alaïa", moncler: "Moncler", toteme: "Toteme" };
async function probeCount(res, host) {
  const ok = SHOP_CANDIDATES.flat().includes(host); const out = { host, ok, total: 0, inStock: 0, brands: {}, pages: 0, complete: false };
  if (ok) { const t0 = Date.now();
    for (let page = 1; page <= 120 && Date.now() - t0 < 50000; page++) {
      let list = [];
      try { const r = await safeFetch(`https://${host}/products.json?limit=250&page=${page}`, { domains: [host, "www." + host], types: ["application/json"], maxBytes: 12_000_000, timeoutMs: 12000 }); list = JSON.parse(r.text || "{}").products || []; }
      catch (e) { out.error = String(e && e.message || e).slice(0, 160); break; }
      out.pages = page; if (!list.length) { out.complete = true; break; }
      for (const p of list) { out.total++; const live = (p.variants || []).some(v => v.available); if (live) out.inStock++;
        const b = KEY_BRANDS[String(p.vendor || "").toLowerCase().trim()]; if (b && live) out.brands[b] = (out.brands[b] || 0) + 1; }
      await new Promise(r => setTimeout(r, 250));
    }
  }
  console.log("PROBE count " + JSON.stringify(out));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

// сайт Saint Laurent: robots.txt, карта сайта, страница сумок — только чтение, без обхода защиты
async function probeYsl(res) {
  const H = "https://www.ysl.com", domains = ["www.ysl.com", "ysl.com"], out = {};
  const look = async (name, url, types) => {
    try { const r = await safeFetch(url, { domains, types, maxBytes: 8_000_000, lang: "en-GB,en;q=0.9" }); const t = r.text || "";
      out[name] = { status: r.status, bytes: t.length, title: (t.match(/<title[^>]*>([^<]{0,160})/i) || [])[1] || null, ld: (t.match(/application\/ld\+json/g) || []).length, products: (t.match(/"@type"\s*:\s*"Product"/g) || []).length,
        links: [...new Set((t.match(/href="([^"]*\/[^"]*-[A-Z0-9]{6,}[^"]*\.html)"/g) || []).map(x => x.slice(6, -1)))].slice(0, 5), text: t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) }; return t; }
    catch (e) { out[name] = { error: String(e && e.message || e).slice(0, 200) }; return ""; }
  };
  const rb = await look("robots", H + "/robots.txt", ["text/plain", "text/html"]);
  out.robotsRules = rb.split("\n").filter(l => /^(user-agent|disallow|allow|sitemap)/i.test(l.trim())).slice(0, 40);
  if (rb) { const R = parseRobots(rb); out.allowed = robotsAllows(R, "/en-de/shop-women/handbags"); }
  const sm = (rb.match(/sitemap:\s*(\S+)/i) || [])[1]; if (sm) { const x = await look("sitemap", sm, ["application/xml", "text/xml", "text/plain"]); out.sitemapLocs = (x.match(/<loc>([^<]+)<\/loc>/g) || []).slice(0, 15).map(v => v.slice(5, -6)); }
  await look("bags", H + "/en-de/shop-women/handbags", ["text/html"]);
  console.log("PROBE ysl " + JSON.stringify(out).slice(0, 6000));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

// сводка по товарам в базе (только числа и примеры id/брендов, без личных данных): откуда товары, сколько пустых
import { getStore } from "../lib/store.js";
async function probeDb(res) {
  const store = await getStore(); const out = {};
  try { if (store.q) out.docs = await store.q(`{"all":count(*),"product":count(*[_type=="product"]),"ourProduct":count(*[_type=="product" && _id in path("product.**")]),"asset":count(*[_type=="sanity.imageAsset"]),"importItem":count(*[_type=="importItem"]),"importJob":count(*[_type=="importJob"]),"drafts":count(*[_id in path("drafts.**")]),"types":array::unique(*[]._type)}`); } catch (e) { out.docsError = String(e.message).slice(0, 200); }
  try {
    const all = await store.list("product", {}, { limit: 60000, fields: "_id, brand, title, status, category, images[0...1]{url}, offers[0...1]{sourceId}, manual, createdAt" });
    const cnt = (f) => { const m = {}; all.forEach(p => { const k = f(p); m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25); };
    out.total = all.length;
    out.byPrefix = cnt(p => String(p._id).split(".").slice(0, 2).join(".").replace(/^(product\.(manual|u))\..*/, "$1"));
    out.bySource = cnt(p => (p.offers || [])[0]?.sourceId || "(нет источника)");
    out.byStatus = cnt(p => p.status || "(нет)");
    out.byCategory = cnt(p => p.category || "(нет)");
    out.noTitle = all.filter(p => !p.title).length; out.noBrand = all.filter(p => !p.brand).length; out.noImage = all.filter(p => !(p.images || []).length).length;
    out.emptyBySource = cnt(p => (!p.title || !(p.images || []).length) ? ((p.offers || [])[0]?.sourceId || "(нет источника)") : "_ok");
    out.topBrands = cnt(p => p.brand || "(нет)");
    out.samples = all.filter(p => !p.title || !(p.images || []).length).slice(0, 8).map(p => ({ id: String(p._id).slice(0, 60), brand: p.brand || null, title: (p.title || "").slice(0, 40), src: (p.offers || [])[0]?.sourceId || null, createdAt: p.createdAt || null }));
    const types = await store.list("source", {}, { limit: 200, fields: "_id, name, kind, custom{home}" }).catch(() => []);
    out.sources = types.map(t => ({ id: t._id, name: t.name, home: t.custom?.home || null }));
  } catch (e) { out.error = String(e && e.message || e).slice(0, 300); }
  console.log("PROBE db " + JSON.stringify(out).slice(0, 5000));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

// перенос Trend Büro в отдельную базу: шаг копирования (только своё, повторять до done) и сверка. После done шаг ничего не делает.
async function migrate(res, mode) {
  let out;
  try { const { stores, migrateStep, migrateVerify } = await import("../lib/migrate.js"); const { oldS, newS } = stores();
    out = mode === "step" ? await migrateStep(oldS, newS) : await migrateVerify(oldS, newS); }
  catch (e) { out = { error: String(e && e.message || e).slice(0, 300), cause: String(e && e.cause && (e.cause.code || e.cause.message) || "").slice(0, 120) }; }
  console.log("MIGRATE " + mode + " " + JSON.stringify(out).slice(0, 2000));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

// путь фото с кнопки: 1) хранилище принимает файл (крошечная картинка, сразу удаляется); 2) сервер скачивает фото Saint Laurent и Mytheresa по ссылке (без сохранения)
async function probePhoto(res) {
  const out = {}; const store = await getStore();
  try { const buf = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z", "base64");
    const up = await store.uploadImage(buf, { filename: "probe.jpg", contentType: "image/jpeg" }); out.upload = { ok: !!up.url, cdn: String(up.url || "").split("/").slice(0, 5).join("/") };
    if (up.assetId && store.del) await store.del(up.assetId).catch(() => {}); }
  catch (e) { out.upload = { ok: false, why: String(e.message).slice(0, 200) }; }
  const { fetchBinary } = await import("../lib/images.js");
  for (const [k, u] of [["ysl", "https://saint-laurent.dam.kering.com/asset/ba997059-975d-4e64-b3db-7b15dfb980a8/eCom/A00FMUAAHXH1000_A.jpg?v=1"], ["mytheresa", "https://www.mytheresa.com/image/1094/1238/100/c2/P00670061.jpg"]]) {
    try { const b = await fetchBinary(u, [new URL(u).hostname]); out[k] = { ok: true, type: b.type, kb: Math.round(b.buf.length / 1024) }; }
    catch (e) { out[k] = { ok: false, why: String(e.message).slice(0, 160) }; }
  }
  console.log("PROBE photo " + JSON.stringify(out));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

// фото для макетов (фиксированный список с наших поставщиков, уменьшенные) — base64, только чтение
const MOCK_IMGS = [
  "https://saint-laurent.dam.kering.com/asset/bc42d3ca-6b5a-48eb-b0b3-d81174a9fa85/Medium/A00FMTAAHXH1000_A.jpg?v=1",
  "https://saint-laurent.dam.kering.com/asset/00115dac-8c6c-441f-be31-9d9d672e7efc/Medium/A00FMUAAHXH6178_A.jpg?v=1",
  "https://saint-laurent.dam.kering.com/asset/ba997059-975d-4e64-b3db-7b15dfb980a8/Medium/A00FMUAAHXH1000_A.jpg?v=1",
  "https://saint-laurent.dam.kering.com/asset/5750f306-3f27-4613-87ac-98e10bf75afd/Medium/A00IJM1F4AW2557_A.jpg?v=2",
  "https://cdn.shopify.com/s/files/1/2185/2813/files/A1050U_01_b1_s1_a1_dFA26.jpg?v=1788430157&width=420",
  "https://cdn.shopify.com/s/files/1/2185/2813/files/A0891U_06645_b1_s1_a1_17016ab7-96c0-4018-9aa2-f65e77f61b63.jpg?v=1767195125&width=420",
  "https://cdn.shopify.com/s/files/1/2185/2813/files/W5561R_0968_b1_s1_a2_dSP26_m18_c32b2296-22b6-4fcb-8c01-6d0cd09c8590.jpg?v=1775104180&width=420",
  "https://cdn.shopify.com/s/files/1/2185/2813/files/A0158U_01_b1_s1_a191_dSP26.jpg?v=1776874071&width=420"
];
async function probeMockImgs(res) {
  const { fetchBinary } = await import("../lib/images.js");
  const out = await Promise.all(MOCK_IMGS.map(async u => { try { const b = await fetchBinary(u, [new URL(u).hostname]); return { u, type: b.type, kb: Math.round(b.buf.length / 1024), b64: b.buf.length < 400000 ? b.buf.toString("base64") : null }; } catch (e) { return { u, err: String(e.message).slice(0, 100) }; } }));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out));
}

// размеры у загруженных с сайта бренда товаров: сколько с размерами и без (только чтение), плюс разбор пары страниц без размеров
async function probeSizes(res, host, cat = "clothing") {
  const store = await getStore(); const out = { host };
  const list = await store.q(`*[_type=="product" && _id in path("product.**") && sourceUrl match $h]{_id,title,category,subcategory,sizes,sourceUrl,sizeDebug,_updatedAt}`, { h: "*" + host + "*" });
  const by = {}; for (const p of list) { const k = p.category || "?"; by[k] = by[k] || { with: 0, without: 0 }; (p.sizes && p.sizes.length ? by[k].with++ : by[k].without++); }
  out.total = list.length; out.byCat = by;
  const no = list.filter(p => p.category === cat && !(p.sizes && p.sizes.length)).sort((a, b) => String(b._updatedAt).localeCompare(String(a._updatedAt))), yes = list.filter(p => p.category === cat && p.sizes && p.sizes.length);
  out.noSamples = no.slice(0, 12).map(p => [p.title, p.sourceUrl, p._updatedAt]); out.debug = list.filter(p => p.sizeDebug && p.category === "clothing").sort((a, b) => String(b._updatedAt).localeCompare(String(a._updatedAt))).slice(0, 5).map(p => [p.title, p._updatedAt, p.sizeDebug]); out.yesSamples = yes.slice(0, 6).map(p => [p.title, p.sizes, p.sourceUrl]);
  const dom = host.replace(/^www\./, ""); out.pages = [];
  for (const p of [...no.slice(0, 3), ...yes.slice(0, 1)]) {
    try { const r = await safeFetch(p.sourceUrl, { domains: [dom, "www." + dom], types: ["text/html"], maxBytes: 8_000_000, lang: "en-GB,en;q=0.9" }); const t = r.text || "";
      const ld = (t.match(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []).map(x => x.replace(/<[^>]+>/g, "")).join(" ");
      const sz = t.match(/"sizes"\s*:\s*(\[[^\]]{0,600}\])/);
      out.pages.push({ url: p.sourceUrl, had: !!(p.sizes && p.sizes.length), status: r.status, bytes: t.length, ldHasVariant: /hasVariant/.test(ld), ldSize: (ld.match(/"size"\s*:\s*"[^"]{0,20}"/g) || []).slice(0, 8), sizesJson: sz ? sz[1].slice(0, 400) : null,
        sizeWords: [...new Set((t.match(/"(?:size|sizeLabel|displayValue)"\s*:\s*"[^"]{1,12}"/g) || []))].slice(0, 15), vattr: (t.match(/"variationAttributes"[\s\S]{0,900}/) || [""])[0].replace(/\s+/g, " ").slice(0, 900), oneSize: /one ?size|taille unique|\bU\b"/i.test(t) });
    } catch (e) { out.pages.push({ url: p.sourceUrl, error: String(e && e.message || e).slice(0, 160) }); }
  }
  console.log("PROBE sizes " + JSON.stringify(out).slice(0, 6000));
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

// витрина: сколько товаров опубликовано и сколько реально попадает в каталог, по брендам (только числа)
async function probeCat(res) {
  const store = await getStore(); const out = {};
  const { toStorefront } = await import("../lib/catalog.js");
  const list = await store.list("product", { status: "published" }, { limit: 30000, fields: "_id, brand, title, sourceTitle, category, gender, images, variants, offers, pricing, overrides, status, publishedAt, stock, secPos" });
  const now = Date.now(), by = {}, shown = {}, why = {};
  for (const p of list) { const b = p.brand || "?"; by[b] = (by[b] || 0) + 1; const sf = toStorefront(p, now, { compact: true }); if (sf) shown[b] = (shown[b] || 0) + 1; else { const r = !p.pricing?.ua ? "no-price" : !(p.images || []).length ? "no-images" : p.overrides?.hidden ? "hidden" : "other"; why[r] = (why[r] || 0) + 1; } }
  // фото: откуда, дубли, примеры; новинки по брендам
  const hosts = {}, dup = {}, news = {}, samples = {};
  for (const p of list) { const sf = toStorefront(p, now, { compact: true }); if (!sf) continue; const b = p.brand || "?";
    const ims = (sf.im || []).map(String); ims.forEach(u => { const h = (u.match(/^https?:\/\/([^/]+)/) || [, u[0] === "~" ? "shopify" : "?"])[1]; hosts[h] = (hosts[h] || 0) + 1; });
    const names = ims.map(u => u.split("?")[0].split("/").pop().replace(/[-_]\d{2,4}x\d{0,4}|_\d{3,4}(?=\.)/g, "").toLowerCase());
    if (new Set(names).size < names.length || new Set(ims).size < ims.length) dup[b] = (dup[b] || 0) + 1;
    if (sf.isNew) news[b] = (news[b] || 0) + 1;
    if (!samples[b] || samples[b].length < 3) (samples[b] = samples[b] || []).push({ id: sf.id, t: sf.title, im: ims.slice(0, 4) }); }
  { const fam = {}, fb = {}; for (const p of list) { const sf = toStorefront(p, now, { compact: true }); if (sf && sf.fam) { fam[sf.fam] = (fam[sf.fam] || []); fam[sf.fam].push(sf.title + " · " + (sf.col || "?")); fb[sf.fam] = p.brand; } }
    const multi = Object.entries(fam).filter(([, l]) => l.length > 1); out.colorFamilies = { total: multi.length, byBrand: multi.reduce((a, [k]) => (a[fb[k]] = (a[fb[k]] || 0) + 1, a), {}), examples: multi.slice(0, 6).map(([, l]) => l.slice(0, 5)) }; }
  out.imgHosts = hosts; out.prodWithDupImgs = dup; out.isNewByBrand = news; out.samples = samples;
  out.published = list.length; out.noPublishedAt = list.filter(p => !p.publishedAt).length; out.brands = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([b, n]) => [b, n, shown[b] || 0]); out.notShown = why;
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

// фото с нашего хранилища: отвечает ли и что отдаёт (только cdn.sanity.io, без личных данных)
async function probeImg(res, u) {
  const out = { u };
  if (!/^https:\/\/cdn\.sanity\.io\/images\/[a-z0-9]+\/[a-z0-9_-]+\/[a-f0-9]+-\d+x\d+\.(jpg|png|webp)(\?[a-z0-9=&_.%-]*)?$/i.test(u)) out.error = "только фото cdn.sanity.io";
  else for (const v of [u, u + (u.includes("?") ? "&" : "?") + "w=400&fit=max&auto=format&q=82"]) {
    try { const r = await fetch(v, { headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", Accept: "image/avif,image/webp,image/*" } }); const b = await r.arrayBuffer();
      out[v === u ? "orig" : "w400"] = { status: r.status, type: r.headers.get("content-type"), bytes: b.byteLength, acao: r.headers.get("access-control-allow-origin") }; }
    catch (e) { out[v === u ? "orig" : "w400"] = { error: String(e.message).slice(0, 120) }; }
  }
  // маленькая копия (для проверки, что на фото — товар, а не пустая заглушка)
  if (!out.error) { try { const r = await fetch(u + (u.includes("?") ? "&" : "?") + "w=240&fm=jpg&q=70", { headers: { Origin: "https://trendburo-app.vercel.app" } }); out.cors = r.headers.get("access-control-allow-origin"); out.thumb = Buffer.from(await r.arrayBuffer()).toString("base64"); } catch (e) { out.thumbErr = String(e.message).slice(0, 80); } }
  res.setHeader("Content-Type", "application/json; charset=utf-8"); res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}

async function pgMig(res, mode) {
  res.setHeader("Content-Type", "application/json; charset=utf-8"); let out;
  try {
    const { sanityStore, pgUrl } = await import("../lib/store.js"); const { PgStore, lazyNeon } = await import("../lib/pgstore.js");
    if (!pgUrl()) throw new Error("Нет DATABASE_URL — база Neon не подключена к проекту");
    const pg = new PgStore({ exec: lazyNeon(pgUrl()) }), san = sanityStore();
    const m = await import("../lib/pgmigrate.js");
    if (mode === "stats") out = { backend: process.env.DB_BACKEND || "sanity", pg: await pg.stats() };
    else if (mode === "step") out = await m.pgMigrateStep(san, pg);
    else if (mode === "delta") { const st = await pg.get("settings.pgmigrate"); if (!st?.startedAt) throw new Error("Сначала step"); out = await m.pgMigrateDelta(san, pg, st.startedAt); }
    else out = await m.pgMigrateVerify(san, pg);
  } catch (e) { out = { error: String(e.message).slice(0, 300) }; }
  console.log("[pgmig]", mode, JSON.stringify(out).slice(0, 1500)); // только количества, без данных
  res.statusCode = 200; res.end(JSON.stringify(out, null, 1));
}
/** Страница переезда: открыть один раз — сама гоняет step до конца, затем verify. Показывает только количества. */
function pgRunPage(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.statusCode = 200;
  res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Переезд базы</title>
<body style="font:16px/1.5 system-ui;padding:20px;max-width:560px;margin:auto;background:#f2f3f4;color:#26282c"><h2>Переезд базы в Neon</h2><div id=s>Начинаю…</div><pre id=o style="white-space:pre-wrap;font-size:12px"></pre>
<script>const s=document.getElementById('s'),o=document.getElementById('o');const j=m=>fetch('?pgmig='+m+'&t='+Date.now()).then(r=>r.json());
(async()=>{let r,i=0;do{r=await j('step');if(r.error){s.textContent='Ошибка: '+r.error;return}s.textContent='Перенесено документов: '+(r.copied||0)+(r.done?' — готово':' …');}while(!r.done&&++i<60);
const d=await j('delta');s.textContent+=' · догнал изменений: '+(d.copied||0)+' · сверяю…';const v=await j('verify');s.textContent=v.ok?'✅ Готово, всё сходится. Можно закрыть страницу.':'⚠️ Есть расхождения — Claude посмотрит.';o.textContent=Object.entries(v.types||{}).map(([k,x])=>k+': '+x.sanity+' → '+x.postgres+(x.ok?'':' ✗')).join('\\n');})();</script>`);
}
