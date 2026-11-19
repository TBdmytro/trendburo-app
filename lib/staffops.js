/**
 * Работа с заказами — общая для админки и для сотрудника в приложении (роль «сотрудник»).
 * Каждая функция возвращает готовый ответ { code, body }.
 */
import { LEAD_STATUS, notifyClient } from "../api/lead.js";
import { setStage, sweep, deliveryLine, flowOf } from "./orderflow.js";
import { makeManualOrder, cleanProfile, createOfflineClient } from "./customers.js";

const ok = body => ({ code: 200, body }), err = (code, error) => ({ code, body: { error } });
const s1 = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function opLeads(store, status, { lite = false } = {}) {
  try { await sweep(store, notifyClient); } catch (e) { console.log("[sweep]", e.message); }
  const where = LEAD_STATUS.includes(status) ? { status } : {};
  const [leads, fresh] = await Promise.all([store.list("lead", where, { order: "createdAt desc", limit: 300 }), store.count("lead", { status: "new" })]);
  // сотруднику в приложении — без закупочной цены и внутренних полей
  return ok({ leads: lite ? leads.map(({ cost, ...l }) => l) : leads, fresh });
}

export async function opLeadSave(store, body, by) {
  const l = await store.get(body.id); if (!l || l._type !== "lead") return err(404, "Заявка не найдена");
  const now = new Date().toISOString();
  if (body.buyMode !== undefined) l.buyMode = body.buyMode === "online" ? "online" : "boutique";
  const changed = body.status && LEAD_STATUS.includes(body.status) && setStage(l, body.status, by);
  // откуда поедет посылка (подпись точки у клиента) и адрес доставки
  if (body.origin !== undefined) l.origin = s1(body.origin, 40);
  if (body.delivery && typeof body.delivery === "object") l.delivery = cleanProfile({ ...(l.delivery || {}), ...body.delivery });
  if (l.delivery && (l.delivery.city || l.delivery.address)) delete l.noAddress;
  if (body.note !== undefined) l.note = String(body.note).slice(0, 2000);
  if (body.track !== undefined) l.track = String(body.track).replace(/[^\w\- ]/g, "").slice(0, 40);
  if (body.payLater !== undefined) l.payLater = !!body.payLater;
  if (body.paid !== undefined) l.paidAt = body.paid ? (l.paidAt || now) : "";
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
