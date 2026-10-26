/**
 * Модуль расчёта цен витрины. Чистые функции, без сети и базы.
 *
 * Правила (настраиваются через PRICING_DEFAULTS или документ settings.pricing в базе):
 *  А. Официальные сайты брендов и магазины: цена витрины = цена бутика + max(markup[направление] × цена, минимум категории).
 *     Украина: +10%, доставка в Украину уже внутри. Европа и Дубай: +8%, доставка отдельно.
 *     Минимальная комиссия за единицу: обувь +40 €, всё остальное +15 € (если процент меньше).
 *     Итог округляется до 5 € ВВЕРХ — наценка никогда не меньше правила (338 € → 371,8 → 375 €).
 *  Б. Очки поставщиков (Optica Bassol, OpticalH) с большой скидкой (≥ порога, по умолчанию 20%):
 *     цена бутика ≤ 400 € → (цена бутика + 40 €) × 0,75
 *     цена бутика > 400 € → (цена бутика + round5(10% цены бутика)) × 0,75
 *  В. Очки этих поставщиков с маленькой скидкой: цена бутика × 1,10 × 0,93.
 *  Магазины (Sporty & Rich, Alo …): доставка от магазина +10 €, если цена вещи меньше 400 € (от 400 € магазин везёт бесплатно). Обувь — без доставки (минимум 40 €).
 *     Футболка 100 € → 100 + 25 (минимум за одежду в магазинах) + 10 = 135 €.
 *     Добавляется после наценки, до округления: худи 270 € → 297 + 10 = 307 → 310 €.
 *
 * Округление итоговой цены — до 5 €. Направление настраивается:
 *  "nearest" (по умолчанию, ПРЕДПОЛОЖЕНИЕ: ближайшие 5 €, ровно посередине — вверх), "up", "down".
 */

export const PRICING_DEFAULTS = Object.freeze({
  rounding: "nearest",            // nearest | up | down
  step: 5,
  // minAdd — минимальная комиссия за единицу по категории, €: наценка = max(процент, минимум)
  // default — минимум для всех категорий, кроме перечисленных
  // retailerMarkup — магазины-поставщики (Alo Yoga и др.): +10% во все регионы
  // доставка от магазина до нас: +add €, если цена вещи в магазине меньше freeFrom €
  shipping: { add: 10, freeFrom: 400, skip: ["shoes"] },
  // единое правило для всех товаров (сайты брендов, магазины, кнопка «В Trend Büro», добавленные вручную; кроме очков поставщиков):
  // цена = цена бутика + max(markup × цена, минимум категории), вверх до 5 €, одна цена во все регионы. Включается в «Правилах цен»
  unified: { on: false, markup: 0.10, minAdd: { shoes: 40, clothing: 15, default: 15 } },
  official: { markup: { ua: 0.10, eu: 0.08, dxb: 0.08 }, retailerMarkup: { ua: 0.10, eu: 0.10, dxb: 0.10 }, minAdd: { shoes: 40, clothing: 15, default: 15 }, retailerMinAdd: { clothing: 25 }, rounding: "up" },
  eyewear: {
    suppliers: ["optica-bassol", "opticalh"],
    bigDiscountThreshold: 0.20,   // скидка поставщика от цены бутика, с которой действует правило Б
    capBoutique: 400,             // граница «до 400 € включительно»
    flatAdd: 40,                  // надбавка для цены бутика ≤ 400
    pctAdd: 0.10,                 // надбавка для цены бутика > 400 (округляется до 5 €)
    clientDiscount: 0.25,         // скидка клиенту в правиле Б
    smallMarkup: 0.10,            // правило В: × 1,10
    smallFactor: 0.93             //            × 0,93
  }
});

/** Округление до шага. Для nearest точная середина идёт вверх. Работает в центах, чтобы не ловить 277.4999. */
export function roundTo(value, step = 5, mode = "nearest") {
  if (!Number.isFinite(value)) return NaN;
  const cents = Math.round(value * 100), s = step * 100;
  if (mode === "up") return Math.ceil(cents / s) * step;
  if (mode === "down") return Math.floor(cents / s) * step;
  const q = Math.floor(cents / s), r = cents - q * s;
  return (r * 2 >= s ? q + 1 : q) * step;
}

