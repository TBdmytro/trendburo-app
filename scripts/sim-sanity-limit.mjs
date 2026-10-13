import { SanityStore } from "../lib/store.js";
import { migrateDb, loadCatalogPage } from "../lib/catalogload.js";
import { addSupplier } from "../lib/suppliers.js";
import fs from "node:fs";
const { setDnsCheck } = await import("../lib/http.js"); setDnsCheck(false);
const db = new Map(); const LIMIT = 2000;
const countPaths = m => { const ps = new Set(); const w = (o, p) => { if (Array.isArray(o)) { ps.add(p + ":arr"); o.forEach(x => w(x, p + "[]")); } else if (o && typeof o === "object") { for (const k in o) w(o[k], p + "." + k); } else ps.add(p + ":" + typeof o); }; for (const d of m.values()) w(d, ""); return ps.size; };
const J = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
let peak = 0;
const sanity = async (url, o = {}) => {
  const u = new URL(url);
  if (u.pathname.includes("/mutate/")) {
    const body = JSON.parse(o.body); const next = new Map(db);
    for (const m of body.mutations) {
      if (m.createOrReplace) next.set(m.createOrReplace._id, m.createOrReplace);
      else if (m.create) next.set(m.create._id, m.create);
      else if (m.delete) next.delete(m.delete.id);
      else if (m.patch) { const d = next.get(m.patch.id); if (d) next.set(m.patch.id, { ...d, ...(m.patch.set || {}) }); }
    }
    const n = countPaths(next); peak = Math.max(peak, n);
    if (n > LIMIT) return new Response(JSON.stringify({ error: { description: `Total attribute/datatype count ${n} exceeds limit of ${LIMIT}` } }), { status: 400 });
    for (const k of [...db.keys()]) if (!next.has(k)) db.delete(k); for (const [k, v] of next) db.set(k, v);
    return J({ results: body.mutations.map(m => ({ document: m.createOrReplace || m.create || null })) });
  }
  if (u.pathname.includes("/export/")) return new Response([...db.values()].map(d => JSON.stringify(d)).join("\n"));
  let q, params;
  if (o.method === "POST") ({ query: q, params } = JSON.parse(o.body)); else { q = u.searchParams.get("query"); params = {}; for (const [k, v] of u.searchParams) if (k.startsWith("$")) params[k.slice(1)] = JSON.parse(v); }
  const all = [...db.values()];
  let m;
  if (q.startsWith("*[_id == $id][0]")) return J({ result: db.get(params.id) || null });
  if (q.startsWith("*[_id in $ids]")) return J({ result: all.filter(d => params.ids.includes(d._id)) });
  if ((m = q.match(/^(count\()?\*\[_type == \$t(.*?)\]/))) {
    let r = all.filter(d => d._type === params.t);
    for (const c of m[2].matchAll(/&& (\w+) == \$(w\d+)/g)) r = r.filter(d => d[c[1]] === params[c[2]]);
    if (m[1]) return J({ result: r.length });
    if (/order\(_id asc\)/.test(q)) r.sort((a, b) => a._id < b._id ? -1 : 1);
    const lim = q.match(/\[0\.\.\.(\d+)\]/); if (lim) r = r.slice(0, +lim[1]);
    await new Promise(z => setTimeout(z, 5));
    return J({ result: r });
  }
  throw new Error("fake: unsupported query " + q);
};
// исходное состояние: 118 товаров в старом формате + задачи, почти у лимита
const prods = JSON.parse(fs.readFileSync("process.argv[2]"));
const rnd = () => Math.random().toString(16).slice(2, 18);
for (let i = 0; i < 118; i++) db.set("product.u.old" + i, { _id: "product.u.old" + i, _type: "product", brand: "Alo Yoga", title: "Old " + i, status: "draft", overrides: { title: i === 3 ? "Моё название" : undefined }, offers: [{ _key: "o", sourceId: "x", availability: Object.fromEntries([0, 1, 2, 3, 4].map(() => [rnd(), { status: "online", price: 10 }])) }], variants: [] });
db.set("settings.dbv", { _id: "settings.dbv", _type: "settings", v: 2 });
for (let i = 0; i < 50; i++) db.set("item." + i, { _id: "item." + i, _type: "importItem", jobId: "j", offer: { availability: Object.fromEntries([0, 1, 2, 3, 4].map(() => [rnd(), { status: "online", price: 10 }])) } });
for (let i = 0; i < 20; i++) db.set("job." + i, { _id: "job." + i, _type: "importJob", status: "done", attempts: Object.fromEntries([0, 1, 2].map(() => [rnd(), 1])) });
// магазин
const shop = async (url) => { const u = new URL(url);
  if (u.hostname.includes("api.sanity.io")) return sanity(url, arguments[1]);
  if (u.pathname === "/robots.txt") return new Response("User-agent: *\n", { headers: { "content-type": "text/plain" } });
  if (u.pathname === "/meta.json") return J({ name: "Alo Yoga", currency: "EUR" });
  if (/products\.json$/.test(u.pathname)) { const pg = +u.searchParams.get("page") || 1, lim = +u.searchParams.get("limit"); return J({ products: prods.slice((pg - 1) * lim, pg * lim) }); }
  return new Response("nf", { status: 404, headers: { "content-type": "text/html" } }); };
const store = new SanityStore({ projectId: "x", token: "t", fetchImpl: (u, o) => new URL(u).hostname.includes("api.sanity.io") ? sanity(u, o) : shop(u) });
const { id } = await addSupplier(store, { url: "https://shop.example" }, { fetchImpl: shop });
let base = countPaths(db); let pad = 0; while (base < 1995) { db.set("pad" + pad, { _id: "pad" + pad, _type: "pad", ["f" + pad]: 1 }); pad++; base = countPaths(db); }
console.log("start paths", countPaths(db));
const { dbStats } = await import("../lib/catalogload.js"); console.log("stats before", JSON.stringify((await dbStats(store)).byType.slice(0,3)));
let mg, calls = 0; do { mg = await migrateDb(store, { budgetMs: 15 }); calls++; } while (!mg.done && calls < 500); console.log("migrate", mg, "calls", calls, "paths now", countPaths(db));
let page = 1, r, saved = 0; do { r = await loadCatalogPage(store, id, { page, limit: 50, fetchImpl: shop }); if (r.migrating) { console.log("still migrating"); continue; } saved += r.saved; console.log("page", page, r.saved, r.errors[0] || ""); page++; } while (r.more);
console.log("saved", saved, "products", [...db.values()].filter(d => d._type === "product").length, "paths", countPaths(db), "peak", peak);
console.log("override kept:", (await store.get("product.u.old3")).overrides);
