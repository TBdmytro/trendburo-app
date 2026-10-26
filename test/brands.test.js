import { test } from "node:test";
import assert from "node:assert/strict";
import { canonBrand, brandKey } from "../lib/normalize.js";
import { MemoryStore } from "../lib/store.js";
import { fixBrands } from "../lib/catalogload.js";

test("одно название на бренд", () => {
  assert.equal(canonBrand("Sporty-&-Rich"), "Sporty & Rich");
  assert.equal(canonBrand("Sporty & Rich"), "Sporty & Rich");
  assert.equal(canonBrand("Alo Yoga Set"), "Alo Yoga");
  assert.equal(canonBrand("BOTTEGA VENETA"), "Bottega Veneta");
  assert.equal(canonBrand("MIU MIU"), "Miu Miu");
  assert.equal(canonBrand("OFF-WHITE"), "Off-White");
  assert.equal(canonBrand("TOD'S"), "Tod's");
  assert.equal(canonBrand("MM6 MAISON MARGIELA"), "MM6 Maison Margiela");
  assert.equal(canonBrand("JW ANDERSON"), "JW Anderson");
  assert.equal(canonBrand("Yves Saint Laurent"), "Saint Laurent");
  assert.equal(canonBrand("Dolce & Gabbana"), "Dolce & Gabbana");
  assert.equal(canonBrand("Ray-Ban"), "Ray-Ban");
  assert.equal(canonBrand("Gucci"), "Gucci");
  assert.equal(brandKey("Sporty-&-Rich"), brandKey("Sporty & Rich"));
});

test("уже загруженные товары с «Sporty-&-Rich» выравниваются, остальные не трогаются", async () => {
  const s = new MemoryStore();
  await s.put({ _id: "product.u.a", _type: "product", brand: "Sporty-&-Rich" });
  await s.put({ _id: "product.u.b", _type: "product", brand: "Sporty & Rich" });
  await s.put({ _id: "product.u.c", _type: "product", brand: "Alo Yoga" });
  assert.equal(await fixBrands(s), 1);
  assert.equal((await s.get("product.u.a")).brand, "Sporty & Rich");
  assert.equal((await s.get("product.u.c")).brand, "Alo Yoga");
  assert.equal(await fixBrands(s), 0);
});

test("сайт одного бренда: все товары поставщика получают его бренд, мультибренд — нет", async () => {
  const { singleBrand } = await import("../lib/suppliers.js");
  assert.equal(singleBrand([...Array(40).fill("Sporty & Rich"), ...Array(6).fill("Sporty-&-Rich")]), "Sporty & Rich");
  assert.equal(singleBrand(["Gucci", "Prada", "Loewe", "Gucci", "Prada", "Miu Miu"]), null);
  const s = new MemoryStore();
  await s.put({ _id: "source.s-sr", _type: "sourceSettings", sourceId: "s-sr", custom: { id: "s-sr", brand: null } });
  await s.put({ _id: "source.s-mb", _type: "sourceSettings", sourceId: "s-mb", custom: { id: "s-mb", brand: null } });
  for (let i = 0; i < 25; i++) await s.put({ _id: "product.u.sr" + i, _type: "product", brand: i < 2 ? "Sporty Rich Club" : i < 6 ? "Sporty-&-Rich" : "Sporty & Rich", offers: [{ sourceId: "s-sr" }] });
  for (let i = 0; i < 25; i++) await s.put({ _id: "product.u.mb" + i, _type: "product", brand: ["GUCCI", "Prada", "Loewe"][i % 3], offers: [{ sourceId: "s-mb" }] });
  await fixBrands(s);
  assert.equal((await s.get("source.s-sr")).custom.brand, "Sporty & Rich");
  assert.equal((await s.get("source.s-mb")).custom.brand, null);
  const sr = (await s.list("product", {})).filter(p => p._id.includes(".sr"));
  assert.deepEqual([...new Set(sr.map(p => p.brand))], ["Sporty & Rich"]);
  assert.equal((await s.get("product.u.mb0")).brand, "Gucci");
});

test("товар с кнопки: цена бутика +10% во все регионы, вверх до 5 €", async () => {
  const { saveManualProduct } = await import("../lib/manual.js");
  const s = new MemoryStore();
  const p = await saveManualProduct(s, { id: "product.manual.ysl-a1", brand: "Yves Saint Laurent", title: "Simone", category: "bags", boutique: 3200, images: ["https://x.test/a.jpg"], markupPct: 10, status: "draft" });
  assert.equal(p.brand, "Saint Laurent");
  assert.deepEqual([p.pricing.ua, p.pricing.eu, p.pricing.dxb], [3520, 3520, 3520]);
  const q = await saveManualProduct(s, { id: "product.manual.ysl-a2", brand: "Saint Laurent", title: "Le 5 a 7", category: "bags", boutique: 2333, images: ["https://x.test/b.jpg"], markupPct: 10, status: "draft" });
  assert.equal(q.pricing.eu, 2570); // 2566,3 → вверх до 2570
  assert.equal(q.status, "draft");
});

