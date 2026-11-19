/**
 * Работа с заказами — общая для админки и для сотрудника в приложении (роль «сотрудник»).
 * Каждая функция возвращает готовый ответ { code, body }.
 */
import { LEAD_STATUS, notifyClient } from "../api/lead.js";
import { setStage, sweep, deliveryLine, flowOf } from "./orderflow.js";
import { makeManualOrder, cleanProfile, createOfflineClient, cleanItems, mergeOffline } from "./customers.js";

const ok = body => ({ code: 200, body }), err = (code, error) => ({ code, body: { error } });
const s1 = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function opLeads(store, status, { lite = false } = {}) {
  try { await sweep(store, notifyClient); } catch (e) { console.log("[sweep]", e.message); }
  const where = LEAD_STATUS.includes(status) ? { status } : {};
  const [leads, fresh] = await Promise.all([store.list("lead", where, { order: "createdAt desc", limit: 300 }), store.count("lead", { status: "new" })]);
  // сотруднику в приложении — без закупочной цены и внутренних полей
  // запросы «это мой заказ» с личной ссылки клиента — показываем у его заказов
  const offIds = [...new Set(leads.filter(l => l.cust).map(l => l.cust))], offs = offIds.length ? (await Promise.all(offIds.map(id => store.get(id).catch(() => null)))).filter(c => c && (c.claims || []).length) : [];
  const oc = Object.fromEntries(offs.map(c => [c._id, c.claims]));
  const out = leads.map(l => oc[l.cust] ? { ...l, custClaims: oc[l.cust] } : l);
  return ok({ leads: lite ? out.map(({ cost, ...l }) => l) : out, fresh });
}

export async function opLeadSave(store, body, by) {
  const l = await store.get(body.id); if (!l || l._type !== "lead") return err(404, "Заявка не найдена");
  const now = new Date().toISOString();
  if (body.buyMode !== undefined) l.buyMode = body.buyMode === "online" ? "online" : "boutique";
  const changed = body.status && LEAD_STATUS.includes(body.status) && setStage(l, body.status, by);
  // откуда поедет посылка (подпись точки у клиента) и адрес доставки
  if (body.origin !== undefined) l.origin = s1(body.origin, 40);
  if (body.delivery && typeof body.delivery === "object") l.delivery = cleanProfile({ ...(l.delivery || {}), ...body.delivery }, (l.dest || "ua") === "ua");
  if (l.delivery && (l.delivery.city || l.delivery.address)) delete l.noAddress;
  if (body.note !== undefined) l.note = String(body.note).slice(0, 2000);
  // вещи заказа можно менять: добавить, убрать, поправить размер и цену — сумма пересчитывается
  if (Array.isArray(body.items)) { const it = cleanItems(body.items); const { fillCosts } = await import("./customers.js"); await fillCosts(store, it); if (!it.length) return err(400, "В заказе должна остаться хотя бы одна вещь"); l.items = it; l.total = it.reduce((a, i) => a + (i.price || 0), 0) || null; const c = it.reduce((a, i) => a + (i.cost || 0), 0); if (c) l.cost = c; }
  if (body.track !== undefined) l.track = String(body.track).replace(/[^\w\- ]/g, "").slice(0, 40);
  if (body.payLater !== undefined) l.payLater = !!body.payLater;
  if (body.handover !== undefined) { l.handover = !!body.handover; if (l.handover && l.status === "np") l.status = "ready"; if (!l.handover && l.status === "ready") l.status = "packed"; }
  if (body.paid !== undefined) l.paidAt = body.paid ? (l.paidAt || now) : "";
  if (body.cost !== undefined) { const c = Number(String(body.cost).replace(",", ".")); l.cost = c > 0 ? Math.round(c * 100) / 100 : null; }
  for (const k of ["buyCity", "buyDate", "shipDate", "npDate", "uaCity"]) if (body[k] !== undefined) l[k] = s1(body[k], 40);
  if (changed && body.notify !== false) l.clientNotified = await notifyClient(l, l.status);
  l.updatedAt = now; l.manager = by;
  return ok({ lead: await store.put(l) });
}

