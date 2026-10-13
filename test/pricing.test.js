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

test("минимальная комиссия за единицу: одежда +15 €, обувь +40 € (пример Alo Yoga)", () => {
  const ua = (boutique, category) => priceOffer({ kind: "official", boutique, dest: "ua", category }).final;
  assert.equal(ua(50, "clothing"), 65, "майка: 10% = 5 € < 15 € → 65");
  assert.equal(ua(340, "clothing"), 375, "худи: +34 € → 374 → 375");
  assert.equal(ua(200, "clothing"), 220, "штаны: +20 € → 220");
  assert.equal(ua(40, "clothing"), 55, "кофта: минимум +15 € → 55");
  assert.equal(ua(200, "shoes"), 240, "обувь: 10% = 20 € < 40 € → 240");
  assert.equal(ua(600, "shoes"), 660, "дорогая обувь: 10% больше минимума");
  assert.equal(ua(50, "bags"), 65, "у всех категорий, кроме обуви, минимум +15 €");
  assert.equal(ua(20, "accessories"), 35, "носки 20 € → 35");
  assert.equal(ua(95, "other"), 110, "книга 95 € → 110");
  assert.equal(ua(150, "accessories"), 165, "до 150 € — минимум 15 €");
  assert.equal(ua(338, "clothing"), 375, "338 + 10% = 371,8 → округление вверх → 375 (не 370)");
  assert.equal(ua(400, "shoes"), 440, "обувь до 400 € — +40 €");
  assert.equal(ua(450, "shoes"), 495, "обувь дороже 400 € — +10%");
  assert.equal(ua(1200, "bags"), 1320, "сумка 1200 € → +10%");
  assert.equal(priceOffer({ kind: "official", boutique: 50, dest: "eu", category: "clothing" }).final, 65, "Европа: тот же минимум");
});