const num = v => (v === null || v === undefined || v === "" ? null : Number(v));

/**
 * Расчёт цены для одного предложения.
 * @param {object} p
 * @param {"official"|"eyewear-supplier"} p.kind   тип источника
 * @param {number|null} p.boutique   подтверждённая цена бутика / рекомендованная цена (EUR того же региона)
 * @param {number|null} p.purchase   закупочная цена поставщика, если известна
 * @param {"ua"|"eu"|"dxb"} [p.dest] направление (для официальных источников)
 * @param {number|null} [p.pinned]   закреплённая администратором цена
 * @param {number} [p.minCosts]      известные обязательные расходы (для блокировки)
 * @returns {{final:number|null, rule:string, steps:Array, markup:number|null, discount:number|null,
 *            purchase:number|null, spread:number|null, needsReview:boolean, blocked:boolean, reasons:string[]}}
 */
export function priceOffer(p, cfg = PRICING_DEFAULTS) {
  const boutique = num(p.boutique), purchase = num(p.purchase), pinned = num(p.pinned);
  const minCosts = num(p.minCosts) || 0;
  const reasons = [], steps = [];
  let final = null, rule = "", markup = null, discount = null;

  if (!(boutique > 0)) {
    reasons.push("Нет подтверждённой цены бутика — расчёт требует проверки");
    return result(null, "no-boutique", steps, null, null, purchase, true, reasons, pinned, minCosts);
  }

  if (p.kind === "eyewear-supplier") {
    const e = cfg.eyewear;
    const supplierDiscount = purchase > 0 ? 1 - purchase / boutique : null;
    if (supplierDiscount === null) {
      reasons.push("Нет закупочной цены — нельзя определить размер скидки поставщика");
      return result(null, "no-purchase", steps, null, null, purchase, true, reasons, pinned, minCosts);
    }
    // сравнение в базисных пунктах, чтобы 1 - 800/1000 = 0.19999… считалось ровно 20%
    if (Math.round(supplierDiscount * 10000) >= Math.round(e.bigDiscountThreshold * 10000)) {
      rule = "Б";
      markup = boutique <= e.capBoutique ? e.flatAdd : roundTo(boutique * e.pctAdd, cfg.step, "nearest");
      const mid = boutique + markup;
      steps.push({ label: boutique <= e.capBoutique ? `Цена бутика + ${e.flatAdd} €` : `Цена бутика + 10% (до 5 €)`, value: mid });
      const raw = mid * (1 - e.clientDiscount);
      discount = e.clientDiscount;
      steps.push({ label: `Скидка клиенту ${Math.round(e.clientDiscount * 100)}%`, value: raw });
      final = roundTo(raw, cfg.step, cfg.rounding);
    } else {
      rule = "В";
      const raw = boutique * (1 + e.smallMarkup) * e.smallFactor;
      markup = e.smallMarkup; discount = 1 - e.smallFactor;
      steps.push({ label: `× ${1 + e.smallMarkup}`, value: boutique * (1 + e.smallMarkup) });
      steps.push({ label: `× ${e.smallFactor}`, value: raw });
      final = roundTo(raw, cfg.step, cfg.rounding);
    }
    steps.push({ label: "Округление до 5 €", value: final });
    return result(final, rule, steps, markup, discount, purchase, false, reasons, pinned, minCosts);
  }

  // А. Официальный источник
  const dest = p.dest || "ua";
  const m = p.retailer ? (cfg.official.retailerMarkup?.[dest] ?? cfg.official.markup[dest]) : cfg.official.markup[dest];
  if (m === undefined) throw new Error("Неизвестное направление: " + dest);
  rule = "А";
  markup = m;
  const mins = p.retailer ? { ...(cfg.official.minAdd || {}), ...(cfg.official.retailerMinAdd || {}) } : (cfg.official.minAdd || {});
  const minAdd = Number(mins[p.category] ?? mins.default) || 0;
  const add = Math.max(boutique * m, minAdd);
  let raw = boutique + add;
  steps.push(add > boutique * m ? { label: `Цена бутика + минимум ${minAdd} €`, value: raw } : { label: `Цена бутика × ${(1 + m).toFixed(2)}`, value: raw });
  const sh = cfg.shipping || {};
  if (p.retailer && Number(sh.add) > 0 && boutique < (Number(sh.freeFrom) || 0) && !(sh.skip || []).includes(p.category)) {
    raw += Number(sh.add);
    steps.push({ label: `Доставка от магазина +${Number(sh.add)} € (вещь дешевле ${Number(sh.freeFrom)} €)`, value: raw });
  }
  const rmode = cfg.official.rounding || "up";
  final = roundTo(raw, cfg.step, rmode);
  steps.push({ label: rmode === "up" ? "Округление до 5 € вверх" : "Округление до 5 €", value: final });
  return result(final, rule, steps, markup, 0, purchase, false, reasons, pinned, minCosts);
}

