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
