import test from "node:test";
import assert from "node:assert/strict";
import { headCategory, detectCategory, detectSubcategory } from "../lib/normalize.js";

test("немецкие названия Dior: одежда по главному слову, а не украшения из описания; подразделы", () => {
  const C = [["Ausgestellter Rock", "skirts"], ["Gerade geschnittener Dioriviera Minirock", "skirts"], ["Dior Médaillon Schlaghose", "pants"], ["Bluse", "shirts"],
    ["Mittellanges, drapiertes Kleid", "dresses"], ["Kapuzencape", "coats"], ["Dior Oblique Poncho", "coats"], ["30 Montaigne Bar Jacke", "jackets"],
    ["Langärmliges Dior Marinière Poloshirt", "tops"], ["Dioriviera Bikinihöschen", "swim"], ["Strickjacke aus Kaschmir", "knit"]];
  for (const [t, sub] of C) {
    assert.equal(headCategory(t), "clothing", t);
    assert.equal(detectCategory(t, "", "Mit goldfarbenem Anhänger und Kette"), "clothing", t);
    assert.equal(detectSubcategory("clothing", t), sub, t);
  }
  for (const t of ["Ring mit Perle", "Halskette", "Dior Oblique Gürtel", "Mütze", "Lady Dior Tasche"]) assert.equal(headCategory(t), null, t);
  assert.equal(detectCategory("Halskette"), "jewelry");
  assert.equal(detectCategory("Tank top with ring detail"), "clothing");
  assert.equal(detectSubcategory("accessories", "Dior Oblique Gürtel"), "belts");
  assert.equal(detectSubcategory("accessories", "Mütze aus Kaschmir"), "hats");
});

test("обслуживание: юбки и брюки Dior из «Украшений» и «Другого» → «Одежда» с подразделом; ручная категория не трогается", async () => {
  const { MemoryStore } = await import("../lib/store.js");
  const { fixBrands } = await import("../lib/catalogload.js");
  const store = new MemoryStore();
  await store.put({ _id: "product.manual.dior-a1", _type: "product", brand: "Dior", title: "Ausgestellter Rock", category: "jewelry", description: "Mit Anhänger" });
  await store.put({ _id: "product.manual.dior-a2", _type: "product", brand: "Dior", title: "Dioriviera Bluse", category: "other" });
  await store.put({ _id: "product.manual.dior-a3", _type: "product", brand: "Dior", title: "Ausgestellter Rock", category: "jewelry", overrides: { category: "jewelry" } });
  await store.put({ _id: "product.manual.dior-a4", _type: "product", brand: "Dior", title: "Halskette", category: "jewelry" });
  await store.put({ _id: "product.manual.dior-a5", _type: "product", brand: "Dior", title: "Dior Oblique Kapuzenjacke mit Reißverschluss", category: "bags", description: "Zwei Taschen" });
  await store.put({ _id: "product.manual.dior-a6", _type: "product", brand: "Dior", title: "Medium Dior Initials Hobo Tasche", category: "bags" });
  await fixBrands(store);
  assert.equal((await store.get("product.manual.dior-a5")).category, "clothing"); assert.equal((await store.get("product.manual.dior-a5")).subcategory, "jackets");
  assert.equal((await store.get("product.manual.dior-a6")).category, "bags");
  const g = async id => store.get(id);
  assert.equal((await g("product.manual.dior-a1")).category, "clothing"); assert.equal((await g("product.manual.dior-a1")).subcategory, "skirts");
  assert.equal((await g("product.manual.dior-a2")).category, "clothing"); assert.equal((await g("product.manual.dior-a2")).subcategory, "shirts");
  assert.equal((await g("product.manual.dior-a3")).category, "jewelry");
  assert.equal((await g("product.manual.dior-a4")).category, "jewelry");
});

test("обувь с «вязаными» словами — обувь: Knitted Runners, Gestrickte Läufer", () => {
  assert.equal(detectCategory("Knitted Runners"), "shoes");
  assert.equal(detectCategory("Gestrickte Läufer"), "shoes");
  assert.equal(headCategory("Strickjacke"), "clothing");
});

test("Dior: Trenchcoat — одежда (не аксессуар из-за «Gürtel»), Knit Pump / Knit Ballerina — обувь, Twinset — одежда", () => {
  assert.equal(detectCategory("Trenchcoat mit Gürtel"), "clothing"); assert.equal(detectSubcategory("clothing", "Trenchcoat mit Gürtel"), "coats");
  assert.equal(detectCategory("Dior Knit Pump"), "shoes"); assert.equal(detectCategory("Dior Knit Ballerina"), "shoes");
  assert.equal(headCategory("Twinset"), "clothing"); assert.equal(detectSubcategory("clothing", "Twinset"), "knit");
});