test("сумка с кнопки, попавшая в одежду из-за «coated canvas», возвращается в «Сумки»; куртка остаётся одеждой", async () => {
  const s = new MemoryStore();
  await s.put({ _id: "product.manual.ysl-x1", _type: "product", brand: "Saint Laurent", title: "CABAS in coated canvas", description: "A spacious tote bag in coated canvas", category: "clothing" });
  await s.put({ _id: "product.manual.ysl-x2", _type: "product", brand: "Saint Laurent", title: "Jacket in wool", description: "Fits in your bag", category: "clothing" });
  await fixBrands(s);
  assert.equal((await s.get("product.manual.ysl-x1")).category, "bags");
  assert.equal((await s.get("product.manual.ysl-x2")).category, "clothing");
});

test("наличие по размерам с сайта бренда: продано — «out», остальные в наличии; держится месяц, а не двое суток", async () => {
  const { saveManualProduct } = await import("../lib/manual.js");
  const { toStorefront } = await import("../lib/catalog.js");
  const s = new MemoryStore();
  const p = await saveManualProduct(s, { id: "product.manual.mt-l1", brand: "Alo Yoga", title: "Leggings", category: "clothing", boutique: 120, images: ["https://x.test/a.jpg"], markupPct: 10, status: "published",
    sizeStock: [{ s: "XS", ok: true }, { s: "S", ok: true }, { s: "M", ok: true }, { s: "L", ok: true }, { s: "XL", ok: true }, { s: "XXL", ok: false }] });
  const in10days = Date.parse(p.offers[0].checkedAt) + 10 * 864e5;
  const sf = toStorefront(p, in10days);
  assert.deepEqual(sf.sizes.map(x => x.size + ":" + x.status), ["XS:online", "S:online", "M:online", "L:online", "XL:online", "XXL:ask"]);
  assert.equal(sf.orderable, true);
});

test("предзаказ у бутика: размеры «предзаказ», проданные остаются проданными, купить сразу нельзя; при обновлении — снимается", async () => {
  const { saveManualProduct, updateWebProduct } = await import("../lib/manual.js");
  const { toStorefront } = await import("../lib/catalog.js");
  const s = new MemoryStore();
  const p = await saveManualProduct(s, { id: "product.manual.ysl-j1", brand: "Saint Laurent", title: "Jacket", category: "clothing", boutique: 3000, images: ["https://x.test/a.jpg"], markupPct: 10, status: "published",
    sizeStock: [{ s: "44", ok: true }, { s: "46", ok: false }], preorder: true });
  const sf = toStorefront(p, Date.parse(p.offers[0].checkedAt) + 864e5);
  assert.deepEqual(sf.sizes.map(x => x.size + ":" + x.status), ["44:preorder", "46:preorder"]);
  assert.equal(sf.availability, "preorder"); assert.equal(sf.orderable, false);
  const nosz = await saveManualProduct(s, { id: "product.manual.ysl-j2", brand: "Saint Laurent", title: "Coat", category: "clothing", boutique: 3000, images: ["https://x.test/a.jpg"], status: "published", preorder: true });
  assert.equal(toStorefront(nosz, Date.parse(nosz.offers[0].checkedAt) + 864e5).availability, "preorder");
  const u = await updateWebProduct(s, "product.manual.ysl-j1", { boutique: 3000, sizeStock: [{ s: "44", ok: true }, { s: "46", ok: true }] }, {});
  const after = await s.get("product.manual.ysl-j1");
  assert.equal(toStorefront(after, Date.parse(after.offers[0].checkedAt) + 864e5).availability, "online");
  assert.ok(u);
});

