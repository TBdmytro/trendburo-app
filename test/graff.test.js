import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStore } from "../lib/store.js";
import { buildDiaProduct, diaGroup, normStone } from "../lib/graff.js";
import { toStorefront } from "../lib/catalog.js";

test("Graff: группы карат вниз до ступени", () => {
  assert.equal(diaGroup(0.51), 0.5); assert.equal(diaGroup(0.551), 0.5); assert.equal(diaGroup(0.8), 0.7); assert.equal(diaGroup(0.92), 0.9);
  assert.equal(diaGroup(1.01), 1); assert.equal(diaGroup(1.33), 1); assert.equal(diaGroup(1.52), 1.5); assert.equal(diaGroup(2.01), 2);
});
test("Graff: перепутанные подписи цвет/чистота, мусор отбрасывается", () => {
  assert.deepEqual(normStone({ id: "A_GR1", ct: 0.51, col: "VVS2", cla: "H", p: 6100 }), { id: "A_GR1", ct: 0.51, col: "H", cla: "VVS2", p: 6100 });
  assert.equal(normStone({ id: "x", ct: 0.5, col: "Z", cla: "VS1", p: 10 }), null);
  assert.equal(normStone({ id: "x", ct: 0, col: "G", cla: "VS1", p: 10 }), null);
});
test("Graff: модель с камнями — в «Новые с сайтов», повтор обновляет камни, цена «от» — самый дешёвый", async () => {
  const st = new MemoryStore(), stones = JSON.parse(readFileSync(new URL("./fixtures/graff-op01.json", import.meta.url)));
  const d = { name: "Promise Oval Diamond Engagement Ring", mpn: "OP01", sku: "OP01ALL_OP01ALL", url: "https://www.graff.com/eu-en/x/OP01ALL_OP01ALL.html", description: "Oval", imgs: ["https://www.graff.com/dw/image/a.jpg"], st: stones };
  const r = await buildDiaProduct(st, d);
  assert.equal(r.id, "product.manual.graff-op01"); assert.equal(r.n, 31); assert.deepEqual(r.groups, { 0.5: 7, 0.7: 7, 0.9: 1, 1: 7, 1.5: 5, 2: 4 });
  const p = await st.get(r.id); assert.equal(p.status, "incoming"); assert.equal(p.brand, "Graff"); assert.equal(p.category, "jewelry"); assert.equal(p.offers[0].boutique, 6100);
  await st.patchEach([{ id: r.id, set: { status: "published" } }]);
  const r2 = await buildDiaProduct(st, { ...d, st: stones.slice(1) }); assert.equal(r2.created, false); assert.equal(r2.n, 30);
  const p2 = await st.get(r.id); assert.equal(p2.status, "published", "статус не трогаем"); assert.equal(p2.offers[0].boutique, 6500); assert.equal(p2.dia.list.length, 30);
  const pub = toStorefront(p2); assert.equal(pub.dia.list.length, 30); assert.equal(pub.dia.base, 6500); assert.deepEqual(pub.dia.list[0], [0.5, "G", "VVS2", 6500]);
  await assert.rejects(buildDiaProduct(st, { ...d, st: [] }), /Нет камней/);
});
test("Graff: обручальное кольцо без камней — одна цена, без dia; название с подписью", async () => {
  const st = new MemoryStore();
  const r = await buildDiaProduct(st, { name: "Laurence Graff Signature Diamond Band", sub: "WHITE GOLD, 0.75 CARAT", mpn: "RGR449", sku: "RGR449ALL_RGR449", url: "https://www.graff.com/eu-en/x.html", imgs: ["https://www.graff.com/dw/image/b.jpg"], st: [], price: 8200, g: "u" });
  const p = await st.get(r.id); assert.equal(p.title, "Laurence Graff Signature Diamond Band, White Gold, 0.75 Carat"); assert.equal(p.offers[0].boutique, 8200); assert.equal(p.dia, null); assert.equal(p.gender, "u");
  await assert.rejects(buildDiaProduct(st, { name: "x", mpn: "Z1", st: [], price: 0 }), /Нет камней/);
});
test("Graff: жёлтые бриллианты и цветные камни без характеристик", () => {
  assert.deepEqual(normStone({ id: "Y_GR1", ct: 1.08, col: "F.V.Y", cla: "VS1", p: 65500 }), { id: "Y_GR1", ct: 1.08, col: "F.V.Y", cla: "VS1", p: 65500 });
  assert.equal(normStone({ id: "Y_GR2", ct: 1, col: "VS2", cla: "F.Y", p: 26000 }).col, "F.Y");
  assert.deepEqual(normStone({ id: "R_GR3", ct: 1.52, col: "null", cla: "null", p: 62000 }), { id: "R_GR3", ct: 1.52, col: "", cla: "", p: 62000 });
  assert.equal(normStone({ id: "x", ct: 1, col: "G", cla: "null", p: 5 }), null);
});
test("Graff: серьги — своя подкатегория, запонки без подкатегории", async () => {
  const st = new MemoryStore();
  const a = await buildDiaProduct(st, { name: "Classic Graff Diamond Stud Earrings", sub: "platinum", mpn: "RGE1", sku: "RGE1", imgs: [], st: [], price: 9000, cat2: "earrings" });
  assert.equal((await st.get(a.id)).subcategory, "earrings");
  const b = await buildDiaProduct(st, { name: "Diamond Cufflinks", mpn: "CL1", sku: "CL1", imgs: [], st: [], price: 5000, cat2: "", g: "m" });
  assert.ok(!(await st.get(b.id)).subcategory || (await st.get(b.id)).subcategory !== "rings");
});
