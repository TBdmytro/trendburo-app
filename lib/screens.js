/**
 * Импорт товаров со скриншотов: Google Gemini читает скриншот страницы товара
 * (бренд, название, цена, валюта, цвет, размеры, категория) и говорит, где на экране фото товара.
 * Ключ — только в переменной окружения GEMINI_API_KEY на сервере, в браузер и логи не попадает.
 * Обрезка фото делается в браузере по рамке, которую вернул Gemini.
 */
import { toEur, FX_CURRENCIES } from "./fx.js";
import { CATEGORIES } from "./normalize.js";

export const SCREEN_MODEL = () => process.env.GEMINI_MODEL || "gemini-flash-latest";
export const screensEnabled = () => !!process.env.GEMINI_API_KEY;

const PROMPT = `Это скриншот страницы товара из интернет-магазина или приложения люксового бренда.
Найди ОДИН главный товар и верни JSON:
- isProduct: true, если на скриншоте страница или карточка товара; false — если это что-то другое.
- brand: бренд (например "Louis Vuitton"), как написан на сайте; если не виден — по логотипу или адресу сайта; иначе пусто.
- title: название модели без бренда (например "Keepall Bandoulière 50").
- price: цена числом без пробелов и символов (например 2650). Если цен несколько (старая и новая) — актуальная. Если цены нет — 0.
- currency: код валюты ISO (EUR, USD, GBP, CHF, AED, UAH …); "€" = EUR, "$" = USD, "£" = GBP.
- color: цвет или материал, если указан.
- sizes: доступные размеры списком строк; если размеров нет — пустой список.
- sku: артикул, если виден.
- category: одно из bags, clothing, shoes, accessories, jewelry, eyewear, watches, fragrance, other.
- gender: w (женское), m (мужское) или u (унисекс/не понятно).
- box: рамка ГЛАВНОГО ФОТО товара на скриншоте [ymin, xmin, ymax, xmax] в долях 0–1000, без кнопок, текста и панелей сайта. Если фото нет — [0,0,0,0].
Ничего не выдумывай: чего не видно — пусто.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    isProduct: { type: "BOOLEAN" }, brand: { type: "STRING" }, title: { type: "STRING" }, price: { type: "NUMBER" },
    currency: { type: "STRING" }, color: { type: "STRING" }, sizes: { type: "ARRAY", items: { type: "STRING" } },
    sku: { type: "STRING" }, category: { type: "STRING" }, gender: { type: "STRING" },
    box: { type: "ARRAY", items: { type: "NUMBER" } }
  },
  required: ["isProduct", "brand", "title", "price", "currency", "category", "gender", "box"]
};

export class ScreenError extends Error { constructor(msg, { retryAfter = 0, status = 0 } = {}) { super(msg); this.retryAfter = retryAfter; this.status = status; } }

const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Привести ответ модели к безопасному виду (модели доверяем только как данным). */
export function cleanReading(r, fx) {
  const currency = str(r.currency, 3).toUpperCase();
  const price = Number(r.price) > 0 && Number(r.price) < 1e7 ? Math.round(Number(r.price) * 100) / 100 : null;
  const known = currency === "EUR" || FX_CURRENCIES.includes(currency);
  const box = Array.isArray(r.box) && r.box.length === 4 ? r.box.map(n => Math.max(0, Math.min(1000, Math.round(Number(n) || 0)))) : [0, 0, 0, 0];
  const okBox = box[2] - box[0] > 40 && box[3] - box[1] > 40;
  return {
    isProduct: r.isProduct !== false,
    brand: str(r.brand, 60), title: str(r.title, 120), color: str(r.color, 60), sku: str(r.sku, 40),
    sizes: (Array.isArray(r.sizes) ? r.sizes : []).map(s => str(s, 12)).filter(Boolean).slice(0, 30),
    category: CATEGORIES[r.category] ? r.category : "other",
    gender: ["w", "m", "u"].includes(r.gender) ? r.gender : "u",
    price, currency: currency || "EUR",
    priceEur: price && known ? toEur(price, currency || "EUR", fx) : null,
    currencyKnown: known,
    box: okBox ? box : null
  };
}

/** Прочитать один скриншот. data — base64 JPEG/PNG/WebP. */
export async function readScreen(data, mime, { fx, fetchImpl = fetch, key = process.env.GEMINI_API_KEY, model = SCREEN_MODEL(), timeoutMs = 45000 } = {}) {
  if (!key) throw new ScreenError("Распознавание не подключено: добавьте GEMINI_API_KEY в Vercel");
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data } }, { text: PROMPT }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA }
      })
    });
  } catch (e) { throw new ScreenError(e.name === "AbortError" ? "Gemini не ответил вовремя" : "Нет связи с Gemini", { retryAfter: 10 }); }
  finally { clearTimeout(t); }
  if (r.status === 429) throw new ScreenError("Дневной или минутный лимит Gemini — подождём", { retryAfter: 40, status: 429 });
  if (r.status === 400 || r.status === 403) {
    const j = await r.json().catch(() => ({}));
    const m = String(j.error?.message || "");
    if (/location|region|country/i.test(m)) throw new ScreenError("Google не даёт бесплатный Gemini для вашего региона", { status: r.status });
    if (/API key/i.test(m)) throw new ScreenError("Ключ Gemini не подходит — проверьте GEMINI_API_KEY", { status: r.status });
    throw new ScreenError("Gemini отклонил запрос (" + r.status + ")", { status: r.status });
  }
  if (r.status === 404) throw new ScreenError("Модель Gemini не найдена — укажите GEMINI_MODEL", { status: 404 });
  if (!r.ok) throw new ScreenError("Gemini ответил ошибкой " + r.status, { retryAfter: 15, status: r.status });
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  let parsed; try { parsed = JSON.parse(text); } catch { throw new ScreenError("Не удалось прочитать ответ Gemini"); }
  return cleanReading(parsed, fx);
}

/** Ключ для склейки: скриншоты одного товара (бренд + название) — одна карточка. */
export const groupKey = r => (r.brand + "|" + r.title).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9а-я|]+/g, "");
