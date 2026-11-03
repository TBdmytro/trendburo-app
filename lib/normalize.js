/**
 * Приведение данных источника к единой структуре: модель → варианты → предложения.
 * Ничего не выдумываем: чего нет в источнике, остаётся null и попадает в список неполноты.
 */
import { createHash } from "node:crypto";

export const CATEGORIES = {
  bags: "Сумки", shoes: "Обувь", clothing: "Одежда", eyewear: "Очки", accessories: "Аксессуары",
  jewelry: "Украшения", watches: "Часы", fragrance: "Ароматы", other: "Другое"
};

const CAT_RULES = [
  ["eyewear", /(sunglass|sonnenbrill|eyewear|brille|lunettes|occhiali|optical)/i],
  ["bags", /(\bbags?\b|tasche|handtasch|\btotes?\b|clutch|backpack|rucksack|shopper|pochette|\bsac\b|borse|luggage|gep[aä]ck|reisegep|crossbody|duffle|belt bag|fanny pack)/i],
  ["shoes", /(shoe|schuh|sneaker|loafer|slipper|\bpumps?\b|sandal|\bboots?\b|stiefel|\bmules?\b|ballerin|espadrill|chaussure|scarpe|runner|l[aä]ufer\b|trainer|\bslides?\b|\bclogs?\b|footwear)/i],
  ["jewelry", /(jewel|schmuck|\brings?\b|necklace|kette\b|ketten\b|bracelet|armband|earring|ohrring|bijou|gioiell)/i],
  ["watches", /(\bwatch(es)?\b|\buhr\b|uhren|montre|orolog)/i],
  ["fragrance", /(fragrance|parfum|perfume|\bduft\b|eau de)/i],
  ["clothing", /(ready-to-wear|pr[eê]t|kleidung|apparel|clothing|dress|kleid|jacket|jacke|coat|mantel|shirt|hemd|t-shirt|pullover|knit|strick|trouser|\bhose\b|jeans|skirt|\brock\b|blazer|hood(ie|y)?|sweat|legging|\bbras?\b|bralette|\btanks?\b|\btops?\b|\btees?\b|shorts?\b|jogger|\bpants?\b|onesie|bodysuit|jumpsuit|unitard|catsuit|romper|puffer|\bvests?\b|cardigan|\bcrew\b|sweater|\bpolo\b|track|jumper|biker|capri|flare|skort|corset|\bzip\b|quarter-zip|1\/4 zip|outerwear|swim|bikini|lingerie|underwear)/i],
  // книги, коврики, бутылки, свечи — не одежда и не аксессуары (у Alo они в типе «Accessories:…»)
  ["other", /(\bbooks?\b|candles?|yoga mats?|\bmats?\b|water bottles?|\bbottles?\b|diffuser|incense|blankets?|gift ?cards?|\bblocks?\b|\bstraps?\b|bolster)/i],
  ["accessories", /(accessor|wallet|geldb[oö]rse|\bbelts?\b|g[uü]rtel|scarf|schal|\btuch\b|cardholder|kartenetui|keychain|schl[uü]ssel|small leather|kleinlederwaren|\bhats?\b|m[uü]tze|\bcaps?\b|beanie|glove|handschuh|\btie\b|krawatte|socks?\b|headband|scrunchie|hair|bottle|\bmat\b)/i]
];

export function detectCategory(...hints) {
  // подсказки по порядку важности: сначала тип товара, потом адрес и название
  for (const h of hints.filter(Boolean)) { if (headCategory(h) === "clothing") return "clothing"; for (const [cat, re] of CAT_RULES) if (re.test(String(h))) return cat; }
  return null;
}
export function detectGender(...hints) {
  const t = hints.filter(Boolean).join(" ").toLowerCase();
  const w = /(women|damen|femme|donna|\/w\/|woman)/.test(t), m = /(\bmen\b|herren|homme|uomo|\/m\/|\bman\b|\/men)/.test(t);
  if (w && !m) return "w"; if (m && !w) return "m"; if (w && m) return "u"; return null;
}

