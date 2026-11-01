/**
 * PgStore — товары, заказы, клиенты и настройки в Postgres (Neon). Тот же интерфейс, что у SanityStore/MemoryStore.
 * Зачем: у бесплатной Sanity потолок 10 000 документов, а каталогу нужно 100 000+.
 * Фото по-прежнему загружаются в Sanity (images — отдельный SanityStore), сюда пишутся только ссылки.
 *
 * Одна таблица docs: id, type, data (jsonb — сам документ), rev, created_at, updated_at.
 * Проекции полей (fields) — те же строки, что для Sanity (GROQ), переводятся в SQL: тянем только нужное.
 * exec(text, params) → rows — подключение (Neon по HTTP или PGlite в тестах).
 */

export const SCHEMA = [
  `create table if not exists docs (id text primary key, type text not null, data jsonb not null, rev bigint not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
  `create index if not exists docs_type on docs(type)`,
  `create index if not exists docs_type_status on docs(type, (data->>'status'))`,
  `create index if not exists docs_type_created on docs(type, (data->>'createdAt'))`,
  `create index if not exists docs_lead_tg on docs((data->'tgId')) where type = 'lead'`
];

const META = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt"]);
const strip = d => { const o = {}; for (const k in d) if (!META.has(k)) o[k] = d[k]; return o; };
const qid = k => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error("Недопустимое поле: " + k); return k; };

/** Делим строку полей по запятым верхнего уровня. */
function splitTop(s) {
  const out = []; let depth = 0, q = false, cur = "";
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q) { if ("{[(".includes(ch)) depth++; else if ("}])".includes(ch)) depth--; else if (ch === "," && !depth) { out.push(cur.trim()); cur = ""; continue; } }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Путь вида a[0].b.c → SQL выражение от src. */
function pathExpr(path, src) {
  let e = src; const re = /([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\./g; let m;
  while ((m = re.exec(path))) { if (m[1]) e = `(${e})->'${qid(m[1])}'`; else if (m[2] !== undefined) e = `(${e})->${Number(m[2])}`; }
  return e;
}

let uid = 0;
/** Проекция GROQ ({a, b[0...1]{url}, "n": count(c), "x": a[0].b, ...}) → SQL выражение jsonb. */
export function compileProj(fields, src = "d") {
  const pairs = []; let spread = false;
  for (const ent of splitTop(fields)) {
    if (ent === "...") { spread = true; continue; }
    let m = ent.match(/^"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(.+)$/s);
    if (m) {
      const [, alias, ex] = m; let v;
      if (ex.trim() === "null") v = `'null'::jsonb`;
      else if ((m = ex.trim().match(/^count\((.+)\)$/))) { const p = pathExpr(m[1], src); v = `(case when jsonb_typeof(${p}) = 'array' then to_jsonb(jsonb_array_length(${p})) end)`; }
      else v = pathExpr(ex.trim(), src);
      pairs.push([alias, v]); continue;
    }
    m = ent.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\{.*\})?$/s);
    if (!m) throw new Error("Не понимаю поле: " + ent);
    const [, name, slice, sub] = m; const base = `(${src})->'${qid(name)}'`;
    let v;
    if (!slice) v = sub ? `(case when jsonb_typeof(${base}) = 'object' then ${compileProj(sub.slice(1, -1), base)} end)` : base;
    else {
      const inner = slice.slice(1, -1).trim();
      if (/^\d+$/.test(inner)) { const el = `(${base})->${Number(inner)}`; v = sub ? `(case when jsonb_typeof(${el}) = 'object' then ${compileProj(sub.slice(1, -1), el)} end)` : el; }
      else {
        const e = "e" + (++uid), i = "i" + uid; let cond = "true";
        const r = inner.match(/^(\d+)\s*(\.\.\.?)\s*(\d+)$/);
        if (r) { const a = Number(r[1]), b = Number(r[3]) + (r[2] === ".." ? 1 : 0); cond = `${i} > ${a} and ${i} <= ${b}`; }
        else if (inner !== "") throw new Error("Не понимаю срез: " + slice);
        const item = sub ? `(case when jsonb_typeof(${e}) = 'object' then ${compileProj(sub.slice(1, -1), e)} else ${e} end)` : e;
        v = `(case when jsonb_typeof(${base}) = 'array' then coalesce((select jsonb_agg(${item} order by ${i}) from jsonb_array_elements(${base}) with ordinality as t${uid}(${e}, ${i}) where ${cond}), '[]'::jsonb) end)`;
      }
    }
    pairs.push([name, v]);
  }
  // jsonb_build_object принимает до 100 аргументов — собираем частями
  const parts = [];
  for (let k = 0; k < pairs.length; k += 40) parts.push(`jsonb_build_object(${pairs.slice(k, k + 40).map(([a, v]) => `'${a}', ${v}`).join(", ")})`);
  const obj = parts.length ? parts.join(" || ") : `'{}'::jsonb`;
  // поля, которых нет, не возвращаем (как MemoryStore: undefined), но явный "x": null оставляем
  const nulls = pairs.filter(([, v]) => v === `'null'::jsonb`).map(([a]) => a);
  const stripped = `jsonb_strip_nulls(${obj})` + (nulls.length ? ` || jsonb_build_object(${nulls.map(a => `'${a}', 'null'::jsonb`).join(", ")})` : "");
  return spread ? `((${src}) || ${stripped})` : stripped;
}

const DOC = `(data || jsonb_build_object('_id', id, '_type', type, '_rev', 'r' || rev, '_createdAt', to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '_updatedAt', to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`;
const parseJ = v => typeof v === "string" ? JSON.parse(v) : v;

export class PgStore {
  /** exec(text, params) → массив строк; images — хранилище фото (SanityStore) */
  constructor({ exec, images = null }) { this.x = exec; this.images = images; this.kind = "postgres"; this.ready = null; }
  async init() { if (!this.ready) this.ready = (async () => { for (const s of SCHEMA) await this.x(s, []); })().catch(e => { this.ready = null; throw e; }); return this.ready; }
  async rows(text, params = []) { await this.init(); return this.x(text, params); }

  where(type, where = {}, params) {
    const conds = ["type = $" + params.push(type)];
    for (const [k, v] of Object.entries(where)) {
      if (k === "_id") { conds.push(Array.isArray(v) ? `id = any($${params.push(v.map(String))}::text[])` : `id = $${params.push(String(v))}`); continue; }
      const f = `data->'${qid(k)}'`;
      if (v === null) conds.push(`(${f} is null or ${f} = 'null'::jsonb)`);
      else if (Array.isArray(v)) conds.push(`${f} = any($${params.push(v.map(x => JSON.stringify(x)))}::text[]::jsonb[])`);
      else conds.push(`${f} = $${params.push(JSON.stringify(v))}::jsonb`);
    }
    return conds.join(" and ");
  }

  async get(id) { const r = await this.rows(`select ${DOC} as d from docs where id = $1`, [id]); return r[0] ? parseJ(r[0].d) : null; }
  async getMany(ids) { if (!ids.length) return []; const r = await this.rows(`select ${DOC} as d from docs where id = any($1::text[])`, [ids]); return r.map(x => parseJ(x.d)); }

  async put(doc) {
    if (!doc?._id) throw new Error("Нет _id");
    const r = await this.rows(`insert into docs(id, type, data) values ($1, coalesce($2, (select type from docs where id = $1), 'doc'), $3::jsonb)
      on conflict (id) do update set type = excluded.type, data = excluded.data, rev = docs.rev + 1, updated_at = now() returning ${DOC} as d`, [doc._id, doc._type || null, JSON.stringify(strip(doc))]);
    return parseJ(r[0].d);
  }
  /** Запись только если ревизия не изменилась (блокировки). Без ревизии — только создание. */
  async putIfRev(doc, rev) {
    if (!rev) { const r = await this.rows(`insert into docs(id, type, data) values ($1, $2, $3::jsonb) on conflict (id) do nothing returning ${DOC} as d`, [doc._id, doc._type, JSON.stringify(strip(doc))]); return r[0] ? parseJ(r[0].d) : null; }
    const n = Number(String(rev).replace(/^r/, "")); if (!Number.isFinite(n)) return null;
    const r = await this.rows(`update docs set data = data || $2::jsonb, rev = rev + 1, updated_at = now() where id = $1 and rev = $3 returning ${DOC} as d`, [doc._id, JSON.stringify(strip(doc)), n]);
    return r[0] ? parseJ(r[0].d) : null;
  }
  async putMany(docs) {
    for (let i = 0; i < docs.length; i += 200) {
      const chunk = docs.slice(i, i + 200).map(d => ({ id: d._id, type: d._type, data: strip(d) }));
      await this.rows(`insert into docs(id, type, data) select x->>'id', x->>'type', x->'data' from jsonb_array_elements($1::jsonb) x
        on conflict (id) do update set type = excluded.type, data = excluded.data, rev = docs.rev + 1, updated_at = now()`, [JSON.stringify(chunk)]);
    }
  }
  async del(id) { await this.rows(`delete from docs where id = $1`, [id]); }
  async delMany(ids) { for (let i = 0; i < ids.length; i += 1000) await this.rows(`delete from docs where id = any($1::text[])`, [ids.slice(i, i + 1000)]); }
  async patchMany(ids, set) { for (let i = 0; i < ids.length; i += 1000) await this.rows(`update docs set data = data || $2::jsonb, rev = rev + 1, updated_at = now() where id = any($1::text[])`, [ids.slice(i, i + 1000), JSON.stringify(strip(set))]); }
  async patchEach(items) {
    for (let i = 0; i < items.length; i += 300) {
      const chunk = items.slice(i, i + 300).map(({ id, set }) => ({ id, set: strip(set) }));
      await this.rows(`update docs set data = docs.data || x.set, rev = docs.rev + 1, updated_at = now() from (select e->>'id' as id, e->'set' as set from jsonb_array_elements($1::jsonb) e) x where docs.id = x.id`, [JSON.stringify(chunk)]);
    }
  }
  async list(type, where = {}, { limit = 10000, order, fields } = {}) {
    const params = []; const cond = this.where(type, where, params);
    let ord = "";
    if (order) {
      const [f, dir = "asc"] = order.trim().split(/\s+/); const d = /desc/i.test(dir) ? "desc" : "asc";
      ord = f === "_id" ? ` order by id ${d}` : f === "_updatedAt" ? ` order by updated_at ${d}` : f === "_createdAt" ? ` order by created_at ${d}` : ` order by data->'${qid(f)}' ${d} nulls last`;
    }
    const proj = fields ? compileProj(fields, "d") : "d";
    const r = await this.rows(`select ${proj} as p from (select ${DOC} as d, id, data, created_at, updated_at from docs where ${cond}${ord} limit ${Math.max(1, Math.min(200000, Number(limit) || 10000))}) s`, params);
    return r.map(x => parseJ(x.p));
  }
  async count(type, where = {}) { const params = []; const r = await this.rows(`select count(*)::int as n from docs where ${this.where(type, where, params)}`, params); return Number(r[0].n); }
  async exportAll() { const r = await this.rows(`select ${DOC} as d from docs`); return r.map(x => parseJ(x.d)); }
  async uploadImage(buf, opts) { if (!this.images) throw new Error("Хранилище фото не настроено"); return this.images.uploadImage(buf, opts); }
  /** Сколько документов каждого типа (для проверок и админки). */
  async stats() { const r = await this.rows(`select type, count(*)::int as n from docs group by type order by n desc`); return Object.fromEntries(r.map(x => [x.type, Number(x.n)])); }
}

/** Подключение к Neon по HTTP (без постоянного соединения — подходит для функций Vercel); драйвер грузится при первом запросе. */
export function lazyNeon(url) {
  let sql = null;
  return async (text, params) => { if (!sql) { const { neon } = await import("@neondatabase/serverless"); sql = neon(url); } return sql.query(text, params); };
}
