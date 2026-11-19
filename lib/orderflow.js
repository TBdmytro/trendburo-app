// Этапы заказа и автоматика (Trend Büro).
// Викуп в бутику:   Оплачено → Викуплено → Запаковано → Відправлено → [Україна: Нова пошта] → Отримано
// Заказ на сайте:   Оплачено → Замовлено → Отримали ми → Запаковано → Відправлено → …
// Сами: «Запаковано» — в ближайшую пятницу 12:00 (Берлин), если выкупили в пятницу — через 2 часа;
//       «Отримано» — через 3 дня после Новой почты (или раньше, если клиент нажал «Я отримав»).

export const flowOf = l => ["new", "work", ...(l.payLater ? [] : ["paid"]), "bought", ...(l.buyMode === "online" ? ["received"] : []), "packed", ...(l.handover ? [...((l.dest || "ua") === "ua" ? ["shipping"] : []), "ready"] : ["shipping", ...((l.dest || "ua") === "ua" ? ["np"] : [])]), "delivered"]; // лично в руки: вместо Новой почты — «Готово до передачі», потом «Передано»

const berlinOffset = d => new Date(d.toLocaleString("en-US", { timeZone: "Europe/Berlin" })) - new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));

/** Когда заказ станет «Запаковано»: ближайшая пятница 12:00 по Берлину; в пятницу — через 2 часа. */
export function packAtFrom(now = new Date()) {
  const loc = new Date(now.getTime() + berlinOffset(now)), dow = loc.getUTCDay();
  if (dow === 5) return new Date(now.getTime() + 2 * 3600e3).toISOString();
  const add = (5 - dow + 7) % 7, t = new Date(Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate() + add, 12, 0));
  return new Date(t.getTime() - berlinOffset(t)).toISOString();
}

export const DELIVERED_AFTER_DAYS = 3;

/** Поставить этап (вручную или пачкой). Возвращает true, если этап сменился. */
export function setStage(l, status, by, now = new Date()) {
  if (!status || status === l.status) return false;
  const at = now.toISOString();
  l.history = [...(l.history || []).slice(-30), { at, status, by }]; l.status = status; l.updatedAt = at;
  if ((status === "bought" && l.buyMode !== "online") || status === "received") l.packAt = packAtFrom(now);
  if (status === "np") l.npAt = at;
  return true;
}

/** Автоматические переходы. notify(lead, status) — сообщение клиенту. Возвращает true, если заказ изменён. */
export async function autoAdvance(l, notify, now = new Date()) {
  const t = now.getTime();
  if (((l.status === "bought" && l.buyMode !== "online") || l.status === "received") && l.packAt && Date.parse(l.packAt) <= t) {
    setStage(l, "packed", "авто", new Date(Math.max(Date.parse(l.packAt), Date.parse(l.updatedAt || 0) || 0))); return true; // «Запаковано» — без сообщения
  }
  const npAt = l.npAt || [...(l.history || [])].reverse().find(h => h.status === "np")?.at;
  if (l.status === "np" && npAt && Date.parse(npAt) + DELIVERED_AFTER_DAYS * 864e5 <= t) {
    setStage(l, "delivered", "авто", now); if (notify) l.clientNotified = await notify(l, "delivered"); return true;
  }
  return false;
}

/** Прогнать автоматику по всем заказам в работе (для админки и ежедневного cron). */
export async function sweep(store, notify) {
  const ls = await store.list("lead", {}, { limit: 3000, order: "createdAt desc" });
  let n = 0;
  for (const l of ls) if (["bought", "received", "np"].includes(l.status) && await autoAdvance(l, notify)) { await store.put(l); n++; }
  return n;
}

/** Куда едет посылка: для клиента и для водителя. */
export function deliveryLine(l) {
  const d = l.delivery || {}, NPT = { branch: "відділення", locker: "поштомат", courier: "курʼєр" };
  const place = (l.dest || "ua") === "ua" ? [d.city, d.npType === "courier" ? d.address : d.npPoint ? `${NPT[d.npType] || "відділення"} №${d.npPoint}` : ""].filter(Boolean).join(", ") : [d.city, d.address].filter(Boolean).join(", ");
  if (l.handover) return { carrier: "hand", name: d.name || "", phone: d.phone || "", place: "🤝 в руки" + ([d.city, d.address].filter(Boolean).length ? ": " + [d.city, d.address].filter(Boolean).join(", ") : "") };
  return { carrier: (l.dest || "ua") === "ua" ? "np" : "dhl", name: d.name || "", phone: d.phone || "", place };
}
