import { AniListClient } from './anilistAdapter';
import { dateKey } from './dates';
import { isAbort, limiter } from './http';
import { matchTitles, pickVerified } from './matching';
import { buildOrdering, type OrderedNode } from './orderPolicy';
import type { LoadCtx, SiteAdapter } from './sites/site';
import { DAY, HOUR, type UserState } from './storage';
import type { AlMedia, FranchiseGraph, MediaFormat, OrderItem, OrderResult, SiteMatch, SiteTitle } from './types';

export const FORMAT_LABEL: Record<MediaFormat, string> = {
  TV: 'TV',
  TV_SHORT: 'TV-короткометражка',
  MOVIE: 'Фильм',
  SPECIAL: 'Спешл',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Клип',
  UNKNOWN: '?',
};

export interface Deps {
  adapter: SiteAdapter;
  anilist: AniListClient;
  user: UserState;
  ctx: LoadCtx;
}

const hasLatin = (s: string) => /[a-z]/i.test(s) && !/[а-яё]/i.test(s);

/** id текущего тайтла в AniList: из данных сайта или проверенным поиском по латинским названиям. */
async function resolveRoot(current: SiteTitle, { anilist, ctx }: Deps): Promise<number | undefined> {
  if (current.anilistId) return current.anilistId;
  const r = await ctx.cache.wrap<{ id: number | null }>('anilist-root', current.key, 7 * DAY, async () => {
    const queries = [...new Set(current.names.filter(hasLatin))].slice(0, 3);
    for (const q of queries) {
      const hit = pickVerified(current, await anilist.search(q, ctx.signal));
      if (hit) return { id: hit.id };
    }
    return { id: null };
  }, ctx.force);
  return r.id ?? undefined;
}

async function loadGraph(rootId: number, { anilist, ctx }: Deps): Promise<FranchiseGraph> {
  const raw = await ctx.cache.wrap('anilist-graph', String(rootId), 24 * HOUR, async () => {
    const g = await anilist.loadFranchise(rootId, ctx.signal);
    return { nodes: [...g.nodes.values()], truncated: g.truncated };
  }, ctx.force);
  return { rootId, nodes: new Map(raw.nodes.map((m: AlMedia) => [m.id, m])), truncated: raw.truncated };
}

/** Общее название франшизы для поиска по каталогу: "Haikyuu!! To the Top Part 2" -> "Haikyuu!! To the Top". */
export function baseName(s: string | undefined): string | undefined {
  if (!s || !hasLatin(s)) return undefined;
  const b = s
    .split(/[:：]/)[0]!
    .replace(/\s+(season\s*\d+|\d+(st|nd|rd|th)\s+season|part\s*\d+|movie.*|ova|[ivx]+|\d+)$/i, '')
    .trim();
  return b.length >= 3 ? b : undefined;
}

/** Поиск по каталогу сайта по общему названию: одним запросом находит почти всю франшизу. */
async function searchFranchise(queries: (string | undefined)[], done: Set<string>, deps: Deps, max = 2): Promise<SiteTitle[]> {
  const { adapter, ctx } = deps;
  if (!adapter.search) return [];
  const out: SiteTitle[] = [];
  let n = 0;
  for (const q of queries) {
    if (!q || done.has(q.toLowerCase()) || n >= max) continue;
    done.add(q.toLowerCase());
    n++;
    try {
      out.push(...(await adapter.search(q, ctx)));
    } catch (e) {
      if (isAbort(e)) throw e;
    }
  }
  return out;
}

/** Дополняет тайтл данными из поиска (там бывает anilist_id и точная дата). */
function enrich(t: SiteTitle, byKey: Map<string, SiteTitle>): SiteTitle {
  const s = byKey.get(t.key);
  if (!s) return t;
  return {
    ...t,
    anilistId: t.anilistId ?? s.anilistId,
    date: t.date ?? s.date,
    format: t.format ?? s.format,
    formatLabel: t.formatLabel ?? s.formatLabel,
    cover: t.cover ?? s.cover,
    names: [...new Set([...t.names, ...s.names])],
  };
}

