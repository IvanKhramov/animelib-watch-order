// ==UserScript==
// @name         Порядок просмотра франшизы (AnimeLib, AnimeGO)
// @namespace    https://github.com/IvanKhramov/animelib-watch-order
// @homepageURL  https://github.com/IvanKhramov/animelib-watch-order
// @supportURL   https://github.com/IvanKhramov/animelib-watch-order/issues
// @updateURL    https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/dist/animelib-watch-order.user.js
// @downloadURL  https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/dist/animelib-watch-order.user.js
// @version      0.3.0
// @description  Блок «Порядок просмотра» на странице аниме: основная линия, дополнительное, альтернативы. Ссылки только на сам сайт.
// @match        https://animelib.org/*
// @match        https://animego.me/*
// @match        https://animego.org/*
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
  function withRetry(transport2, opts = {}) {
    const retries = opts.retries ?? 2;
    const base = opts.baseDelayMs ?? 800;
    const max = opts.maxDelayMs ?? 1e4;
    return async (req) => {
      let attempt = 0;
      for (; ; ) {
        if (req.signal?.aborted) throw new AbortError();
        let res;
        let err;
        try {
          res = await transport2(req);
        } catch (e) {
          if (isAbort(e)) throw e;
          err = e;
        }
        const retriable = !res || res.status === 429 || res.status >= 500;
        if (!retriable || attempt >= retries) {
          if (res) return res;
          throw err;
        }
        const hinted = res?.retryAfter !== void 0 ? res.retryAfter * 1e3 : 0;
        const delay = Math.min(max, Math.max(hinted, base * 2 ** attempt));
        attempt++;
        await sleep(delay, req.signal);
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
    constructor(transport2) {
      this.transport = transport2;
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
  var CACHE_SCHEMA = "v2";
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
      return { ...DEFAULT_PREFS, ...v && typeof v === "object" ? v : {} };
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
      for (const name of USER_KEYS) {
        const v = raw[name];
        if (v === void 0) this.kv.remove(`user:${SCHEMA}:${name}`);
        else if (typeof v === "object" && v !== null && !Array.isArray(v)) this.kv.set(`user:${SCHEMA}:${name}`, v);
        else throw new Error(`повреждено поле ${name}`);
      }
    }
  };
  var DEFAULT_PREFS = { view: "all", collapsed: false, branchesOpen: false, covers: false, hiddenSites: {} };
  var USER_KEYS = ["watched", "rejected", "prefs", "orders"];
  var EXPORT_FORMAT = "animelib-watch-order/v1";

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
  function createAnimego(transport2) {
    const limit = limiter(2);
    const loadPage = (key, ctx) => {
      const url = new URL(key, location.origin);
      if (location.pathname.replace(/\/$/, "") === key) {
        return Promise.resolve(parseAnimegoPage(document, url));
      }
      return ctx.cache.wrap("ag-page", key, 3 * DAY, async () => {
        const res = await limit(() => transport2({ url: url.href, signal: ctx.signal, headers: { Accept: "text/html" } }));
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
        const pages = await Promise.all(
          first.slice(0, 15).map((r) => loadPage(r.key, ctx).catch(() => void 0))
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
        return [...out.values()];
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
  function detectApiBase() {
    try {
      const entries = performance.getEntriesByType("resource");
      for (const e of entries) {
        const m = e.name.match(/^(https:\/\/[^/]+)\/api\/(anime|constants|auth)\b/);
        if (m) return m[1];
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
  function createAnimeLib(transport2) {
    const limit = limiter(3);
    let apiBase;
    const get = async (path, signal) => {
      apiBase ?? (apiBase = detectApiBase());
      const base = apiBase ?? FALLBACK_API;
      const headers = { Accept: "application/json", "Site-Id": SITE_ID };
      const token = readToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await limit(() => transport2({ url: `${base}/api/${path}`, headers, signal }));
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
        const found = /* @__PURE__ */ new Map();
        const seen = /* @__PURE__ */ new Set([current.key]);
        let frontier = [{ key: current.key }];
        for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
          const next = [];
          const lists = await Promise.all(
            frontier.map((f) => relations(f.key, ctx).then((r) => ({ f, r })).catch(() => ({ f, r: [] })))
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
        return [...found.values()];
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
        if (!cur || RANK2[c.confidence] > RANK2[cur[0].confidence]) m.set(k, [c]);
        else if (RANK2[c.confidence] === RANK2[cur[0].confidence]) cur.push(c);
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
.zoom{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;
  background:rgba(0,0,0,.75);cursor:zoom-out;padding:24px}
.zoom img{width:min(420px,90vw);max-height:80vh;object-fit:contain;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.6)}
.zoom div{color:#fff;font-size:14px;text-align:center;max-width:90vw}
`;
  var KIND_LABEL = {
    main: "",
    extra: "Дополнительно",
    recap: "Пересказ",
    alternative: "Альтернативная ветка",
    spinoff: "Спин-офф",
    other: "Другое"
  };
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
      return this.state.status === "ready" ? this.state.result : void 0;
    }
    /** Элементы основного списка с учётом своего порядка, скрытых и режима. */
    arranged(res) {
      const prefs = this.user.prefs();
      const custom = this.user.customOrder(res.franchiseKey);
      const byKey = new Map(res.items.map((i) => [i.watchKey, i]));
      const keys = applyOrder(res.items.map((i) => i.watchKey), custom?.order);
      const hidden = new Set(custom?.hidden ?? []);
      const all = keys.map((k) => byKey.get(k));
      const showAll = prefs.view === "all" || res.mode !== "anilist";
      const visible = all.filter((i) => !hidden.has(i.watchKey) && (showAll || i.kind === "main" || i.isCurrent));
      return { keys, all, visible, hiddenItems: all.filter((i) => hidden.has(i.watchKey)), custom };
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
      if (res && this.user.customOrder(res.franchiseKey)) {
        m.append(
          h("button", {
            text: "Сбросить свой порядок для франшизы",
            onClick: close(() => this.user.setCustomOrder(res.franchiseKey, void 0))
          })
        );
      }
      m.append(h("button", { text: "Скрыть блок на этом сайте", onClick: close(() => this.handlers.hideOnSite()) }));
      return m;
    }
    summary(res) {
      const { visible } = this.arranged(res);
      const main = visible.filter((i) => i.kind === "main");
      const watched = main.filter((i) => this.user.isWatched(i.watchKey)).length;
      const pos = main.findIndex((i) => i.isCurrent);
      const parts = [];
      if (pos >= 0 && res.mode === "anilist") parts.push(`вы здесь: ${pos + 1} из ${main.length}`);
      if (watched > 0) parts.push(`просмотрено ${watched} из ${main.length}`);
      if (this.user.prefs().collapsed) {
        const next = main.find((i, n) => n > pos && !this.user.isWatched(i.watchKey));
        if (next && pos >= 0) parts.push(`дальше: ${next.title}`);
      }
      return parts.join(" · ");
    }
    body(res) {
      if (this.state.status === "loading") return [h("div", { class: "state", text: "Загружаю связи франшизы…" })];
      if (this.state.status === "error") return [h("div", { class: "state", text: `Порядок не определён: ${this.state.message}` })];
      if (!res) return [];
      const out = [];
      const { keys, visible, hiddenItems, custom } = this.arranged(res);
      if (visible.length === 0) {
        out.push(h("div", { class: "state", text: "Порядок не определён." }));
      } else {
        const list = h("ol");
        const visibleKeys = new Set(visible.map((i) => i.watchKey));
        let n = 0;
        for (const it of visible) {
          const index = res.mode === "anilist" && it.kind === "main" ? ++n : void 0;
          list.append(this.row(it, index, { keys, visibleKeys, franchise: res.franchiseKey, hidden: custom?.hidden ?? [] }));
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
                    const hidden = (custom?.hidden ?? []).filter((k) => k !== it.watchKey);
                    this.user.setCustomOrder(res.franchiseKey, { order: custom?.order ?? [], hidden });
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
        d.append(h("summary", { text: `Альтернативы и прочее (${res.branches.length})` }));
        const list = h("ol");
        for (const it of res.branches) list.append(this.row(it, void 0));
        d.append(list);
        out.push(d);
      }
      const notes = [...res.notes];
      if (res.mode === "anilist") notes.push("Рекомендованный порядок по связям и датам выхода AniList, не каноническая хронология.");
      if (custom) notes.push("Порядок изменён вами.");
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
          title: watched ? "Снять отметку «просмотрено»" : "Отметить просмотренным",
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
            h("button", { class: "btn", text: "↑", title: "Выше", onClick: () => save(move(edit.keys, it.watchKey, -1, edit.visibleKeys), edit.hidden) }),
            h("button", { class: "btn", text: "↓", title: "Ниже", onClick: () => save(move(edit.keys, it.watchKey, 1, edit.visibleKeys), edit.hidden) }),
            h("button", { class: "btn", text: "Скрыть", onClick: () => save(edit.keys, [...edit.hidden, it.watchKey]) })
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
    /** Крупная обложка поверх страницы; закрывается кликом или Esc. */
    zoom(it) {
      const img = h("img");
      img.src = it.coverLarge ?? it.cover ?? "";
      img.alt = it.title;
      img.referrerPolicy = "no-referrer";
      const layer = h("div", { class: "zoom" }, img, h("div", { text: it.title }));
      const close = () => {
        layer.remove();
        document.removeEventListener("keydown", onKey, true);
      };
      const onKey = (e) => {
        if (e.key === "Escape") close();
      };
      layer.addEventListener("click", close);
      document.addEventListener("keydown", onKey, true);
      this.box.append(layer);
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
  var RECAP_RE = /\brecap\b|soushuu|総集編|\bcompilation\b|\bdigest\b/i;
  function isRecap(m) {
    return [m.romaji, m.english, ...m.synonyms].some((t) => !!t && RECAP_RE.test(t));
  }
  function buildOrdering(g) {
    const adj = adjacency(g);
    const flags = /* @__PURE__ */ new Map();
    const root = g.nodes.get(g.rootId);
    if (!root) return { main: [], all: [], branches: [] };
    const isLine = (id) => (adj.get(id) ?? []).some((e) => e.rel === "PREQUEL" || e.rel === "SEQUEL");
    let seed = g.rootId;
    if (!isLine(seed)) {
      const parent = (adj.get(seed) ?? []).find((e) => e.rel === "PARENT" && isLine(e.id));
      if (parent) seed = parent.id;
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
    const mainIds = orderMain([...mainSet], g, adj, flags);
    const kind = /* @__PURE__ */ new Map();
    for (const id of mainIds) kind.set(id, "main");
    const queue = [...mainIds];
    while (queue.length > 0) {
      const id = queue.shift();
      const parentKind = kind.get(id);
      for (const e of adj.get(id) ?? []) {
        if (kind.has(e.id)) continue;
        let k = KIND_BY_REL[e.rel] ?? (parentKind === "main" ? "extra" : parentKind);
        if (parentKind === "alternative" || parentKind === "spinoff" || parentKind === "other") k = parentKind;
        kind.set(e.id, k);
        queue.push(e.id);
      }
    }
    for (const id of g.nodes.keys()) if (!kind.has(id)) kind.set(id, "other");
    for (const [id, m] of g.nodes) if (!m.startDate.year) mark(flags, id, FLAG_NO_DATE);
    const node = (id, index) => ({
      id,
      kind: kind.get(id),
      index,
      flags: flags.get(id) ?? []
    });
    for (const id of mainIds) if (isRecap(g.nodes.get(id))) kind.set(id, "recap");
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
    const b = s.split(/[:：]/)[0].replace(/\s+(season\s*\d+|\d+(st|nd|rd|th)\s+season|part\s*\d+|movie.*|ova|[ivx]+|\d+)$/i, "").trim();
    return b.length >= 3 ? b : void 0;
  }
  async function searchFranchise(queries, done, deps, max = 2) {
    const { adapter, ctx } = deps;
    if (!adapter.search) return [];
    const out = [];
    let n = 0;
    for (const q of queries) {
      if (!q || done.has(q.toLowerCase()) || n >= max) continue;
      done.add(q.toLowerCase());
      n++;
      try {
        out.push(...await adapter.search(q, ctx));
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
  async function searchMissing(ids, g, matches, deps) {
    const { adapter, ctx, user } = deps;
    if (!adapter.search) return;
    const search = adapter.search.bind(adapter);
    const rejected = user.rejected();
    const taken = new Set([...matches.values()].map((m) => m.title.key));
    const run = limiter(2);
    await Promise.all(
      ids.slice(0, 10).map(
        (id) => run(async () => {
          const al = g.nodes.get(id);
          if (!al) return;
          try {
            const found = await search(al.romaji, ctx);
            const m = matchTitles([al], found.filter((t) => !taken.has(t.key)), rejected).get(id);
            if (m && m.confidence !== "date") matches.set(id, m);
          } catch (e) {
            if (isAbort(e)) throw e;
          }
        })
      )
    );
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
      kind: "main",
      isCurrent,
      flags: isCurrent ? [] : [t.relationLabel ?? "связь"],
      match: { title: t, confidence: "site" },
      cover: t.cover,
      coverLarge: t.cover
    });
    const byDate2 = (a, b) => dateKey(a.date) - dateKey(b.date);
    const pre = related.filter((t) => t.relationKind === "prequel").sort(byDate2);
    const seq = related.filter((t) => t.relationKind === "sequel").sort(byDate2);
    const rest = related.filter((t) => t.relationKind !== "prequel" && t.relationKind !== "sequel").sort(byDate2);
    return {
      mode: "site-only",
      franchiseKey: `site:${adapter.id}:${current.key}`,
      items: [...pre.map((t) => item(t, false)), item(current, true), ...seq.map((t) => item(t, false))],
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
      related = (await adapter.loadRelated(current, ctx)).filter((t) => t.format !== "MUSIC");
    } catch (e) {
      if (isAbort(e)) throw e;
      notes.push("Не удалось загрузить связи с сайта.");
    }
    const queried = /* @__PURE__ */ new Set();
    const searched = await searchFranchise(current.names.map(baseName), queried, deps);
    current = enrich(current, new Map(searched.map((t) => [t.key, t])));
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
    const root = g.nodes.get(rootId);
    const ordering = buildOrdering(g);
    const first = g.nodes.get(ordering.main[0]?.id ?? rootId);
    const queries = [baseName(first.romaji), baseName(first.english), baseName(root.romaji), baseName(root.english)];
    searched.push(...await searchFranchise(queries, queried, deps));
    const byKey = new Map(searched.map((t) => [t.key, t]));
    const pool = [current, ...related.filter((t) => t.key !== current.key).map((t) => enrich(t, byKey))];
    const poolKeys = new Set(pool.map((t) => t.key));
    const candidates = [...pool, ...[...byKey.values()].filter((t) => !poolKeys.has(t.key))];
    const matches = matchTitles(g.nodes.values(), candidates, user.rejected());
    for (const [id, m] of matches) if (m.title.key === current.key && id !== rootId) matches.delete(id);
    matches.set(rootId, { title: current, confidence: current.anilistId ? "id" : "name" });
    const unmatched = ordering.all.map((n) => n.id).filter((id) => !matches.has(id));
    await searchMissing(unmatched, g, matches, deps);
    if (ordering.main.length === 0) notes.push("Порядок не определён.");
    const used = new Set([...matches.values()].map((m) => m.title.key));
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
      // ключ франшизы для своего порядка: самый ранний тайтл основной линии одинаков на всех её страницах
      franchiseKey: `al:${ordering.main[0]?.id ?? rootId}`,
      items: ordering.all.map((n) => toItem(n, g, matches, adapter)),
      branches: [...ordering.branches.map((n) => toItem(n, g, matches, adapter)), ...orphans],
      notes
    };
  }

  // src/main.ts
  function start(adapter) {
    const kv = gmKV();
    const cache = new Cache(kv);
    const user = new UserState(kv);
    const anilist = new AniListClient(withRetry(gmTransport, { retries: 2 }));
    let session = null;
    const load = (s, force) => {
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
        if (isAbort(e) || session !== s) return;
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
      mount();
    };
    gmMenuCommand("Показать/скрыть «Порядок просмотра» на этом сайте", () => setHidden(!hiddenHere()));
    watchRoute((url) => {
      const key = adapter.pageKey(url);
      if (session?.key === key) return;
      session?.ctrl.abort();
      session?.view.root.remove();
      session = null;
      if (!key) return;
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
    });
    watchDom(mount);
  }
  var host = location.hostname;
  var transport = withRetry(fetchTransport, { retries: 2 });
  if (/(^|\.)animelib\.org$/.test(host)) start(createAnimeLib(transport));
  else if (/(^|\.)animego\.[a-z]+$/.test(host)) start(createAnimego(transport));
})();
