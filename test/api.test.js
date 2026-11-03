import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, setStore } from "../lib/store.js";
import { setDnsCheck } from "../lib/http.js";
import handler from "../api/admin.js";
import catalog, { _resetCatalogMemo } from "../api/catalog.js";

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
  _resetCatalogMemo(); const r = await call(catalog);
  assert.equal(r.body.products.length, 1);
  assert.ok(!JSON.stringify(r.body).includes("700"));
  // лёгкий формат для витрины: только исходные адреса фото, без трёх копий каждой ссылки
  const c = await call(catalog, { query: { v: "2" } });
  // повторный запрос в течение 20 с — из памяти, без нового запроса к базе
  const c2 = await call(catalog, { query: { v: "2" } }); assert.deepEqual(c2.body, c.body);
  assert.deepEqual(c.body.products[0].im, ["https://cdn.sanity.io/images/p/d/a.jpg"]);
  assert.equal(c.body.products[0].images, undefined);
  assert.ok(!JSON.stringify(c.body).includes("700"));
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
  let c = (_resetCatalogMemo(), await call(catalog, { url: "/api/catalog" })).body.content;
  assert.deepEqual(c.banners.map(x => x.title), ["Осень"]); // будущий и выключенный не показываются
  assert.equal(c.banners[0].action.type, "category");
  assert.equal(c.stories[0].slides.length, 1); assert.equal(c.news[0].action.type, "none"); // небезопасная ссылка отброшена
  assert.equal(c.rails[0].value, "bags"); assert.ok(c.site.contacts.length);
  // правка, включение, порядок, удаление
  await post("cmsSave", { kind: "banner", item: { ...b3, title: "Включён", active: true } });
  await post("cmsReorder", { kind: "banner", ids: [b3._id, b1._id, b2._id] });
  c = (_resetCatalogMemo(), await call(catalog, { url: "/api/catalog" })).body.content;
  assert.deepEqual(c.banners.map(x => x.title), ["Включён", "Осень"]);
  await post("cmsActive", { ids: [b1._id], active: false });
  await post("cmsDelete", { ids: [b3._id] });
  c = (_resetCatalogMemo(), await call(catalog, { url: "/api/catalog" })).body.content;
  assert.equal(c.banners.length, 0);
  const s = (await post("siteSave", { site: { shipWeekday: 3, contacts: [{ label: "Менеджер", handle: "@m", url: "https://t.me/m" }], announce: { on: true, text: "Скидки" } } })).body.site;
  assert.equal(s.shipWeekday, 3); assert.equal(s.contacts.length, 1);
  // блок «В наличии»: по умолчанию скрыт, включается из раздела «В наличии» и сохраняется при других правках
  assert.equal(s.stockUa, false, "блок «В наличии» скрыт, пока его не включат");
  const s2 = (await post("siteSave", { site: { ...s, stockUa: true } })).body.site; assert.equal(s2.stockUa, true);
  const s3 = (await post("siteSave", { site: { ...s2, announce: { on: false, text: "" } } })).body.site; assert.equal(s3.stockUa, true);
  _resetCatalogMemo(); assert.equal((await call(catalog, { url: "/api/catalog" })).body.content.site.stockUa, true);
  await post("siteSave", { site: { ...s3, stockUa: false } });
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
  const other = await call(me, { method: "POST", body: { initData: "dev:556:Чужой" } });
  assert.equal(other.status, 404); assert.equal(other.body.code, "no_account"); // без регистрации аккаунт сам не создаётся и чужие заказы не видны
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

test("каталог под нагрузкой: одновременные запросы — одна сборка; база упала — отдаётся последний удачный каталог", async () => {
  _resetCatalogMemo();
  let calls = 0; const orig = store.list.bind(store);
  store.list = async (...a) => { if (a[0] === "product") calls++; await new Promise(r => setTimeout(r, 30)); return orig(...a); };
  const rs = await Promise.all(Array.from({ length: 50 }, () => call(catalog, { query: { v: "2" } })));
  assert.equal(calls, 1);
  assert.ok(rs.every(r => r.status === 200 && r.body.products.length === rs[0].body.products.length));
  // база недоступна, память устарела — витрина всё равно получает последний каталог
  store.list = async () => { throw new Error("Sanity query 503"); };
  _resetCatalogMemo(); // без памяти — честная ошибка 503
  const bad = await call(catalog, { query: { v: "2" } }); assert.equal(bad.status, 503);
  store.list = orig;
  const ok = await call(catalog, { query: { v: "2" } }); assert.equal(ok.status, 200);
  store.list = async () => { throw new Error("Sanity query 503"); };
  const realNow = Date.now; Date.now = () => realNow() + 60000; // память старше 20 с
  try { const st = await call(catalog, { query: { v: "2" } }); assert.equal(st.status, 200); assert.deepEqual(st.body.products, ok.body.products); }
  finally { Date.now = realNow; store.list = orig; _resetCatalogMemo(); }
});

