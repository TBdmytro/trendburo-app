import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, setStore } from "../lib/store.js";
import { setDnsCheck } from "../lib/http.js";
import handler from "../api/admin.js";
import catalog from "../api/catalog.js";

setDnsCheck(false);
process.env.ADMIN_PASSWORD = "test-password-123";
const store = new MemoryStore(); setStore(store);

function call(h, { method = "GET", query = {}, body, headers = {} } = {}) {
  return new Promise(resolve => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b ? JSON.parse(b) : null }); } };
    h({ method, query, body, headers, url: "/api/admin?" + new URLSearchParams(query) }, res);
  });
}

test("без входа импорт недоступен", async () => {
  const r = await call(handler, { method: "POST", query: { a: "jobCreate" }, body: { sourceId: "louis-vuitton", mode: "link", input: "https://de.louisvuitton.com/deu-de/products/x" }, headers: { "x-tb": "1" } });
  assert.equal(r.status, 401);
});
test("неверный пароль не пускает", async () => {
  const r = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "nope" } });
  assert.equal(r.status, 401);
});
test("после входа: без защитного заголовка запись запрещена, с ним — задача создаётся", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123", name: "Дмитрий" } });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"].split(";")[0];
  const noHdr = await call(handler, { method: "POST", query: { a: "jobCreate" }, body: { sourceId: "louis-vuitton", mode: "link", input: "https://de.louisvuitton.com/deu-de/products/x" }, headers: { cookie } });
  assert.equal(noHdr.status, 403);
  const ok = await call(handler, { method: "POST", query: { a: "jobCreate" }, body: { sourceId: "louis-vuitton", mode: "link", input: "https://de.louisvuitton.com/deu-de/products/x" }, headers: { cookie, "x-tb": "1" } });
  assert.equal(ok.status, 200); assert.equal(ok.body.job.createdBy, "Дмитрий");
  const src = await call(handler, { query: { a: "sources" }, headers: { cookie } });
  assert.equal(src.body.sources.find(s => s.id === "opticalh").connected, false);
  const bad = await call(handler, { method: "POST", query: { a: "sourceSave" }, body: { id: "dior", photoCopy: { allowed: true, basis: "" } }, headers: { cookie, "x-tb": "1" } });
  assert.equal(bad.status, 400);
  const prev = await call(handler, { method: "POST", query: { a: "pricingSave" }, body: { config: {} }, headers: { cookie, "x-tb": "1" } });
  assert.equal(prev.status, 400); // без предпросмотра правила цен не сохраняются
});
test("публичный каталог не отдаёт черновики и закупку", async () => {
  await store.put({ _id: "product.t", _type: "product", status: "draft", brand: "Dior", title: "X", pricing: { ua: 100 }, images: [], variants: [], offers: [] });
  await store.put({ _id: "product.p", _type: "product", status: "published", brand: "Dior", title: "Y", pricing: { ua: 1100, eu: 1080, dxb: 1080, purchase: 700, offerKey: "k" }, images: [{ url: "https://cdn.sanity.io/images/p/d/a.jpg" }], variants: [], offers: [{ _key: "k", purchase: 700, checkedAt: new Date().toISOString(), availability: {} }] });
  const r = await call(catalog);
  assert.equal(r.body.products.length, 1);
  assert.ok(!JSON.stringify(r.body).includes("700"));
});

async function adminCookie() {
  const r = await call(handler, { method: "POST", query: { a: "login" }, body: { name: "t", password: "test-password-123" } });
  return r.headers["set-cookie"].split(";")[0];
}

