import { test } from "node:test";
import assert from "node:assert/strict";
import { roundTo, priceOffer, officialPrices, mergeConfig } from "../lib/pricing.js";

test("округление: ближайшие 5 €, середина вверх (примеры из ТЗ)", () => {
  assert.equal(roundTo(277.5), 280);
  assert.equal(roundTo(378.75), 380);
  assert.equal(roundTo(1023), 1025);
  assert.equal(roundTo(1022.49), 1020);
  assert.equal(roundTo(1022.5), 1025);
  assert.equal(roundTo(1020), 1020);
});
test("округление: режимы up/down", () => {
  assert.equal(roundTo(1021, 5, "up"), 1025);
  assert.equal(roundTo(1024.9, 5, "down"), 1020);
});

test("А: официальный сайт ×1,10 (Украина), 3000 → 3300", () => {
  const r = priceOffer({ kind: "official", boutique: 3000, dest: "ua" });
  assert.equal(r.final, 3300); assert.equal(r.rule, "А"); assert.equal(r.needsReview, false);
});
test("А: Европа и Дубай ×1,08, 3000 → 3240", () => {
  assert.deepEqual(officialPrices(3000), { ua: 3300, eu: 3240, dxb: 3240 });
});
test("А: итог кратен 5", () => {
  assert.equal(priceOffer({ kind: "official", boutique: 3451, dest: "ua" }).final % 5, 0);
});

test("Б: 330 € (≤400) → (330+40)×0,75 = 277,5 → 280", () => {
  const r = priceOffer({ kind: "eyewear-supplier", boutique: 330, purchase: 200 });
  assert.equal(r.rule, "Б"); assert.equal(r.final, 280); assert.equal(r.markup, 40);
});
test("Б: граница 400 € включительно → +40", () => {
  const r = priceOffer({ kind: "eyewear-supplier", boutique: 400, purchase: 300 });
  assert.equal(r.markup, 40); assert.equal(r.final, roundTo(440 * 0.75));
});
test("Б: 460 € (>400) → 460+45 = 505 ×0,75 = 378,75 → 380", () => {
  const r = priceOffer({ kind: "eyewear-supplier", boutique: 460, purchase: 300 });
  assert.equal(r.markup, 45); assert.equal(r.final, 380);
});
test("Б: 400,01 € уже по правилу >400", () => {
  const r = priceOffer({ kind: "eyewear-supplier", boutique: 400.01, purchase: 300 });
  assert.equal(r.markup, 40); // 10% = 40.001 → 40
  assert.notEqual(r.steps[0].label.indexOf("10%"), -1);
});

test("порог 20%: ровно 20% — большая скидка (Б), 19,9% — маленькая (В)", () => {
  assert.equal(priceOffer({ kind: "eyewear-supplier", boutique: 1000, purchase: 800 }).rule, "Б");
  assert.equal(priceOffer({ kind: "eyewear-supplier", boutique: 1000, purchase: 801 }).rule, "В");
});
test("В: 1000 × 1,10 × 0,93 = 1023 → 1025", () => {
  const r = priceOffer({ kind: "eyewear-supplier", boutique: 1000, purchase: 900 });
  assert.equal(r.rule, "В"); assert.equal(r.final, 1025);
});
test("порог настраивается", () => {
  const cfg = mergeConfig({ eyewear: { bigDiscountThreshold: 0.3 } });
  assert.equal(priceOffer({ kind: "eyewear-supplier", boutique: 1000, purchase: 750 }, cfg).rule, "В");
});

test("нет цены бутика — не подменяем, требует проверки", () => {
  const r = priceOffer({ kind: "official", boutique: null, purchase: 500 });
  assert.equal(r.final, null); assert.equal(r.needsReview, true);
});
test("нет закупки у поставщика очков — требует проверки", () => {
  const r = priceOffer({ kind: "eyewear-supplier", boutique: 500, purchase: null });
  assert.equal(r.final, null); assert.equal(r.needsReview, true);
});
test("итог ниже закупки с обязательными расходами — блокировка", () => {
  // правило Б: 330 → 280; закупка 264 + расходы 20 = 284 > 280
  const r = priceOffer({ kind: "eyewear-supplier", boutique: 330, purchase: 264, minCosts: 20 });
  assert.equal(r.final, 280); assert.equal(r.blocked, true); assert.ok(r.reasons[0].includes("ниже закупки"));
});
test("закреплённая цена ниже закупки — блокировка", () => {
  const r = priceOffer({ kind: "official", boutique: 3000, purchase: 2900, pinned: 2800 });
  assert.equal(r.blocked, true);
});
test("разница продажа−закупка считается, но не называется прибылью", () => {
  const r = priceOffer({ kind: "eyewear-supplier", boutique: 460, purchase: 300 });
  assert.equal(r.spread, 80);
});
test("закреплённая цена имеет приоритет", () => {
  const r = priceOffer({ kind: "official", boutique: 3000, dest: "ua", pinned: 3250 });
  assert.equal(r.final, 3250);
});