test("кнопка «В Trend Büro»: товар одним запросом — сервер качает фото, сохраняет скрытым, цена +10%", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0];
  const real = globalThis.fetch;
  const jpg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z", "base64");
  globalThis.fetch = async u => String(u).includes("_A.jpg") ? new Response(jpg, { status: 200, headers: { "content-type": "image/jpeg" } }) : new Response("no", { status: 404 });
  try {
    const item = { brand: "Yves Saint Laurent", title: "SIMONE medium", category: "bags", gender: "w", boutique: 3200, images: ["https://saint-laurent.dam.kering.com/x/A0_A.jpg", "https://saint-laurent.dam.kering.com/x/A0_B.jpg"], markupPct: 10 };
    const r = await call(handler, { method: "POST", query: { a: "webImport" }, body: { id: "product.manual.ysl-a0", item }, headers: { cookie, "x-tb": "1" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.copied, 1); assert.equal(r.body.images, 1); assert.equal(r.body.price, 3520); // не скачавшееся фото не ставим (на витрине была бы пустая картинка)
    const p = await store.get("product.manual.ysl-a0");
    assert.equal(p.status, "incoming"); assert.equal(p.brand, "Saint Laurent"); // «Новые с сайтов» — ещё не в «Товарах»
    // удалили — кнопка больше не берёт (rejected); в общем списке «Новых» не видно
    const lst = await call(handler, { query: { a: "products" }, headers: { cookie } });
    assert.ok(!lst.body.products.some(x => x._id === "product.manual.ysl-a0")); assert.ok(lst.body.incoming >= 1);
    await call(handler, { method: "POST", query: { a: "productDelete" }, body: { ids: ["product.manual.ysl-a0"] }, headers: { cookie, "x-tb": "1" } });
    const kn = await call(handler, { query: { a: "knownProducts", prefix: "ysl" }, headers: { cookie } });
    assert.equal(kn.body.status.A0, "rejected");
    assert.ok(p.images[0].url.startsWith("https://cdn.sanity.io/")); assert.equal(p.images.length, 1); // обложка — первая, как на сайте; не скачалось — не берём
    const bad = await call(handler, { method: "POST", query: { a: "webImport" }, body: { id: "evil", item }, headers: { cookie, "x-tb": "1" } });
    assert.equal(bad.status, 400);
  } finally { globalThis.fetch = real; }
});

test("раздел «Новинки»: новый товар сохраняется новинкой на месяц, уже добавленный — отмечается новинкой", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0];
  const { saveManualProduct } = await import("../lib/manual.js");
  const p1 = await saveManualProduct(store, { id: "product.manual.ysl-n1", brand: "Saint Laurent", title: "Niki", category: "bags", boutique: 2000, images: ["https://x.test/a.jpg"], markupPct: 10, status: "draft", isNew: true });
  assert.equal(p1.overrides.isNew, "on"); assert.match(p1.overrides.newUntil, /^\d{4}-\d{2}-\d{2}$/);
  await saveManualProduct(store, { id: "product.manual.ysl-n2", brand: "Saint Laurent", title: "Loulou", category: "bags", boutique: 2100, images: ["https://x.test/b.jpg"], markupPct: 10, status: "published" });
  const r = await call(handler, { method: "POST", query: { a: "markNew" }, body: { ids: ["product.manual.ysl-n2", "product.u.zzz"] }, headers: { cookie, "x-tb": "1" } });
  assert.equal(r.body.marked, 1);
  const p2 = await store.get("product.manual.ysl-n2");
  assert.equal(p2.overrides.isNew, "on"); assert.equal(p2.status, "published"); // витрину не трогаем
});