test("витрина из админки: баннеры, сторис, новости, подборки — создание, порядок, выключение, даты, удаление", async () => {
  const ck = await adminCookie(); const H = { cookie: ck, "x-tb": "1" };
  const post = (a, body) => call(handler, { method: "POST", query: { a }, body, headers: H });
  let r = await post("cmsSave", { kind: "banner", item: {} });
  assert.equal(r.status, 400); assert.match(r.body.error, /фото или заголовок/);
  const b1 = (await post("cmsSave", { kind: "banner", item: { title: "Осень", image: "https://cdn.sanity.io/images/x/y/1.jpg", action: { type: "category", value: "bags" } } })).body.item;
  const b2 = (await post("cmsSave", { kind: "banner", item: { title: "Скоро", from: "2099-01-01" } })).body.item;
  const b3 = (await post("cmsSave", { kind: "banner", item: { title: "Выкл", active: false } })).body.item;
  await post("cmsSave", { kind: "story", item: { title: "LV", slides: [{ image: "https://cdn.sanity.io/images/x/y/2.jpg", title: "Новинка" }] } });
  await post("cmsSave", { kind: "news", item: { title: "Новая коллекция", tag: "Новинка", text: "Текст", action: { type: "url", value: "javascript:alert(1)" } } });
  await post("cmsSave", { kind: "rail", item: { title: "Сумки", rule: "category", value: "bags" } });
  let c = (await call(catalog, { url: "/api/catalog" })).body.content;
  assert.deepEqual(c.banners.map(x => x.title), ["Осень"]); // будущий и выключенный не показываются
  assert.equal(c.banners[0].action.type, "category");
  assert.equal(c.stories[0].slides.length, 1); assert.equal(c.news[0].action.type, "none"); // небезопасная ссылка отброшена
  assert.equal(c.rails[0].value, "bags"); assert.ok(c.site.contacts.length);
  // правка, включение, порядок, удаление
  await post("cmsSave", { kind: "banner", item: { ...b3, title: "Включён", active: true } });
  await post("cmsReorder", { kind: "banner", ids: [b3._id, b1._id, b2._id] });
  c = (await call(catalog, { url: "/api/catalog" })).body.content;
  assert.deepEqual(c.banners.map(x => x.title), ["Включён", "Осень"]);
  await post("cmsActive", { ids: [b1._id], active: false });
  await post("cmsDelete", { ids: [b3._id] });
  c = (await call(catalog, { url: "/api/catalog" })).body.content;
  assert.equal(c.banners.length, 0);
  const s = (await post("siteSave", { site: { shipWeekday: 3, contacts: [{ label: "Менеджер", handle: "@m", url: "https://t.me/m" }], announce: { on: true, text: "Скидки" } } })).body.site;
  assert.equal(s.shipWeekday, 3); assert.equal(s.contacts.length, 1);
});

test("заявки: витрина отправляет, клиент видит статус, админ меняет статус; чужой ключ не видит", async () => {
  const lead = (await import("../api/lead.js")).default;
  const client = "abcdef0123456789abcd";
  let r = await call(lead, { method: "POST", body: { kind: "order", client, number: "TB-12345", message: "Заказ", items: [{ id: "product.x", brand: "LV", title: "Neverfull", price: 2420 }], total: 2420, dest: "ua" } });
  assert.equal(r.status, 200); assert.equal(r.body.number, "TB-1001"); // номер выдаёт сервер, по порядку
  assert.equal((await call(lead, { method: "POST", body: { kind: "order" } })).status, 400);
  const ck = await adminCookie(); const H = { cookie: ck, "x-tb": "1" };
  const list = (await call(handler, { query: { a: "leads" }, headers: H })).body;
  assert.equal(list.fresh, 1); const id = list.leads[0]._id;
  await call(handler, { method: "POST", query: { a: "leadSave" }, body: { id, status: "bought", note: "выкупили в Париже" }, headers: H });
  const mine = await new Promise(resolve => { const res = { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }; lead({ method: "GET", url: "/api/lead?client=" + client }, res); });
  assert.equal(mine.leads[0].status, "bought");
  const other = await new Promise(resolve => { const res = { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }; lead({ method: "GET", url: "/api/lead?client=zzzzzzzzzzzzzzzzzzzz" }, res); });
  assert.equal(other.leads.length, 0);
});

test("вход через Telegram: подпись initData проверяется, подделка не проходит", async () => {
  const { createHmac } = await import("node:crypto");
  const { verifyInitData } = await import("../lib/tgauth.js");
  const token = "123:abc", user = JSON.stringify({ id: 777, first_name: "Дмитрий", username: "dima" }), auth = String(Math.floor(Date.now() / 1000));
  const check = `auth_date=${auth}\nuser=${user}`;
  const hash = createHmac("sha256", createHmac("sha256", "WebAppData").update(token).digest()).update(check).digest("hex");
  const init = new URLSearchParams({ user, auth_date: auth, hash }).toString();
  assert.equal(verifyInitData(init, token).id, 777);
  assert.equal(verifyInitData(init.replace("777", "778"), token), null);
  assert.equal(verifyInitData(init, "999:zzz"), null);
  assert.equal(verifyInitData("dev:1:Тест", token), null); // тестовый вход выключен без DEV_AUTH
});