function result(final, rule, steps, markup, discount, purchase, needsReview, reasons, pinned, minCosts) {
  let out = final;
  if (pinned > 0) { steps.push({ label: "Закреплено администратором", value: pinned }); out = pinned; }
  const spread = out !== null && purchase > 0 ? out - purchase : null;
  let blocked = false;
  if (out !== null && purchase > 0 && out < purchase + minCosts) {
    blocked = true;
    reasons.push(`Итог ${out} € ниже закупки ${purchase} €${minCosts ? " с расходами " + minCosts + " €" : ""} — автопубликация запрещена`);
  }
  return { final: out, rule, steps, markup, discount, purchase: purchase ?? null, spread, needsReview, blocked, reasons };
}

/** Цены по всем направлениям для официального предложения (для витрины). */
export function officialPrices(boutique, cfg = PRICING_DEFAULTS, category = null) {
  const o = {};
  for (const d of Object.keys(cfg.official.markup)) o[d] = priceOffer({ kind: "official", boutique, dest: d, category }, cfg).final;
  return o;
}

export function mergeConfig(over) {
  if (!over) return PRICING_DEFAULTS;
  return {
    ...PRICING_DEFAULTS, ...over,
    official: { markup: { ...PRICING_DEFAULTS.official.markup, ...(over.official?.markup || {}) }, minAdd: { ...PRICING_DEFAULTS.official.minAdd, ...(over.official?.minAdd || {}) }, retailerMarkup: { ...PRICING_DEFAULTS.official.retailerMarkup, ...(over.official?.retailerMarkup || {}) }, retailerMinAdd: { ...PRICING_DEFAULTS.official.retailerMinAdd, ...(over.official?.retailerMinAdd || {}) }, rounding: over.official?.rounding || PRICING_DEFAULTS.official.rounding },
    shipping: { ...PRICING_DEFAULTS.shipping, ...(over.shipping || {}) },
    unified: { ...PRICING_DEFAULTS.unified, ...(over.unified || {}), minAdd: { ...PRICING_DEFAULTS.unified.minAdd, ...(over.unified?.minAdd || {}) } },
    eyewear: { ...PRICING_DEFAULTS.eyewear, ...(over.eyewear || {}) }
  };
}

/** Единое правило: цена бутика + max(процент, минимум категории), вверх до шага. */
export function unifiedPrice(boutique, category, cfgIn) {
  const cfg = mergeConfig(cfgIn), u = cfg.unified, b = Number(boutique);
  if (!(b > 0)) return { final: null, rule: "no-boutique", steps: [], reasons: ["Нет цены бутика"], blocked: true, needsReview: true };
  const min = Number(u.minAdd[category] ?? u.minAdd.default) || 0, pct = Number(u.markup) || 0, add = Math.max(b * pct, min), v = roundTo(b + add, cfg.step || 5, "up");
  const byMin = add > b * pct;
  return { final: v, rule: byMin ? `единое: +${min} € (минимум)` : `единое: +${Math.round(pct * 100)}%`, steps: [byMin ? `Цена бутика ${b} € + минимум ${min} € = ${v} €` : `Цена бутика ${b} € +${Math.round(pct * 100)}% = ${v} €`], reasons: [], blocked: false, needsReview: false };
}
