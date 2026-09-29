/**
 * Дубли, выбор основного предложения и наличие.
 */

const norm = s => (s ? String(s).toLowerCase().replace(/[\s._-]+/g, "") : null);

/**
 * Ищет существующий товар для нормализованной модели.
 * Объединяем только по точным идентификаторам: бренд + артикул модели, GTIN, артикул варианта.
 * Похожее название → «возможный дубль» без объединения.
 * @returns {{status:"new"|"update"|"possible-duplicate", matchId?:string, by?:string}}
 */
export function findMatch(norm1, existing) {
  const { model, variants } = norm1;
  const brand = norm(model.brand);
  for (const p of existing) {
    if (p.overrides && p.overrides.rejectMerge && p.overrides.rejectMerge.includes(model._id)) continue;
    const pb = norm(p.brand);
    if (brand && pb === brand && model.modelSku && norm(p.modelSku) === norm(model.modelSku)) return { status: "update", matchId: p._id, by: "артикул модели" };
    const pg = [p.gtin, ...(p.variants || []).map(v => v.gtin)].filter(Boolean).map(norm);
    const mg = [model.gtin, ...variants.map(v => v.gtin)].filter(Boolean).map(norm);
    if (mg.some(g => pg.includes(g))) return { status: "update", matchId: p._id, by: "GTIN/EAN" };
    const ps = (p.variants || []).map(v => v.sku).filter(Boolean).map(norm);
    const ms = variants.map(v => v.sku).filter(Boolean).map(norm);
    if (brand && pb === brand && ms.some(s => ps.includes(s))) return { status: "update", matchId: p._id, by: "артикул варианта" };
  }
  const t = norm(model.title);
  const similar = existing.find(p => norm(p.brand) === brand && t && norm(p.title || p.sourceTitle) === t);
  if (similar) return { status: "possible-duplicate", matchId: similar._id, by: "совпадает только название — не объединяем автоматически" };
  return { status: "new" };
}

export const LEAD_LIMIT = 14;

/** Максимальный срок поставщика до нас: число или диапазон "10-20". Неизвестно → null. */
export function leadMax(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const m = String(v).match(/(\d+)\s*(?:[-–]\s*(\d+))?/);
  if (!m) return null;
  return Number(m[2] || m[1]);
}

/**
 * Выбор основного предложения для конкретного варианта.
 * offers: [{_key, sourceKind, final (цена витрины), supplierLeadDays, variantMatch:boolean, blocked}]
 * strategy: "manual" (по умолчанию — конфликт показывается администратору), "cheaper", "faster"
 */
export function chooseOffer(offers, { strategy = "manual", leadLimit = LEAD_LIMIT } = {}) {
  const explain = [];
  const suppliers = offers.filter(o => o.sourceKind === "eyewear-supplier");
  const eligible = suppliers.filter(o => {
    const lm = leadMax(o.supplierLeadDays);
    if (!o.variantMatch) { explain.push(`${o._key}: не совпадает цвет/размер`); return false; }
    if (lm === null) { explain.push(`${o._key}: срок поставки неизвестен — не подходит автоматически`); return false; }
    if (lm > leadLimit) { explain.push(`${o._key}: срок до ${lm} дн. больше ${leadLimit}`); return false; }
    if (o.blocked || !(o.final > 0)) { explain.push(`${o._key}: цена не прошла проверку`); return false; }
    return true;
  });
  if (eligible.length) {
    if (eligible.length === 1) return { primary: eligible[0]._key, conflict: false, explain: [...explain, "Единственное подходящее предложение поставщика (приоритет перед официальным)"] };
    const sorted = [...eligible].sort((a, b) => a.final - b.final);
    const cheapest = sorted[0];
    const fastest = [...eligible].sort((a, b) => leadMax(a.supplierLeadDays) - leadMax(b.supplierLeadDays))[0];
    if (cheapest._key === fastest._key || leadMax(cheapest.supplierLeadDays) === leadMax(fastest.supplierLeadDays)) {
      return { primary: cheapest._key, conflict: false, explain: [...explain, "Дешевле и не медленнее остальных"] };
    }
    if (strategy === "cheaper") return { primary: cheapest._key, conflict: true, explain: [...explain, "Конфликт цена/срок, стратегия «дешевле»"] };
    if (strategy === "faster") return { primary: fastest._key, conflict: true, explain: [...explain, "Конфликт цена/срок, стратегия «быстрее»"] };
    return { primary: null, conflict: true, candidates: [cheapest._key, fastest._key], explain: [...explain, "Одно дешевле, другое быстрее — нужен выбор администратора"] };
  }
  const official = offers.filter(o => o.sourceKind !== "eyewear-supplier" && o.final > 0 && !o.blocked).sort((a, b) => a.final - b.final)[0];
  if (official) return { primary: official._key, conflict: false, explain: [...explain, "Подходящего поставщика нет — официальный источник"] };
  return { primary: null, conflict: false, explain: [...explain, "Нет предложения с корректной ценой"] };
}

export const AVAIL_LABEL = { online: "Можно заказать онлайн", boutique: "Только в бутике", out: "Нет в наличии", preorder: "Предзаказ", unknown: "Наличие не подтверждено" };
export const STALE_HOURS = 48;

/** Статус для витрины с учётом устаревания. Отсутствие кнопки покупки само по себе не значит «нет». */
export function effectiveAvailability(status, checkedAt, now = Date.now(), staleHours = STALE_HOURS) {
  if (!checkedAt) return "unknown";
  if (now - Date.parse(checkedAt) > staleHours * 3600e3) return "unknown";
  return status || "unknown";
}

/**
 * Слияние результата новой синхронизации с сохранённым предложением.
 * Ошибка загрузки не обнуляет цену и не переводит в «нет в наличии».
 */
export function mergeOffer(prev, next, error) {
  if (error) {
    if (!prev) return null;
    return { ...prev, errors: [...(prev.errors || []).slice(-4), { at: new Date().toISOString(), text: String(error.message || error) }] };
  }
  if (!prev) return next;
  const merged = { ...prev, ...next, errors: [] };
  if (next.boutique === null && prev.boutique) merged.boutique = prev.boutique;
  merged.availability = { ...(prev.availability || {}) };
  for (const [k, v] of Object.entries(next.availability || {})) merged.availability[k] = v.status === "unknown" && prev.availability?.[k] ? { ...prev.availability[k], stale: true } : v;
  return merged;
}
