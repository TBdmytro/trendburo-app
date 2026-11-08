/**
 * Перевод карточки товара с немецкого на английский (сайты брендов в Германии бывают только на немецком — LV и др.).
 * Переводим название, описание и цвета; цена, размеры и наличие не трогаем. Немецкий оригинал хранится рядом (orig).
 * Ключ — только на сервере (GEMINI_API_KEY). Ошибка перевода не мешает загрузке: товар сохранится как есть.
 */
import { createHash } from "node:crypto";

const DE_WORDS = /\b(und|aus|mit|der|die|das|für|aus|tasche|leder|damen|herren|schuhe|kleid|jacke|hose|mantel|gürtel|schwarz|weiß|braun|grün|blau|rot|grau|rosa|beige|größe|kalbsleder|wildleder|baumwolle|wolle|seide|umhängetasche|handtasche|halskette|armband|ohrringe|sonnenbrille|stiefel|turnschuhe|sneaker aus|hergestellt|maße|breite|höhe|tiefe|hut|hüte|krempe|breiter|kurzer|langer|kleine|kleiner|große|großer|mittelgroße|schulterriemen|reißverschluss|trageriemen|riemen|kappe|mütze|schirmmütze|glockenhut|fischerhut|sandalette|pantolette|stiefelette|halbschuh|rucksack|geldbörse|kartenetui|schal|tuch|jacke|hemd|pullover|strickjacke|kapuzenpullover)\b/gi;

// нидерландский (Dior, сайты Нидерландов/Бельгии)
const NL_WORDS = /\b(en|met|van|het|een|voor|leer|kalfsleer|zwart|wit|grijs|bruin|maat|soepel|vervaardigd|gemaakt|tas|schoudertas|jurk|jas|broek|riem|sjaal|zonnebril|kies|uw|deze|stijl)\b/gi;
/** Похоже ли на немецкий: умлауты/ß или несколько типичных немецких слов. */
export function looksGerman(...parts) {
  const t = parts.filter(Boolean).join(" ");
  if (!t.trim()) return false;
  if (/[äöüß]/i.test(t)) return true;
  const m = t.match(DE_WORDS) || [], n = t.match(NL_WORDS) || [];
  return new Set(m.map(x => x.toLowerCase())).size >= 2 || new Set(n.map(x => x.toLowerCase())).size >= 3;
}

export const trHash = (title, description, colors) => createHash("sha1").update([title || "", description || "", ...(colors || [])].join("\u0001")).digest("hex").slice(0, 16);

const PROMPT = `You translate luxury fashion product listings (German, Dutch or another European language) to English, the way the brand's own English website writes them.
Rules: keep brand names, model names and product line names exactly as written (e.g. "Neverfull MM", "LE LOAFER", "Monogram", "GG Marmont"); keep capitalization style of the original title;
use standard fashion terms (Kalbsleder → calfskin leather, Wildleder → suede, Umhängetasche → shoulder bag, Gürteltasche → belt bag); translate measurements labels but keep numbers and units;
color names in simple English (Schwarz → Black, Dunkelbraun → Dark Brown). Return JSON only.`;

const SCHEMA = { type: "OBJECT", properties: { title: { type: "STRING" }, description: { type: "STRING" }, colors: { type: "ARRAY", items: { type: "STRING" } } }, required: ["title", "colors"] };

// быстрые модели по очереди: перегрузка (503) или долгий ответ одной — пробуем следующую
const TR_MODELS = () => (process.env.GEMINI_TR_MODEL ? [process.env.GEMINI_TR_MODEL] : []).concat(["gemini-flash-lite-latest", "gemini-flash-latest"]);

async function askModel(model, payload, { key, fetchImpl, timeoutMs }) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT + "\n\n" + JSON.stringify(payload) }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA } })
    });
    if (!r.ok) { const m = r.status === 400 ? String((await r.json().catch(() => ({}))).error?.message || "").slice(0, 80) : ""; throw new Error("перевод: ответ " + r.status + " (" + model + ")" + (m ? " " + m : "")); }
    const j = await r.json();
    return JSON.parse(j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "");
  } catch (e) { throw new Error(e.name === "AbortError" ? "перевод: долго (" + model + ")" : e.message); }
  finally { clearTimeout(t); }
}

