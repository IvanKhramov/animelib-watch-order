import { parseIsoDate, parseRuDate } from '../dates';
import { arr, isObj, num, obj, str, strings, type Obj } from '../guards';
import { HttpError, isAbort, limiter, parseJson, type Transport } from '../http';
import { DAY, HOUR } from '../storage';
import type { MediaFormat, SiteRelationKind, SiteTitle } from '../types';
import type { LoadCtx, SiteAdapter } from './site';

// Проверено 2026-10-17 на живом сайте: SPA ходит в api.cdnlibs.org или hapi.hentaicdn.org
// (зависит от региона), с заголовком Site-Id: 5. Связи (/relations) отдаются анонимно,
// карточка лицензированного тайтла (/anime/{slug}) анонимно отдаёт 404.
const FALLBACK_API = 'https://api.cdnlibs.org';
const SITE_ID = '5';
const ORIGIN = 'https://animelib.org';

/** Типы связей AnimeLib (/api/constants?fields[]=relationTypes). */
const REL_KIND: Record<number, SiteRelationKind | 'skip'> = {
  1: 'skip', // Адаптация
  2: 'skip', // Источник
  3: 'prequel', // Предыстория
  4: 'sequel', // Продолжение
  5: 'story', // Альтернативная история
  6: 'story', // Спин-офф
  7: 'other', // Кроссовер
  8: 'skip', // Цветная версия
  9: 'story', // Перезапуск
  10: 'story', // Другое
  11: 'story', // Обобщение
  12: 'other', // Одна вселенная
  13: 'story', // Изначальная история
  14: 'other', // Общий персонаж
  15: 'story', // Альтернативная история
  16: 'story', // Развёрнутая история
};
/** По этим связям обходим граф AnimeLib дальше текущей страницы. */
const EXPAND_REL = new Set([3, 4, 11, 13, 16]);

const FORMAT_BY_LABEL: Record<string, MediaFormat> = {
  'TV Сериал': 'TV',
  'Фильм': 'MOVIE',
  'Короткометражка': 'TV_SHORT',
  'Спешл': 'SPECIAL',
  'OVA': 'OVA',
  'ONA': 'ONA',
  'Клип': 'MUSIC',
};

/** Токен разрешён только для HTTPS API на доменах AnimeLib. */
export function isTrustedApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      ['cdnlibs.org', 'hentaicdn.org'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

/** Хост API из запросов самой страницы; undefined, если страница их ещё не делала. */
export function detectApiBase(): string | undefined {
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (const e of entries) {
      if (!isTrustedApiUrl(e.name)) continue;
      const url = new URL(e.name);
      if (/^\/api\/(anime|constants|auth)\b/.test(url.pathname)) return url.origin;
    }
  } catch {
    /* нет Performance API */
  }
  return undefined;
}

/** Токен самого AnimeLib (pinia-persist, ключ "auth"). Уходит только в API AnimeLib. */
export function readToken(): string | undefined {
  try {
    const raw = localStorage.getItem('auth');
    if (!raw) return undefined;
    return str(obj(obj(JSON.parse(raw) as unknown).token).access_token);
  } catch {
    return undefined;
  }
}

export function parseLibMedia(v: unknown): SiteTitle | undefined {
  if (!isObj(v)) return undefined;
  const slug = str(v.slug_url);
  const name = str(v.name);
  if (!slug || !name) return undefined;
  const label = str(obj(v.type).label);
  const names = [name, str(v.rus_name), str(v.eng_name), ...strings(v.otherNames)].filter(
    (x): x is string => !!x,
  );
  return {
    key: slug,
    url: `${ORIGIN}/ru/anime/${slug}`,
    displayName: str(v.rus_name) ?? name,
    names,
    date: parseIsoDate(str(v.releaseDate)) ?? parseRuDate(str(v.releaseDateString)),
    format: label ? (FORMAT_BY_LABEL[label] ?? 'UNKNOWN') : undefined,
    formatLabel: label,
    anilistId: num(v.anilist_id),
    cover: [str(obj(v.cover).thumbnail), str(obj(v.cover).default)].find((u) => u?.startsWith('https://')),
  };
}

interface LibRelation {
  relId: number;
  label: string;
  title: SiteTitle;
}

export function parseRelations(body: unknown): LibRelation[] {
  const out: LibRelation[] = [];
  for (const r of arr(obj(body).data)) {
    const ro = obj(r);
    const media: Obj = obj(ro.media);
    if (media.model !== 'anime') continue;
    const rt = obj(ro.related_type);
    const relId = num(rt.id);
    const title = parseLibMedia(media);
    if (relId === undefined || !title) continue;
    out.push({ relId, label: str(rt.label) ?? '', title });
  }
  return out;
}

