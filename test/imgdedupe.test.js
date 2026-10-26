import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { dedupeImages, pngGray } from "../lib/imgdedupe.js";

function png(w, h, f) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.fill(f(x, y), y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3);
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); return b; };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const A = png(24, 30, x => (x < 12 ? 20 : 230)), B = png(24, 30, (x, y) => (y < 15 ? 20 : 230));
const U = k => "https://cdn.sanity.io/images/p/d/" + k;

test("дубли фото: одно фото в разных размерах — остаётся крупное; разные кадры одного размера не склеиваются", async () => {
  assert.equal(pngGray(A).px.length, 24 * 30);
  const map = { "a-2608x3260.jpg": A, "a-200x250.jpg": A, "a-600x750.jpg": A, "b-2608x3260.jpg": B, "c-2608x3260.jpg": A };
  const fetchImpl = async u => new Response(map[Object.keys(map).find(k => u.includes(k))], { status: 200 });
  const out = await dedupeImages([U("a-200x250.jpg"), U("a-2608x3260.jpg"), U("b-2608x3260.jpg"), U("a-600x750.jpg"), U("c-2608x3260.jpg"), "https://shop.test/x.jpg"], { fetchImpl });
  assert.deepEqual(out, [U("a-2608x3260.jpg"), U("b-2608x3260.jpg"), U("c-2608x3260.jpg"), "https://shop.test/x.jpg"]);
});
