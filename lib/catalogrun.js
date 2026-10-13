/**
 * Загрузка каталога поставщика на сервере — админку можно закрыть.
 *
 * Кнопка «Загрузить каталог» записывает в настройки поставщика состояние загрузки (load) и запускает шаг.
 * Шаг (≤ 45 с) читает страницы магазина и сразу пишет товары в базу, сохраняет, где остановился,
 * и сам запускает следующий шаг. Админка только показывает состояние из базы.
 *  - Остановить: status = "stopped" — следующий шаг видит это и не продолжает. Загруженное остаётся.
 *  - Обрыв цепочки (сбой сети, перезапуск сервера): админка видит, что состояние давно не менялось,
 *    и запускает шаг заново с того же места («Продолжить»). Повтор страницы безопасен — дублей нет.
 *  - Два шага одновременно не работают: шаг берёт «аренду» (lease) с проверкой ревизии документа.
 */
import { loadCatalogPage, migrateDb, dbReady } from "./catalogload.js";
import { resolveTabs, sortStep } from "./sections.js";

const STEP_MS = Number(process.env.CATALOG_STEP_MS) || 35000;          // запас до 60 с лимита функции
const LEASE_MS = 70000;         // шаг считается живым столько времени
export const STALE_MS = 90000;  // нет движения дольше — цепочка оборвалась, можно продолжить

const nowIso = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 10);

export async function loadState(store, sourceId) {
  const s = await store.get("source." + sourceId);
  return s?.load || null;
}

/** Начать новую загрузку (или продолжить прерванную с того же места). */
export async function startLoad(store, sourceId, { resume = false, mode = "full" } = {}) {
  const s = await store.get("source." + sourceId);
  if (!s) throw new Error("Поставщик не найден");
  // грузим весь каталог; выбранные разделы — это вкладки, по которым товары раскладываются после загрузки
  const handles = ["__all__"];
  const prev = s.load;
  const load = resume && prev && prev.status !== "done"
    ? { ...prev, status: "running", lease: null, updatedAt: nowIso(), note: "" }
    : { runId: rid(), status: "running", mode, handles, hi: mode === "sort" ? handles.length : 0, ...(mode === "sort" ? { loadedAt: nowIso() } : {}), page: 1, saved: 0, found: 0, filtered: 0, skipped: 0, pages: 0, errors: [], prep: null, startedAt: nowIso(), updatedAt: nowIso(), lease: null, note: "" };
  await store.patchMany([s._id], { load });
  return load;
}

export async function stopLoad(store, sourceId) {
  const s = await store.get("source." + sourceId);
  if (!s?.load) return null;
  const load = { ...s.load, status: "stopped", lease: null, updatedAt: nowIso() };
  await store.patchMany([s._id], { load });
  return load;
}

/** Один шаг загрузки. Возвращает { next } — нужно ли запускать следующий шаг. */
export async function runStep(store, sourceId, runId, { fetchImpl = fetch, stepMs = STEP_MS, log = () => {} } = {}) {
  const t0 = Date.now(), left = () => Date.now() - t0 < stepMs;
  const s = await store.get("source." + sourceId);
  let L = s?.load;
  if (!L || L.runId !== runId || L.status !== "running") return { next: false, why: "not running" };
  if (L.lease && Date.parse(L.lease.until) > Date.now()) return { next: false, why: "busy" };
  // аренда: если кто-то успел раньше — ревизия не совпадёт и мы выходим
  const me = rid();
  const taken = await store.putIfRev({ ...s, load: { ...L, lease: { by: me, until: new Date(Date.now() + LEASE_MS).toISOString() } } }, s._rev);
  if (!taken) return { next: false, why: "race" };

  // сохранить прогресс, не затирая «Остановить», нажатое во время шага
  const save = async (patch, final = false) => {
    const cur = (await store.get(s._id))?.load || L;
    if (cur.runId !== runId) return false;
    const stopped = cur.status === "stopped";
    L = { ...L, ...patch, status: stopped ? "stopped" : (patch.status || L.status), lease: final || stopped ? null : L.lease, updatedAt: nowIso() };
    await store.patchMany([s._id], { load: L });
    return !stopped;
  };

  try {
    const budget = () => Math.max(3000, stepMs - (Date.now() - t0) - 3000);
    do {
      // 1) старые словари ещё в базе — сначала освобождаем место (иначе база не примет новые товары)
      if (!(await dbReady(store))) {
        const mig = await migrateDb(store, { budgetMs: budget() });
        log({ prep: mig }); if (!(await save({ prep: mig }))) return { next: false };
        continue;
      }
      // 2) товары магазина — страница за страницей
      if (L.hi < L.handles.length) {
        if (L.prep) L.prep = null;
        const handle = L.handles[L.hi];
        const r = await loadCatalogPage(store, sourceId, { handle, page: L.page, limit: 50, fetchImpl });
        const errors = [...(r.errors || []), ...(L.errors || [])].slice(0, 5);
        const pos = r.more ? { page: L.page + 1 } : { hi: L.hi + 1, page: 1 };
        log({ handle, page: L.page, found: r.found, saved: r.saved, more: r.more, errors: r.errors?.slice(0, 1) });
        const go = await save({ ...pos, saved: L.saved + r.saved, found: L.found + r.found, filtered: L.filtered + r.filtered, skipped: L.skipped + r.skipped, pages: L.pages + 1, errors, lastError: r.errors?.[0] || "", fails: 0, ...(pos.hi >= L.handles.length ? { loadedAt: nowIso() } : {}) });
        if (!go) return { next: false };
        continue;
      }
      // 3) раскладка по разделам магазина (вкладки «Бестселлеры», «Женское»…), в порядке как у бренда
      if (!L.sortedAt) {
        let st = L.sort;
        if (!st) { const tabs = await resolveTabs(store, sourceId, { fetchImpl }); st = { tabs, ti: 0, tpage: 1, reset: false }; await store.patchMany([s._id], { tabs }); }
        st = await sortStep(store, sourceId, st, { fetchImpl, left });
        log({ sort: { tabs: st.tabs.length, ti: st.ti, tpage: st.tpage, done: !!st.done } });
        if (!(await save({ sort: { ...st, done: undefined }, ...(st.done ? { sortedAt: nowIso() } : {}) }))) return { next: false };
        continue;
      }
      // 4) товары загружены; в фоне доделываем перевод старых товаров (наличие по размерам) и закрываем загрузку
      const mig = await migrateDb(store, { budgetMs: budget() });
      if (mig.done) { await save({ status: "done", finishedAt: nowIso(), prep: null }, true); return { next: false, done: true }; }
      log({ finish: mig }); if (!(await save({ prep: null }))) return { next: false };
    } while (left());
    await save({ lease: null }, true);
    return { next: true };
  } catch (e) {
    // шаг упал (сеть, магазин, база) — фиксируем и пробуем снова со следующего шага, но не бесконечно
    const fails = (L.fails || 0) + 1;
    log({ fail: e.message, fails });
    await save({ fails, lastError: e.message.slice(0, 300), ...(fails >= 6 ? { status: "failed" } : {}) }, true);
    return { next: fails < 6 };
  }
}

/** Запустить шаг на сервере (запрос самому себе); ждём только отправку. */
export async function kickCatalog(base, sourceId, runId, n = 1) {
  if (!process.env.CRON_SECRET || !base || n > 600) return false;
  try {
    await fetch(`${base}/api/cron?catalog=${encodeURIComponent(sourceId)}&run=${encodeURIComponent(runId)}&n=${n}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(2500) });
  } catch { /* таймаут ожидания — нормально: шаг уже идёт */ }
  return true;
}
