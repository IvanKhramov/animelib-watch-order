import { describe, expect, it, vi } from 'vitest';
import { AniListClient } from '../src/anilistAdapter';
import { CommunityOrdersClient } from '../src/communityOrders';
import { cachedWatchOrder, FRANCHISE_TTL } from '../src/franchiseCache';
import { AbortError } from '../src/http';
import { pairKey } from '../src/matching';
import type { LoadCtx, SiteAdapter } from '../src/sites/site';
import { CACHE_SCHEMA, Cache, DAY, HOUR, memoryKV, UserState, type KV } from '../src/storage';
import type { FranchiseGraph, OrderResult, SiteTitle } from '../src/types';
import { buildWatchOrder } from '../src/watchOrder';
import { graph, media } from './helpers';

function setup(kv: KV = memoryKV(), site = 'cache-fixture') {
  let now = 0;
  const titles: SiteTitle[] = [1, 2].map((id) => ({
    key: id === 1 ? 'first' : 'second', anilistId: id,
    names: [id === 1 ? 'Cache Saga' : 'Cache Saga 2'], displayName: `Season ${id}`,
    url: `https://example.org/${site}/${id}`, format: 'TV', date: { year: 2019 + id },
  }));
  let reusableRootIds = [1, 2];
  let truncated = false;
  let partial = false;
  let nodes = [media(1, 'Cache Saga', 2020, 'TV', [['SEQUEL', 2]]),
    media(2, 'Cache Saga 2', 2021, 'TV', [['PREQUEL', 1]])];
  const currentRequest = vi.fn(async (key: string) => structuredClone(titles.find((t) => t.key === key)!));
  const relatedRequest = vi.fn(async (key: string) => ({ titles: structuredClone(titles.filter((t) => t.key !== key)), partial }));
  const adapter: SiteAdapter = {
    id: site, pageKey: () => null, findAnchor: () => null,
    loadCurrent: vi.fn((key, ctx) => ctx.cache.wrap(`fixture-current:${site}`, key, DAY, () => currentRequest(key), ctx.force)),
    loadRelated: vi.fn((current, ctx) => ctx.cache.wrap(`fixture-related:${site}`, current.key, DAY, () => relatedRequest(current.key), ctx.force)),
    search: vi.fn(async () => structuredClone(titles)), searchUrl: (q) => `https://example.org/search?q=${encodeURIComponent(q)}`,
  };
  const anilist = new AniListClient(vi.fn(async () => { throw new Error('Unexpected network request'); }));
  const loadGraph = vi.spyOn(anilist, 'loadFranchise').mockImplementation(async (id): Promise<FranchiseGraph> => ({
    ...graph(id, structuredClone(nodes)), reusableRootIds: [...reusableRootIds], truncated,
  }));
  const alSearch = vi.spyOn(anilist, 'search').mockResolvedValue([]);
  const byIds = vi.spyOn(anilist, 'getByIds').mockResolvedValue([]);
  const community = new CommunityOrdersClient(vi.fn(async () => { throw new Error('Unexpected network request'); }));
  const communityLoad = vi.spyOn(community, 'load').mockResolvedValue({});
  vi.spyOn(community, 'peek').mockReturnValue(undefined);
  const deps = (force = false, controller = new AbortController()) => ({
    adapter, anilist, community, user: new UserState(kv),
    ctx: { cache: new Cache(kv, () => now), signal: controller.signal, force } satisfies LoadCtx,
  });
  const calls = () => [adapter.loadCurrent, adapter.loadRelated, adapter.search!, loadGraph, alSearch, byIds, communityLoad]
    .map((fn) => vi.mocked(fn).mock.calls.length);
  return { kv, titles, adapter, anilist, community, deps, calls, currentRequest, relatedRequest, loadGraph,
    setTime: (value: number) => { now = value; },
    configure: (options: { roots?: number[]; truncated?: boolean; partial?: boolean; nodes?: typeof nodes }) => {
      reusableRootIds = options.roots ?? reusableRootIds;
      truncated = options.truncated ?? truncated;
      partial = options.partial ?? partial;
      nodes = options.nodes ?? nodes;
    } };
}