/** Запасной вариант: "Рус / Romaji смотреть аниме онлайн • AnimeLIB". */
function titleFromDocument(key: string): SiteTitle | undefined {
  const t = document.title.replace(/\s*смотреть.*$/i, '').replace(/\s*•.*$/, '');
  const parts = t.split(' / ').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || /не найдена/i.test(t)) return undefined;
  return { key, url: `${ORIGIN}/ru/anime/${key}`, displayName: parts[0]!, names: parts };
}

export function createAnimeLib(transport: Transport): SiteAdapter {
  const limit = limiter(3);
  let apiBase: string | undefined;

  const get = async (path: string, signal: AbortSignal): Promise<unknown> => {
    // запасной хост не запоминаем: страница может сделать свои запросы позже
    apiBase ??= detectApiBase();
    const base = apiBase ?? FALLBACK_API;
    const headers: Record<string, string> = { Accept: 'application/json', 'Site-Id': SITE_ID };
    const token = readToken();
    const url = `${base}/api/${path}`;
    if (token && isTrustedApiUrl(url)) headers.Authorization = `Bearer ${token}`;
    const res = await limit(() => transport({ url, headers, signal }));
    return parseJson(res, 'AnimeLib');
  };

  const relations = (slug: string, ctx: LoadCtx) =>
    ctx.cache.wrap('al-lib-rel', slug, 12 * HOUR, async () => parseRelations(await get(`anime/${slug}/relations`, ctx.signal)), ctx.force);

  return {
    id: 'animelib',

    pageKey(url) {
      if (!/(^|\.)animelib\.org$/.test(url.hostname)) return null;
      const m = url.pathname.match(/^\/[a-z]{2}\/anime\/(\d+--[^/]+)\/?$/);
      return m ? m[1]! : null;
    },

    findAnchor(doc) {
      const heads = doc.querySelectorAll('.section-title');
      for (const h of heads) {
        if (h.textContent?.trim() !== 'Связанное') continue;
        const section = h.closest('.section-body');
        if (section?.parentElement) return { parent: section.parentElement, before: section };
      }
      // связей нет: ставим перед «Похожее»
      for (const h of heads) {
        if (!/^Похожее/.test(h.textContent?.trim() ?? '')) continue;
        const section = h.closest('.section-body');
        if (section?.parentElement) return { parent: section.parentElement, before: section };
      }
      return null;
    },


    async loadCurrent(key, ctx) {
      try {
        return await ctx.cache.wrap('al-lib-title', key, 3 * DAY, async () => {
          const q = ['eng_name', 'otherNames', 'releaseDate'].map((f) => `fields[]=${f}`).join('&');
          const t = parseLibMedia(obj(await get(`anime/${key}?${q}`, ctx.signal)).data);
          if (!t) throw new Error('AnimeLib: неожиданный ответ карточки');
          return t;
        }, ctx.force);
      } catch (e) {
        // лицензированный тайтл без логина: берём названия из самой страницы
        const fallback = e instanceof HttpError && e.status === 404 ? titleFromDocument(key) : undefined;
        if (fallback) return fallback;
        throw e;
      }
    },

    async loadRelated(current, ctx) {
      let partial = false;
      const found = new Map<string, SiteTitle>();
      const seen = new Set([current.key]);
      let frontier: { key: string; kind?: SiteRelationKind }[] = [{ key: current.key }];
      for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
        const next: typeof frontier = [];
        const lists = await Promise.all(
          frontier.map((f) => relations(f.key, ctx).then((r) => ({ f, r })).catch((e: unknown) => {
            if (isAbort(e)) throw e;
            partial = true;
            return { f, r: [] as LibRelation[] };
          })),
        );
        for (const { f, r } of lists) {
          for (const rel of r) {
            const k = REL_KIND[rel.relId] ?? 'other';
            if (k === 'skip' || seen.has(rel.title.key)) continue;
            seen.add(rel.title.key);
            // вид связи считается от текущего тайтла: предыстория предыстории тоже предыстория
            const kind: SiteRelationKind = f.kind === undefined ? k : f.kind === k ? k : 'story';
            found.set(rel.title.key, { ...rel.title, relationLabel: rel.label, relationKind: kind });
            if (EXPAND_REL.has(rel.relId) && found.size < 25) next.push({ key: rel.title.key, kind });
          }
        }
        frontier = next;
      }
      return { titles: [...found.values()], partial };
    },

    async search(query, ctx) {
      return ctx.cache.wrap('al-lib-search', query.toLowerCase(), 3 * DAY, async () => {
        const body = await get(`anime?q=${encodeURIComponent(query)}&site_id[]=${SITE_ID}`, ctx.signal);
        return arr(obj(body).data).map(parseLibMedia).filter((t): t is SiteTitle => !!t);
      }, ctx.force);
    },

    searchUrl: (query) => `${ORIGIN}/ru/catalog?q=${encodeURIComponent(query)}`,
  };
}
