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
