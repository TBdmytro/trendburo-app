import { test } from "node:test";
import assert from "node:assert/strict";
import { rectFor } from "../lib/imgtrim.js";
// серая картинка w×h: фон bg, внутри прямоугольник «снимка» с шумом
const img = (w, h, box, bg = 240) => { const px = new Uint8Array(w * h).fill(bg); const [x0, y0, x1, y1] = box;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * w + x] = 60 + ((x * 7 + y * 13) % 90); return { w, h, px }; };
test("фото на модели в широком холсте: полосы по бокам обрезаются, сам снимок целиком (с отступом)", () => {
  const g = img(200, 112, [60, 0, 140, 112]); // 16:9, снимок по центру во всю высоту
  const r = rectFor(g, 3840, 2160).split(",").map(Number);
  assert.ok(r[0] > 900 && r[0] <= 60 * 19.2, "слева отрезано, но не больше полосы"); assert.equal(r[1], 0); assert.equal(r[3], 2160); // по высоте — целиком (лицо и ноги на месте)
  assert.ok(r[0] + r[2] >= 140 * 19.2, "снимок не обрезан справа");
});
test("мелкий товар в большой рамке — рамка убирается; обычный снимок товара не трогаем", () => {
  const tiny = rectFor(img(185, 200, [70, 80, 115, 125]), 1850, 2000); assert.ok(tiny);
  const [x, y, w, h] = tiny.split(",").map(Number); assert.ok(x <= 700 && x + w >= 1150 && y <= 800 && y + h >= 1250);
  assert.equal(rectFor(img(160, 200, [20, 30, 140, 170]), 1600, 2000), null); // товар занимает больше половины кадра
  assert.equal(rectFor(img(160, 200, [0, 0, 160, 200]), 1600, 2000), null); // полей нет
});