test("новая коллекция: раздел пройден целиком — новый товар сразу на сайте с «Новинкой»; первый прогон — на отбор; Gürtel — аксессуары", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0], H = { cookie, "x-tb": "1" };
  const real = globalThis.fetch;
  const jpg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z", "base64");
  globalThis.fetch = async () => new Response(jpg, { status: 200, headers: { "content-type": "image/jpeg" } });
  try {
    const section = "dior.com/de_de/fashion/herrenmode/accessoires/gurtel";
    const item = n => ({ brand: "Dior", title: "Dior Médaillon Gürtel " + n, category: "other", gender: "m", boutique: 890, images: ["https://assets.christiandior.com/x/" + n + ".jpg"], markupPct: 10, section, sizeStock: [{ s: "90", ok: true }, { s: "95", ok: false }] });
    // первый прогон раздела: на отбор
    let r = await call(handler, { method: "POST", query: { a: "webImport" }, body: { id: "product.manual.dior-b1", item: item(1) }, headers: H });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.novelty, false);
    let p = await store.get("product.manual.dior-b1"); assert.equal(p.status, "incoming"); assert.equal(p.category, "accessories"); assert.equal(p.overrides?.isNew, undefined);
    // раздел пройден не целиком — следующий товар ещё не новинка
    await call(handler, { method: "POST", query: { a: "sectionSync" }, body: { prefix: "dior", section, codes: ["b1"], complete: false }, headers: H });
    r = await call(handler, { method: "POST", query: { a: "webImport" }, body: { id: "product.manual.dior-b2", item: item(2) }, headers: H });
    assert.equal(r.body.novelty, false);
    // пройден целиком — дальше всё новое: сразу на сайт, «Новинка»
    await call(handler, { method: "POST", query: { a: "sectionSync" }, body: { prefix: "dior", section, codes: ["b1", "b2"], complete: true }, headers: H });
    const realNow = Date.now; Date.now = () => realNow() + 60e3; // кэш разделов 30 с
    try { r = await call(handler, { method: "POST", query: { a: "webImport" }, body: { id: "product.manual.dior-b3", item: item(3) }, headers: H }); } finally { Date.now = realNow; }
    assert.equal(r.body.novelty, true); assert.equal(r.body.status, "published");
    p = await store.get("product.manual.dior-b3"); assert.equal(p.overrides.isNew, "on"); assert.ok(Date.parse(p.overrides.newUntil) > Date.now() + 55 * 864e5, "новинка живёт 2 месяца"); assert.deepEqual(p.sizes, ["90", "95"]);
    // выбрано «сначала мне» — новинка в «Новые с сайтов», но с отметкой
    await call(handler, { method: "POST", query: { a: "arrivalsSet" }, body: { mode: "incoming" }, headers: H });
    r = await call(handler, { method: "POST", query: { a: "webImport" }, body: { id: "product.manual.dior-b4", item: item(4) }, headers: H });
    assert.equal(r.body.novelty, true); assert.equal(r.body.status, "incoming");
    const ws = await call(handler, { query: { a: "webSections" }, headers: { cookie } });
    assert.equal(ws.body.arrivals, "incoming"); assert.equal(ws.body.sections.find(x => x.section === section).complete, true);
    // повторный неполный прогон не снимает отметку «пройден целиком»
    await call(handler, { method: "POST", query: { a: "sectionSync" }, body: { prefix: "dior", section, codes: ["b1"], complete: false }, headers: H });
    assert.equal((await store.get("settings.webSections")).list[section.replace(/[^a-zA-Z0-9_-]/g, "_")].complete, true);
    await call(handler, { method: "POST", query: { a: "arrivalsSet" }, body: { mode: "publish" }, headers: H });
  } finally { globalThis.fetch = real; }
});

test("копии страниц бренда для автопроверки кнопки: сохраняются по разделу, читаются через diag", async () => {
  process.env.TB_SNAPS = "1"; // по умолчанию копии не храним (место в базе); включается переменной
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0], H = { cookie, "x-tb": "1" };
  const { gzipSync } = await import("node:zlib"); const gz = s => gzipSync(Buffer.from(s)).toString("base64");
  const section = "dior.com/de_de/fashion/herrenmode/accessoires/gurtel";
  const r = await call(handler, { method: "POST", query: { a: "snapSave" }, body: { host: "dior.com", section, ver: "v54", list: { url: "https://www.dior.com/x", gz: gz("<html>list</html>"), got: { links: 58 } }, pages: [{ url: "https://www.dior.com/p", gz: gz("<html>p</html>"), got: { title: "Belt", sizes: ["90"] } }, { gz: "<script>" }] }, headers: H });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.pages, 1); // мусор отброшен
  const diag = (await import("../api/diag.js")).default;
  const L = await new Promise(res => diag({ method: "GET", url: "/api/diag?probe=snaps", headers: {} }, { statusCode: 200, setHeader() {}, end(b) { res(JSON.parse(b)); } }));
  const s = L.find(x => x.section === section); assert.ok(s); assert.equal(s.n, 1); assert.equal(s.lg.links, 58); assert.equal(s.pg[0].got.title, "Belt");
  const g = await new Promise(res => diag({ method: "GET", url: "/api/diag?probe=snap&id=" + s._id + "&i=0", headers: {} }, { statusCode: 200, setHeader() {}, end(b) { res(b); } }));
  assert.equal(gzipSync && (await import("node:zlib")).gunzipSync(Buffer.from(g, "base64")).toString(), "<html>p</html>");
});

test("фото по ссылке сайта бренда, которые не открываются: список для проверки и удаление (последнее фото остаётся)", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0], H = { cookie, "x-tb": "1" };
  const A = "https://assets.christiandior.com/is/image/diorprod/";
  await store.put({ _id: "product.manual.dior-kco576", _type: "product", brand: "Dior", title: "Bow", category: "shoes", status: "published", images: [{ url: A + "K_SBG_E02-8?x" }, { url: A + "K_SBG_E05?x" }], overrides: { cover: A + "K_SBG_E02-8?x" }, offers: [] });
  const h = await call(handler, { query: { a: "hotlinked" }, headers: { cookie } });
  assert.ok(h.body.list.find(p => p.id === "product.manual.dior-kco576").urls.length === 2);
  let r = await call(handler, { method: "POST", query: { a: "imgDrop" }, body: { id: "product.manual.dior-kco576", urls: [A + "K_SBG_E02-8?x"] }, headers: H });
  assert.equal(r.body.dropped, 1);
  const p = await store.get("product.manual.dior-kco576"); assert.deepEqual(p.images.map(i => i.url), [A + "K_SBG_E05?x"]); assert.equal(p.overrides.cover, null);
  r = await call(handler, { method: "POST", query: { a: "imgDrop" }, body: { id: "product.manual.dior-kco576", urls: [A + "K_SBG_E05?x"] }, headers: H });
  assert.equal(r.body.dropped, 0); // последнее фото не убираем
});