/** Перевести поля. Возвращает { title, description, colors } или бросает ошибку. */
// лимит перевода исчерпан (429 у всех моделей) — 10 минут не спрашиваем: иначе каждое сохранение товара с кнопки ждало два отказа подряд.
// Непереведённое потом доделывает «trPending» пачками
let TR_LIMIT_UNTIL = 0;
export const trLimited = () => Date.now() < TR_LIMIT_UNTIL;
export async function translateFields({ title = "", description = "", colors = [] }, { key = process.env.GEMINI_API_KEY, models = TR_MODELS(), fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!key) throw new Error("нет ключа перевода");
  if (trLimited()) throw new Error("перевод: ответ 429 (лимит, пауза)");
  let last; const errs = [];
  for (const model of models) {
    try {
      const o = await askModel(model, { title, description: description || "", colors }, { key, fetchImpl, timeoutMs });
      const out = { title: String(o.title || "").trim().slice(0, 120), description: String(o.description || "").trim().slice(0, 2000), colors: (Array.isArray(o.colors) ? o.colors : []).map(c => String(c).trim().slice(0, 60)) };
      if (out.title) return out;
      last = new Error("перевод: пустое название");
    } catch (e) { last = e; errs.push(e.message); }
  }
  if (errs.length && errs.every(m => /ответ 429/.test(m))) TR_LIMIT_UNTIL = Date.now() + 10 * 60e3;
  throw new Error(errs.join("; ") || (last && last.message) || "перевод не удался");
}

/**
 * Товар с кнопки: если текст немецкий — переводим. prev — сохранённый товар: если немецкий текст не менялся, берём прежний перевод (без нового запроса).
 * Возвращает новый объект item (title/description/colors/color на английском + orig с немецким) или исходный.
 */
export async function englishItem(it, prev = null, opts = {}) {
  const colorNames = Array.isArray(it.colors) && it.colors.length ? it.colors.map(c => c && c.name).filter(Boolean) : (it.color ? [it.color] : []);
  if (!looksGerman(it.title, it.description, colorNames.join(" "))) return it;
  const h = trHash(it.title, it.description, colorNames);
  let po = null; try { po = prev?.orig ? JSON.parse(prev.orig) : null; } catch {}
  let en = po?.h === h && po.en ? po.en : null;
  if (!en) en = await translateFields({ title: it.title, description: it.description, colors: colorNames }, opts);
  const cmap = new Map(colorNames.map((c, i) => [c, en.colors[i] || c]));
  return {
    ...it, title: en.title, description: en.description || it.description,
    colors: Array.isArray(it.colors) ? it.colors.map(c => c ? { ...c, name: cmap.get(c.name) || c.name } : c) : it.colors,
    color: it.color ? cmap.get(it.color) || it.color : it.color,
    // одной строкой: у базы лимит на число полей
    orig: JSON.stringify({ lang: "auto", h, title: it.title, description: it.description || null, colors: colorNames, en })
  };
}

const BSCHEMA = { type: "ARRAY", items: SCHEMA };
/**
 * Несколько товаров одним запросом (меньше запросов — реже упираемся в лимит бесплатного перевода).
 * items: [{ title, description, colors }] → [{ title, description, colors }] в том же порядке; при сбое — ошибка.
 */
export async function translateBatch(items, { key = process.env.GEMINI_API_KEY, models = TR_MODELS(), fetchImpl = fetch, timeoutMs = 40000 } = {}) {
  if (!key) throw new Error("нет ключа перевода");
  if (!items.length) return [];
  const errs = [];
  for (const model of models) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT + "\nTranslate every item of this JSON array; return an array of the same length and order.\n\n" + JSON.stringify(items.map(i => ({ title: i.title || "", description: i.description || "", colors: i.colors || [] }))) }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: BSCHEMA } })
      });
      if (!r.ok) throw new Error("перевод: ответ " + r.status + " (" + model + ")");
      const j = await r.json(), arr = JSON.parse(j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "[]");
      if (!Array.isArray(arr) || arr.length !== items.length) throw new Error("перевод: не тот ответ (" + model + ")");
      return arr.map(o => ({ title: String(o.title || "").trim().slice(0, 120), description: String(o.description || "").trim().slice(0, 2000), colors: (Array.isArray(o.colors) ? o.colors : []).map(c => String(c).trim().slice(0, 60)) }));
    } catch (e) { errs.push(e.name === "AbortError" ? "перевод: долго (" + model + ")" : e.message); }
    finally { clearTimeout(t); }
  }
  throw new Error(errs.join("; "));
}

/** Короткое описание коллекции на русском (одно предложение, до 140 знаков). При сбое — ошибка (вызывающий оставит оригинал). */
export async function translateRu(text, { key = process.env.GEMINI_API_KEY, models = TR_MODELS(), fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!key) throw new Error("нет ключа перевода");
  const errs = [];
  for (const model of models) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Перескажи по-русски одним коротким предложением (до 140 знаков), как анонс коллекции в модном журнале. Имена и названия не переводи. Только текст.\n\n" + text }] }], generationConfig: { temperature: 0.2 } })
      });
      if (!r.ok) throw new Error("перевод: ответ " + r.status);
      const j = await r.json(), out = String(j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "").replace(/\s+/g, " ").trim();
      if (out) return out;
      throw new Error("пусто");
    } catch (e) { errs.push(e.message); } finally { clearTimeout(t); }
  }
  throw new Error(errs.join("; "));
}