/** Короткое название 2–5 слов на основе реального названия: убираем бренд и хвост с цветом/материалом. */
export function shortTitle(title, brand) {
  if (!title) return null;
  let t = String(title);
  if (brand) t = t.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "");
  t = t.split(/\s[-–|]\s|,/)[0].replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean);
  if (!words.length) return String(title).trim();
  return words.slice(0, 5).join(" ");
}

export const hash = s => createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
const slug = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * @param raw   результат parseProductPage / строки CSV
 * @param src   описание источника {id, kind, brand, region, currency, imageRights}
 */
// Один бренд — одно название: магазины пишут «Sporty-&-Rich», «BOTTEGA VENETA», «Yves Saint Laurent» — приводим к одному виду,
// иначе на сайте и в админке появляются две плитки одного бренда.
// Подразделы внутри категории — как на сайтах брендов (кроссовки, ботинки…; тоуты, клатчи…). Порядок важен: сверху — более точные.
export const SUBVER = 4; // поменяли правила подразделов — у уже загруженных товаров подразделы пересчитаются (кроме выставленных вручную)
// ключи — латиницей (под будущие языки сайта), названия — по-русски
export const SUBCATS = {
  shoes: [["sneakers", "Кроссовки", /\b(sneakers?|trainers?|runners?|baskets)\b/i], ["boots", "Ботинки и сапоги", /\b(boots?|booties|ankle ?boots?|chelsea|combat)\b/i],
    ["pumps", "Туфли и слингбэки", /\b(pumps?|slingbacks?|stilettos?|escarpins?|court shoes?)\b/i], ["slides", "Мюли и шлёпанцы", /\b(slides?|mules?|slippers?|clogs?|flip[- ]?flops?)\b/i],
    ["sandals", "Сандалии", /\b(sandals?|thongs?)\b/i], ["loafers", "Лоферы и дерби", /\b(loafers?|moccasins?|derb(y|ies)|oxfords?|brogues?|lace[- ]?ups?)\b/i],
    ["flats", "Балетки", /\b(ballerinas?|ballet flats?|flats|mary ?janes?)\b/i], ["espadrilles", "Эспадрильи", /\bespadrilles?\b/i]],
  bags: [["backpacks", "Рюкзаки", /\bbackpacks?\b/i], ["belt-bags", "Поясные", /\b(belt ?bags?|bum ?bags?|fanny|waist ?bags?)\b/i], ["clutches", "Клатчи и вечерние", /\b(clutch(es)?|minaudi[eè]res?|evening bags?)\b/i],
    ["mini", "Мини-сумки", /\b(mini|nano|micro)\b/i], ["crossbody", "Кросс-боди", /\b(cross[- ]?body|camera bags?|messenger)\b/i], ["totes", "Тоуты и шопперы", /\b(totes?|shoppers?|shopping|cabas)\b/i],
    ["top-handle", "С ручками", /\b(top[- ]?handle|bowling|doctor|handbags?)\b/i], ["hobo", "Хобо и мешки", /\b(hobos?|buckets?)\b/i], ["shoulder", "Через плечо", /\b(shoulder|baguette)\b/i],
    ["travel", "Дорожные", /\b(duffle|duffel|weekender|travel|suitcases?|luggage)\b/i]],
  clothing: [["swim", "Купальники", /\b(swim(wear|suits?)?|bikinis?|bathing suits?)\b/i], ["sport", "Спорт и йога", /\b(leggings?|sports? bras?|bike shorts|yoga|activewear|joggers?|track ?pants|sweatpants)\b/i],
    ["dresses", "Платья", /\b(dress(es)?|gowns?)\b/i], ["lingerie", "Боди и бельё", /\b(bodysuits?|lingerie|bras?|bralettes?|briefs|knickers|corsets?|bustiers?|slips?)\b/i],
    ["coats", "Пальто и тренчи", /\b(coats?|trench(es)?|parkas?|puffers?|down jackets?|capes?|overcoats?|peacoats?)\b/i],
    ["blazers", "Пиджаки", /\b(blazers?|tuxedo|smoking|single[- ]breasted|double[- ]breasted|saharienne|tailored jackets?)\b/i],
    ["jackets", "Куртки", /\b(jackets?|bombers?|blousons?|bikers?|gilets?|vests?|windbreakers?)\b/i], ["hoodies", "Толстовки и худи", /\b(hoodies?|sweatshirts?|zip[- ]?ups?)\b/i],
    ["tops", "Футболки и топы", /\b(t-?shirts?|tees?|tops?|tanks?|camis?|camisoles?|polos?)\b/i], ["shirts", "Рубашки и блузки", /\b(shirts?|blouses?|overshirts?)\b/i],
    ["knit", "Трикотаж", /\b(knit(wear)?|sweaters?|jumpers?|cardigans?|pullovers?|turtlenecks?)\b/i], ["jeans", "Джинсы", /\b(jeans|denim pants|denim trousers)\b/i],
    ["pants", "Брюки", /\b(pants|trousers|chinos|cargos?|culottes)\b/i], ["skirts", "Юбки", /\bskirts?\b/i], ["shorts", "Шорты", /\bshorts\b/i], ["suits", "Костюмы", /\b(suits?|tracksuits?|sets?|co-?ords?)\b/i]],
  accessories: [["belts", "Ремни", /\bbelts?\b/i], ["scarves", "Платки и шарфы", /\b(scarf|scarves|shawls?|stoles?|bandanas?)\b/i], ["wallets", "Кошельки и картхолдеры", /\b(wallets?|card ?holders?|card ?cases?|purses?|pouch(es)?|key ?(rings?|holders?))\b/i],
    ["hats", "Головные уборы", /\b(hats?|caps?|beanies?|bucket hats?|berets?)\b/i], ["gloves", "Перчатки", /\bgloves?\b/i], ["sunglasses", "Очки", /\b(sunglasses|eyewear|glasses)\b/i], ["socks", "Носки", /\bsocks?\b/i]]
};
// Те же подразделы по-немецки, по-французски и по-итальянски (Dior, LV и др. отдают названия на языке сайта).
// Немецкие слова часто составные — «Minirock», «Schlaghose», «Midikleid», «Kapuzencape», поэтому ищем окончание слова.
const W = "(?![a-zäöüß])"; // конец слова с учётом умлаутов
export const SUBCATS_INTL = {
  clothing: {
    swim: new RegExp(`(bikini\\S*|badeanzug|badehose|badeshorts|maillot de bain|costume da bagno)`, "i"),
    dresses: new RegExp(`(kleid(er)?${W}|\\brobes?${W}|\\babit[oi]${W})`, "i"),
    lingerie: new RegExp(`(\\bbody${W}|unterw[aä]sche|\\bbh${W}|korsett|bustier)`, "i"),
    coats: new RegExp(`(coat${W}|trench\\w*|mantel${W}|m[aä]ntel${W}|cape${W}|poncho${W}|parka${W}|\\bmanteau${W}|\\bcappott[oi]${W})`, "i"),
    blazers: new RegExp(`(sakko${W}|blazer${W}|frack${W}|\\bsmoking${W})`, "i"),
    jackets: new RegExp(`((?<!strick)jacke${W}|blouson${W}|weste${W}|\\bveste${W}|\\bgiacc[ah]${W}|\\bgilet${W})`, "i"),
    hoodies: new RegExp(`(kapuzenpullover|sweatshirt|kapuzenjacke)`, "i"),
    tops: new RegExp(`(oberteil${W}|poloshirt|t-?shirt|tanktop|top${W}|\\bpolo${W}|tr[aä]gertop)`, "i"),
    shirts: new RegExp(`(bluse${W}|hemd${W}|\\bchemise${W}|\\bcamici[ae]${W}|\\bblouse${W})`, "i"),
    knit: new RegExp(`(twin-?set${W}|pullover${W}|pullunder${W}|strick\\S*|cardigan${W}|\\bpull${W}|\\bmagli[ae]${W}|rollkragen)`, "i"),
    jeans: new RegExp(`(jeans${W})`, "i"),
    pants: new RegExp(`(hose${W}|\\bpantalons?${W}|\\bpantaloni${W}|chino${W})`, "i"),
    skirts: new RegExp(`(rock${W}|skort${W}|\\bjupe${W}|\\bgonna${W})`, "i"),
    shorts: new RegExp(`(shorts${W}|bermuda${W})`, "i"),
    suits: new RegExp(`(anzug${W}|kost[uü]m${W}|\\btailleur${W}|\\bensemble${W})`, "i")
  },
  accessories: {
    belts: /(g[uü]rtel|\bceinture|\bcintur)/i, scarves: /(schal|\btuch\b|t[uü]cher|stola|\bfoulard|\b[eé]charpe|\bsciarp)/i,
    wallets: /(portemonnaie|geldb[oö]rse|kartenetui|schl[uü]sselanh[aä]nger|\bportefeuille|\bportafogli)/i,
    hats: /(\bhut\b|h[uü]te\b|m[uü]tze|kappe|\bchapeau|\bcappell|\bbonnet)/i, gloves: /(handschuh|\bgants?\b|\bguanti)/i
  },
  shoes: {
    sneakers: /(sneaker|turnschuh|\bbaskets?\b)/i, boots: /(stiefel|\bbottes?\b|bottine|\bstival)/i, pumps: /(pumps|slingback|\bescarpin|\bdécolleté)/i,
    slides: /(pantolette|\bmules?\b|slipper|pantofol)/i, sandals: /(sandal|\bsandales?\b)/i, loafers: /(mokassin|loafer|derby|schn[uü]rschuh|\bmocassin)/i, flats: /(ballerina)/i
  },
  bags: {
    backpacks: /(rucksack|\bsac [àa] dos|\bzaino)/i, clutches: /(clutch|abendtasche|\bpochette)/i, crossbody: /(umh[aä]ngetasche|crossbody)/i,
    totes: /(shopper|\btote\b|einkaufstasche|\bcabas)/i, shoulder: /(schultertasche|\bsac port[ée] [ée]paule)/i, travel: /(reisetasche|weekender|\bkoffer)/i
  }
};
/** Подраздел по тексту: тексты проверяются по очереди (обычно: название, потом раздел сайта, потом описание). */
export function detectSubcategory(cat, ...texts) {
  const list = SUBCATS[cat]; if (!list) return null;
  const intl = SUBCATS_INTL[cat] || {};
  for (const t of texts.flat().map(x => String(x || "")).filter(Boolean)) for (const [k, , re] of list) if (re.test(t) || (intl[k] && intl[k].test(t))) return k;
  return null;
}

