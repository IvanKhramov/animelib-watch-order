import { describe, expect, it, vi } from 'vitest';
import { AniListClient } from '../src/anilistAdapter';
import { CommunityOrdersClient } from '../src/communityOrders';
import { Cache, memoryKV, UserState } from '../src/storage';
import type { SiteAdapter } from '../src/sites/site';
import type { SiteTitle } from '../src/types';
import { baseName, buildWatchOrder } from '../src/watchOrder';
import { profileForId } from '../src/orderProfiles';
import { selectOrder } from '../src/orderModes';
import { graph, media } from './helpers';
import snapshot from '../data/community-orders.json';

const title = (key: string, name: string, anilistId?: number): SiteTitle => ({
  key, names: [name], displayName: name, url: `https://animelib.org/ru/anime/${key}`, anilistId,
});

function setup(nodes = [media(1, 'Root', 2020)]) {
  const current = title('current', 'Root', 1);
  const search = vi.fn(async (_q: string): Promise<SiteTitle[]> => []);
  const adapter: SiteAdapter = {
    id: 'test', pageKey: () => null, findAnchor: () => null,
    loadCurrent: async () => current,
    loadRelated: async () => ({ titles: [], partial: false }),
    search, searchUrl: (q) => `https://animelib.org/ru/catalog?q=${q}`,
  };
  const anilist = new AniListClient(async () => { throw new Error('unexpected transport'); });
  vi.spyOn(anilist, 'loadFranchise').mockResolvedValue(graph(1, nodes));
  vi.spyOn(anilist, 'search').mockResolvedValue([]);
  const kv = memoryKV();
  const deps = { adapter, anilist, user: new UserState(kv), ctx: { cache: new Cache(kv), signal: new AbortController().signal, force: false } };
  return { deps, search, current };
}

