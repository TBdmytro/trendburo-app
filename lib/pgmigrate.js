/**
 * Переезд базы: Sanity → Postgres (Neon). Фото остаются в Sanity — переносятся только документы (товары, заказы, клиенты, настройки…).
 * По частям (у функции 60 с), с места остановки: курсор в Postgres (settings.pgmigrate). Повторный прогон безопасен — запись «поверх».
 *  step   — первый проход по всем документам (по _id)
 *  delta  — догнать изменения, сделанные в Sanity после начала переезда (до переключения сайта на Postgres)
 *  verify — сравнить количество документов по типам
 */
const SKIP = `!(_type match "sanity.*") && !(_id in path("drafts.**")) && !(_id in path("_.**")) && _type != "system.group" && _type != "system.retention"`;
const clean = d => { const { _rev, _createdAt, _updatedAt, ...x } = d; return x; };

export async function pgMigrateStep(san, pg, { budgetMs = 40000, batch = 300 } = {}) {
  const st = (await pg.get("settings.pgmigrate")) || { _id: "settings.pgmigrate", _type: "settings", after: "", copied: 0, done: false, startedAt: new Date().toISOString() };
  if (st.done) return { ...st, already: true };
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const docs = await san.q(`*[${SKIP} && _id > $a] | order(_id asc) [0...${batch}]`, { a: st.after || "" });
    if (!docs.length) { st.done = true; st.doneAt = new Date().toISOString(); break; }
    await pg.putMany(docs.filter(d => d._id !== "settings.pgmigrate").map(clean));
    st.after = docs[docs.length - 1]._id; st.copied = (st.copied || 0) + docs.length;
  }
  await pg.put(clean(st));
  return clean(st);
}

/** Изменения в Sanity после начала переезда (since — ISO время). */
export async function pgMigrateDelta(san, pg, since, { batch = 300, budgetMs = 40000 } = {}) {
  let after = "", n = 0; const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const docs = await san.q(`*[${SKIP} && _updatedAt > $s && _id > $a] | order(_id asc) [0...${batch}]`, { s: since, a: after });
    if (!docs.length) return { copied: n, done: true };
    // не затирать то, что уже поменяли в Postgres после переключения сайта
    const have = new Map((await pg.getMany(docs.map(d => d._id))).filter(Boolean).map(d => [d._id, d._updatedAt]));
    const fresh = docs.filter(d => d._id !== "settings.pgmigrate" && !(have.get(d._id) && Date.parse(have.get(d._id)) > Date.parse(d._updatedAt)));
    if (fresh.length) await pg.putMany(fresh.map(clean));
    after = docs[docs.length - 1]._id; n += fresh.length;
  }
  return { copied: n, done: false, after };
}

export async function pgMigrateVerify(san, pg) {
  const types = await san.q(`array::unique(*[${SKIP}]._type)`);
  const out = {};
  for (const t of types || []) {
    const [a, b0] = await Promise.all([san.q(`count(*[${SKIP} && _type == $t])`, { t }), pg.count(t)]);
    const b = t === "settings" && await pg.get("settings.pgmigrate") ? b0 - 1 : b0; // своя служебная запись переезда
    out[t] = { sanity: a, postgres: b, ok: a === b };
  }
  return { ok: Object.values(out).every(x => x.ok), types: out, pg: await pg.stats() };
}
