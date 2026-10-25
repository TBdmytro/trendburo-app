/**
 * Перенос Trend Büro в отдельную базу Sanity (старая база общая с OPTIX и переполнена).
 * Берём только своё: типы и id-префиксы Trend Büro. Товары OPTIX (id без «product.»), их фото и служебное — не трогаем.
 * По частям (у сервера 60 с на запрос), с места остановки: курсор хранится в новой базе (settings.migrate).
 */
import { SanityStore } from "./store.js";

export const OUR_TYPES = ["product", "sourceSettings", "settings", "cms", "stats", "lead", "counter", "customer"];
export const OUR_PREFIXES = ["product", "source", "settings", "cms", "stats", "lead", "counter", "customer"];

export function stores(env = process.env) {
  if (!env.SANITY_PROJECT_ID || !env.SANITY_TOKEN) throw new Error("Старая база не настроена");
  if (!env.NEW_SANITY_PROJECT_ID || !env.NEW_SANITY_TOKEN) throw new Error("Новая база не настроена: нужны NEW_SANITY_PROJECT_ID и NEW_SANITY_TOKEN");
  const id = String(env.NEW_SANITY_PROJECT_ID).trim();
  if (!/^[a-z0-9]{6,12}$/.test(id)) throw new Error(`NEW_SANITY_PROJECT_ID не похож на ID проекта Sanity (нужно 8 латинских букв/цифр в нижнем регистре, сейчас длина ${id.length}${/\s/.test(id) ? ", есть пробелы" : ""}${/[A-Z]/.test(id) ? ", есть заглавные" : ""}${/[^a-zA-Z0-9]/.test(id) ? ", есть другие символы" : ""})`);
  return {
    oldS: new SanityStore({ projectId: env.SANITY_PROJECT_ID, dataset: env.SANITY_DATASET || "production", token: env.SANITY_TOKEN }),
    newS: new SanityStore({ projectId: id, dataset: String(env.NEW_SANITY_DATASET || "production").trim(), token: String(env.NEW_SANITY_TOKEN).trim() })
  };
}

// своё — по префиксу id (у OPTIX id без префикса); у товаров ещё и тип product
const OURS = `string::split(_id, ".")[0] in $p && !(_id in path("drafts.**"))`;

export async function migrateStep(oldS, newS, { budgetMs = 40000, batch = 200 } = {}) {
  const st = (await newS.get("settings.migrate")) || { _id: "settings.migrate", _type: "settings", after: "", copied: 0, done: false };
  if (st.done) return { ...st, already: true };
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const docs = await oldS.q(`*[${OURS} && _id > $a] | order(_id asc) [0...${batch}]`, { p: OUR_PREFIXES, a: st.after || "" });
    if (!docs.length) { st.done = true; break; }
    await newS.putMany(docs.filter(d => d._id !== "settings.migrate").map(({ _rev, _createdAt, _updatedAt, ...d }) => d));
    st.after = docs[docs.length - 1]._id; st.copied = (st.copied || 0) + docs.length;
  }
  st.at = new Date().toISOString();
  const { _rev, _createdAt, _updatedAt, ...save } = st;
  await newS.put(save);
  return save;
}

/** Сверка: сколько своих документов каждого типа в старой и новой базе. */
export async function migrateVerify(oldS, newS) {
  const q = `{${OUR_PREFIXES.map(t => `"${t}": count(*[string::split(_id, ".")[0] == "${t}" && _id != "settings.migrate" && !(_id in path("drafts.**"))])`).join(",")}}`;
  const [a, b] = await Promise.all([oldS.q(q), newS.q(q)]);
  const diff = OUR_PREFIXES.filter(t => a[t] !== b[t]);
  return { old: a, new: b, same: diff.length === 0, diff };
}