// пачкой: body.next — каждый заказ на ОДИН свой следующий этап (выкуплено → запаковано, запаковано → отправлено), без перескоков
export async function opLeadBulk(store, body, by) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 300), fixed = String(body.status || "");
  if (!body.next && !LEAD_STATUS.includes(fixed)) return err(400, "Неизвестный этап");
  let n = 0, sent = 0; const cnt = {};
  for (const id of ids) {
    const l = await store.get(id); if (!l || l._type !== "lead" || l.status === "cancelled") continue;
    let st = fixed;
    if (body.next) { const F = flowOf(l), i = F.indexOf(l.status); st = i >= 0 && i < F.length - 1 ? F[i + 1] : ""; if (!st) continue; }
    if (st === "bought") { // место выкупа ставим только тем, кто сейчас выкупается
      if (body.buyMode) l.buyMode = body.buyMode === "online" ? "online" : "boutique";
      if (body.origin) l.origin = s1(body.origin, 40);
      if (body.buyCity) l.buyCity = s1(body.buyCity, 40); }
    if (!setStage(l, st, by)) continue;
    if (body.notify !== false && await notifyClient(l, st)) { l.clientNotified = true; sent++; }
    l.manager = by; await store.put(l); n++; cnt[st] = (cnt[st] || 0) + 1;
  }
  return ok({ n, sent, by: cnt });
}

// список для водителя: что отправлено в Украину за последние N дней — товар, кому, куда
export async function opDriverList(store, daysIn) {
  const days = Math.min(30, Math.max(1, Number(daysIn) || 7)), since = Date.now() - days * 864e5;
  const ls = await store.list("lead", {}, { limit: 3000, order: "createdAt desc" });
  const rows = ls.filter(l => (l.dest || "ua") === "ua" && ["shipping", "np"].includes(l.status)).map(l => {
    const at = [...(l.history || [])].reverse().find(h => h.status === "shipping")?.at || l.updatedAt;
    if (Date.parse(at || 0) < since) return null;
    const d = deliveryLine(l);
    return { id: l._id, number: l.number, at, status: l.status, client: d.name || l.tg?.name || "", phone: d.phone || "", city: l.delivery?.city || "", place: d.place, items: (l.items || []).map(i => [i.brand, i.title, i.size].filter(Boolean).join(" ")).join("; "), payLater: !!l.payLater && !l.paidAt, total: l.total || 0 };
  }).filter(Boolean).sort((a, b) => a.city.localeCompare(b.city, "uk"));
  return ok({ rows, days });
}

// клиенты для выбора при новом заказе (коротко: имя, ник, телефон, город)
export async function opClientsLite(store) {
  const [cs, ls] = await Promise.all([store.list("customer", {}, { order: "lastSeen desc", limit: 1000 }), store.list("lead", { kind: "order" }, { limit: 5000, fields: "_id, tgId, cust, status, total, createdAt, items[]{brand, title}" })]);
  // сколько заказов, последний заказ и сумма — чтобы сразу было видно, кто это
  const st = {}; ls.forEach(l => { const k = String(l.tgId || l.cust || ""); if (!k || l.status === "cancelled") return; const x = st[k] = st[k] || { n: 0, sum: 0, last: "", lastItem: "" }; x.n++; x.sum += l.total || 0; if (String(l.createdAt) > x.last) { x.last = l.createdAt; x.lastItem = [(l.items || [])[0]?.brand, (l.items || [])[0]?.title].filter(Boolean).join(" "); } });
  return ok({ clients: cs.filter(c => !c.staff || c.offline).map(c => ({ ...(st[String(c.offline ? c._id : c.tg?.id)] || { n: 0, sum: 0, last: "", lastItem: "" }), seen: c.lastSeen || "", app: !c.offline, id: c._id, name: c.profile?.name || c.tg?.name || "", username: c.tg?.username || "", insta: c.insta || "", dv: c.profile ? { name: c.profile.name || "", phone: c.profile.phone || "", city: c.profile.city || "", npType: c.profile.npType || "branch", npPoint: c.profile.npPoint || "", address: c.profile.address || "" } : null, phone: c.profile?.phone || "", city: c.profile?.city || "", offline: !!c.offline })) });
}

export async function opManualOrder(store, body, by) {
  const c = await store.get(String(body.customer || ""));
  if (!c || c._type !== "customer") return err(404, "Клиент не найден");
  return ok({ lead: await makeManualOrder(store, c, body, by) });
}

export async function opClientCreate(store, body, by) {
  try { const c = await createOfflineClient(store, body, by); return ok({ id: c._id }); } catch (e) { return err(400, e.message); }
}

/* «это мой заказ»: менеджер подтверждает — заказ (и все заказы карточки без приложения) переходят в Telegram-аккаунт клиента; или отклоняет */
export async function opClaim(store, body, by) {
  const l = await store.get(String(body.id || "")); if (!l || l._type !== "lead") return err(404, "Заказ не найден");
  const tgId = Number(body.tgId); const off = l.cust ? await store.get(l.cust).catch(() => null) : null;
  const cl = [...(l.claims || []), ...((off && off.claims) || [])].find(x => Number(x.tgId) === tgId); if (!cl) return err(404, "Запрос не найден");
  const drop = a => (a || []).filter(x => Number(x.tgId) !== tgId);
  if (!body.ok) { l.claims = drop(l.claims); await store.put(l); if (off) { off.claims = drop(off.claims); await store.put(off); } return ok({ ok: true }); }
  const user = { id: tgId, username: cl.username || "", name: cl.name || "" };
  if (off && off.offline) { const r = await mergeOffline(store, user, off); const fresh = await store.get(l._id); if (fresh) { fresh.claims = []; fresh.manager = by; await store.put(fresh); } return ok({ moved: r.moved }); }
  l.tgId = tgId; l.tg = { id: tgId, username: user.username, name: user.name }; delete l.cust; l.claims = []; l.linkedAt = new Date().toISOString(); l.manager = by; await store.put(l);
  return ok({ moved: 1 });
}