test("с сайта бренда: размер распродан или «лист ожидания» — на витрине «уточнить наличие» (менеджер выкупит в бутике), а не «продано»", async () => {
  const { saveManualProduct, markWebGone } = await import("../lib/manual.js");
  const { toStorefront } = await import("../lib/catalog.js");
  const s = new MemoryStore();
  const a = await saveManualProduct(s, { id: "product.manual.lv-s1", brand: "Louis Vuitton", title: "LV Trainer sneaker", category: "shoes", boutique: 1200, images: ["https://x.test/a.jpg"], status: "published",
    sizeStock: [{ s: "40", ok: false }, { s: "41", ok: false }] });
  const sa = toStorefront(a, Date.parse(a.offers[0].checkedAt) + 864e5);
  assert.equal(sa.availability, "ask"); assert.equal(sa.orderable, false); assert.ok(a.hasPre);
  const b = await saveManualProduct(s, { id: "product.manual.lv-s2", brand: "Louis Vuitton", title: "Coat", category: "clothing", boutique: 5000, images: ["https://x.test/a.jpg"], status: "published", ask: "wait" });
  assert.equal(toStorefront(b, Date.parse(b.offers[0].checkedAt) + 864e5).availability, "ask");
  await markWebGone(s, ["product.manual.lv-s2"]); // страницы на сайте бренда больше нет — тогда «нет в наличии»
  const g = await s.get("product.manual.lv-s2");
  assert.equal(toStorefront(g, Date.parse(g.offers[0].checkedAt) + 864e5).availability, "out");
});

test("кнопка +10%: минимальная наценка по категории — как на сайте (обувь 40 €)", async () => {
  const { priceFor } = await import("../lib/pipeline.js");
  const { mergeConfig } = await import("../lib/pricing.js");
  const cfg = mergeConfig({ official: { minAdd: { shoes: 40, default: 40 } } });
  assert.equal(priceFor({ sourceKind: "official", boutique: 200, flatMarkup: 0.1 }, cfg, null, "shoes").ua, 240); // 10% = 20 € < 40 €
  assert.equal(priceFor({ sourceKind: "official", boutique: 1200, flatMarkup: 0.1 }, cfg, null, "shoes").ua, 1320); // 10% больше минимума
  assert.equal(priceFor({ sourceKind: "official", boutique: 150, flatMarkup: 0.1 }, cfg, null, "bags").ua, 190);
});

test("одежда с сайта бренда без размеров — «уточнить наличие» (и у уже загруженных)", async () => {
  const { saveManualProduct } = await import("../lib/manual.js");
  const { askNoSizes } = await import("../lib/catalogload.js");
  const { toStorefront } = await import("../lib/catalog.js");
  const s = new MemoryStore();
  const a = await saveManualProduct(s, { id: "product.manual.ysl-x1", brand: "Saint Laurent", title: "shorts in cotton", category: "clothing", boutique: 1200, images: ["https://x.test/a.jpg"], status: "published", fromWeb: true });
  assert.equal(toStorefront(a, Date.parse(a.offers[0].checkedAt) + 864e5).availability, "ask");
  const old = await saveManualProduct(s, { id: "product.manual.ysl-x2", brand: "Saint Laurent", title: "coat", category: "clothing", boutique: 9000, images: ["https://x.test/a.jpg"], status: "published" });
  assert.equal(toStorefront(old, Date.parse(old.offers[0].checkedAt) + 864e5).availability, "online");
  assert.equal(await askNoSizes(s), 1);
  const o2 = await s.get("product.manual.ysl-x2");
  assert.equal(toStorefront(o2, Date.parse(o2.offers[0].checkedAt) + 864e5).availability, "ask");
});

test("единое правило цен: одинаково для сайтов брендов, магазинов, кнопки и ручных; очки — по своим", async () => {
  const { priceFor } = await import("../lib/pipeline.js");
  const { mergeConfig } = await import("../lib/pricing.js");
  const cfg = mergeConfig({ unified: { on: true, markup: 0.10, minAdd: { shoes: 40, clothing: 40, default: 40 } } });
  for (const kind of ["official", "retailer"]) assert.equal(priceFor({ sourceKind: kind, boutique: 200 }, cfg, null, "shoes").ua, 240);
  assert.equal(priceFor({ sourceKind: "official", boutique: 200, flatMarkup: 0.2 }, cfg, null, "clothing").ua, 240); // своя наценка товара не действует — правило одно
  const r = priceFor({ sourceKind: "retailer", boutique: 3000 }, cfg, null, "clothing"); assert.equal(r.ua, 3300); assert.equal(r.eu, 3300); assert.equal(r.dxb, 3300);
  assert.equal(priceFor({ sourceKind: "official", boutique: 3000 }, cfg, 2900, "clothing").ua, 2900); // закреплённая цена главнее
  assert.notEqual(priceFor({ sourceKind: "eyewear-supplier", boutique: 330, purchase: 240 }, cfg, null, "eyewear").rule, "единое: +40 € (минимум)");
  assert.equal(priceFor({ sourceKind: "official", boutique: 3000, region: "DE" }, mergeConfig({}), null, "clothing").ua, 3300); // выключено — как раньше
});

