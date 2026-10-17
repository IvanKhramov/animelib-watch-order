// ==UserScript==
// @name         Порядок просмотра франшизы (AnimeLib, AnimeGO)
// @name:en      Anime watch order (AnimeLib, AnimeGO)
// @namespace    https://github.com/IvanKhramov/animelib-watch-order
// @homepageURL  https://github.com/IvanKhramov/animelib-watch-order
// @supportURL   https://github.com/IvanKhramov/animelib-watch-order/issues
// @updateURL    https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/dist/animelib-watch-order.user.js
// @downloadURL  https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/dist/animelib-watch-order.user.js
// @version      0.6.0
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
// @connect      raw.githubusercontent.com
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
    const id2 = num(v.id);
    if (id2 === void 0 || v.type !== "ANIME") return void 0;
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
      id: id2,
      format: toFormat(v.format),
      startDate: { year: num(sd.year), month: num(sd.month), day: num(sd.day) },
      romaji: str(title.romaji) ?? str(title.english) ?? `#${id2}`,
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
        const toFetch = [...wanted].filter((id2) => !nodes.has(id2) && !missing.has(id2)).slice(0, 50);
        if (toFetch.length > 0) {
          if (requests >= maxRequests) {
            truncated = true;
            break;
          }
          requests++;
          for (const m of await this.getByIds(toFetch, signal)) nodes.set(m.id, m);
          for (const id2 of toFetch) if (!nodes.has(id2)) missing.add(id2);
        }
        let progressed = false;
        for (const [id2, r] of [...reach]) {
          const m = nodes.get(id2);
          const done = expanded.get(id2);
          if (!m || r === "leaf" || done !== void 0 && RANK[done] >= RANK[r]) continue;
          expanded.set(id2, r);
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

  // data/community-orders.json
  var community_orders_default = {
    version: 1,
    updatedAt: "2026-10-17T20:29:45.254Z",
    sources: [
      {
        name: "r/anime",
        url: "https://www.reddit.com/r/anime/wiki/watch_order/"
      },
      {
        name: "Shikimori",
        url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
      }
    ],
    profiles: [
      {
        id: "community:hack-sign",
        title: ".hack//Sign",
        origin: "community",
        anchorIds: [
          48,
          299,
          873,
          9332
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 48,
              title: ".hack//Sign [TV]"
            },
            {
              alId: 299,
              title: ".hack//Liminality [OVA]"
            },
            {
              alId: 873,
              title: ".hack//Roots [TV]"
            },
            {
              alId: 9332,
              title: ".hack//Quantum [OVA]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — .hack//Sign: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:amagami-ss",
        title: "Amagami SS",
        origin: "community",
        anchorIds: [
          8676,
          9925,
          9117,
          11235,
          12669
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 8676,
              title: "Amagami SS [TV]"
            },
            {
              alId: 9925,
              title: "Amagami SS: Tachibana Miya-hen - Imouto [Special]"
            },
            {
              alId: 9117,
              title: "Amagami SS [OVA]",
              optional: true
            },
            {
              alId: 11235,
              title: "Amagami SS+ Plus [TV]"
            },
            {
              alId: 12669,
              title: "Amagami SS+ Plus: Extra Episode+ Plus [Special]",
              optional: true
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Amagami SS: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:amanchu",
        title: "Amanchu!",
        origin: "community",
        anchorIds: [
          21406,
          98536,
          100532
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 21406,
              title: "Amanchu! [TV]"
            },
            {
              alId: 98536,
              title: "Amanchu!: Yakusoku no Natsu to Atarashii Omoide no Koto [OVA]"
            },
            {
              alId: 100532,
              title: "Amanchu! Advance [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Amanchu!: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:ansatsu-kyoushitsu",
        title: "Ansatsu Kyoushitsu",
        origin: "community",
        anchorIds: [
          21303,
          20755,
          21170,
          21678,
          101102,
          97985
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 21303,
              title: "Ansatsu Kyoushitsu: Deai no Jikan [Special]"
            },
            {
              alId: 20755,
              title: "Ansatsu Kyoushitsu [TV]"
            },
            {
              alId: 21170,
              title: "Ansatsu Kyoushitsu 2nd Season Episode 1 [TV]",
              episodes: "1"
            },
            {
              alId: 21678,
              title: "Ansatsu Kyoushitsu 2nd Season: Kagaijugyou-hen [ONA]"
            },
            {
              alId: 21170,
              title: "Ansatsu Kyoushitsu 2nd Season Episode 2-25 [TV]",
              episodes: "2–25"
            },
            {
              alId: 101102,
              title: "Ansatsu Kyoushitsu: 365-nichi no Jikan [Movie]"
            },
            {
              alId: 97985,
              title: "Koro-sensei Quest!"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Ansatsu Kyoushitsu: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:ao-no-exorcist",
        title: "Ao no Exorcist",
        origin: "community",
        anchorIds: [
          9919,
          11737,
          11266,
          10647,
          21861,
          158931,
          176311,
          185880
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 9919,
              title: "Ao no Exorcist [TV]"
            },
            {
              alId: 11737,
              title: "Ao no Exorcist [Movie]",
              optional: true
            },
            {
              alId: 11266,
              title: "Ao no Exorcist: Kuro no Iede [Special]",
              optional: true
            },
            {
              alId: 10647,
              title: "Ao no Exorcist: Ura Ex [Special]",
              optional: true
            },
            {
              alId: 21861,
              title: "Ao no Exorcist: Kyoto Fujouou-hen [TV]"
            },
            {
              alId: 158931,
              title: "Ao no Exorcist: Shimane Illuminati-hen"
            },
            {
              alId: 176311,
              title: "Ao no Exorcist: Yuki no Hate-hen"
            },
            {
              alId: 185880,
              title: "Ao no Exorcist: Yosuga-hen"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Ao no Exorcist: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:aoki-hagane-no-arpeggio",
        title: "Aoki Hagane no Arpeggio",
        origin: "community",
        anchorIds: [
          18893,
          20763,
          20764
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 18893,
              title: "Aoki Hagane no Arpeggio: Ars Nova [TV]"
            },
            {
              alId: 20763,
              title: "Aoki Hagane no Arpeggio: Ars Nova DC [Movie]"
            },
            {
              alId: 20764,
              title: "Aoki Hagane no Arpeggio: Ars Nova Cadenza [Movie]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Aoki Hagane no Arpeggio: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:aria",
        title: "Aria",
        origin: "community",
        anchorIds: [
          477,
          5244,
          962,
          2563,
          3297,
          5196,
          21043,
          117556,
          130558
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 477,
              title: "Aria the Animation (TV)"
            },
            {
              alId: 5244,
              title: "Aria the Natural: Sono Futatabi Deaeru Kiseki ni... (Optional 5 Mins)",
              optional: true
            },
            {
              alId: 962,
              title: "Aria the Natural (TV)"
            },
            {
              alId: 2563,
              title: "Aria the OVA: Arietta (OVA)"
            },
            {
              alId: 3297,
              title: "Aria the Origination (TV)"
            },
            {
              alId: 5196,
              title: "Aria the Origination Picture Drama (Optional. Slideshow with narrations)",
              optional: true
            },
            {
              alId: 21043,
              title: "Aria the Avvenire (Special)"
            },
            {
              alId: 117556,
              title: "Aria the Crepuscolo (Movie)"
            },
            {
              alId: 130558,
              title: "Aria the Benedizione"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Aria: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:attack-on-titan",
        title: "Attack on Titan",
        origin: "community",
        anchorIds: [
          16498,
          18397,
          20811,
          20958,
          99634,
          99147,
          104578,
          110277,
          131681,
          146984
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 16498,
              title: "Attack on Titan [TV]"
            },
            {
              alId: 18397,
              title: "Attack on Titan [OVA]"
            },
            {
              alId: 20811,
              title: "Attack on Titan: No Regrets [OVA]"
            },
            {
              alId: 20958,
              title: "Attack on Titan Season 2 [TV]"
            },
            {
              alId: 99634,
              title: "Attack on Titan: Lost Girls Episodes 1-2 [OVA]",
              episodes: "1–2"
            },
            {
              alId: 99147,
              title: "Attack on Titan Season 3 [TV]"
            },
            {
              alId: 99634,
              title: "Attack on Titan: Lost Girls Episode 3 [OVA]",
              episodes: "3"
            },
            {
              alId: 104578,
              title: "Attack on Titan Season 3 Part 2 [TV]"
            },
            {
              alId: 110277,
              title: "Attack on Titan Final Season [TV]"
            },
            {
              alId: 131681,
              title: "Attack on Titan Final Season Part 2 [TV]"
            },
            {
              alId: 146984,
              title: "Attack on Titan Final Season Part 3 [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Attack on Titan: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:baka-to-test",
        title: "Baka to Test",
        origin: "community",
        anchorIds: [
          6347,
          9471,
          8516
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 6347,
              title: "Baka to Test to Shoukanjuu [TV]"
            },
            {
              alId: 9471,
              title: "Baka to Test to Shoukanjuu: Matsuri [OVA]"
            },
            {
              alId: 8516,
              title: "Baka to Test to Shoukanjuu Ni! [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Baka to Test: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:baki",
        title: "Baki",
        origin: "community",
        anchorIds: [
          287,
          1859,
          551,
          97888,
          108522,
          124195
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 287,
              title: "Grappler Baki Episodes 1-16 [TV]",
              episodes: "1–16"
            },
            {
              alId: 1859,
              title: "Grappler Baki [OVA]"
            },
            {
              alId: 287,
              title: "Grappler Baki Episodes 17-24 [TV]",
              episodes: "17–24"
            },
            {
              alId: 551,
              title: "Grappler Baki: Saidai Tournament-hen [TV])"
            },
            {
              alId: 97888,
              title: "Baki [ONA]"
            },
            {
              alId: 108522,
              title: "Baki: Dai Raitaisai-hen [ONA]"
            },
            {
              alId: 124195,
              title: "Hanma Baki: Son of Ogre"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Baki: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:bang-dream",
        title: "BanG Dream!",
        origin: "community",
        anchorIds: [
          87435,
          101633,
          101634
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 87435,
              title: "BanG Dream! [TV]"
            },
            {
              alId: 101633,
              title: "BanG Dream! 2nd Season [TV]"
            },
            {
              alId: 101634,
              title: "BanG Dream! 3rd Season [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — BanG Dream!: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:berserk",
        title: "Berserk",
        origin: "community",
        anchorIds: [
          33,
          21560,
          97643
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 33,
              title: "Berserk (1997)"
            },
            {
              alId: 21560,
              title: "Berserk (2016)"
            },
            {
              alId: 97643,
              title: "Berserk (2017)"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Berserk: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:beyblade",
        title: "Beyblade",
        origin: "community",
        anchorIds: [
          288,
          1669,
          1670,
          1668,
          5962,
          8410,
          8245,
          10370,
          13231,
          136110
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 288,
              title: "Beyblade [TV]"
            },
            {
              alId: 1669,
              title: "Beyblade V-Force [TV]"
            },
            {
              alId: 1670,
              title: "Beyblade the Movie: Decisive battle! Takao VS Daichi [Movie]"
            },
            {
              alId: 1668,
              title: "Beyblade G Revolution [TV]"
            },
            {
              alId: 5962,
              title: "Metal Fight Beyblade [TV]"
            },
            {
              alId: 8410,
              title: "Beyblade: Metal Masters [TV]"
            },
            {
              alId: 8245,
              title: "Metal Fight Beyblade vs. Taiyou: Shakunetsu no Shinryakusha Sol Blaze [Movie]"
            },
            {
              alId: 10370,
              title: "Beyblade: Metal Fury [TV]"
            },
            {
              alId: 13231,
              title: "Beyblade: Shogun Steel [TV]"
            },
            {
              alId: 136110,
              title: "Metal Fight Beyblade Zero G [Special]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Beyblade: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:birdy-the-mighty",
        title: "Birdy the Mighty",
        origin: "community",
        anchorIds: [
          3974,
          6380,
          5074
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 3974,
              title: "Birdy the Mighty: Decode [TV]"
            },
            {
              alId: 6380,
              title: "Birdy the Mighty: Decode [OVA]"
            },
            {
              alId: 5074,
              title: "Birdy the Mighty: Decode 02 [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Birdy the Mighty: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:black-jack",
        title: "Black Jack",
        origin: "community",
        anchorIds: [
          2213,
          4071,
          2214,
          1983,
          1521,
          1520,
          21187
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 2213,
              title: "Black Jack [TV]"
            },
            {
              alId: 4071,
              title: "Black Jack (TV): Hizouban [Special]"
            },
            {
              alId: 2214,
              title: "Black Jack 21 [TV]"
            },
            {
              alId: 1983,
              title: "Black Jack: Futari no Kuroi Isha [Movie]",
              optional: true
            },
            {
              alId: 1521,
              title: "Black Jack the Movie",
              optional: true
            },
            {
              alId: 1520,
              title: "Black Jack [OVA]"
            },
            {
              alId: 21187,
              title: "Young Black Jack [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Black Jack: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:black-rock-shooter",
        title: "Black Rock Shooter",
        origin: "community",
        anchorIds: [
          11285,
          7059
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 11285,
              title: "Black Rock Shooter [TV]"
            },
            {
              alId: 7059,
              title: "Black★Rock Shooter [OVA]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Black Rock Shooter: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:boku-wa-tomodachi-ga-sukunai",
        title: "Boku wa Tomodachi ga Sukunai",
        origin: "community",
        anchorIds: [
          10719,
          14027,
          14967
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 10719,
              title: "Boku wa Tomodachi ga Sukunai [TV]"
            },
            {
              alId: 14027,
              title: "Boku wa Tomodachi ga Sukunai: Relay Shousetsu wa Ketsumatsu ga Hanpanai [OVA]"
            },
            {
              alId: 14967,
              title: "Boku wa Tomodachi ga Sukunai Next [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Boku wa Tomodachi ga Sukunai: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:candy-boy",
        title: "Candy☆Boy",
        origin: "community",
        anchorIds: [
          5116,
          3456,
          4535,
          6479
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 5116,
              title: "Candy☆Boy Episode: EX01 - Mirai Yohouzu [OVA]"
            },
            {
              alId: 3456,
              title: "Candy☆Boy: Side Story For Archive [ONA]"
            },
            {
              alId: 4535,
              title: "Candy☆Boy: Nonchalant Talk of the Certain Twin Sisters in Daily Life [ONA]"
            },
            {
              alId: 6479,
              title: "Candy☆Boy Episode: EX02 - Shiawase Kyouyuu Riron [Special]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Candy☆Boy: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:captain-harlock",
        title: "Captain Harlock",
        origin: "community",
        anchorIds: [
          1e3,
          2470,
          2202,
          2203,
          1645,
          1706,
          1081,
          17269
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 1e3,
              title: "Space Pirate Captain Harlock Episodes 1-13 [TV]",
              episodes: "1–13"
            },
            {
              alId: 2470,
              title: "Space Pirate Captain Harlock: Riddle of the Arcadia Episode [Movie]"
            },
            {
              alId: 1e3,
              title: "Space Pirate Captain Harlock Episodes 14-42 [TV]",
              episodes: "14–42"
            },
            {
              alId: 2202,
              title: "Waga Seishun no Arcadia [Movie]"
            },
            {
              alId: 2203,
              title: "Endless Orbit SSX [TV]"
            },
            {
              alId: 1645,
              title: "Harlock Saga: The Ring of the Nibelung - The Rhein Gold [OVA]"
            },
            {
              alId: 1706,
              title: "Gun Frontier [TV]"
            },
            {
              alId: 1081,
              title: "Space Pirate Captain Herlock: Outside Legend - The Endless Odyssey [OVA]"
            },
            {
              alId: 17269,
              title: "Space Pirate Captain Harlock [Movie]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Captain Harlock: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:cardcaptor-sakura",
        title: "Cardcaptor Sakura",
        origin: "community",
        anchorIds: [
          232,
          371,
          372,
          2424,
          98554,
          97881
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 232,
              title: "Cardcaptor Sakura Episodes 1-46 [TV]",
              episodes: "1–46"
            },
            {
              alId: 371,
              title: "Cardcaptor Sakura The Movie"
            },
            {
              alId: 232,
              title: "Cardcaptor Sakura Episodes 47-70 [TV]",
              episodes: "47–70"
            },
            {
              alId: 372,
              title: "CardCaptor Sakura Movie 2: The Sealed Card"
            },
            {
              alId: 2424,
              title: "Cardcaptor Sakura Specials"
            },
            {
              alId: 98554,
              title: "Cardcaptor Sakura: Clear Card-hen Prologue [OVA]"
            },
            {
              alId: 97881,
              title: "Cardcaptor Sakura: Clear Card [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Option 1 Chronologically by Release Date.",
          sources: [
            {
              label: "r/anime — Cardcaptor Sakura: Option 1 Chronologically by Release Date",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 232,
              title: "Cardcaptor Sakura Episodes 1-35 [TV]",
              episodes: "1–35"
            },
            {
              alId: 371,
              title: "Cardcaptor Sakura The Movie"
            },
            {
              alId: 232,
              title: "Cardcaptor Sakura Episodes 36-70 [TV]",
              episodes: "36–70"
            },
            {
              alId: 372,
              title: "CardCaptor Sakura Movie 2: The Sealed Card"
            },
            {
              alId: 2424,
              title: "Cardcaptor Sakura Specials"
            },
            {
              alId: 98554,
              title: "Cardcaptor Sakura: Clear Card-hen Prologue [OVA]"
            },
            {
              alId: 97881,
              title: "Cardcaptor Sakura: Clear Card [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Option 2 Chronologically by Series Timeline.",
          sources: [
            {
              label: "r/anime — Cardcaptor Sakura: Option 2 Chronologically by Series Timeline",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:chainsaw-man",
        title: "Chainsaw Man",
        origin: "community",
        anchorIds: [
          127230,
          171627
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 127230,
              title: "Chainsaw Man Season 1"
            },
            {
              alId: 171627,
              title: "Chainsaw Man Movie: Reze"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Chainsaw Man: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:chuunibyou",
        title: "Chuunibyou",
        origin: "community",
        anchorIds: [
          14741,
          15687,
          16934,
          19021,
          18671,
          20582,
          20889,
          98762
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 14741,
              title: "Chuunibyou demo Koi ga Shitai! [TV]"
            },
            {
              alId: 15687,
              title: "Chuunibyou demo Koi ga Shitai! Lite [ONA]",
              optional: true
            },
            {
              alId: 16934,
              title: "Chuunibyou demo Koi ga Shitai!: Kirameki no... Slapstick Noel [OVA]"
            },
            {
              alId: 19021,
              title: "Takanashi Rikka Kai: Chuunibyou demo Koi ga Shitai! Movie",
              optional: true
            },
            {
              alId: 18671,
              title: "Chuunibyou demo Koi ga Shitai! Ren [TV]"
            },
            {
              alId: 20582,
              title: "Chuunibyou demo Koi ga Shitai! Ren Lite",
              optional: true
            },
            {
              alId: 20889,
              title: "Chuunibyou demo Koi ga Shitai! Ren: The Rikka Wars [Special]"
            },
            {
              alId: 98762,
              title: "Chuunibyou demo Koi ga Shitai! Movie: Take On Me [Movie]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Chuunibyou: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:clannad",
        title: "Clannad",
        origin: "community",
        anchorIds: [
          2167,
          6351,
          4059,
          4181,
          1723
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 2167,
              title: "Clannad [TV]"
            },
            {
              alId: 6351,
              title: "Clannad : Another World, Kyou Chapter [Special]"
            },
            {
              alId: 4059,
              title: "Clannad: Another World, Tomoyo Chapter [Special]"
            },
            {
              alId: 4181,
              title: "Clannad: Afterstory [TV]"
            },
            {
              alId: 1723,
              title: "Clannad The Motion Picture [Movie]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Clannad: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:cowboy-bebop",
        title: "Cowboy Bebop",
        origin: "community",
        anchorIds: [
          1,
          5
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 1,
              title: "Cowboy Bebop Episodes 1-22 [TV]",
              episodes: "1–22"
            },
            {
              alId: 5,
              title: "Cowboy Bebop: The Movie"
            },
            {
              alId: 1,
              title: "Cowboy Bebop Episodes 23-26",
              episodes: "23–26"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Cowboy Bebop: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:crest-of-the-stars",
        title: "Crest of the Stars",
        origin: "community",
        anchorIds: [
          290,
          1124,
          396,
          397,
          398
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 290,
              title: "Crest of the Stars [TV])"
            },
            {
              alId: 1124,
              title: "Crest of the Stars: Birth [Special]",
              optional: true
            },
            {
              alId: 396,
              title: "Banner of the Stars [TV]"
            },
            {
              alId: 397,
              title: "Banner of the Stars II"
            },
            {
              alId: 398,
              title: "Banner of the Stars III"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Crest of the Stars: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:danmachi",
        title: "DanMachi",
        origin: "community",
        anchorIds: [
          20920,
          21660,
          21676,
          101166,
          101167,
          112125,
          112124,
          127368,
          129196
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20920,
              title: "Danmachi Season 1 [TV]"
            },
            {
              alId: 21660,
              title: "Danmachi Season 1 [OVA]",
              optional: true
            },
            {
              alId: 21676,
              title: "Sword Oratoria Season 1 [TV]"
            },
            {
              alId: 101166,
              title: "Danmachi : Arrow of the Orion [Movie]",
              optional: true
            },
            {
              alId: 101167,
              title: "Danmachi Season 2 [TV]"
            },
            {
              alId: 112125,
              title: "Danmachi Season 2 [OVA]",
              optional: true
            },
            {
              alId: 112124,
              title: "Danmachi Season 3 [TV]"
            },
            {
              alId: 127368,
              title: "Danmachi Season 3 [OVA]",
              optional: true
            },
            {
              alId: 129196,
              title: "Danmachi Season 4 [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — DanMachi: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:darker-than-black",
        title: "Darker than Black",
        origin: "community",
        anchorIds: [
          2025,
          4182,
          7338,
          6573
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 2025,
              title: "Darker than Black [TV]"
            },
            {
              alId: 4182,
              title: "Darker than Black: Kuro no Keiyakusha [Special]"
            },
            {
              alId: 7338,
              title: "Darker than Black: Ryuusei no Gemini [Special]"
            },
            {
              alId: 6573,
              title: "Darker than Black: Ryuusei no Gemini [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Darker than Black: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:date-a-live",
        title: "Date A Live",
        origin: "community",
        anchorIds: [
          15583,
          17641,
          19163,
          20767,
          20741,
          100722,
          116605
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 15583,
              title: "Date A Live [TV]"
            },
            {
              alId: 17641,
              title: "Date A Live: Date to Date [OVA]"
            },
            {
              alId: 19163,
              title: "Date A Live II [TV]"
            },
            {
              alId: 20767,
              title: "Date A Live II: Kurumi Star Festival [OVA]"
            },
            {
              alId: 20741,
              title: "Date A Live Movie: Mayuri Judgement [Movie]"
            },
            {
              alId: 100722,
              title: "Date A Live III [TV]"
            },
            {
              alId: 116605,
              title: "Date A Live IV [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Date A Live: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:diamond-no-ace",
        title: "Diamond no Ace",
        origin: "community",
        anchorIds: [
          18689,
          20861,
          21085,
          98582,
          105749
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 18689,
              title: "Diamond no Ace [TV]"
            },
            {
              alId: 20861,
              title: "Diamond no Ace OVA"
            },
            {
              alId: 21085,
              title: "Diamond no Ace: Second Season [TV]"
            },
            {
              alId: 98582,
              title: "Diamond no Ace: Second Season OVA"
            },
            {
              alId: 105749,
              title: "Diamond no Ace: Act II [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Diamond no Ace: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:ef-a-tale-of-memories",
        title: "ef: A Tale of Memories",
        origin: "community",
        anchorIds: [
          2924,
          4789
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 2924,
              title: "ef: A Tale of Memories"
            },
            {
              alId: 4789,
              title: "ef: A Tale of Melodies"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — ef: A Tale of Memories: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:free",
        title: "Free!",
        origin: "community",
        anchorIds: [
          18507,
          20614,
          21158,
          98497,
          101117,
          107203
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 18507,
              title: "Free!"
            },
            {
              alId: 20614,
              title: "Free!: Eternal Summer"
            },
            {
              alId: 21158,
              title: "High☆Speed!: Free! Starting Days"
            },
            {
              alId: 98497,
              title: "Free!: Take Your Marks"
            },
            {
              alId: 101117,
              title: "Free!: Dive to the Future"
            },
            {
              alId: 107203,
              title: "Free!: Final Stroke Part 1 and 2"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Free!: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:flcl",
        title: "FLCL",
        origin: "community",
        anchorIds: [
          227,
          21746,
          21748,
          146472,
          146473
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 227,
              title: "FLCL"
            },
            {
              alId: 21746,
              title: "FLCL Progressive"
            },
            {
              alId: 21748,
              title: "FLCL Alternative"
            },
            {
              alId: 146472,
              title: "FLCL: Grunge"
            },
            {
              alId: 146473,
              title: "FLCL: Shoegaze"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — FLCL: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:garo",
        title: "Garo",
        origin: "community",
        anchorIds: [
          20753,
          102098,
          21426
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20753,
              title: "Garo: Honoo no Kokuin"
            },
            {
              alId: 102098,
              title: "Garo: Honoo no Kokuin - Home"
            },
            {
              alId: 21426,
              title: "Garo Movie: Divine Flame"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Garo: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:genshiken",
        title: "Genshiken",
        origin: "community",
        anchorIds: [
          240,
          1813,
          2508,
          19159,
          18465
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 240,
              title: "Genshiken"
            },
            {
              alId: 1813,
              title: "Genshiken OVA"
            },
            {
              alId: 2508,
              title: "Genshiken 2"
            },
            {
              alId: 19159,
              title: "Genshiken Nidaime OVA"
            },
            {
              alId: 18465,
              title: "Genshiken Nidaime (Genshiken Second Season)"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Genshiken: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:girls-und-panzer",
        title: "Girls und Panzer",
        origin: "community",
        anchorIds: [
          14131,
          15811,
          18619,
          18617,
          21649,
          99938,
          107208,
          114052,
          124115,
          144803,
          132420,
          176663,
          130362
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 14131,
              title: "Girls und Panzer"
            },
            {
              alId: 15811,
              title: "Girls und Panzer Specials",
              optional: true
            },
            {
              alId: 18619,
              title: "Girls & Panzer: This is the Real Anzio Battle!"
            },
            {
              alId: 18617,
              title: "Girls und Panzer der Film"
            },
            {
              alId: 21649,
              title: "Girls und Panzer der Film OVA"
            },
            {
              alId: 99938,
              title: "Girls und Panzer das Finale Part 1"
            },
            {
              alId: 107208,
              title: "Girls und Panzer das Finale Part 2"
            },
            {
              alId: 114052,
              title: "Girls und Panzer: Taiyaki War!"
            },
            {
              alId: 124115,
              title: "Girls und Panzer das Finale – Part 3"
            },
            {
              alId: 144803,
              title: "Girls und Panzer: Daikon War!"
            },
            {
              alId: 132420,
              title: "Girls und Panzer das Finale - Part 4"
            },
            {
              alId: 176663,
              title: "Girls und Panzer: Taichou War!"
            },
            {
              alId: 130362,
              title: "Yukari's Tank Corner",
              optional: true
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Girls und Panzer: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:grimoire-of-zero",
        title: "Grimoire of Zero",
        origin: "community",
        anchorIds: [
          97682,
          133175
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 97682,
              title: "Grimoire of Zero"
            },
            {
              alId: 133175,
              title: "The Dawn of the Witch"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Grimoire of Zero: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:grisaia",
        title: "Grisaia",
        origin: "community",
        anchorIds: [
          17729,
          21005,
          21006,
          99470
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 17729,
              title: "Kajitsu"
            },
            {
              alId: 21005,
              title: "Meikyuu"
            },
            {
              alId: 21006,
              title: "Rakuen"
            },
            {
              alId: 99470,
              title: "Phantom Trigger"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Grisaia: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:hajime-no-ippo",
        title: "Hajime no Ippo",
        origin: "community",
        anchorIds: [
          263,
          12069,
          264,
          265,
          5258,
          19647
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 263,
              title: "Hajime no Ippo (Fighting Spirit)"
            },
            {
              alId: 12069,
              title: "Hajime no Ippo Special"
            },
            {
              alId: 264,
              title: "Hajime no Ippo: Champion Road"
            },
            {
              alId: 265,
              title: "Hajime no Ippo: Mashiba vs. Kimura"
            },
            {
              alId: 5258,
              title: "Hajime no Ippo: New Challenger"
            },
            {
              alId: 19647,
              title: "Hajime no Ippo: Rising"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Hajime no Ippo: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:haikyuu",
        title: "Haikyuu!!",
        origin: "community",
        anchorIds: [
          20464,
          20884,
          20992,
          21348,
          21698,
          111790,
          106625,
          113538
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20464,
              title: "Haikyuu!!"
            },
            {
              alId: 20884,
              title: "Haikyuu!!: Lev Genzan! (OVA)"
            },
            {
              alId: 20992,
              title: "Haikyuu!! Second Season"
            },
            {
              alId: 21348,
              title: 'Haikyuu!!: vs "Akaten" (OVA)'
            },
            {
              alId: 21698,
              title: "Haikyuu!!: Karasuno Koukou VS Shiratorizawa Gakuen Koukou"
            },
            {
              alId: 111790,
              title: "Haikyuu!!: Riku vs. Kuu"
            },
            {
              alId: 106625,
              title: "Haikyuu!!: To the Top"
            },
            {
              alId: 113538,
              title: "Haikyuu!!: To the Top 2nd Season"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Haikyuu!!: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:haiyore-nyaruko-san",
        title: "Haiyore! Nyaruko-san",
        origin: "community",
        anchorIds: [
          11785,
          15699,
          20824
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 11785,
              title: "Haiyore! Nyaruko-san"
            },
            {
              alId: 15699,
              title: "Haiyore! Nyaruko-san W"
            },
            {
              alId: 20824,
              title: "Haiyore! Nyaruko-san F"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Haiyore! Nyaruko-san: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:hen-zemi",
        title: "Hen Zemi",
        origin: "community",
        anchorIds: [
          8101,
          10187
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 8101,
              title: "Hen Zemi OVA"
            },
            {
              alId: 10187,
              title: "Hen Zemi (TV)"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Hen Zemi: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:hidamari-sketch",
        title: "Hidamari Sketch",
        origin: "community",
        anchorIds: [
          1852,
          3165,
          3604,
          6984,
          7062,
          9563,
          11237,
          11239,
          17739
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 1852,
              title: "Hidamari Sketch"
            },
            {
              alId: 3165,
              title: "Hidamari Sketch Specials"
            },
            {
              alId: 3604,
              title: "Hidamari Sketch x 365"
            },
            {
              alId: 6984,
              title: "365 Specials"
            },
            {
              alId: 7062,
              title: "Hidamari Sketch x ☆☆☆"
            },
            {
              alId: 9563,
              title: "☆☆☆ Specials"
            },
            {
              alId: 11237,
              title: "Hidamari Sketch x SP"
            },
            {
              alId: 11239,
              title: "Hidamari Sketch x Honeycomb"
            },
            {
              alId: 17739,
              title: "Hidamari Sketch: Sae Hiro Sotsugyou-hen"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Hidamari Sketch: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:higurashi-no-naku-koro-ni",
        title: "Higurashi no Naku Koro ni",
        origin: "community",
        anchorIds: [
          934,
          2899,
          1889,
          3652,
          10491,
          16700,
          114446,
          131149
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 934,
              title: "Higurashi no Naku Koro ni"
            },
            {
              alId: 2899,
              title: "Higurashi no Naku Koro ni Spe­cial: Nekogoroshi-hen",
              optional: true
            },
            {
              alId: 1889,
              title: "Higur­ashi no Naku Koro ni Kai"
            },
            {
              alId: 3652,
              title: "Higurashi no Naku Koro ni Rei",
              optional: true
            },
            {
              alId: 10491,
              title: "Higur­ashi no Naku Koro ni Kira",
              optional: true
            },
            {
              alId: 16700,
              title: "Higurashi no Naku Koro ni Kaku: Outbreak",
              optional: true
            },
            {
              alId: 114446,
              title: "Higurashi no Naku Koro ni Gou"
            },
            {
              alId: 131149,
              title: "Higurashi no Naku Koro ni Sotsu"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Higurashi no Naku Koro ni: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:hunter-x-hunter",
        title: "Hunter X Hunter",
        origin: "community",
        anchorIds: [
          136,
          137,
          138
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 136,
              title: "Hunter X Hunter (1999)"
            },
            {
              alId: 137,
              title: "OVA"
            },
            {
              alId: 138,
              title: "Hunter x Hunter: Greed Island"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Hunter X Hunter: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:inuyasha",
        title: "Inuyasha",
        origin: "community",
        anchorIds: [
          249,
          6811
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 249,
              title: "Inuyasha"
            },
            {
              alId: 6811,
              title: "InuYasha: Kanketsu-hen"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Inuyasha: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:initial-d",
        title: "Initial D",
        origin: "community",
        anchorIds: [
          185,
          186,
          187,
          18,
          15059,
          19613
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 185,
              title: "First stage"
            },
            {
              alId: 186,
              title: "Second Stage"
            },
            {
              alId: 187,
              title: "Third stage"
            },
            {
              alId: 18,
              title: "Fourth Stage"
            },
            {
              alId: 15059,
              title: "Fifth stage"
            },
            {
              alId: 19613,
              title: "Final Stage"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Initial D: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:jaku-chara-tomozaki-kun",
        title: "Jaku-Chara Tomozaki-kun",
        origin: "community",
        anchorIds: [
          112443,
          127363,
          143866
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 112443,
              title: "Jaku-Chara Tomozaki-kun [TV]"
            },
            {
              alId: 127363,
              title: "Jaku-Chara Tomozaki-kun Specials",
              optional: true
            },
            {
              alId: 143866,
              title: "Jaku-Chara Tomozaki-kun 2nd Stage [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Jaku-Chara Tomozaki-kun: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:jujutsu-kaisen",
        title: "Jujutsu Kaisen",
        origin: "community",
        anchorIds: [
          113415,
          131573,
          145064,
          172463,
          209895
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 113415,
              title: "Jujutsu Kaisen"
            },
            {
              alId: 131573,
              title: "Jujutsu Kaisen 0"
            },
            {
              alId: 145064,
              title: "Jujutsu Kaisen Season 2"
            },
            {
              alId: 172463,
              title: "Jujutsu Kaisen: The Culling Game Part 1"
            },
            {
              alId: 209895,
              title: "Jujutsu Kaisen: The Culling Game Part 2"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Jujutsu Kaisen: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:kaguya-sama-love-is-war",
        title: "Kaguya-sama: Love is War",
        origin: "community",
        anchorIds: [
          101921,
          112641,
          125368,
          165557,
          125367,
          151384
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 101921,
              title: "Kaguya-sama: Love is War"
            },
            {
              alId: 112641,
              title: "Kaguya-sama: Love is War Season 2"
            },
            {
              alId: 125368,
              title: "Kaguya-sama: Love is War OVA"
            },
            {
              alId: 165557,
              title: 'Kaguya-sama: Love is War - Ultra Romantic "Yu Ishigami Wants to Chat" (ONA)'
            },
            {
              alId: 125367,
              title: "Kaguya-sama: Love is War - Ultra Romantic (S3)"
            },
            {
              alId: 151384,
              title: "Kaguya-sama: Love is War - The First Kiss That Never Ends (Movie)"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Kaguya-sama: Love is War: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:k-on",
        title: "K-On",
        origin: "community",
        anchorIds: [
          5680,
          6862,
          7791,
          9734,
          9617
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 5680,
              title: "K-On!"
            },
            {
              alId: 6862,
              title: "K-On! Live House"
            },
            {
              alId: 7791,
              title: "K-On!!"
            },
            {
              alId: 9734,
              title: "K-On!!: Keikaku!"
            },
            {
              alId: 9617,
              title: "K-On! Movie"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — K-On: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:kara-no-kyoukai",
        title: "Kara no Kyoukai",
        origin: "community",
        anchorIds: [
          2593,
          3782,
          3783,
          4280,
          4282,
          5204,
          6624,
          5205,
          6954,
          14807,
          20697
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 2593,
              title: "Kara no Kyoukai 1"
            },
            {
              alId: 3782,
              title: "Kara no Kyoukai 2"
            },
            {
              alId: 3783,
              title: "Kara no Kyoukai 3"
            },
            {
              alId: 4280,
              title: "Kara no Kyoukai 4"
            },
            {
              alId: 4282,
              title: "Kara no Kyoukai 5"
            },
            {
              alId: 5204,
              title: "Kara no Kyoukai 6"
            },
            {
              alId: 6624,
              title: "Kara no Kyoukai Remix: Gate of Seventh Heaven (RECAP)(Optional)",
              optional: true
            },
            {
              alId: 5205,
              title: "Kara no Kyoukai 7"
            },
            {
              alId: 6954,
              title: "Kara no Kyoukai: Epilogue"
            },
            {
              alId: 14807,
              title: "Kara no Kyoukai: Mirai Fukuin(optional)",
              optional: true
            },
            {
              alId: 20697,
              title: "Kara no Kyoukai: Mirai Fukuin - Extra Chorus"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Kara no Kyoukai: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:kyoukai-no-kanata",
        title: "Kyoukai no Kanata",
        origin: "community",
        anchorIds: [
          18153,
          20779,
          20768,
          20963
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 18153,
              title: "Kyoukai no Kanata"
            },
            {
              alId: 20779,
              title: "Shinonome",
              optional: true
            },
            {
              alId: 20768,
              title: "Kako-Hen",
              optional: true
            },
            {
              alId: 20963,
              title: "Mirai-Hen"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Kyoukai no Kanata: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:kyousougiga",
        title: "Kyousougiga",
        origin: "community",
        anchorIds: [
          19703,
          10893,
          15359
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 19703,
              title: "Kyousougiga (TV)"
            },
            {
              alId: 10893,
              title: "Kyousougiga OVA (OPTIONAL)",
              optional: true
            },
            {
              alId: 15359,
              title: "Kyousougiga ONA (2012) (OPTIONAL)",
              optional: true
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Kyousougiga: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:little-witch-academia",
        title: "Little Witch Academia",
        origin: "community",
        anchorIds: [
          14349,
          19489
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 14349,
              title: "Little Witch Academia (Movie)"
            },
            {
              alId: 19489,
              title: "Little Witch Academia: Mahoujikake no Parade"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Little Witch Academia: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:love-live",
        title: "Love Live",
        origin: "community",
        anchorIds: [
          15051,
          20554,
          19111,
          20766,
          21584,
          98349,
          100965
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 15051,
              title: "Love Live! School Idol Project"
            },
            {
              alId: 20554,
              title: "Love Live! School Idol Project OVA"
            },
            {
              alId: 19111,
              title: "Love Live! School Idol Project 2nd Season"
            },
            {
              alId: 20766,
              title: "Love Live! The School Idol Movie"
            },
            {
              alId: 21584,
              title: "Love Live! Sunshine!!"
            },
            {
              alId: 98349,
              title: "Love Live! Sunshine!! 2nd Season"
            },
            {
              alId: 100965,
              title: "Love Live! Sunshine!! The School Idol Movie: Over the Rainbow"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Love Live: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:madoka-magica",
        title: "Madoka Magica",
        origin: "community",
        anchorIds: [
          9756,
          11981,
          133007
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 9756,
              title: "Mahou Shoujo Madoka Magica"
            },
            {
              alId: 11981,
              title: "Mahou Shoujo Madoka★Magica Movie 3: Hangyaku no Monogatari"
            },
            {
              alId: 133007,
              title: "Mahou Shoujo Madoka★Magica Movie 4: Walpurgis no Kaiten"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Madoka Magica: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:magi",
        title: "Magi",
        origin: "community",
        anchorIds: [
          14513,
          18115,
          21394
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 14513,
              title: "Magi: The Labyrinth of Magic"
            },
            {
              alId: 18115,
              title: "Magi: The Kingdom of Magic"
            },
            {
              alId: 21394,
              title: "Magi: Sinbad no Bouken (TV)"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Magi: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:mahou-shoujo-lyrical-nanoha",
        title: "Mahou Shoujo Lyrical Nanoha",
        origin: "community",
        anchorIds: [
          76,
          77,
          1915,
          20820,
          21871
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 76,
              title: "Mahou Shoujo Lyrical Nanoha"
            },
            {
              alId: 77,
              title: "Mahou Shoujo Lyrical Nanoha A's"
            },
            {
              alId: 1915,
              title: "Mahou Shoujo Lyrical Nanoha StrikerS"
            },
            {
              alId: 20820,
              title: "Mahou Shoujo Lyrical Nanoha ViVid"
            },
            {
              alId: 21871,
              title: "ViVid Strike!"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Mahou Shoujo Lyrical Nanoha: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:mahouka-koukou-no-rettousei",
        title: "Mahouka Koukou no Rettousei",
        origin: "community",
        anchorIds: [
          20458,
          112300,
          21684,
          143271
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20458,
              title: "Mahouka Koukou no Rettousei"
            },
            {
              alId: 112300,
              title: "Mahouka Koukou no Rettousei: Raihousha-hen"
            },
            {
              alId: 21684,
              title: "Mahouka Koukou no Rettousei Movie: Hoshi wo Yobu Shoujo"
            },
            {
              alId: 143271,
              title: "Mahouka Koukou no Rettousei 3rd Season"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Mahouka Koukou no Rettousei: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:major",
        title: "Major",
        origin: "community",
        anchorIds: [
          627,
          5029,
          558,
          1842,
          3226,
          5028,
          7655,
          11917,
          9890,
          100306,
          112302
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 627,
              title: "Major S1"
            },
            {
              alId: 5029,
              title: "Major Movie: Yuujou no Winning Shot"
            },
            {
              alId: 558,
              title: "Major S2"
            },
            {
              alId: 1842,
              title: "Major S3"
            },
            {
              alId: 3226,
              title: "Major S4"
            },
            {
              alId: 5028,
              title: "Major S5"
            },
            {
              alId: 7655,
              title: "Major S6"
            },
            {
              alId: 11917,
              title: "Major: World Series"
            },
            {
              alId: 9890,
              title: "Major: Message"
            },
            {
              alId: 100306,
              title: "Major 2nd (TV)"
            },
            {
              alId: 112302,
              title: "Major 2nd (TV) 2nd Season"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Major: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:the-melancholy-of-haruhi-suzumiya",
        title: "The Melancholy of Haruhi Suzumiya",
        origin: "community",
        anchorIds: [
          849,
          4382,
          7311
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 849,
              title: "The Melancholy of Haruhi Suzumiya"
            },
            {
              alId: 4382,
              title: "The Melancholy of Haruhi Suzumiya (2009)"
            },
            {
              alId: 7311,
              title: "The Disappearance of Haruhi Suzumiya"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — The Melancholy of Haruhi Suzumiya: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:milky-holmes",
        title: "Milky Holmes",
        origin: "community",
        anchorIds: [
          7768,
          10923,
          11341,
          14647,
          17267,
          20848,
          21314,
          87533,
          100570,
          105663
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 7768,
              title: "Tantei Opera Milky Holmes"
            },
            {
              alId: 10923,
              title: "Tantei Opera Milky Holmes: Summer Special"
            },
            {
              alId: 11341,
              title: "Tantei Opera Milky Holmes Dai 2 Maku"
            },
            {
              alId: 14647,
              title: "Tantei Opera Milky Holmes: Alternative"
            },
            {
              alId: 17267,
              title: "Futari wa Milky Holmes"
            },
            {
              alId: 20848,
              title: "Tantei Kageki Milky Holmes TD"
            },
            {
              alId: 21314,
              title: "Tantei Opera Milky Holmes Movie: Gyakushuu no Milky Holmes"
            },
            {
              alId: 87533,
              title: "Tantei Opera Milky Holmes: Fun Fun Party Night♪ - Ken to Janet no Okurimono"
            },
            {
              alId: 100570,
              title: "Tantei Opera Milky Holmes: Arsene Karei naru Yokubou"
            },
            {
              alId: 105663,
              title: "Tantei Opera Milky Holmes: Psycho no Aisatsu"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Milky Holmes: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:mushishi",
        title: "Mushishi",
        origin: "community",
        anchorIds: [
          457,
          20526,
          20595,
          20752,
          20751,
          21008
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 457,
              title: "Mushishi"
            },
            {
              alId: 20526,
              title: "Mushishi: Special: Hihamukage"
            },
            {
              alId: 20595,
              title: "Mushishi Zoku Shou"
            },
            {
              alId: 20752,
              title: "Mushishi Zoku Shou Special"
            },
            {
              alId: 20751,
              title: "Mushishi Zoku Shou 2"
            },
            {
              alId: 21008,
              title: "Mushishi Zoku Shou: Suzu no Shizuku"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Mushishi: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:nanatsu-no-taizai",
        title: "Nanatsu no Taizai",
        origin: "community",
        anchorIds: [
          20789,
          21104,
          21385,
          99539,
          104175,
          99540,
          108928,
          116752
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20789,
              title: "Nanatsu no Taizai"
            },
            {
              alId: 21104,
              title: "Nanatsu no Taizai OVA"
            },
            {
              alId: 21385,
              title: "Nanatsu no Taizai: Seisen no Shirushi"
            },
            {
              alId: 99539,
              title: "Nanatsu no Taizai: Imashime no Fukkatsu"
            },
            {
              alId: 104175,
              title: "Nanatsu no Taizai: Eiyuu-tachi wa Hashagu"
            },
            {
              alId: 99540,
              title: "Nanatsu no Taizai Movie: Tenkuu no Torawarebito"
            },
            {
              alId: 108928,
              title: "Nanatsu no Taizai: Kamigami no Gekirin"
            },
            {
              alId: 116752,
              title: "Nanatsu no Taizai: Fundo no Shinpan"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Nanatsu no Taizai: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:natsume-yuujinchou",
        title: "Natsume Yuujinchou",
        origin: "community",
        anchorIds: [
          4081,
          5300,
          10379,
          11665,
          20478,
          21710,
          99363,
          97983,
          100283,
          100268
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 4081,
              title: "Natsume Yuujinchou"
            },
            {
              alId: 5300,
              title: "Zoku Natsume Yuujinchou"
            },
            {
              alId: 10379,
              title: "Natsume Yuujinchou San"
            },
            {
              alId: 11665,
              title: "Nastume Yuujinchou Shi"
            },
            {
              alId: 20478,
              title: "Natsume Yuujinchou: Itsuka Yuki no Hi ni"
            },
            {
              alId: 21710,
              title: "Natsume Yuujinchou Go"
            },
            {
              alId: 99363,
              title: "Natsume Yuujinchou Go Specials"
            },
            {
              alId: 97983,
              title: "Natsume Yuujinchou Roku"
            },
            {
              alId: 100283,
              title: "Natsume Yuujinchou Roku Specials"
            },
            {
              alId: 100268,
              title: "Natsume Yuujinchou Movie: Utsusemi ni Musubu"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Natsume Yuujinchou: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:no-game-no-life",
        title: "No Game No Life",
        origin: "community",
        anchorIds: [
          19815,
          21875
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 19815,
              title: "No Game No Life"
            },
            {
              alId: 21875,
              title: "No Game No Life: Zero"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — No Game No Life: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:non-non-biyori",
        title: "Non Non Biyori",
        origin: "community",
        anchorIds: [
          17549,
          20694,
          21585,
          20497,
          98779,
          109403,
          137337
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 17549,
              title: "Non Non Biyori"
            },
            {
              alId: 20694,
              title: "Non Non Biyori Repeat"
            },
            {
              alId: 21585,
              title: "Non Non Biyori Repeat: Hotaru Had Fun (OVA)"
            },
            {
              alId: 20497,
              title: "Non Non Biyori: We're Going to Okinawa (OVA)"
            },
            {
              alId: 98779,
              title: "Non Non Biyori Movie: Vacation (Movie)"
            },
            {
              alId: 109403,
              title: "Non Non Biyori Nonstop"
            },
            {
              alId: 137337,
              title: "Non Non Biyori Nonstop: Our Club Worked Hard (OVA)"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Non Non Biyori: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:oreimo",
        title: "OreImo",
        origin: "community",
        anchorIds: [
          8769,
          10020,
          13659,
          18857
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 8769,
              title: "Oreimo S1"
            },
            {
              alId: 10020,
              title: "Oreimo Specials 1"
            },
            {
              alId: 13659,
              title: "Oreimo S2"
            },
            {
              alId: 18857,
              title: "Oreimo Specials 2."
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — OreImo: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:psycho-pass",
        title: "Psycho Pass",
        origin: "community",
        anchorIds: [
          13601,
          20513,
          20514,
          102649,
          104382,
          104990,
          108307,
          113917,
          153687
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 13601,
              title: "Psycho Pass"
            },
            {
              alId: 20513,
              title: "Psycho Pass 2"
            },
            {
              alId: 20514,
              title: "Psycho Pass Movie"
            },
            {
              alId: 102649,
              title: "Psycho Pass SS Case 1"
            },
            {
              alId: 104382,
              title: "Psycho Pass SS Case 2"
            },
            {
              alId: 104990,
              title: "Psycho Pass SS Case 3"
            },
            {
              alId: 108307,
              title: "Psycho Pass 3"
            },
            {
              alId: 113917,
              title: "Psycho-Pass 3: First Inspector"
            },
            {
              alId: 153687,
              title: "Psycho-Pass Movie: Providence"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Psycho Pass: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:relife",
        title: "ReLIFE",
        origin: "community",
        anchorIds: [
          21049,
          98635
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 21049,
              title: "ReLIFE"
            },
            {
              alId: 98635,
              title: "ReLIFE: Kanketsu-hen"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — ReLIFE: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:rozen-maiden",
        title: "Rozen Maiden",
        origin: "community",
        anchorIds: [
          64,
          65,
          1719,
          18041
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 64,
              title: "Rozen Maiden"
            },
            {
              alId: 65,
              title: "Träumend"
            },
            {
              alId: 1719,
              title: "Ouvertüre"
            },
            {
              alId: 18041,
              title: "Zurückspulen (2013)"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Rozen Maiden: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:rurouni-kenshin",
        title: "Rurouni Kenshin",
        origin: "community",
        anchorIds: [
          45,
          46,
          44,
          401
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 45,
              title: "Rurouni Kenshin"
            },
            {
              alId: 46,
              title: "Movie"
            },
            {
              alId: 44,
              title: "Trust and Betrayal"
            },
            {
              alId: 401,
              title: "Reflection"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Rurouni Kenshin: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:saiki-kusuo-no-nan",
        title: "Saiki Kusuo no Ψ-nan",
        origin: "community",
        anchorIds: [
          21804,
          98034,
          112625,
          104580
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 21804,
              title: "Saiki Kusuo no Ψ-nan"
            },
            {
              alId: 98034,
              title: "Saiki Kusuo no Ψ-nan 2"
            },
            {
              alId: 112625,
              title: "Saiki Kusuo no Ψ-nan: Ψ-shidou-hen",
              episodes: "1–5"
            },
            {
              alId: 104580,
              title: "Saiki Kusuo no Ψ-nan: Kanketsu-hen"
            },
            {
              alId: 112625,
              title: "Saiki Kusuo no Ψ-nan: Ψ-shidou-hen",
              episodes: "6"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Saiki Kusuo no Ψ-nan: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:sailor-moon",
        title: "Sailor Moon",
        origin: "community",
        anchorIds: [
          530,
          740,
          532,
          1239,
          996
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 530,
              title: "Sailor Moon"
            },
            {
              alId: 740,
              title: "Sailor Moon R"
            },
            {
              alId: 532,
              title: "Sailor Moon S"
            },
            {
              alId: 1239,
              title: "Sailor Moon SuperS"
            },
            {
              alId: 996,
              title: "Sailor Moon SailorStars"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Sailor Moon: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:sayonara-zetsubou-sensei",
        title: "Sayonara Zetsubou Sensei",
        origin: "community",
        anchorIds: [
          2605,
          3228,
          4872,
          6377,
          7044,
          10469
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 2605,
              title: "Sayonara Zetsubou Sensei"
            },
            {
              alId: 3228,
              title: "Zoku Sayonara Zetsubou Sensei"
            },
            {
              alId: 4872,
              title: "Goku Sayonara Zetsubou Sensei"
            },
            {
              alId: 6377,
              title: "Zan Sayonara Zetsubou Sensei"
            },
            {
              alId: 7044,
              title: "Zan Sayonara Zetsubou Sensei Bangaichi OVAs"
            },
            {
              alId: 10469,
              title: "Sayonara Zetsubou Sensei Special"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Sayonara Zetsubou Sensei: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:senki-zesshou-symphogear",
        title: "Senki Zesshou Symphogear",
        origin: "community",
        anchorIds: [
          11751,
          15793,
          20560,
          21672,
          21673
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 11751,
              title: "Senki Zesshou Symphogear: Meteoroid-Falling, Burning, and Disappear, Then..."
            },
            {
              alId: 15793,
              title: "Senki Zesshou Symphogear G: In the Distance, That Day, When the Star Became Music..."
            },
            {
              alId: 20560,
              title: "Senki Zesshou Symphogear GX: Believe in Justice and Hold a Determination to Fist."
            },
            {
              alId: 21672,
              title: "Senki Zesshou Symphogear AXZ: By Shedding Many Tears, the Reality You Face is..."
            },
            {
              alId: 21673,
              title: "Senki Zesshou Symphogear XV: Create a history, with the light God could not know"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Senki Zesshou Symphogear: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:shakugan-no-shana",
        title: "Shakugan no Shana",
        origin: "community",
        anchorIds: [
          355,
          1531,
          1815,
          2787,
          6572,
          6773
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 355,
              title: "Shakugan no Shana",
              episodes: "1–13"
            },
            {
              alId: 1531,
              title: "Shakugan no Shana SP (OVA)"
            },
            {
              alId: 355,
              title: "Shakugan no Shana",
              episodes: "14–24"
            },
            {
              alId: 1815,
              title: "Shakugan no Shana: The Movie"
            },
            {
              alId: 2787,
              title: "Shakugan no Shana Second"
            },
            {
              alId: 6572,
              title: "Shakugan no Shana S"
            },
            {
              alId: 6773,
              title: "Shakugan no Shana Final"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Shakugan no Shana: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:shingeki-no-bahamut",
        title: "Shingeki no Bahamut",
        origin: "community",
        anchorIds: [
          20590,
          21184,
          21322
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20590,
              title: "Shingeki no Bahamut: Genesis"
            },
            {
              alId: 21184,
              title: "Shingeki no Bahamut: Virgin Soul"
            },
            {
              alId: 21322,
              title: "Shingeki no Bahamut: Manaria Friends"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Shingeki no Bahamut: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:shokugeki-no-souma",
        title: "Shokugeki no Souma",
        origin: "community",
        anchorIds: [
          20923,
          21691,
          21518,
          98702,
          99255,
          101924,
          100773
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20923,
              title: "Season 1"
            },
            {
              alId: 21691,
              title: "OVA 1 (optional)",
              optional: true
            },
            {
              alId: 21518,
              title: "Ni no Sara/The Second Plate"
            },
            {
              alId: 98702,
              title: "Ni no Sara OVA (required)"
            },
            {
              alId: 99255,
              title: "San no Sara/The Third Plate"
            },
            {
              alId: 101924,
              title: "San no Sara OVA: Kyoukuseiryou no Erina (optional)",
              optional: true
            },
            {
              alId: 100773,
              title: "San no Sara: Toutsuki Ressha-hen/The Third Plate: Toutsuki Train Arc"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Shokugeki no Souma: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:slam-dunk",
        title: "Slam Dunk",
        origin: "community",
        anchorIds: [
          170,
          1764,
          1861,
          2498,
          2499
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 170,
              title: "Slam Dunk",
              episodes: "1–20"
            },
            {
              alId: 1764,
              title: "Slam Dunk Movie 1"
            },
            {
              alId: 170,
              title: "Slam Dunk",
              episodes: "21–36"
            },
            {
              alId: 1861,
              title: "Slam Dunk: Zenkoku Seiha Da! Sakuragi Hanamichi (Movie 2)"
            },
            {
              alId: 170,
              title: "Slam Dunk",
              episodes: "37–60"
            },
            {
              alId: 2498,
              title: "Slam Dunk: Shouhoku Saidai no Kiki! Moero Sakuragi Hanamichi (Movie 3)"
            },
            {
              alId: 2499,
              title: "Slam Dunk: Hoero Basketman-damashii! Hanamichi to Rukawa no Atsuki Natsu (Movie 4)"
            },
            {
              alId: 170,
              title: "Slam Dunk",
              episodes: "61–101"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Slam Dunk: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:sora-no-woto",
        title: "Sora no Woto",
        origin: "community",
        anchorIds: [
          6802,
          8197
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 6802,
              title: "So Ra No Wo To"
            },
            {
              alId: 8197,
              title: "So Ra No Wo To Specials"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Sora no Woto: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:soukyuu-no-fafner",
        title: "Soukyuu no Fafner",
        origin: "community",
        anchorIds: [
          75,
          560,
          8098,
          17080
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 75,
              title: "Soukyuu no Fafner: Dead Aggressor"
            },
            {
              alId: 560,
              title: "Soukyuu no Fafner: Right of Left"
            },
            {
              alId: 8098,
              title: "Soukyuu no Fafner: Dead Aggressor - Heaven and Earth"
            },
            {
              alId: 17080,
              title: "Soukyuu no Fafner: Dead Aggressor - Exodus"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Soukyuu no Fafner: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:spy-family",
        title: "Spy × Family",
        origin: "community",
        anchorIds: [
          140960,
          142838,
          158927,
          158928,
          177937
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 140960,
              title: "Spy × Family [TV]"
            },
            {
              alId: 142838,
              title: "Spy × Family Part 2 [TV]"
            },
            {
              alId: 158927,
              title: "Spy × Family Season 2 [TV]"
            },
            {
              alId: 158928,
              title: "Spy × Family code: White [Movie]",
              optional: true
            },
            {
              alId: 177937,
              title: "Spy × Family Season 3 [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Spy × Family: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:strike-witches",
        title: "Strike Witches",
        origin: "community",
        anchorIds: [
          3667,
          6381,
          20650,
          9751,
          103119
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 3667,
              title: "Strike Witches"
            },
            {
              alId: 6381,
              title: "Strike Witches 2"
            },
            {
              alId: 20650,
              title: "Operation Victory Arrow"
            },
            {
              alId: 9751,
              title: "Strike Witches Movie"
            },
            {
              alId: 103119,
              title: "Road to Berlin"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Strike Witches: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:tensei-shitara-slime-datta-ken",
        title: "Tensei shitara Slime Datta Ken",
        origin: "community",
        anchorIds: [
          101280,
          106509,
          108511,
          116742
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 101280,
              title: "Tensei shitara Slime Datta Ken"
            },
            {
              alId: 106509,
              title: "Tensei shitara Slime Datta Ken OVA"
            },
            {
              alId: 108511,
              title: "Tensei shitara Slime Datta Ken 2nd Season"
            },
            {
              alId: 116742,
              title: "Tensei shitara Slime Datta Ken 2nd Season Part 2"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Tensei shitara Slime Datta Ken: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:tokyo-ghoul",
        title: "Tokyo Ghoul",
        origin: "community",
        anchorIds: [
          20605,
          20850,
          21132,
          21326,
          100240,
          102351
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20605,
              title: "Tokyo Ghoul"
            },
            {
              alId: 20850,
              title: "Tokyo Ghoul Root A"
            },
            {
              alId: 21132,
              title: 'Tokyo Ghoul: "Jack" (OVA)'
            },
            {
              alId: 21326,
              title: 'Tokyo Ghoul: "Pinto" (OVA)'
            },
            {
              alId: 100240,
              title: "Tokyo Ghoul:re"
            },
            {
              alId: 102351,
              title: "Tokyo Ghoul:re 2nd Season"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Tokyo Ghoul: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:tsurune",
        title: "Tsurune",
        origin: "community",
        anchorIds: [
          100402,
          107506,
          153841
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 100402,
              title: "Tsurune: Kazemai Koukou Kyuudou-bu [TV]"
            },
            {
              alId: 107506,
              title: "Tsurune: Kazemai Koukou Kyuudou-bu - Yabai [Special]"
            },
            {
              alId: 153841,
              title: "Tsurune: Tsunagari no Issha [TV]"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Tsurune: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:uma-musume",
        title: "Uma Musume",
        origin: "community",
        anchorIds: [
          98514,
          103237,
          124223,
          145608,
          156632
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 98514,
              title: "Uma Musume: Pretty Derby Season 1"
            },
            {
              alId: 103237,
              title: "Uma Musume: Pretty Derby BNW no Chikai"
            },
            {
              alId: 124223,
              title: "Uma Musume: Pretty Derby Season 2"
            },
            {
              alId: 145608,
              title: "Uma Musume: Pretty Derby - 1st Anniversary Special Animation"
            },
            {
              alId: 156632,
              title: "Uma Musume: Pretty Derby Season 3"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Uma Musume: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:uta-no-prince-sama",
        title: "Uta no☆Prince-sama♪",
        origin: "community",
        anchorIds: [
          10321,
          12711,
          20662
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 10321,
              title: "Uta no☆Prince-sama♪ Maji Love 1000%"
            },
            {
              alId: 12711,
              title: "Uta no☆Prince-sama♪ Maji Love 2000%"
            },
            {
              alId: 20662,
              title: "Uta no☆Prince-sama♪ Maji Love Revolutions"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Uta no☆Prince-sama♪: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:violet-evergarden",
        title: "Violet Evergarden",
        origin: "community",
        anchorIds: [
          21827,
          101432,
          109190,
          103047
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 21827,
              title: "Violet Evergarden",
              episodes: "1–4"
            },
            {
              alId: 101432,
              title: 'Violet Evergarden: Kitto "Ai" wo Shiru Hi ga Kuru no Darou'
            },
            {
              alId: 21827,
              title: "Violet Evergarden",
              episodes: "5–13"
            },
            {
              alId: 109190,
              title: "Violet Evergarden Gaiden: Eien to Jidou Shuki Ningyou (movie)"
            },
            {
              alId: 103047,
              title: "Violet Evergarden: The Movie"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Violet Evergarden: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:wake-up-girls",
        title: "Wake Up, Girls!",
        origin: "community",
        anchorIds: [
          20512,
          19023,
          20989,
          21107
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20512,
              title: "Wake Up, Girls! Shichinin no Idol"
            },
            {
              alId: 19023,
              title: "Wake Up, Girls!"
            },
            {
              alId: 20989,
              title: "Wake Up, Girls! Seishun no Kage"
            },
            {
              alId: 21107,
              title: "Wake Up, Girls! Beyond the Bottom"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Wake Up, Girls!: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:wolfs-rain",
        title: "Wolfs Rain",
        origin: "community",
        anchorIds: [
          202,
          1023
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 202,
              title: "Wolf's Rain"
            },
            {
              alId: 1023,
              title: "Wolf's Rain OVA"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Wolfs Rain: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:working",
        title: "Working!!",
        origin: "community",
        anchorIds: [
          6956,
          10521,
          20819,
          21384
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 6956,
              title: "Working!!"
            },
            {
              alId: 10521,
              title: "Working'!!"
            },
            {
              alId: 20819,
              title: "Working!!!"
            },
            {
              alId: 21384,
              title: "Working!!!: Lord of the Takanashi"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Working!!: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:xxxholic",
        title: "xxxHolic",
        origin: "community",
        anchorIds: [
          861,
          3091,
          177,
          969,
          4918,
          6864
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 861,
              title: "xxxHOLiC"
            },
            {
              alId: 3091,
              title: "xxxHOLiC Kei"
            },
            {
              alId: 177,
              title: "Tsubasa Chronicle Season 1"
            },
            {
              alId: 969,
              title: "Tsubasa Chronicle Season 2"
            },
            {
              alId: 4918,
              title: "xxxHOLiC Shunmuki"
            },
            {
              alId: 6864,
              title: "xxxHOLiC Rou."
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — xxxHolic: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:yahari-ore-no-seishun-love-comedy-wa-machigatteiru",
        title: "Yahari Ore no Seishun Love Comedy wa Machigatteiru",
        origin: "community",
        anchorIds: [
          14813,
          18753,
          20698,
          21769,
          108489
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 14813,
              title: "Oregairu"
            },
            {
              alId: 18753,
              title: "Oregairu OVA"
            },
            {
              alId: 20698,
              title: "Oregairu Zoku"
            },
            {
              alId: 21769,
              title: "Oregairu Zoku OVA"
            },
            {
              alId: 108489,
              title: "Oregairu Season 3"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Yahari Ore no Seishun Love Comedy wa Machigatteiru: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:yamada-kun-and-the-seven-witches",
        title: "Yamada-kun and the Seven Witches",
        origin: "community",
        anchorIds: [
          20966,
          20740
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 20966,
              title: "Yamada-kun and the Seven Witches"
            },
            {
              alId: 20740,
              title: "OVAs"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Yamada-kun and the Seven Witches: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "community:yuru-yuri",
        title: "Yuru Yuri",
        origin: "community",
        anchorIds: [
          10495,
          12403,
          20625,
          21214,
          21088,
          102090
        ],
        checkedAt: "2026-10-17",
        recommended: {
          steps: [
            {
              alId: 10495,
              title: "Yuru Yuri"
            },
            {
              alId: 12403,
              title: "Yuri Yuri♪♪"
            },
            {
              alId: 20625,
              title: "Yuru Yuri Nachuyachumi!"
            },
            {
              alId: 21214,
              title: "Yuru Yuri Nachuyachumi!+"
            },
            {
              alId: 21088,
              title: "Yuru Yuri San☆Hai!"
            },
            {
              alId: 102090,
              title: "Yuru Yuri,"
            }
          ],
          note: "Автоматически импортированный порядок сообщества: Main Story.",
          sources: [
            {
              label: "r/anime — Yuru Yuri: Main Story",
              url: "https://www.reddit.com/r/anime/wiki/watch_order/",
              detail: "Автоматический импорт явной последовательности."
            }
          ]
        },
        limitations: [
          "Автоматический импорт; спорные варианты смотрите в источнике."
        ]
      },
      {
        id: "shikimori:2881-228",
        title: "Адская девочка",
        origin: "community",
        anchorIds: [
          228,
          1594,
          3713,
          98379
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 228,
              title: "Адская девочка"
            },
            {
              alId: 1594,
              title: "Адская девочка: Двое заключённых"
            },
            {
              alId: 3713,
              title: "Адская девочка: Три пути"
            },
            {
              alId: 98379,
              title: "Адская девочка: Разговоры в сумерках"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-2012",
        title: "Адский учитель Нубэ",
        origin: "community",
        anchorIds: [
          2012,
          5296,
          8208,
          8228,
          2745
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 2012,
              title: "Адский учитель Нубэ"
            },
            {
              alId: 5296,
              title: "Адский учитель Нубэ: Жуткие каникулы! Легенда Моря Подозрения"
            },
            {
              alId: 8208,
              title: "Адский учитель Нубэ. Фильм"
            },
            {
              alId: 8228,
              title: "Адский учитель Нубэ: Полночь. Смерть Нубэ"
            },
            {
              alId: 2745,
              title: "Адский учитель Нубэ OVA"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-22503",
        title: "Васимо",
        origin: "community",
        anchorIds: [
          21047,
          21048,
          98763,
          98764,
          98765,
          109930,
          131458,
          131459
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 21047,
              title: "Васимо"
            },
            {
              alId: 21048,
              title: "Васимо 2"
            },
            {
              alId: 98763,
              title: "Васимо 3"
            },
            {
              alId: 98764,
              title: "Васимо 4"
            },
            {
              alId: 98765,
              title: "Васимо 5"
            },
            {
              alId: 109930,
              title: "Васимо 6"
            },
            {
              alId: 131458,
              title: "Васимо 7"
            },
            {
              alId: 131459,
              title: "Васимо 8"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-1848",
        title: "Властелин властелинов Рыцарь Рю",
        origin: "community",
        anchorIds: [
          1848,
          1849,
          1850,
          1851
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 1848,
              title: "Властелин властелинов Рыцарь Рю"
            },
            {
              alId: 1849,
              title: "Властелин властелинов Рыцарь Рю: Легенда Адьё"
            },
            {
              alId: 1850,
              title: "Властелин властелинов Рыцарь Рю: Легенда Адьё II"
            },
            {
              alId: 1851,
              title: "Властелин властелинов Рыцарь Рю: Легенда Адьё — Финал"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-1232",
        title: "Воины-марионетки Эр",
        origin: "community",
        anchorIds: [
          1232,
          573,
          1191,
          1231
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 1232,
              title: "Воины-марионетки Эр"
            },
            {
              alId: 573,
              title: "Воины-марионетки Джей"
            },
            {
              alId: 1191,
              title: "Снова воины-марионетки Джей"
            },
            {
              alId: 1231,
              title: "Воины-марионетки от Джей до Икс"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-383",
        title: "Галактический ангел",
        origin: "community",
        anchorIds: [
          383,
          13287,
          652,
          2206,
          653,
          654,
          12225,
          655,
          1600
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 383,
              title: "Галактический ангел"
            },
            {
              alId: 13287,
              title: "Галактический ангел: Спецвыпуски"
            },
            {
              alId: 652,
              title: "Галактический ангел Z"
            },
            {
              alId: 2206,
              title: "Галактический ангел Z: Спецвыпуск"
            },
            {
              alId: 653,
              title: "Галактический ангел 3"
            },
            {
              alId: 654,
              title: "Галактический ангел 3: Спецвыпуски"
            },
            {
              alId: 12225,
              title: "Галактический ангел S"
            },
            {
              alId: 655,
              title: "Галактический ангел 4"
            },
            {
              alId: 1600,
              title: "Галактический ангел: Руна"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-3782",
        title: "Граница пустоты",
        origin: "community",
        anchorIds: [
          3782,
          4280,
          3783,
          2593,
          4282,
          5204,
          5205,
          6954,
          14807,
          20697
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 3782,
              title: "Граница пустоты 2: Теория убийства — Часть 1"
            },
            {
              alId: 4280,
              title: "Граница пустоты 4: Храм пустоты"
            },
            {
              alId: 3783,
              title: "Граница пустоты 3: Оставшееся чувство боли"
            },
            {
              alId: 2593,
              title: "Граница пустоты 1: Вид с высоты"
            },
            {
              alId: 4282,
              title: "Граница пустоты 5: Спираль парадокса"
            },
            {
              alId: 5204,
              title: "Граница пустоты 6: Мелодия забвения"
            },
            {
              alId: 5205,
              title: "Граница пустоты 7: Теория убийства — Часть 2"
            },
            {
              alId: 6954,
              title: "Граница пустоты: Эпилог"
            },
            {
              alId: 14807,
              title: "Граница пустоты: Благословение будущего"
            },
            {
              alId: 20697,
              title: "Граница пустоты: Благословение будущего — Дополнительная глава"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-17731",
        title: "Группа крови-кун!",
        origin: "community",
        anchorIds: [
          17731,
          20929,
          21354,
          21528
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 17731,
              title: "Группа крови-кун!"
            },
            {
              alId: 20929,
              title: "Группа крови-кун! 2"
            },
            {
              alId: 21354,
              title: "Группа крови-кун! 3"
            },
            {
              alId: 21528,
              title: "Группа крови-кун! 4"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-158",
        title: "Дева Мария смотрит за вами",
        origin: "community",
        anchorIds: [
          158,
          444,
          1729,
          3750
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 158,
              title: "Дева Мария смотрит за вами"
            },
            {
              alId: 444,
              title: "Дева Мария смотрит за вами ~Весна~"
            },
            {
              alId: 1729,
              title: "Дева Мария смотрит за вами 3"
            },
            {
              alId: 3750,
              title: "Дева Мария смотрит за вами 4"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-1597",
        title: "Ди-Ги Карат",
        origin: "community",
        anchorIds: [
          1597,
          293,
          1683,
          1757,
          1718,
          1755,
          1754,
          1756,
          1752,
          1753,
          1758,
          1748
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 1597,
              title: "Ди-Ги Карат Панё Панё"
            },
            {
              alId: 293,
              title: "Ди-Ги Карат"
            },
            {
              alId: 1683,
              title: "Ди-Ги Карат Нё"
            },
            {
              alId: 1757,
              title: "Ди-Ги Карат: Рождественский спецвыпуск"
            },
            {
              alId: 1718,
              title: "Зимний сад: Спецвыпуск"
            },
            {
              alId: 1755,
              title: "Ди-Ги Карат: Цветочный спецвыпуск"
            },
            {
              alId: 1754,
              title: "Ди-Ги Карат: Летний спецвыпуск"
            },
            {
              alId: 1756,
              title: "Ди-Ги Карат: Летний отпуск"
            },
            {
              alId: 1752,
              title: "Ди-Ги Карат: Путешествие звезды"
            },
            {
              alId: 1753,
              title: "Ди-Ги Карат: Ракета изо рта"
            },
            {
              alId: 1758,
              title: "Ди-Ги Карат: Дождливый спецвыпуск"
            },
            {
              alId: 1748,
              title: "Предоставьте это Пиёко!"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-161",
        title: "Железный миротворец",
        origin: "community",
        anchorIds: [
          161,
          9568,
          21770,
          101369
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 161,
              title: "Железный миротворец"
            },
            {
              alId: 9568,
              title: "Железный миротворец: Спецвыпуск"
            },
            {
              alId: 21770,
              title: "Железный миротворец: Вера"
            },
            {
              alId: 101369,
              title: "Железный миротворец: Друг"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-24909",
        title: "Загадочный Джокер",
        origin: "community",
        anchorIds: [
          20818,
          21004,
          21427,
          21859
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 20818,
              title: "Загадочный Джокер"
            },
            {
              alId: 21004,
              title: "Загадочный Джокер 2"
            },
            {
              alId: 21427,
              title: "Загадочный Джокер 3"
            },
            {
              alId: 21859,
              title: "Загадочный Джокер 4"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-250",
        title: "Златовласый Гаш Белл",
        origin: "community",
        anchorIds: [
          250,
          7430,
          10732,
          844,
          911
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 250,
              title: "Златовласый Гаш Белл"
            },
            {
              alId: 7430,
              title: "Златовласый Гаш Белл!! OVA"
            },
            {
              alId: 10732,
              title: "Златовласый Гаш Белл!! OVA 2"
            },
            {
              alId: 844,
              title: "Златовласый Гаш Белл: 101-я демоническая книга"
            },
            {
              alId: 911,
              title: "Златовласый Гаш Белл: Нападение Мехавулканов"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-763",
        title: "Зойды",
        origin: "community",
        anchorIds: [
          763,
          1746,
          764,
          712,
          101228,
          110788
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 763,
              title: "Зойды"
            },
            {
              alId: 1746,
              title: "Зойды: Фьюзоры"
            },
            {
              alId: 764,
              title: "Зойды нового века"
            },
            {
              alId: 712,
              title: "Зойды нового века: Генезис"
            },
            {
              alId: 101228,
              title: "Дикие Зойды"
            },
            {
              alId: 110788,
              title: "Дикие Зойды: Начало"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-34602",
        title: "Идеальный муж и я, или Как украсть 55 поцелуев",
        origin: "community",
        anchorIds: [
          99548,
          103022,
          103023,
          108936
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 99548,
              title: "Идеальный муж и я, или Как украсть 55 поцелуев"
            },
            {
              alId: 103022,
              title: "Идеальный муж и я, или Как украсть 55 поцелуев 2"
            },
            {
              alId: 103023,
              title: "Идеальный муж и я, или Как украсть 55 поцелуев 3"
            },
            {
              alId: 108936,
              title: "Идеальный муж и я, или Как украсть 55 поцелуев 4"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-28981",
        title: "Какао цвета дождя",
        origin: "community",
        anchorIds: [
          21054,
          21285,
          21797,
          99741,
          104712
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 21054,
              title: "Какао цвета дождя"
            },
            {
              alId: 21285,
              title: "Какао цвета дождя 2"
            },
            {
              alId: 21797,
              title: "Какао цвета дождя 3"
            },
            {
              alId: 99741,
              title: "Какао цвета дождя 4"
            },
            {
              alId: 104712,
              title: "Какао цвета дождя 5"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-36291",
        title: "Край основателей",
        origin: "community",
        anchorIds: [
          100297,
          101877,
          101878,
          101879,
          101880,
          101881
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 100297,
              title: "Край основателей"
            },
            {
              alId: 101877,
              title: "Край основателей 2"
            },
            {
              alId: 101878,
              title: "Край основателей 3"
            },
            {
              alId: 101879,
              title: "Край основателей 4"
            },
            {
              alId: 101880,
              title: "Край основателей 5"
            },
            {
              alId: 101881,
              title: "Край основателей 6"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-34300",
        title: "Маг на полную ставку",
        origin: "community",
        anchorIds: [
          99200,
          100294,
          104745,
          115800
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 99200,
              title: "Маг на полную ставку"
            },
            {
              alId: 100294,
              title: "Маг на полную ставку 2"
            },
            {
              alId: 104745,
              title: "Маг на полную ставку 3"
            },
            {
              alId: 115800,
              title: "Маг на полную ставку 4"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-457",
        title: "Мастер муси",
        origin: "community",
        anchorIds: [
          457,
          20526,
          20595,
          20752,
          20751,
          21008
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 457,
              title: "Мастер муси"
            },
            {
              alId: 20526,
              title: "Мастер муси: Тень, поглотившая солнце"
            },
            {
              alId: 20595,
              title: "Мастер муси: Следующая глава"
            },
            {
              alId: 20752,
              title: "Мастер муси: Следующая глава — Тернистый путь"
            },
            {
              alId: 20751,
              title: "Мастер муси: Следующая глава 2"
            },
            {
              alId: 21008,
              title: "Мастер муси: Следующая глава — Капли колокольчиков"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-3841",
        title: "Милый дом Чи",
        origin: "community",
        anchorIds: [
          3841,
          6024,
          7972,
          21796,
          99478
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 3841,
              title: "Милый дом Чи"
            },
            {
              alId: 6024,
              title: "Милый дом Чи 2"
            },
            {
              alId: 7972,
              title: "Милый дом Чи OVA"
            },
            {
              alId: 21796,
              title: "Милый дом Чи 3"
            },
            {
              alId: 99478,
              title: "Милый дом Чи 4"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-749",
        title: "Нанами-тян",
        origin: "community",
        anchorIds: [
          749,
          4314,
          4316,
          116046,
          116048,
          116050
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 749,
              title: "Нанами-тян"
            },
            {
              alId: 4314,
              title: "Нанами-тян 2"
            },
            {
              alId: 4316,
              title: "Нанами-тян 3"
            },
            {
              alId: 116046,
              title: "Нанами-тян 4"
            },
            {
              alId: 116048,
              title: "Нанами-тян 5"
            },
            {
              alId: 116050,
              title: "Нанами-тян 6"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-14713",
        title: "Очень приятно, Бог",
        origin: "community",
        anchorIds: [
          14713,
          18661,
          20801,
          21186,
          98033
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 14713,
              title: "Очень приятно, Бог"
            },
            {
              alId: 18661,
              title: "Очень приятно, Бог OVA"
            },
            {
              alId: 20801,
              title: "Очень приятно, Бог 2"
            },
            {
              alId: 21186,
              title: "Очень приятно, Бог 2 OVA"
            },
            {
              alId: 98033,
              title: "Очень приятно, Бог: Будьте счастливы"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-31838",
        title: "Путь выбора",
        origin: "community",
        anchorIds: [
          101409,
          102165,
          102166,
          108986,
          115839
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 101409,
              title: "Путь выбора"
            },
            {
              alId: 102165,
              title: "Путь выбора 2"
            },
            {
              alId: 102166,
              title: "Путь выбора 3"
            },
            {
              alId: 108986,
              title: "Путь выбора 4"
            },
            {
              alId: 115839,
              title: "Путь выбора 5"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-2963",
        title: "Сёстры Минами",
        origin: "community",
        anchorIds: [
          2963,
          3225,
          5162,
          5713,
          14575,
          14511,
          20221
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 2963,
              title: "Сёстры Минами"
            },
            {
              alId: 3225,
              title: "Сёстры Минами 2"
            },
            {
              alId: 5162,
              title: "Сёстры Минами 3"
            },
            {
              alId: 5713,
              title: "Сёстры Минами OVA"
            },
            {
              alId: 14575,
              title: "Сёстры Минами: Простите за ожидание"
            },
            {
              alId: 14511,
              title: "Сёстры Минами: Снова дома"
            },
            {
              alId: 20221,
              title: "Сёстры Минами: Летние каникулы"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-36666",
        title: "Стич!",
        origin: "community",
        anchorIds: [
          108746,
          5027,
          8963,
          6899,
          140340,
          8964,
          146171,
          147814,
          147815
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 108746,
              title: "Стич и Ай"
            },
            {
              alId: 5027,
              title: "Стич!"
            },
            {
              alId: 8963,
              title: "Стич: Эпизод 26"
            },
            {
              alId: 6899,
              title: "Стич! 2"
            },
            {
              alId: 140340,
              title: "Стич: Большое приключение озорных инопланетян — Ещё один брат по разуму"
            },
            {
              alId: 8964,
              title: "Стич! 3"
            },
            {
              alId: 146171,
              title: "Стич! 3: Эпизод 30"
            },
            {
              alId: 147814,
              title: "Стич и планета песка"
            },
            {
              alId: 147815,
              title: "Стич: Идеальные воспоминания"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-421",
        title: "Стратос 4",
        origin: "community",
        anchorIds: [
          421,
          422,
          423,
          1584
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 421,
              title: "Стратос 4"
            },
            {
              alId: 422,
              title: "Стратос 4 OVA"
            },
            {
              alId: 423,
              title: "Стратос 4: Продвижение"
            },
            {
              alId: 1584,
              title: "Стратос 4: Продвижение. Финал"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-1196",
        title: "Театр Косукэ Масуды",
        origin: "community",
        anchorIds: [
          1196,
          2518,
          4056,
          7761
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 1196,
              title: "Театр Косукэ Масуды"
            },
            {
              alId: 2518,
              title: "Театр Косукэ Масуды 2"
            },
            {
              alId: 4056,
              title: "Театр Косукэ Масуды 3"
            },
            {
              alId: 7761,
              title: "Театр Косукэ Масуды 4"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-22689",
        title: "Терраформирование",
        origin: "community",
        anchorIds: [
          20630,
          20629,
          21300,
          97989
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 20630,
              title: "Терраформирование OVA"
            },
            {
              alId: 20629,
              title: "Terra FormarsТерраформирование"
            },
            {
              alId: 21300,
              title: "Терраформирование 2"
            },
            {
              alId: 97989,
              title: "Терраформирование OVA 2"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-5958",
        title: "Утраченное небесами",
        origin: "community",
        anchorIds: [
          5958,
          7858,
          8407,
          9790,
          12783
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 5958,
              title: "Утраченное небесами"
            },
            {
              alId: 7858,
              title: "Утраченное небесами: Проект «Розовый»"
            },
            {
              alId: 8407,
              title: "Утраченное небесами: Сильнейшая"
            },
            {
              alId: 9790,
              title: "Утраченное небесами: Ангелоид времени"
            },
            {
              alId: 12783,
              title: "Утраченное небесами: Мой хозяин навсегда"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-30519",
        title: "Феи Балала",
        origin: "community",
        anchorIds: [
          99712,
          104469,
          104468,
          104509,
          104510
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 99712,
              title: "Феи Балала"
            },
            {
              alId: 104469,
              title: "Феи Балала 2"
            },
            {
              alId: 104468,
              title: "Феи Балала 3"
            },
            {
              alId: 104509,
              title: "Феи Балала: Над радугой"
            },
            {
              alId: 104510,
              title: "Феи Балала: Над радугой 2"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-9981",
        title: "Фи Брейн: Загадка Бога",
        origin: "community",
        anchorIds: [
          9981,
          12753,
          15651
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 9981,
              title: "Фи Брейн: Загадка Бога"
            },
            {
              alId: 12753,
              title: "Фи Брейн: Загадка Бога — Орден Орфея"
            },
            {
              alId: 15651,
              title: "Фи Брейн: Загадка Бога 3"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-12031",
        title: "Царство",
        origin: "community",
        anchorIds: [
          12031,
          17389,
          113108
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 12031,
              title: "Царство"
            },
            {
              alId: 17389,
              title: "Царство 2"
            },
            {
              alId: 113108,
              title: "Царство 3"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-24",
        title: "Школьный переполох",
        origin: "community",
        anchorIds: [
          24,
          517,
          846,
          4015
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 24,
              title: "Школьный переполох"
            },
            {
              alId: 517,
              title: "Школьный переполох OVA"
            },
            {
              alId: 846,
              title: "Школьный переполох 2"
            },
            {
              alId: 4015,
              title: "Школьный переполох 2 OVA"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      },
      {
        id: "shikimori:2881-30831",
        title: "Этот замечательный мир!",
        origin: "community",
        anchorIds: [
          21202,
          21574,
          21699,
          97996,
          102976
        ],
        checkedAt: "2020-06-26",
        recommended: {
          steps: [],
          note: "В клубе указан только событийный порядок.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        chronological: {
          steps: [
            {
              alId: 21202,
              title: "Этот замечательный мир!"
            },
            {
              alId: 21574,
              title: "Этот замечательный мир! OVA"
            },
            {
              alId: 21699,
              title: "Этот замечательный мир! 2"
            },
            {
              alId: 97996,
              title: "Этот замечательный мир! 2 OVA"
            },
            {
              alId: 102976,
              title: "Этот замечательный мир! Багровая легенда"
            }
          ],
          note: "Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.",
          sources: [
            {
              label: "Shikimori — Правильная Хронология Аниме",
              url: "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime"
            }
          ]
        },
        limitations: [
          "Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно."
        ]
      }
    ],
    stats: {
      reddit: {
        inputProfiles: 167,
        inputRoutes: 224,
        importedProfiles: 97,
        importedRoutes: 98,
        recommended: 97,
        chronological: 1,
        skippedRoutes: 126,
        skipReasons: {
          "missing-media-mapping": 9,
          "ambiguous-repeat": 3,
          "no-explicit-sequence": 66,
          "ambiguous-sequence": 26,
          "unclassified-route": 11,
          "unparsed-sequence-text": 6,
          "invalid-episodes": 3,
          "competing-routes": 2
        },
        skipped: [
          {
            title: "Ajin",
            name: "Main Story",
            reason: "missing-media-mapping"
          },
          {
            title: "Angel Beats",
            name: "Main Story",
            reason: "ambiguous-repeat"
          },
          {
            title: "Ashita no Joe",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Blood Series",
            name: "Main Story",
            reason: "missing-media-mapping"
          },
          {
            title: "Charlotte",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Code Geass",
            name: "Anime Timeline",
            reason: "unclassified-route"
          },
          {
            title: "Code Geass",
            name: "Movie Timeline",
            reason: "unparsed-sequence-text"
          },
          {
            title: "Code Geass",
            name: "Akito the Exiled Movies",
            reason: "unclassified-route"
          },
          {
            title: "Danganronpa",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Digimon",
            name: "Without Movies",
            reason: "unclassified-route"
          },
          {
            title: "Digimon",
            name: "With Movies",
            reason: "unclassified-route"
          },
          {
            title: "Dragon Ball",
            name: "Simple",
            reason: "ambiguous-sequence"
          },
          {
            title: "Dragon Ball",
            name: "Super Saiyan Mode",
            reason: "ambiguous-sequence"
          },
          {
            title: "Dragon Ball",
            name: "Non-Canon",
            reason: "no-explicit-sequence"
          },
          {
            title: "Dragon Ball",
            name: "Movie Order",
            reason: "unclassified-route"
          },
          {
            title: "Dragon Ball",
            name: "What is the Difference between Dragon Ball Z and Dragon Ball Kai?",
            reason: "no-explicit-sequence"
          },
          {
            title: "Dragon Ball",
            name: "Why Aren't the Movies/GT Canon?",
            reason: "no-explicit-sequence"
          },
          {
            title: "Durarara",
            name: "Simple",
            reason: "unclassified-route"
          },
          {
            title: "Durarara",
            name: "Detailed",
            reason: "unclassified-route"
          },
          {
            title: "Eve no Jikan",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Fist of the North Star",
            name: "Optional",
            reason: "no-explicit-sequence"
          },
          {
            title: "Full Metal Panic!",
            name: "Main Story",
            reason: "missing-media-mapping"
          },
          {
            title: "Fullmetal Alchemist",
            name: "Main Story",
            reason: "unparsed-sequence-text"
          },
          {
            title: "Gargantia on the Verdurous Planet",
            name: "Main Story",
            reason: "invalid-episodes"
          },
          {
            title: "Ghost In the Shell",
            name: "Ghost in the Shell (Movies)",
            reason: "unclassified-route"
          },
          {
            title: "Ghost In the Shell",
            name: "Ghost in the Shell Stand Alone Complex",
            reason: "unclassified-route"
          },
          {
            title: "Ghost In the Shell",
            name: "Ghost in the Shell Arise",
            reason: "unclassified-route"
          },
          {
            title: "Gundam",
            name: "Mobile Suit Gundam",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Timelines and Continuity",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Entry Points",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Mainline UC Route (most recommended)",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "AU Series route (second most recommended)",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "UC Spinoff route (Very doable and enjoyable but least recommended)",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Watch Order",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Universal Century recommended Order",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Alternate Universe Timelines",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Future Colony",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "After Colony",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "After War",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Cosmic Era",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Anno Domini",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Advanced Generation",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "SD Gundam",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Present Day",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Post Disaster",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Ad Stella",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "¯\\_(ツ)_/¯",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Turn A Gundam and Correct Century",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "ZZ Gundam",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "0083 Stardust Memory",
            reason: "ambiguous-sequence"
          },
          {
            title: "Gundam",
            name: "Gundam Unicorn",
            reason: "no-explicit-sequence"
          },
          {
            title: "Gundam",
            name: "Movie Summaries",
            reason: "no-explicit-sequence"
          },
          {
            title: "Hellsing",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Hetalia",
            name: "Main Story",
            reason: "missing-media-mapping"
          },
          {
            title: "Hibike! Euphonium",
            name: "Main Story",
            reason: "unparsed-sequence-text"
          },
          {
            title: "IDOLiSH7",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "The iDOLM@STER",
            name: "Main Story",
            reason: "missing-media-mapping"
          },
          {
            title: "Isekai Quartet",
            name: "Isekai Quartet",
            reason: "no-explicit-sequence"
          },
          {
            title: "Isekai Quartet",
            name: "Isekai Quartet S2",
            reason: "no-explicit-sequence"
          },
          {
            title: "Isekai Quartet",
            name: "Isekai Quartet Movie",
            reason: "no-explicit-sequence"
          },
          {
            title: "Isekai Quartet",
            name: "Isekai Quartet S3",
            reason: "no-explicit-sequence"
          },
          {
            title: "JoJo's Bizarre Adventure",
            name: "Main Story",
            reason: "missing-media-mapping"
          },
          {
            title: "K",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Kaiji",
            name: "Main Story",
            reason: "unparsed-sequence-text"
          },
          {
            title: "Kamichu!",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Kimetsu no Yaiba - Demon Slayer",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Kino's Journey",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Kiss X Sis",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Kono Subarashii Sekai ni Shukufuku wo!",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Kuroshitsuji",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Kuroko no Basuke",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Legend of the Galactic Heroes",
            name: "Original Series",
            reason: "ambiguous-sequence"
          },
          {
            title: "Legend of the Galactic Heroes",
            name: "Readaption Die Neue These",
            reason: "missing-media-mapping"
          },
          {
            title: "Love Hina",
            name: "Main Story",
            reason: "invalid-episodes"
          },
          {
            title: "Macross",
            name: "Broadcast/OVA/theatrical content, major entries in bold",
            reason: "no-explicit-sequence"
          },
          {
            title: "Mobile Police Patlabor",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Monogatari",
            name: "Chronological Order",
            reason: "no-explicit-sequence"
          },
          {
            title: "Monogatari",
            name: "Bonus Order",
            reason: "no-explicit-sequence"
          },
          {
            title: "Monogatari",
            name: "Airing Order",
            reason: "competing-routes"
          },
          {
            title: "Monogatari",
            name: "Novel Release Order",
            reason: "competing-routes"
          },
          {
            title: "My Hero Academia",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Naruto",
            name: "Naruto Movies and OVAs",
            reason: "no-explicit-sequence"
          },
          {
            title: "Naruto",
            name: "Naruto Shippuden Movies and OVAs",
            reason: "no-explicit-sequence"
          },
          {
            title: "Neon Genesis Evangelion",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Night Raid",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Noragami",
            name: "First season's OVAs",
            reason: "no-explicit-sequence"
          },
          {
            title: "Noragami",
            name: "Second Season's OVAs",
            reason: "ambiguous-sequence"
          },
          {
            title: "One Piece",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Queensblade",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Raildex",
            name: "Railgun first",
            reason: "no-explicit-sequence"
          },
          {
            title: "Raildex",
            name: "Simplified 'chronological' order",
            reason: "ambiguous-sequence"
          },
          {
            title: "Raildex",
            name: "Optimal Chronological Order",
            reason: "ambiguous-sequence"
          },
          {
            title: "Raildex",
            name: "Full chronological order",
            reason: "no-explicit-sequence"
          },
          {
            title: "Raildex",
            name: "Index first",
            reason: "ambiguous-sequence"
          },
          {
            title: "Raildex",
            name: "List of filler",
            reason: "no-explicit-sequence"
          },
          {
            title: "Raildex",
            name: "Read order",
            reason: "no-explicit-sequence"
          },
          {
            title: "Rec",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Rascal Does Not Dream",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Re:Zero kara Hajimeru Isekai Seikatsu (Re:Zero)",
            name: "Semi Chronological Order with Chibi shorts and OVAs",
            reason: "ambiguous-sequence"
          },
          {
            title: "Re:Zero kara Hajimeru Isekai Seikatsu (Re:Zero)",
            name: "Release Order Condensed",
            reason: "missing-media-mapping"
          },
          {
            title: "Saint Seiya",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Seitokai Yakuindomo",
            name: "Main Story",
            reason: "ambiguous-repeat"
          },
          {
            title: "Slayers",
            name: "Main Story",
            reason: "ambiguous-repeat"
          },
          {
            title: "Slayers",
            name: "Prequels",
            reason: "unclassified-route"
          },
          {
            title: "Slayers",
            name: "Side Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Space Battleship Yamato",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Steins;Gate",
            name: "Main Story",
            reason: "unparsed-sequence-text"
          },
          {
            title: "Sword Art Online",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Tamako Market",
            name: "Main Story",
            reason: "missing-media-mapping"
          },
          {
            title: "Tamayura",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Tengen Toppa Gurren Lagann",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "The Prince of Tennis",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "To LOVE-Ru",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Toradora!",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Trigun",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "White Album",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "WIXOSS",
            name: "Main Story",
            reason: "unparsed-sequence-text"
          },
          {
            title: "The World God Only Knows",
            name: "TWGOK Care Package",
            reason: "no-explicit-sequence"
          },
          {
            title: "Yama no Susume",
            name: "Main Story",
            reason: "invalid-episodes"
          },
          {
            title: "Yowamushi Pedal",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Yu-Gi-Oh!",
            name: "Main Story",
            reason: "no-explicit-sequence"
          },
          {
            title: "Yuru Camp△",
            name: "Main Story",
            reason: "ambiguous-sequence"
          },
          {
            title: "Yuuki Yuuna wa Yuusha de Aru",
            name: "Release Date",
            reason: "ambiguous-sequence"
          },
          {
            title: "Yuuki Yuuna wa Yuusha de Aru",
            name: "Chronological Order",
            reason: "no-explicit-sequence"
          },
          {
            title: "Yuuki Yuuna wa Yuusha de Aru",
            name: "Light Novels",
            reason: "no-explicit-sequence"
          },
          {
            title: "Yuuki Yuuna wa Yuusha de Aru",
            name: "Anime Only Watch Order",
            reason: "ambiguous-sequence"
          }
        ]
      },
      shikimori: {
        inputProfiles: 58,
        inputRoutes: 58,
        parsedRoutes: 35,
        skippedRoutes: 24,
        skipReasons: {
          "quality-flag": 20,
          "ambiguous-step": 1,
          "nested-instructions": 2,
          "missing-media-mapping": 1
        },
        skipped: [
          {
            title: "Ария",
            reason: "quality-flag"
          },
          {
            title: "Боевой континент",
            reason: "ambiguous-step"
          },
          {
            title: "Вольный стиль!",
            reason: "quality-flag"
          },
          {
            title: "Данганронпа",
            reason: "quality-flag"
          },
          {
            title: "Евангелион нового поколения",
            reason: "nested-instructions"
          },
          {
            title: "Золотое божество",
            reason: "quality-flag"
          },
          {
            title: "Из одной комнаты",
            reason: "quality-flag"
          },
          {
            title: "Как и ожидалось, моя школьная романтическая жизнь не удалась",
            reason: "quality-flag"
          },
          {
            title: "Кровь",
            reason: "quality-flag"
          },
          {
            title: "Любовные неприятности",
            reason: "quality-flag"
          },
          {
            title: "Может, я встречу тебя в подземелье?",
            reason: "quality-flag"
          },
          {
            title: "Нет лекарства для моего брата!",
            reason: "quality-flag"
          },
          {
            title: "Ну не может моя сестрёнка быть такой милой",
            reason: "nested-instructions"
          },
          {
            title: "Ох уж этот экстрасенс Сайки Кусуо!",
            reason: "quality-flag"
          },
          {
            title: "Подручный Луизы-Нулизы",
            reason: "quality-flag"
          },
          {
            title: "Проза бродячих псов",
            reason: "quality-flag"
          },
          {
            title: "Рандеву с жизнью",
            reason: "quality-flag"
          },
          {
            title: "Синий экзорцист",
            reason: "quality-flag"
          },
          {
            title: "Токийский гуль",
            reason: "quality-flag"
          },
          {
            title: "Удар крови",
            reason: "quality-flag"
          },
          {
            title: "Хвост Феи",
            reason: "quality-flag"
          },
          {
            title: "Чудачества любви не помеха!",
            reason: "quality-flag"
          },
          {
            title: "Ярость Бахамута",
            reason: "quality-flag"
          },
          {
            title: "Мы не можем учиться!",
            reason: "missing-media-mapping"
          }
        ],
        importedProfiles: 34,
        importedRoutes: 34,
        recommended: 0,
        chronological: 34
      }
    }
  };

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

  // src/communityOrders.ts
  var COMMUNITY_URL = "https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/data/community-orders.json";
  var SOURCE_URL = "https://www.reddit.com/r/anime/wiki/watch_order/";
  var SHIKI_URL = "https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime";
  var allowedSource = (value) => [SOURCE_URL, SHIKI_URL].some((url) => value === url || value.startsWith(`${url}#`));
  var NS = "community-orders-v1";
  var text = (value, max) => typeof value === "string" && value.length <= max;
  var id = (value) => Number.isInteger(value) && value > 0 && value < 1e7;
  function parseRoute(raw) {
    if (!isObj(raw) || !text(raw.note, 1500) || !Array.isArray(raw.steps) || raw.steps.length > 80 || !Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > 5) return void 0;
    const steps = [];
    const keys = /* @__PURE__ */ new Set();
    for (const step of raw.steps) {
      if (!isObj(step) || !id(step.alId) || step.title !== void 0 && !text(step.title, 500) || step.note !== void 0 && !text(step.note, 800) || step.optional !== void 0 && typeof step.optional !== "boolean" || step.episodes !== void 0 && (!text(step.episodes, 60) || !/^\d{1,4}(?:[–-]\d{1,4})?$/.test(step.episodes))) return void 0;
      const key = `${step.alId}:${step.episodes ?? "full"}`;
      if (keys.has(key)) return void 0;
      keys.add(key);
      steps.push({
        alId: step.alId,
        title: step.title,
        episodes: step.episodes,
        optional: step.optional,
        note: step.note
      });
    }
    const sources = [];
    for (const source of raw.sources) {
      if (!isObj(source) || !text(source.label, 500) || !text(source.url, 600) || !allowedSource(source.url) || source.detail !== void 0 && !text(source.detail, 800)) return void 0;
      sources.push({ label: source.label, url: source.url, detail: source.detail });
    }
    return { steps, note: raw.note, sources };
  }
  function parseCatalogue(raw) {
    if (!isObj(raw) || raw.version !== 1 || !text(raw.updatedAt, 60) || !Number.isFinite(Date.parse(raw.updatedAt)) || !Array.isArray(raw.profiles) || raw.profiles.length > 500) return void 0;
    const profiles = [];
    const profileIds = /* @__PURE__ */ new Set();
    for (const p of raw.profiles) {
      if (!isObj(p) || !text(p.id, 200) || !/^(?:community|shikimori):[a-z0-9_-]+$/.test(p.id) || profileIds.has(p.id) || !text(p.title, 300) || !text(p.checkedAt, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(p.checkedAt) || !Array.isArray(p.anchorIds) || !p.anchorIds.length || p.anchorIds.length > 160 || !p.anchorIds.every(id)) return void 0;
      const recommended = parseRoute(p.recommended);
      const chronological = p.chronological === void 0 ? void 0 : parseRoute(p.chronological);
      if (!recommended || p.chronological !== void 0 && !chronological || !recommended.steps.length && !chronological?.steps.length) return void 0;
      const expectedSource = p.id.startsWith("shikimori:") ? SHIKI_URL : SOURCE_URL;
      if ([recommended, chronological].some((route) => route?.sources.some((source) => source.url !== expectedSource && !source.url.startsWith(`${expectedSource}#`)))) return void 0;
      for (const route of [recommended, chronological]) if (route) {
        route.origin = "community";
        route.variantId = p.id;
        route.label = p.id.startsWith("shikimori:") ? "Shikimori" : "r/anime";
        route.checkedAt = p.checkedAt;
      }
      const anchors = [...new Set(p.anchorIds)];
      const steps = [...recommended.steps, ...chronological?.steps ?? []];
      if (steps.some((step) => !anchors.includes(step.alId))) return void 0;
      if (p.limitations !== void 0 && (!Array.isArray(p.limitations) || p.limitations.length > 10 || !p.limitations.every((s) => text(s, 1e3)))) return void 0;
      profiles.push({
        id: p.id,
        title: p.title,
        checkedAt: p.checkedAt,
        anchorIds: anchors,
        origin: "community",
        recommended,
        chronological,
        limitations: p.limitations,
        chronologyUnavailable: "В источнике нет однозначно разобранного событийного маршрута. Порядок по датам выхода доступен автоматически."
      });
      profileIds.add(p.id);
    }
    return { version: 1, updatedAt: raw.updatedAt, profiles };
  }
  function communityProfile(catalogue, rootId) {
    const matches = catalogue.profiles.filter((profile) => profile.anchorIds.includes(rootId));
    const candidates = ["community:", "shikimori:"].flatMap((prefix) => {
      const group = matches.filter((profile) => profile.id.startsWith(prefix));
      return group.length === 1 ? group : [];
    });
    const primary = candidates.find((profile) => profile.recommended.steps.length) ?? candidates[0];
    if (!primary) return void 0;
    const chronologicalVariants = candidates.flatMap((profile) => profile.chronological ? [profile.chronological] : []);
    return {
      ...primary,
      anchorIds: [...new Set(candidates.flatMap((profile) => profile.anchorIds))],
      chronological: chronologicalVariants[0],
      chronologicalVariants: chronologicalVariants.length > 1 ? chronologicalVariants : void 0,
      limitations: [...new Set(candidates.flatMap((profile) => profile.limitations ?? []))]
    };
  }
  var CommunityOrdersClient = class {
    constructor(transport) {
      this.transport = transport;
    }
    async load(rootId, ctx) {
      const cached = !ctx.force ? parseCatalogue(ctx.cache.get(NS, "latest")) : void 0;
      if (cached) return { profile: communityProfile(cached, rootId) };
      const bundled = parseCatalogue(community_orders_default);
      const saved = parseCatalogue(ctx.cache.get(NS, "last-good"));
      const fallback = saved && Date.parse(saved.updatedAt) >= Date.parse(bundled.updatedAt) ? saved : bundled;
      const useFallback = () => ({ profile: communityProfile(fallback, rootId), note: "Автокаталог: используется сохранённая копия источника." });
      if (!ctx.force && ctx.cache.get(NS, "cooldown")) return useFallback();
      try {
        const response = await this.transport({ url: COMMUNITY_URL, method: "GET", signal: ctx.signal, timeoutMs: 4e3 });
        if (response.text.length > 15e5) throw new Error("каталог слишком большой");
        const catalogue = parseCatalogue(parseJson(response, "Каталог порядков"));
        if (!catalogue || !catalogue.profiles.length) throw new Error("неверный формат каталога");
        const newest = Date.parse(catalogue.updatedAt) >= Date.parse(fallback.updatedAt) ? catalogue : fallback;
        ctx.cache.set(NS, "latest", newest, DAY);
        ctx.cache.set(NS, "last-good", newest, 90 * DAY);
        return { profile: communityProfile(newest, rootId) };
      } catch (error) {
        if (isAbort(error) || ctx.signal.aborted) throw error;
        ctx.cache.set(NS, "cooldown", true, HOUR / 4);
        return useFallback();
      }
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
      const { id: id2, match } = proposalsForTitle[0];
      const list = out.get(id2) ?? [];
      list.push(match);
      out.set(id2, list);
    }
    for (const [id2, titles] of out) if (titles.length !== 1) out.delete(id2);
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
  var profileForId = (id2) => ORDER_PROFILES.find((profile) => profile.anchorIds.includes(id2));

  // src/orderModes.ts
  var MODE_LABELS = {
    recommended: "Рекомендованный",
    release: "По выходу",
    chronological: "По событиям"
  };
  var rowKey = (item) => item.rowKey ?? item.watchKey;
  function findProfile(result, profiles = ORDER_PROFILES) {
    const current = [...result.items, ...result.branches].find((item) => item.isCurrent)?.alId;
    const id2 = result.rootAlId ?? current ?? Number(result.franchiseKey.match(/^al:(\d+)$/)?.[1]);
    if (!id2 || result.mode !== "anilist") return void 0;
    if (result.orderProfile?.anchorIds.includes(id2)) return result.orderProfile;
    return profiles.find((profile) => profile.anchorIds.includes(id2));
  }
  function selectOrder(result, selectedMode, profiles = ORDER_PROFILES, chronologyId) {
    const profile = findProfile(result, profiles);
    const franchiseKey = profile ? `al:${profile.anchorIds[0]}` : result.franchiseKey;
    const variants = profile?.chronologicalVariants;
    const chronology = variants?.find((route2) => route2.variantId === chronologyId) ?? profile?.chronological;
    const hasVariants = selectedMode === "chronological" && !!variants?.length;
    const base = {
      ...result,
      selectedMode,
      profile,
      // Старые пользовательские правки продолжают действовать в рекомендованном режиме.
      orderKey: selectedMode === "recommended" ? franchiseKey : hasVariants ? `${franchiseKey}:chronological:${chronology?.variantId ?? "default"}` : `${franchiseKey}:${selectedMode}`,
      legacyOrderKeys: selectedMode === "recommended" ? [.../* @__PURE__ */ new Set([result.franchiseKey, ...profile?.anchorIds.map((id2) => `al:${id2}`) ?? []])].filter((key) => key !== franchiseKey) : hasVariants && chronology === variants?.[0] ? [`${franchiseKey}:chronological`] : [],
      verified: false,
      communityRoute: false,
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
    const candidate = selectedMode === "recommended" ? profile?.recommended : chronology;
    const route = candidate?.steps.length ? candidate : void 0;
    if (!route) {
      return {
        ...base,
        available: selectedMode !== "chronological",
        items: selectedMode === "chronological" ? [] : [...result.items].sort((a, b) => dateKey(a.date) - dateKey(b.date)),
        sources: selectedMode === "recommended" && result.rootAlId ? [{ label: "AniList: связи и даты выхода", url: `https://anilist.co/anime/${result.rootAlId}` }] : [],
        explanation: selectedMode === "chronological" ? profile?.chronologyUnavailable ?? "Проверенной хронологии событий пока нет. Можно выбрать порядок по выходу." : result.mode === "anilist" ? "Автоматически для первого просмотра: выбранная ветка по датам выхода. Пересказы, дополнительные материалы и альтернативы отмечены отдельно. Это общий алгоритм, без отдельного гайда для франшизы." : "Автоматически по данным сайта. Если даты или связи отсутствуют, точный порядок не определён."
      };
    }
    const imported = route.origin === "community" || profile.origin === "community";
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
      flags: [...item.flags, imported ? "вне маршрута источника" : "вне проверенного маршрута"]
    }));
    const notes = [...result.notes];
    if (missing.length) notes.push(`В загруженных данных нет ${new Set(missing.map((step) => step.alId)).size} частей проверенного маршрута. Список неполный.`);
    if (route.steps.some((step) => step.episodes)) notes.push("Диапазоны серий относятся к указанному тайтлу. Отметка «просмотрено» общая для всех его диапазонов.");
    return {
      ...base,
      items,
      branches,
      notes,
      verified: !imported,
      communityRoute: imported,
      sources: route.sources,
      explanation: `${missing.length ? "Маршрут неполный: часть тайтлов не загрузилась. " : ""}${route.note} ${imported ? "Сведения источника" : "Проверено"}: ${route.checkedAt ?? profile.checkedAt}. Части вне маршрута показаны отдельно.`
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
      if (this.state.status !== "ready") return void 0;
      const selected = selectOrder(this.state.result, this.user.prefs().orderMode, void 0, this.chronologyId);
      return selected.available ? selected : selectOrder(this.state.result, "recommended");
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
        h("strong", { text: this.custom(res) ? "Порядок с вашими правками. " : res.verified ? "Проверенный маршрут. " : res.communityRoute ? "Порядок сообщества. " : "" }),
        res.explanation
      );
      info.setAttribute("aria-live", "polite");
      const out = [controls, info];
      if (res.selectedMode === "chronological" && res.profile?.chronologicalVariants) {
        const sources = h("div", { class: "order-modes" });
        sources.setAttribute("role", "group");
        sources.setAttribute("aria-label", "Источник хронологии");
        const selectedId = (res.profile.chronologicalVariants.find((route) => route.variantId === this.chronologyId) ?? res.profile.chronologicalVariants[0])?.variantId;
        for (const [index, route] of res.profile.chronologicalVariants.entries()) {
          const active = route.variantId === selectedId;
          const button = h("button", {
            class: "btn" + (active ? " on" : ""),
            text: route.label ?? `Вариант ${index + 1}`,
            onClick: () => {
              this.chronologyId = route.variantId;
              this.editing = false;
              this.render();
            }
          });
          button.setAttribute("aria-pressed", String(active));
          sources.append(button);
        }
        out.splice(1, 0, sources);
      }
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
        d.append(h("summary", { text: `${res.verified ? "Вне проверенного маршрута" : res.communityRoute ? "Вне маршрута источника" : "Альтернативы и прочее"} (${res.branches.length})` }));
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
    const indeg = new Map(ids.map((id2) => [id2, 0]));
    const succ = /* @__PURE__ */ new Map();
    for (const id2 of ids) {
      for (const e of adj.get(id2) ?? []) {
        if (e.rel !== "SEQUEL" || !set.has(e.id)) continue;
        const list = succ.get(id2) ?? [];
        if (list.includes(e.id)) continue;
        list.push(e.id);
        succ.set(id2, list);
        indeg.set(e.id, (indeg.get(e.id) ?? 0) + 1);
      }
    }
    const cmp = byDate(g.nodes);
    const ready = ids.filter((id2) => indeg.get(id2) === 0).sort(cmp);
    const out = [];
    while (ready.length > 0) {
      const id2 = ready.shift();
      out.push(id2);
      for (const s of succ.get(id2) ?? []) {
        const d = (indeg.get(s) ?? 0) - 1;
        indeg.set(s, d);
        if (d === 0) {
          ready.push(s);
          ready.sort(cmp);
        }
      }
    }
    if (out.length < ids.length) {
      const rest = ids.filter((id2) => !out.includes(id2)).sort(cmp);
      for (const id2 of rest) mark(flags, id2, FLAG_AMBIGUOUS);
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
  function mark(flags, id2, flag) {
    const list = flags.get(id2) ?? [];
    if (!list.includes(flag)) list.push(flag);
    flags.set(id2, list);
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
    const isLine = (id2) => (adj.get(id2) ?? []).some((e) => e.rel === "PREQUEL" || e.rel === "SEQUEL");
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
      const id2 = stack.pop();
      for (const e of adj.get(id2) ?? []) {
        if ((e.rel === "PREQUEL" || e.rel === "SEQUEL") && !mainSet.has(e.id)) {
          mainSet.add(e.id);
          stack.push(e.id);
        }
      }
    }
    const lineLinks = (id2) => new Set((adj.get(id2) ?? []).filter((e) => mainSet.has(e.id) && !recaps.has(e.id) && (e.rel === "PREQUEL" || e.rel === "SEQUEL")).map((e) => e.id)).size;
    const preferred = [...mainSet].filter((id2) => !recaps.has(id2)).sort((a, b) => lineLinks(b) - lineLinks(a) || Number(g.nodes.get(b).format === "TV") - Number(g.nodes.get(a).format === "TV") || (g.nodes.get(b).episodes ?? 0) - (g.nodes.get(a).episodes ?? 0) || byDate(g.nodes)(a, b));
    const alternatives = /* @__PURE__ */ new Set();
    const selected = /* @__PURE__ */ new Set();
    for (const id2 of preferred) {
      if ((adj.get(id2) ?? []).some((e) => e.rel === "ALTERNATIVE" && selected.has(e.id))) alternatives.add(id2);
      else selected.add(id2);
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
    for (const id2 of alternatives) mainSet.delete(id2);
    let mainIds = orderMain([...mainSet], g, adj, flags);
    const first = mainIds.find((id2) => !recaps.has(id2));
    const prerequisites = first === void 0 ? [] : (adj.get(first) ?? []).filter((e) => e.rel === "ALTERNATIVE" && !mainSet.has(e.id) && !alternatives.has(e.id) && !recaps.has(e.id) && g.nodes.get(e.id).format === "TV" && dateKey(g.nodes.get(e.id).startDate) < dateKey(g.nodes.get(first).startDate)).map((e) => e.id);
    if (prerequisites.length === 1) {
      const before = /* @__PURE__ */ new Set();
      const pending = [...prerequisites];
      while (pending.length) {
        const id2 = pending.pop();
        if (before.has(id2) || mainSet.has(id2) || recaps.has(id2)) continue;
        before.add(id2);
        for (const e of adj.get(id2) ?? []) if (e.rel === "PREQUEL") pending.push(e.id);
      }
      const ordered = orderMain([...before], g, adj, flags);
      for (const id2 of ordered) {
        mainSet.add(id2);
        alternatives.delete(id2);
        mark(flags, id2, "предыстория по другой ветке");
      }
      mainIds = [...ordered, ...mainIds];
    }
    const kind = /* @__PURE__ */ new Map();
    for (const id2 of mainIds) kind.set(id2, recaps.has(id2) ? "recap" : "main");
    for (const id2 of alternatives) kind.set(id2, "alternative");
    const queue = [...mainIds, ...alternatives];
    while (queue.length > 0) {
      const id2 = queue.shift();
      const parentKind = kind.get(id2);
      for (const e of adj.get(id2) ?? []) {
        if (kind.has(e.id)) continue;
        let k = KIND_BY_REL[e.rel] ?? (parentKind === "main" || parentKind === "recap" ? "extra" : parentKind);
        if (parentKind === "alternative" || parentKind === "spinoff" || parentKind === "other") k = parentKind;
        kind.set(e.id, k);
        queue.push(e.id);
      }
    }
    for (const id2 of g.nodes.keys()) if (!kind.has(id2)) kind.set(id2, "other");
    for (const id2 of recaps) kind.set(id2, "recap");
    for (const [id2, m] of g.nodes) if (!m.startDate.year) mark(flags, id2, FLAG_NO_DATE);
    const node = (id2, index) => ({
      id: id2,
      kind: kind.get(id2),
      index,
      flags: flags.get(id2) ?? []
    });
    let n = 0;
    const main = mainIds.map((id2) => node(id2, kind.get(id2) === "main" ? ++n : void 0));
    const cmp = byDate(g.nodes);
    const extras = [...g.nodes.keys()].filter((id2) => !mainSet.has(id2) && (kind.get(id2) === "extra" || kind.get(id2) === "recap")).sort(cmp);
    const all = [...main];
    for (const id2 of extras) {
      const k = dateKey(g.nodes.get(id2)?.startDate);
      let pos = all.length;
      if (k !== Number.MAX_SAFE_INTEGER) {
        pos = 0;
        for (let i = 0; i < all.length; i++) {
          if (dateKey(g.nodes.get(all[i].id)?.startDate) <= k) pos = i + 1;
        }
      }
      all.splice(pos, 0, node(id2));
    }
    const branches = [...g.nodes.keys()].filter((id2) => ["alternative", "spinoff", "other"].includes(kind.get(id2))).sort(cmp).map((id2) => node(id2));
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
        for (const id2 of ids) {
          if (queried.size >= limit) break;
          if (rematch().has(id2)) continue;
          const al = g.nodes.get(id2);
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
    let profile = profileForId(rootId);
    if (deps.community) {
      const imported = await deps.community.load(rootId, ctx);
      if (!profile) profile = imported.profile;
      else if (imported.profile?.chronological) {
        const variants = [
          ...profile.chronological ? [{ ...profile.chronological, variantId: "editorial", label: "Редакционный", checkedAt: profile.checkedAt }] : [],
          ...imported.profile.chronologicalVariants ?? [imported.profile.chronological]
        ];
        profile = { ...profile, chronological: variants[0], chronologicalVariants: variants.length > 1 ? variants : void 0 };
      }
      if (imported.note) notes.push(imported.note);
    }
    if (profile) {
      const routes = [profile.recommended, ...profile.chronologicalVariants ?? (profile.chronological ? [profile.chronological] : [])];
      const ids = [...new Set(routes.flatMap((route) => route.steps).map((step) => step.alId))].filter((id2) => !g.nodes.has(id2));
      if (ids.length) {
        try {
          const nodes = await ctx.cache.wrap(
            `profile-nodes:${profile.id}:${profile.checkedAt}`,
            ids.join(","),
            DAY,
            async () => {
              const loaded = [];
              for (let start2 = 0; start2 < Math.min(ids.length, 100); start2 += 50) {
                loaded.push(...await deps.anilist.getByIds(ids.slice(start2, start2 + 50), ctx.signal));
              }
              return loaded;
            },
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
      for (const [id2, m] of matches2) if (m.confidence === "date" && !poolKeys.has(m.title.key)) matches2.delete(id2);
      for (const [id2, m] of matches2) if (m.title.key === current.key && id2 !== rootId) matches2.delete(id2);
      matches2.set(rootId, { title: current, confidence: current.anilistId ? "id" : "name" });
      return matches2;
    };
    const branchIds = [...ordering.branches].sort((a, b) => Number(a.kind === "other") - Number(b.kind === "other")).map((n) => n.id);
    const preferredIds = profile?.recommended.steps.map((step) => step.alId).filter((id2) => g.nodes.has(id2)) ?? [];
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
      orderProfile: profile,
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
    const community = new CommunityOrdersClient(gmTransport);
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
      buildWatchOrder(s.key, { adapter, anilist, community, user, ctx }).finally(() => clearTimeout(timer)).then((result) => {
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
