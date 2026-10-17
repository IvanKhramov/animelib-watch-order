import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The Node-only data importer deliberately has no runtime TypeScript dependency.
import { extractShikiRoutes, normalizeShikimoriCatalogue, resolveShikimoriMappings } from '../scripts/import-shikimori-orders.mjs';

type Club = { id: number; description_html: string; animes?: { id: number; url: string }[] };
type Parsed = { routes: { title: string; steps: { malId: number; title: string }[] }[]; stats: { inputProfiles: number; skippedRoutes: number; skipReasons: Record<string, number> } };
type Catalogue = {
  updatedAt: string;
  profiles: { id: string; title: string; checkedAt: string; anchorIds: number[]; recommended: { steps: unknown[] }; chronological: { steps: { alId: number; title: string }[]; sources: { url: string }[] }; limitations: string[] }[];
  stats: { importedProfiles: number; skippedRoutes: number; skipReasons: Record<string, number> };
};
const extract = extractShikiRoutes as (raw: unknown) => Parsed;
const normalize = normalizeShikimoriCatalogue as (raw: unknown, mapping: Record<number, number> | Map<number, number>, retrievedAt: string) => Catalogue;
const resolveMappings = resolveShikimoriMappings as (club: Club, wiki: unknown, supplied?: unknown) => Promise<Record<number, number>>;
const retrievedAt = '2026-10-17T12:00:00.000Z';
const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const anime = (id: number, title = `Title ${id}`, type = 'anime') => `<a href="https://shikimori.io/animes/z${id}-title" data-attrs="${escaped(JSON.stringify({ id, type }))}">${escaped(title)}</a>`;
const item = (id: number, extra = '') => `<li>${anime(id)}${extra}</li>`;
const franchise = (title = 'Fixture', items = `${item(1)}${item(2)}`) => `<div class="b-spoiler_block"><span>Франшиза: ${escaped(title)}</span><div><ul class="b-list">${items}</ul></div></div>`;
const club = (html = franchise()): Club => ({ id: 2881, description_html: `<div>${html}</div>` });
const wiki = (ids: number[]) => ({ data: [{ watch_orders: [{ steps: ids.map((id) => ({ media: { id: id + 1000, idMal: id } })) }] }] });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Shikimori club chronology importer', () => {
  it('maps explicit MAL IDs without assuming ID equality and keeps the source age visible', () => {
    const input = club();
    const before = structuredClone(input);
    const result = normalize(input, { 1: 5432, 2: 7689 }, retrievedAt);
    expect(result.profiles[0]!.anchorIds).toEqual([5432, 7689]);
    expect(result.profiles[0]!.chronological.steps.map((step) => step.alId)).toEqual([5432, 7689]);
    expect(result.profiles[0]!.recommended.steps).toEqual([]);
    expect(result.profiles[0]!.checkedAt).toBe('2020-06-26');
    expect(result.updatedAt).toBe(retrievedAt);
    expect(result.profiles[0]!.limitations[0]).toContain('2020');
    expect(result.profiles[0]!.chronological.sources[0]!.url).toBe('https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime');
    expect(input).toEqual(before);
  });

  it.each(['Не проверено', 'Неполный список', 'НЕ ПРОВЕРЕНО'])('detects the trailing sibling quality flag %s without applying it to the next franchise', (flag) => {
    const input = club(`${franchise('Bad')} <span><span>${flag}</span></span><br>${franchise('Good', `${item(3)}${item(4)}`)}`);
    const result = normalize(input, { 1: 1001, 2: 1002, 3: 1003, 4: 1004 }, retrievedAt);
    expect(result.profiles.map((profile) => profile.title)).toEqual(['Good']);
    expect(result.stats.skipReasons['quality-flag']).toBe(1);
  });

  it('handles multiple direct lists exactly as returned by the club API', () => {
    const html = '<div class="b-spoiler_block"><span>Франшиза: Direct</span><div>' +
      `<ul class="b-list">${item(1)}</ul><ul class="b-list">${item(2)}</ul></div></div>`;
    expect(extract(club(html)).routes[0]!.steps.map((step) => step.malId)).toEqual([1, 2]);
  });

  it('rejects the entire route for nested spoilers and never extracts their links as extra steps', () => {
    const nested = `<span><div class="b-spoiler"><label>❖❖❖</label><div>Между сериями 5 и 6 ${anime(99)}</div></div></span>`;
    const result = extract(club(franchise('Complex', `${item(1, nested)}${item(2)}`)));
    expect(result.routes).toEqual([]);
    expect(result.stats.skipReasons['nested-instructions']).toBe(1);
  });

  it('does not mistake a nested franchise-shaped block for a separate route', () => {
    const result = extract(club(franchise('Outer', `${item(1, franchise('Fake'))}${item(2)}`)));
    expect(result.stats.inputProfiles).toBe(1);
    expect(result.routes).toEqual([]);
  });

  it.each([' (после пятой серии)', ' Эпизоды 1–5', '<span>серии 2–8</span>', ' или другая версия'])('rejects unresolved instructions outside the anime anchor: %s', (extra) => {
    expect(extract(club(franchise('Complex', `${item(1, extra)}${item(2)}`))).routes).toEqual([]);
  });

  it('rejects ranges in link labels but allows an actual standalone special called Episode 0', () => {
    expect(extract(club(franchise('Ranges', `<li>${anime(1, 'Сериал, эпизоды 1–5')}</li>${item(2)}`))).routes).toEqual([]);
    expect(extract(club(franchise('Special', `<li>${anime(1, 'Спецвыпуск: Эпизод 0')}</li>${item(2)}`))).routes).toHaveLength(1);
  });

  it('rejects multiple anime options, duplicate whole titles, and unresolved literal BBCode', () => {
    for (const items of [
      `<li>${anime(1)} или ${anime(2)}</li>${item(3)}`,
      `${item(1)}${item(2)}${item(1)}`,
      `${item(1)}<li>[anime=42496]Season 3[/anime]</li>`,
    ]) expect(extract(club(franchise('Unsafe', items))).routes).toEqual([]);
  });

  it('ignores contributor credits without turning them into anime steps', () => {
    const credit = '<br>Автор:<a class="b-user16" href="https://shikimori.io/Contributor"><img src="https://shikimori.io/avatar.png"><span>Contributor</span></a>';
    const result = extract(club(franchise('Credits', `${item(1)}${item(2, credit)}`)));
    expect(result.routes[0]!.steps.map((step) => step.malId)).toEqual([1, 2]);
  });

  it('rejects a complete source route when even one MAL→AniList mapping is missing', () => {
    const result = normalize(club(), { 1: 1001 }, retrievedAt);
    expect(result.profiles).toEqual([]);
    expect(result.stats.skipReasons['missing-media-mapping']).toBe(1);
    expect(normalize(club(), { 1: 1001, 2: 10000000 }, retrievedAt).profiles).toEqual([]);
  });

  it('rejects distinct source IDs that collapse to one AniList title without known segments', () => {
    expect(normalize(club(), { 1: 1001, 2: 1001 }, retrievedAt).stats.skipReasons['duplicate-anilist-id']).toBe(1);
  });

  it('keeps profile IDs stable across title translations and corrected AniList mappings', () => {
    const first = normalize(club(franchise('English title')), { 1: 1001, 2: 1002 }, retrievedAt);
    const next = normalize(club(franchise('Русское название')), new Map([[1, 2001], [2, 2002]]), retrievedAt);
    expect(first.profiles[0]!.id).toBe('shikimori:2881-1');
    expect(next.profiles[0]!.id).toBe(first.profiles[0]!.id);
  });

  it('uses the explicit anime JSON inventory only for an exact source URL match', () => {
    const input = club(franchise('Inventory', '<li><a href="https://shikimori.io/animes/z1-title">First</a></li>' + item(2)));
    input.animes = [{ id: 1, url: '/animes/z1-title' }];
    expect(extract(input).routes[0]!.steps.map((step) => step.malId)).toEqual([1, 2]);
    input.animes = [{ id: 1, url: '/animes/z1-other' }];
    expect(extract(input).routes).toEqual([]);
  });

  it('does not execute source HTML or retrieve external resources', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    expect(() => extract(club(`<script>globalThis.__shikiExecuted = true</script>${franchise()}`))).toThrow('unsafe club HTML');
    expect(() => extract(club(`<iframe src="https://example.org"></iframe>${franchise()}`))).toThrow('unsafe club HTML');
    expect((globalThis as Record<string, unknown>).__shikiExecuted).toBeUndefined();
    expect(extract(club()).routes).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('limits route length and rejects unknown club IDs or malformed timestamps', () => {
    const items = Array.from({ length: 81 }, (_, i) => item(i + 1)).join('');
    expect(extract(club(franchise('Long', items))).stats.skipReasons['route-step-limit']).toBe(1);
    expect(() => extract({ id: 999, description_html: franchise() })).toThrow('invalid club');
    expect(() => normalize(club(), { 1: 1001, 2: 1002 }, 'yesterday')).toThrow('retrieval date');
  });
});

