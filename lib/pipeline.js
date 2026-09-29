/**
 * Конвейер одной позиции: нормализация → дубли → цены → проверка полей → строка предпросмотра.
 * Ничего не публикует. Публикация — отдельным действием администратора (lib/publish.js).
 */
import { normalize, hash, CATEGORIES } from "./normalize.js";
import { findMatch, leadMax, LEAD_LIMIT } from "./match.js";
import { priceOffer, mergeConfig, roundTo } from "./pricing.js";
import { orderImages } from "./images.js";

export function priceFor(offer, cfgIn, pinned) {
  const cfg = mergeConfig(cfgIn);
  if (offer.sourceKind === "eyewear-supplier") {
    const r = priceOffer({ kind: "eyewear-supplier", boutique: offer.boutique, purchase: offer.purchase, pinned }, cfg);
    return { rule: r.rule, ua: r.final, eu: r.final, dxb: r.final, steps: r.steps, blocked: r.blocked, needsReview: r.needsReview, reasons: r.reasons, spread: r.spread, purchase: r.purchase, boutique: offer.boutique, currency: offer.currency, region: offer.region };
  }
  // закреплённая цена — это цена для Украины; Европа и Дубай пересчитываются от неё своими коэффициентами
  const by = {}; let base = null;
  for (const d of ["ua", "eu", "dxb"]) {
    const pin = pinned > 0 ? (d === "ua" ? pinned : roundTo(pinned * (1 + cfg.official.markup[d]) / (1 + cfg.official.markup.ua), cfg.step, cfg.rounding)) : null;
    const r = priceOffer({ kind: "official", boutique: offer.boutique, dest: d, purchase: offer.purchase, pinned: pin }, cfg); by[d] = r.final; if (d === "ua") base = r;
  }
  return { rule: base.rule, ...by, steps: base.steps, blocked: base.blocked, needsReview: base.needsReview, reasons: base.reasons, spread: base.spread, purchase: base.purchase, boutique: offer.boutique, currency: offer.currency, region: offer.region };
}

/**
 * @param raw     сырой товар из адаптера/файла
 * @param src     источник (sourceWith)
 * @param ctx     {existing: product[], pricingCfg, now, jobId, urlHints}
 */
export function buildItem(raw, src, ctx) {
  const cfg = mergeConfig(ctx.pricingCfg);
  const n = normalize(raw, src, { now: ctx.now, urlHints: ctx.urlHints });
  const issues = [...n.issues];
  const match = findMatch(n, ctx.existing || []);
  const existing = match.matchId ? (ctx.existing || []).find(p => p._id === match.matchId) : null;
  const pinned = existing?.overrides?.pinnedPrice || null;
  const pricing = priceFor(n.offer, cfg, pinned);
  pricing.reasons.forEach(t => issues.push({ level: pricing.blocked ? "error" : "warn", code: pricing.blocked ? "price-blocked" : "price-review", text: t }));

  // фото: порядок по источнику, предметные раньше «на модели»; обложка должна быть надёжной
  const ord = orderImages(n.model.images.map(i => i.url));
  n.model.images = ord.images.map(url => ({ url, rights: src.imageRights }));
  if (ord.images.length && !ord.coverSure) issues.push({ level: "warn", code: "cover", text: "Нет предметного фото — выберите обложку вручную" });
  n.variants.forEach(v => { v.images = orderImages(v.images.map(i => i.url)).images.map(url => ({ url, rights: src.imageRights })); });
  const colorsWithSameImages = n.variants.filter(v => v.color).map(v => v.images[0]?.url).filter(Boolean);
  if (new Set(n.variants.map(v => v.color).filter(Boolean)).size > 1 && new Set(colorsWithSameImages).size === 1)
    issues.push({ level: "warn", code: "color-photos", text: "У разных цветов одинаковое фото — проверьте, что фото соответствуют цвету" });

  let kind;
  const lm = leadMax(n.offer.supplierLeadDays);
  if (src.kind === "eyewear-supplier" && lm !== null && lm > LEAD_LIMIT) kind = "excluded";
  else if (issues.some(i => i.level === "error")) kind = issues.some(i => ["no-price", "no-photo"].includes(i.code)) && !n.model.sourceTitle ? "error" : "incomplete";
  else if (match.status === "possible-duplicate") kind = "duplicate";
  else kind = match.status === "update" ? "update" : "new";
  if (src.kind === "eyewear-supplier" && lm === null) issues.push({ level: "warn", code: "lead-unknown", text: "Срок поставки неизвестен — предложение не выбирается автоматически" });
  if (kind === "excluded") issues.push({ level: "info", code: "lead", text: `Срок поставщика до ${lm} дн. — больше ${LEAD_LIMIT}` });
  if (!n.model.category) n.model.category = null;

  return {
    _id: `item.${ctx.jobId}.${hash(n.offer.url || n.model._id)}`,
    _type: "importItem", jobId: ctx.jobId, sourceId: src.id, url: n.offer.url,
    kind, match, issues, model: n.model, variants: n.variants, offer: n.offer,
    pricing, priceBefore: existing?.pricing?.ua ?? null,
    categoryLabel: CATEGORIES[n.model.category] || "—",
    selected: kind === "new" || kind === "update", createdAt: ctx.now
  };
}