test("фото Dior с битой версией в адресе (…_E02-8) заменяется тем же кадром без версии; обложка из админки видна в списке", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0], H = { cookie, "x-tb": "1" };
  const A = "https://assets.christiandior.com/is/image/diorprod/";
  await store.put({ _id: "product.manual.dior-kco577", _type: "product", brand: "Dior", title: "Bow 2", category: "shoes", status: "incoming", images: [{ url: A + "K_SBG_E02-8?x" }, { url: A + "K_SBG_E05?x" }], overrides: { cover: A + "K_SBG_E02-8?x" }, offers: [] });
  const r = await call(handler, { method: "POST", query: { a: "imgDrop" }, body: { id: "product.manual.dior-kco577", urls: [], swap: { [A + "K_SBG_E02-8?x"]: A + "K_SBG_E02?x", [A + "K_SBG_E05?x"]: "https://evil.test/x.jpg" } }, headers: H });
  assert.equal(r.body.cover, A + "K_SBG_E02?x");
  const p = await store.get("product.manual.dior-kco577"); assert.deepEqual(p.images.map(i => i.url), [A + "K_SBG_E02?x", A + "K_SBG_E05?x"]); // чужой сайт в замене не принимаем
  await store.patchMany(["product.manual.dior-kco577"], { overrides: { cover: A + "K_SBG_E05?x" } });
  const l = await call(handler, { query: { a: "products", status: "incoming", q: "bow 2" }, headers: { cookie } });
  assert.equal(l.body.products.find(x => x._id === "product.manual.dior-kco577").cover, A + "K_SBG_E05?x");
});

test("прогон: на странице бренда фото больше, чем у товара, — фото дополняются, ваша обложка остаётся", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0], H = { cookie, "x-tb": "1" };
  const A = "https://assets.christiandior.com/is/image/diorprod/";
  const { saveManualProduct } = await import("../lib/manual.js");
  await saveManualProduct(store, { id: "product.manual.dior-kco578", brand: "Dior", title: "Bow 3", category: "shoes", boutique: 1000, images: [A + "KCO578_SBG_E05?x"], status: "published" });
  await store.patchMany(["product.manual.dior-kco578"], { imgVer: 5, overrides: { cover: A + "KCO578_SBG_E05?x" } });
  const real = globalThis.fetch; globalThis.fetch = async () => new Response("no", { status: 403 });
  try { const r = await call(handler, { method: "POST", query: { a: "webUpdate" }, body: { id: "product.manual.dior-kco578", item: { boutique: 1000, images: [A + "KCO578_SBG_E02?x", A + "KCO578_SBG_E05?x"] } }, headers: H }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  finally { globalThis.fetch = real; }
  const p = await store.get("product.manual.dior-kco578");
  assert.equal(p.images.length, 2); assert.equal(p.overrides.cover, A + "KCO578_SBG_E05?x");
});

test("удалили бренд целиком — ночная загрузка поставщика его не возвращает, обновление поставщика выключается", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0], H = { cookie, "x-tb": "1" };
  await store.put({ _id: "source.s-therow-test", _type: "sourceSettings", sourceId: "s-therow-test", schedule: "daily" });
  for (const n of [1, 2]) await store.put({ _id: "product.u.therow" + n, _type: "product", brand: "The Row", title: "Coat " + n, category: "clothing", status: "draft", offers: [{ sourceId: "s-therow-test" }] });
  const r = await call(handler, { method: "POST", query: { a: "productDelete" }, body: { ids: ["product.u.therow1", "product.u.therow2"] }, headers: H });
  assert.deepEqual(r.body.blockedBrands, ["The Row"]); assert.deepEqual(r.body.pausedSources, ["s-therow-test"]);
  assert.equal((await store.get("source.s-therow-test")).schedule, "off");
  assert.ok((await store.get("settings.blockedBrands")).list.includes("therow"));
});

test("названия на немецком (перевод упёрся в лимит) переводятся в фоне пачкой; лимит — останавливаемся", async () => {
  const login = await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } });
  const cookie = login.headers["set-cookie"].split(";")[0], H = { cookie, "x-tb": "1" };
  await store.put({ _id: "product.manual.dior-hut1", _type: "product", brand: "Dior", title: "Teddy-D Hut mit breiter Krempe", category: "accessories", status: "incoming", offers: [] });
  const real = globalThis.fetch, key = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = "test";
  globalThis.fetch = async (u, o) => { const items = JSON.parse(JSON.parse(o.body).contents[0].parts[0].text.split("\n\n").pop()); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(items.map(i => ({ title: i.title.includes("Teddy-D Hut") ? "Teddy-D Wide-Brim Hat" : i.title, description: "", colors: [] }))) }] } }] }), { status: 200 }); };
  try { const r = await call(handler, { method: "POST", query: { a: "trPending" }, headers: H }); assert.ok(r.body.done >= 1, JSON.stringify(r.body)); }
  finally { globalThis.fetch = real; if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; }
  const p = await store.get("product.manual.dior-hut1"); assert.equal(p.title, "Teddy-D Wide-Brim Hat"); assert.equal(JSON.parse(p.orig).title, "Teddy-D Hut mit breiter Krempe");
  globalThis.fetch = async () => new Response("", { status: 429 }); process.env.GEMINI_API_KEY = "test";
  await store.put({ _id: "product.manual.dior-hut2", _type: "product", brand: "Dior", title: "Hut mit kurzer Krempe", category: "accessories", status: "incoming", offers: [] });
  try { const r = await call(handler, { method: "POST", query: { a: "trPending" }, headers: H }); assert.equal(r.body.limited, true); }
  finally { globalThis.fetch = real; if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; }
});

