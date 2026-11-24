/** Вишлисты клиентов (макет «Вишлисты — готовое решение», 24.11.2026).
 *  wl.<code>  — список клиента: повод, дата, срок ссылки, настройки, вещи (цена фиксируется в день добавления)
 *  wlg.<hex>  — подарок/взнос друга (или доплата самого клиента): заявка → ссылка → «я оплатил» → деньги пришли
 *  Оплата пока вручную: менеджер вставляет ссылку из банка и подтверждает поступление в Пульте. */
const ok = body => ({ code: 200, body }), err = (code, error) => ({ code, body: { error } });
const s1 = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const OCC = ["birthday", "newyear", "wedding", "self", "other"];
const GST = ["new", "link", "claimed", "paid", "cancel", "refund"];
const MIN_PART = 20;
const rnd = async (n, abc = "abcdefghjkmnpqrstuvwxyz23456789") => { const { randomBytes } = await import("node:crypto"); const b = randomBytes(n); return [...b].map(x => abc[x % abc.length]).join(""); };
const now = () => new Date().toISOString();
const dateOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";

/** Конец действия ссылки: до даты повода + 14 дней · 3 месяца · бессрочно. */
function untilOf(term, date) {
  if (term === "forever") return null;
  if (term === "3m") return new Date(Date.now() + 92 * 864e5).toISOString();
  const d = dateOk(date) ? Date.parse(date + "T23:59:00Z") : Date.now() + 30 * 864e5;
  return new Date(d + 14 * 864e5).toISOString();
}
const alive = w => !w.until || Date.parse(w.until) > Date.now();
const left = it => Math.max(0, Math.round((it.price || 0) - (it.got || 0)));
const itemSt = it => it.order ? "order" : it.price && (it.got || 0) >= it.price ? "done" : (it.got || 0) > 0 ? "part" : "wait";

/** Снимок товара каталога для списка: название, бренд, фото, цена клиенту (UA) на сегодня. */
async function snap(store, pid) {
  const p = await store.get(String(pid || "")).catch(() => null);
  if (!p || p._type !== "product" || p.status !== "published") return null;
  const o = p.overrides || {}, img = (p.images || [])[0], price = Math.round(p.pricing?.ua || 0);
  return { pid: p._id, t: s1(o.title || p.title, 120), b: s1(o.brand || p.brand, 40), img: String(img?.url || img || "").slice(0, 600), price };
}

/** Для клиента-владельца: всё, кроме имён в режиме «сюрприз» до даты. */
function ownerView(w, gifts) {
  const surprise = w.opts?.surprise && w.date && Date.parse(w.date + "T23:59:00Z") > Date.now();
  const paid = gifts.filter(g => g.st === "paid");
  return { code: w.code, title: w.title, occasion: w.occasion, date: w.date || "", until: w.until || null, opts: w.opts || {},
    items: (w.items || []).map(it => ({ ...it, left: left(it), st: itemSt(it) })),
    total: paid.reduce((a, g) => a + g.amount, 0), people: new Set(paid.filter(g => !g.owner).map(g => g.name || g._id)).size,
    gifts: surprise ? [] : paid.filter(g => !g.owner).map(g => ({ k: g.k, amount: g.amount, name: g.anon ? "" : g.name, anon: !!g.anon, msg: g.msg || "", at: g.paidAt || g.createdAt })),
    pending: gifts.filter(g => g.owner && ["new", "link", "claimed"].includes(g.st)).map(g => ({ id: g._id, k: g.k, amount: g.amount, st: g.st, link: g.link || "" })),
    surprise: !!surprise };
}

