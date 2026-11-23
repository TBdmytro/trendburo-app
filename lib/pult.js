/** Пульт сотрудника: заявки (отдельно от заказов — свой тип документа «req»), счётчики, поручения и агенты.
 *  Заявка ведётся по линии этапов: Новая → Взял → Нашли → Предложили → Заказ (или «Закрыта»). */
const ok = body => ({ code: 200, body }), err = (code, error) => ({ code, body: { error } });
const s1 = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const RSTAGES = ["new", "taken", "found", "offered", "order", "closed"];
const TYPES = ["bag", "shoes", "clothing", "jewelry", "accessory", "watch", "other"];

function reqOut(r) {
  const { _rev, _type, _createdAt, _updatedAt, ...x } = r; return x;
}

/** Всё для экрана «Пульт» одним запросом. */
export async function opPult(store) {
  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const [reqs, orders, incoming, cfg] = await Promise.all([
    store.list("req", {}, { order: "createdAt desc", limit: 300 }),
    store.list("lead", { kind: "order" }, { limit: 2000, fields: "status, test" }).catch(() => []),
    store.count("product", { status: "incoming" }).catch(() => 0),
    store.get("settings.pult").catch(() => null)]);
  const list = reqs.filter(r => r.stage !== "closed" || String(r.stageAt || r.createdAt) > since).map(reqOut);
  const now = Date.now(), urgent = list.filter(r => r.stage === "new" && now - Date.parse(r.createdAt) > 2 * 3600e3).length;
  const activeOrders = orders.filter(o => !o.test && !["delivered", "cancelled"].includes(o.status)).length;
  return ok({ reqs: list, counts: { reqs: list.filter(r => !["order", "closed"].includes(r.stage)).length, orders: activeOrders, approve: incoming + (cfg?.approveExtra || 0), urgent },
    approvals: (cfg?.approvals || []).slice(0, 12), tasks: (cfg?.tasks || []).slice(0, 30), agents: (cfg?.agents || []).slice(0, 12), agentsAt: cfg?.agentsAt || null });
}

/** Новая заявка с пульта (кнопка «+ Заявка»). */
export async function opReqNew(store, d, by) {
  const w = d.want && typeof d.want === "object" ? d.want : {};
  const want = { brand: s1(w.brand, 40), type: TYPES.includes(w.type) ? w.type : "", model: s1(w.model, 80), color: s1(w.color, 40), size: s1(w.size, 20), budget: Number(w.budget) > 0 ? Math.round(Number(w.budget)) : null };
  const img = /^https:\/\/[^\s]{8,600}$/.test(String(d.img || "")) ? String(d.img) : "";
  if (!want.brand && !want.model && !want.type && !img && !s1(d.note, 10)) return err(400, "Добавьте фото или опишите вещь");
  let cust = null, who = { name: s1(d.who?.name, 60), nick: s1(String(d.who?.nick || "").replace(/^@+/, ""), 40) };
  if (d.cust) { const c = await store.get(String(d.cust)).catch(() => null); if (c && c._type === "customer") { cust = c._id; who = { name: c.profile?.name || c.tg?.name || who.name, nick: c.tg?.username || c.insta || who.nick }; } }
  const { randomBytes } = await import("node:crypto");
  const code = randomBytes(3).toString("hex").toUpperCase(), now = new Date().toISOString();
  const doc = { _id: "req." + randomBytes(7).toString("hex"), _type: "req", code, stage: "new", stageAt: now, createdAt: now, by: s1(by, 80), source: ["pult", "bot", "voice", "client"].includes(d.source) ? d.source : "pult",
    cust, who, want, img, guess: d.guess && typeof d.guess === "object" ? Object.fromEntries(Object.entries(d.guess).filter(([k]) => /^[a-z]{2,10}$/.test(k)).slice(0, 10).map(([k, v]) => [k, !!v])) : {},
    matches: (Array.isArray(d.matches) ? d.matches : []).map(String).filter(x => /^product\.[a-z0-9._-]{3,120}$/.test(x)).slice(0, 3),
    note: s1(d.note, 500), history: [{ at: now, by: s1(by, 80), stage: "new" }] };
  await store.put(doc);
  return ok({ req: reqOut(doc) });
}

