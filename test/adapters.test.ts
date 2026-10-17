// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AniListClient, parseMedia } from '../src/anilistAdapter';
import { parseIsoDate, parseRuDate } from '../src/dates';
import { HttpError, withRetry, type HttpRequest, type Transport } from '../src/http';
import { parseAnimegoPage, relationKind } from '../src/sites/animego';
import { parseLibMedia, parseRelations } from '../src/sites/animelib';
import { baseName } from '../src/watchOrder';

describe('dates', () => {
  it('разбирает русские даты AnimeLib', () => {
    expect(parseRuDate('12 января 2019 г.')).toEqual({ year: 2019, month: 1, day: 12 });
    expect(parseRuDate('19 мая 2021 г.')).toEqual({ year: 2021, month: 5, day: 19 });
    expect(parseRuDate('03 марта 2020 г.')).toEqual({ year: 2020, month: 3, day: 3 });
    expect(parseRuDate('2027 г.')).toEqual({ year: 2027 });
    expect(parseRuDate('')).toBeUndefined();
    expect(parseIsoDate('2021-07-03')).toEqual({ year: 2021, month: 7, day: 3 });
  });
});

describe('AnimeLib', () => {
  it('берёт из связей только аниме', () => {
    const rel = parseRelations({
      data: [
        { related_type: { id: 2, label: 'Источник' }, media: { model: 'manga', name: 'LN', slug_url: '1--ln' } },
        {
          related_type: { id: 4, label: 'Продолжение' },
          media: { model: 'anime', name: 'Show II', rus_name: 'Шоу 2', slug_url: '2--show-ii-anime', type: { label: 'TV Сериал' } },
        },
      ],
    });
    expect(rel).toHaveLength(1);
    expect(rel[0]!.title.format).toBe('TV');
    expect(rel[0]!.title.url).toBe('https://animelib.org/ru/anime/2--show-ii-anime');
  });

  it('переживает мусор в ответе', () => {
    expect(parseRelations(null)).toEqual([]);
    expect(parseRelations({ data: [1, 'x', { media: {} }] })).toEqual([]);
    expect(parseLibMedia({ name: 'no slug' })).toBeUndefined();
  });

  it('baseName даёт общее название франшизы', () => {
    expect(baseName('Haikyuu!! To the Top Part 2')).toBe('Haikyuu!! To the Top');
    expect(baseName('Mushoku Tensei II: Isekai Ittara Honki Dasu')).toBe('Mushoku Tensei');
    expect(baseName('Реинкарнация')).toBeUndefined();
  });
});

describe('animego', () => {
  it('разбирает страницу тайтла и блок «Связанное»', () => {
    const html = readFileSync('test/fixtures/animego-page.html', 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const url = new URL('https://animego.me/anime/moya-reinkarnaciya-v-otome-igre-v-kachestve-glavnoy-zlodeyki-2-1808');
    const p = parseAnimegoPage(doc as unknown as Document, url);
    expect(p.title.names).toContain('My Next Life as a Villainess: All Routes Lead to Doom! X');
    expect(p.title.date).toEqual({ year: 2021, month: 7, day: 3 });
    expect(p.title.format).toBe('TV');
    const prequel = p.related.find((r) => r.relationKind === 'prequel');
    expect(prequel?.key).toBe('/anime/moya-reinkarnaciya-v-otome-igre-v-kachestve-glavnoy-zlodeyki-1517');
    expect(prequel?.date?.year).toBe(2020);
    expect(p.related.find((r) => r.formatLabel === 'Фильм')?.relationKind).toBe('sequel');
  });

  it('классифицирует подписи связей', () => {
    expect(relationKind('Предыстория')).toBe('prequel');
    expect(relationKind('Продолжение')).toBe('sequel');
    expect(relationKind('Альтернативная история')).toBe('story');
  });
});

describe('AniList', () => {
  it('отбрасывает некорректные Media', () => {
    expect(parseMedia({ id: 'x', type: 'ANIME' })).toBeUndefined();
    expect(parseMedia({ id: 1, type: 'MANGA' })).toBeUndefined();
    expect(parseMedia({ id: 1, type: 'ANIME', relations: { edges: [{ relationType: 'WAT', node: { id: 2, type: 'ANIME' } }] } })?.edges).toEqual([]);
  });

  it('берёт обложку только по https', () => {
    const base = { id: 1, type: 'ANIME', title: { romaji: 'X' } };
    expect(parseMedia({ ...base, coverImage: { medium: 'https://s4.anilist.co/a.jpg' } })?.cover?.medium).toBe('https://s4.anilist.co/a.jpg');
    expect(parseMedia({ ...base, coverImage: { medium: 'javascript:alert(1)' } })?.cover).toBeUndefined();
  });

  it('обход графа не зацикливается и соблюдает лимит узлов', async () => {
    // кольцо из 200 тайтлов: каждый сиквел следующего
    const transport: Transport = async (req: HttpRequest) => {
      const { ids } = (JSON.parse(req.body!) as { variables: { ids: number[] } }).variables;
      const media = ids.map((id) => ({
        id,
        type: 'ANIME',
        format: 'TV',
        startDate: { year: 2000 },
        title: { romaji: `T${id}` },
        relations: { edges: [{ relationType: 'SEQUEL', node: { id: (id % 200) + 1, type: 'ANIME', format: 'TV' } }] },
      }));
      return { status: 200, text: JSON.stringify({ data: { Page: { media } } }) };
    };
    const g = await new AniListClient(transport).loadFranchise(1, undefined, { maxNodes: 30, maxRequests: 100 });
    expect(g.nodes.size).toBeLessThanOrEqual(30);
    expect(g.truncated).toBe(true);
  });

  it('ошибка AniList превращается в исключение, а не в пустой граф', async () => {
    const t: Transport = async () => ({ status: 200, text: '<html>oops' });
    await expect(new AniListClient(t).getByIds([1])).rejects.toBeInstanceOf(HttpError);
  });
});

describe('withRetry', () => {
  it('повторяет 429 и 5xx, затем отдаёт успех', async () => {
    let n = 0;
    const t = withRetry(async () => ({ status: ++n < 3 ? (n === 1 ? 429 : 503) : 200, text: 'ok' }), { baseDelayMs: 1 });
    expect((await t({ url: 'x' })).status).toBe(200);
    expect(n).toBe(3);
  });

  it('не повторяет 404', async () => {
    let n = 0;
    const t = withRetry(async () => ({ status: (n++, 404), text: '' }), { baseDelayMs: 1 });
    expect((await t({ url: 'x' })).status).toBe(404);
    expect(n).toBe(1);
  });
});
