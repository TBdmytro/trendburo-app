/**
 * Хранилище документов. Две реализации с одинаковым интерфейсом:
 *  - SanityStore: рабочая база (HTTP API Sanity, токен только на сервере)
 *  - MemoryStore: тесты и явно обозначенный демо-режим (данные не сохраняются между запусками)
 */

export class MemoryStore {
  constructor() { this.docs = new Map(); this.rev = 0; this.kind = "memory"; }
  async get(id) { const d = this.docs.get(id); return d ? structuredClone(d) : null; }
  async getMany(ids) { return Promise.all(ids.map(i => this.get(i))).then(a => a.filter(Boolean)); }
  async put(doc) { const d = { ...structuredClone(doc), _rev: "r" + (++this.rev), _updatedAt: new Date().toISOString() }; this.docs.set(d._id, d); return structuredClone(d); }
  /** Запись только если ревизия не изменилась (для блокировок). */
  async putIfRev(doc, rev) { const cur = this.docs.get(doc._id); if (cur && cur._rev !== rev) return null; return this.put(doc); }
  async del(id) { this.docs.delete(id); }
  async delMany(ids) { ids.forEach(id => this.docs.delete(id)); }
  async patchMany(ids, set) { for (const id of ids) { const d = this.docs.get(id); if (d) this.docs.set(id, { ...d, ...structuredClone(set) }); } }
  async list(type, where = {}, { limit = 10000, order } = {}) {
    let out = [...this.docs.values()].filter(d => d._type === type && Object.entries(where).every(([k, v]) => Array.isArray(v) ? v.includes(d[k]) : v === null ? d[k] === undefined || d[k] === null : d[k] === v));
    if (order) { const [f, dir] = order.split(" "); out.sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir === "desc" ? -1 : 1)); }
    return out.slice(0, limit).map(d => structuredClone(d));
  }
  async count(type, where = {}) { return (await this.list(type, where)).length; }
  async uploadImage(buf, { filename, contentType }) {
    const id = "image-mem-" + (++this.rev);
    this.docs.set(id, { _id: id, _type: "sanity.imageAsset", size: buf.length, mimeType: contentType, originalFilename: filename });
    return { assetId: id, url: "https://cdn.sanity.io/images/memory/test/" + id + ".jpg" };
  }
}

export class SanityStore {
  constructor({ projectId, dataset = "production", token, apiVersion = "2023-10-01", fetchImpl = fetch }) {
    if (!projectId || !token) throw new Error("Sanity не настроена: нужны SANITY_PROJECT_ID и SANITY_TOKEN");
    this.base = `https://${projectId}.api.sanity.io/v${apiVersion}/data`;
    this.dataset = dataset; this.token = token; this.f = fetchImpl; this.kind = "sanity";
  }
  async q(query, params = {}) {
    const u = new URL(`${this.base}/query/${this.dataset}`);
    u.searchParams.set("query", query);
    for (const [k, v] of Object.entries(params)) u.searchParams.set("$" + k, JSON.stringify(v));
    const opts = { headers: { Authorization: `Bearer ${this.token}` } };
    let r;
    if (u.href.length > 8000) r = await this.f(`${this.base}/query/${this.dataset}`, { method: "POST", headers: { ...opts.headers, "Content-Type": "application/json" }, body: JSON.stringify({ query, params }) });
    else r = await this.f(u, opts);
    if (!r.ok) throw new Error(`Sanity query ${r.status}`);
    return (await r.json()).result;
  }
  async mutate(mutations, { returnDocuments = false } = {}) {
    const r = await this.f(`${this.base}/mutate/${this.dataset}?returnDocuments=${returnDocuments}&visibility=sync`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ mutations })
    });
    if (r.status === 409) return null; // конфликт ревизии
    if (!r.ok) throw new Error(`Sanity mutate ${r.status}`);
    return r.json();
  }
  async get(id) { return this.q(`*[_id == $id][0]`, { id }); }
  async getMany(ids) { return ids.length ? this.q(`*[_id in $ids]`, { ids }) : []; }
  async put(doc) { const r = await this.mutate([{ createOrReplace: doc }], { returnDocuments: true }); return r.results[0].document; }
  async putIfRev(doc, rev) {
    if (!rev) { const r = await this.mutate([{ create: doc }], { returnDocuments: true }).catch(() => null); return r ? r.results[0].document : null; }
    const { _id, _rev, _createdAt, _updatedAt, ...rest } = doc;
    const r = await this.mutate([{ patch: { id: _id, ifRevisionID: rev, set: rest } }], { returnDocuments: true });
    return r ? r.results[0].document : null;
  }
  async del(id) { await this.mutate([{ delete: { id } }]); }
  /** Удаление пачкой: по 200 документов за одну транзакцию. */
  async delMany(ids) { for (let i = 0; i < ids.length; i += 200) await this.mutate(ids.slice(i, i + 200).map(id => ({ delete: { id } }))); }
  /** Точечные правки полей пачкой (без чтения документов). */
  async patchMany(ids, set) { for (let i = 0; i < ids.length; i += 200) await this.mutate(ids.slice(i, i + 200).map(id => ({ patch: { id, set } }))); }
  async list(type, where = {}, { limit = 10000, order, fields } = {}) {
    const conds = Object.keys(where).map((k, i) => Array.isArray(where[k]) ? `${k} in $w${i}` : where[k] === null ? `!defined(${k})` : `${k} == $w${i}`);
    const params = { t: type }; Object.values(where).forEach((v, i) => { if (v !== null) params["w" + i] = v; });
    const ord = order ? ` | order(${order})` : "";
    // fields — проекция GROQ: тянем только нужные поля (быстрее и легче для больших каталогов)
    const proj = fields ? `{${fields}}` : "";
    return this.q(`*[_type == $t${conds.map(c => " && " + c).join("")}]${ord}[0...${limit}]${proj}`, params);
  }
  /** Загрузка фото в хранилище Sanity (дедупликация по содержимому делается самой Sanity). */
  async uploadImage(buf, { filename, contentType }) {
    const base = this.base.replace(/\/data$/, "");
    const r = await this.f(`${base}/assets/images/${this.dataset}?filename=${encodeURIComponent(filename)}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": contentType }, body: buf
    });
    if (!r.ok) throw new Error(`загрузка фото ${r.status}`);
    const d = (await r.json()).document;
    return { assetId: d._id, url: d.url, width: d.metadata?.dimensions?.width, height: d.metadata?.dimensions?.height };
  }
  async count(type, where = {}) {
    const conds = Object.keys(where).map((k, i) => Array.isArray(where[k]) ? ` && ${k} in $w${i}` : where[k] === null ? ` && !defined(${k})` : ` && ${k} == $w${i}`).join("");
    const params = { t: type }; Object.values(where).forEach((v, i) => { if (v !== null) params["w" + i] = v; });
    return this.q(`count(*[_type == $t${conds}])`, params);
  }
}

let _store = null;
/** Хранилище по переменным окружения. Без базы — только явно включённый DEMO_MODE. */
export function getStore(env = process.env) {
  if (_store) return _store;
  if (env.SANITY_PROJECT_ID && env.SANITY_TOKEN) _store = new SanityStore({ projectId: env.SANITY_PROJECT_ID, dataset: env.SANITY_DATASET || "production", token: env.SANITY_TOKEN });
  else if (env.DEMO_MODE === "1") { _store = new MemoryStore(); _store.demo = true; }
  else throw new Error("База не настроена: задайте SANITY_PROJECT_ID и SANITY_TOKEN в переменных окружения");
  return _store;
}
export function setStore(s) { _store = s; }