/**
 * Категория по главному слову названия — надёжнее раздела сайта и описания: «Ausgestellter Rock» — одежда,
 * даже если в описании есть «Anhänger» или «Kette» (из-за этого юбки попадали в «Украшения»).
 * Главное слово — до «mit / with / im / avec / con…». Возвращает "clothing" или null (решают остальные правила).
 */
// «and/und/et» не режем: «DIOR AND ED RUSCHA Hemd» — главное слово в конце
const HEAD_SPLIT = /\s+(?:in|with|featuring|from|for|mit|im|aus|f[uü]r|zum|zur|von|avec|en|con)\s+/;
const HEAD_CLOTH = new RegExp(`(\\b(dress(es)?|gowns?|coats?|trench(es)?|parkas?|capes?|jackets?|blazers?|bombers?|blousons?|vests?|gilets?|pants|trousers|jeans|shorts|bermudas?|skirts?|knit(wear)?|sweaters?|jumpers?|cardigans?|pullovers?|hoodies?|sweatshirts?|shirts?|t-shirts?|tees?|tops?|tanks?|camis?|camisoles?|polos?|blouses?|bodysuits?|leggings?|joggers?|tracksuits?|suits?|jumpsuits?|overalls?|swimsuits?|bikinis?|kimonos?|ponchos?)\\b|kleid(er)?${W}|rock${W}|hose${W}|bluse${W}|hemd${W}|jacke${W}|m[aä]ntel${W}|cape${W}|poncho${W}|weste${W}|pullover${W}|strick\\S*|oberteil${W}|shirt${W}|sakko${W}|anzug${W}|bikini\\S*|badeanzug|coat${W}|trench\\w*|twin-?set${W}|skort${W}|pullunder${W}|tanktop${W}|top${W}|shorts${W}|\\bbh${W}|chino${W}|smoking${W}|frack${W}|\\bjupe${W}|\\bpantalons?${W}|\\bchemise${W}|\\bveste${W}|\\bmanteau${W}|\\bgonna${W}|\\bpantaloni${W}|\\bcamicia${W}|\\bgiacca${W}|\\babito${W})`, "i");
const HEAD_OTHER = /\b(rings?|earrings?|necklaces?|bracelets?|brooch(es)?|cuffs?|belts?|scarf|scarves|hats?|caps?|gloves?|wallets?|card ?(holder|case)s?|bags?|books?|candles?|sunglasses|keychains?|key ?rings?|socks?|ringe?|ketten?|halsketten?|ohrringe?|ohrstecker|armb[aä]nder|armband|brosche|anh[aä]nger|g[uü]rtel|tasche|taschen|schal|m[uü]tze|hut|handschuhe?|portemonnaie|kartenetui|brille|sonnenbrille|schuhe?|sneakers?|runners?|trainers?|pumps?|ballerinas?|slingbacks?|mules?|slides?|boots?|sandal\w*|espadrilles?|l[aä]ufer|loafers?|mokassins?|slippers?|stiefel|stiefeletten?|sandalen|pumps|bague|collier|boucles?|sac|anello|collana|borsa)\b/i;
export function headCategory(title) {
  const head = String(title || "").toLowerCase().split(HEAD_SPLIT)[0];
  if (!head || HEAD_OTHER.test(head)) return null;
  return HEAD_CLOTH.test(head) ? "clothing" : null;
}
export const brandKey = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
const BRAND_ALIAS = { aloyogaset: "Alo Yoga", sportyrich: "Sporty & Rich", ysl: "Saint Laurent", yvessaintlaurent: "Saint Laurent", saintlaurentparis: "Saint Laurent" };
export function canonBrand(name) {
  let s = String(name ?? "").replace(/\s+/g, " ").trim(); if (!s) return name ?? null;
  const a = BRAND_ALIAS[brandKey(s)]; if (a) return a;
  s = s.replace(/\s*-\s*&\s*-\s*/g, " & ").replace(/\s+&\s+/g, " & ");
  // ВСЁ ЗАГЛАВНЫМИ → Как Обычно (короткие и с цифрами/точками — как есть: JW, MM6, C.P.)
  if (/\p{Lu}{3}/u.test(s) && s === s.toUpperCase()) s = s.split(" ").map(w => w.length <= 2 || /[\d.]/.test(w) ? w : w.toLowerCase().replace(/(^|[-])(\p{L})/gu, (m, p1, c) => p1 + c.toUpperCase())).join(" ");
  return s;
}
export function normalize(raw, src, { now = new Date().toISOString(), urlHints = "" } = {}) {
  const brand = canonBrand(src.brand || raw.brand || null);
  const issues = [];
  const cat = raw.categoryOverride || detectCategory(raw.category, urlHints, raw.title, ...(raw.categoryHints || [])) || null;
  if (!cat) issues.push({ level: "warn", code: "no-category", text: "Категорию не удалось определить" });
  // пол: из файла/источника («women», «женское», «m» …) или по подсказкам в категории, адресе и названии
  const gRaw = String(raw.gender || "").toLowerCase().trim();
  const gender = ({ w: "w", m: "m", u: "u", f: "w", k: "k" })[gRaw] || (/(^|\b)(kids?|children|child|boys?|girls?|kinder|baby|детск|дет)/.test(gRaw) ? "k" : null) || (/(^|\b)(women|woman|female|damen|femme|жен)/.test(gRaw) ? "w" : /(^|\b)(men|man|male|herren|homme|муж)/.test(gRaw) ? "m" : /(unisex|унисекс)/.test(gRaw) ? "u" : null)
    || detectGender(raw.category, urlHints, raw.title);

  const variants = (raw.variants && raw.variants.length ? raw.variants : [{}]).map((v, i) => ({
    _key: hash((v.sku || "") + "|" + (v.color || "") + "|" + (v.size || "") + "|" + i),
    sku: v.sku || null, gtin: v.gtin || null, color: v.color || null, size: v.size || null, material: v.material || null,
    images: (v.images || []).slice(0, 12).map(url => ({ url, rights: src.imageRights || "source-link" }))
  }));

  // Предложение источника: цены по вариантам в валюте и регионе источника, без конвертации
  const perVariant = {};
  let boutique = null, currency = null, taxIncluded = null;
  (raw.variants || []).forEach((v, i) => {
    const o = (v.offers || [])[0];
    const key = variants[i]._key;
    perVariant[key] = { status: o ? o.availability : "unknown", price: o ? o.price : null };
    if (o && o.price && (boutique === null || o.price < boutique)) boutique = o.price;
    if (o && o.currency) currency = o.currency;
    if (o && o.taxIncluded !== undefined && o.taxIncluded !== null) taxIncluded = o.taxIncluded;
  });
  if (raw.price && !boutique) boutique = raw.price;
  if (raw.currency) currency = raw.currency;

  if (!boutique) issues.push({ level: "error", code: "no-price", text: "Нет цены в источнике" });
  if (!(raw.region || src.region)) issues.push({ level: "warn", code: "no-region", text: "Регион цены не указан" });
  if (currency && src.currency && currency !== src.currency) issues.push({ level: "error", code: "currency", text: `Валюта источника ${currency}, ожидалась ${src.currency} — конвертация не выполняется` });
  const onlineOrder = Object.values(perVariant).some(x => x.status === "online");

  const imgCount = new Set(variants.flatMap(v => v.images.map(i => i.url))).size || (raw.images || []).length;
  if (!imgCount) issues.push({ level: "error", code: "no-photo", text: "Нет фотографий" });
  else if (imgCount < 3) issues.push({ level: "warn", code: "few-photos", text: `Фото: ${imgCount} из рекомендуемых 3` });
  if (!raw.modelSku && !variants.some(v => v.sku || v.gtin)) issues.push({ level: "warn", code: "no-ids", text: "Нет артикула и GTIN — дубли определить нельзя" });
  if (raw.structured === false) issues.push({ level: "warn", code: "meta-only", text: "Только мета-теги, без структурированных данных" });

  const key = raw.modelSku ? slug(brand) + "." + slug(raw.modelSku) : "u." + hash(raw.url || raw.title);
  const model = {
    _id: "product." + key,
    brand, sourceTitle: raw.title || null, title: shortTitle(raw.title, brand),
    category: cat, subcategory: raw.subcategory || detectSubcategory(cat, raw.category, raw.title, ...(raw.categoryHints || []), urlHints) || null, gender,
    modelSku: raw.modelSku || null, gtin: raw.gtin || null,
    colors: raw.colors || [], materials: raw.materials || [], sizes: raw.sizes || [], sizeSystem: raw.sizeSystem || null,
    images: (raw.images || []).slice(0, 16).map(url => ({ url, rights: src.imageRights || "source-link" })),
    sourceUrl: raw.url || null, description: raw.description || null
  };
  const offer = {
    _key: hash(src.id + "|" + (raw.url || key)),
    sourceId: src.id, sourceKind: src.kind, region: raw.region || src.region || null, currency: currency || null,
    boutique, priceSource: src.kind === "official" ? "официальный сайт" : src.kind === "eyewear-supplier" ? "поставщик" : (raw.priceSource || "файл"),
    taxIncluded, purchase: raw.purchase ?? null, availability: perVariant, onlineOrder,
    supplierLeadDays: raw.leadDays ?? null, checkedAt: now, errors: [], url: raw.url || null,
    completeness: Math.max(0, 1 - issues.filter(i => i.level === "error").length * 0.34 - issues.filter(i => i.level === "warn").length * 0.1)
  };
  return { model, variants, offer, issues, warnings: raw.warnings || [] };
}
