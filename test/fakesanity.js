/**
 * Имитация HTTP API Sanity для проверок (только тесты): документы в памяти, подмножество GROQ, которое использует store.js,
 * ревизии (ifRevisionID → 409), лимит разных названий полей (как в настоящей базе → 400), задержка сети, экспорт.
 */
export function fakeSanity({ limit = 2000, latencyMs = 0 } = {}) {
  const db = new Map(); let rev = 0; const stats = { mutations: 0, queries: 0, peak: 0, rejected: 0 };
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const countPaths = m => { const ps = new Set(); const w = (o, p) => { if (Array.isArray(o)) { ps.add(p + ":arr"); o.forEach(x => w(x, p + "[]")); } else if (o && typeof o === "object") { for (const k in o) w(o[k], p + "." + k); } else ps.add(p + ":" + (o === null ? "null" : typeof o)); }; for (const d of m.values()) w(d, ""); return ps.size; };
  const sleep = () => latencyMs ? new Promise(r => setTimeout(r, latencyMs)) : null;
  const evalCond = (d, cond, params) => {
    let m;
    if ((m = cond.match(/^!defined\((\w+)\)$/))) return d[m[1]] === undefined || d[m[1]] === null;
    if ((m = cond.match(/^(\w+) == \$(\w+)$/))) return d[m[1]] === params[m[2]];
    if ((m = cond.match(/^(\w+) in \$(\w+)$/))) return params[m[2]].includes(d[m[1]]);
    throw new Error("fakeSanity: условие не поддерживается: " + cond);
  };
  const fetchImpl = async (url, o = {}) => {
    await sleep();
    const u = new URL(url);
    if (u.pathname.includes("/mutate/")) {
      stats.mutations++;
      const body = JSON.parse(o.body); const next = new Map(db); const out = [];
      for (const m of body.mutations) {
        const stamp = d => ({ ...d, _rev: "r" + (++rev), _updatedAt: new Date().toISOString() });
        if (m.createOrReplace) next.set(m.createOrReplace._id, stamp(m.createOrReplace));
        else if (m.create) { if (next.has(m.create._id)) return J({ error: { description: "exists" } }, 409); next.set(m.create._id, stamp(m.create)); }
        else if (m.delete) next.delete(m.delete.id);
        else if (m.patch) {
          const d = next.get(m.patch.id); if (!d) continue;
          if (m.patch.ifRevisionID && d._rev !== m.patch.ifRevisionID) return J({ error: { description: "revision mismatch" } }, 409);
          next.set(m.patch.id, stamp({ ...d, ...(m.patch.set || {}) }));
        }
        const id = m.createOrReplace?._id || m.create?._id || m.patch?.id; if (id) out.push({ id, document: next.get(id) });
      }
      const n = countPaths(next); stats.peak = Math.max(stats.peak, n);
      if (n > limit) { stats.rejected++; return J({ error: { description: `Total attribute/datatype count ${n} exceeds limit of ${limit}` } }, 400); }
      for (const k of [...db.keys()]) if (!next.has(k)) db.delete(k);
      for (const [k, v] of next) db.set(k, v);
      return J({ results: out });
    }
    if (u.pathname.includes("/export/")) return new Response([...db.values()].map(d => JSON.stringify(d)).join("\n"));
    stats.queries++;
    let q, params = {};
    if (o.method === "POST") ({ query: q, params } = JSON.parse(o.body));
    else { q = u.searchParams.get("query"); for (const [k, v] of u.searchParams) if (k.startsWith("$")) params[k.slice(1)] = JSON.parse(v); }
    const all = [...db.values()];
    if (q === "*[_id == $id][0]") return J({ result: db.get(params.id) || null });
    if (q === "*[_id in $ids]") return J({ result: all.filter(d => params.ids.includes(d._id)) });
    const m = q.match(/^(count\()?\*\[_type == \$t((?: && [^\]]+?)*)\](?: \| order\((\w+) (asc|desc)\))?(?:\[0\.\.\.(\d+)\])?/);
    if (!m) throw new Error("fakeSanity: запрос не поддерживается: " + q);
    let r = all.filter(d => d._type === params.t);
    for (const c of (m[2] || "").split(" && ").map(x => x.trim()).filter(Boolean)) r = r.filter(d => evalCond(d, c, params));
    if (m[1]) return J({ result: r.length });
    if (m[3]) { const f = m[3], dir = m[4] === "desc" ? -1 : 1; r.sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * dir); }
    if (m[5]) r = r.slice(0, +m[5]);
    return J({ result: r });
  };
  return { db, stats, fetchImpl, countPaths: () => countPaths(db) };
}