test("Louis Vuitton: фото без дублей и пустых заглушек, лицевой кадр первым, баннер раздела не берём", async () => {
  const { orderImages, lvOwn } = await import("../lib/imgorder.js");
  const b = "https://de.louisvuitton.com/images/is/image/lv/1/PP_VP_L/louis-vuitton-fastline-rucksack--M29799";
  const out = orderImages(["https://en.louisvuitton.com/images/is/image/MEN_BC_LG_FORMAL_AUG26_DII.jpg?wid=4096", b + "_PM2_Front view.jpg", b + "_PM2_Front%20view.png?wid=490&hei=490", b + "_PM1_Worn%20view.png?wid=490", b + "_PM1_Side%20view.png?wid=490", b + "_PM1_Back%20view.png", b + "_PM2_Front", b + "_PM1_Side"], { sku: "m29799" });
  assert.deepEqual(out.map(u => u.split("--")[1]), ["M29799_PM2_Front%20view.png?wid=2400&hei=2400", "M29799_PM1_Side%20view.png?wid=2400&hei=2400", "M29799_PM1_Back%20view.png?wid=2400&hei=2400", "M29799_PM1_Worn%20view.png?wid=2400&hei=2400"]);
  assert.ok(lvOwn(b + "_PM2_Front%20view.png", "M29799")); assert.ok(!lvOwn("https://en.louisvuitton.com/images/is/image/MEN_BC_X.jpg", "M29799"));
});

test("убранное в админке фото (×) не идёт на витрину", async () => {
  const { cleanOverride } = await import("../lib/publish.js");
  assert.deepEqual(cleanOverride("imgOff", ["https://a/1.png", "javascript:x", "https://a/1.png"]), ["https://a/1.png"]);
});

test("LV обувь: фото с кодом модели (не артикулом) — берём их, рекламный кадр раздела не обложка", async () => {
  const { orderImages } = await import("../lib/imgorder.js");
  const b = "https://de.louisvuitton.com/images/is/image/lv/1/PP_VP_L/louis-vuitton-lv-trainer-sneaker--BM9U5PMI92";
  const out = orderImages(["https://de.louisvuitton.com/images/is/image/M_PRECO_STILL_BC_7_OCT26_DII.jpg?wid=4096", b + "_PM1_Side%20view.png?wid=490", b + "_PM2_Front%20view.png?wid=490", "https://de.louisvuitton.com/images/is/image/lv/1/PP_VP_L/louis-vuitton-other--BM1111_PM2_Front%20view.png"], { sku: "1al3jv" });
  assert.deepEqual(out.map(u => u.split("--")[1]), ["BM9U5PMI92_PM2_Front%20view.png?wid=2400&hei=2400", "BM9U5PMI92_PM1_Side%20view.png?wid=2400&hei=2400"]);
});

test("предмет в названии: ремень/шляпа/носки из денима — аксессуары, чемодан — сумка, перчатки — не обувь, портфель — сумка", async () => {
  const { objCategory } = await import("../lib/normalize.js");
  const T = { "LV Dimension Denim Wendegürtel 35 mm": "accessories", "Fischerhut aus Denim mit Monogram-Blüten": "accessories", "Monogram Denim Icon Socken": "accessories", "Denim Patchwork Stola": "accessories",
    "Horizon 55 Koffer": "bags", "Horizon 55 Kofferhülle": "accessories", "Uhrenetui für drei Uhren": "accessories", "LV Blason Handschuhe": "accessories", "Gate Briefcase": "bags",
    "Bomberjacke aus Leder": "clothing", "T-Shirt mit Hut-Print": "clothing", "Cap Sleeve Top": "clothing", "Knitted Runners": "shoes", "Gürteltasche": "bags", "Lady Dior Medium": null };
  for (const [t, c] of Object.entries(T)) assert.equal(objCategory(t), c, t);
});

test("обувь: Low-Top/High-Top и Slip-on — не одежда (Gucci)", async () => {
  const { headCategory, detectCategory, detectSubcategory } = await import("../lib/normalize.js");
  for (const t of ["Stretch Low-Top-Herrensneaker", "Stretch High-Top-Herrensneaker", "Slip-on-Herrensneaker"]) {
    assert.notEqual(headCategory(t), "clothing", t); assert.equal(detectCategory(t), "shoes", t); assert.equal(detectSubcategory("shoes", t), "sneakers", t); }
  assert.equal(headCategory("Crop Top"), "clothing"); assert.equal(detectSubcategory("clothing", "Silk Slip Dress"), "dresses");
});

test("пол: вещь из мужского и женского раздела бренда — унисекс; ручной выбор важнее", async () => {
  const { genderOf } = await import("../lib/catalog.js");
  const m = "de.louisvuitton.com/deu-de/herren/taschen/alle-taschen/_/N-t1", w = "de.louisvuitton.com/deu-de/damen/taschen/alle-taschen/_/N-t2";
  assert.equal(genderOf({ gender: "m", webSections: [m] }), "m");
  assert.equal(genderOf({ gender: "m", webSections: [m, w] }), "u");
  assert.equal(genderOf({ gender: "w", webSections: ["gucci.com/de/de/ca/women/x", "gucci.com/de/de/ca/men/x"] }), "u");
  assert.equal(genderOf({ gender: "m", webSections: [m, w], overrides: { gender: "m" } }, { gender: "m" }), "m");
});

