/**
 * Фотографии: порядок, обложка, копирование в наше хранилище (только при разрешении источника).
 * Изображения никогда не растягиваются: витрина запрашивает у CDN нужную ширину, пропорции сохраняются.
 */
import { safeFetch } from "./http.js";
import { createHash } from "node:crypto";

const IMG_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
export const MAX_IMAGE_BYTES = 8_000_000;
export const MAX_IMAGES_PER_MODEL = 12;

/** Признаки фото «на модели» в адресе — такие не ставим обложкой, если есть предметные. */
const ON_MODEL = /(model|worn|look|campaign|onbody|on-body|editorial|_ww_|lifestyle|porte)/i;

/**
 * Порядок фото для варианта: сначала предметные в порядке источника, затем на модели.
 * Возвращает {images, coverSure}: coverSure=false → товар идёт на проверку обложки.
 */
export function orderImages(urls) {
  const uniq = [...new Set(urls.filter(Boolean))];
  const product = uniq.filter(u => !ON_MODEL.test(u)), model = uniq.filter(u => ON_MODEL.test(u));
  const images = [...product, ...model].slice(0, MAX_IMAGES_PER_MODEL);
  return { images, coverSure: product.length > 0 };
}

/**
 * Копирует фото в хранилище, если источник разрешает. Иначе возвращает ссылки источника как есть.
 * store.uploadImage(buffer, {filename, contentType, sourceUrl}) → {assetId, url}
 */
export async function materializeImages(urls, src, store, { fetchImpl = fetch, limit = MAX_IMAGES_PER_MODEL } = {}) {
  const out = [], errors = [];
  for (const url of urls.slice(0, limit)) {
    if (src.imageRights !== "copy-allowed" || !store.uploadImage) { out.push({ url, sourceUrl: url, rights: "source-link" }); continue; }
    try {
      const bin = await fetchBinary(url, src.imageDomains || src.domains, fetchImpl);
      const up = await store.uploadImage(bin.buf, { filename: "tb-" + createHash("sha1").update(url).digest("hex").slice(0, 12), contentType: bin.type, sourceUrl: url });
      out.push({ url: up.url, assetId: up.assetId, sourceUrl: url, rights: "copied", width: up.width || null, height: up.height || null });
    } catch (e) {
      errors.push(`Фото не сохранено (${e.message}) — оставлена ссылка источника`);
      out.push({ url, sourceUrl: url, rights: "source-link" });
    }
  }
  return { images: out, errors };
}

async function fetchBinary(url, domains, fetchImpl) {
  // проверка адреса и редиректов той же функцией, что и для страниц; тело читаем как бинарное
  const { checkUrl } = await import("./http.js");
  let u = url;
  for (let hop = 0; hop < 3; hop++) {
    const cu = await checkUrl(u, domains);
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    const res = await fetchImpl(cu.href, { redirect: "manual", signal: ctl.signal, headers: { "User-Agent": "TrendBuroCatalogBot/1.0", Accept: IMG_TYPES.join(",") } }).finally(() => clearTimeout(t));
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { u = new URL(res.headers.get("location"), cu).href; continue; }
    if (!res.ok) throw new Error("ответ " + res.status);
    const type = (res.headers.get("content-type") || "").split(";")[0];
    if (!IMG_TYPES.includes(type)) throw new Error("не изображение: " + (type || "без типа"));
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_IMAGE_BYTES) throw new Error("файл больше 8 МБ");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error("файл больше 8 МБ");
    return { buf, type };
  }
  throw new Error("слишком много перенаправлений");
}

/** Адрес нужного размера для витрины (Sanity CDN масштабирует без растяжения). */
export function sized(url, w) {
  if (!url) return url;
  if (/cdn\.sanity\.io\/images\//.test(url)) return `${url}${url.includes("?") ? "&" : "?"}w=${w}&fit=max&auto=format&q=82`;
  return url;
}