test("закрытый сайт: заявка после входа, доступ из админки и из бота, каталог только с доступом", async () => {
  const { signSess } = await import("../lib/tgauth.js");
  const me = (await import("../api/me.js")).default, bot = (await import("../api/bot.js")).default, { hookSecret } = await import("../api/bot.js");
  const { resetAccessMemo } = await import("../lib/access.js");
  const T = "9:tok"; process.env.TELEGRAM_BOT_TOKEN = T; process.env.TELEGRAM_MANAGER_CHAT = "-100";
  const sent = [], f0 = globalThis.fetch;
  globalThis.fetch = async (u, o) => { sent.push({ m: String(u).split("/").pop(), b: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: "tb_bot" } }) }; };
  const ck = await adminCookie(), H = { cookie: ck, "x-tb": "1" };
  const auth = id => ({ "x-tb-auth": encodeURIComponent(JSON.stringify({ sess: signSess({ id, name: "N" + id }, T) })) });
  const cat = async h => { _resetCatalogMemo(); resetAccessMemo(); return call(catalog, { query: { v: "2" }, headers: h || {} }); };
  try {
    await store.put({ _id: "customer.11", _type: "customer", tg: { id: 11, name: "Старый" } });
    assert.equal((await cat()).status, 200, "пока открыт — всем");
    const r = await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: true }, headers: H });
    assert.ok(r.body.approved >= 1);
    assert.equal((await cat()).status, 403);
    assert.equal((await cat(auth(11))).status, 200, "старый клиент получил доступ");
    // новый: входит → ждёт, менеджеру уходит заявка с кнопками
    resetAccessMemo();
    const m = await call(me, { method: "POST", body: { sess: signSess({ id: 22, name: "Новый" }, T), a: "register", name: "Новый" } });
    assert.equal(m.body.access, "pending"); assert.deepEqual(m.body.orders, []);
    const ask = sent.find(x => x.m === "sendMessage" && x.b.chat_id === "-100");
    assert.equal(ask.b.reply_markup.inline_keyboard[0][0].callback_data, "ac:ok:22");
    assert.equal((await cat(auth(22))).status, 403);
    const n0 = sent.length; await call(me, { method: "POST", body: { sess: signSess({ id: 22, name: "Новый" }, T) } });
    assert.equal(sent.filter(x => x.b.chat_id === "-100").length, 1, "заявка менеджеру — один раз"); void n0;
    // кнопка из чужого чата не работает
    const run = body => new Promise(res => { const r = { statusCode: 0, setHeader() {}, end() { res(r); } }; bot({ method: "POST", headers: { "x-telegram-bot-api-secret-token": hookSecret(T), host: "x.test" }, body }, r); });
    await run({ callback_query: { id: "q1", data: "ac:ok:22", from: { id: 22 }, message: { chat: { id: 22 }, message_id: 1, text: "x" } } });
    assert.equal((await cat(auth(22))).status, 403);
    await run({ callback_query: { id: "q2", data: "ac:ok:22", from: { id: 5, username: "mgr" }, message: { chat: { id: -100 }, message_id: 1, text: "Заявка" } } });
    assert.equal((await cat(auth(22))).status, 200);
    assert.ok(sent.some(x => x.m === "sendMessage" && x.b.chat_id === 22), "клиенту сообщили");
    // закрыть из админки
    await call(handler, { method: "POST", query: { a: "accessSet" }, body: { customer: "customer.22", access: "blocked" }, headers: H });
    assert.equal((await cat(auth(22))).status, 403);
    const list = await call(handler, { query: { a: "customers" }, headers: { cookie: ck } });
    assert.equal(list.body.closed, true); assert.equal(list.body.customers.find(c => c.id === "customer.22").access, "blocked");
    // отклонить заявку из бота; заявка с Instagram доходит до менеджера
    resetAccessMemo();
    await call(me, { method: "POST", body: { sess: signSess({ id: 33, name: "Ира" }, T), a: "register", name: "Ира", insta: "https://instagram.com/ira.k", note: "от Анны" } });
    assert.ok(sent.some(x => x.b.chat_id === "-100" && /@ira\.k/.test(x.b.text) && /от Анны/.test(x.b.text)));
    await run({ callback_query: { id: "q3", data: "ac:no:33", from: { id: 5 }, message: { chat: { id: -100 }, message_id: 2, text: "Заявка" } } });
    assert.equal((await call(me, { method: "POST", body: { sess: signSess({ id: 33, name: "Ира" }, T) } })).body.access, "rejected");
    // пачкой
    await store.put({ _id: "customer.44", _type: "customer", tg: { id: 44 } }); await store.put({ _id: "customer.45", _type: "customer", tg: { id: 45 } });
    assert.equal((await call(handler, { method: "POST", query: { a: "accessSetMany" }, body: { customers: ["customer.44", "customer.45", "x"], access: "ok" }, headers: H })).body.n, 2);
    assert.equal((await cat(auth(45))).status, 200);
    await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: false }, headers: H });
    assert.equal((await cat()).status, 200);
    // удалить аккаунт: снова только через регистрацию → снова заявка
    await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: true }, headers: H }); resetAccessMemo();
    assert.equal((await call(handler, { method: "POST", query: { a: "customerDelete" }, body: { customer: "customer.45" }, headers: H })).status, 200);
    const gone = await call(me, { method: "POST", body: { sess: signSess({ id: 45, name: "X" }, T) } });
    assert.equal(gone.status, 404); assert.equal(gone.body.code, "no_account");
    assert.equal((await cat(auth(45))).status, 403);
    assert.equal((await call(me, { method: "POST", body: { sess: signSess({ id: 45, name: "X" }, T), a: "register", name: "X" } })).body.access, "pending");
    await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: false }, headers: H }); resetAccessMemo();
    // блок действует и на открытом сайте
    assert.equal((await cat(auth(22))).status, 403);
    assert.equal((await call(me, { method: "POST", body: { sess: signSess({ id: 22, name: "N" }, T) } })).body.access, "blocked");
    assert.equal((await cat(auth(45))).status, 200);
  } finally { globalThis.fetch = f0; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_MANAGER_CHAT; resetAccessMemo(); }
});