/** Этап, заметка, правка полей заявки. */
export async function opReqSave(store, d, by) {
  const r = await store.get(String(d.id || "")); if (!r || r._type !== "req") return err(404, "Заявка не найдена");
  const now = new Date().toISOString();
  if (d.stage && RSTAGES.includes(d.stage) && d.stage !== r.stage) { r.stage = d.stage; r.stageAt = now; r.history = [...(r.history || []).slice(-30), { at: now, by: s1(by, 80), stage: d.stage }]; if (d.stage === "taken" && !r.takenBy) r.takenBy = s1(by, 80); }
  if (d.note !== undefined) r.note = s1(d.note, 500);
  if (d.want && typeof d.want === "object") { const w = d.want; r.want = { ...(r.want || {}), ...(w.brand !== undefined ? { brand: s1(w.brand, 40) } : {}), ...(w.size !== undefined ? { size: s1(w.size, 20) } : {}), ...(w.color !== undefined ? { color: s1(w.color, 40) } : {}), ...(w.model !== undefined ? { model: s1(w.model, 80) } : {}), ...(w.budget !== undefined ? { budget: Number(w.budget) > 0 ? Math.round(Number(w.budget)) : null } : {}), ...(TYPES.includes(w.type) ? { type: w.type } : {}) }; }
  if (d.order) r.order = s1(d.order, 60);
  await store.put(r);
  return ok({ req: reqOut(r) });
}

const PARSE_PROMPT = `You read a screenshot or photo sent to a luxury personal-shopping service (clients from Ukraine; texts may be Ukrainian, Russian, German, English).
Find what the client wants. Return JSON only:
brand — fashion house if visible (logo, monogram, text) else "";
type — one of bag, shoes, clothing, jewelry, accessory, watch, other;
model — model/product name if readable (e.g. "Neverfull MM", "Le 19", "Love bracelet") else "";
color — main color in simple English;
size — size the client asks for (from text) else "";
budget — number in EUR if the client names a budget or the price is visible, else 0;
nick — Instagram/Telegram username of the CLIENT shown as the chat header or sender (without @), else "";
sure — object of booleans {brand, type, model, size, nick}: true only when clearly visible.`;
const PSCHEMA = { type: "OBJECT", properties: { brand: { type: "STRING" }, type: { type: "STRING" }, model: { type: "STRING" }, color: { type: "STRING" }, size: { type: "STRING" }, budget: { type: "NUMBER" }, nick: { type: "STRING" },
  sure: { type: "OBJECT", properties: { brand: { type: "BOOLEAN" }, type: { type: "BOOLEAN" }, model: { type: "BOOLEAN" }, size: { type: "BOOLEAN" }, nick: { type: "BOOLEAN" } } } }, required: ["brand", "type"] };

/** Разобрать скрин: бренд, тип, модель, цвет, размер, бюджет, ник клиента. Ошибка сервиса — пустой ответ, заявку заполняют руками. */
export async function opReqParse(d, { key = process.env.GEMINI_API_KEY, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const data = String(d.data || ""); if (!data || data.length > 4.8e6) return err(400, "Нет фото");
  const mime = /^\/9j\//.test(data) ? "image/jpeg" : /^iVBOR/.test(data) ? "image/png" : /^UklGR/.test(data) ? "image/webp" : null;
  if (!mime) return err(400, "Нужен JPEG, PNG или WebP");
  if (!key) return ok({ guess: null, why: "нет ключа распознавания" });
  const models = (process.env.GEMINI_VISION_MODEL ? [process.env.GEMINI_VISION_MODEL] : []).concat(["gemini-flash-latest", "gemini-flash-lite-latest"]);
  const errs = [];
  for (const model of models) {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: PARSE_PROMPT }, { inline_data: { mime_type: mime, data } }] }], generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: PSCHEMA } }) });
      if (!r.ok) throw new Error("ответ " + r.status);
      const j = await r.json(), g = JSON.parse(j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "{}");
      return ok({ guess: { brand: s1(g.brand, 40), type: TYPES.includes(g.type) ? g.type : "", model: s1(g.model, 80), color: s1(g.color, 40), size: s1(g.size, 20), budget: Number(g.budget) > 0 ? Math.round(Number(g.budget)) : null, nick: s1(String(g.nick || "").replace(/^@+/, ""), 40), sure: g.sure || {} } });
    } catch (e) { errs.push(e.name === "AbortError" ? "долго" : e.message); }
    finally { clearTimeout(t); }
  }
  console.log("REQPARSE fail " + errs.join("; "));
  return ok({ guess: null, why: "распознавание сейчас не отвечает" });
}

/** Поручения, одобрения и статус агентов на пульте — пишет Claude после работы. */
export async function setPult(store, patch) {
  const cur = (await store.get("settings.pult").catch(() => null)) || { _id: "settings.pult", _type: "settings" };
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch || {}).filter(([k]) => ["tasks", "agents", "approvals", "approveExtra", "agentsAt"].includes(k))), at: new Date().toISOString() };
  delete next._rev; delete next._createdAt; delete next._updatedAt;
  await store.put(next); return next;
}
