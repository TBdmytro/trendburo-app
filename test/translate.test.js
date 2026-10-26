import test from "node:test";
import assert from "node:assert/strict";
import { looksGerman, englishItem } from "../lib/translate.js";

const fake = (calls) => async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "Neverfull MM Tote", description: "Monogram canvas tote with natural cowhide-leather trim.", colors: ["Brown"] }) }] } }] }) }; };

test("перевод: распознаём немецкий, английский не трогаем", () => {
  assert.equal(looksGerman("Neverfull MM Tasche", "Aus Monogram Canvas mit Rindsleder"), true);
  assert.equal(looksGerman("LE LOAFER supple in suede", "Loafers in suede with YSL hardware"), false);
  assert.equal(looksGerman("Umhängetasche"), true);
});

test("перевод: немецкий товар → английский, оригинал хранится; повтор без нового запроса", async () => {
  const calls = [];
  const it = { title: "Neverfull MM Tasche", description: "Aus Monogram Canvas mit Rindsleder", colors: [{ name: "Braun", image: "x" }], boutique: 2000 };
  const en = await englishItem(it, null, { key: "k", fetchImpl: fake(calls) });
  assert.equal(en.title, "Neverfull MM Tote");
  assert.equal(en.colors[0].name, "Brown");
  assert.equal(en.boutique, 2000);
  assert.equal(JSON.parse(en.orig).title, "Neverfull MM Tasche");
  assert.equal(calls.length, 1);
  const again = await englishItem(it, { orig: en.orig }, { key: "k", fetchImpl: fake(calls) });
  assert.equal(again.title, "Neverfull MM Tote");
  assert.equal(calls.length, 1);
  const eng = await englishItem({ title: "LE LOAFER supple in suede" }, null, { key: "k", fetchImpl: fake(calls) });
  assert.equal(eng.title, "LE LOAFER supple in suede");
  assert.equal(calls.length, 1);
});