test("заявка на вход: клиенту «заявка принята» в боте, в админке счётчик новых заявок", async () => {
  const { signSess } = await import("../lib/tgauth.js");
  const me = (await import("../api/me.js")).default;
  const { resetAccessMemo } = await import("../lib/access.js");
  const T = "9:tok"; process.env.TELEGRAM_BOT_TOKEN = T;
  const sent = [], f0 = globalThis.fetch;
  globalThis.fetch = async (u, o) => { sent.push({ m: String(u).split("/").pop(), b: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; };
  const ck = await adminCookie(), H = { cookie: ck, "x-tb": "1" };
  try {
    await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: true }, headers: H }); resetAccessMemo();
    let p = await call(handler, { query: { a: "accessPending" }, headers: { cookie: ck } });
    const n0 = p.body.n;
    await call(me, { method: "POST", body: { sess: signSess({ id: 77, name: "Марта" }, T), a: "register", name: "Марта" } });
    assert.ok(sent.some(x => x.b.chat_id === 77 && /Заявка принята/.test(x.b.text)), "клиенту — заявка принята");
    p = await call(handler, { query: { a: "accessPending" }, headers: { cookie: ck } });
    assert.equal(p.body.n, n0 + 1); assert.equal(p.body.latest[0].name, "Марта");
    await call(handler, { method: "POST", query: { a: "accessSet" }, body: { customer: "customer.77", access: "ok" }, headers: H });
    assert.ok(sent.some(x => x.b.chat_id === 77 && /Доступ к приложению Trend Büro открыт/.test(x.b.text)));
    assert.equal((await call(handler, { query: { a: "accessPending" }, headers: { cookie: ck } })).body.n, n0);
  } finally { await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: false }, headers: H }); globalThis.fetch = f0; delete process.env.TELEGRAM_BOT_TOKEN; resetAccessMemo(); }
});

test("уведомления админу: подключить свой Telegram из админки одной ссылкой; заявки и кнопки работают из этого чата", async () => {
  const { signSess } = await import("../lib/tgauth.js");
  const me = (await import("../api/me.js")).default, bot = (await import("../api/bot.js")).default, { hookSecret } = await import("../api/bot.js");
  const { resetAccessMemo } = await import("../lib/access.js");
  const T = "9:tok"; process.env.TELEGRAM_BOT_TOKEN = T; delete process.env.TELEGRAM_MANAGER_CHAT;
  const sent = [], f0 = globalThis.fetch;
  globalThis.fetch = async (u, o) => { sent.push({ m: String(u).split("/").pop(), b: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: "tb_bot" } }) }; };
  const ck = await adminCookie(), H = { cookie: ck, "x-tb": "1" };
  const run = body => new Promise(res => { const r = { statusCode: 0, setHeader() {}, end() { res(r); } }; bot({ method: "POST", headers: { "x-telegram-bot-api-secret-token": hookSecret(T), host: "x.test" }, body }, r); });
  try {
    const link = await call(handler, { method: "POST", query: { a: "notifyLink" }, body: {}, headers: H });
    const code = link.body.url.match(/start=admin_([a-f0-9]{20})$/)[1];
    await run({ message: { chat: { id: 900 }, from: { id: 900, first_name: "Дмитрий", username: "dmytro" }, text: "/start admin_" + code } });
    assert.ok(sent.some(x => x.b.chat_id === 900 && /Готово/.test(x.b.text)));
    await run({ message: { chat: { id: 901 }, from: { id: 901 }, text: "/start admin_" + code } });
    assert.ok(sent.some(x => x.b.chat_id === 901 && /устарела/.test(x.b.text)), "ссылка одноразовая");
    const g = await call(handler, { query: { a: "notifyGet" }, headers: { cookie: ck } });
    assert.deepEqual(g.body.chats.map(c => c.id), ["900"]);
    await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: true }, headers: H }); resetAccessMemo();
    await call(me, { method: "POST", body: { sess: signSess({ id: 88, name: "Лена" }, T), a: "register", name: "Лена" } });
    assert.ok(sent.some(x => x.b.chat_id === "900" && /Заявка на вход/.test(x.b.text) && x.b.reply_markup));
    await run({ callback_query: { id: "q", data: "ac:ok:88", from: { id: 900 }, message: { chat: { id: 900 }, message_id: 1, text: "Заявка" } } });
    assert.equal((await call(me, { method: "POST", body: { sess: signSess({ id: 88, name: "Лена" }, T) } })).body.access, "ok");
    await call(handler, { method: "POST", query: { a: "notifyUnlink" }, body: { id: "900" }, headers: H });
    assert.equal((await call(handler, { query: { a: "notifyGet" }, headers: { cookie: ck } })).body.chats.length, 0);
  } finally { await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: false }, headers: H }); globalThis.fetch = f0; delete process.env.TELEGRAM_BOT_TOKEN; resetAccessMemo(); }
});