test("очки: +10% округляется до 5 € (410 → +40, 420 → +40, 430 → +45), минимум 40 €", async () => {
  const { unifiedPrice } = await import("../lib/pricing.js");
  const cfg = { unified: { on: true, markup: 0.10, minAdd: { default: 40, shoes: 40, clothing: 40 } } };
  assert.equal(unifiedPrice(410, "eyewear", cfg).final, 450);
  assert.equal(unifiedPrice(420, "eyewear", cfg).final, 460);
  assert.equal(unifiedPrice(430, "eyewear", cfg).final, 475);
  assert.equal(unifiedPrice(300, "eyewear", cfg).final, 340);
});

test("одежда в «Украшениях»/«Другом» с кнопки: по главному слову названия → «Одежда»; кольцо остаётся украшением", async () => {
  const s = new MemoryStore();
  await s.put({ _id: "product.manual.ysl-b1", _type: "product", brand: "Saint Laurent", title: "plunge bodysuit in silicone-coated lace", category: "jewelry" });
  await s.put({ _id: "product.manual.ysl-b2", _type: "product", brand: "Saint Laurent", title: "CASSANDRE ring in metal", category: "jewelry" });
  await s.put({ _id: "product.manual.ysl-b3", _type: "product", brand: "Saint Laurent", title: "tank top with ring detail", category: "other", overrides: { category: "other" } });
  await fixBrands(s);
  assert.equal((await s.get("product.manual.ysl-b1")).category, "clothing");
  assert.equal((await s.get("product.manual.ysl-b2")).category, "jewelry");
  assert.equal((await s.get("product.manual.ysl-b3")).category, "other"); // выставлено вручную — не трогаем
});

test("витрина: копии одного фото в меньших размерах не показываются, разные ракурсы одного размера — да", async () => {
  const { dropSizeCopies } = await import("../lib/catalog.js");
  const U = k => ({ url: "https://cdn.sanity.io/images/p/d/" + k });
  const out = dropSizeCopies([U("a-2608x3260.jpg"), U("b-200x250.jpg"), U("c-400x500.jpg"), U("d-2608x3260.jpg"), U("e-1200x800.jpg"), U("f-600x400.jpg")]).map(x => x.url.split("/").pop());
  assert.deepEqual(out, ["a-2608x3260.jpg", "d-2608x3260.jpg", "e-1200x800.jpg"]);
});

test("подразделы: обувь, сумки, одежда — по разделу сайта, названию, описанию", async () => {
  const { detectSubcategory } = await import("../lib/normalize.js");
  assert.equal(detectSubcategory("shoes", ["sneakers"], "SL/61 low-top"), "sneakers");
  assert.equal(detectSubcategory("shoes", [], "ISABELLA slingback pumps in TPU"), "pumps"); // как у YSL: «Туфли и слингбэки»
  assert.equal(detectSubcategory("shoes", [], "Tribute sandals in patent leather"), "sandals");
  assert.equal(detectSubcategory("shoes", [], "Wyatt chelsea boots"), "boots");
  assert.equal(detectSubcategory("bags", [], "ICARE maxi shopping bag"), "totes");
  assert.equal(detectSubcategory("bags", [], "LOULOU medium", "chain shoulder bag in quilted leather"), "shoulder");
  assert.equal(detectSubcategory("bags", [], "Kate small chain bag", "a clutch with chain"), "clutches");
  assert.equal(detectSubcategory("clothing", [], "Airlift High-Waist Legging"), "sport");
  assert.equal(detectSubcategory("clothing", [], "Wool trousers"), "pants");
  assert.equal(detectSubcategory("bags", [], "Simone"), null);
  // одежда как у YSL: пиджаки отдельно от курток, футболки и топы, боди; название важнее раздела «jackets-and-pants»
  assert.equal(detectSubcategory("clothing", "single-breasted tuxedo jacket in grain de poudre"), "blazers");
  assert.equal(detectSubcategory("clothing", "bomber jacket in lambskin"), "jackets");
  assert.equal(detectSubcategory("clothing", "Cassandre Tank Top"), "tops");
  assert.equal(detectSubcategory("clothing", "Saint Laurent T-shirt in cotton"), "tops");
  assert.equal(detectSubcategory("clothing", "laced bodysuit in ribbed silk jersey"), "lingerie");
  assert.equal(detectSubcategory("clothing", "trench coat in suede"), "coats");
  assert.equal(detectSubcategory("clothing", "Saint Laurent sweatshirt"), "hoodies");
  assert.equal(detectSubcategory("clothing", "Wool trousers", ["jackets", "and", "pants"]), "pants");
  assert.equal(detectSubcategory("clothing", "split pencil skirt in silicone-coated lace"), "skirts");
  const s = new MemoryStore();
  await s.put({ _id: "product.u.l1", _type: "product", brand: "Alo Yoga", title: "Airlift High-Waist Legging", category: "clothing" });
  await fixBrands(s);
  assert.equal((await s.get("product.u.l1")).subcategory, "sport");
});
