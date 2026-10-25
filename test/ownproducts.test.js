import { test } from "node:test";
import assert from "node:assert/strict";
import { SanityStore } from "../lib/store.js";

// товары OPTIX в общей базе (id без «product.») не должны попадать в админку и на витрину Trend Büro
test("в списке и подсчёте товаров — только наши id «product.…»", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push(decodeURIComponent(String(url).replace(/\+/g, " ")) + (opts?.body || "")); return { ok: true, status: 200, json: async () => ({ result: [] }), text: async () => '{"result":[]}' }; };
  const s = new SanityStore({ projectId: "x", token: "t", fetchImpl });
  await s.list("product", { status: "published" }, { fields: "_id" });
  await s.count("product");
  await s.list("lead", {});
  assert.ok(seen[0].includes('_id in path("product.**")'), seen[0]);
  assert.ok(seen[1].includes('_id in path("product.**")'), seen[1]);
  assert.ok(!seen[2].includes("path("), seen[2]);
});
