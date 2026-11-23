import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../lib/store.js";
import { opPult, opReqNew, opReqSave, opReqParse, setPult } from "../lib/pult.js";

test("пульт: заявка создаётся отдельно от заказов, ведётся по этапам, счётчики верные", async () => {
  const st = new MemoryStore();
  await st.put({ _id: "customer.1", _type: "customer", tg: { username: "marina.kyiv" }, profile: { name: "Марина" } });
  await st.put({ _id: "lead.o1", _type: "lead", kind: "order", status: "paid" });
  await st.put({ _id: "product.x", _type: "product", status: "incoming" });
  assert.equal((await opReqNew(st, { want: {} }, "Д")).code, 400, "пустая заявка не создаётся");
  const r = await opReqNew(st, { cust: "customer.1", want: { brand: "Chanel", type: "shoes", size: "38", budget: "2000" }, img: "https://cdn.sanity.io/x.jpg", guess: { brand: 1, evil$: 1 } }, "Дмитрий");
  assert.equal(r.code, 200); const q = r.body.req;
  assert.equal(q.stage, "new"); assert.equal(q.who.nick, "marina.kyiv"); assert.equal(q.want.budget, 2000); assert.deepEqual(q.guess, { brand: true });
  assert.equal((await st.list("lead", {})).length, 1, "в заказы заявка не попала");
  await setPult(st, { tasks: [{ t: "Дубли LV", st: "done" }], hacked: 1 });
  let p = (await opPult(st)).body;
  assert.equal(p.counts.reqs, 1); assert.equal(p.counts.orders, 1); assert.equal(p.counts.approve, 1); assert.equal(p.tasks.length, 1);
  assert.equal((await st.get("settings.pult")).hacked, undefined);
  const s2 = await opReqSave(st, { id: q._id, stage: "taken" }, "Аня"); assert.equal(s2.body.req.stage, "taken"); assert.equal(s2.body.req.takenBy, "Аня");
  await opReqSave(st, { id: q._id, stage: "order" }, "Аня"); p = (await opPult(st)).body; assert.equal(p.counts.reqs, 0);
  assert.equal((await opReqSave(st, { id: "lead.o1", stage: "taken" }, "x")).code, 404, "заказ этим не правится");
});

test("пульт: разбор скрина — ответ сервиса превращается в поля; сервис недоступен — пустая догадка без ошибки", async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
  const fake = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ brand: "Chanel", type: "shoes", model: "", color: "Black", size: "38", budget: 0, nick: "@marina.kyiv", sure: { brand: true } }) }] } }] }));
  const r = await opReqParse({ data: jpg }, { key: "k", fetchImpl: fake });
  assert.equal(r.body.guess.brand, "Chanel"); assert.equal(r.body.guess.nick, "marina.kyiv"); assert.equal(r.body.guess.budget, null);
  const bad = await opReqParse({ data: jpg }, { key: "k", fetchImpl: async () => new Response("", { status: 429 }) });
  assert.equal(bad.code, 200); assert.equal(bad.body.guess, null);
  assert.equal((await opReqParse({ data: "aGVsbG8=" }, { key: "k" })).code, 400, "не картинка");
});