const all = (result: OrderResult) => [...result.items, ...result.branches];

describe('готовый порядок и общий снимок франшизы', () => {
  it('перезагрузка страницы с новым Cache/UserState не вызывает адаптеры или API и возвращает независимую копию', async () => {
    const s = setup();
    const first = await buildWatchOrder('first', s.deps());
    const before = s.calls();
    first.items[0]!.title = 'Changed only by the caller';
    const reloaded = await buildWatchOrder('first', s.deps());
    expect(s.calls()).toEqual(before);
    expect(reloaded.items.map((item) => item.alId)).toEqual([1, 2]);
    expect(reloaded.items[0]!.title).not.toBe('Changed only by the caller');
  });

  it('переход между раскрытыми сезонами меняет root/current и сохраняет порядок без новых запросов', async () => {
    const s = setup();
    await buildWatchOrder('first', s.deps());
    const before = s.calls();
    const second = await buildWatchOrder('second', s.deps());
    expect(s.calls()).toEqual(before);
    expect(second.rootAlId).toBe(2);
    expect(second.items.map((item) => item.alId)).toEqual([1, 2]);
    expect(all(second).filter((item) => item.isCurrent).map((item) => item.match?.title.key)).toEqual(['second']);
    expect((await buildWatchOrder('first', s.deps())).items.find((item) => item.isCurrent)?.alId).toBe(1);
  });

  it('просмотренное и свой порядок живут отдельно от общего raw-снимка', async () => {
    const s = setup();
    const first = await buildWatchOrder('first', s.deps());
    const keys = first.items.map((item) => item.watchKey);
    const user = new UserState(s.kv);
    user.setWatched(keys[0]!, true);
    user.setCustomOrder(first.franchiseKey, { order: [...keys].reverse(), hidden: [keys[1]!] });
    const before = s.calls();
    const second = await buildWatchOrder('second', s.deps());
    const reloaded = s.deps();
    expect(reloaded.user.isWatched(keys[0]!)).toBe(true);
    expect(reloaded.user.customOrder(first.franchiseKey)).toEqual({ order: [...keys].reverse(), hidden: [keys[1]!] });
    expect(second.items.map((item) => item.watchKey)).toEqual(keys);
    expect(s.calls()).toEqual(before);
  });

  it('переход на другой сезон не продлевает 12 часов и после TTL обходит нижние суточные и трёхдневные кэши', async () => {
    const s = setup();
    await buildWatchOrder('first', s.deps());
    s.setTime(6 * HOUR);
    await buildWatchOrder('second', s.deps());
    const before = s.calls();
    s.setTime(FRANCHISE_TTL + 1);
    await buildWatchOrder('second', s.deps());
    expect(s.calls()[0]).toBe(before[0]! + 1);
    expect(s.calls()[1]).toBe(before[1]! + 1);
    expect(s.calls()[2]).toBeGreaterThan(before[2]!);
    expect(s.loadGraph).toHaveBeenLastCalledWith(2, expect.any(AbortSignal));
    expect(s.currentRequest).toHaveBeenCalledTimes(2);
    expect(s.relatedRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(s.adapter.loadCurrent).mock.calls.at(-1)![1].force).toBe(true);
  });

  it('force на первом сезоне инвалидирует подготовленную страницу второго сезона', async () => {
    const s = setup();
    await buildWatchOrder('first', s.deps());
    await buildWatchOrder('second', s.deps());
    s.titles[1]!.displayName = 'Updated second season';
    await buildWatchOrder('first', s.deps(true));
    expect(cachedWatchOrder('second', s.deps())).toBeUndefined();
    const before = s.calls();
    const second = await buildWatchOrder('second', s.deps());
    expect(second.items.find((item) => item.alId === 2)?.title).toBe('Updated second season');
    expect(s.calls()).toEqual(before);
  });

  it('force на собственной линии SIDE_STORY обновляет прежний общий снимок, даже когда franchiseKey изменился', async () => {
    const s = setup();
    s.titles.push(...[3, 4].map((id): SiteTitle => ({
      key: id === 3 ? 'side' : 'side-second', anilistId: id,
      names: [id === 3 ? 'Side Saga' : 'Side Saga 2'], displayName: `Side season ${id}`,
      url: `https://example.org/side/${id}`, format: 'TV', date: { year: 2020 + id },
    })));
    s.configure({ roots: [1, 2, 3, 4], nodes: [
      media(1, 'Cache Saga', 2020, 'TV', [['SEQUEL', 2], ['SIDE_STORY', 3]]),
      media(2, 'Cache Saga 2', 2021, 'TV', [['PREQUEL', 1]]),
      media(3, 'Side Saga', 2023, 'TV', [['PARENT', 1], ['SEQUEL', 4]]),
      media(4, 'Side Saga 2', 2024, 'TV', [['PREQUEL', 3]]),
    ] });
    const original = await buildWatchOrder('first', s.deps());
    const beforeSide = s.calls();
    const side = await buildWatchOrder('side', s.deps());
    expect(s.calls()).toEqual(beforeSide);
    expect(original.franchiseKey).toBe('al:1');
    expect(side.franchiseKey).toBe('al:3');
    expect(side.items.filter((item) => item.kind === 'main').map((item) => item.alId)).toEqual([3, 4]);
    s.titles[0]!.displayName = 'Fresh original from side refresh';
    await buildWatchOrder('side', s.deps(true));
    expect(cachedWatchOrder('first', s.deps())).toBeUndefined();
    const beforeOriginal = s.calls();
    const refreshed = await buildWatchOrder('first', s.deps());
    expect(s.calls()).toEqual(beforeOriginal);
    expect(refreshed.items.find((item) => item.isCurrent)?.title).toBe('Fresh original from side refresh');
  });

  it('сбой поиска сокращает срок снимка до пяти минут, после восстановления ссылки догружаются', async () => {
    const s = setup();
    s.relatedRequest.mockResolvedValue({ titles: [], partial: false });
    vi.mocked(s.adapter.search!).mockRejectedValue(new Error('Temporary catalogue failure'));
    const incomplete = await buildWatchOrder('first', s.deps());
    expect(incomplete.items.find((item) => item.alId === 2)?.match).toBeUndefined();
    expect(incomplete.notes.some((note) => note.includes('поиска по каталогу'))).toBe(true);
    const before = s.calls();
    s.setTime(HOUR / 12 - 1);
    await buildWatchOrder('first', s.deps());
    expect(s.calls()).toEqual(before);
    vi.mocked(s.adapter.search!).mockImplementation(async () => structuredClone(s.titles));
    s.setTime(HOUR / 12 + 1);
    const restored = await buildWatchOrder('first', s.deps());
    expect(s.calls()[2]).toBeGreaterThan(before[2]!);
    expect(restored.items.find((item) => item.alId === 2)?.match?.title.key).toBe('second');
    expect(restored.notes.some((note) => note.includes('поиска по каталогу'))).toBe(false);
    expect(s.loadGraph).toHaveBeenCalledTimes(2);
  });

  it('новое отклонённое сопоставление не возвращает старую ссылку из подготовленного результата', async () => {
    const s = setup();
    await buildWatchOrder('first', s.deps());
    s.deps().user.reject(pairKey(2, 'second'));
    expect(cachedWatchOrder('first', s.deps())).toBeUndefined();
    const result = await buildWatchOrder('first', s.deps());
    expect(result.items.find((item) => item.alId === 2)?.match).toBeUndefined();
    expect(s.deps().user.rejected().has(pairKey(2, 'second'))).toBe(true);
  });

  it('не алиасит альтернативы, листовые/нераскрытые узлы и неполные обходы как полноценные точки входа', async () => {
    for (const scenario of ['alternative', 'leaf', 'unexpanded', 'partial', 'truncated'] as const) {
      const s = setup();
      s.configure({ roots: scenario === 'partial' ? [1, 2] : [1], partial: scenario === 'partial', truncated: scenario === 'truncated',
        nodes: [media(1, 'Cache Saga', 2020, 'TV', [[scenario === 'alternative' ? 'ALTERNATIVE' : scenario === 'leaf' ? 'OTHER' : 'SEQUEL', 2]]),
          media(2, 'Cache Saga 2', 2021, 'TV', [['PREQUEL', 1]])] });
      await buildWatchOrder('first', s.deps());
      const before = vi.mocked(s.adapter.loadCurrent).mock.calls.length;
      await buildWatchOrder('second', s.deps());
      expect(vi.mocked(s.adapter.loadCurrent).mock.calls.length, scenario).toBe(before + 1);
      expect(s.loadGraph.mock.calls.at(-1)![0], scenario).toBe(2);
    }
  });

  it('две карточки частей одной записи AniList не становятся алиасами полных корней', async () => {
    const s = setup();
    s.configure({ roots: [1], nodes: [media(1, 'Cache Saga Part 1', 2020)] });
    s.titles[0]!.names = ['Cache Saga Part 1'];
    Object.assign(s.titles[1]!, { anilistId: 1, names: ['Cache Saga Part 2'], date: { year: 2020 } });
    const first = await buildWatchOrder('first', s.deps());
    expect(first.items.filter((item) => item.alId === 1)).toHaveLength(2);
    const before = vi.mocked(s.adapter.loadCurrent).mock.calls.length;
    await buildWatchOrder('second', s.deps());
    expect(vi.mocked(s.adapter.loadCurrent).mock.calls.length).toBe(before + 1);
  });

  it('поздний ответ отменённой загрузки не затирает успешный force и нижний Cache.wrap', async () => {
    const s = setup();
    let resolveOld!: (value: SiteTitle) => void;
    s.currentRequest.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldController = new AbortController();
    const old = buildWatchOrder('first', s.deps(false, oldController)).catch((error: unknown) => error);
    await Promise.resolve();
    oldController.abort();
    s.titles[0]!.displayName = 'Fresh force result';
    await buildWatchOrder('first', s.deps(true));
    const before = s.calls();
    resolveOld({ ...s.titles[0]!, displayName: 'Stale cancelled result' });
    expect(await old).toBeInstanceOf(AbortError);
    const latest = await buildWatchOrder('first', s.deps());
    expect(latest.items.find((item) => item.isCurrent)?.title).toBe('Fresh force result');
    expect(s.calls()).toEqual(before);
    const current = await s.adapter.loadCurrent('first', s.deps().ctx);
    expect(current.displayName).toBe('Fresh force result');
    expect(s.currentRequest).toHaveBeenCalledTimes(2);
  });

  it('одинаковые ключи страниц разных сайтов не разделяют подготовленный результат', async () => {
    const kv = memoryKV();
    const a = setup(kv, 'site-a');
    const b = setup(kv, 'site-b');
    await buildWatchOrder('first', a.deps());
    b.titles[0]!.displayName = 'Site B first season';
    const result = await buildWatchOrder('first', b.deps());
    expect(result.items.find((item) => item.isCurrent)?.title).toBe('Site B first season');
    expect(b.adapter.loadCurrent).toHaveBeenCalledTimes(1);
    expect(b.adapter.loadRelated).toHaveBeenCalledTimes(1);
    expect(result.items.find((item) => item.isCurrent)?.match?.title.url).toContain('/site-b/');
  });

  it('битый подготовленный снимок и переполненное prepared-хранилище не ломают успешную загрузку', async () => {
    const s = setup();
    await buildWatchOrder('first', s.deps());
    s.kv.set(`cache:${CACHE_SCHEMA}:prepared-order:franchise:cache-fixture:al:1`, { exp: DAY, v: { rejected: '[]', pages: null } });
    const repaired = await buildWatchOrder('first', s.deps());
    expect(repaired.mode).toBe('anilist');
    const kv = memoryKV();
    const full: KV = { ...kv, set: (key, value) => { if (key.includes(':prepared-order:')) throw new Error('Quota exceeded'); kv.set(key, value); } };
    const quota = setup(full);
    expect((await buildWatchOrder('first', quota.deps())).items.map((item) => item.alId)).toEqual([1, 2]);
  });
});
