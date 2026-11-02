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
