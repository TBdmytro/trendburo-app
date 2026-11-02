import { test } from "node:test";
import assert from "node:assert/strict";
import { isCollection, cleanTitle, collGender, upsertCollection, activeCollections } from "../lib/collections.js";
import { MemoryStore } from "../lib/store.js";

test("страница коллекции узнаётся, обычный раздел — нет; название и пол", () => {
  assert.ok(isCollection("Dior Cruise 2027 Kollektion | DIOR", "https://www.dior.com/de_de/fashion/damenmode/cruise-2027"));
  assert.ok(!isCollection("Taschen für Herren | DIOR", "https://www.dior.com/de_de/fashion/herrenmode/taschen/alle-taschen"));
  assert.equal(cleanTitle("Dior Cruise 2027 Kollektion | DIOR", "Dior"), "Cruise 2027");
  assert.equal(collGender("dior.com/de_de/fashion/damenmode/cruise-2027"), "w");
  assert.equal(collGender("dior.com/de_de/fashion/herrenmode/winter-2026"), "m");
});

test("коллекция создаётся при прогоне, правки из админки не затираются; на витрину — только включённые с товарами", async () => {
  const store = new MemoryStore(), section = "dior.com/de_de/fashion/damenmode/cruise-2027";
  const c = await upsertCollection(store, { section, url: "https://www.dior.com/" + section, title: "Dior Cruise 2027 Kollektion", desc: "Eine Kollektion, inspiriert von Hollywood", brand: "Dior", translate: async () => "Коллекция, вдохновлённая Голливудом" });
  assert.equal(c.title, "Cruise 2027"); assert.equal(c.g, "w"); assert.equal(c.on, true); assert.equal(c.desc, "Коллекция, вдохновлённая Голливудом");
  await store.patchMany([c._id], { title: "Круиз 2027", edited: true });
  await upsertCollection(store, { section, title: "Dior Cruise 2027 Kollektion", brand: "Dior" });
  assert.equal((await store.get(c._id)).title, "Круиз 2027");
  const prods = [{ _id: "product.manual.dior-a", status: "published", webSections: [section], images: [{ url: "https://x/a_SBG_E01" }, { url: "https://x/LOOK_F_27_1_E01" }] }, { _id: "product.manual.dior-b", status: "draft", webSections: [section] }, { _id: "product.manual.dior-c", status: "published", webSections: ["other"] }];
  let act = activeCollections(await store.list("collection", {}), prods);
  assert.equal(act.length, 1); assert.deepEqual(act[0].ids, ["product.manual.dior-a"]); assert.match(act[0].cover, /LOOK_/);
  await store.patchMany([c._id], { on: false });
  act = activeCollections(await store.list("collection", {}), prods); assert.equal(act.length, 0);
  await store.patchMany([c._id], { on: true, until: "2020-01-01" });
  assert.equal(activeCollections(await store.list("collection", {}), prods).length, 0); // срок показа прошёл
});
