window.__H=(function(){var tick=null;
  var sleep = function (ms) { return tick ? Promise.race([tick(ms), new Promise(function (r) { setTimeout(r, ms + 4000); })]) : new Promise(function (r) { setTimeout(r, ms); }); };
  var host = location.hostname.replace(/^www\./, "");
  var SITE = { "mytheresa.com": "Mytheresa", "ysl.com": "Saint Laurent", "de.loropiana.com": "Loro Piana", "loropiana.com": "Loro Piana" }, siteName = SITE[host] || host.split(".")[0].replace(/^\w/, function (c) { return c.toUpperCase(); });
  var BRANDS = { "yves saint laurent": "Saint Laurent", "saint laurent paris": "Saint Laurent", "ysl": "Saint Laurent" };
  var flat = function (x) { var out = []; (Array.isArray(x) ? x : [x]).forEach(function (o) { if (!o) return; if (o["@graph"]) out = out.concat(flat(o["@graph"])); else out.push(o); }); return out; };
  var lds = function (doc) { var all = []; [].slice.call(doc.querySelectorAll('script[type="application/ld+json"]')).forEach(function (s) { try { all = all.concat(flat(JSON.parse(s.textContent))); } catch (e) {} }); return all; };
  var isT = function (o, t) { var v = o["@type"]; return v === t || (Array.isArray(v) && v.indexOf(t) >= 0); };
  // код товара из адреса: …-P1234567, …-A005ENAAB9S1000.html, Dior: /products/3SN272ZIJ_H80G (подчёркивание убираем — как в артикуле в админке)
  // артикул товара из адреса. Louis Vuitton: /produkte/<название>-nvprod…|-P0…/M28324 — артикул последний (M28324, как на странице товара);
  // ссылки на разделы меню (/_/N-t164iz3b) — не товары: из-за них кнопка раньше брала 18 сумок из 116
  var codeOf = function (url) { var path = new URL(url, location.href).pathname; if (/\/_\/N-[a-z0-9-]+\/?$/i.test(path)) return ""; if (/\/c\/\d{4,6}[A-Z]{2}\/?$/.test(path)) return ""; /* Miu Miu / Prada: …/c/10207EU — раздел, не товар */ var pr = path.match(/\/p\/[^/]+\/([A-Z0-9]{4,8}_[A-Z0-9]{2,6}_[A-Z0-9]{4,6}(?:_[A-Z0-9]+)*)\/?$/i); if (pr) return pr[1].replace(/_/g, "").toUpperCase(); /* Miu Miu / Prada: …/p/stiefel-aus-leder/5W767E_Y9S_F0002_F_055 → весь артикул (как в админке) */ var lp = path.match(/-([A-Z]{3}\d{4}_[A-Z0-9]{4})\.html$/); if (lp) return lp[1].replace(/_/g, "").toUpperCase(); /* Loro Piana: …/derbyschuh-oliver-walk-FAO3228_H0RP.html (модель_цвет) */ var lv = path.match(/\/(?:produkte|products|produits|prodotti|productos|produtos)\/[^/]+\/([A-Z][A-Z0-9]{4,7})\/?$/i); if (lv) return lv[1].toUpperCase(); var m = path.match(/-cod-([A-Za-z0-9]+(?:\.[A-Za-z0-9]+){0,3})\.html?$/i) /* Golden Goose: …-cod-GMF00101.F006889.10273.html */ || path.match(/[-_/]((?=[A-Za-z0-9.]*\d)[A-Za-z0-9]{3,}(?:\.[A-Za-z0-9]{2,}){1,3})\.html?$/) /* артикул с точками */ || path.match(/-(p\d{7,9})(?:[/?#]|$)/i) || path.match(/\/products\/([A-Za-z0-9]{5,}_[A-Za-z0-9]{2,8})(?:[-/?#]|$)/i) || path.match(/[-_/]([A-Za-z0-9]*\d[A-Za-z0-9]{5,})(?:\.html?)?\/?$/); return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, "") : ""; };
  // фото: из галереи открытой страницы или из HTML товара — все картинки с кодом товара, по одной на кадр, крупнейшего размера
  var pickImages = function (html, code, ldImg, limit) {
    var urls = []; html = String(html || "").replace(/\\u002F/gi, "/").replace(/\\\//g, "/"); // адреса фото в данных страницы бывают с экранированными «/»
    // Louis Vuitton, обувь и часть вещей: в названии фото не артикул (1AL4JZ), а код модели (BM9U1PMI72) — берём ракурсы того кода,
    // у которого на странице больше всего разных снимков (галерея самого товара; у рекомендаций по одному фото)
    if (/louisvuitton\.com$/.test(location.hostname)) { var lre = /https?:\/\/[^"'\s()<>\\]+?\/images\/is\/image\/lv\/[^"'\s()<>\\?]*?--([A-Z0-9]+)_[A-Z]{1,3}\d_([^"'\s()<>\\?]+?)(?:%20| )view\.(?:png|jpe?g)(?:\?[^"'\s()<>\\]*)?/g, lm, grp = {};
      while ((lm = lre.exec(html))) { var lc = lm[1]; (grp[lc] = grp[lc] || {})[lm[2].toLowerCase()] = lm[0].replace(/&amp;/g, "&"); }
      // какой код — этого товара: 1) из данных товара на странице (JSON-LD image), 2) название фото совпадает с названием товара, 3) больше всего ракурсов.
      // Без 1–2 на странице обуви «больше всего ракурсов» бывало у рекомендаций (сумка, шарф, очки) — их фото попадали в карточку
      if (!(code && grp[code] && Object.keys(grp[code]).length >= 2)) {
        var ldC = ""; [].concat(ldImg || []).some(function (u) { var m = String(typeof u === "string" ? u : u && u.url || "").match(/--([A-Z0-9]+)_[A-Z]{1,3}\d_/); if (m && grp[m[1]]) { ldC = m[1]; return true; } return false; });
        var nm = (String(html).match(/"@type"\s*:\s*"Product"[\s\S]{0,200}?"name"\s*:\s*"([^"]{2,80})"/) || [])[1] || "", slug = nm.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        var slugC = ""; if (slug) Object.keys(grp).some(function (k) { var any = grp[k][Object.keys(grp[k])[0]]; if (any.toLowerCase().indexOf("louis-vuitton-" + slug + "--") >= 0) { slugC = k; return true; } return false; });
        var bestC = ldC || slugC, bn = bestC ? 99 : 0; if (!bestC) Object.keys(grp).forEach(function (k) { var n = Object.keys(grp[k]).length; if (n > bn) { bn = n; bestC = k; } });
        if (bestC && bn >= 3) Object.keys(grp[bestC]).forEach(function (v) { urls.push(grp[bestC][v]); }); } }
    if (/(^|\.)loropiana\.com$/.test(location.hostname) && code) { var lpU = {}, lpR = /https:\/\/media\.loropiana\.com\/[^"'\s()<>\\?]+?[\/_]([A-Z0-9]+)_([A-Z0-9]+)_(ZOOM|MEDIUM|SMALL)\.jpg/gi, lpM; while ((lpM = lpR.exec(html))) { if ((lpM[1] + lpM[2]).toUpperCase() !== code) continue; var lk0 = lpM[3].toUpperCase(); (lpU[lk0] = lpU[lk0] || []); if (lpU[lk0].indexOf(lpM[0]) < 0) lpU[lk0].push(lpM[0]); }
      var lpL = lpU.ZOOM || lpU.MEDIUM; if (lpL && lpL.length) return lpL.slice(0, limit); } // Loro Piana: у каждого снимка три размера с разными папками — берём галерею ZOOM (1920 px), иначе MEDIUM; без этого все снимки сливались в один
    if (code) { var re = /https?:\/\/[^"'\s()<>\\]+?\.(?:jpe?g|png|webp|avif)(?:\?[^"'\s()<>\\]*)?|\/image\/\d+\/\d+\/\d+\/[^"'\s()<>\\]+?\.(?:jpe?g|png|webp)/gi, m; while ((m = re.exec(html))) { var u = m[0].replace(/&amp;/g, "&"); if (u.toUpperCase().replace(/[^A-Z0-9]/g, "").indexOf(code) >= 0) urls.push(new URL(u, location.origin).href); } }
    // фото без расширения в адресе (Dior и др.: …/is/image/<бренд>/<артикул>_E01?…)
    if (code) { var re2 = /https?:\/\/[^"'\s()<>\\]+?\/is\/image\/[^"'\s()<>\\?]+(?:\?[^"'\s()<>\\]*)?/gi, m2; while ((m2 = re2.exec(html))) { var u2 = m2[0].replace(/&amp;/g, "&").replace(/\\u002F/gi, "/"); if (u2.toUpperCase().replace(/[^A-Z0-9]/g, "").indexOf(code) >= 0 && urls.indexOf(u2) < 0) urls.push(u2); } }
    [].concat(ldImg || []).forEach(function (u) { if (typeof u === "string") urls.push(u); else if (u && u.url) urls.push(u.url); });
    var score = function (u) { var n = (u.match(/\d{3,4}/g) || []).map(Number).filter(function (x) { return x <= 4000; }); return Math.max.apply(null, [0].concat(n)) + (/ecom|large|zoom|original|full/i.test(u) ? 3000 : 0) - (/thumb|small|tiny|icon|swatch/i.test(u) ? 5000 : 0); };
    // обложка — как на сайте: главное фото товара (из данных страницы) ставим первым
    var ld0 = [].concat(ldImg || []).map(function (u) { return typeof u === "string" ? u : u && u.url; }).filter(Boolean)[0];
    if (ld0) { var lk = (function (u) { var f = u.split("?")[0].split("/").pop(), F = f.toUpperCase(), i = code ? F.indexOf(code) : -1; return (i >= 0 ? F.slice(i) : F).replace(/\.(JPE?G|PNG|WEBP|AVIF)$/, "").toLowerCase(); })(ld0);
      urls.sort(function (a, b) { var ka = a.split("?")[0].split("/").pop().toUpperCase(), kb = b.split("?")[0].split("/").pop().toUpperCase(); return (kb.indexOf(lk.toUpperCase()) >= 0) - (ka.indexOf(lk.toUpperCase()) >= 0); }); }
    // одно фото в разных размерах (Small-…, Medium-…, eCom-… или ?imwidth=…) — один ключ: часть имени файла начиная с артикула
    var keyOf = function (u) { var f = u.split("?")[0].split("/").pop(), F = f.toUpperCase(), i = code ? F.indexOf(code) : -1; return (i >= 0 ? F.slice(i) : F).replace(/\.(JPE?G|PNG|WEBP|AVIF)$/, "").toLowerCase(); };
    var best = {}, order = [];
    urls.forEach(function (u) { var k = keyOf(u); if (!best[k]) { best[k] = u; order.push(k); } else if (score(u) > score(best[k])) best[k] = u; });
    return order.map(function (k) { return best[k]; }).filter(function (u) { return score(u) > -2000; }).slice(0, limit);
  };
  // фото берём так же, как их показывает страница (через картинку, а не прямой запрос — его могут запрещать правила сайта); не вышло — передаём ссылку на фото
  var toJpeg = async function (u) {
    // и файл, и ссылку: если файл не передастся или не сохранится, админка скачает фото по ссылке
    try {
      var im = new Image(); im.crossOrigin = "anonymous";
      await new Promise(function (ok, no) { im.onload = ok; im.onerror = no; im.src = u + (u.indexOf("?") >= 0 ? "&" : "?") + "tbx=1"; setTimeout(no, 20000); });
      var w0 = im.naturalWidth, h0 = im.naturalHeight; if (!w0) throw new Error("empty");
      var s = Math.min(1, 1600 / Math.max(w0, h0)), c = document.createElement("canvas"); c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
      var x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height); return { d: c.toDataURL("image/jpeg", 0.9), u: u };
    } catch (e) { return /^https:\/\//.test(u) ? { d: null, u: u } : null; }
  };
  // размеры и наличие: 1) данные schema.org по размерам; 2) кнопки размеров на странице (проданные — «sold out», серые, недоступные);
  // 3) список размеров в коде страницы (наличие неизвестно); 4) просто список размеров из данных товара
  var PRE = /(pre-?order|pr[ée]-?commande|vorbestell|preordin|prenota|preventa|pre-?venta|produkt anfragen|auf anfrage|request (this )?product|on request|su richiesta|sur demande)/i;
  // предзаказ на всю вещь: в данных товара, рядом с артикулом в коде страницы или на кнопке покупки
  var pagePre = function (doc, html, p, code) {
    if ([].concat(p.offers || []).some(function (o) { return /PreOrder|PreSale|BackOrder/i.test(String(o.availability || "")) || [].concat(o.offers || []).some(function (x) { return /PreOrder|PreSale/i.test(String(x.availability || "")); }); })) return true;
    var H = String(html || ""), re = /"(?:isPre[Oo]rder|pre[Oo]rder|is_preorder|preOrderable)"\s*:\s*true|"(?:status|orderType|availabilityStatus|inventoryStatus|availability)"\s*:\s*"(?:https?:\/\/schema\.org\/)?(?:PRE_?ORDER|PreOrder|PreSale)"/i;
    if (code) { var i = -1, n = 0; while ((i = H.indexOf(code, i + 1)) >= 0 && n++ < 30) if (re.test(H.slice(Math.max(0, i - 3000), i + 3000))) return true; }
    return [].slice.call(doc.querySelectorAll('button, [role="button"], [class*="add-to-cart" i], [class*="addtocart" i], [class*="add-to-bag" i]')).some(function (b) { var t = (b.textContent || "").replace(/\s+/g, " ").trim(); return t.length <= 40 && PRE.test(t); });
  };
  var BLOCK = /(pre-?order|pr[ée]-?commande|vorbestell|join the wait ?list|wait ?list|warteliste|liste d'attente|find in store|in store only|available in store|nur im (store|geschäft)|coming soon|notify me|benachrichtig)/i;
  var BUY = /(add to (bag|cart|basket|shopping)|in den warenkorb|ajouter au panier|aggiungi al carrello|buy now|jetzt kaufen)/i;
  // что мешает купить онлайн: «pre» — предзаказ, «wait» — лист ожидания / сообщить о поступлении, «store» — только в бутике
  var blockOf = function (t) { t = String(t || ""); return /pre-?order|pr[ée]-?commande|vorbestell/i.test(t) ? "pre" : /wait ?list|warteliste|liste d'attente|notify me|benachrichtig|coming soon/i.test(t) ? "wait" : /find in store|in store only|available in store|nur im (store|geschäft)/i.test(t) ? "store" : ""; };
  // кнопка покупки на открытой странице — только видимые (в коде LV спрятаны обе: «В корзину» и «Сообщить о поступлении»)
  var visBuy = function (doc) { var bs = [].slice.call(doc.querySelectorAll('button, [role="button"], a[class*="btn" i]')).filter(function (b) { var r = b.getClientRects(); if (!r.length || !r[0].width || !r[0].height) return false; var cs = (b.ownerDocument.defaultView || window).getComputedStyle(b); return cs.visibility !== "hidden" && cs.display !== "none"; }).map(function (b) { return (b.textContent || "").replace(/\s+/g, " ").trim(); }).filter(function (t) { return t && t.length <= 40; });
    if (bs.some(function (t) { return BUY.test(t); })) return { s: "buy", t: bs.filter(function (t) { return BUY.test(t); })[0] }; for (var i = 0; i < bs.length; i++) { var k = blockOf(bs[i]); if (k) return { s: k, t: bs[i] }; } return null; };
  var pageBlock = function (doc, html, p, code) {
    if (pagePre(doc, html, p, code)) return "pre";
    // Loro Piana: вещь одного размера («NR») — выключенный размер = распродано (кнопка «Benachrichtigen»), иначе можно купить; скрытые кнопки корзины в коде страницы есть всегда
    if (/(^|\.)loropiana\.com$/.test(location.hostname) && doc && doc.querySelectorAll) { var lpI = [].slice.call(doc.querySelectorAll("input.size-item__input[value]")).filter(function (x) { return !code || String(x.getAttribute("data-id") || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === String(code).toUpperCase().replace(/[^A-Z0-9]/g, ""); });
      if (lpI.length === 1 && /^(NR|UNI|TU|OS|U)$/i.test(String(lpI[0].value).trim())) return lpI[0].disabled || lpI[0].hasAttribute("disabled") ? "wait" : ""; if (lpI.length) return ""; }
    // Prada / Miu Miu: кнопка «Benachrichtigen, wenn verfügbar» лежит в коде страницы всегда (скрытое окно подписки), а «В корзину» дорисовывается позже — решает наличие из данных товара (schema.org)
    if (/(^|\.)(prada|miumiu)\.com$/.test(location.hostname)) { var av = String(html || "").match(/"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?(\w+)"/g) || []; if (av.length) { var inS = av.some(function (x) { return /InStock|LimitedAvailability|OnlineOnly/.test(x); }); if (inS) return ""; if (av.some(function (x) { return /PreOrder|BackOrder/.test(x); })) return "pre"; return "wait"; } }
    var btns = [].slice.call(doc.querySelectorAll('button, [role="button"], a[class*="btn" i], [class*="add-to-cart" i], [class*="addtocart" i], [class*="add-to-bag" i]')).map(function (b) { return (b.textContent || "").replace(/\s+/g, " ").trim(); }).filter(function (t) { return t && t.length <= 40; });
    if (btns.some(function (t) { return BUY.test(t); })) return "";
    for (var i = 0; i < btns.length; i++) { var k = blockOf(btns[i]); if (k) return k; }
    return "";
  };
  var OUT = /(sold ?out|notify ?me|join the wait ?list|wait ?list|warteliste|liste d.attente|ausverkauft|esaurit|agotad|épuisé|epuise|not available|unavailable|out of stock|nicht verfügbar|nicht vorr[äa]tig|vergriffen|nicht auf lager|derzeit nicht|benachrichtig)/i;
  var SZL = "(?:x{0,3}s|m|x{0,4}l|[2-6]xl)";
  var SZRE = new RegExp("^(?:" + SZL + "(?:\\s?[\\/-]\\s?" + SZL + ")?|one ?size|os|tu|u|uni|(?:(?:it|eu|fr|uk|us|de|ysl|f)\\s?)?\\d{1,3}(?:[.,]5)?(?:\\s?(?:it|eu|fr|uk|us))?|\\d{2}\\/\\d{2}|w\\d{2}(?:\\s?l\\d{2})?)(?:\\s?[\\/-]\\s?\\S+)?$", "i");
  var okLabel = function (t) { t = String(t == null ? "" : t).replace(/\s+/g, " ").trim()
      /* LV женская обувь: целые размеры пишутся «38.0» — приводим к «38» (раньше такие размеры отбрасывались, оставались только половинки) */
      .replace(/^((?:eu\s?)?\d{1,3})[.,]0(\s?(?:eu|it|fr))?$/i, "$1$2")
      /* Prada: британский и европейский размер склеены («539 EU» = UK 5 / EU 39) — берём европейский */
      .replace(/^(\d{1,2}(?:[.,]5)?)\s*\/?\s*((?:3[4-9]|4\d|50)(?:[.,]5)?)\s?EU$/i, function (m, uk, eu) { return parseFloat(uk) <= 15 ? eu : m; })
      /* размер и статус в одной строке без разделителя (Brunello: «46Nur noch ein Artikel verfügbar», «52Produkt anfragen») — оставляем размер */
      .replace(/^(\d{2,3}(?:[.,]5)?|XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}\/\d{1,2})\s*(nur noch|noch \d|only|last|letzte|wenige|produkt anfragen|auf anfrage|request|benachrichtig|notify|in der boutique|verfügbar|available|anfrage|low stock|derniers?|ultimi|ultimo)\b.*$/i, "$1").replace(/\s*[-–—]\s*(join the wait ?list|wait ?list|sold ?out|notify ?me|out of stock|coming soon|pre-?order|low stock|only \d+ left)\b.*$/i, "").replace(/^([^/]{1,14}?)\s\/\s[A-Z]{2,4}\s?\d.*$/i, "$1").replace(/^ysl\s+/i, "").replace(/^(it|eu|fr|f|uk|us|de)\s?(\d)/i, "$2").replace(/(\d)\s?(?:½|1\/2)(?!\d)/g, "$1.5").replace(/(\d),5\b/g, "$1.5"); /* половинки: 40½, 40 1/2, 40,5 → 40.5 */ return t && t.length <= 20 && SZRE.test(t) ? t.split(" / ")[0].trim() : null; };
  // массив JSON целиком, со вложенными скобками (у сайтов на Salesforce внутри размеров бывают свои списки)
  var arrAt = function (h, i) { var d = 0, q = false, e = false; for (var j = i; j < h.length && j < i + 80000; j++) { var c = h[j]; if (q) { if (e) e = false; else if (c === "\\") e = true; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === "[" || c === "{") d++; else if (c === "]" || c === "}") { d--; if (!d) return h.slice(i, j + 1); } } return null; };
  var jsonSizes = function (html) {
    var H0 = String(html || ""), lists = [];
    [H0, H0.replace(/&quot;/g, '"'), H0.replace(/\\"/g, '"')].forEach(function (H, n) {
      if (lists.length || (n && H === H0)) return;
      var re = /"(?:sizes|sizeOptions|availableSizes|sizeList)"\s*:\s*\[/g, m;
      while ((m = re.exec(H)) && lists.length < 4) { var a = arrAt(H, m.index + m[0].length - 1); if (a) try { lists.push(JSON.parse(a)); } catch (e) {} }
      var re2 = /"(?:attributeId|attribute_id|id|code|name)"\s*:\s*"size"[^\[\]]{0,600}?"(?:values|options)"\s*:\s*\[/gi;
      while ((m = re2.exec(H)) && lists.length < 8) { var b = arrAt(H, m.index + m[0].length - 1); if (b) try { lists.push(JSON.parse(b)); } catch (e) {} }
    });
    var out = [];
    lists.forEach(function (L) { [].concat(L || []).forEach(function (z) {
      if (z == null) return; if (typeof z !== "object") { out.push([z, null]); return; }
      var lab = z.displayValue || z.value || z.label || z.name || z.size || z.text || z.id;
      var ok = z.isAvailable != null ? !!z.isAvailable : z.orderable != null ? !!z.orderable : z.selectable != null ? !!z.selectable : z.inStock != null ? !!z.inStock : z.available != null ? !!z.available : z.availability != null ? !/out|sold|unavail/i.test(String(z.availability)) : null;
      var pre = !!(z.preorder || z.isPreorder || z.isPreOrder || z.preOrder || z.preOrderable) || /pre_?order|presale|backorder/i.test(String(z.availability || z.status || ""));
      out.push([lab, ok, pre]); }); });
    return out;
  };
  // размеров не нашли — короткий кусок страницы рядом со словом size (без личных данных), чтобы понять формат сайта
  var sizeDbg = function (html) { var H = String(html || "").replace(/<style[\s\S]*?<\/style>/gi, " "), re = /size/gi, m, out = [], last = -999;
    while ((m = re.exec(H)) && out.length < 4) { if (m.index - last < 300) continue; var pre = H.slice(Math.max(0, m.index - 30), m.index).toLowerCase(); if (/(font-|background-|max-|min-|data-|aria-|box-|text-|icon|image|img)$/.test(pre) || /^sizes?="/i.test(H.slice(m.index, m.index + 7)) || /^size-adjust/i.test(H.slice(m.index, m.index + 12))) continue; last = m.index; out.push(H.slice(Math.max(0, m.index - 60), m.index + 160).replace(/\s+/g, " ")); }
    return out.join(" | ").slice(0, 900); };
  // размеры на готовой странице без известных классов: ищем группу кнопок/пунктов, подписи которых похожи на размеры (XS, 44, IT 38…)
  var genericSizes = function (doc) {
    var groups = new Map();
    [].slice.call(doc.querySelectorAll('button, li, label, a, [role="radio"], [role="option"], option, input[type="radio"]')).forEach(function (el) {
      if (el.closest && el.closest("nav, header, footer, [class*='filter' i], [class*='breadcrumb' i]")) return;
      var t = el.tagName === "INPUT" ? (el.value || el.getAttribute("aria-label") || "") : (el.getAttribute("aria-label") && okLabel(el.getAttribute("aria-label")) ? el.getAttribute("aria-label") : el.textContent);
      var lab = okLabel(String(t || "").replace(/(sold ?out|notify me|out of stock|ausverkauft|épuisé|join the wait ?list)/ig, "").trim()); if (!lab) return;
      var par = el.parentElement; if (par && par.children.length === 1 && par.parentElement) par = par.parentElement;
      if (!par) return; if (!groups.has(par)) groups.set(par, []); groups.get(par).push({ el: el, lab: lab });
    });
    var best = null; groups.forEach(function (g) { var n = {}; g.forEach(function (x) { n[x.lab] = 1; }); var k = Object.keys(n).length; if (k >= 2 && (!best || k > best.k)) best = { g: g, k: k }; });
    if (!best) return [];
    var rows = best.g.map(function (x) { var el = x.el, cls = String(el.className || "") + " " + String((el.parentElement || {}).className || ""), tx = el.textContent || "";
      return { lab: x.lab, hard: OUT.test(tx) || /(sold|unavail|notavail|not-available|out-of-stock|oos|strike)/i.test(cls), soft: /disabled/i.test(cls) || el.getAttribute("aria-disabled") === "true" || !!el.disabled, pre: PRE.test(tx) }; });
    var allSoft = rows.every(function (x) { return x.soft && !x.hard; });
    return rows.map(function (x) { return [x.lab, allSoft ? null : !(x.hard || x.soft), x.pre]; });
  };
  // размеры дорисовываются на странице уже в браузере (Saint Laurent и др.): открываем страницу товара в невидимом окне этого же сайта,
  // ждём, пока появятся размеры, и читаем их с готовой страницы — так же, как их видит покупатель
  var rOk = 0, rFail = 0, rMem = {}; try { rMem = JSON.parse(localStorage.getItem("tbRender") || "{}"); } catch (e) {}
  // пропуск окна с размерами — только если на этом сайте оно ни разу не сработало и подряд не вышло много раз (не на неделю: одна неудачная серия не должна отключать размеры)
  var rSkip = rMem.ok === 0 && rMem.fail >= 12 && Date.now() - (rMem.at || 0) < 864e5;
  var rSave = function () { try { localStorage.setItem("tbRender", JSON.stringify({ ok: (rMem.ok || 0) + rOk > 0 ? 1 : 0, fail: rOk ? 0 : rFail, at: Date.now() })); } catch (e) {} };
  // образец для точной настройки под бренд: где на странице лежат размеры (кусок разметки списка размеров и место в коде страницы) — без цен и личных данных
  var capDom = function (d, labels) { try {
    var els = [].slice.call(d.querySelectorAll("button, li, label, option, a, span, div, [role='radio'], [role='option']")).filter(function (e) { var t = (e.textContent || "").replace(/\s+/g, " ").trim(); return labels.indexOf(t) >= 0 && e.children.length <= 3; });
    if (!els.length) return ""; var c = els[0];
    for (var k = 0; k < 6 && c.parentElement; k++) { c = c.parentElement; var n = 0; els.forEach(function (e) { if (c.contains(e)) n++; }); if (n >= Math.min(3, els.length)) break; }
    var x = c.cloneNode(true);
    [x].concat([].slice.call(x.querySelectorAll("*"))).forEach(function (e) { [].slice.call(e.attributes || []).forEach(function (a) { if (!/^(class|data-|aria-|disabled|role|type|name|value|for|id)/.test(a.name)) e.removeAttribute(a.name); }); if (/^(svg|script|style|img|picture|path)$/i.test(e.tagName)) e.innerHTML = ""; });
    return x.outerHTML.replace(/\s+/g, " ").slice(0, 7000); } catch (e) { return ""; } };
  var capHtml = function (h, labels) { var out = []; h = String(h || "");
    labels.slice(0, 3).forEach(function (l) { var re = new RegExp('"[A-Za-z_]{1,40}"\\s*:\\s*"' + l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"', "g"), m, n = 0; while ((m = re.exec(h)) && n < 2) { n++; out.push(h.slice(Math.max(0, m.index - 250), m.index + 250).replace(/\s+/g, " ")); } });
    return out.join(" || ").slice(0, 4000); };
  var imgKey = function (u, code) { var f = String(u || "").split("?")[0].split("/").pop(), F = f.toUpperCase(), i = code ? F.indexOf(code) : -1; return (i >= 0 ? F.slice(i) : F).replace(/\.(JPE?G|PNG|WEBP|AVIF)$/, "").toLowerCase(); };
  // ссылки на другие цвета той же модели: в блоке выбора цвета (swatch / color / colour / variant) на странице товара
  var colorLinks = function (doc, url) { var me = codeOf(url), out = [], base = new URL(url);
    [].slice.call(doc.querySelectorAll("a[href]")).forEach(function (a) { var hr = a.getAttribute("href") || ""; var u; try { u = new URL(hr, base).href.split("#")[0]; } catch (e) { return; } var c = codeOf(u); if (!c || c === me || new URL(u).hostname !== base.hostname) return;
      var el = a, hit = false; for (var d = 0; d < 5 && el; d++) { var s0 = ((el.className && el.className.baseVal != null ? el.className.baseVal : el.className) || "") + " " + (el.getAttribute && (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("data-testid") || "") + " " + (el.id || "")); if (/(swatch|colou?r|variant|farbe|couleur)/i.test(s0)) { hit = true; break; } el = el.parentElement; }
      if (hit && out.indexOf(u) < 0) out.push(u); });
    return out.slice(0, 12); };
  // список размеров в панели, куда ведёт кнопка «Select size» (aria-controls): подпись — собственный текст пункта, статус («JOIN THE WAITLIST», «sold out») — отдельно
  // размер зачёркнут (LV: распроданные размеры перечёркнуты, без надписи) или помечен «недоступен» в подписи для экранных дикторов
  var struck = function (el) { try { var w0 = (el.ownerDocument && el.ownerDocument.defaultView) || window, all = [el].concat([].slice.call(el.querySelectorAll("*")).slice(0, 8));
    for (var q = 0; q < all.length; q++) { var e = all[q]; if (/^(S|DEL|STRIKE)$/.test(e.tagName)) return true;
      var cs = w0.getComputedStyle(e); if (/line-through/.test(cs.textDecorationLine || cs.textDecoration || "")) return true;
      if (e.getAttribute && (e.getAttribute("aria-disabled") === "true" || OUT.test(e.getAttribute("aria-label") || "") || /out.?of.?stock|unavailable|sold.?out|not.?available|disabled/i.test(String(e.className && e.className.baseVal != null ? e.className.baseVal : e.className || "")))) return true; }
    return false; } catch (e) { return false; } };
  var panelSizes = function (d, sb) { try {
    var id = sb && (sb.getAttribute("aria-controls") || ""), pan = id ? d.getElementById(id) : null; if (!pan) return [];
    var items = [].slice.call(pan.querySelectorAll("button, [role='option'], [role='radio'], option, label")); if (!items.length) items = [].slice.call(pan.querySelectorAll("li"));
    var out = [], seen = {};
    items.forEach(function (el) { var host = el.querySelector("span") || el, own = "";
      [].slice.call(host.childNodes).forEach(function (n) { if (n.nodeType === 3) own += n.textContent; });
      own = own.replace(/\s+/g, " ").trim() || (el.textContent || "").replace(/\s+/g, " ").trim();
      var lab = okLabel(own); if (!lab || seen[lab]) return; seen[lab] = 1;
      var full = el.textContent || "", dis = el.disabled || el.getAttribute("aria-disabled") === "true" || /disabled|unavail|sold/i.test(String(el.className || "")) || struck(el);
      out.push(PRE.test(full) ? { s: lab, ok: null, pre: true } : { s: lab, ok: OUT.test(full) || dis ? false : true }); });
    return out; } catch (e) { return []; } };
  // размеры подряд после заголовка «Größe/Size» (Brunello: «44», «Produkt anfragen», «46», «48»…): статус идёт отдельным пунктом после размера
  var seqSizes = function (d) { try {
    var tEl = [].slice.call(d.querySelectorAll("button, [role='button'], [role='option'], [role='radio'], li, label, span")).filter(function (b) { return !b.querySelector("button, li, label"); }).map(function (b) { return [(b.textContent || "").replace(/\s+/g, " ").trim(), b]; }).filter(function (x) { return x[0] && x[0].length < 40; });
    var toks = tEl.map(function (x) { return x[0]; });
    var i0 = -1; for (var i = 0; i < toks.length; i++) if (/^(gr[öo](ss|ß)e|size|taille|taglia|talla|maat)$/i.test(toks[i])) { i0 = i; break; } if (i0 < 0) return [];
    var out = [], seen = {}, cur = null, miss = 0;
    for (var j = i0 + 1; j < toks.length && miss < 2; j++) { var tk = toks[j], lab = okLabel(tk);
      if (lab) { miss = 0; if (seen[lab] !== undefined) { cur = out[seen[lab]]; continue; } cur = PRE.test(tk) ? { s: lab, ok: null, pre: true } : { s: lab, ok: OUT.test(tk) || struck(tEl[j][1]) ? false : true }; seen[lab] = out.length; out.push(cur); continue; }
      if (cur && PRE.test(tk)) { cur.ok = null; cur.pre = true; continue; }
      if (cur && OUT.test(tk)) { cur.ok = false; delete cur.pre; continue; }
      if (cur && /(nur noch|verfügbar|only|last|letzte|wenige|low stock|derniers?|ultimi)/i.test(tk)) continue;
      miss++; }
    return out.length >= 2 || (out.length === 1 && /^(one ?size|os|tu|u|uni)$/i.test(out[0].s)) ? out : [];
  } catch (e) { return []; } };
  var rLock = Promise.resolve();
  // фото галереи с открытой страницы (сайты, где в адресе фото нет артикула — On и др.): крупные картинки товара, без шапки, подвала и «вам может понравиться»
  var galleryOf = function (doc, url) { var me = codeOf(url), out = [], seen = {}, base0 = new URL(url).pathname.split("/").slice(0, -1).join("/"), sameModel = function (h) { try { var pp = new URL(h, url).pathname; return base0.length > 10 && pp.indexOf(base0) === 0; } catch (e) { return false; } };
    var big = function (im) { var c = [im.currentSrc || im.getAttribute("src") || ""]; String(im.getAttribute("srcset") || im.getAttribute("data-srcset") || "").replace(/(\s\d+(?:\.\d+)?[wx])\s*,\s*/g, "$1\u0001").split("\u0001").forEach(function (x) { var q = x.trim().split(/\s+/); if (q[0]) c.push(q[0]); }); c.push(im.getAttribute("data-src") || ""); var pic0 = im.closest && im.closest("picture"); if (pic0) [].slice.call(pic0.querySelectorAll("source")).forEach(function (so) { String(so.getAttribute("srcset") || so.getAttribute("data-srcset") || "").replace(/(\s\d+(?:\.\d+)?[wx])\s*,\s*/g, "$1\u0001").split("\u0001").forEach(function (x) { var q = x.trim().split(/\s+/); if (q[0]) c.push(q[0]); }); }); return c.filter(function (u) { return /^https?:\/\//.test(u); }).pop() || ""; };
    [].slice.call(doc.querySelectorAll("img")).forEach(function (im) { if (out.length >= 8) return;
      if (im.closest && im.closest("header, nav, footer, [role=dialog], [aria-modal=true]")) return;
      var w = Math.max(im.naturalWidth || 0, im.width || 0, +(im.getAttribute("width") || 0)); if (w && w < 300) return;
      var ia = im.closest && im.closest("a[href]"); if (ia && codeOf(ia.href) && codeOf(ia.href) !== me) return; // картинка-ссылка на другой товар или цвет (кружок цвета)
      for (var el = im, d = 0; d < 4 && el.parentElement; d++) { el = el.parentElement; var other = 0; [].slice.call(el.querySelectorAll("a[href]")).forEach(function (a) { var c = codeOf(a.href); if (c && c !== me && !sameModel(a.href)) other++; }); if (other) { if (el.querySelectorAll("img").length <= other + 1) return; break; } } // плитка другого товара (одна картинка + ссылка) — не наша галерея
      var u = big(im); if (!u || /(logo|icon|sprite|placeholder|blank|1x1|svg)/i.test(u)) return; var qw = +((u.match(/[?&]w=(\d+)/) || [])[1] || 0); if (qw && qw < 300) return; var k = u.split("?")[0]; if (seen[k]) return; seen[k] = 1; out.push(u); });
    return out; };
  // сколько страниц открываем одновременно: обычно одну (тяжело для компьютера), на LV — три (страница лёгкая, наличие читается за 1–2 с после загрузки)
  var rMax = 1, rBusy = 0, rQ = [];
  var rendered = async function (url, p, raw) {
    if (rBusy >= rMax) await new Promise(function (r) { rQ.push(r); }); rBusy++;
    try { return await rendered0(url, p, raw); } finally { rBusy--; var nx = rQ.shift(); if (nx) nx(); } };
  // LV: одна страница-окно на весь прогон. Следующий товар открываем внутри неё, как переход по ссылке на сайте (страница не грузится заново) — в 2–3 раза быстрее;
  // если переход не удался (другой товар не открылся за 4,5 с) — обычная загрузка страницы, как раньше
  var lvF = null, lvSpa = 0, lvFull = 0;
  // LV закрыл доступ (ответ 403 «Access Denied»): запоминаем в этом браузере, чтобы не стучаться снова, пока не пройдёт пауза —
  // повторные попытки только продлевают блокировку. stock — чтение наличия (страница как у покупателя), pages — сами страницы товаров
  var LVDK = "tbLvDeny", lvDeny = {}; try { lvDeny = JSON.parse(localStorage.getItem(LVDK) || "{}") || {}; } catch (e) {}
  var lvDenySet = function (k, min) { lvDeny[k] = Date.now() + min * 6e4; try { localStorage.setItem(LVDK, JSON.stringify(lvDeny)); } catch (e) {} };
  var lvLeft = function (k) { return Math.max(0, Math.ceil(((lvDeny[k] || 0) - Date.now()) / 6e4)); };
  // ответ сайта на запрос наличия внутри открытой страницы: 403 — LV не отдаёт наличие (ждать панель размеров бесполезно), 200 — отдал
  // Safari не сообщает код ответа в performance (responseStatus есть только в Chrome/Firefox) — поэтому ещё и смотрим ответ сайта на запрос наличия в самом окне
  var bigBuf = function (w) { try { if (w && w.performance && !w.__tbBuf) { w.performance.setResourceTimingBufferSize(5000); w.__tbBuf = 1; } } catch (e) {} };
  var hookAv = function (w) { try { if (!w || w.__tbAvHook) return; var of = w.fetch; if (typeof of !== "function") return; w.__tbAvHook = 1; w.__tbAv = [];
    w.fetch = function (u) { var url = String(u && u.url || u), pr = of.apply(this, arguments); if (/\/availability(\?|$)/.test(url)) pr.then(function (r) { w.__tbAv.push(r.status); }, function () { w.__tbAv.push(-2); }); return pr; }; } catch (e) {} };
  var avStatus = function (w) { try { var es = w.performance.getEntriesByType("resource").filter(function (e) { return /\/availability(\?|$)/.test(e.name); }); var e = es[es.length - 1]; if (!e) return -1;
    if (typeof e.responseStatus === "number" && e.responseStatus > 0) return e.responseStatus; // Chrome / Firefox
    var h = w.__tbAv || []; if (h.length) return h[h.length - 1]; // Safari: ответ, перехваченный в окне
    return 200; } catch (e) { return -1; } }; // код ответа узнать нельзя — считаем, что ответил
  // LV одежда/аксессуары: размеры — «плашки» в окне выбора (не выпадающий список, как у обуви); у каждой подпись «46 - Verfügbar» / «50 - Nicht verfügbar.»
  var lvChips = function (d) { var out = [], seen = {};
    [].slice.call(d.querySelectorAll(".lv-product-variation-badges__item [aria-label], .lv-choice-group__item [aria-label], [role='option'][aria-label], [class*='variation'] [aria-label]")).forEach(function (e) {
      var m = String(e.getAttribute("aria-label") || "").match(/^\s*(.{1,14}?)\s+-\s+(nicht\s+)?verf[üu]gbar/i); if (!m) return; var sz = m[1].trim().replace(/^(\d+)\.0$/, "$1"); if (seen[sz]) return; seen[sz] = 1; out.push({ s: sz, ok: !m[2] }); });
    return out; };
  // LV: следующий товар открываем в том же окне через навигацию самого сайта (как клик по ссылке на товар): ≈70 лёгких запросов
  // вместо полной загрузки страницы (≈250 запросов + 1,3 МБ). Ждём, пока на странице окажется именно этот товар (код в данных страницы)
  var avCount = function (w) { try { return w.performance.getEntriesByType("resource").filter(function (e) { return /\/availability(\?|$)/.test(e.name); }).length; } catch (e) { return 0; } };
  var lvSku = function (d) { try { var x = null; [].slice.call(d.querySelectorAll('script[type="application/ld+json"]')).some(function (s) { try { var j = JSON.parse(s.textContent); x = [].concat(j["@graph"] || j).filter(function (o) { return o && /Product/.test(String(o["@type"])); })[0]; return !!x; } catch (e) { return false; } }); return x && String(x.sku || "").toUpperCase() || ""; } catch (e) { return ""; } };
  var lvGo = async function (url) {
    if (!lvF || !lvF.isConnected) return null;
    try { var w = lvF.contentWindow, d0 = lvF.contentDocument; if (!w || !d0 || !d0.body) return null;
      var path = new URL(url, location.href).pathname, code = ((path.match(/\/([A-Za-z0-9]{5,8})\/?$/) || [])[1] || "").toUpperCase();
      if ((w.location.pathname === path || lvF.__want === path) && lvF.__av0 != null) return { avN0: lvF.__av0, alias: lvF.__alias || "" }; // уже открыт (страница товара для данных) — наличие читаем там же
      var app = d0.querySelector("#__nuxt") && d0.querySelector("#__nuxt").__vue_app__, R = app && app.config && app.config.globalProperties && app.config.globalProperties.$router; if (!R) return null;
      try { d0.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })); } catch (e) {}
      [].slice.call(d0.querySelectorAll(".lv-modal__close")).forEach(function (b) { try { b.click(); } catch (e) {} });
      hookAv(w); bigBuf(w); try { w.performance.clearResourceTimings(); w.__tbAv = []; } catch (e) {} // перед переходом — чистый список запросов: ответ наличия этой вещи точно запишется
      var avN0 = avCount(w), sk0 = lvSku(d0), p0 = w.location.pathname, pseg = path.replace(/\/[A-Za-z0-9]{5,8}\/?$/, "/"); R.push(path).catch(function () {});
      for (var q = 0; q < 50; q++) { await sleep(160); var d = lvF.contentDocument; if (!d || !d.body) continue;
        var sk = lvSku(d), lp = w.location.pathname; if (lp === path && sk && (sk === code || sk !== sk0) && d.querySelector("h1")) { lvF.__av0 = avN0; lvF.__want = path; lvF.__alias = ""; lvSpa++; return { avN0: avN0 }; }
        // мужская обувь LV: у каждого размера свой код; сайт при переходе сам выбирает другой размер той же модели и цвета (1AL3M1 → 1AL3LZ).
        // Данные (название, цвет, цена, фото, список размеров и наличие) те же — принимаем, а сохраняем под исходным кодом (без дублей)
        var lc = ((lp.match(/\/([A-Za-z0-9]{5,8})\/?$/) || [])[1] || "").toUpperCase(); if (lp !== path && lp !== p0 && lp.indexOf(pseg) === 0 && lc && sk === lc && sk !== sk0 && d.querySelector("h1")) { lvF.__av0 = avN0; lvF.__want = path; lvF.__alias = lc; lvSpa++; return { avN0: avN0, alias: lc }; } }
    } catch (e) {}
    return null; };
  // LV: открыть товар в окне (первый — обычной загрузкой, дальше — навигацией сайта) и отдать разметку уже открытой страницы — без отдельного скачивания 1,3 МБ
  var lvOpen = async function (url) {
    var path = new URL(url, location.href).pathname, code = ((path.match(/\/([A-Za-z0-9]{5,8})\/?$/) || [])[1] || "").toUpperCase();
    var g = await lvGo(url);
    if (!g) { // первая вещь или навигация не удалась — обычная загрузка в окне
      if (!lvF || !lvF.isConnected) { lvF = document.createElement("iframe"); lvF.setAttribute("aria-hidden", "true"); lvF.tabIndex = -1; lvF.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;opacity:0;pointer-events:none;border:0;z-index:-2147483647"; document.body.appendChild(lvF); }
      var old = null; try { old = lvF.contentDocument; } catch (e) {}
      lvF.__av0 = null; lvF.__want = path; lvF.__alias = ""; lvF.src = url; lvFull++;
      for (var q = 0; q < 80; q++) { await sleep(200); var d1 = null; try { d1 = lvF.contentDocument; if (d1 && d1 !== old) bigBuf(lvF.contentWindow); } catch (e) { return null; } if (d1 && d1 !== old && d1.body && lvSku(d1) && d1.querySelector("h1")) { lvF.__av0 = 0; hookAv(lvF.contentWindow); break; } }
      if (lvF.__av0 == null) return null;
    }
    try { var dd = lvF.contentDocument; if (/Access Denied|Zugriff verweigert/i.test(dd.title || "")) return { denied: true }; return { html: "<!DOCTYPE html>" + dd.documentElement.outerHTML, alias: lvF.__alias || "" }; } catch (e) { return null; }
  };
  var rendered0 = async function (url, p, raw) {
    var lvS = /louisvuitton\.com$/.test(location.hostname); // LV: наличие есть только в открытой странице — не отключаем чтение после неудач
    if (!lvS && (rSkip || (rOk === 0 && rFail >= 15))) return { sst: [], blocked: "", dbg: "R skip" };
    var spa = false, avN0 = 0; if (lvS) { var gg = await lvGo(url); if (gg) { spa = true; avN0 = gg.avN0 || 0; } } // LV: товар уже открыт или открываем навигацией сайта
    var f = spa ? lvF : (lvS && lvF && lvF.isConnected ? lvF : document.createElement("iframe")); f.setAttribute("aria-hidden", "true"); f.tabIndex = -1;
    // в пределах экрана (прозрачно, позади страницы): иначе сайт считает блок невидимым и не подгружает размеры
    f.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;opacity:0;pointer-events:none;border:0;z-index:-2147483647";
    if (lvS) { lvF = f; if (!spa) { lvFull++; lvF.__av0 = 0; } }
    var out = { sst: [], blocked: "", dbg: "" };
    try {
      // не ждём, пока догрузятся все картинки и скрипты страницы (onload у LV — 5–8 с): как только страница товара разобрана — читаем
      // ждём именно НОВУЮ страницу: окно переиспользуется, и раньше мы успевали прочитать (и нажать) ещё старую — потом ждали панель до конца (лишние 9 с) и рисковали взять размеры прошлого товара
      var oldDoc = null; try { oldDoc = f.isConnected && !spa ? f.contentDocument : null; } catch (e) {}
      var tL0 = Date.now();
      if (!spa) await new Promise(function (ok) { var done = false, fin = function () { if (!done) { done = true; clearInterval(iv); ok(); } }, t0 = Date.now(); f.onload = function () { try { if (f.contentDocument !== oldDoc) fin(); } catch (e) { fin(); } }; f.src = url; if (!f.isConnected) document.body.appendChild(f);
        var iv = setInterval(function () { try { var d = f.contentDocument; if (d && d !== oldDoc) bigBuf(f.contentWindow); if (d && d !== oldDoc && d.readyState !== "loading" && d.body && d.body.children.length && String(d.location.href).indexOf("about:") !== 0) fin(); } catch (e) {} if (Date.now() - t0 > 10000) fin(); }, 150); });
      var tL = Date.now() - tL0;
      var last = "", same = 0, clicked = false, info = [spa ? "spa" : "load"];
      try { info.push(f.contentDocument ? "loaded:" + String(f.contentWindow.location.pathname).slice(0, 60) : "blocked"); } catch (e) { info.push("blocked:" + (e && e.name)); }
      var lvP = /louisvuitton\.com$/.test(location.hostname) && !(p && p.__ns); // LV: размеры в коде страницы есть сразу, а наличие — только в открытой панели размеров; без панели не доверяем
      for (var t = 0; t < (lvP ? 36 : 24); t++) {
        await sleep(t < 2 ? 300 : 200);
        var d = f.contentDocument; if (!d || !d.body || d === oldDoc) continue;
        if (lvS && t >= 1) { var as = avCount(f.contentWindow) > avN0 ? avStatus(f.contentWindow) : -1; if (as === 403 || as === 429) { out.denied = true; info.push("av:" + as); break; } if (as === 200 && !out.avOk) { out.avOk = true; info.push("av:200"); } }
        if (lvS && lvP && out.avOk && clicked) { var lc = lvChips(d), lk = JSON.stringify(lc); if (lc.length) { if (lk === out.lcK) { out.sst = lc; info.push("chips"); break; } out.lcK = lk; } } // наличие пришло (200) и плашки два раза подряд одинаковые — читаем
        if (p && p.__ns && (t >= 20 || (t >= 2 && visBuy(d) && (!lvS || out.avOk)))) break; // LV: кнопку «в корзину / сообщить» читаем только после ответа наличия — до него LV показывает «Benachrichtigen» у всего // вещь без размеров (сумка, ремень): ждём, пока появится видимая кнопка «в корзину / сообщить о поступлении» (до ~5 с)
        if (out.btn && !(lvS && !out.avOk)) { var ps = panelSizes(d, out.btn); if (!ps.length && t >= 3) ps = seqSizes(d); if (ps.length) { if (!lvS) { out.sst = ps; break; } var pk = JSON.stringify(ps); if (pk === out.psK) { out.sst = ps; break; } out.psK = pk; } } // LV: список размеров (выпадающий у обуви) — только ПОСЛЕ ответа наличия и два раза подряд одинаковый. Раньше читали за доли секунды, пока LV ещё не ответил, — все размеры выглядели «нет» и пары ошибочно уходили в «распродано»
        // размеры прячутся за кнопкой «Select your size» — нажимаем её один раз (как покупатель), чтобы список появился
        if (!clicked && t >= 1) { var sb = [].slice.call(d.querySelectorAll("button, [role='button'], a")).filter(function (b) { var tx = (b.textContent || "").replace(/\s+/g, " ").trim(); return tx.length < 40 && /(select|choose|choisir|w[äa]hlen|seleziona|kies|elige|selecciona)?\s*(your\s*|uw\s*|tu\s*)?(size|taille|gr[öo](ss|ß)e|taglia|maat|talla)/i.test(tx) && !/guide|chart|tabelle|vergleich|compare/i.test(tx); })[0]; if (sb) { clicked = true; try { sb.click(); out.btn = sb; info.push("click:" + (sb.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30)); } catch (e) {} } else if (t >= 8) { clicked = true; info.push("nobtn"); } }
        var sst = sizeInfo(d, "", p || {}), key = JSON.stringify(sst);
        if (sst.length) { if (key === last) { if (++same >= 2 && !lvP) { out.sst = sst; break; } } else { last = key; same = 0; } }
      }
      info.push("L" + tL + "/P" + (Date.now() - tL0 - tL));
      var d2 = f.contentDocument;
      try { if (d2) out.gal = galleryOf(d2, url); } catch (e) {}
      if (d2) { if (!out.sst.length && last && !lvP) out.sst = JSON.parse(last); if (lvP && !out.sst.length) info.push("lv:nopanel"); out.blocked = pageBlock(d2, d2.documentElement.outerHTML, p || {}, "");
        if (/louisvuitton\.com$/.test(location.hostname)) { var vb = visBuy(d2); info.push("buy:" + (vb ? vb.s + "=" + vb.t : "-")); out.blocked = vb ? (vb.s === "buy" ? "" : vb.s) : out.blocked; } /* LV: решает видимая кнопка */ if (!out.sst.length) { var bt = [].slice.call(d2.querySelectorAll("button, [role='button'], li, label")).map(function (b) { return (b.textContent || "").replace(/\s+/g, " ").trim(); }).filter(function (t) { return t && t.length < 25; }).slice(0, 60).join("|");
        out.dbg = ("R " + info.join(" ") + " · BTN " + bt + " · " + sizeDbg(d2.body ? d2.body.innerHTML : "")).slice(0, 900); } }
      else out.dbg = "R " + info.join(" ") + " · нет доступа к странице в окне";
    } catch (e) {}
    // размеры не нашлись — снимаем разметку открывшейся панели размеров (куда ведёт кнопка «Select size»), чтобы настроить чтение под бренд
    try { if (!out.sst.length && f.contentDocument) { var dd = f.contentDocument, pan = null, bb = out.btn;
      var ctl = bb && (bb.getAttribute("aria-controls") || bb.getAttribute("data-target") || ""); if (ctl) pan = dd.getElementById(ctl.replace(/^#/, ""));
      if (!pan) pan = [].slice.call(dd.querySelectorAll("[role='dialog'], [aria-modal='true'], [class*='size' i][class*='panel' i], [class*='size' i][class*='drawer' i], [class*='size' i][class*='modal' i], [class*='sizes' i], [class*='size-selector' i], [data-testid*='size' i]")).filter(function (e) { return (e.textContent || "").replace(/\s+/g, "").length > 4; }).pop();
      if (!pan && bb) { pan = bb.parentElement; for (var up = 0; up < 3 && pan && pan.parentElement; up++) pan = pan.parentElement; }
      if (pan) { var x = pan.cloneNode(true); [x].concat([].slice.call(x.querySelectorAll("*"))).forEach(function (e) { [].slice.call(e.attributes || []).forEach(function (a) { if (!/^(class|data-|aria-|disabled|role|type|name|value|for|id)/.test(a.name)) e.removeAttribute(a.name); }); if (/^(svg|script|style|img|picture|path)$/i.test(e.tagName)) e.innerHTML = ""; });
        out.cap = { url: url.split("?")[0], fail: true, info: info.join(" ").slice(0, 200), dom: x.outerHTML.replace(/\s+/g, " ").slice(0, 9000) }; } } } catch (e) {}
    try { if (/louisvuitton\.com$/.test(location.hostname)) { var bq = out.btn, pq = bq && bq.getAttribute("aria-controls"), pe = pq && f.contentDocument && f.contentDocument.getElementById(pq);
      out.dbg = ("R " + info.join(" ") + " · ctl:" + (pq || "-") + (pe ? " panel:" + (pe.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) + " li:" + pe.querySelectorAll("li, button").length : " nopanel") + " · SST " + out.sst.map(function (x) { return x.s + (x.ok === false ? "✗" : ""); }).join(",") + (out.dbg && !out.sst.length ? " · " + out.dbg.slice(0, 400) : "")).slice(0, 900); } } catch (e) {}
    if (out.denied) { out.blocked = ""; out.sst = []; } // наличие не отдали — ни «распродано», ни «лист ожидания» по этой странице не решаем
    if (lvS && !out.avOk && !out.denied) { out.blocked = ""; out.sst = []; out.noAv = true; } // LV не прислал наличие (или не дождались) — ни размеров, ни «распродано» по этой странице не решаем
    delete out.btn; delete out.lcK; delete out.psK;
    try { if (out.sst.length && f.contentDocument) { var labs = out.sst.map(function (x) { return x.s; }); out.cap = { url: url.split("?")[0], labels: labs.slice(0, 20), dom: capDom(f.contentDocument, labs), inHtml: capHtml(raw, labs) }; } } catch (e) {}
    if (!lvS) f.remove(); if (out.sst.length) { rOk++; rFail = 0; } else rFail++; rSave(); return out;
  };
  var sizeInfo = function (doc, html, p, url) {
    var out = [], seen = {}, add = function (s, ok, pre) { s = okLabel(s); if (!s) return; if (seen[s] !== undefined) { if (ok === false) out[seen[s]].ok = false; return; } seen[s] = out.length; out.push(pre && ok !== false ? { s: s, ok: ok, pre: true } : { s: s, ok: ok }); };
    var avail = function (a) { a = String(a || ""); return /InStock|LimitedAvailability|PreOrder|PreSale|BackOrder|OnlineOnly/i.test(a) ? true : /OutOfStock|SoldOut|Discontinued|InStoreOnly/i.test(a) ? false : null; }; // InStoreOnly — только в бутике: онлайн не купить, «уточнить наличие»
    var preA = function (a) { return /PreOrder|PreSale|BackOrder/i.test(String(a || "")); };
    // Prada / Miu Miu: размеры и наличие — в данных страницы __NUXT_DATA__ (sizeCodes: UK value → EU convertedValue, inventoryStatus); JSON-LD даёт только общий список UK
    if (/(^|\.)(prada|miumiu)\.com$/i.test(location.hostname)) { try { var nx = (doc && doc.getElementById && doc.getElementById("__NUXT_DATA__")) ? doc.getElementById("__NUXT_DATA__").textContent : ((String(html || "").match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [])[1]);
      if (nx) { var NA = JSON.parse(nx), RV = function (v, d) { if (d > 8) return null; if (typeof v === "number") { var x = NA[v]; if (Array.isArray(x)) { if (typeof x[0] === "string" && /^(Shallow)?(Reactive|Ref)$/.test(x[0])) return RV(x[1], d + 1); return x.map(function (y) { return RV(y, d + 1); }); } if (x && typeof x === "object") { var o = {}; for (var k in x) o[k] = RV(x[k], d + 1); return o; } return x; } return v; };
        var me1 = String(p.sku || "").toUpperCase().replace(/_/g, "") || (url ? codeOf(url) : ""), cand = [];
        NA.forEach(function (x) { if (x && typeof x === "object" && !Array.isArray(x) && "sizeCodes" in x) { var sc = RV(x.sizeCodes, 0); if (Array.isArray(sc) && sc.length) cand.push(sc.filter(function (z) { return z && typeof z === "object"; })); } });
        var pick = cand.find(function (sc) { return me1 && sc.some(function (z) { return String(z.colorProductId || "").toUpperCase().replace(/_/g, "") === me1; }); }) || (cand.length === 1 ? cand[0] : null);
        if (pick) pick.forEach(function (z) { if (me1 && z.colorProductId && String(z.colorProductId).toUpperCase().replace(/_/g, "") !== me1) return; var lab = String(z.convertedValue || z.value || "").replace(",", ".").trim(); if (lab) add(lab, /^Available$/i.test(z.inventoryStatus || "") || (z.online === true && Number(z.availableQuantity) > 0)); }); } } catch (e) {} }
    if (!out.length) [].concat(p.hasVariant || []).forEach(function (v) { var o = [].concat(v.offers || [])[0] || {}; add(v.size || v.name, avail(o.availability), preA(o.availability)); });
    // On: кнопки размеров data-test-id="purchasePodSizeButton"; распроданный размер помечен …OutOfStock («Notify me») — берём все размеры с отметкой, а не только те, что есть
    if (!out.length && doc && doc.querySelectorAll) { var pod = [].slice.call(doc.querySelectorAll('[data-test-id="purchasePodSizeButton"]')).map(function (b) { var v = b.querySelector('[data-wk-name^="purchasePodSizeOption"]'); return v ? [(v.textContent || "").trim(), !/OutOfStock/i.test(v.getAttribute("data-wk-name") || "") && !b.disabled] : null; }).filter(Boolean);
      // обувь в американских размерах (US 8, 9…) не берём отсюда — нужны европейские (их читает следующий способ)
      if (pod.length && !pod.every(function (x) { return /^(US\s*)?\d{1,2}(\.5)?$/i.test(x[0]) && parseFloat(x[0].replace(/^US\s*/i, "")) < 20; })) pod.forEach(function (x) { add(x[0], x[1]); }); }
    // Salesforce-магазины (Golden Goose и др.): кнопки размеров — <input data-attr-id="size" data-attr-value="36">; распроданный — «сообщить о поступлении» (notify-me) или выключен
    if (!out.length && doc && doc.querySelectorAll) [].slice.call(doc.querySelectorAll('input[data-attr-id="size"][data-attr-value], input.size-value[value]')).forEach(function (x) { var w = x.closest(".attribute-item, li, label, div") || x, lab = doc.querySelector('label[for="' + (x.id || "").replace(/"/g, "") + '"]'), cls = String(x.className || "") + " " + String(w.className || "");
      add(x.getAttribute("data-attr-value") || x.value, x.disabled || /notify-?me|unselectable|unavailable|out-?of-?stock|sold/i.test(cls) || OUT.test((lab && lab.getAttribute("aria-description")) || "") ? false : true); });
    // Loro Piana: размеры — <input class="size-item__input" value="39,5" data-id="FAO3228_H0RP" disabled> (выключен — нет в наличии); только этого товара
    if (!out.length && doc && doc.querySelectorAll && /(^|\.)loropiana\.com$/.test(location.hostname)) { var lpId = String(p.sku || "").toUpperCase(), lpIn = [].slice.call(doc.querySelectorAll("input.size-item__input[value]")).filter(function (x) { return !lpId || String(x.getAttribute("data-id") || "").toUpperCase() === lpId; });
      lpIn.forEach(function (x) { if (/^(NR|UNI|TU|OS|U)$/i.test(String(x.value).trim())) return; add(String(x.value).replace(",", "."), !(x.disabled || x.hasAttribute("disabled"))); });
      if (lpIn.length) return out.slice(0, 40); } // один размер «NR» (шарфы, сумки…) — без размеров; наличие решает pageBlock. Раньше сюда попадал список «количество 1…10»
    // Dior: размеры и наличие лежат в данных страницы ("sizeLabel":"38.5" … "status":"AVAILABLE") — без открытия окна
    if (!out.length && /"__typename"\s*:\s*"ProductVariation"/.test(html || "")) { var hv = String(html).replace(/\\"/g, '"'), me0 = String(p.sku || "").toUpperCase(), rv = /"sku"\s*:\s*"([A-Z0-9]+_[A-Z0-9]+)_(?:T\w{1,5}|\d{2,3})"[\s\S]{0,300}?"sizeLabel"\s*:\s*"([^"]{1,12})"[\s\S]{0,900}?"status"\s*:\s*"([A-Z_]+)"/g, mv; while ((mv = rv.exec(hv))) { if (me0 && mv[1] !== me0) continue; add(mv[2], /^(AVAILABLE|IN_STOCK|LOW_STOCK|LAST_ITEMS?)$/.test(mv[3]) || /PRE/.test(mv[3]), /PRE/.test(mv[3])); } } // только размеры этого товара, не рекомендаций
    // запасной путь: размер из артикула предложения (…_T385 → 38.5) и его наличие
    if (!out.length) [].concat(p.offers || []).forEach(function (o) { var m = String(o.sku || "").match(/_T(\d{2})(5?)$/); if (m) add(m[1] + (m[2] ? ".5" : ""), avail(o.availability), preA(o.availability)); });
    // Gucci: размер в артикуле предложения после «_» («…_4.5 = 38.5 IT», «…_48», «…_M»): берём европейский/итальянский размер справа от «=»
    if (!out.length) [].concat(p.offers || []).forEach(function (o) { var sk = String(o.sku || ""), k = sk.lastIndexOf("_"); if (k < 0) return; var tl = sk.slice(k + 1).trim(); if (!tl || tl.length > 24) return; if (/=/.test(tl)) tl = tl.split("=").pop().trim(); tl = tl.replace(/\s*(IT|EU|FR|UK|US)$/i, "").trim(); if (okLabel(tl)) add(tl, avail(o.availability), preA(o.availability)); });
    if (!out.length) [].concat(p.offers || []).forEach(function (o) { var it = o.itemOffered || {}; if (o.size || it.size || (o.name && okLabel(o.name))) add(o.size || it.size || o.name, avail(o.availability), preA(o.availability)); });
    if (!out.length) { var els = [].slice.call(doc.querySelectorAll('[class*="sizeitem"]:not([class*="placeholder"]):not([class*="__"]), [class*="size-item"], [class*="size__item"], [class*="sizeSelector"] li, [class*="size-selector"] li, [data-size], button[class*="size" i]')).map(function (el) {
        var cls = String(el.className || "") + " " + String((el.firstElementChild || {}).className || "");
        return { lab: el.getAttribute("data-size") || (el.querySelector('[class*="label"]') || {}).textContent || el.textContent, hard: OUT.test(el.textContent) || /(sold|unavail|notavail|not-available|out-of-stock|oos)/i.test(cls),
          soft: /disabled/i.test(cls) || el.getAttribute("aria-disabled") === "true" || !!el.disabled, pre: PRE.test(el.textContent + " " + cls) }; });
      // все кнопки размеров «выключены» и ни одна не «продано» — это заготовка до загрузки страницы: наличие неизвестно, считаем доступными
      var allSoft = els.length && els.every(function (x) { return x.soft && !x.hard; });
      els.forEach(function (x) { add(x.lab, allSoft ? null : !(x.hard || x.soft), x.pre); }); }
    if (!out.length) jsonSizes(html).forEach(function (x) { add(x[0], x[1], x[2]); });
    if (!out.length) genericSizes(doc).forEach(function (x) { add(x[0], x[1], x[2]); });
    if (!out.length) [].concat(p.size || []).forEach(function (z) { add(z, null); });
    return out.slice(0, 40);
  };
  var gender = function (path) { var t = "/" + path.toLowerCase().replace(/[-_]/g, "/") + "/"; return /\/(women|womens|woman|donna|damen|damenmode|femme|femmes|dames|damesmode|womenswear)\//.test(t) ? "w" : /\/(men|mens|man|uomo|herren|herrenmode|homme|hommes|heren|herenmode|menswear)\//.test(t) ? "m" : "u"; };
  var build = async function (doc, html, url, limit, extra) {
    var all = lds(doc), p = all.find(function (o) { return isT(o, "Product") || isT(o, "ProductGroup"); }); if (!p) return null;
    // группа товаров (On и др.: одна модель, варианты — цвета): берём вариант этой страницы — его цену, наличие, фото и артикул
    if (isT(p, "ProductGroup") && p.hasVariant && !p.offers) { var vs = [].concat(p.hasVariant), uc = codeOf(url), pu = url.split(/[?#]/)[0];
      var v0 = vs.find(function (x) { return String(x.sku || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === uc; }) || vs.find(function (x) { var o = [].concat(x.offers || [])[0] || {}; return o.url && o.url.split(/[?#]/)[0] === pu; }) || vs[0];
      if (v0) { var pg = {}; Object.keys(p).forEach(function (k) { if (k !== "hasVariant") pg[k] = p[k]; }); pg["@type"] = "Product"; pg.sku = v0.sku || p.productGroupID; pg.offers = v0.offers; pg.image = v0.image || p.image; if (v0.color) pg.color = v0.color; if (v0.size) pg.size = v0.size; p = pg; } }
    var of = [].concat(p.offers || [])[0] || {}; if (of.offers) of = [].concat(of.offers)[0] || of; var ps = of.priceSpecification ? [].concat(of.priceSpecification)[0] : of;
    var price = Number(String(ps.price != null ? ps.price : of.lowPrice != null ? of.lowPrice : "").replace(",", ".")) || null;
    var bc = all.find(function (o) { return isT(o, "BreadcrumbList"); });
    var crumbs = ((bc && bc.itemListElement) || []).map(function (i) { return String((i.item && i.item.name) || i.name || "").toLowerCase(); }).concat(new URL(url).pathname.toLowerCase().split(/[/_-]+/), [String(p.category || "").toLowerCase()], extra || []);
    var brand = String((p.brand && (p.brand.name || p.brand)) || siteName).trim(); brand = BRANDS[brand.toLowerCase()] || brand;
    var code = String(p.sku || "").toUpperCase() || codeOf(url), sst = sizeInfo(doc, html, p, url), sz = sst.map(function (x) { return x.s; });
    // цвет из ссылки (Brunello: …-262MZUEHRO342CBX11.html), а разметка страницы называет другой цвет той же модели — берём цвет из ссылки, если его фото есть на странице.
    // Иначе все цвета модели сливались в один товар (из 51 кроссовка загружалось 10) и обложка была не того цвета
    try { var uc1 = codeOf(url), c1 = code.replace(/[^A-Z0-9]/g, ""); if (uc1 && c1 && uc1 !== c1 && uc1.length === c1.length && uc1.length >= 12 && uc1.slice(0, uc1.length - 5) === c1.slice(0, c1.length - 5) && String(html || "").toUpperCase().indexOf(uc1 + "_") >= 0) code = uc1; } catch (e) {}
    var srcs = pickImages(html, String(code || codeOf(url)).replace(/[^A-Za-z0-9]/g, "").toUpperCase(), p.image, limit) /* Dior: артикул 3SN279ZMB_H969, в фото 3SN279ZMBH969_E02 — сравниваем без «_» */, images = [];
    for (var k = 0; k < srcs.length; k++) images.push({ u: srcs[k] }); // фото качает сервер по ссылке — быстро и без нагрузки на браузер
    // фото на модели и другие кадры галереи, в адресе которых нет артикула (Dior: «LOOK…», On) — из галереи страницы, только с того же сервера фото, что и снимки товара
    try { if (limit && srcs.length && images.length < limit && !/(^|\.)loropiana\.com$/.test(location.hostname)) { var dom0 = function (h) { return h.split(".").slice(-2).join("."); }, h0 = dom0(new URL(srcs[0]).hostname), hv1 = {}; /* assets.christiandior.com и media.christiandior.com — один сайт */ images.forEach(function (x) { hv1[x.u.split("?")[0]] = 1; });
      galleryOf(doc, url).forEach(function (u) { try { if (images.length < limit && dom0(new URL(u).hostname) === h0 && !hv1[u.split("?")[0]]) { hv1[u.split("?")[0]] = 1; images.push({ u: u }); } } catch (e) {} }); } } catch (e) {}
    return { src: siteName, host: host, brand: brand, title: String(p.name || "").replace(/\s+/g, " ").trim(), price: price, currency: String(ps.priceCurrency || of.priceCurrency || "EUR").toUpperCase(),
      sizes: sz, sizeStock: sst, blocked: (function (b) { return b === "wait" && sst.some(function (x) { return x.ok === true; }) ? "" : b; })(pageBlock(doc, html, p, code)) /* «Сообщить о поступлении» у распроданного размера (Golden Goose) — не значит, что вся вещь недоступна */ || (sst.some(function (x) { return x.pre; }) && sst.every(function (x) { return x.pre || x.ok === false; }) ? "pre" : ""), szDbg: sz.length || /bag|handbag|tasche|borse|sac\b/.test(crumbs.join(" ")) ? "" : sizeDbg(html), color: String(p.color || ""), material: String(p.material || "").slice(0, 80), sku: code, description: String(p.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      url: url.split("?")[0].split("#")[0], crumbs: crumbs, isNew: isNewSec, gender: gender(new URL(url).pathname + "/" + (extra || []).join("/")), images: images };
  };
return {codeOf:codeOf,build:build,sizeInfo:sizeInfo,pageBlock:pageBlock};})();"ok"
