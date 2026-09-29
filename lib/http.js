/**
 * Безопасная загрузка страниц источников (только на сервере).
 * - только https и домены из списка источника; редиректы проверяются заново
 * - запрет локальных и внутренних адресов (проверка DNS)
 * - лимиты размера, времени, типов содержимого
 * - соблюдение robots.txt
 * - признаки защиты от ботов → ошибка SourceBlocked, без попыток обхода
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

export const USER_AGENT = "TrendBuroCatalogBot/1.0 (+https://trendburo.app/bot)";

export class SourceBlocked extends Error { constructor(msg, status) { super(msg); this.name = "SourceBlocked"; this.status = status; this.retryable = false; } }
export class FetchError extends Error { constructor(msg, status, retryable = true) { super(msg); this.name = "FetchError"; this.status = status; this.retryable = retryable; } }
export class UrlRejected extends Error { constructor(msg) { super(msg); this.name = "UrlRejected"; this.retryable = false; } }

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") ||
      (x.startsWith("::ffff:") && isPrivateIp(x.slice(7)));
  }
  return true;
}

export function hostAllowed(host, domains) {
  host = host.toLowerCase();
  return domains.some(d => host === d || host.endsWith("." + d));
}

/** Проверка адреса до запроса. resolve=false — только синтаксис (для тестов без сети). */
let DNS_CHECK = true;
/** Только для автотестов без сети. */
export function setDnsCheck(v) { DNS_CHECK = !!v; }

export async function checkUrl(raw, domains, { resolve = DNS_CHECK } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new UrlRejected("Некорректная ссылка"); }
  if (u.protocol !== "https:") throw new UrlRejected("Разрешены только https-ссылки");
  if (u.username || u.password) throw new UrlRejected("Ссылки с логином не принимаются");
  if (u.port && u.port !== "443") throw new UrlRejected("Нестандартный порт запрещён");
  if (net.isIP(u.hostname)) throw new UrlRejected("Адреса по IP не принимаются");
  if (!hostAllowed(u.hostname, domains)) throw new UrlRejected(`Домен ${u.hostname} не относится к этому источнику`);
  if (resolve) {
    const addrs = await lookup(u.hostname, { all: true }).catch(() => { throw new FetchError("Домен не найден", 0, true); });
    if (addrs.some(a => isPrivateIp(a.address))) throw new UrlRejected("Адрес ведёт во внутреннюю сеть");
  }
  return u;
}

const CHALLENGE = /(captcha|cf-chl|challenge-platform|akamai.*bot|_abck|px-captcha|are you a robot|access denied|datadome)/i;

/**
 * Загрузка с лимитами. Возвращает {url, status, contentType, text}.
 */
export async function safeFetch(raw, { domains, maxBytes = 3_000_000, timeoutMs = 15000, accept = "text/html,application/xhtml+xml,application/xml,application/json;q=0.9", types = ["text/html", "application/xhtml+xml", "application/xml", "text/xml", "application/json", "text/csv", "text/plain"], maxRedirects = 3, fetchImpl = fetch } = {}) {
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = await checkUrl(url, domains);
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(u.href, { redirect: "manual", signal: ctl.signal, headers: { "User-Agent": USER_AGENT, "Accept": accept, "Accept-Language": "de-DE,de;q=0.9,en;q=0.5" } });
    } catch (e) {
      clearTimeout(t);
      throw new FetchError(e.name === "AbortError" ? "Превышено время ожидания" : "Сетевая ошибка: " + e.message, 0, true);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(t); url = new URL(res.headers.get("location"), u).href; continue;
    }
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const text = await readLimited(res, maxBytes).finally(() => clearTimeout(t));
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      if (res.status === 429) throw new FetchError("Источник просит снизить частоту запросов (429)", 429, true);
      throw new SourceBlocked(`Источник закрыл доступ (${res.status})${CHALLENGE.test(text) ? ": защита от автоматизации" : ""}`, res.status);
    }
    if (res.status === 404 || res.status === 410) throw new FetchError(`Страница не найдена (${res.status})`, res.status, false);
    if (res.status >= 400) throw new FetchError(`Ошибка источника ${res.status}`, res.status, res.status >= 500);
    if (ct && !types.includes(ct)) throw new FetchError(`Неожиданный тип содержимого: ${ct}`, res.status, false);
    if (/text\/html/.test(ct) && CHALLENGE.test(text.slice(0, 20000)) && !/application\/ld\+json/.test(text)) {
      throw new SourceBlocked("Страница защиты от автоматизации вместо товара — обход не выполняется", res.status);
    }
    return { url: u.href, status: res.status, contentType: ct, text };
  }
  throw new FetchError("Слишком много перенаправлений", 0, false);
}

async function readLimited(res, maxBytes) {
  if (!res.body || !res.body.getReader) {
    const t = await res.text();
    if (t.length > maxBytes) throw new FetchError("Ответ больше допустимого размера", res.status, false);
    return t;
  }
  const reader = res.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { try { reader.cancel(); } catch {} throw new FetchError("Ответ больше допустимого размера", res.status, false); }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
}

/* ---------- robots.txt ---------- */
export function parseRobots(txt) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const line of String(txt).split(/\r?\n/)) {
    const m = line.replace(/#.*$/, "").trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") { if (!lastWasAgent || !cur) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === "disallow" || k === "allow") { if (v) cur.rules.push({ allow: k === "allow", path: v }); }
    if (k === "crawl-delay") cur.delay = Number(v) || null;
  }
  const mine = groups.find(g => g.agents.some(a => a !== "*" && USER_AGENT.toLowerCase().includes(a))) || groups.find(g => g.agents.includes("*")) || { rules: [], delay: null };
  return mine;
}
function ruleMatch(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + body + (anchored ? "$" : "")).test(path);
}
/** Разрешён ли путь (самое длинное совпадение, при равенстве — Allow). */
export function robotsAllows(group, pathWithQuery) {
  let best = null;
  for (const r of group.rules) if (ruleMatch(r.path, pathWithQuery)) {
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}