test("админ-бот: уведомления идут через отдельный бот; без его вебхука — кнопка «Открыть заявки в админке»", async () => {
  const { signSess } = await import("../lib/tgauth.js");
  const me = (await import("../api/me.js")).default, adminbot = (await import("../api/adminbot.js")).default, { hookSecret } = await import("../api/bot.js");
  const { resetAccessMemo, NOTIFY_ID } = await import("../lib/access.js");
  const T = "9:tok", A = "7:admintok"; process.env.TELEGRAM_BOT_TOKEN = T; process.env.TELEGRAM_ADMIN_BOT_TOKEN = A; process.env.PUBLIC_URL = "https://tb.test";
  const sent = [], f0 = globalThis.fetch; let hookUrl = "";
  globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body), m = String(u).split("/").pop(), tok = String(u).match(/bot([^/]+)\//)[1]; sent.push({ m, b, tok });
    if (m === "setWebhook") hookUrl = b.url;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: m === "getWebhookInfo" ? { url: hookUrl } : { username: tok === A ? "tb_admin0021_bot" : "tb_bot" } }) }; };
  const ck = await adminCookie(), H = { cookie: ck, "x-tb": "1" };
  try {
    await store.put({ _id: NOTIFY_ID, _type: "settings", chats: [{ id: 900, name: "Д" }] });
    await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: true }, headers: H }); resetAccessMemo();
    await call(me, { method: "POST", body: { sess: signSess({ id: 91, name: "Ян" }, T), a: "register", name: "Ян" } });
    const toAdm = sent.filter(x => x.b.chat_id === "900");
    assert.equal(toAdm.length, 1); assert.equal(toAdm[0].tok, A, "через админ-бот");
    assert.match(toAdm[0].b.reply_markup.inline_keyboard[0][0].web_app.url, /admin\.html#customers/);
    assert.ok(sent.some(x => x.b.chat_id === 91 && x.tok === T), "клиенту — от бота магазина");
    // подключить кнопки: вебхук админ-бота
    const st = await call(handler, { method: "POST", query: { a: "adminBotSetup" }, body: {}, headers: H });
    assert.equal(st.status, 200); assert.equal(hookUrl, "https://tb.test/api/adminbot");
    await call(me, { method: "POST", body: { sess: signSess({ id: 92, name: "Ника" }, T), a: "register", name: "Ника" } });
    const m2 = sent.filter(x => x.b.chat_id === "900").pop();
    assert.equal(m2.b.reply_markup.inline_keyboard[0][0].callback_data, "ac:ok:92");
    const run = body => new Promise(res => { const r = { statusCode: 0, setHeader() {}, end() { res(r); } }; adminbot({ method: "POST", headers: { "x-telegram-bot-api-secret-token": hookSecret(A) }, body }, r); });
    await run({ callback_query: { id: "q", data: "ac:ok:92", from: { id: 900 }, message: { chat: { id: 900 }, message_id: 1, text: "Заявка" } } });
    assert.equal((await call(me, { method: "POST", body: { sess: signSess({ id: 92, name: "Ника" }, T) } })).body.access, "ok");
    assert.ok(sent.some(x => x.m === "editMessageText" && x.tok === A));
    const bad = await new Promise(res => { const r = { statusCode: 0, setHeader() {}, end() { res(r); } }; adminbot({ method: "POST", headers: { "x-telegram-bot-api-secret-token": hookSecret(T) }, body: {} }, r); });
    assert.equal(bad.statusCode, 401, "чужой секрет не принимается");
    // занятый другим сервисом бот без «всё равно» не трогаем
    hookUrl = "https://other.example/hook";
    assert.equal((await call(handler, { method: "POST", query: { a: "adminBotSetup" }, body: {}, headers: H })).status, 409);
    assert.equal(hookUrl, "https://other.example/hook");
  } finally { await call(handler, { method: "POST", query: { a: "accessMode" }, body: { closed: false }, headers: H }); globalThis.fetch = f0; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_ADMIN_BOT_TOKEN; delete process.env.PUBLIC_URL; resetAccessMemo(); }
});

