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