test("быстрый прогон без чтения наличия не трогает статусы размеров; чтение наличия ставит дату", async () => {
  const { updateWebProduct } = await import("../lib/manual.js");
  const doc = { _id: "product.manual.de-x1", category: "shoes", sizes: ["40", "41"], variants: [{ _key: "a", size: "40" }, { _key: "b", size: "41" }],
    offers: [{ boutique: 500, availability: { a: { status: "ask" }, b: { status: "online" } } }], pricing: {} };
  const store = { d: { [doc._id]: doc }, async get(id) { return JSON.parse(JSON.stringify(this.d[id] || null)); }, async put(x) { this.d[x._id] = x; return x; }, async patchMany() {} };
  await updateWebProduct(store, doc._id, { boutique: 500, sizeStock: [{ s: "40", ok: true }, { s: "41", ok: true }], noStock: true }, {});
  let p = store.d[doc._id]; assert.equal(p.offers[0].availability.a.status, "ask"); assert.ok(!p.offers[0].stockAt);
  await updateWebProduct(store, doc._id, { boutique: 500, sizeStock: [{ s: "40", ok: true }, { s: "41", ok: false }], stockRead: true }, {});
  p = store.d[doc._id]; assert.equal(p.offers[0].availability.a.status, "online"); assert.equal(p.offers[0].availability.b.status, "ask"); assert.ok(p.offers[0].stockAt);
});

test("цвета одной модели — одна семья по артикулу, даже если названия переведены по-разному", async () => {
  const { famKey } = await import("../lib/catalog.js");
  const f = (id, title, brand = "Dior") => famKey({ _id: "product.manual." + id, title, brand });
  assert.equal(f("dior-113j698a0531c888", "CD Icon Hoodie"), f("dior-113j698a0531c989", "CD Icon Hooded Sweatshirt"));
  assert.notEqual(f("dior-113j698a0531c888", "CD Icon Hoodie"), f("dior-113j699a0531c888", "CD Icon Sweatshirt"));
  assert.equal(f("gucci-1334833g2001160", "Schal aus GG Wolle", "Gucci"), f("gucci-1334833g2001763", "GG wool scarf", "Gucci"));
  assert.equal(f("goldengoose-gwf00117f00934412615", "Ball Star", "Golden Goose"), f("goldengoose-gwf00117f00934410920", "Ball Star Damen", "Golden Goose"));
});

test("Miu Miu: only women, colors of one model+material are one family", async () => {
  const { genderOf, famKey } = await import("../lib/catalog.js");
  assert.equal(genderOf({ brand: "Miu Miu", gender: "u" }), "w");
  const a = famKey({ _id: "product.manual.miumiu-5bf131an88f0009volo", brand: "Miu Miu", title: "Caprice Clutch" });
  const b = famKey({ _id: "product.manual.miumiu-5bf131an88f0007volo", brand: "Miu Miu", title: "Caprice Clutch" });
  const c = famKey({ _id: "product.manual.miumiu-5bf1312ieof0041vooo", brand: "Miu Miu", title: "Caprice Leather Clutch" });
  assert.equal(a, b); assert.notEqual(a, c);
});

test("Loro Piana: пол по адресу (без унисекса), цвета одной модели — одна семья, разные модели — разные", async () => {
  const { genderOf, famKey } = await import("../lib/catalog.js");
  const base = { brand: "Loro Piana", gender: "w", webSections: ["de.loropiana.com/de/c/herren/accessoires/schals", "de.loropiana.com/de/c/damen/accessoires/schals"] };
  assert.equal(genderOf({ ...base, sourceUrl: "https://de.loropiana.com/de/damen/accessoires/schals/schal-grande-unita-FAA2448_W000.html" }), "w");
  assert.equal(genderOf({ ...base, sourceUrl: "https://de.loropiana.com/de/herren/the-gift-of-kings/sakkos/jacke-FAP6827_BE11.html" }), "m");
  assert.equal(genderOf({ ...base, sourceUrl: "https://de.loropiana.com/de/tops/man/t-shirt-como-FAF6689_1000.html" }), "m");
  assert.equal(genderOf({ ...base, sourceUrl: "https://de.loropiana.com/de/x/y-FAA2448_W000.html" }), "w");
  assert.equal(genderOf({ ...base, brand: "Gucci" }), "u"); // у других брендов правило «в обоих разделах — унисекс» как было
  const sw = (sku, id) => famKey({ _id: "product.manual.de-" + id, brand: "Loro Piana", title: "Mokassin Summer Walk", modelSku: sku });
  assert.equal(sw("FAE8124_50ZF", "a"), sw("FAE8124_W12S", "b"));
  assert.notEqual(sw("FAE8124_50ZF", "a"), sw("FAQ2211_MH90", "c"));
});

test("Hermès: цвета одной модели — одна семья", async () => {
  const { famKey } = await import("../lib/catalog.js");
  const f = (sku, id) => famKey({ _id: "product.manual.hermes-" + id, brand: "Hermès", title: "Sneakers Day", modelSku: sku });
  assert.equal(f("H241856ZHC9", "a"), f("H241856ZH90", "b"));
  assert.notEqual(f("H241856ZHC9", "a"), f("H212901ZH90", "c"));
});
