/**
 * Перевод карточки товара с немецкого на английский (сайты брендов в Германии бывают только на немецком — LV и др.).
 * Переводим название, описание и цвета; цена, размеры и наличие не трогаем. Немецкий оригинал хранится рядом (orig).
 * Ключ — только на сервере (GEMINI_API_KEY). Ошибка перевода не мешает загрузке: товар сохранится как есть.
 */
import { createHash } from "node:crypto";

const DE_WORDS = /\b(und|aus|mit|der|die|das|für|aus|tasche|leder|damen|herren|schuhe|kleid|jacke|hose|mantel|gürtel|schwarz|weiß|braun|grün|blau|rot|grau|rosa|beige|größe|kalbsleder|wildleder|baumwolle|wolle|seide|umhängetasche|handtasche|halskette|armband|ohrringe|sonnenbrille|stiefel|turnschuhe|sneaker aus|hergestellt|maße|breite|höhe|tiefe)\b/gi;

/** Похоже ли на немецкий: умлауты/ß или несколько типичных немецких слов. */
export function looksGerman(...parts) {
  const t = parts.filter(Boolean).join(" ");
  if (!t.trim()) return false;
  if (/[äöüß]/i.test(t)) return true;
  const m = t.match(DE_WORDS) || [];
  return new Set(m.map(x => x.toLowerCase())).size >= 2;
}

export const trHash = (title, description, colors) => createHash("sha1").update([title || "", description || "", ...(colors || [])].join("\u0001")).digest("hex").slice(0, 16);

const PROMPT = `You translate luxury fashion product listings from German to English, the way the brand's own English website writes them.
Rules: keep brand names, model names and product line names exactly as written (e.g. "Neverfull MM", "LE LOAFER", "Monogram", "GG Marmont"); keep capitalization style of the original title;
use standard fashion terms (Kalbsleder → calfskin leather, Wildleder → suede, Umhängetasche → shoulder bag, Gürteltasche → belt bag); translate measurements labels but keep numbers and units;
color names in simple English (Schwarz → Black, Dunkelbraun → Dark Brown). Return JSON only.`;

const SCHEMA = { type: "OBJECT", properties: { title: { type: "STRING" }, description: { type: "STRING" }, colors: { type: "ARRAY", items: { type: "STRING" } } }, required: ["title", "colors"] };

// быстрые модели по очереди: перегрузка (503) или долгий ответ одной — пробуем следующую
const TR_MODELS = () => (process.env.GEMINI_TR_MODEL ? [process.env.GEMINI_TR_MODEL] : []).concat(["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-flash-latest"]);

async function askModel(model, payload, { key, fetchImpl, timeoutMs }) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT + "\n\n" + JSON.stringify(payload) }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA, ...(/flash-lite|2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } })
    });
    if (!r.ok) throw new Error("перевод: ответ " + r.status + " (" + model + ")");
    const j = await r.json();
    return JSON.parse(j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "");
  } catch (e) { throw new Error(e.name === "AbortError" ? "перевод: долго (" + model + ")" : e.message); }
  finally { clearTimeout(t); }
}

/** Перевести поля. Возвращает { title, description, colors } или бросает ошибку. */
export async function translateFields({ title = "", description = "", colors = [] }, { key = process.env.GEMINI_API_KEY, models = TR_MODELS(), fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (!key) throw new Error("нет ключа перевода");
  let last;
  for (const model of models) {
    try {
      const o = await askModel(model, { title, description: description || "", colors }, { key, fetchImpl, timeoutMs });
      const out = { title: String(o.title || "").trim().slice(0, 120), description: String(o.description || "").trim().slice(0, 2000), colors: (Array.isArray(o.colors) ? o.colors : []).map(c => String(c).trim().slice(0, 60)) };
      if (out.title) return out;
      last = new Error("перевод: пустое название");
    } catch (e) { last = e; }
  }
  throw last || new Error("перевод не удался");
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
    orig: JSON.stringify({ lang: "de", h, title: it.title, description: it.description || null, colors: colorNames, en })
  };
}