/** Поиск оставшихся узлов по их названию. Принимаем только проверенное совпадение (id или название + год). */
async function searchMissing(ids: number[], g: FranchiseGraph, matches: Map<number, SiteMatch>, deps: Deps) {
  const { adapter, ctx, user } = deps;
  if (!adapter.search) return;
  const search = adapter.search.bind(adapter);
  const rejected = user.rejected();
  const taken = new Set([...matches.values()].map((m) => m.title.key));
  const run = limiter(2);
  await Promise.all(
    ids.slice(0, 10).map((id) =>
      run(async () => {
        const al = g.nodes.get(id);
        if (!al) return;
        try {
          const found = await search(al.romaji, ctx);
          const m = matchTitles([al], found.filter((t) => !taken.has(t.key)), rejected).get(id);
          if (m && m.confidence !== 'date') matches.set(id, m);
        } catch (e) {
          if (isAbort(e)) throw e;
        }
      }),
    ),
  );
}

function toItem(n: OrderedNode, g: FranchiseGraph, matches: Map<number, SiteMatch>, adapter: SiteAdapter): OrderItem {
  const al = g.nodes.get(n.id)!;
  const match = matches.get(n.id);
  const title = match?.title.displayName ?? al.english ?? al.romaji;
  return {
    watchKey: `al:${n.id}`,
    alId: n.id,
    title,
    subtitle: title !== al.romaji ? al.romaji : undefined,
    format: al.format,
    formatLabel: FORMAT_LABEL[al.format],
    date: al.startDate,
    kind: n.kind,
    index: n.index,
    isCurrent: n.id === g.rootId,
    flags: [...n.flags],
    match,
    searchUrl: match ? undefined : adapter.searchUrl(al.romaji),
    cover: al.cover?.medium ?? match?.title.cover,
    coverLarge: al.cover?.large ?? al.cover?.medium ?? match?.title.cover,
  };
}

/** Порядок только по связям сайта: без AniList дат и графа нет, поэтому порядок помечаем как неточный. */
function siteOnly(current: SiteTitle, related: SiteTitle[], adapter: SiteAdapter, notes: string[]): OrderResult {
  const item = (t: SiteTitle, isCurrent: boolean): OrderItem => ({
    watchKey: t.anilistId ? `al:${t.anilistId}` : `site:${adapter.id}:${t.key}`,
    alId: t.anilistId,
    title: t.displayName,
    format: t.format ?? 'UNKNOWN',
    formatLabel: t.formatLabel,
    date: t.date,
    kind: 'main',
    isCurrent,
    flags: isCurrent ? [] : [t.relationLabel ?? 'связь'],
    match: { title: t, confidence: 'site' },
    cover: t.cover,
    coverLarge: t.cover,
  });
  const byDate = (a: SiteTitle, b: SiteTitle) => dateKey(a.date) - dateKey(b.date);
  const pre = related.filter((t) => t.relationKind === 'prequel').sort(byDate);
  const seq = related.filter((t) => t.relationKind === 'sequel').sort(byDate);
  const rest = related.filter((t) => t.relationKind !== 'prequel' && t.relationKind !== 'sequel').sort(byDate);
  return {
    mode: 'site-only',
    franchiseKey: `site:${adapter.id}:${current.key}`,
    items: [...pre.map((t) => item(t, false)), item(current, true), ...seq.map((t) => item(t, false))],
    branches: rest.map((t) => ({ ...item(t, false), kind: 'other' as const })),
    notes: [...notes, 'Порядок собран только по связям сайта, без дат выхода: может быть неточным.'],
  };
}