test("кабинет: профиль, доставка, заказ с маршрутом от менеджера; без подписи — 401", async () => {
  process.env.DEV_AUTH = "1";
  const me = (await import("../api/me.js")).default, lead = (await import("../api/lead.js")).default;
  assert.equal((await call(me, { method: "POST", body: {} })).status, 401);
  let r = await call(me, { method: "POST", body: { initData: "dev:555:Анна", a: "save", profile: { name: "Анна Ковальчук", phone: "+380 67 123 45 67", city: "Киев", npType: "locker", npPoint: "26814" } } });
  assert.equal(r.status, 200); assert.equal(r.body.profile.phone, "+380671234567"); assert.equal(r.body.profile.npType, "locker");
  r = await call(lead, { method: "POST", body: { kind: "order", client: "zzzz0123456789abcdef", initData: "dev:555:Анна", message: "Заказ", items: [{ id: "product.nope", brand: "LV", title: "X", price: 1 }], dest: "ua", delivery: { name: "Анна", phone: "+380671234567", city: "Киев", npPoint: "1" } } });
  assert.equal(r.status, 200); assert.match(r.body.number, /^TB-10\d\d$/);
  const ck = await adminCookie(); const H = { cookie: ck, "x-tb": "1" };
  const id = (await call(handler, { query: { a: "leads" }, headers: H })).body.leads.find(l => l.number === r.body.number)._id;
  await call(handler, { method: "POST", query: { a: "leadSave" }, body: { id, status: "shipping", buyCity: "Париж", buyDate: "2026-10-12", shipDate: "2026-10-17", npDate: "2026-10-19", notify: false }, headers: H });
  const o = (await call(me, { method: "POST", body: { initData: "dev:555:Анна" } })).body.orders.find(x => x.number === r.body.number);
  assert.equal(o.status, "shipping"); assert.equal(o.route.buyCity, "Париж"); assert.equal(o.route.shipDate, "2026-10-17");
  assert.equal(o.note, undefined); // заметки менеджера клиенту не видны
  const cl = (await call(handler, { query: { a: "customers" }, headers: H })).body.customers.find(c => c.tg.id === 555);
  assert.equal(cl.profile.npPoint, "26814"); assert.equal(cl.orders, 1);
  const other = (await call(me, { method: "POST", body: { initData: "dev:556:Чужой" } })).body.orders;
  assert.equal(other.length, 0);
  delete process.env.DEV_AUTH;
});

test("регистрация и вход: один Telegram — одна учётная запись; без токена вход честно выключен", async () => {
  const me = (await import("../api/me.js")).default;
  delete process.env.DEV_AUTH; delete process.env.TELEGRAM_BOT_TOKEN;
  assert.equal((await call(me, { method: "POST", body: { initData: "dev:1:Х" } })).body.code, "no_token");
  process.env.DEV_AUTH = "1";
  let r = await call(me, { method: "POST", body: { initData: "dev:900:Олег", a: "check" } });
  assert.equal(r.body.exists, false);
  r = await call(me, { method: "POST", body: { initData: "dev:900:Олег", a: "register", name: "Олег Петренко" } });
  assert.equal(r.body.profile.name, "Олег Петренко");
  r = await call(me, { method: "POST", body: { initData: "dev:900:Другое имя в Telegram", a: "check" } });
  assert.equal(r.body.exists, true); assert.equal(r.body.profile.name, "Олег Петренко"); // тот же id — тот же аккаунт, имя сохранено
  r = await call(me, { method: "POST", body: { initData: "dev:900:Олег", a: "register", name: "Повторно" } });
  assert.equal((await store.list("customer", {})).filter(c => c.tg.id === 900).length, 1); // дубля нет
  delete process.env.DEV_AUTH;
});