// ---- клиент (вошёл через Telegram) ----
export async function wlMine(store, custId) {
  const L = (await store.list("wl", { owner: custId }, { limit: 30 })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const out = [];
  for (const w of L) { const gifts = await store.list("wlg", { wl: w.code }, { limit: 500 }).catch(() => []); out.push(ownerView(w, gifts)); }
  return ok({ lists: out });
}

export async function wlSave(store, custId, ownerName, d) {
  let w = d.code ? await store.get("wl." + String(d.code)).catch(() => null) : null;
  if (w && w.owner !== custId) return err(403, "Це не ваш вішліст");
  const opts = d.opts && typeof d.opts === "object" ? d.opts : {};
  if (!w) {
    const n = (await store.list("wl", { owner: custId }, { limit: 30 })).length; if (n >= 20) return err(400, "Забагато вішлістів");
    const code = await rnd(8);
    w = { _id: "wl." + code, _type: "wl", code, owner: custId, ownerName: s1(ownerName, 40), items: [], createdAt: now() };
  }
  if (d.title !== undefined) w.title = s1(d.title, 60) || "Мій вішліст";
  if (d.occasion !== undefined) w.occasion = OCC.includes(d.occasion) ? d.occasion : "other";
  if (d.date !== undefined) w.date = dateOk(d.date);
  if (d.term !== undefined) { w.term = ["date", "3m", "forever"].includes(d.term) ? d.term : "date"; w.until = untilOf(w.term, w.date); }
  else if (!w.until && !w.term) { w.term = "date"; w.until = untilOf("date", w.date); }
  w.opts = { part: opts.part !== undefined ? !!opts.part : w.opts?.part ?? true, anon: opts.anon !== undefined ? !!opts.anon : w.opts?.anon ?? true,
    surprise: opts.surprise !== undefined ? !!opts.surprise : w.opts?.surprise ?? false, prices: opts.prices !== undefined ? !!opts.prices : w.opts?.prices ?? true };
  w.updatedAt = now(); await store.put(w);
  return ok({ list: ownerView(w, await store.list("wlg", { wl: w.code }, { limit: 500 }).catch(() => [])) });
}

export async function wlItem(store, custId, d) {
  const w = await store.get("wl." + String(d.code || "")).catch(() => null);
  if (!w || w.owner !== custId) return err(404, "Вішліст не знайдено");
  if (d.del) { const it = (w.items || []).find(x => x.k === d.del); if (it && (it.got || 0) > 0) return err(400, "На цю річ уже дарували — напишіть менеджеру"); w.items = (w.items || []).filter(x => x.k !== d.del); }
  else {
    if ((w.items || []).length >= 40) return err(400, "У списку вже 40 речей");
    const sn = await snap(store, d.pid); if (!sn) return err(404, "Товар недоступний");
    const k = await rnd(6);
    w.items = [...(w.items || []), { k, ...sn, size: s1(d.size, 16), color: s1(d.color, 40), note: s1(d.note, 120), prio: d.prio === "nice" ? "nice" : "want", got: 0, addedAt: now() }];
  }
  w.updatedAt = now(); await store.put(w);
  return ok({ list: ownerView(w, await store.list("wlg", { wl: w.code }, { limit: 500 }).catch(() => [])) });
}

/** Клиент сам доплачивает остаток (или всю вещь) — менеджер пришлёт ссылку. */
export async function wlTopup(store, custId, d, notify) {
  const w = await store.get("wl." + String(d.code || "")).catch(() => null);
  if (!w || w.owner !== custId) return err(404, "Вішліст не знайдено");
  const it = (w.items || []).find(x => x.k === d.k); if (!it) return err(404, "Річ не знайдено");
  const amount = left(it); if (!amount) return err(400, "Річ уже зібрана");
  const g = await newGift(store, w, it, { amount, full: true, name: w.ownerName, owner: true, contact: s1(d.contact, 60) });
  if (notify) await notify(`💳 <b>Доплата</b> ${amount} € · ${w.ownerName || "клієнт"}\n${it.b} — ${it.t}\nВішліст «${w.title}» · потрібне посилання на оплату`);
  return ok({ gift: { id: g._id, amount, st: g.st } });
}

// ---- друг по ссылке (без входа) ----
export async function wlPublic(store, code) {
  if (!/^[a-z2-9]{8}$/.test(String(code || ""))) return err(404, "Вішліст не знайдено");
  const w = await store.get("wl." + code).catch(() => null);
  if (!w) return err(404, "Вішліст не знайдено");
  if (!alive(w)) return { code: 410, body: { error: "Термін дії посилання минув", expired: true } };
  const show = w.opts?.prices !== false;
  return ok({ code: w.code, title: w.title, occasion: w.occasion, date: w.date || "", owner: s1(w.ownerName, 40).split(" ")[0], opts: { part: w.opts?.part !== false, anon: w.opts?.anon !== false },
    items: (w.items || []).map(it => ({ k: it.k, pid: it.pid, t: it.t, b: it.b, img: it.img, size: it.size, color: it.color, note: it.note, prio: it.prio,
      st: itemSt(it), ...(show ? { price: it.price, got: Math.round(it.got || 0), left: left(it) } : { pct: it.price ? Math.min(100, Math.round((it.got || 0) / it.price * 100)) : 0 }) })) });
}

async function newGift(store, w, it, { amount, full, name, anon, msg, contact, owner }) {
  const id = "wlg." + await rnd(12), token = await rnd(16);
  const g = { _id: id, _type: "wlg", wl: w.code, owner: !!owner, k: it.k, item: `${it.b} — ${it.t}`, amount: Math.round(amount), full: !!full, name: s1(name, 40), anon: !!anon, msg: s1(msg, 300), contact: s1(contact, 60), token, st: "new", createdAt: now(), history: [{ at: now(), st: "new" }] };
  await store.put(g); return g;
}

export async function wlGift(store, d, notify) {
  const pub = await wlPublic(store, d.code); if (pub.code !== 200) return pub;
  const w = await store.get("wl." + d.code), it = (w.items || []).find(x => x.k === d.k);
  if (!it) return err(404, "Річ не знайдено");
  const rest = left(it); if (!rest) return err(400, "Цю річ уже подарували");
  // ещё не оплаченные заявки на эту вещь тоже держат сумму (чтобы двое не подарили одно и то же целиком)
  const open = (await store.list("wlg", { wl: w.code }, { limit: 500 })).filter(g => g.k === it.k && ["new", "link", "claimed"].includes(g.st)).reduce((a, g) => a + g.amount, 0);
  const free = Math.max(0, rest - open);
  const full = !!d.full; let amount = full ? free : Math.round(Number(d.amount) || 0);
  if (full && !free) return err(409, "Цю річ уже хтось дарує — оберіть іншу або внесіть частину пізніше");
  if (!full) { if (w.opts?.part === false) return err(400, "У цьому списку можна подарувати лише річ повністю"); if (amount < MIN_PART) return err(400, `Мінімум ${MIN_PART} €`); if (amount > free) amount = free; if (!amount) return err(409, "На цю річ уже вистачає заявок"); }
  const anon = !!d.anon && w.opts?.anon !== false, name = s1(d.name, 40), contact = s1(d.contact, 60);
  if (!contact) return err(400, "Вкажіть Telegram або телефон — туди надішлемо посилання на оплату");
  if (!anon && !name) return err(400, "Вкажіть ім’я або оберіть «Інкогніто»");
  const g = await newGift(store, w, it, { amount, full, name, anon, msg: d.msg, contact });
  if (notify) await notify(`🎁 <b>${amount} €</b> у вішліст «${w.title}» (${w.ownerName || "клієнт"})\n${it.b} — ${it.t}\nВід: ${anon ? "інкогніто (" + name + ")" : name} · ${contact}\nПотрібне посилання на оплату — Пульт → Вішлісти`);
  return ok({ token: g.token, amount });
}

export async function wlGiftStatus(store, token) {
  if (!/^[a-z2-9]{16}$/.test(String(token || ""))) return err(404, "Не знайдено");
  const [g] = await store.list("wlg", { token }, { limit: 1 }); if (!g) return err(404, "Не знайдено");
  const w = await store.get("wl." + g.wl).catch(() => null);
  return ok({ st: g.st, amount: g.amount, item: g.item, link: g.st === "link" || g.st === "claimed" ? g.link || "" : "", wl: g.wl, owner: s1(w?.ownerName, 40).split(" ")[0], title: w?.title || "", at: g.createdAt });
}

export async function wlClaim(store, token, notify) {
  const [g] = await store.list("wlg", { token: String(token || "") }, { limit: 1 }); if (!g) return err(404, "Не знайдено");
  if (g.st === "link") { g.st = "claimed"; g.history = [...(g.history || []), { at: now(), st: "claimed" }]; await store.put(g);
    if (notify) await notify(`✅ Гість натиснув «Я оплатив» · ${g.amount} € · ${g.item}\nПеревірте надходження — Пульт → Вішлісти`); }
  return ok({ st: g.st });
}

// ---- менеджер (Пульт) ----
export async function wlQueue(store) {
  const G = (await store.list("wlg", {}, { order: "createdAt desc", limit: 400 })).filter(g => ["new", "link", "claimed"].includes(g.st) || Date.now() - Date.parse(g.createdAt) < 14 * 864e5);
  const codes = [...new Set(G.map(g => g.wl))], W = new Map();
  for (const c of codes) { const w = await store.get("wl." + c).catch(() => null); if (w) W.set(c, w); }
  return ok({ gifts: G.map(g => ({ id: g._id, st: g.st, amount: g.amount, full: g.full, owner: g.owner, item: g.item, name: g.name, anon: g.anon, contact: g.contact, msg: g.msg, link: g.link || "", at: g.createdAt,
      wl: g.wl, wlTitle: W.get(g.wl)?.title || "", client: W.get(g.wl)?.ownerName || "" })),
    counts: { link: G.filter(g => g.st === "new").length, wait: G.filter(g => g.st === "link").length, check: G.filter(g => g.st === "claimed").length } });
}

export async function wlGiftSet(store, d, by) {
  const g = await store.get(String(d.id || "")).catch(() => null); if (!g || g._type !== "wlg") return err(404, "Не знайдено");
  const w = await store.get("wl." + g.wl).catch(() => null); if (!w) return err(404, "Вішліст не знайдено");
  const it = (w.items || []).find(x => x.k === g.k);
  if (d.link !== undefined) { const L = String(d.link || "").trim(); if (!/^https:\/\/[^\s]{6,800}$/.test(L)) return err(400, "Потрібне посилання https://…"); g.link = L; if (g.st === "new") g.st = "link"; }
  if (d.st && GST.includes(d.st) && d.st !== g.st) {
    if (d.st === "paid" && g.st !== "paid") { if (it) { it.got = Math.round((it.got || 0) + g.amount); w.updatedAt = now(); await store.put(w); } g.paidAt = now(); }
    if (g.st === "paid" && d.st !== "paid" && it) { it.got = Math.max(0, Math.round((it.got || 0) - g.amount)); await store.put(w); }
    g.st = d.st;
  }
  g.history = [...(g.history || []).slice(-20), { at: now(), st: g.st, by: s1(by, 60) }]; await store.put(g);
  return ok({ gift: { id: g._id, st: g.st, link: g.link || "" }, item: it ? { k: it.k, got: it.got, left: left(it), st: itemSt(it) } : null });
}

export async function wlStaffList(store, code) {
  const w = await store.get("wl." + String(code || "")).catch(() => null); if (!w) return err(404, "Вішліст не знайдено");
  const gifts = await store.list("wlg", { wl: w.code }, { limit: 500 });
  return ok({ list: { ...ownerView({ ...w, opts: { ...(w.opts || {}), surprise: false } }, gifts), client: w.ownerName, owner: w.owner }, log: gifts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 60).map(g => ({ id: g._id, st: g.st, amount: g.amount, name: g.name, anon: g.anon, item: g.item, at: g.paidAt || g.createdAt })) });
}

export async function wlItemOrder(store, d) {
  const w = await store.get("wl." + String(d.code || "")).catch(() => null); if (!w) return err(404, "Вішліст не знайдено");
  const it = (w.items || []).find(x => x.k === d.k); if (!it) return err(404, "Річ не знайдено");
  it.order = s1(d.order, 60) || "так"; await store.put(w); return ok({ ok: true });
}