/* ручное объединение: клиент «без приложения» (Instagram / WhatsApp) — это вот этот Telegram-аккаунт. Только вручную, система сама никого не склеивает. */
export async function opMerge(store, body, by) {
  const off = await store.get(String(body.off || "")), cu = await store.get(String(body.target || ""));
  if (!off || !off.offline) return err(404, "Клиент без приложения не найден");
  if (!cu || cu._type !== "customer" || cu.offline || !cu.tg?.id) return err(404, "Аккаунт Telegram не найден");
  const r = await mergeOffline(store, { id: cu.tg.id, username: cu.tg.username || "", name: cu.tg.name || "" }, off);
  return ok({ moved: r.moved, by });
}

/* одна покупка — несколько посылок: выбранные вещи уходят в отдельный заказ того же клиента со своим маршрутом (свой бутик, город, отправка).
   Заказы связаны group — клиент видит «Посилка 1 · 2 · 3» в одном заказе. */
export async function opSplit(store, body, by) {
  const l = await store.get(String(body.id || "")); if (!l || l._type !== "lead") return err(404, "Заказ не найден");
  const idx = [...new Set((Array.isArray(body.idx) ? body.idx : []).map(Number))].filter(i => i >= 0 && i < (l.items || []).length);
  if (!idx.length || idx.length >= l.items.length) return err(400, "Выберите вещь — в заказе должна остаться хотя бы одна");
  const { nextOrderNo, newOrderCode, ensureView } = await import("./customers.js"), now = new Date().toISOString();
  const group = l.group || "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const moved = l.items.filter((_, i) => idx.includes(i)), keep = l.items.filter((_, i) => !idx.includes(i));
  const sumP = a => a.reduce((s, i) => s + (i.price || 0), 0) || null, sumC = a => a.reduce((s, i) => s + (i.cost || 0), 0) || null;
  const { _id, _rev, number, code, view, claims, history, ...rest } = l;
  const nl = { ...rest, _id: "lead.s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), number: await nextOrderNo(store), code: await newOrderCode(store), group, items: moved, total: sumP(moved), cost: sumC(moved), prepaid: 0,
    history: [{ at: now, status: l.status, by, note: "отдельная посылка из " + (l.code || l.number) }], createdAt: l.createdAt, updatedAt: now, manager: by };
  await store.put(nl); await ensureView(store, await store.get(nl._id));
  l.items = keep; l.total = sumP(keep); l.cost = sumC(keep); l.group = group; l.updatedAt = now; l.manager = by; await store.put(l);
  return ok({ id: nl._id, group });
}

/* данные клиента без приложения: имя, Telegram, Instagram, телефон, город, размеры — и сразу во всех его заказах (как он подписан) */
export async function opClientEdit(store, body, by) {
  const c = await store.get(String(body.customer || ""));
  if (!c || c._type !== "customer") return err(404, "Клиент не найден");
  const { normInsta } = await import("./customers.js"), s1 = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  if (body.insta !== undefined) c.insta = normInsta(body.insta);
  if (!c.offline) { c.updatedAt = new Date().toISOString(); await store.put(c); return ok({ ok: true }); } // у клиентов из приложения имя и ник — из Telegram
  const username = String(body.username ?? c.tg?.username ?? "").replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").replace(/[^\w]/g, "").slice(0, 40);
  const name = s1(body.name, 80) || (c.insta ? "@" + c.insta : username ? "@" + username : c.profile?.name || "");
  c.tg = { username, name };
  c.profile = cleanProfile({ ...c.profile, name, phone: body.phone ?? c.profile?.phone, city: body.city ?? c.profile?.city });
  if (body.shoes !== undefined || body.clothes !== undefined) c.sizes = { shoes: s1(body.shoes ?? c.sizes?.shoes, 20), clothes: s1(body.clothes ?? c.sizes?.clothes, 20) };
  c.updatedAt = new Date().toISOString(); await store.put(c);
  for (const l of await store.list("lead", { cust: c._id }, { limit: 500 })) { l.tg = { ...(l.tg || {}), username, name }; await store.put(l); }
  return ok({ ok: true, name });
}
