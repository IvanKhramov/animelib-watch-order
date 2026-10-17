// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AniListClient } from '../src/anilistAdapter';
import { AbortError, type Transport } from '../src/http';
import { createAnimego } from '../src/sites/animego';
import { createAnimeLib, detectApiBase, isTrustedApiUrl } from '../src/sites/animelib';
import { Cache, memoryKV, UserState } from '../src/storage';
import type { SiteTitle } from '../src/types';
import { buildWatchOrder } from '../src/watchOrder';

const ctx = () => ({ signal: new AbortController().signal, cache: new Cache(memoryKV()), force: false });
const current: SiteTitle = { key: '1--show', url: 'https://animelib.org/ru/anime/1--show', displayName: 'Шоу', names: ['Шоу'] };
const relation = (key: string) => ({ related_type: { id: 4 }, media: { model: 'anime', name: 'Шоу', slug_url: key } });

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('доверенные API AnimeLib', () => {
  it.each([
    'https://cdnlibs.org', 'https://api.cdnlibs.org/api/anime',
    'https://deep.api.cdnlibs.org/api/auth', 'https://hentaicdn.org',
    'https://hapi.hentaicdn.org/api/constants', 'https://API.CDNLIBS.ORG/api/anime',
  ])('разрешает %s', (url) => expect(isTrustedApiUrl(url)).toBe(true));

  it.each([
    'https://api.cdnlibs.org.evil.com/api/anime', 'https://evilcdnlibs.org/api/auth',
    'https://evilhentaicdn.org', 'https://hentaicdn.org.evil.com',
    'http://api.cdnlibs.org/api/anime', 'http://hapi.hentaicdn.org',
    'https://api.cdnlibs.org@evil.com/api/anime', 'https://evil.com@api.cdnlibs.org',
    'javascript:alert(1)', '//api.cdnlibs.org/api/anime', 'not a url',
  ])('отклоняет %s', (url) => expect(isTrustedApiUrl(url)).toBe(false));

  it('пропускает чужие resource entries и выбирает доверенный API', () => {
    vi.stubGlobal('performance', { getEntriesByType: () => [
      { name: 'https://evil.com/api/anime' },
      { name: 'https://cdnlibs.org/picture.jpg' },
      { name: 'https://hapi.hentaicdn.org/api/constants' },
    ] });
    expect(detectApiBase()).toBe('https://hapi.hentaicdn.org');
  });

  it('отправляет токен на запасной API, игнорируя чужой хост', async () => {
    vi.stubGlobal('performance', { getEntriesByType: () => [{ name: 'https://evil.com/api/auth' }] });
    localStorage.setItem('auth', JSON.stringify({ token: { access_token: 'test-token' } }));
    const send = vi.fn<Transport>(async () => ({ status: 200, text: JSON.stringify({ data: { name: 'Шоу', slug_url: current.key } }) }));
    await createAnimeLib(send).loadCurrent(current.key, ctx());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringMatching(/^https:\/\/api\.cdnlibs\.org\/api\/anime\//),
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
    }));
  });
});

describe('неполные связи сайта', () => {
  it('AnimeLib сохраняет найденное и помечает ошибку соседа', async () => {
    const adapter = createAnimeLib(async (req) => {
      if (!req.url.includes(`anime/${current.key}/relations`)) throw new Error('offline');
      return { status: 200, text: JSON.stringify({ data: [relation('2--show')] }) };
    });
    const result = await adapter.loadRelated(current, ctx());
    expect(result.partial).toBe(true);
    expect(result.titles.map((t) => t.key)).toEqual(['2--show']);
  });

  it.each([new AbortError(), new DOMException('aborted', 'AbortError')])('AnimeLib пробрасывает отмену', async (error) => {
    const adapter = createAnimeLib(async (req) => {
      if (!req.url.includes(`anime/${current.key}/relations`)) throw error;
      return { status: 200, text: JSON.stringify({ data: [relation('2--show')] }) };
    });
    await expect(adapter.loadRelated(current, ctx())).rejects.toBe(error);
  });

  it('полностью загруженные связи не помечает частичными', async () => {
    const adapter = createAnimeLib(async () => ({ status: 200, text: '{"data":[]}' }));
    expect(await adapter.loadRelated(current, ctx())).toEqual({ titles: [], partial: false });
  });

  function animego(send: Transport) {
    const c = ctx();
    const title = { ...current, key: '/anime/show-1' };
    c.cache.set('ag-page', title.key, { title, related: [{ ...title, key: '/anime/show-2' }] }, 10000);
    return { adapter: createAnimego(send), c, title };
  }

  it('AnimeGO сохраняет связи текущей страницы при ошибке соседа', async () => {
    const { adapter, c, title } = animego(async () => { throw new Error('offline'); });
    const result = await adapter.loadRelated(title, c);
    expect(result.partial).toBe(true);
    expect(result.titles.map((t) => t.key)).toEqual(['/anime/show-2']);
  });

  it.each([new AbortError(), new DOMException('aborted', 'AbortError')])('AnimeGO пробрасывает отмену', async (error) => {
    const { adapter, c, title } = animego(async () => { throw error; });
    await expect(adapter.loadRelated(title, c)).rejects.toBe(error);
  });

  it('показывает предупреждение в результате порядка просмотра', async () => {
    const result = await buildWatchOrder(current.key, {
      adapter: {
        id: 'test', pageKey: () => current.key, findAnchor: () => null,
        loadCurrent: async () => current,
        loadRelated: async () => ({ titles: [], partial: true }),
        searchUrl: () => '',
      },
      anilist: new AniListClient(async () => { throw new Error('не должен вызываться'); }),
      user: new UserState(memoryKV()), ctx: ctx(),
    });
    expect(result.notes).toContain('Часть связей с сайта не загрузилась, список может быть неполным.');
  });
});