export async function buildWatchOrder(key: string, deps: Deps): Promise<OrderResult> {
  const { adapter, ctx, user } = deps;
  let current = await adapter.loadCurrent(key, ctx);
  const notes: string[] = [];
  let related: SiteTitle[] = [];
  try {
    const result = await adapter.loadRelated(current, ctx);
    related = result.titles.filter((t) => t.format !== 'MUSIC');
    if (result.partial) notes.push('Часть связей с сайта не загрузилась, список может быть неполным.');
  } catch (e) {
    if (isAbort(e)) throw e;
    notes.push('Не удалось загрузить связи с сайта.');
  }

  // поиск по каталогу сайта: даёт anilist_id тем, у кого его нет в карточке и связях
  const queried = new Set<string>();
  const searched = await searchFranchise(current.names.map(baseName), queried, deps);
  current = enrich(current, new Map(searched.map((t) => [t.key, t])));

  let rootId: number | undefined;
  let g: FranchiseGraph;
  try {
    rootId = await resolveRoot(current, deps);
    if (rootId === undefined) {
      return siteOnly(current, related, adapter, [...notes, 'Тайтл не найден в AniList однозначно.']);
    }
    g = await loadGraph(rootId, deps);
    if (!g.nodes.has(rootId)) return siteOnly(current, related, adapter, [...notes, 'AniList не вернул данные тайтла.']);
  } catch (e) {
    if (isAbort(e)) throw e;
    return siteOnly(current, related, adapter, [...notes, `AniList недоступен (${e instanceof Error ? e.message : 'ошибка'}).`]);
  }
  if (g.truncated) notes.push('Франшиза большая: показана часть, обход упёрся в лимит.');

  const root = g.nodes.get(rootId)!;
  const ordering = buildOrdering(g);
  // самый ранний тайтл основной линии обычно несёт общее название франшизы
  const first = g.nodes.get(ordering.main[0]?.id ?? rootId)!;
  const queries = [baseName(first.romaji), baseName(first.english), baseName(root.romaji), baseName(root.english)];
  searched.push(...(await searchFranchise(queries, queried, deps)));
  const byKey = new Map(searched.map((t) => [t.key, t]));
  const pool = [current, ...related.filter((t) => t.key !== current.key).map((t) => enrich(t, byKey))];
  const poolKeys = new Set(pool.map((t) => t.key));
  // кандидаты: связи сайта + результаты поиска; результаты поиска без проверенного совпадения не показываются
  const candidates = [...pool, ...[...byKey.values()].filter((t) => !poolKeys.has(t.key))];
  const matches = matchTitles(g.nodes.values(), candidates, user.rejected());
  // текущий тайтл сопоставлен по определению, остальные привязки к нему снимаем
  for (const [id, m] of matches) if (m.title.key === current.key && id !== rootId) matches.delete(id);
  matches.set(rootId, { title: current, confidence: current.anilistId ? 'id' : 'name' });

  const unmatched = ordering.all.map((n) => n.id).filter((id) => !matches.has(id));
  await searchMissing(unmatched, g, matches, deps);

  if (ordering.main.length === 0) notes.push('Порядок не определён.');

  const used = new Set([...matches.values()].map((m) => m.title.key));
  const orphans: OrderItem[] = pool
    .filter((t) => !used.has(t.key) && t.relationKind !== 'other')
    .map((t) => ({
      watchKey: `site:${adapter.id}:${t.key}`,
      title: t.displayName,
      format: t.format ?? 'UNKNOWN',
      formatLabel: t.formatLabel,
      date: t.date,
      kind: 'other',
      isCurrent: false,
      flags: ['не сопоставлено с AniList'],
      match: { title: t, confidence: 'site' },
      cover: t.cover,
      coverLarge: t.cover,
    }));

  return {
    mode: 'anilist',
    // ключ франшизы для своего порядка: самый ранний тайтл основной линии одинаков на всех её страницах
    franchiseKey: `al:${ordering.main[0]?.id ?? rootId}`,
    items: ordering.all.map((n) => toItem(n, g, matches, adapter)),
    branches: [...ordering.branches.map((n) => toItem(n, g, matches, adapter)), ...orphans],
    notes,
  };
}
