import { test } from "node:test";
import assert from "node:assert/strict";
import { rectFor } from "../lib/imgtrim.js";
// серая картинка w×h: фон bg, внутри прямоугольник «снимка/товара» с шумом
const img = (w, h, box, bg = 240) => { const px = new Uint8Array(w * h).fill(bg); const [x0, y0, x1, y1] = box;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * w + x] = 60 + ((x * 7 + y * 13) % 90); return { w, h, px }; };
const R = s => s.split(",").map(Number);
test("крупный план в широком холсте (Dior 3840×2160): вертикально 4:5 во всю высоту, полос нет", () => {
  const [x, y, w, h] = R(rectFor(img(200, 112, [42, 0, 157, 112]), 3840, 2160));
  assert.equal(y, 0); assert.equal(h, 2160); assert.ok(Math.abs(w / h - 0.8) < 0.01);
  assert.ok(x >= 42 * 19.2 - 1 && x + w <= 157 * 19.2 + 1, "только внутри снимка — полос не видно");
});
test("широкое фото без полос — тоже вертикально по центру, высота целиком", () => {
  const [x, y, w, h] = R(rectFor(img(200, 112, [0, 0, 200, 112]), 3840, 2160));
  assert.equal(h, 2160); assert.ok(Math.abs(w / h - 0.8) < 0.01); assert.ok(Math.abs(x + w / 2 - 1920) < 3);
});
test("мелкий товар в большой рамке — кадр 4:5 вокруг товара, товар целиком", () => {
  const [x, y, w, h] = R(rectFor(img(185, 200, [70, 80, 115, 125]), 1850, 2000));
  assert.ok(Math.abs(w / h - 0.8) < 0.01); assert.ok(x <= 700 && x + w >= 1150 && y <= 800 && y + h >= 1250);
});
test("вертикальное фото без полей и товар во всю ширину — не трогаем (товар не режем)", () => {
  assert.equal(rectFor(img(160, 200, [0, 0, 160, 200]), 1600, 2000), null);
  assert.equal(rectFor(img(200, 120, [0, 20, 200, 100]), 2000, 1200), null);
});