test("копии страниц по умолчанию не сохраняются; уборка базы удаляет копии и просроченные коды", async () => {
  delete process.env.TB_SNAPS;
  const ck = await adminCookie(), H = { cookie: ck, "x-tb": "1" };
  const r = await call(handler, { method: "POST", query: { a: "snapSave" }, body: { host: "x.com", section: "x.com/a", list: { url: "u", gz: "AAAA" } }, headers: H });
  assert.ok(!r.body.skipped, "первая копия сайта сохраняется");
  const r2 = await call(handler, { method: "POST", query: { a: "snapSave" }, body: { host: "x.com", section: "x.com/b", list: { url: "u", gz: "AAAA" } }, headers: H });
  assert.equal(r2.body.skipped, true, "вторая — нет");
  await store.put({ _id: "snap.old", _type: "snap", host: "y.com", at: "2020-01-01T00:00:00Z", list: { gz: "AAAA" } });
  await store.put({ _id: "product.manual.shop-262mzugnia357cbj62", _type: "product", title: "S", images: [{ url: "https://media.x.com/image/upload/w_1400/v1/262_D.jpg" }, { url: "https://media.x.com/image/upload/w_900/v1/262_D.jpg" }, { url: "https://media.x.com/image/upload/v2/PrenotaAppuntamento_2560x590.jpg" }, { url: "https://media.x.com/image/upload/v1/262_F.jpg" }] });
  await store.put({ _id: "weblogin." + "a".repeat(24), _type: "weblogin", exp: Date.now() - 1000 });
  await store.put({ _id: "weblogin." + "b".repeat(24), _type: "weblogin", exp: Date.now() + 60000 });
  const c = await call(handler, { method: "POST", query: { a: "dbCleanup" }, body: {}, headers: H });
  assert.ok(c.body.deleted >= 2);
  assert.equal(await store.get("snap.old"), null); assert.ok(await store.get("weblogin." + "b".repeat(24)));
  assert.equal((await store.get("product.manual.shop-262mzugnia357cbj62")).images.length, 2); assert.ok(c.body.tidied >= 1);
});

test("раздел бренда: удалённые вами и не прочитанные видны в «Сайтах брендов», «Вернуть» снимает удаление только у этого раздела", async () => {
  const ck = await adminCookie(), H = { cookie: ck, "x-tb": "1" };
  await store.put({ _id: "settings.deleted", _type: "settings", ids: ["product.manual.shop-aaa111", "product.manual.shop-bbb222", "product.manual.shop-zzz999", "product.manual.ysl-ccc"] });
  const r = await call(handler, { method: "POST", query: { a: "sectionSync" }, body: { prefix: "shop", section: "shop.x.com/sneakers/", codes: ["AAA111", "BBB222", "CCC333"], rejected: ["AAA111", "BBB222"], failed: ["DDD444"], url: "https://shop.x.com/sneakers/", title: "Sneakers" }, headers: H });
  assert.equal(r.status, 200);
  const w = await call(handler, { query: { a: "webSections" }, headers: { cookie: ck } });
  const s = w.body.sections.find(x => x.section === "shop.x.com/sneakers/");
  assert.deepEqual(s.rej, ["aaa111", "bbb222"]); assert.deepEqual(s.failed, ["ddd444"]);
  const u = await call(handler, { method: "POST", query: { a: "undeleteSection" }, body: { section: "shop.x.com/sneakers/" }, headers: H });
  assert.equal(u.body.restored, 2);
  assert.deepEqual((await store.get("settings.deleted")).ids, ["product.manual.shop-zzz999", "product.manual.ysl-ccc"], "другие удалённые не тронуты");
});

test("повторный прогон раздела не превращает куртку в «Другое»: категория кнопки «other» не затирает одежду", async () => {
  const cookie = (await call(handler, { method: "POST", query: { a: "login" }, body: { password: "test-password-123" } })).headers["set-cookie"].split(";")[0];
  const H = { cookie, "x-tb": "1" };
  const jpg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z", "base64");
  const real = globalThis.fetch; globalThis.fetch = async () => new Response(jpg, { status: 200, headers: { "content-type": "image/jpeg" } });
  try {
    const id = "product.manual.shop-cat1", item = { brand: "Brunello Cucinelli", title: "Daunenjacke mit Kapuze aus Shearling", category: "other", gender: "m", boutique: 5000, images: ["https://media.brunellocucinelli.com/x_F.jpg"], section: "shop.brunellocucinelli.com/de-de/herren/bekleidung/mantel-jacken/" };
    await call(handler, { method: "POST", query: { a: "webImport" }, body: { id, item }, headers: H });
    assert.equal((await store.get(id)).category, "clothing");
    const r = await call(handler, { method: "POST", query: { a: "webUpdate" }, body: { id, item: { ...item, images: [] } }, headers: H }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await store.get(id)).category, "clothing");
    await store.patchMany([id], { category: "other" }); // уже испорченный прошлым прогоном — чинится
    await call(handler, { method: "POST", query: { a: "webUpdate" }, body: { id, item: { ...item, images: [] } }, headers: H });
    assert.equal((await store.get(id)).category, "clothing");
  } finally { globalThis.fetch = real; }
});