describe('поиск по каталогу', () => {
  it('новый профиль в кэшированной ветке сначала загружает все недостающие части', async () => {
    const nodes = [media(999999, 'Outer', 2000, 'TV', [['SIDE_STORY', 9253]]), media(9253, 'Steins;Gate', 2011)];
    const { deps, current } = setup(nodes);
    current.anilistId = 999999;
    const sg = title('sg', 'Steins;Gate', 9253);
    deps.adapter.loadCurrent = async (key) => key === 'sg' ? sg : current;
    deps.adapter.loadRelated = async () => ({ titles: [sg, current], partial: false });
    vi.mocked(deps.anilist.loadFranchise).mockImplementation(async (rootId) => ({
      ...graph(rootId, nodes), reusableRootIds: [999999, 9253],
    }));
    const ids = [...new Set(profileForId(9253)!.recommended.steps.map((step) => step.alId))].filter((id) => id !== 9253);
    const get = vi.spyOn(deps.anilist, 'getByIds').mockResolvedValue(ids.map((id) => media(id, `Part ${id}`, 2018)));
    await buildWatchOrder('current', deps);
    expect(get).not.toHaveBeenCalled();
    const result = await buildWatchOrder('sg', deps);
    expect(get).toHaveBeenCalledTimes(1);
    expect(selectOrder(result, 'recommended').items.map((i) => i.alId)).toEqual(profileForId(9253)!.recommended.steps.map((step) => step.alId));
    await buildWatchOrder('sg', deps);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('автоматически подхватывает внешний маршрут для франшизы вне ручного каталога', async () => {
    const { deps } = setup([media(1, 'Root', 2020)]);
    const remote = { version: 1, updatedAt: new Date(Date.parse(snapshot.updatedAt) + 24 * 3_600_000).toISOString(), profiles: [{
      id: 'community:test', title: 'Root', checkedAt: '2026-10-18', anchorIds: [1, 2],
      recommended: { steps: [{ alId: 2 }, { alId: 1 }], note: 'Маршрут сообщества.',
        sources: [{ label: 'r/anime', url: 'https://www.reddit.com/r/anime/wiki/watch_order/' }] },
    }] };
    const community = new CommunityOrdersClient(async () => ({ status: 200, text: JSON.stringify(remote) }));
    const extra = vi.spyOn(deps.anilist, 'getByIds').mockResolvedValue([media(2, 'Earlier', 2010)]);
    const result = await buildWatchOrder('current', { ...deps, community });
    expect(extra).toHaveBeenCalledWith([2], deps.ctx.signal);
    const selected = selectOrder(result, 'recommended');
    expect(selected.items.map((i) => i.alId)).toEqual([2, 1]);
    expect(selected.communityRoute).toBe(true);
    expect(selected.verified).toBe(false);
  });

  it('дополняет проверенный профиль по точным ID и кэширует пакет без выдуманных ссылок', async () => {
    const rootId = 9253;
    const { deps, current } = setup([media(rootId, 'Steins;Gate', 2011)]);
    current.anilistId = rootId;
    vi.mocked(deps.anilist.loadFranchise).mockResolvedValue(graph(rootId, [media(rootId, 'Steins;Gate', 2011)]));
    const ids = [...new Set(profileForId(rootId)!.recommended.steps.map((step) => step.alId))].filter((id) => id !== rootId);
    const get = vi.spyOn(deps.anilist, 'getByIds').mockResolvedValue(ids.map((id) => media(id, `Part ${id}`, 2018)));
    const res = await buildWatchOrder('current', deps);
    expect(get).toHaveBeenCalledTimes(1);
    expect(new Set(get.mock.calls[0]![0])).toEqual(new Set(ids));
    const selected = selectOrder(res, 'recommended');
    expect(selected.items.map((i) => i.alId)).toEqual(profileForId(rootId)!.recommended.steps.map((step) => step.alId));
    expect(selected.items.slice(1).every((i) => i.match === undefined)).toBe(true);
    await buildWatchOrder('current', deps);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('убирает TV и год из общего запроса', () => {
    expect(baseName('JoJo no Kimyou na Bouken (TV) (2012)')).toBe('JoJo no Kimyou na Bouken');
    expect(baseName('Re:Zero kara Hajimeru Isekai Seikatsu')).toBe('Re:Zero kara Hajimeru Isekai Seikatsu');
  });

  it('один ответ сопоставляется со всеми узлами, повторный прогон использует кэш', async () => {
    const { deps, search } = setup([
      media(1, 'Root', 2020, 'TV', [['SEQUEL', 2]]),
      media(2, 'Second', 2021, 'TV', [['SEQUEL', 3]]),
      media(3, 'Third', 2022),
    ]);
    search.mockImplementation(async (q) => q === 'Second' ? [title('second', 'Second', 2), title('third', 'Third', 3)] : []);
    const res = await buildWatchOrder('current', deps);
    expect(res.items.map((i) => i.match?.title.key)).toEqual(['current', 'second', 'third']);
    expect(search.mock.calls.map(([q]) => q)).toEqual(['Root', 'Second']);
    await buildWatchOrder('current', deps);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('новый ответ не стирает ID и названия уже известной карточки', async () => {
    const { deps, search } = setup([
      media(1, 'Root', 2020, 'TV', [['SEQUEL', 2]]),
      media(2, 'Second', 2021, 'TV', [['SEQUEL', 3]]),
      media(3, 'Third', 2022),
    ]);
    deps.adapter.loadRelated = async () => ({ partial: false, titles: [title('second', 'Known alias', 2)] });
    search.mockImplementation(async (q) => q === 'Third' ? [title('second', 'Unrelated name'), title('third', 'Third', 3)] : []);
    const res = await buildWatchOrder('current', deps);
    expect(res.items.find((i) => i.alId === 2)?.match).toMatchObject({ confidence: 'id', title: { key: 'second', names: ['Unrelated name', 'Known alias'] } });
  });

  it('совпадение только даты не привязывает чужую карточку из поиска', async () => {
    const { deps, search } = setup([
      media(1, 'Root', 2020, 'TV', [['SEQUEL', 2]]),
      { ...media(2, 'Second', 2021), startDate: { year: 2021, month: 4, day: 1 } },
    ]);
    search.mockResolvedValue([{ ...title('foreign', 'Foreign'), format: 'TV', date: { year: 2021, month: 4, day: 1 } }]);
    const res = await buildWatchOrder('current', deps);
    expect(res.items.find((i) => i.alId === 2)?.match).toBeUndefined();
  });

  it('пробует english и латинский синоним, ищет ветки', async () => {
    const { deps, search } = setup([
      media(1, 'Root', 2020, 'TV', [['SEQUEL', 2], ['ALTERNATIVE', 3]]),
      { ...media(2, 'Second', 2021), english: 'English', synonyms: ['日本語', 'Latin Alias'] },
      media(3, 'Branch', 2022),
    ]);
    search.mockImplementation(async (q) => q === 'Latin Alias' ? [title('second', 'Second', 2)] : q === 'Branch' ? [title('branch', 'Branch', 3)] : []);
    const res = await buildWatchOrder('current', deps);
    expect(search.mock.calls.map(([q]) => q)).toContain('English');
    expect(res.items.find((i) => i.alId === 2)?.match?.title.key).toBe('second');
    expect(res.branches.find((i) => i.alId === 3)?.match?.title.key).toBe('branch');
  });

  it('всего не больше 12 запросов, три зарезервированы веткам', async () => {
    const nodes = Array.from({ length: 16 }, (_, i) => media(i + 1, `Show ${i + 1}`, 2020, 'TV', i < 15 ? [['SEQUEL', i + 2]] : []));
    nodes[0]!.edges.push({ rel: 'ALTERNATIVE', id: 100, type: 'ANIME', format: 'TV' });
    nodes.push({ ...media(100, 'Branch', 2020), english: 'Branch English', synonyms: ['Branch Alias'] });
    const { deps, search } = setup(nodes);
    await buildWatchOrder('current', deps);
    expect(search).toHaveBeenCalledTimes(12);
    expect(search.mock.calls.slice(-3).map(([q]) => q)).toEqual(['Branch', 'Branch English', 'Branch Alias']);
  });

  it('отдельная карточка продолжения не получает номер и отдельный ключ AniList', async () => {
    const { deps, search, current } = setup([media(1, 'Stone Ocean Part 2', 2022, 'ONA')]);
    Object.assign(current, { names: ['Stone Ocean Part 2'], date: { year: 2022 }, format: 'ONA' });
    search.mockResolvedValue([{ ...title('part3', 'Stone Ocean Part 3'), date: { year: 2022 }, format: 'ONA' }]);
    const res = await buildWatchOrder('current', deps);
    expect(res.items.map((i) => [i.watchKey, i.index, i.continuation])).toEqual([
      ['al:1', 1, undefined], ['site:test:part3', undefined, true],
    ]);
    expect(res.branches).toEqual([]);
  });

  it('site-only сохраняет сюжетные story-цепочки при входе через обзор', async () => {
    const { deps, current } = setup();
    Object.assign(current, { anilistId: undefined, displayName: 'Атака титанов: Обзор за двадцать минут' });
    deps.adapter.loadRelated = async () => ({ partial: false, titles: [
      { ...title('original', 'Original'), relationKind: 'story', relationLabel: 'Развёрнутая история' },
      { ...title('second', 'Second'), relationKind: 'story', relationLabel: 'Продолжение' },
      { ...title('spin', 'Spin'), relationKind: 'story', relationLabel: 'Спин-офф' },
    ] });
    const res = await buildWatchOrder('current', deps);
    expect(res.mode).toBe('site-only');
    expect(res.items.map((i) => [i.match?.title.key, i.kind])).toEqual([
      ['original', 'main'], ['second', 'main'], ['current', 'recap'],
    ]);
    expect(res.branches.map((i) => i.match?.title.key)).toEqual(['spin']);
  });
});
