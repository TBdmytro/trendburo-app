/**
 * Курсы валют для поставщиков с ценами не в евро (магазины США, Великобритании, Швейцарии).
 * Источник — ежедневный курс Европейского центрального банка; ручное значение в админке важнее.
 * Курс = сколько единиц валюты за 1 €. Цена в € = цена / курс.
 */
import { safeFetch } from "./http.js";

export const FX_CURRENCIES = ["USD", "GBP", "CHF", "AED", "SEK", "DKK", "PLN", "CAD", "AUD", "JPY"];
// Запасные значения, если ЕЦБ недоступен и курс вручную не задан. В админке помечаются как «примерный».
export const FX_FALLBACK = { USD: 1.17, GBP: 0.87, CHF: 0.94, AED: 4.3, SEK: 11.1, DKK: 7.46, PLN: 4.27, CAD: 1.62, AUD: 1.78, JPY: 172 };
const ECB = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

export function parseEcb(xml) {
  const rates = {};
  for (const m of String(xml).matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = Number(m[2]);
  return rates;
}

export async function getFx(store) {
  const s = (await store.get("settings.fx")) || {};
  const rates = {};
  for (const c of FX_CURRENCIES) {
    const manual = Number(s.manual?.[c]) > 0 ? Number(s.manual[c]) : null;
    const ecb = Number(s.ecb?.[c]) > 0 ? Number(s.ecb[c]) : null;
    rates[c] = { rate: manual || ecb || FX_FALLBACK[c], source: manual ? "вручную" : ecb ? "ЕЦБ" : "примерный", at: manual ? s.manualAt : ecb ? s.ecbAt : null };
  }
  return { rates, ecbAt: s.ecbAt || null };
}

/** Обновить курсы ЕЦБ не чаще раза в 12 часов. Ошибка сети не мешает работе — остаётся прежний курс. */
export async function refreshFx(store, { fetchImpl = fetch, force = false } = {}) {
  const s = (await store.get("settings.fx")) || { _id: "settings.fx", _type: "settings" };
  if (!force && s.ecbAt && Date.now() - Date.parse(s.ecbAt) < 12 * 3600e3) return { ok: true, cached: true };
  try {
    const r = await safeFetch(ECB, { domains: ["ecb.europa.eu"], fetchImpl, types: ["text/xml", "application/xml"], maxBytes: 200000 });
    const rates = parseEcb(r.text);
    if (!rates.USD) throw new Error("В ответе ЕЦБ нет курсов");
    s.ecb = rates; s.ecbAt = new Date().toISOString();
    await store.put(s);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function saveManualFx(store, manual, by = "admin") {
  const s = (await store.get("settings.fx")) || { _id: "settings.fx", _type: "settings" };
  s.manual = {};
  for (const c of FX_CURRENCIES) { const v = Number(manual?.[c]); if (v > 0 && v < 100000) s.manual[c] = Math.round(v * 10000) / 10000; }
  s.manualAt = new Date().toISOString(); s.manualBy = by;
  await store.put(s);
  return getFx(store);
}

/** Цена в евро из цены магазина: деление на курс и коэффициент поставщика (НДС/пошлины). */
export function toEur(amount, currency, fx, factor = 1) {
  const a = Number(amount); if (!(a > 0)) return null;
  const rate = currency === "EUR" || !currency ? 1 : fx?.rates?.[currency]?.rate;
  if (!rate) return null;
  return Math.round(a / rate * (Number(factor) > 0 ? Number(factor) : 1) * 100) / 100;
}