describe('Shikimori exact ID resolver', () => {
  it('reuses verified wiki pairs and makes no lookup when all IDs are known', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    expect(await resolveMappings(club(), wiki([1, 2]))).toEqual({ 1: 1001, 2: 1002 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a supplied map for reproducible offline import and never fetches even unresolved IDs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    expect(await resolveMappings(club(), wiki([1]), { 2: 9002 })).toEqual({ 1: 1001, 2: 9002 });
    expect(await resolveMappings(club(), wiki([1]), {})).toEqual({ 1: 1001 });
    expect(fetch).not.toHaveBeenCalled();
    await expect(resolveMappings(club(), wiki([1]), { 1: 9001 })).rejects.toThrow('conflicting supplied mapping');
  });

  it('does not look up IDs mentioned only in rejected quality-flagged routes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    const raw = club(`${franchise('Bad', `${item(99)}${item(100)}`)}<span>Не проверено</span>${franchise('Good')}`);
    expect(await resolveMappings(raw, wiki([1, 2]))).toEqual({ 1: 1001, 2: 1002 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves sequential batches of at most 50 IDs with at least 2.5 seconds between starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(retrievedAt));
    const starts: number[] = [], batches: number[][] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const ids = (JSON.parse(String(options?.body)) as { variables: { ids: number[] } }).variables.ids;
      starts.push(Date.now()); batches.push(ids);
      return new Response(JSON.stringify({ data: { Page: { media: ids.map((idMal) => ({ id: idMal + 1000, idMal })) } } }), { status: 200 });
    });
    const html = franchise('First', Array.from({ length: 40 }, (_, i) => item(i + 1)).join('')) +
      franchise('Second', Array.from({ length: 21 }, (_, i) => item(i + 41)).join(''));
    const pending = resolveMappings(club(html), wiki([]));
    await vi.runAllTimersAsync();
    const mappings = await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(batches.map((batch) => batch.length)).toEqual([50, 11]);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(2500);
    expect(mappings[61]).toBe(1061);
    expect(Object.keys(mappings)).toHaveLength(61);
  });

  it('keeps missing API records unresolved rather than inventing an AniList ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { Page: { media: [] } } }), { status: 200 }));
    const mappings = await resolveMappings(club(), wiki([1]));
    expect(mappings).toEqual({ 1: 1001 });
    expect(normalize(club(), mappings, retrievedAt).profiles).toEqual([]);
  });

  it('rejects malformed API responses and media returned for an unrequested MAL ID', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { Page: { media: [{ id: 1234, idMal: 999 }] } } })));
    await expect(resolveMappings(club(), wiki([1]))).rejects.toThrow('invalid AniList media mapping');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: 'failed' }] })));
    await expect(resolveMappings(club(), wiki([1]))).rejects.toThrow('invalid AniList mapping response');
  });
});
