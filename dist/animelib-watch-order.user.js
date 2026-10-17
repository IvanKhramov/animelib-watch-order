// ==UserScript==
// @name         Порядок просмотра франшизы (AnimeLib, AnimeGO)
// @name:en      Anime watch order (AnimeLib, AnimeGO)
// @namespace    https://github.com/IvanKhramov/animelib-watch-order
// @homepageURL  https://github.com/IvanKhramov/animelib-watch-order
// @supportURL   https://github.com/IvanKhramov/animelib-watch-order/issues
// @updateURL    https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/dist/animelib-watch-order.user.js
// @downloadURL  https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/dist/animelib-watch-order.user.js
// @version      0.5.0
// @description  Порядок просмотра франшизы: рекомендации с источниками, даты выхода и проверенная хронология. Отметки, обложки и ссылки на тот же сайт.
// @description:en Franchise watch orders: recommendations with sources, release dates and verified timelines. Watch marks, covers and links to the same site.
// @author       Ivan Khramov
// @license      MIT
// @match        https://animelib.org/*
// @match        https://animego.me/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      graphql.anilist.co
// @run-at       document-idle
// @noframes
// ==/UserScript==

"use strict";
(() => {
  // src/guards.ts
  var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var str = (v) => typeof v === "string" && v.trim() !== "" ? v : void 0;
  var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  var arr = (v) => Array.isArray(v) ? v : [];
  var obj = (v) => isObj(v) ? v : {};
  function strings(v) {
    return arr(v).filter((x) => typeof x === "string" && x.trim() !== "");
  }

  // src/http.ts
  var HttpError = class extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
      this.name = "HttpError";
    }
  };
  var AbortError = class extends Error {
    constructor() {
      super("aborted");
      this.name = "AbortError";
    }
  };
  var isAbort = (e) => e instanceof AbortError || e instanceof DOMException && e.name === "AbortError";
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new AbortError());
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new AbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  function limiter(max) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= max) return;
      const run = queue.shift();
      if (run) {
        active++;
        run();
      }
    };
    return (fn) => new Promise((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
  }
  function withRetry(transport, opts = {}) {
    const retries = opts.retries ?? 2;
    const base = opts.baseDelayMs ?? 800;
    const max = opts.maxDelayMs ?? 1e4;
    const maxRetryAfter = opts.maxRetryAfterMs ?? 12e4;
    const limit = opts.rateLimit;
    const sentAt = [];
    const now = opts.now ?? Date.now;
    const wait = opts.sleep ?? sleep;
    let pausedUntil = 0;
    return async (req) => {
      let attempt = 0;
      for (; ; ) {
        if (req.signal?.aborted) throw new AbortError();
        for (; ; ) {
          if (req.signal?.aborted) throw new AbortError();
          const t = now();
          if (limit) while (sentAt.length > 0 && sentAt[0] <= t - limit.windowMs) sentAt.shift();
          const windowFree = limit && sentAt.length >= limit.max ? sentAt[0] + limit.windowMs : 0;
          const delay2 = Math.max(pausedUntil, windowFree) - t;
          if (delay2 <= 0) break;
          await wait(delay2, req.signal);
        }
        if (limit) sentAt.push(now());
        let res;
        let err;
        try {
          res = await transport(req);
        } catch (e) {
          if (isAbort(e)) throw e;
          err = e;
        }
        const hinted = res?.retryAfter !== void 0 && Number.isFinite(res.retryAfter) ? Math.max(0, res.retryAfter * 1e3) : 0;
        const delay = Math.max(hinted, Math.min(max, base * 2 ** attempt));
        if (res?.status === 429) pausedUntil = Math.max(pausedUntil, now() + delay);
        if (res && hinted > maxRetryAfter) return res;
        const retriable = !res || res.status === 429 || res.status >= 500;
        if (!retriable || attempt >= retries) {
          if (res) return res;
          throw err;
        }
        attempt++;
        if (res?.status !== 429) await wait(delay, req.signal);
      }
    };
  }
  var fetchTransport = async (req) => {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 15e3);
    try {
      const r = await fetch(req.url, {
        method: req.method ?? "GET",
        headers: req.headers,
        body: req.body,
        credentials: "omit",
        // referrerPolicy не трогаем: API AnimeLib без Referer отвечает 403.
        // Этот транспорт ходит только на сам сайт, адрес страницы никуда наружу не уходит.
        signal: ctrl.signal
      });
      const ra = Number(r.headers.get("retry-after"));
      return {
        status: r.status,
        text: await r.text(),
        retryAfter: Number.isFinite(ra) && ra > 0 ? ra : void 0
      };
    } catch (e) {
      if (req.signal?.aborted) throw new AbortError();
      throw e;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  };
  function parseJson(res, what) {
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(`${what}: HTTP ${res.status}`, res.status);
    }
    try {
      return JSON.parse(res.text);
    } catch {
      throw new HttpError(`${what}: некорректный JSON`, res.status);
    }
  }

  // src/anilistAdapter.ts
  var ANILIST_URL = "https://graphql.anilist.co";
  var MEDIA_FIELDS = `
  id type format episodes
  startDate { year month day }
  title { romaji english native }
  synonyms
  coverImage { medium large extraLarge }
  relations { edges { relationType(version: 2) node { id type format } } }
`;
  var BY_IDS = `query ($ids: [Int]) {
  Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } }
}`;
  var SEARCH = `query ($q: String) {
  Page(perPage: 8) { media(search: $q, type: ANIME) { ${MEDIA_FIELDS} } }
}`;
  var FORMATS = /* @__PURE__ */ new Set(["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"]);
  var RELATIONS = /* @__PURE__ */ new Set([
    "PREQUEL",
    "SEQUEL",
    "SIDE_STORY",
    "PARENT",
    "SUMMARY",
    "ALTERNATIVE",
    "SPIN_OFF",
    "OTHER",
    "COMPILATION",
    "CONTAINS",
    "CHARACTER",
    "ADAPTATION",
    "SOURCE"
  ]);
  var httpsUrl = (v) => {
    const s = str(v);
    return s && /^https:\/\//.test(s) ? s : void 0;
  };
  var toFormat = (v) => typeof v === "string" && FORMATS.has(v) ? v : "UNKNOWN";
  function parseMedia(v) {
    if (!isObj(v)) return void 0;
    const id = num(v.id);
    if (id === void 0 || v.type !== "ANIME") return void 0;
    const title = obj(v.title);
    const sd = obj(v.startDate);
    const edges = [];
    for (const e of arr(obj(v.relations).edges)) {
      const eo = obj(e);
      const node = obj(eo.node);
      const nid = num(node.id);
      const rel = eo.relationType;
      if (nid === void 0 || typeof rel !== "string" || !RELATIONS.has(rel)) continue;
      if (node.type !== "ANIME" && node.type !== "MANGA") continue;
      edges.push({ rel, id: nid, type: node.type, format: toFormat(node.format) });
    }
    return {
      id,
      format: toFormat(v.format),
      startDate: { year: num(sd.year), month: num(sd.month), day: num(sd.day) },
      romaji: str(title.romaji) ?? str(title.english) ?? `#${id}`,
      english: str(title.english),
      native: str(title.native),
      synonyms: strings(v.synonyms),
      episodes: num(v.episodes),
      cover: httpsUrl(obj(v.coverImage).medium) || httpsUrl(obj(v.coverImage).large) ? {
        medium: httpsUrl(obj(v.coverImage).medium),
        large: httpsUrl(obj(v.coverImage).extraLarge) ?? httpsUrl(obj(v.coverImage).large)
      } : void 0,
      edges
    };
  }
  function parsePage(body) {
    const data = obj(obj(body).data);
    const media = arr(obj(data.Page).media);
    if (!isObj(data.Page)) throw new Error("AniList: неожиданный ответ");
    return media.map(parseMedia).filter((m) => !!m);
  }
  var EXPAND = /* @__PURE__ */ new Set([
    "PREQUEL",
    "SEQUEL",
    "SIDE_STORY",
    "PARENT",
    "SUMMARY",
    "COMPILATION",
    "CONTAINS"
  ]);
  var BRANCH = /* @__PURE__ */ new Set(["ALTERNATIVE", "SPIN_OFF"]);
  var LINE = /* @__PURE__ */ new Set(["PREQUEL", "SEQUEL"]);
  var LEAF = /* @__PURE__ */ new Set(["OTHER"]);
  var RANK = { full: 2, line: 1, leaf: 0 };
  function reachVia(from, rel) {
    if (from === "full") {
      if (EXPAND.has(rel)) return "full";
      if (BRANCH.has(rel)) return "line";
      if (LEAF.has(rel)) return "leaf";
      return void 0;
    }
    if (from === "line") return LINE.has(rel) ? "line" : void 0;
    return void 0;
  }
  var AniListClient = class {
    constructor(transport) {
      this.transport = transport;
    }
    async query(query, variables, signal) {
      const res = await this.transport({
        url: ANILIST_URL,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal,
        timeoutMs: 15e3
      });
      return parsePage(parseJson(res, "AniList"));
    }
    getByIds(ids, signal) {
      return this.query(BY_IDS, { ids }, signal);
    }
    search(q, signal) {
      return this.query(SEARCH, { q }, signal);
    }
    /** Обход графа франшизы от rootId: батчами по уровням, с лимитами и защитой от циклов. */
    async loadFranchise(rootId, signal, limits = {}) {
      const maxNodes = limits.maxNodes ?? 80;
      const maxRequests = limits.maxRequests ?? 10;
      const nodes = /* @__PURE__ */ new Map();
      const wanted = /* @__PURE__ */ new Set([rootId]);
      const missing = /* @__PURE__ */ new Set();
      const reach = /* @__PURE__ */ new Map([[rootId, "full"]]);
      const expanded = /* @__PURE__ */ new Map();
      let requests = 0;
      let truncated = false;
      for (; ; ) {
        const toFetch = [...wanted].filter((id) => !nodes.has(id) && !missing.has(id)).slice(0, 50);
        if (toFetch.length > 0) {
          if (requests >= maxRequests) {
            truncated = true;
            break;
          }
          requests++;
          for (const m of await this.getByIds(toFetch, signal)) nodes.set(m.id, m);
          for (const id of toFetch) if (!nodes.has(id)) missing.add(id);
        }
        let progressed = false;
        for (const [id, r] of [...reach]) {
          const m = nodes.get(id);
          const done = expanded.get(id);
          if (!m || r === "leaf" || done !== void 0 && RANK[done] >= RANK[r]) continue;
          expanded.set(id, r);
          progressed = true;
          for (const e of m.edges) {
            if (e.type !== "ANIME" || e.format === "MUSIC") continue;
            const nr = reachVia(r, e.rel);
            if (!nr) continue;
            if (!wanted.has(e.id)) {
              if (wanted.size >= maxNodes) {
                truncated = true;
                continue;
              }
              wanted.add(e.id);
            }
            const prev = reach.get(e.id);
            if (prev === void 0 || RANK[nr] > RANK[prev]) reach.set(e.id, nr);
          }
        }
        if (!progressed && toFetch.length === 0) break;
      }
      return { rootId, nodes, truncated };
    }
  };

  // src/gm.ts
  function gmMenuCommand(name, fn) {
    if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand(name, fn);
  }
  var gmTransport = typeof GM_xmlhttpRequest === "function" ? (req) => new Promise((resolve, reject) => {
    if (req.signal?.aborted) return reject(new AbortError());
    const h2 = GM_xmlhttpRequest({
      method: req.method ?? "GET",
      url: req.url,
      headers: req.headers,
      data: req.body,
      anonymous: true,
      timeout: req.timeoutMs ?? 15e3,
      onload: (r) => {
        const ra = Number(/^retry-after:\s*(\d+)/im.exec(r.responseHeaders)?.[1]);
        resolve({ status: r.status, text: r.responseText, retryAfter: ra > 0 ? ra : void 0 });
      },
      onerror: () => reject(new Error("сетевая ошибка")),
      ontimeout: () => reject(new Error("таймаут"))
    });
    req.signal?.addEventListener("abort", () => {
      h2.abort();
      reject(new AbortError());
    }, { once: true });
  }) : fetchTransport;
  function gmKV() {
    if (typeof GM_getValue !== "function" || typeof GM_setValue !== "function") {
      return {
        get: (k) => {
          const v = localStorage.getItem(`awo:${k}`);
          return v === null ? void 0 : JSON.parse(v);
        },
        set: (k, v) => localStorage.setItem(`awo:${k}`, JSON.stringify(v)),
        remove: (k) => localStorage.removeItem(`awo:${k}`)
      };
    }
    return {
      get: (k) => GM_getValue(k, void 0),
      set: (k, v) => GM_setValue(k, v),
      remove: (k) => typeof GM_deleteValue === "function" ? GM_deleteValue(k) : GM_setValue(k, void 0)
    };
  }

  // src/dates.ts
  var RU_MONTHS = [
    "январ",
    "феврал",
    "март",
    "апрел",
    "ма",
    "июн",
    "июл",
    "август",
    "сентябр",
    "октябр",
    "ноябр",
    "декабр"
  ];
  function parseIsoDate(s) {
    const m = s?.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
    if (!m) return void 0;
    const d = { year: Number(m[1]) };
    if (m[2]) d.month = Number(m[2]);
    if (m[3]) d.day = Number(m[3]);
    return d;
  }
  function parseRuDate(s) {
    if (!s) return void 0;
    const y = s.match(/(\d{4})/);
    if (!y) return void 0;
    const d = { year: Number(y[1]) };
    const dm = s.toLowerCase().match(/(\d{1,2})\s+([а-яё]+)/);
    if (dm) {
      const word = dm[2];
      const idx = RU_MONTHS.findIndex((p) => word.startsWith(p));
      if (idx >= 0) {
        d.month = idx + 1;
        d.day = Number(dm[1]);
      }
    }
    return d;
  }
  function dateKey(d) {
    if (!d?.year) return Number.MAX_SAFE_INTEGER;
    return d.year * 1e4 + (d.month ?? 12) * 100 + (d.day ?? 31);
  }
  var isExactDate = (d) => !!(d?.year && d.month && d.day);
  var sameExactDate = (a, b) => isExactDate(a) && isExactDate(b) && a.year === b.year && a.month === b.month && a.day === b.day;
  function yearsCompatible(a, b) {
    if (!a?.year || !b?.year) return true;
    return Math.abs(a.year - b.year) <= 1;
  }

  // src/storage.ts
  var SCHEMA = "v1";
  var CACHE_SCHEMA = "v3";
  var HOUR = 36e5;
  var DAY = 24 * HOUR;
  var Cache = class {
    constructor(kv, now = Date.now) {
      this.kv = kv;
      this.now = now;
    }
    key(ns, k) {
      return `cache:${CACHE_SCHEMA}:${ns}:${k}`;
    }
    get(ns, k) {
      const e = this.kv.get(this.key(ns, k));
      if (!e || typeof e.exp !== "number" || e.exp < this.now()) return void 0;
      return e.v;
    }
    set(ns, k, v, ttlMs) {
      this.kv.set(this.key(ns, k), { exp: this.now() + ttlMs, v });
    }
    /** Обёртка «взять из кэша или загрузить». force пропускает чтение, но результат сохраняет. */
    async wrap(ns, k, ttlMs, load, force = false) {
      if (!force) {
        const hit = this.get(ns, k);
        if (hit !== void 0) return hit;
      }
      const v = await load();
      this.set(ns, k, v, ttlMs);
      return v;
    }
  };
  var UserState = class {
    constructor(kv) {
      this.kv = kv;
    }
    map(name) {
      const v = this.kv.get(`user:${SCHEMA}:${name}`);
      return v && typeof v === "object" ? v : {};
    }
    toggle(name, key, on) {
      const m = this.map(name);
      if (on) m[key] = true;
      else delete m[key];
      this.kv.set(`user:${SCHEMA}:${name}`, m);
    }
    isWatched(key) {
      return this.map("watched")[key] === true;
    }
    setWatched(key, on) {
      this.toggle("watched", key, on);
    }
    rejected() {
      return new Set(Object.keys(this.map("rejected")));
    }
    reject(pair) {
      this.toggle("rejected", pair, true);
    }
    clearRejected() {
      this.kv.remove(`user:${SCHEMA}:rejected`);
    }
    prefs() {
      const v = this.kv.get(`user:${SCHEMA}:prefs`);
      const prefs = { ...DEFAULT_PREFS, ...v && typeof v === "object" ? v : {} };
      if (!["recommended", "release", "chronological"].includes(prefs.orderMode)) prefs.orderMode = "recommended";
      return prefs;
    }
    setPrefs(patch) {
      this.kv.set(`user:${SCHEMA}:prefs`, { ...this.prefs(), ...patch });
    }
    orders() {
      const v = this.kv.get(`user:${SCHEMA}:orders`);
      return v && typeof v === "object" ? v : {};
    }
    customOrder(franchise) {
      return this.orders()[franchise];
    }
    setCustomOrder(franchise, v) {
      const all = this.orders();
      if (v && (v.order.length > 0 || v.hidden.length > 0)) all[franchise] = v;
      else delete all[franchise];
      this.kv.set(`user:${SCHEMA}:orders`, all);
    }
    /** Всё, что отметил пользователь, одним объектом: для переноса в другой браузер. */
    exportData() {
      const data = { format: EXPORT_FORMAT, exportedAt: (/* @__PURE__ */ new Date()).toISOString() };
      for (const name of USER_KEYS) {
        const v = this.kv.get(`user:${SCHEMA}:${name}`);
        if (v !== void 0) data[name] = v;
      }
      return data;
    }
    /** Импорт с проверкой формата. Заменяет текущие данные целиком. */
    importData(raw) {
      if (!raw || typeof raw !== "object" || raw.format !== EXPORT_FORMAT) {
        throw new Error("это не файл экспорта порядка просмотра");
      }
      const data = raw;
      for (const name of USER_KEYS) {
        const v = data[name];
        if (v !== void 0 && !validUserField(name, v)) throw new Error(`повреждено поле ${name}`);
      }
      for (const name of USER_KEYS) {
        const v = data[name];
        if (v === void 0) this.kv.remove(`user:${SCHEMA}:${name}`);
        else this.kv.set(`user:${SCHEMA}:${name}`, v);
      }
    }
  };
  var DEFAULT_PREFS = { orderMode: "recommended", view: "all", collapsed: false, branchesOpen: false, covers: false, hiddenSites: {} };
  var USER_KEYS = ["watched", "rejected", "prefs", "orders"];
  var EXPORT_FORMAT = "animelib-watch-order/v1";
  var trueMap = (v) => isObj(v) && Object.values(v).every((x) => x === true);
  var stringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
  function validUserField(name, v) {
    if (name === "watched" || name === "rejected") return trueMap(v);
    if (!isObj(v)) return false;
    if (name === "orders") {
      return Object.values(v).every((order) => isObj(order) && Object.keys(order).every((key) => key === "order" || key === "hidden") && stringArray(order.order) && stringArray(order.hidden));
    }
    return Object.entries(v).every(([key, value]) => {
      if (key === "orderMode") return value === "recommended" || value === "release" || value === "chronological";
      if (key === "view") return value === "main" || value === "all";
      if (key === "hiddenSites") return trueMap(value);
      if (key === "collapsed" || key === "branchesOpen" || key === "covers") return typeof value === "boolean";
      return false;
    });
  }

  // src/sites/animego.ts
  var FORMAT_BY_LABEL = {
    "Сериал": "TV",
    "ТВ Сериал": "TV",
    "Фильм": "MOVIE",
    "OVA": "OVA",
    "ONA": "ONA",
    "Спешл": "SPECIAL",
    "Короткометражка": "TV_SHORT",
    "Клип": "MUSIC"
  };
  function relationKind(label) {
    const l = label.toLowerCase();
    if (l.includes("предыстори")) return "prequel";
    if (l.includes("продолжени")) return "sequel";
    if (/альтернатив|спин|побочн|обобщ|истори|сайд|версия|пересказ/.test(l)) return "story";
    return "other";
  }
  var PATH_RE = /^\/anime\/[a-z0-9-]+-\d+\/?$/;
  function ownText(el) {
    return el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }
  function infoValue(doc, label) {
    for (const el of doc.querySelectorAll("div, dt, span")) {
      if (el.children.length === 0 && ownText(el) === label) {
        const v = ownText(el.nextElementSibling);
        if (v) return v;
      }
    }
    return void 0;
  }
  function jsonLd(doc) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const v = JSON.parse(s.textContent ?? "");
        for (const item of Array.isArray(v) ? v : [v]) {
          if (isObj(item) && typeof item["@type"] === "string" && /Series|Movie|CreativeWork/.test(item["@type"])) {
            return item;
          }
        }
      } catch {
      }
    }
    return void 0;
  }
  function parseAnimegoPage(doc, url) {
    const ld = jsonLd(doc);
    const h1 = ownText(doc.querySelector("h1"));
    const name = h1 || str(ld?.name) || url.pathname;
    const alt = ld ? [str(ld.alternateName), ...arr(ld.alternateName).map(str)] : [];
    const synonyms = [...doc.querySelectorAll(".entity__title-synonyms li")].map(ownText);
    const typeLabel = infoValue(doc, "Тип");
    const title = {
      key: url.pathname.replace(/\/$/, ""),
      url: `${url.origin}${url.pathname}`,
      displayName: name,
      names: [name, str(ld?.name), ...alt, ...synonyms].filter((x) => !!x),
      date: parseIsoDate(str(ld?.datePublished)),
      format: typeLabel ? FORMAT_BY_LABEL[typeLabel] ?? "UNKNOWN" : void 0,
      formatLabel: typeLabel
    };
    const related = [];
    const block = [...doc.querySelectorAll(".seasons")].find((s) => ownText(s.querySelector("h2")) === "Связанное");
    for (const item of block?.querySelectorAll(".seasons-item") ?? []) {
      const a = item.querySelector("a.seasons__link");
      const href = a?.getAttribute("href");
      if (!a || !href || !PATH_RE.test(href)) continue;
      const info = item.querySelector(".seasons__info");
      const spans = [...info?.firstElementChild?.querySelectorAll("span") ?? []].map(ownText).filter((s) => s && s !== "/");
      const label = info && info.children.length > 1 ? ownText(info.lastElementChild) : "";
      const img = item.querySelector("img")?.getAttribute("src") ?? void 0;
      const fl = spans[0];
      const year = Number(spans[1]);
      related.push({
        key: href.replace(/\/$/, ""),
        url: `${url.origin}${href}`,
        displayName: ownText(a),
        names: [ownText(a)],
        date: Number.isInteger(year) && year > 1900 ? { year } : void 0,
        format: fl ? FORMAT_BY_LABEL[fl] ?? "UNKNOWN" : void 0,
        formatLabel: fl,
        relationLabel: label,
        relationKind: relationKind(label),
        cover: img?.startsWith("https://") ? img : void 0
      });
    }
    return { title, related };
  }
  function createAnimego(transport) {
    const limit = limiter(2);
    const loadPage = (key, ctx) => {
      const url = new URL(key, location.origin);
      if (location.pathname.replace(/\/$/, "") === key) {
        return Promise.resolve(parseAnimegoPage(document, url));
      }
      return ctx.cache.wrap("ag-page", key, 3 * DAY, async () => {
        const res = await limit(() => transport({ url: url.href, signal: ctx.signal, headers: { Accept: "text/html" } }));
        if (res.status !== 200) throw new Error(`animego: HTTP ${res.status}`);
        return parseAnimegoPage(new DOMParser().parseFromString(res.text, "text/html"), url);
      }, ctx.force);
    };
    return {
      id: "animego",
      pageKey(url) {
        if (!/(^|\.)animego\.[a-z]+$/.test(url.hostname)) return null;
        return PATH_RE.test(url.pathname) ? url.pathname.replace(/\/$/, "") : null;
      },
      findAnchor(doc) {
        const block = [...doc.querySelectorAll(".seasons")].find((s) => ownText(s.querySelector("h2")) === "Связанное");
        if (block?.parentElement) return { parent: block.parentElement, before: block };
        return null;
      },
      async loadCurrent(key, ctx) {
        return (await loadPage(key, ctx)).title;
      },
      async loadRelated(current, ctx) {
        const first = (await loadPage(current.key, ctx)).related;
        const out = /* @__PURE__ */ new Map();
        const seen = /* @__PURE__ */ new Set([current.key]);
        for (const r of first) {
          seen.add(r.key);
          out.set(r.key, r);
        }
        let partial = false;
        const pages = await Promise.all(
          first.slice(0, 15).map((r) => loadPage(r.key, ctx).catch((e) => {
            if (isAbort(e)) throw e;
            partial = true;
            return void 0;
          }))
        );
        for (const [i, p] of pages.entries()) {
          if (!p) continue;
          const base = first[i];
          out.set(base.key, { ...base, names: [.../* @__PURE__ */ new Set([...base.names, ...p.title.names])], date: p.title.date ?? base.date, format: p.title.format ?? base.format });
          for (const r of p.related) {
            if (seen.has(r.key) || out.size >= 30) continue;
            seen.add(r.key);
            const kind = base.relationKind === r.relationKind ? r.relationKind : "story";
            out.set(r.key, { ...r, relationKind: kind });
          }
        }
        return { titles: [...out.values()], partial };
      },
      searchUrl: (query) => `${location.origin}/search/all?q=${encodeURIComponent(query)}`
    };
  }

  // src/sites/animelib.ts
  var FALLBACK_API = "https://api.cdnlibs.org";
  var SITE_ID = "5";
  var ORIGIN = "https://animelib.org";
  var REL_KIND = {
    1: "skip",
    // Адаптация
    2: "skip",
    // Источник
    3: "prequel",
    // Предыстория
    4: "sequel",
    // Продолжение
    5: "story",
    // Альтернативная история
    6: "story",
    // Спин-офф
    7: "other",
    // Кроссовер
    8: "skip",
    // Цветная версия
    9: "story",
    // Перезапуск
    10: "story",
    // Другое
    11: "story",
    // Обобщение
    12: "other",
    // Одна вселенная
    13: "story",
    // Изначальная история
    14: "other",
    // Общий персонаж
    15: "story",
    // Альтернативная история
    16: "story"
    // Развёрнутая история
  };
  var EXPAND_REL = /* @__PURE__ */ new Set([3, 4, 11, 13, 16]);
  var FORMAT_BY_LABEL2 = {
    "TV Сериал": "TV",
    "Фильм": "MOVIE",
    "Короткометражка": "TV_SHORT",
    "Спешл": "SPECIAL",
    "OVA": "OVA",
    "ONA": "ONA",
    "Клип": "MUSIC"
  };
  function isTrustedApiUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && ["cdnlibs.org", "hentaicdn.org"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  }
  function detectApiBase() {
    try {
      const entries = performance.getEntriesByType("resource");
      for (const e of entries) {
        if (!isTrustedApiUrl(e.name)) continue;
        const url = new URL(e.name);
        if (/^\/api\/(anime|constants|auth)\b/.test(url.pathname)) return url.origin;
      }
    } catch {
    }
    return void 0;
  }
  function readToken() {
    try {
      const raw = localStorage.getItem("auth");
      if (!raw) return void 0;
      return str(obj(obj(JSON.parse(raw)).token).access_token);
    } catch {
      return void 0;
    }
  }
  function parseLibMedia(v) {
    if (!isObj(v)) return void 0;
    const slug = str(v.slug_url);
    const name = str(v.name);
    if (!slug || !name) return void 0;
    const label = str(obj(v.type).label);
    const names = [name, str(v.rus_name), str(v.eng_name), ...strings(v.otherNames)].filter(
      (x) => !!x
    );
    return {
      key: slug,
      url: `${ORIGIN}/ru/anime/${slug}`,
      displayName: str(v.rus_name) ?? name,
      names,
      date: parseIsoDate(str(v.releaseDate)) ?? parseRuDate(str(v.releaseDateString)),
      format: label ? FORMAT_BY_LABEL2[label] ?? "UNKNOWN" : void 0,
      formatLabel: label,
      anilistId: num(v.anilist_id),
      cover: [str(obj(v.cover).thumbnail), str(obj(v.cover).default)].find((u) => u?.startsWith("https://"))
    };
  }
  function parseRelations(body) {
    const out = [];
    for (const r of arr(obj(body).data)) {
      const ro = obj(r);
      const media = obj(ro.media);
      if (media.model !== "anime") continue;
      const rt = obj(ro.related_type);
      const relId = num(rt.id);
      const title = parseLibMedia(media);
      if (relId === void 0 || !title) continue;
      out.push({ relId, label: str(rt.label) ?? "", title });
    }
    return out;
  }
  function titleFromDocument(key) {
    const t = document.title.replace(/\s*смотреть.*$/i, "").replace(/\s*•.*$/, "");
    const parts = t.split(" / ").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0 || /не найдена/i.test(t)) return void 0;
    return { key, url: `${ORIGIN}/ru/anime/${key}`, displayName: parts[0], names: parts };
  }
  function createAnimeLib(transport) {
    const limit = limiter(3);
    let apiBase;
    const get = async (path, signal) => {
      apiBase ?? (apiBase = detectApiBase());
      const base = apiBase ?? FALLBACK_API;
      const headers = { Accept: "application/json", "Site-Id": SITE_ID };
      const token = readToken();
      const url = `${base}/api/${path}`;
      if (token && isTrustedApiUrl(url)) headers.Authorization = `Bearer ${token}`;
      const res = await limit(() => transport({ url, headers, signal }));
      return parseJson(res, "AnimeLib");
    };
    const relations = (slug, ctx) => ctx.cache.wrap("al-lib-rel", slug, 12 * HOUR, async () => parseRelations(await get(`anime/${slug}/relations`, ctx.signal)), ctx.force);
    return {
      id: "animelib",
      pageKey(url) {
        if (!/(^|\.)animelib\.org$/.test(url.hostname)) return null;
        const m = url.pathname.match(/^\/[a-z]{2}\/anime\/(\d+--[^/]+)\/?$/);
        return m ? m[1] : null;
      },
      findAnchor(doc) {
        const heads = doc.querySelectorAll(".section-title");
        for (const h2 of heads) {
          if (h2.textContent?.trim() !== "Связанное") continue;
          const section = h2.closest(".section-body");
          if (section?.parentElement) return { parent: section.parentElement, before: section };
        }
        for (const h2 of heads) {
          if (!/^Похожее/.test(h2.textContent?.trim() ?? "")) continue;
          const section = h2.closest(".section-body");
          if (section?.parentElement) return { parent: section.parentElement, before: section };
        }
        return null;
      },
      async loadCurrent(key, ctx) {
        try {
          return await ctx.cache.wrap("al-lib-title", key, 3 * DAY, async () => {
            const q = ["eng_name", "otherNames", "releaseDate"].map((f) => `fields[]=${f}`).join("&");
            const t = parseLibMedia(obj(await get(`anime/${key}?${q}`, ctx.signal)).data);
            if (!t) throw new Error("AnimeLib: неожиданный ответ карточки");
            return t;
          }, ctx.force);
        } catch (e) {
          const fallback = e instanceof HttpError && e.status === 404 ? titleFromDocument(key) : void 0;
          if (fallback) return fallback;
          throw e;
        }
      },
      async loadRelated(current, ctx) {
        let partial = false;
        const found = /* @__PURE__ */ new Map();
        const seen = /* @__PURE__ */ new Set([current.key]);
        let frontier = [{ key: current.key }];
        for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
          const next = [];
          const lists = await Promise.all(
            frontier.map((f) => relations(f.key, ctx).then((r) => ({ f, r })).catch((e) => {
              if (isAbort(e)) throw e;
              partial = true;
              return { f, r: [] };
            }))
          );
          for (const { f, r } of lists) {
            for (const rel of r) {
              const k = REL_KIND[rel.relId] ?? "other";
              if (k === "skip" || seen.has(rel.title.key)) continue;
              seen.add(rel.title.key);
              const kind = f.kind === void 0 ? k : f.kind === k ? k : "story";
              found.set(rel.title.key, { ...rel.title, relationLabel: rel.label, relationKind: kind });
              if (EXPAND_REL.has(rel.relId) && found.size < 25) next.push({ key: rel.title.key, kind });
            }
          }
          frontier = next;
        }
        return { titles: [...found.values()], partial };
      },
      async search(query, ctx) {
        return ctx.cache.wrap("al-lib-search", query.toLowerCase(), 3 * DAY, async () => {
          const body = await get(`anime?q=${encodeURIComponent(query)}&site_id[]=${SITE_ID}`, ctx.signal);
          return arr(obj(body).data).map(parseLibMedia).filter((t) => !!t);
        }, ctx.force);
      },
      searchUrl: (query) => `${ORIGIN}/ru/catalog?q=${encodeURIComponent(query)}`
    };
  }

  // src/spaLifecycle.ts
  function watchRoute(onRoute) {
    let last;
    const check = () => {
      if (location.pathname === last) return;
      last = location.pathname;
      onRoute(new URL(location.href));
    };
    const timer = setInterval(check, 400);
    window.addEventListener("popstate", check);
    document.addEventListener("turbo:load", check);
    check();
    return () => {
      clearInterval(timer);
      window.removeEventListener("popstate", check);
      document.removeEventListener("turbo:load", check);
    };
  }
  function watchDom(cb, delayMs = 150) {
    let t;
    const obs = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(cb, delayMs);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      clearTimeout(t);
      obs.disconnect();
    };
  }

  // src/customOrder.ts
  function applyOrder(defaults, saved) {
    if (!saved || saved.length === 0) return [...defaults];
    const present = new Set(defaults);
    const out = saved.filter((k, i) => present.has(k) && saved.indexOf(k) === i);
    const placed = new Set(out);
    defaults.forEach((k, i) => {
      if (placed.has(k)) return;
      let pos = 0;
      for (let j = i - 1; j >= 0; j--) {
        const at = out.indexOf(defaults[j]);
        if (at >= 0) {
          pos = at + 1;
          break;
        }
      }
      out.splice(pos, 0, k);
      placed.add(k);
    });
    return out;
  }
  function move(full, key, dir, visible) {
    const out = [...full];
    const from = out.indexOf(key);
    if (from < 0) return out;
    let to = from + dir;
    while (to >= 0 && to < out.length && !visible.has(out[to])) to += dir;
    if (to < 0 || to >= out.length) return out;
    out.splice(from, 1);
    out.splice(to, 0, key);
    return out;
  }

  // src/matching.ts
  function normalizeTitle(s) {
    return s.normalize("NFKC").toLowerCase().replace(/[ё]/g, "е").replace(/[‘’“”`'"«»]/g, "").replace(/[~:;,.!?()[\]{}\-–—_/\\|·•☆★♪♥+*&]/g, " ").replace(/\s+/g, " ").trim();
  }
  function alNames(m) {
    const out = /* @__PURE__ */ new Set();
    for (const n of [m.romaji, m.english, m.native, ...m.synonyms]) {
      if (!n) continue;
      const k = normalizeTitle(n);
      if (k.length >= 2) out.add(k);
    }
    return out;
  }
  function siteNames(t) {
    const out = /* @__PURE__ */ new Set();
    for (const n of t.names) {
      const k = normalizeTitle(n);
      if (k.length >= 2) out.add(k);
    }
    return out;
  }
  var FORMAT_GROUP = {
    TV: "series",
    TV_SHORT: "series",
    ONA: "series",
    MOVIE: "movie",
    OVA: "extra",
    SPECIAL: "extra",
    MUSIC: "music",
    UNKNOWN: "?"
  };
  function formatsCompatible(a, b) {
    if (!a || !b || a === "UNKNOWN" || b === "UNKNOWN") return true;
    const ga = FORMAT_GROUP[a];
    const gb = FORMAT_GROUP[b];
    if (ga === gb) return true;
    const loose = /* @__PURE__ */ new Set(["series", "extra"]);
    return a === "ONA" || b === "ONA" ? loose.has(ga) && loose.has(gb) : false;
  }
  var pairKey = (alId, siteKey) => `${alId}|${siteKey}`;
  function candidatesFor(al, site) {
    if (site.anilistId !== void 0) return site.anilistId === al.id ? "id" : void 0;
    if (!formatsCompatible(al.format, site.format)) return void 0;
    const an = alNames(al);
    for (const n of siteNames(site)) {
      if (an.has(n)) return yearsCompatible(al.startDate, site.date) ? "name" : void 0;
    }
    if (sameExactDate(al.startDate, site.date) && al.format === site.format) return "date";
    return void 0;
  }
  function candidateRank(c) {
    const dateRank = c.confidence === "name" ? (c.site.date?.year !== void 0 && c.site.date.year === c.al.startDate.year ? 2 : 0) + (sameExactDate(c.site.date, c.al.startDate) ? 1 : 0) : 0;
    return RANK2[c.confidence] * 4 + dateRank;
  }
  var RANK2 = { site: 4, id: 3, name: 2, date: 1 };
  function matchTitles(alNodes, pool, rejected = /* @__PURE__ */ new Set()) {
    const all = [];
    for (const al of alNodes) {
      for (const site of pool) {
        if (rejected.has(pairKey(al.id, site.key))) continue;
        const c = candidatesFor(al, site);
        if (c) all.push({ al, site, confidence: c });
      }
    }
    const best = (key) => {
      const m = /* @__PURE__ */ new Map();
      for (const c of all) {
        const k = key(c);
        const cur = m.get(k);
        if (!cur || candidateRank(c) > candidateRank(cur[0])) m.set(k, [c]);
        else if (candidateRank(c) === candidateRank(cur[0])) cur.push(c);
      }
      return m;
    };
    const byAl = best((c) => c.al.id);
    const bySite = best((c) => c.site.key);
    const out = /* @__PURE__ */ new Map();
    for (const [alId, cands] of byAl) {
      if (cands.length !== 1) continue;
      const c = cands[0];
      const back = bySite.get(c.site.key);
      if (!back || back.length !== 1 || back[0].al.id !== alId) continue;
      out.set(alId, { title: c.site, confidence: c.confidence });
    }
    return out;
  }
  function pickVerified(current, results) {
    const m = matchTitles(results, [current]);
    const hits = [...m.entries()].filter(([, v]) => v.confidence !== "date");
    if (hits.length !== 1) return void 0;
    return results.find((r) => r.id === hits[0][0]);
  }
  function partName(name) {
    const m = normalizeTitle(name).match(/^(.+?)\s+(?:(?:part|часть)\s+)?(\d+)$/);
    return m && m[1].length >= 6 ? { base: m[1], number: Number(m[2]) } : void 0;
  }
  function nextPart(primary, title, al) {
    for (const name of primary.names) {
      const a = partName(name);
      if (!a) continue;
      if (![...alNames(al)].some((n) => partName(n)?.base === a.base)) continue;
      if (title.names.some((n) => {
        const b = partName(n);
        return b?.base === a.base && b.number === a.number + 1;
      })) return true;
    }
    return false;
  }
  function matchParts(nodes, matches, pool, rejected = /* @__PURE__ */ new Set()) {
    const used = new Set([...matches.values()].map((m) => m.title.key));
    const proposals = /* @__PURE__ */ new Map();
    const bundled = /* @__PURE__ */ new Set([
      "13329--rezero-kara-hajimeru-isekai-seikatsu-memory-snow-anime",
      "14685--rezero-kara-hajimeru-isekai-seikatsu-hyouketsu-no-kizuna-anime"
    ]);
    for (const al of nodes) {
      const primary = matches.get(al.id)?.title;
      if (!primary) continue;
      for (const title of pool) {
        if (used.has(title.key) || rejected.has(pairKey(al.id, title.key)) || title.anilistId !== void 0 && title.anilistId !== al.id || !primary.format || primary.format === "UNKNOWN" || title.format !== primary.format || !primary.date?.year || !title.date?.year || !yearsCompatible(primary.date, title.date) || !yearsCompatible(al.startDate, title.date)) continue;
        const bundle = al.id === 100049 && bundled.has(primary.key) && bundled.has(title.key);
        if (!bundle && !nextPart(primary, title, al)) continue;
        const list = proposals.get(title.key) ?? [];
        list.push({ id: al.id, match: { title, confidence: title.anilistId === al.id ? "id" : "name" } });
        proposals.set(title.key, list);
      }
    }
    const out = /* @__PURE__ */ new Map();
    for (const proposalsForTitle of proposals.values()) {
      if (proposalsForTitle.length !== 1) continue;
      const { id, match } = proposalsForTitle[0];
      const list = out.get(id) ?? [];
      list.push(match);
      out.set(id, list);
    }
    for (const [id, titles] of out) if (titles.length !== 1) out.delete(id);
    return out;
  }

  // src/data/orderProfiles.ts
  var CURATED_PROFILES = [
    {
      "id": "monogatari",
      "title": "Monogatari",
      "anchorIds": [5081, 9260, 11597, 15689, 17074, 20593, 20918, 21520, 21262, 21745, 100815, 173533, 21399, 21400],
      "checkedAt": "2026-10-17",
      "recommended": {
        "steps": [
          { "alId": 5081, "title": "Bakemonogatari", "note": "Все 15 серий, включая сетевые 13–15." },
          { "alId": 9260, "title": "Kizumonogatari I: Tekketsu-hen" },
          { "alId": 21399, "title": "Kizumonogatari II: Nekketsu-hen" },
          { "alId": 21400, "title": "Kizumonogatari III: Reiketsu-hen" },
          { "alId": 11597, "title": "Nisemonogatari" },
          { "alId": 15689, "title": "Nekomonogatari (Kuro)" },
          { "alId": 17074, "title": "Monogatari Series: Second Season", "episodes": "1–11" },
          { "alId": 20593, "title": "Hanamonogatari" },
          { "alId": 17074, "title": "Monogatari Series: Second Season", "episodes": "12–26" },
          { "alId": 20918, "title": "Tsukimonogatari" },
          { "alId": 21520, "title": "Koyomimonogatari" },
          { "alId": 21262, "title": "Owarimonogatari" },
          { "alId": 21745, "title": "Owarimonogatari (Ge)" },
          { "alId": 100815, "title": "Zoku Owarimonogatari" },
          { "alId": 173533, "title": "Monogatari Series: Off & Monster Season" }
        ],
        "note": "Выбран порядок публикации романов. Hanamonogatari вставлена внутрь Second Season; он отличается от порядка аниме-релизов. Это редакционный выбор для первого просмотра, а не официальное предписание.",
        "sources": [
          {
            "label": "r/anime — Watch Order Wiki (порядок сообщества)",
            "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_monogatari_.2F_bakemonogatari",
            "detail": "Раздел Novel Release Order: конкретный порядок и разбиение Second Season 1–11 / 12–26."
          },
          {
            "label": "Официальный портал Monogatari",
            "url": "https://www.monogatari-series.com/series/?code=monogatari-series",
            "detail": "Состав Second Season и принадлежность Hana к этому циклу."
          }
        ]
      },
      "chronologyUnavailable": "Полная событийная карта не проверена: арки пересекаются, требуются многочисленные переходы между сериями. Сортировка целых сезонов будет неверной.",
      "limitations": [
        "Диапазоны Second Season используют исходную 26-серийную нумерацию с recap-сериями; в изданиях без пересказов номера сдвинуты.",
        "Off & Monster Season оставлен в порядке эпизодов своего издания; это не восстановленная хронология событий.",
        "Новая Shin Episode и Koyomi Vamp не добавлены в проверенный маршрут; Koyomi Vamp — альтернативное сокращённое издание Kizu."
      ]
    },
    {
      "id": "fate-stay-night",
      "title": "Fate/stay night и Fate/Zero",
      "anchorIds": [356, 6922, 19603, 20792, 20791, 21718, 21719, 10087, 11741, 21318],
      "checkedAt": "2026-10-17",
      "recommended": {
        "steps": [
          { "alId": 19603, "title": "Fate/stay night: Unlimited Blade Works", "note": "Включая пролог, обычно обозначенный серией 0." },
          { "alId": 20792, "title": "Fate/stay night: Unlimited Blade Works 2nd Season" },
          { "alId": 21318, "title": "Fate/stay night: Unlimited Blade Works 2nd Season - sunny day", "optional": true, "note": "Альтернативная концовка UBW." },
          { "alId": 20791, "title": "Fate/stay night [Heaven's Feel] I. presage flower" },
          { "alId": 21718, "title": "Fate/stay night [Heaven's Feel] II. lost butterfly" },
          { "alId": 21719, "title": "Fate/stay night [Heaven's Feel] III. spring song" },
          { "alId": 10087, "title": "Fate/Zero" },
          { "alId": 11741, "title": "Fate/Zero 2nd Season" }
        ],
        "note": "Выбран anime-only маршрут сообщества: UBW → Heaven’s Feel → Zero. Zero раскрывает часть загадок Stay Night; варианты Stay Night показывают разные исходы одних событий.",
        "sources": [
          {
            "label": "r/fatestaynight — Viewing Order Guide (гайд сообщества)",
            "url": "https://www.reddit.com/r/fatestaynight/comments/df8rvo/rfatestaynights_official_viewing_order_guide_v2/",
            "detail": "Anime-only UBW → три Heaven’s Feel → два сезона Zero; Sunny Day после UBW."
          },
          {
            "label": "Официальный сайт Fate/Zero",
            "url": "https://www.fate-zero.jp/introduction/",
            "detail": "Zero рассказывает о войне за десять лет до событий Stay Night."
          },
          {
            "label": "r/anime — Fate FAQ",
            "url": "https://www.reddit.com/r/anime/wiki/seriesfaq/fate/",
            "detail": "Три альтернативных маршрута Stay Night; отделение спин-оффов от основной ветки."
          }
        ]
      },
      "chronologyUnavailable": "Единой линейной хронологии нет: Fate, UBW и Heaven’s Feel — альтернативные ветки. Zero происходит раньше; последовательность Zero → UBW → Heaven’s Feel ошибочно изображала бы последние две ветки продолжениями.",
      "limitations": [
        "Версии DEEN 2006 и UBW 2010 — отдельные адаптации, не обязательные промежуточные сезоны.",
        "Слово Official в названии Reddit-поста означает утверждённый гайд сообщества, не позицию TYPE-MOON."
      ]
    },
    {
      "id": "steins-gate",
      "title": "Steins;Gate",
      "anchorIds": [9253, 21127, 21624, 10863, 11577, 104174],
      "checkedAt": "2026-10-17",
      "recommended": {
        "steps": [
          { "alId": 9253, "title": "Steins;Gate", "episodes": "1–24" },
          { "alId": 21624, "title": "Steins;Gate: Kyoukaimenjou no Missing Link - Divide By Zero", "note": "Альтернативная серия 23β, вход в Steins;Gate 0." },
          { "alId": 21127, "title": "Steins;Gate 0" },
          { "alId": 104174, "title": "Steins;Gate 0: Kesshou Takei no Valentine - Bittersweet Day", "optional": true },
          { "alId": 10863, "title": "Steins;Gate: Oukoubakko no Poriomania", "optional": true },
          { "alId": 11577, "title": "Steins;Gate: Fuka Ryouiki no Déjà vu", "optional": true }
        ],
        "note": "Для первого просмотра закончить оригинальный сериал, затем 23β и Zero. OVA и фильм — дополнения.",
        "sources": [
          {
            "label": "r/anime — Watch Order Wiki (порядок сообщества)",
            "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_steins.3Bgate",
            "detail": "Оба маршрута: целыми сериалами и с переходами по эпизодам."
          }
        ]
      },
      "chronological": {
        "steps": [
          { "alId": 9253, "title": "Steins;Gate", "episodes": "1–22" },
          { "alId": 21624, "title": "Steins;Gate: Kyoukaimenjou no Missing Link - Divide By Zero" },
          { "alId": 21127, "title": "Steins;Gate 0", "episodes": "1–11" },
          { "alId": 104174, "title": "Steins;Gate 0: Kesshou Takei no Valentine - Bittersweet Day", "optional": true },
          { "alId": 21127, "title": "Steins;Gate 0", "episodes": "12–23" },
          { "alId": 9253, "title": "Steins;Gate", "episodes": "23–24" },
          { "alId": 10863, "title": "Steins;Gate: Oukoubakko no Poriomania", "optional": true },
          { "alId": 11577, "title": "Steins;Gate: Fuka Ryouiki no Déjà vu", "optional": true }
        ],
        "note": "Альтернативный маршрут по причинной последовательности временных линий. Требует переходов между сериалами; для повторного просмотра.",
        "sources": [
          {
            "label": "r/anime — Watch Order Wiki (порядок сообщества)",
            "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_steins.3Bgate",
            "detail": "Оба маршрута: целыми сериалами и с переходами по эпизодам."
          }
        ]
      },
      "limitations": [
        "Это маршрут по веткам истории, не календарная сортировка сцен: события временных петель повторяются.",
        "В отдельных каталогах альтернативная 23β включена в сезон; не заменять ею обычную 23-ю серию при первом просмотре."
      ]
    },
    {
      "id": "madoka-magica",
      "title": "Madoka Magica",
      "anchorIds": [9756, 11977, 11979, 11981, 133007],
      "checkedAt": "2026-10-17",
      "recommended": {
        "steps": [
          { "alId": 9756, "title": "Mahou Shoujo Madoka☆Magica" },
          { "alId": 11981, "title": "Mahou Shoujo Madoka☆Magica: Hangyaku no Monogatari" },
          { "alId": 133007, "title": "Mahou Shoujo Madoka☆Magica: Walpurgis no Kaiten" }
        ],
        "note": "Основная линия: сериал → Rebellion → Walpurgisnacht Rising. Первые два фильма пересказывают сериал и служат альтернативным изданием, а не его продолжением.",
        "sources": [
          {
            "label": "Официальный сайт Walpurgisnacht Rising",
            "url": "https://www.madoka-magica.com/wr/",
            "detail": "Прямое продолжение Rebellion; первые два фильма названы перемонтированной версией сериала."
          },
          {
            "label": "r/anime — Watch Order Wiki (порядок сообщества)",
            "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_madoka_magica",
            "detail": "Для первого просмотра выбран сериал, Magia Record обозначен отдельной историей."
          }
        ]
      },
      "chronologyUnavailable": "Внутри сериала есть временные петли и предыстория. Проверенная схема перестановки эпизодов для полной событийной хронологии не найдена.",
      "limitations": [
        "Magia Record — самостоятельный спин-офф, его нельзя механически вставить между основными фильмами."
      ]
    },
    {
      "id": "mushoku-tensei",
      "title": "Реинкарнация безработного",
      "anchorIds": [108465, 127720, 141534, 146065, 166873, 178789],
      "checkedAt": "2026-10-17",
      "recommended": {
        "steps": [
          { "alId": 108465, "title": "Mushoku Tensei: Isekai Ittara Honki Dasu" },
          { "alId": 127720, "title": "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2" },
          { "alId": 141534, "title": "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2 - Eris no Goblin Toubatsu", "note": "Дополнение об Эрис, смотреть до второго сезона." },
          { "alId": 146065, "title": "Mushoku Tensei II: Isekai Ittara Honki Dasu", "note": "Включая вводную серию 0 о Фиттсе, если она есть в данном издании." },
          { "alId": 166873, "title": "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2" },
          { "alId": 178789, "title": "Mushoku Tensei III: Isekai Ittara Honki Dasu" }
        ],
        "note": "Редакционный маршрут: сезоны по продолжению истории, OVA об Эрис после первого сезона.",
        "sources": [
          {
            "label": "Официальный Mushoku: OVA Эрис",
            "url": "https://mushokutensei.jp/news/220302_1/",
            "detail": "OVA происходит одновременно с общей серией 16: Рудеус встречает Пауля, Эрис и Руйджерд проводят этот день отдельно."
          },
          {
            "label": "Официальный Mushoku: серия 16",
            "url": "https://mushokutensei.jp/story/16/",
            "detail": "Место события OVA в первом сезоне."
          },
          {
            "label": "Официальный Mushoku: сезон 2, серия 0",
            "url": "https://mushokutensei.jp/news/230628_1/",
            "detail": "Вводная серия второго сезона имеет номер 0."
          },
          {
            "label": "Официальный Mushoku: текущие выпуски",
            "url": "https://mushokutensei.jp/2024/",
            "detail": "Третий сезон существует и выходил летом 2026 года."
          }
        ]
      },
      "chronologyUnavailable": "Подтверждена вставка OVA рядом с общей серией 16 (Part 2, серия 5). Полный маршрут с серией 0 второго сезона и пересекающейся предысторией не проверен; автоматически считать его хронологическим нельзя.",
      "limitations": [
        "Точное локальное положение OVA: Part 2 серии 1–5 → OVA → Part 2 серии 6–12; это подтверждённая вставка, но не полная хронология всей франшизы.",
        "Поздние анонсы за пределами проверенного маршрута."
      ]
    },
    {
      "id": "konosuba",
      "title": "KonoSuba",
      "anchorIds": [21202, 21574, 21699, 97996, 102976, 150075, 136804, 181244],
      "checkedAt": "2026-10-17",
      "recommended": {
        "steps": [
          { "alId": 21202, "title": "Kono Subarashii Sekai ni Shukufuku wo!" },
          { "alId": 21699, "title": "Kono Subarashii Sekai ni Shukufuku wo! 2", "episodes": "1–4" },
          { "alId": 21574, "title": "Kono Subarashii Sekai ni Shukufuku wo!: Kono Subarashii Choker ni Shukufuku wo!", "optional": true },
          { "alId": 21699, "title": "Kono Subarashii Sekai ni Shukufuku wo! 2", "episodes": "5–10" },
          { "alId": 97996, "title": "Kono Subarashii Sekai ni Shukufuku wo! 2: Kono Subarashii Geijutsu ni Shukufuku wo!", "optional": true },
          { "alId": 150075, "title": "Kono Subarashii Sekai ni Bakuen wo!", "optional": true, "note": "Приквел о Мэгумин; здесь уже понятны отсылки к основной истории." },
          { "alId": 102976, "title": "Kono Subarashii Sekai ni Shukufuku wo! Kurenai Densetsu" },
          { "alId": 136804, "title": "Kono Subarashii Sekai ni Shukufuku wo! 3" },
          { "alId": 181244, "title": "Kono Subarashii Sekai ni Shukufuku wo! 3: BONUS STAGE", "optional": true }
        ],
        "note": "Первую OVA удобно вставить после 4-й серии второго сезона. Приквел о Мэгумин оставлен после знакомства с основной командой.",
        "sources": [
          {
            "label": "r/anime — Watch Order Wiki (порядок сообщества)",
            "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_kono_subarashii_sekai_ni_shukufuku_wo.21",
            "detail": "Разбиение второго сезона вокруг первой OVA и рекомендация смотреть Bakuen после второго сезона."
          },
          {
            "label": "Официальный KonoSuba: Bonus Stage",
            "url": "https://konosuba.com/3rd/ova/story/",
            "detail": "Две дополнительные истории к третьему сезону; точная позиция в общей хронологии не установлена."
          }
        ]
      },
      "chronologyUnavailable": "Положение Bakuen как приквела и первой OVA внутри S2 проверено, но точное событийное место Bonus Stage не установлено. Полный событийный маршрут пока не опубликован.",
      "limitations": [
        "Для отдельных OVA порядок выхода и событийное место различаются.",
        "Четвёртый сезон не включён в проверенный маршрут."
      ]
    },
    {
      "id": "kaguya-sama",
      "title": "Госпожа Кагуя",
      "anchorIds": [101921, 112641, 125368, 165557, 125367, 151384],
      "checkedAt": "2026-10-17",
      "recommended": {
        "steps": [
          { "alId": 101921, "title": "Kaguya-sama wa Kokurasetai: Tensaitachi no Renai Zunousen" },
          { "alId": 112641, "title": "Kaguya-sama wa Kokurasetai?: Tensaitachi no Renai Zunousen" },
          { "alId": 125368, "title": "Kaguya-sama wa Kokurasetai: Tensaitachi no Renai Zunousen OVA", "optional": true },
          { "alId": 165557, "title": "Kaguya-sama wa Kokurasetai: Ultra Romantic 3rd Season Teaser PV - Ishigami Yuu wa Kataritai", "optional": true },
          { "alId": 125367, "title": "Kaguya-sama wa Kokurasetai: Ultra Romantic" },
          { "alId": 151384, "title": "Kaguya-sama wa Kokurasetai: First Kiss wa Owaranai" }
        ],
        "note": "Основная линия сезонов; OVA и короткий Ishigami Yuu wa Kataritai перед третьим сезоном. First Kiss продолжает Ultra Romantic.",
        "sources": [
          {
            "label": "r/anime — Watch Order Wiki (порядок сообщества)",
            "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_kaguya-sama.3A_love_is_war",
            "detail": "Последовательность S1 → S2 → OVA → ONA → Ultra Romantic → First Kiss."
          }
        ]
      },
      "chronologyUnavailable": "Гэги и OVA не проверены на покадровую/поэпизодную хронологию. Порядок выхода дополнений не выдаётся за событийный.",
      "limitations": [
        "Otona e no Kaidan (AL 194884) существует, но точное место его отдельных эпизодов в событийной карте здесь не проверено.",
        "Kanketsu-hen (AL 205081) не включён."
      ]
    },
    {
      "id": "attack-on-titan",
      "title": "Атака титанов",
      "anchorIds": [16498, 18397, 20811, 20958, 99634, 99147, 104578, 110277, 131681, 146984, 162314],
      "checkedAt": "2026-10-17",
      "recommended": {
        "steps": [
          { "alId": 16498, "title": "Shingeki no Kyojin" },
          { "alId": 18397, "title": "Shingeki no Kyojin OVA", "optional": true },
          { "alId": 20811, "title": "Shingeki no Kyojin Gaiden: Kuinaki Sentaku", "optional": true },
          { "alId": 20958, "title": "Shingeki no Kyojin Season 2" },
          { "alId": 99634, "title": "Shingeki no Kyojin: LOST GIRLS", "episodes": "1–2", "optional": true },
          { "alId": 99147, "title": "Shingeki no Kyojin Season 3" },
          { "alId": 99634, "title": "Shingeki no Kyojin: LOST GIRLS", "episodes": "3", "optional": true, "note": "Эта история отделена от первых двух Lost Girls." },
          { "alId": 104578, "title": "Shingeki no Kyojin Season 3 Part 2" },
          { "alId": 110277, "title": "Shingeki no Kyojin: The Final Season" },
          { "alId": 131681, "title": "Shingeki no Kyojin: The Final Season Part 2" },
          { "alId": 146984, "title": "Shingeki no Kyojin: The Final Season - Kanketsu-hen Zenpen" },
          { "alId": 162314, "title": "Shingeki no Kyojin: The Final Season - Kanketsu-hen Kouhen" }
        ],
        "note": "Первый просмотр с OVA в местах, где они не опережают раскрытия основной истории. Lost Girls нужно разделить на 1–2 и 3.",
        "sources": [
          {
            "label": "r/anime — Watch Order Wiki (порядок сообщества)",
            "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_attack_on_titan",
            "detail": "Точное размещение обеих частей Lost Girls и No Regrets относительно сезонов."
          }
        ]
      },
      "chronologyUnavailable": "Полная событийная карта не проверена: No Regrets — предыстория, Lost Girls и основной сюжет включают ретроспективы. Порядок для первого просмотра не является строгой хронологией.",
      "limitations": [
        "Пересказы и альтернативные монтажи финала оставлены за пределами основного маршрута."
      ]
    },
    {
      "id": "jojo",
      "title": "Невероятные приключения ДжоДжо",
      "anchorIds": [14719, 20474, 20799, 21450, 21778, 102883, 131942, 146722, 190327, 210482],
      "checkedAt": "2026-10-17",
      "recommended": {
        "steps": [
          { "alId": 14719, "title": "JoJo no Kimyou na Bouken (TV)" },
          { "alId": 20474, "title": "JoJo no Kimyou na Bouken: Stardust Crusaders" },
          { "alId": 20799, "title": "JoJo no Kimyou na Bouken: Stardust Crusaders - Egypt-hen" },
          { "alId": 21450, "title": "JoJo no Kimyou na Bouken: Diamond wa Kudakenai" },
          { "alId": 21778, "title": "Kishibe Rohan wa Ugokanai", "optional": true },
          { "alId": 102883, "title": "JoJo no Kimyou na Bouken: Ougon no Kaze" },
          { "alId": 131942, "title": "JoJo no Kimyou na Bouken: Stone Ocean" },
          { "alId": 146722, "title": "JoJo no Kimyou na Bouken: Stone Ocean Part 2", "note": "В AniList это 26 серий: объединённые блоки Stone Ocean 2 и 3." },
          { "alId": 190327, "title": "JoJo no Kimyou na Bouken: Steel Ball Run - 1st STAGE", "note": "Начало другой сюжетной линии; это не возвращение в прошлое мира Stone Ocean." },
          { "alId": 210482, "title": "JoJo no Kimyou na Bouken: Steel Ball Run - 2nd & 3rd STAGE" }
        ],
        "note": "Части основной адаптации по порядку, Rohan необязателен после Diamond. Затем отдельная линия Steel Ball Run.",
        "sources": [
          {
            "label": "r/anime — Watch Order Wiki (порядок сообщества)",
            "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_jojo.27s_bizarre_adventure",
            "detail": "Порядок адаптации, Rohan после Diamond, старые OVA как альтернативные адаптации."
          },
          {
            "label": "Официальный портал JoJo: аниме",
            "url": "https://jojo-portal.com/en/anime/",
            "detail": "Преемственность основных частей, Stone Ocean в 2011 году, Rohan как отдельная коллекция историй."
          },
          {
            "label": "AniList: Stone Ocean Part 2",
            "url": "https://anilist.co/anime/146722/JoJo-no-Kimyou-na-Bouken-Stone-Ocean-Part-2",
            "detail": "AL 146722 содержит 26 серий; отдельного AL ID для Netflix Part 3 нет."
          }
        ]
      },
      "chronological": {
        "steps": [
          { "alId": 14719, "title": "JoJo no Kimyou na Bouken (TV)" },
          { "alId": 20474, "title": "JoJo no Kimyou na Bouken: Stardust Crusaders" },
          { "alId": 20799, "title": "JoJo no Kimyou na Bouken: Stardust Crusaders - Egypt-hen" },
          { "alId": 21450, "title": "JoJo no Kimyou na Bouken: Diamond wa Kudakenai" },
          { "alId": 102883, "title": "JoJo no Kimyou na Bouken: Ougon no Kaze" },
          { "alId": 131942, "title": "JoJo no Kimyou na Bouken: Stone Ocean" },
          { "alId": 146722, "title": "JoJo no Kimyou na Bouken: Stone Ocean Part 2", "note": "В AniList это 26 серий: объединённые блоки Stone Ocean 2 и 3." }
        ],
        "note": "Только исходная линия Phantom Blood → Stone Ocean. Steel Ball Run и эпизодические истории Rohan не вставлены в общую временную шкалу.",
        "sources": [
          {
            "label": "r/anime — Watch Order Wiki (порядок сообщества)",
            "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_jojo.27s_bizarre_adventure",
            "detail": "Порядок адаптации, Rohan после Diamond, старые OVA как альтернативные адаптации."
          },
          {
            "label": "Официальный портал JoJo: аниме",
            "url": "https://jojo-portal.com/en/anime/",
            "detail": "Преемственность основных частей, Stone Ocean в 2011 году, Rohan как отдельная коллекция историй."
          },
          {
            "label": "AniList: Stone Ocean Part 2",
            "url": "https://anilist.co/anime/146722/JoJo-no-Kimyou-na-Bouken-Stone-Ocean-Part-2",
            "detail": "AL 146722 содержит 26 серий; отдельного AL ID для Netflix Part 3 нет."
          }
        ]
      },
      "limitations": [
        "AniList объединяет Netflix Stone Ocean Part 2 и Part 3 в AL 146722; нельзя создавать выдуманный AniList ID для третьего блока.",
        "Событийный маршрут ограничен основной исходной линией, флешбэки внутри серий не переставляются."
      ]
    }
  ];

  // src/orderProfiles.ts
  var ORDER_PROFILES = CURATED_PROFILES;
  var profileForId = (id) => ORDER_PROFILES.find((profile) => profile.anchorIds.includes(id));

  // src/orderModes.ts
  var MODE_LABELS = {
    recommended: "Рекомендованный",
    release: "По выходу",
    chronological: "По событиям"
  };
  var rowKey = (item) => item.rowKey ?? item.watchKey;
  function findProfile(result, profiles = ORDER_PROFILES) {
    const current = [...result.items, ...result.branches].find((item) => item.isCurrent)?.alId;
    const id = result.rootAlId ?? current ?? Number(result.franchiseKey.match(/^al:(\d+)$/)?.[1]);
    if (!id || result.mode !== "anilist") return void 0;
    return profiles.find((profile) => profile.anchorIds.includes(id));
  }
  function selectOrder(result, selectedMode, profiles = ORDER_PROFILES) {
    const profile = findProfile(result, profiles);
    const franchiseKey = profile ? `al:${profile.anchorIds[0]}` : result.franchiseKey;
    const base = {
      ...result,
      selectedMode,
      profile,
      // Старые пользовательские правки продолжают действовать в рекомендованном режиме.
      orderKey: selectedMode === "recommended" ? franchiseKey : `${franchiseKey}:${selectedMode}`,
      legacyOrderKeys: selectedMode === "recommended" ? [.../* @__PURE__ */ new Set([result.franchiseKey, ...profile?.anchorIds.map((id) => `al:${id}`) ?? []])].filter((key) => key !== franchiseKey) : [],
      verified: false,
      available: true,
      sources: [],
      explanation: ""
    };
    if (selectedMode === "release") {
      const items2 = [...result.items, ...result.branches].sort((a, b) => dateKey(a.date) - dateKey(b.date));
      return {
        ...base,
        items: items2,
        branches: [],
        explanation: "По датам начала выхода тайтлов. Альтернативные версии и спин-оффы не обязательны для просмотра. Неполные даты приблизительны, неизвестные — в конце."
      };
    }
    const route = selectedMode === "recommended" ? profile?.recommended : profile?.chronological;
    if (!route) {
      return {
        ...base,
        available: selectedMode !== "chronological",
        items: selectedMode === "chronological" ? [] : result.items,
        explanation: selectedMode === "chronological" ? profile?.chronologyUnavailable ?? "Проверенной хронологии событий пока нет. Можно выбрать порядок по выходу." : "Автоматический порядок по связям и датам. Проверенного маршрута для первого просмотра пока нет."
      };
    }
    const all = [...result.items, ...result.branches];
    const byId = /* @__PURE__ */ new Map();
    for (const item of all) {
      if (item.alId === void 0) continue;
      const group = byId.get(item.alId) ?? [];
      group.push(item);
      byId.set(item.alId, group);
    }
    const included = /* @__PURE__ */ new Set();
    const items = [];
    for (const step of route.steps) {
      const group = byId.get(step.alId);
      if (!group) continue;
      included.add(step.alId);
      for (const item of group) {
        const flags = item.flags.filter((flag) => flag !== "порядок неоднозначен" && flag !== "предыстория по другой ветке");
        if (step.note) flags.push(step.note);
        if (step.optional) flags.push("необязательно");
        const episodes = group.length === 1 ? step.episodes : void 0;
        if (step.episodes && !episodes) flags.push(`диапазон всей записи: серии ${step.episodes}; нумерация карточек сайта может отличаться`);
        items.push({
          ...item,
          rowKey: step.episodes ? `${item.watchKey}:episodes:${step.episodes}` : item.watchKey,
          episodes,
          kind: step.optional ? "extra" : "main",
          index: void 0,
          continuation: item.continuation,
          flags
        });
      }
    }
    const missing = route.steps.filter((step) => !byId.has(step.alId));
    const branches = all.filter((item) => item.alId === void 0 || !included.has(item.alId)).map((item) => ({
      ...item,
      flags: [...item.flags, "вне проверенного маршрута"]
    }));
    const notes = [...result.notes];
    if (missing.length) notes.push(`В загруженных данных нет ${new Set(missing.map((step) => step.alId)).size} частей проверенного маршрута. Список неполный.`);
    if (route.steps.some((step) => step.episodes)) notes.push("Диапазоны серий относятся к указанному тайтлу. Отметка «просмотрено» общая для всех его диапазонов.");
    return {
      ...base,
      items,
      branches,
      notes,
      verified: true,
      sources: route.sources,
      explanation: `${missing.length ? "Маршрут неполный: часть тайтлов не загрузилась. " : ""}${route.note} Проверено: ${profile.checkedAt}. Части вне маршрута показаны отдельно.`
    };
  }

  // src/ui.ts
  var CSS = `
:host{all:initial;display:block;margin:24px 0;color:var(--fg);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
:host([data-theme=dark]){--fg:#e8e8ea;--muted:#a1a1aa;--row:rgba(255,255,255,.05);--row-hi:rgba(255,255,255,.12);
  --line:rgba(255,255,255,.16);--accent:#8b7cf6;--warn:#e3a33b;--panel:#232327;--shadow:rgba(0,0,0,.5)}
:host([data-theme=light]){--fg:#1d1d1f;--muted:#6b6b73;--row:rgba(0,0,0,.04);--row-hi:rgba(0,0,0,.09);
  --line:rgba(0,0,0,.15);--accent:#6a4ff0;--warn:#a85f00;--panel:#fff;--shadow:rgba(0,0,0,.18)}
*{box-sizing:border-box}
button{font:inherit;color:inherit}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.toggle{all:unset;cursor:pointer;display:flex;align-items:center;gap:8px;min-width:0}
.chev{display:inline-block;width:1em;text-align:center;color:var(--muted);transition:transform .15s}
.collapsed .chev{transform:rotate(-90deg)}
h2{margin:0;font-size:18px;font-weight:600;line-height:1.3}
.sum{font-size:12px;color:var(--muted)}
.ctl{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto;position:relative}
.btn{font-size:12px;line-height:18px;padding:3px 10px;border-radius:6px;cursor:pointer;background:transparent;
  border:1px solid var(--line)}
.btn:hover,.btn.on{background:var(--row-hi)}
.btn:disabled{opacity:.5;cursor:default;background:transparent}
button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.order-modes{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.order-info{margin:8px 0;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.order-info strong{color:var(--fg);font-weight:500}
.sources{font-size:12px;margin:6px 0}
.sources a{color:var(--accent)}
.sources ul{margin:6px 0;padding-left:20px}
.seg{display:inline-flex}
.seg .btn{border-radius:0}
.seg .btn:first-child{border-radius:6px 0 0 6px}
.seg .btn:last-child{border-radius:0 6px 6px 0;border-left:0}
.menu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;min-width:220px;padding:4px;border-radius:8px;
  background:var(--panel);border:1px solid var(--line);box-shadow:0 8px 24px var(--shadow)}
.menu button{all:unset;display:block;width:100%;box-sizing:border-box;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:13px}
.menu button:hover{background:var(--row-hi)}
ol{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
li{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;padding:6px 10px;border-radius:8px;background:var(--row)}
li.cur{background:var(--row-hi);box-shadow:inset 3px 0 0 var(--accent)}
li.cur .title{font-weight:600}
li.side{margin-left:20px}
li.done .title{color:var(--muted)}
.mark{all:unset;cursor:pointer;width:1.3em;text-align:center;color:var(--muted)}
.mark:hover{color:var(--fg)}
li.done .mark{color:var(--accent)}
.num{min-width:1.5em;color:var(--muted);font-variant-numeric:tabular-nums}
.title{color:inherit;text-decoration:none;overflow-wrap:anywhere}
a.title:hover{text-decoration:underline}
.meta,.sub{font-size:12px;color:var(--muted)}
.warn{font-size:12px;color:var(--warn)}
.miss{font-size:12px;color:var(--muted)}
.miss a{color:inherit}
.link{all:unset;cursor:pointer;font-size:12px;text-decoration:underline;color:var(--muted)}
.edit{display:flex;gap:4px;margin-left:auto}
.edit .btn{padding:1px 8px}
details{margin-top:10px}
summary{cursor:pointer;color:var(--muted)}
.note{margin-top:8px;font-size:12px;color:var(--muted)}
.state{margin-top:10px;color:var(--muted)}
.cover{all:unset;flex:none;width:40px;height:56px;border-radius:4px;overflow:hidden;cursor:zoom-in;background:var(--row-hi)}
.cover img{width:100%;height:100%;object-fit:cover;display:block}
.cover.empty{cursor:default}
`;
  var ZOOM_CSS = `
:host{all:initial}
.zoom{outline:none;position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;
  background:rgba(8,8,10,.94);cursor:zoom-out;padding:24px;overflow:hidden;overscroll-behavior:contain;touch-action:none;
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.zoom img{width:min(420px,90vw);max-height:80vh;object-fit:contain;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.6);
  transform-origin:center;user-select:none;will-change:transform}
.cap,.hint{position:fixed;left:0;right:0;z-index:1;margin:0 auto;max-width:90vw;text-align:center;pointer-events:none;
  text-shadow:0 1px 3px #000,0 0 8px #000}
.cap{bottom:38px;color:#fff}
.hint{bottom:14px;color:rgba(255,255,255,.6);font-size:12px}
`;
  var KIND_LABEL = {
    main: "",
    extra: "Дополнительно",
    recap: "Пересказ",
    alternative: "Альтернативная ветка",
    spinoff: "Спин-офф",
    other: "Другое"
  };
  function zoomAt(v, factor, d, min = 1, max = 8) {
    const scale = Math.min(max, Math.max(min, v.scale * factor));
    if (scale === 1) return { scale: 1, x: 0, y: 0 };
    const k = scale / v.scale;
    return { scale, x: d.x - k * (d.x - v.x), y: d.y - k * (d.y - v.y) };
  }
  var yearOf = (d) => d?.year ? String(d.year) : void 0;
  function h(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    if (props.class) e.className = props.class;
    if (props.text !== void 0) e.textContent = props.text;
    if (props.title) e.title = props.title;
    if (props.onClick) {
      const fn = props.onClick;
      e.addEventListener("click", (ev) => {
        ev.preventDefault();
        fn();
      });
    }
    if (e instanceof HTMLButtonElement) e.type = "button";
    for (const c of children) if (c) e.append(c);
    return e;
  }
  function isDarkBackground(start2) {
    for (let el = start2; el; el = el.parentElement) {
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m || m[4] !== void 0 && Number(m[4]) < 0.5) continue;
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }
  var WatchOrderView = class {
    constructor(user, handlers) {
      this.user = user;
      this.handlers = handlers;
      this.state = { status: "loading" };
      this.editing = false;
      this.menuOpen = false;
      this.root = document.createElement("div");
      this.root.dataset.awo = "1";
      this.root.dataset.theme = "dark";
      const shadow = this.root.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CSS;
      this.box = document.createElement("div");
      shadow.append(style, this.box);
      this.render();
    }
    set(state) {
      this.state = state;
      this.root.dataset.status = state.status;
      this.render();
    }
    /** Подстроить тему под фон страницы; зовётся при каждом монтировании. */
    syncTheme() {
      const theme = isDarkBackground(this.root.parentElement) ? "dark" : "light";
      if (this.root.dataset.theme !== theme) this.root.dataset.theme = theme;
    }
    result() {
      return this.state.status === "ready" ? selectOrder(this.state.result, this.user.prefs().orderMode) : void 0;
    }
    custom(res) {
      return this.user.customOrder(res.orderKey) ?? res.legacyOrderKeys.map((key) => this.user.customOrder(key)).find(Boolean);
    }
    /** Элементы основного списка с учётом своего порядка, скрытых и режима. */
    arranged(res) {
      const prefs = this.user.prefs();
      const custom = this.custom(res);
      const byKey = new Map(res.items.map((i) => [rowKey(i), i]));
      const saved = custom?.order.flatMap((key) => byKey.has(key) ? [key] : res.items.filter((i) => i.watchKey === key).map(rowKey));
      const keys = applyOrder(res.items.map(rowKey), saved);
      const hidden = new Set(custom?.hidden ?? []);
      const all = keys.map((k) => byKey.get(k));
      const showAll = prefs.view === "all" || res.mode !== "anilist";
      const isHidden = (i) => hidden.has(rowKey(i)) || hidden.has(i.watchKey);
      const visible = all.filter((i) => !isHidden(i) && (showAll || i.kind === "main" || i.isCurrent && i.kind !== "recap"));
      return { keys, all, visible, hiddenItems: all.filter(isHidden), custom };
    }
    render() {
      const prefs = this.user.prefs();
      const res = this.result();
      const wrap = h("div", { class: prefs.collapsed ? "collapsed" : "" });
      wrap.append(this.header(res));
      if (!prefs.collapsed) wrap.append(...this.body(res));
      this.box.replaceChildren(wrap);
    }
    header(res) {
      const prefs = this.user.prefs();
      const toggle = h(
        "button",
        {
          class: "toggle",
          title: prefs.collapsed ? "Развернуть" : "Свернуть",
          onClick: () => {
            this.user.setPrefs({ collapsed: !prefs.collapsed });
            this.render();
          }
        },
        h("span", { class: "chev", text: "▾" }),
        h("h2", { text: "Порядок просмотра" })
      );
      const head = h("div", { class: "head" }, toggle);
      if (res) head.append(h("span", { class: "sum", text: this.summary(res) }));
      if (prefs.collapsed) return head;
      const ctl = h("div", { class: "ctl" });
      if (res?.mode === "anilist") {
        const seg = h("span", { class: "seg" });
        for (const [v, label] of [["main", "Основное"], ["all", "Всё"]]) {
          seg.append(
            h("button", {
              class: "btn" + (prefs.view === v ? " on" : ""),
              text: label,
              onClick: () => {
                this.user.setPrefs({ view: v });
                this.render();
              }
            })
          );
        }
        ctl.append(seg);
      }
      if (res) {
        ctl.append(
          h("button", {
            class: "btn" + (prefs.covers ? " on" : ""),
            text: "Обложки",
            title: "Показать обложки частей",
            onClick: () => {
              this.user.setPrefs({ covers: !prefs.covers });
              this.render();
            }
          })
        );
        ctl.append(
          h("button", {
            class: "btn" + (this.editing ? " on" : ""),
            text: this.editing ? "Готово" : "Править",
            title: "Поменять порядок и скрыть лишнее",
            onClick: () => {
              this.editing = !this.editing;
              this.render();
            }
          })
        );
      }
      ctl.append(h("button", { class: "btn", text: "Обновить", title: "Загрузить данные заново, без кэша", onClick: () => this.handlers.refresh() }));
      ctl.append(
        h("button", {
          class: "btn" + (this.menuOpen ? " on" : ""),
          text: "⋯",
          title: "Ещё",
          onClick: () => {
            this.menuOpen = !this.menuOpen;
            this.render();
          }
        })
      );
      if (this.menuOpen) ctl.append(this.menu(res));
      head.append(ctl);
      return head;
    }
    menu(res) {
      const close = (fn) => () => {
        this.menuOpen = false;
        fn();
        this.render();
      };
      const m = h("div", { class: "menu" });
      m.append(h("button", { text: "Экспорт отметок в файл", onClick: close(() => this.exportFile()) }));
      m.append(h("button", { text: "Импорт отметок из файла", onClick: close(() => this.importFile()) }));
      if (res && this.custom(res)) {
        m.append(
          h("button", {
            text: "Сбросить правки текущего режима",
            onClick: close(() => {
              this.user.setCustomOrder(res.orderKey, void 0);
              for (const key of res.legacyOrderKeys) this.user.setCustomOrder(key, void 0);
            })
          })
        );
      }
      m.append(h("button", { text: "Скрыть блок на этом сайте", onClick: close(() => this.handlers.hideOnSite()) }));
      return m;
    }
    summary(res) {
      const { visible } = this.arranged(res);
      const main = visible.filter((i) => i.kind === "main" && !i.continuation);
      const watched = main.filter((i) => this.user.isWatched(i.watchKey)).length;
      const current = visible.find((i) => i.isCurrent);
      const repeatedCurrent = main.filter((i) => i.isCurrent).length > 1;
      const pos = main.findIndex((i) => i.isCurrent || current?.continuation && i.alId === current.alId);
      const parts = [];
      if (repeatedCurrent) parts.push("текущий тайтл встречается в нескольких шагах");
      else if (pos >= 0 && res.mode === "anilist") parts.push(`вы здесь: ${pos + 1} из ${main.length}`);
      if (watched > 0) parts.push(`просмотрено ${watched} из ${main.length}`);
      if (this.user.prefs().collapsed) {
        const next = main.find((i, n) => n > pos && !this.user.isWatched(i.watchKey));
        if (next && pos >= 0 && !repeatedCurrent) parts.push(`дальше: ${next.title}`);
      }
      return parts.join(" · ");
    }
    modeControls(res) {
      const controls = h("div", { class: "order-modes" });
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", "Порядок просмотра");
      const chronology = this.state.status === "ready" ? selectOrder(this.state.result, "chronological") : void 0;
      for (const mode of ["recommended", "release", "chronological"]) {
        const button = h("button", {
          class: "btn" + (res.selectedMode === mode ? " on" : ""),
          text: MODE_LABELS[mode],
          title: mode === "chronological" && !chronology?.available ? chronology?.explanation : MODE_LABELS[mode],
          onClick: () => {
            this.user.setPrefs({ orderMode: mode });
            this.editing = false;
            this.render();
            this.box.querySelector(`[data-mode="${mode}"]`)?.focus();
          }
        });
        button.dataset.mode = mode;
        button.setAttribute("aria-pressed", String(res.selectedMode === mode));
        button.disabled = mode === "chronological" && !chronology?.available;
        controls.append(button);
      }
      const info = h(
        "div",
        { class: "order-info" },
        h("strong", { text: this.custom(res) ? "Порядок с вашими правками. " : res.verified ? "Проверенный маршрут. " : "" }),
        res.explanation
      );
      info.setAttribute("aria-live", "polite");
      const out = [controls, info];
      if (res.selectedMode !== "chronological" && !chronology?.available) {
        out.push(h("div", { class: "note", text: `По событиям: ${chronology?.explanation}` }));
      }
      if (res.sources.length) {
        const details = h("details", { class: "sources" });
        details.append(h("summary", { text: "Источники и пояснения" }));
        const list = h("ul");
        for (const source of res.sources) {
          if (!source.url.startsWith("https://")) continue;
          const link = h("a", { text: source.label });
          link.href = source.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          list.append(h("li", {}, link, source.detail ? h("span", { class: "meta", text: source.detail }) : void 0));
        }
        details.append(list);
        for (const limitation of res.profile?.limitations ?? []) details.append(h("p", { text: limitation }));
        out.push(details);
      }
      return out;
    }
    body(res) {
      if (this.state.status === "loading") return [h("div", { class: "state", text: "Загружаю связи франшизы…" })];
      if (this.state.status === "error") return [h("div", { class: "state", text: `Порядок не определён: ${this.state.message}` })];
      if (!res) return [];
      const out = this.modeControls(res);
      const { keys, visible, hiddenItems, custom } = this.arranged(res);
      if (visible.length === 0) {
        out.push(h("div", { class: "state", text: "Порядок не определён." }));
      } else {
        const list = h("ol");
        const visibleKeys = new Set(visible.map(rowKey));
        let n = 0;
        for (const it of visible) {
          const index = res.mode === "anilist" && it.kind === "main" && !it.continuation ? ++n : void 0;
          list.append(this.row(it, index, { keys, visibleKeys, franchise: res.orderKey, hidden: custom?.hidden ?? [] }));
        }
        out.push(list);
      }
      if (this.editing && hiddenItems.length > 0) {
        const d = h("details");
        d.open = true;
        d.append(h("summary", { text: `Скрытые (${hiddenItems.length})` }));
        const list = h("ol");
        for (const it of hiddenItems) {
          list.append(
            h(
              "li",
              {},
              h("span", { class: "title", text: it.title }),
              h("span", { class: "meta", text: [it.formatLabel, yearOf(it.date)].filter(Boolean).join(" · ") }),
              h(
                "span",
                { class: "edit" },
                h("button", {
                  class: "btn",
                  text: "Вернуть",
                  onClick: () => {
                    const hidden = (custom?.hidden ?? []).filter((k) => k !== rowKey(it) && k !== it.watchKey);
                    this.user.setCustomOrder(res.orderKey, { order: custom?.order ?? [], hidden });
                    this.render();
                  }
                })
              )
            )
          );
        }
        d.append(list);
        out.push(d);
      }
      if (res.branches.length > 0) {
        const d = h("details");
        d.open = this.user.prefs().branchesOpen;
        d.addEventListener("toggle", () => this.user.setPrefs({ branchesOpen: d.open }));
        d.append(h("summary", { text: `${res.verified ? "Вне проверенного маршрута" : "Альтернативы и прочее"} (${res.branches.length})` }));
        const list = h("ol");
        for (const it of res.branches) list.append(this.row(it, void 0));
        d.append(list);
        out.push(d);
      }
      const notes = [...res.notes];
      if (custom) notes.push("Есть ваши правки в текущем режиме. Источники описывают исходный маршрут.");
      out.push(h("div", { class: "note", text: notes.join(" ") }));
      return out;
    }
    row(it, index, edit) {
      const watched = this.user.isWatched(it.watchKey);
      const li = h("li");
      if (it.isCurrent) li.classList.add("cur");
      if (watched) li.classList.add("done");
      if (edit && it.kind !== "main") li.classList.add("side");
      li.append(
        h("button", {
          class: "mark",
          text: watched ? "✓" : it.isCurrent ? "▶︎" : it.kind === "main" ? "○" : "◇",
          title: it.episodes ? "Отметка для всего тайтла, включая все диапазоны серий" : watched ? "Снять отметку «просмотрено»" : "Отметить просмотренным",
          onClick: () => {
            this.user.setWatched(it.watchKey, !watched);
            this.render();
          }
        })
      );
      li.append(h("span", { class: "num", text: index !== void 0 ? String(index) : "" }));
      if (this.user.prefs().covers) li.append(this.cover(it));
      const url = it.match?.title.url;
      if (url && !it.isCurrent) {
        const a = h("a", { class: "title", text: it.title });
        a.href = url;
        li.append(a);
      } else {
        li.append(h("span", { class: "title", text: it.title }));
      }
      const meta = [it.formatLabel, yearOf(it.date), KIND_LABEL[it.kind], it.isCurrent ? "вы здесь" : ""].filter(Boolean).join(" · ");
      if (meta) li.append(h("span", { class: "meta", text: meta }));
      if (it.episodes) li.append(h("span", { class: "meta", text: `серии ${it.episodes}` }));
      for (const f of it.flags) li.append(h("span", { class: "warn", text: f }));
      const conf = it.match?.confidence;
      if (!it.isCurrent && it.alId !== void 0 && it.match && (conf === "name" || conf === "date")) {
        li.append(h("span", { class: "warn", text: conf === "name" ? "≈ по названию" : "≈ по дате выхода" }));
        const pair = pairKey(it.alId, it.match.title.key);
        li.append(
          h("button", {
            class: "link",
            text: "не то",
            title: "Убрать это сопоставление",
            onClick: () => {
              this.user.reject(pair);
              this.handlers.reload();
            }
          })
        );
      }
      if (!it.match) {
        const miss = h("span", { class: "miss", text: "Не найдено на сайте" });
        if (it.searchUrl) {
          const a = h("a", { text: "искать" });
          a.href = it.searchUrl;
          miss.append(" · ", a);
        }
        li.append(miss);
      }
      if (it.subtitle) li.append(h("span", { class: "sub", text: it.subtitle }));
      if (this.editing && edit) {
        const save = (order, hidden) => {
          this.user.setCustomOrder(edit.franchise, { order, hidden });
          this.render();
        };
        li.append(
          h(
            "span",
            { class: "edit" },
            h("button", { class: "btn", text: "↑", title: "Выше", onClick: () => save(move(edit.keys, rowKey(it), -1, edit.visibleKeys), edit.hidden) }),
            h("button", { class: "btn", text: "↓", title: "Ниже", onClick: () => save(move(edit.keys, rowKey(it), 1, edit.visibleKeys), edit.hidden) }),
            h("button", { class: "btn", text: "Скрыть", onClick: () => save(edit.keys, [...edit.hidden, rowKey(it)]) })
          )
        );
      }
      return li;
    }
    cover(it) {
      if (!it.cover) return h("span", { class: "cover empty" });
      const img = h("img");
      img.src = it.cover;
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      return h("button", { class: "cover", title: "Увеличить", onClick: () => this.zoom(it) }, img);
    }
    /**
     * Крупная обложка поверх всей страницы. Колесо приближает относительно центра экрана,
     * приближённую картинку можно таскать, двойной клик сбрасывает масштаб.
     * Закрытие: клик мимо картинки или Esc.
     */
    zoom(it) {
      for (const old of document.querySelectorAll("[data-awo-zoom]")) old.remove();
      const host = document.createElement("div");
      host.dataset.awoZoom = "1";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = ZOOM_CSS;
      const img = h("img");
      img.src = it.coverLarge ?? it.cover ?? "";
      img.alt = it.title;
      img.referrerPolicy = "no-referrer";
      img.draggable = false;
      const layer = h(
        "div",
        { class: "zoom" },
        img,
        h("div", { class: "cap", text: it.title }),
        h("div", { class: "hint", text: "колесо: масштаб · перетаскивание: сдвиг · двойной клик: сброс · Esc или клик мимо: закрыть" })
      );
      shadow.append(style, layer);
      let view = { scale: 1, x: 0, y: 0 };
      const apply = () => {
        img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
        img.style.cursor = view.scale > 1 ? "grab" : "zoom-in";
      };
      const root = document.documentElement;
      const prevOverflow = root.style.overflow;
      root.style.overflow = "hidden";
      const close = () => {
        host.remove();
        root.style.overflow = prevOverflow;
        document.removeEventListener("keydown", onKey, true);
      };
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        close();
      };
      layer.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          view = zoomAt(view, Math.exp(-e.deltaY * 15e-4), { x: 0, y: 0 });
          apply();
        },
        { passive: false }
      );
      let drag;
      img.addEventListener("pointerdown", (e) => {
        if (view.scale <= 1) return;
        drag = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
        img.setPointerCapture(e.pointerId);
        img.style.cursor = "grabbing";
      });
      img.addEventListener("pointermove", (e) => {
        if (!drag) return;
        view = { ...view, x: drag.x + e.clientX - drag.px, y: drag.y + e.clientY - drag.py };
        apply();
      });
      img.addEventListener("pointerup", () => {
        drag = void 0;
        apply();
      });
      img.addEventListener("dblclick", () => {
        view = { scale: 1, x: 0, y: 0 };
        apply();
      });
      layer.addEventListener("click", (e) => {
        if (!e.composedPath().includes(img)) close();
      });
      document.addEventListener("keydown", onKey, true);
      apply();
      document.documentElement.append(host);
      layer.tabIndex = -1;
      layer.focus({ preventScroll: true });
    }
    exportFile() {
      const blob = new Blob([JSON.stringify(this.user.exportData(), null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `watch-order-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1e4);
    }
    importFile() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          this.user.importData(JSON.parse(await file.text()));
          this.handlers.reload();
        } catch (e) {
          alert(`Импорт не удался: ${e instanceof Error ? e.message : "ошибка"}`);
        }
      });
      input.click();
    }
  };

  // src/orderPolicy.ts
  var FLAG_AMBIGUOUS = "порядок неоднозначен";
  var FLAG_NO_DATE = "дата неизвестна";
  function adjacency(g) {
    const adj = /* @__PURE__ */ new Map();
    const add = (a, b, rel) => {
      if (!g.nodes.has(a) || !g.nodes.has(b) || a === b) return;
      const list = adj.get(a) ?? [];
      if (!list.some((x) => x.id === b && x.rel === rel)) list.push({ id: b, rel });
      adj.set(a, list);
    };
    const inverse = {
      PREQUEL: "SEQUEL",
      SEQUEL: "PREQUEL",
      PARENT: "SIDE_STORY",
      SIDE_STORY: "PARENT",
      SUMMARY: "PARENT",
      COMPILATION: "CONTAINS",
      CONTAINS: "COMPILATION",
      ALTERNATIVE: "ALTERNATIVE",
      SPIN_OFF: "PARENT",
      OTHER: "OTHER"
    };
    for (const m of g.nodes.values()) {
      for (const e of m.edges) {
        if (e.type !== "ANIME") continue;
        add(m.id, e.id, e.rel);
        const inv = inverse[e.rel];
        if (inv) add(e.id, m.id, inv);
      }
    }
    return adj;
  }
  var byDate = (nodes) => (a, b) => dateKey(nodes.get(a)?.startDate) - dateKey(nodes.get(b)?.startDate) || a - b;
  function orderMain(ids, g, adj, flags) {
    const set = new Set(ids);
    const indeg = new Map(ids.map((id) => [id, 0]));
    const succ = /* @__PURE__ */ new Map();
    for (const id of ids) {
      for (const e of adj.get(id) ?? []) {
        if (e.rel !== "SEQUEL" || !set.has(e.id)) continue;
        const list = succ.get(id) ?? [];
        if (list.includes(e.id)) continue;
        list.push(e.id);
        succ.set(id, list);
        indeg.set(e.id, (indeg.get(e.id) ?? 0) + 1);
      }
    }
    const cmp = byDate(g.nodes);
    const ready = ids.filter((id) => indeg.get(id) === 0).sort(cmp);
    const out = [];
    while (ready.length > 0) {
      const id = ready.shift();
      out.push(id);
      for (const s of succ.get(id) ?? []) {
        const d = (indeg.get(s) ?? 0) - 1;
        indeg.set(s, d);
        if (d === 0) {
          ready.push(s);
          ready.sort(cmp);
        }
      }
    }
    if (out.length < ids.length) {
      const rest = ids.filter((id) => !out.includes(id)).sort(cmp);
      for (const id of rest) mark(flags, id, FLAG_AMBIGUOUS);
      out.push(...rest);
    }
    for (let i = 1; i < out.length; i++) {
      const a = g.nodes.get(out[i - 1])?.startDate;
      const b = g.nodes.get(out[i])?.startDate;
      if (a?.year && b?.year && dateKey(a) > dateKey(b)) {
        mark(flags, out[i - 1], FLAG_AMBIGUOUS);
        mark(flags, out[i], FLAG_AMBIGUOUS);
      }
    }
    return out;
  }
  function mark(flags, id, flag) {
    const list = flags.get(id) ?? [];
    if (!list.includes(flag)) list.push(flag);
    flags.set(id, list);
  }
  var KIND_BY_REL = {
    ALTERNATIVE: "alternative",
    SPIN_OFF: "spinoff",
    OTHER: "other",
    SUMMARY: "recap",
    COMPILATION: "recap"
  };
  var RECAP_IDS = /* @__PURE__ */ new Set([11977, 11979]);
  var RECAP_RE = /\brecap\b|soushuu|総集編|\bcompilation\b|\bdigest\b/i;
  function isRecap(m) {
    return RECAP_IDS.has(m.id) || [m.romaji, m.english, ...m.synonyms].some((t) => !!t && RECAP_RE.test(t));
  }
  function buildOrdering(g) {
    const adj = adjacency(g);
    const flags = /* @__PURE__ */ new Map();
    const root = g.nodes.get(g.rootId);
    if (!root) return { main: [], all: [], branches: [] };
    const isLine = (id) => (adj.get(id) ?? []).some((e) => e.rel === "PREQUEL" || e.rel === "SEQUEL");
    const recaps = new Set([...g.nodes.values()].filter(isRecap).map((m) => m.id));
    for (const m of g.nodes.values()) {
      for (const e of m.edges) {
        if (e.type === "ANIME" && (e.rel === "SUMMARY" || e.rel === "COMPILATION") && g.nodes.has(e.id)) recaps.add(e.id);
      }
    }
    let seed = g.rootId;
    if (recaps.has(seed) || !isLine(seed)) {
      const parent = (adj.get(seed) ?? []).find((e) => e.rel === "PARENT" && !recaps.has(e.id) && isLine(e.id));
      const original = parent ?? (recaps.has(seed) ? (adj.get(seed) ?? []).find((e) => e.rel === "ALTERNATIVE" && !recaps.has(e.id) && g.nodes.get(e.id).format === "TV" && isLine(e.id)) : void 0);
      if (original) seed = original.id;
    }
    const mainSet = /* @__PURE__ */ new Set([seed]);
    const stack = [seed];
    while (stack.length > 0) {
      const id = stack.pop();
      for (const e of adj.get(id) ?? []) {
        if ((e.rel === "PREQUEL" || e.rel === "SEQUEL") && !mainSet.has(e.id)) {
          mainSet.add(e.id);
          stack.push(e.id);
        }
      }
    }
    const lineLinks = (id) => new Set((adj.get(id) ?? []).filter((e) => mainSet.has(e.id) && !recaps.has(e.id) && (e.rel === "PREQUEL" || e.rel === "SEQUEL")).map((e) => e.id)).size;
    const preferred = [...mainSet].filter((id) => !recaps.has(id)).sort((a, b) => lineLinks(b) - lineLinks(a) || Number(g.nodes.get(b).format === "TV") - Number(g.nodes.get(a).format === "TV") || (g.nodes.get(b).episodes ?? 0) - (g.nodes.get(a).episodes ?? 0) || byDate(g.nodes)(a, b));
    const alternatives = /* @__PURE__ */ new Set();
    const selected = /* @__PURE__ */ new Set();
    for (const id of preferred) {
      if ((adj.get(id) ?? []).some((e) => e.rel === "ALTERNATIVE" && selected.has(e.id))) alternatives.add(id);
      else selected.add(id);
    }
    const removed = [...alternatives];
    while (removed.length) {
      for (const e of adj.get(removed.pop()) ?? []) {
        if (e.rel !== "SEQUEL" || !mainSet.has(e.id) || alternatives.has(e.id)) continue;
        const parents = (adj.get(e.id) ?? []).filter((p) => p.rel === "PREQUEL" && mainSet.has(p.id));
        if (parents.every((p) => alternatives.has(p.id))) {
          alternatives.add(e.id);
          removed.push(e.id);
        }
      }
    }
    for (const id of alternatives) mainSet.delete(id);
    let mainIds = orderMain([...mainSet], g, adj, flags);
    const first = mainIds.find((id) => !recaps.has(id));
    const prerequisites = first === void 0 ? [] : (adj.get(first) ?? []).filter((e) => e.rel === "ALTERNATIVE" && !mainSet.has(e.id) && !alternatives.has(e.id) && !recaps.has(e.id) && g.nodes.get(e.id).format === "TV" && dateKey(g.nodes.get(e.id).startDate) < dateKey(g.nodes.get(first).startDate)).map((e) => e.id);
    if (prerequisites.length === 1) {
      const before = /* @__PURE__ */ new Set();
      const pending = [...prerequisites];
      while (pending.length) {
        const id = pending.pop();
        if (before.has(id) || mainSet.has(id) || recaps.has(id)) continue;
        before.add(id);
        for (const e of adj.get(id) ?? []) if (e.rel === "PREQUEL") pending.push(e.id);
      }
      const ordered = orderMain([...before], g, adj, flags);
      for (const id of ordered) {
        mainSet.add(id);
        alternatives.delete(id);
        mark(flags, id, "предыстория по другой ветке");
      }
      mainIds = [...ordered, ...mainIds];
    }
    const kind = /* @__PURE__ */ new Map();
    for (const id of mainIds) kind.set(id, recaps.has(id) ? "recap" : "main");
    for (const id of alternatives) kind.set(id, "alternative");
    const queue = [...mainIds, ...alternatives];
    while (queue.length > 0) {
      const id = queue.shift();
      const parentKind = kind.get(id);
      for (const e of adj.get(id) ?? []) {
        if (kind.has(e.id)) continue;
        let k = KIND_BY_REL[e.rel] ?? (parentKind === "main" || parentKind === "recap" ? "extra" : parentKind);
        if (parentKind === "alternative" || parentKind === "spinoff" || parentKind === "other") k = parentKind;
        kind.set(e.id, k);
        queue.push(e.id);
      }
    }
    for (const id of g.nodes.keys()) if (!kind.has(id)) kind.set(id, "other");
    for (const id of recaps) kind.set(id, "recap");
    for (const [id, m] of g.nodes) if (!m.startDate.year) mark(flags, id, FLAG_NO_DATE);
    const node = (id, index) => ({
      id,
      kind: kind.get(id),
      index,
      flags: flags.get(id) ?? []
    });
    let n = 0;
    const main = mainIds.map((id) => node(id, kind.get(id) === "main" ? ++n : void 0));
    const cmp = byDate(g.nodes);
    const extras = [...g.nodes.keys()].filter((id) => !mainSet.has(id) && (kind.get(id) === "extra" || kind.get(id) === "recap")).sort(cmp);
    const all = [...main];
    for (const id of extras) {
      const k = dateKey(g.nodes.get(id)?.startDate);
      let pos = all.length;
      if (k !== Number.MAX_SAFE_INTEGER) {
        pos = 0;
        for (let i = 0; i < all.length; i++) {
          if (dateKey(g.nodes.get(all[i].id)?.startDate) <= k) pos = i + 1;
        }
      }
      all.splice(pos, 0, node(id));
    }
    const branches = [...g.nodes.keys()].filter((id) => ["alternative", "spinoff", "other"].includes(kind.get(id))).sort(cmp).map((id) => node(id));
    return { main, all, branches };
  }

  // src/watchOrder.ts
  var FORMAT_LABEL = {
    TV: "TV",
    TV_SHORT: "TV-короткометражка",
    MOVIE: "Фильм",
    SPECIAL: "Спешл",
    OVA: "OVA",
    ONA: "ONA",
    MUSIC: "Клип",
    UNKNOWN: "?"
  };
  var hasLatin = (s) => /[a-z]/i.test(s) && !/[а-яё]/i.test(s);
  async function resolveRoot(current, { anilist, ctx }) {
    if (current.anilistId) return current.anilistId;
    const r = await ctx.cache.wrap("anilist-root", current.key, 7 * DAY, async () => {
      const queries = [...new Set(current.names.filter(hasLatin))].slice(0, 3);
      for (const q of queries) {
        const hit = pickVerified(current, await anilist.search(q, ctx.signal));
        if (hit) return { id: hit.id };
      }
      return { id: null };
    }, ctx.force);
    return r.id ?? void 0;
  }
  async function loadGraph(rootId, { anilist, ctx }) {
    const raw = await ctx.cache.wrap("anilist-graph", String(rootId), 24 * HOUR, async () => {
      const g = await anilist.loadFranchise(rootId, ctx.signal);
      return { nodes: [...g.nodes.values()], truncated: g.truncated };
    }, ctx.force);
    return { rootId, nodes: new Map(raw.nodes.map((m) => [m.id, m])), truncated: raw.truncated };
  }
  function baseName(s) {
    if (!s || !hasLatin(s)) return void 0;
    const b = s.replace(/\s*\((?:tv|\d{4})\)/gi, "").split(/[:：](?=\s)/)[0].replace(/\s+(season\s*\d+|\d+(st|nd|rd|th)\s+season|part\s*\d+|movie.*|ova|[ivx]+|\d+)$/i, "").trim();
    return b.length >= 3 ? b : void 0;
  }
  async function searchFranchise(queries, done, deps, max = 2) {
    const { adapter, ctx } = deps;
    if (!adapter.search) return [];
    const out = [];
    let n = 0;
    for (const q of queries) {
      if (!q || done.has(q.toLowerCase()) || n >= max || done.size >= 12) continue;
      done.add(q.toLowerCase());
      n++;
      try {
        out.push(...await ctx.cache.wrap(`site-search:${adapter.id}`, q.toLowerCase(), 3 * DAY, () => adapter.search(q, ctx), ctx.force));
      } catch (e) {
        if (isAbort(e)) throw e;
      }
    }
    return out;
  }
  function enrich(t, byKey) {
    const s = byKey.get(t.key);
    if (!s) return t;
    return {
      ...t,
      anilistId: t.anilistId ?? s.anilistId,
      date: t.date ?? s.date,
      format: t.format ?? s.format,
      formatLabel: t.formatLabel ?? s.formatLabel,
      cover: t.cover ?? s.cover,
      names: [.../* @__PURE__ */ new Set([...t.names, ...s.names])]
    };
  }
  function indexTitles(titles) {
    const out = /* @__PURE__ */ new Map();
    for (const title of titles) out.set(title.key, enrich(title, out));
    return out;
  }
  async function searchMissing(groups, g, candidates, queried, rematch, deps) {
    for (const [group, ids] of groups.entries()) {
      const limit = group === 0 ? 9 : 12;
      for (let alias = 0; alias < 4 && queried.size < limit; alias++) {
        for (const id of ids) {
          if (queried.size >= limit) break;
          if (rematch().has(id)) continue;
          const al = g.nodes.get(id);
          const q = [al.romaji, al.english, al.synonyms.find(hasLatin), baseName(al.romaji)][alias];
          candidates.push(...await searchFranchise([q], queried, deps, 1));
        }
      }
    }
  }
  function toItem(n, g, matches, adapter) {
    const al = g.nodes.get(n.id);
    const match = matches.get(n.id);
    const title = match?.title.displayName ?? al.english ?? al.romaji;
    return {
      watchKey: `al:${n.id}`,
      alId: n.id,
      title,
      subtitle: title !== al.romaji ? al.romaji : void 0,
      format: al.format,
      formatLabel: FORMAT_LABEL[al.format],
      date: al.startDate,
      kind: n.kind,
      index: n.index,
      isCurrent: n.id === g.rootId,
      flags: [...n.flags],
      match,
      searchUrl: match ? void 0 : adapter.searchUrl(al.romaji),
      cover: al.cover?.medium ?? match?.title.cover,
      coverLarge: al.cover?.large ?? al.cover?.medium ?? match?.title.cover
    };
  }
  function siteOnly(current, related, adapter, notes) {
    const item = (t, isCurrent) => ({
      watchKey: t.anilistId ? `al:${t.anilistId}` : `site:${adapter.id}:${t.key}`,
      alId: t.anilistId,
      title: t.displayName,
      format: t.format ?? "UNKNOWN",
      formatLabel: t.formatLabel,
      date: t.date,
      kind: /обобщение|обзор|рекап/i.test(t.relationLabel ?? t.displayName) ? "recap" : "main",
      isCurrent,
      flags: isCurrent ? [] : [t.relationLabel ?? "связь"],
      match: { title: t, confidence: "site" },
      cover: t.cover,
      coverLarge: t.cover
    });
    const byDate2 = (a, b) => dateKey(a.date) - dateKey(b.date);
    const pre = related.filter((t) => t.relationKind === "prequel").sort(byDate2);
    const seq = related.filter((t) => t.relationKind === "sequel").sort(byDate2);
    const story = related.filter((t) => t.relationKind === "story" && /предыстория|продолжение|развёрнутая история|изначальная история|обобщение/i.test(t.relationLabel ?? "")).sort(byDate2);
    const rest = related.filter((t) => !pre.includes(t) && !seq.includes(t) && !story.includes(t)).sort(byDate2);
    return {
      mode: "site-only",
      franchiseKey: `site:${adapter.id}:${current.key}`,
      items: [...pre.map((t) => item(t, false)), ...story.map((t) => item(t, false)), item(current, true), ...seq.map((t) => item(t, false))],
      branches: rest.map((t) => ({ ...item(t, false), kind: "other" })),
      notes: [...notes, "Порядок собран только по связям сайта, без дат выхода: может быть неточным."]
    };
  }
  async function buildWatchOrder(key, deps) {
    const { adapter, ctx, user } = deps;
    let current = await adapter.loadCurrent(key, ctx);
    const notes = [];
    let related = [];
    try {
      const result = await adapter.loadRelated(current, ctx);
      related = result.titles.filter((t) => t.format !== "MUSIC");
      if (result.partial) notes.push("Часть связей с сайта не загрузилась, список может быть неполным.");
    } catch (e) {
      if (isAbort(e)) throw e;
      notes.push("Не удалось загрузить связи с сайта.");
    }
    const queried = /* @__PURE__ */ new Set();
    const searched = await searchFranchise(current.names.map(baseName), queried, deps);
    current = enrich(current, indexTitles(searched));
    let rootId;
    let g;
    try {
      rootId = await resolveRoot(current, deps);
      if (rootId === void 0) {
        return siteOnly(current, related, adapter, [...notes, "Тайтл не найден в AniList однозначно."]);
      }
      g = await loadGraph(rootId, deps);
      if (!g.nodes.has(rootId)) return siteOnly(current, related, adapter, [...notes, "AniList не вернул данные тайтла."]);
    } catch (e) {
      if (isAbort(e)) throw e;
      return siteOnly(current, related, adapter, [...notes, `AniList недоступен (${e instanceof Error ? e.message : "ошибка"}).`]);
    }
    if (g.truncated) notes.push("Франшиза большая: показана часть, обход упёрся в лимит.");
    const profile = profileForId(rootId);
    if (profile) {
      const ids = [...new Set([...profile.recommended.steps, ...profile.chronological?.steps ?? []].map((step) => step.alId))].filter((id) => !g.nodes.has(id));
      if (ids.length) {
        try {
          const nodes = await ctx.cache.wrap(
            `profile-nodes:${profile.id}:${profile.checkedAt}`,
            ids.join(","),
            DAY,
            () => deps.anilist.getByIds(ids, ctx.signal),
            ctx.force
          );
          for (const node of nodes) g.nodes.set(node.id, node);
        } catch (e) {
          if (isAbort(e)) throw e;
          notes.push("Не удалось загрузить все части проверенного маршрута.");
        }
      }
    }
    const root = g.nodes.get(rootId);
    const ordering = buildOrdering(g);
    const first = g.nodes.get(ordering.main[0]?.id ?? rootId);
    const queries = [baseName(first.romaji), baseName(first.english), baseName(root.romaji), baseName(root.english)];
    searched.push(...await searchFranchise(queries, queried, deps));
    const byKey = indexTitles(searched);
    const pool = [current, ...related.filter((t) => t.key !== current.key).map((t) => enrich(t, byKey))];
    const poolKeys = new Set(pool.map((t) => t.key));
    const candidates = [...pool, ...[...byKey.values()].filter((t) => !poolKeys.has(t.key))];
    const rematch = () => {
      const unique = indexTitles(candidates);
      const matches2 = matchTitles(g.nodes.values(), [...unique.values()], user.rejected());
      for (const [id, m] of matches2) if (m.confidence === "date" && !poolKeys.has(m.title.key)) matches2.delete(id);
      for (const [id, m] of matches2) if (m.title.key === current.key && id !== rootId) matches2.delete(id);
      matches2.set(rootId, { title: current, confidence: current.anilistId ? "id" : "name" });
      return matches2;
    };
    const branchIds = [...ordering.branches].sort((a, b) => Number(a.kind === "other") - Number(b.kind === "other")).map((n) => n.id);
    const preferredIds = profile?.recommended.steps.map((step) => step.alId).filter((id) => g.nodes.has(id)) ?? [];
    await searchMissing([[.../* @__PURE__ */ new Set([...preferredIds, ...ordering.all.map((n) => n.id)])], branchIds], g, candidates, queried, rematch, deps);
    const matches = rematch();
    const parts = matchParts(g.nodes.values(), matches, [...indexTitles(candidates).values()], user.rejected());
    const expand = (n) => {
      const primary = toItem(n, g, matches, adapter);
      const titles = parts.get(n.id) ?? [];
      const extra = titles.map((match) => ({
        ...primary,
        watchKey: `site:${adapter.id}:${match.title.key}`,
        title: match.title.displayName,
        subtitle: void 0,
        date: match.title.date ?? primary.date,
        index: void 0,
        continuation: true,
        isCurrent: match.title.key === current.key,
        flags: [...primary.flags, "продолжение той же записи"],
        match,
        cover: match.title.cover ?? primary.cover,
        coverLarge: match.title.cover ?? primary.coverLarge
      }));
      if (titles.length) primary.isCurrent = primary.match?.title.key === current.key;
      return [primary, ...extra];
    };
    if (ordering.main.length === 0) notes.push("Порядок не определён.");
    const used = new Set([...matches.values(), ...[...parts.values()].flat()].map((m) => m.title.key));
    const orphans = pool.filter((t) => !used.has(t.key) && t.relationKind !== "other").map((t) => ({
      watchKey: `site:${adapter.id}:${t.key}`,
      title: t.displayName,
      format: t.format ?? "UNKNOWN",
      formatLabel: t.formatLabel,
      date: t.date,
      kind: "other",
      isCurrent: false,
      flags: ["не сопоставлено с AniList"],
      match: { title: t, confidence: "site" },
      cover: t.cover,
      coverLarge: t.cover
    }));
    return {
      mode: "anilist",
      rootAlId: rootId,
      // ключ франшизы для своего порядка: самый ранний тайтл основной линии одинаков на всех её страницах
      franchiseKey: `al:${ordering.main[0]?.id ?? rootId}`,
      items: ordering.all.flatMap(expand),
      branches: [...ordering.branches.flatMap(expand), ...orphans],
      notes
    };
  }

  // src/main.ts
  function start(adapter) {
    const kv = gmKV();
    const cache = new Cache(kv);
    const user = new UserState(kv);
    const anilist = new AniListClient(withRetry(gmTransport, { retries: 2, rateLimit: { max: 25, windowMs: 6e4 } }));
    let session = null;
    const load = (s, force) => {
      if (hiddenHere()) return;
      s.ctrl.abort();
      s.ctrl = new AbortController();
      const ctx = { signal: s.ctrl.signal, cache, force };
      s.view.set({ status: "loading" });
      const timer = setTimeout(() => {
        if (session !== s || ctx.signal.aborted) return;
        s.ctrl.abort();
        s.view.set({
          status: "error",
          message: "данные не пришли за 60 секунд. Проверьте, что менеджер скриптов разрешил доступ к graphql.anilist.co, и нажмите «Обновить»."
        });
      }, 6e4);
      buildWatchOrder(s.key, { adapter, anilist, user, ctx }).finally(() => clearTimeout(timer)).then((result) => {
        if (session === s && !ctx.signal.aborted) s.view.set({ status: "ready", result });
      }).catch((e) => {
        if (isAbort(e) || ctx.signal.aborted || session !== s) return;
        console.warn("[animelib-watch-order]", e);
        s.view.set({ status: "error", message: e instanceof Error ? e.message : "ошибка загрузки" });
      });
    };
    const hiddenHere = () => user.prefs().hiddenSites[adapter.id] === true;
    const mount = () => {
      for (const other of document.querySelectorAll("[data-awo]")) {
        if (other !== session?.view.root) other.remove();
      }
      if (!session) return;
      const root = session.view.root;
      const anchor = hiddenHere() ? null : adapter.findAnchor(document);
      if (!anchor) {
        root.remove();
        return;
      }
      if (root.parentElement !== anchor.parent || root.nextElementSibling !== anchor.before) {
        anchor.parent.insertBefore(root, anchor.before);
      }
      session.view.syncTheme();
    };
    const setHidden = (hidden) => {
      const sites = { ...user.prefs().hiddenSites };
      if (hidden) sites[adapter.id] = true;
      else delete sites[adapter.id];
      user.setPrefs({ hiddenSites: sites });
      if (hidden) {
        session?.ctrl.abort();
        session?.view.root.remove();
        session = null;
      } else route(new URL(location.href));
      mount();
    };
    gmMenuCommand("Показать/скрыть «Порядок просмотра» на этом сайте", () => setHidden(!hiddenHere()));
    const route = (url) => {
      const key = adapter.pageKey(url);
      if (session?.key === key) return;
      session?.ctrl.abort();
      session?.view.root.remove();
      session = null;
      if (!key || hiddenHere()) return;
      const s = {
        key,
        ctrl: new AbortController(),
        view: new WatchOrderView(user, {
          refresh: () => load(s, true),
          reload: () => load(s, false),
          hideOnSite: () => setHidden(true)
        })
      };
      session = s;
      mount();
      load(s, false);
    };
    watchRoute(route);
    watchDom(mount);
  }
  var marker = "data-awo-active";
  if (document.documentElement.hasAttribute(marker)) {
    console.info("[animelib-watch-order] Скрипт уже запущен на этой странице.");
  } else {
    document.documentElement.setAttribute(marker, "true");
    const host = location.hostname;
    const transport = withRetry(fetchTransport, { retries: 2 });
    if (/(^|\.)animelib\.org$/.test(host)) start(createAnimeLib(transport));
    else if (/(^|\.)animego\.[a-z]+$/.test(host)) start(createAnimego(transport));
  }
})();
