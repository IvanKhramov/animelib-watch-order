import { describe, expect, it } from 'vitest';
import { matchTitles, normalizeTitle, pairKey, pickVerified } from '../src/matching';
import type { SiteTitle } from '../src/types';
import { media } from './helpers';

const site = (key: string, names: string[], extra: Partial<SiteTitle> = {}): SiteTitle => ({
  key,
  url: `https://animelib.org/ru/anime/${key}`,
  displayName: names[0]!,
  names,
  ...extra,
});

describe('normalizeTitle', () => {
  it('убирает пунктуацию и регистр', () => {
    expect(normalizeTitle('Mushoku Tensei~ Isekai Ittara Honki Dasu!')).toBe('mushoku tensei isekai ittara honki dasu');
    expect(normalizeTitle('Steins;Gate 0')).toBe('steins gate 0');
  });
});

describe('matchTitles', () => {
  it('id важнее названия', () => {
    const al = [media(10, 'Show', 2020)];
    const m = matchTitles(al, [site('a', ['Show']), site('b', ['Other'], { anilistId: 10 })]);
    expect(m.get(10)?.title.key).toBe('b');
    expect(m.get(10)?.confidence).toBe('id');
  });

  it('точное название с совместимым годом', () => {
    const m = matchTitles([media(1, 'Show Part 2', 2021)], [site('x', ['Шоу 2', 'Show Part 2'], { date: { year: 2021 } })]);
    expect(m.get(1)?.confidence).toBe('name');
  });

  it('не сопоставляет при расхождении года', () => {
    const m = matchTitles([media(1, 'Show', 2001)], [site('x', ['Show'], { date: { year: 2019 } })]);
    expect(m.size).toBe(0);
  });

  it('неоднозначность: два тайтла сайта с одним названием, сопоставления нет', () => {
    const m = matchTitles([media(1, 'Show', 2020)], [site('x', ['Show']), site('y', ['Show'])]);
    expect(m.size).toBe(0);
  });

  it('чужой anilist_id блокирует совпадение по названию', () => {
    const m = matchTitles([media(1, 'Show', 2020)], [site('x', ['Show'], { anilistId: 2 })]);
    expect(m.size).toBe(0);
  });

  it('несовместимый формат блокирует совпадение', () => {
    const m = matchTitles([media(1, 'Show', 2020, 'MOVIE')], [site('x', ['Show'], { format: 'TV' })]);
    expect(m.size).toBe(0);
  });

  it('отклонённая пользователем пара не сопоставляется', () => {
    const m = matchTitles([media(1, 'Show', 2020)], [site('x', ['Show'])], new Set([pairKey(1, 'x')]));
    expect(m.size).toBe(0);
  });

  it('по одному русскому названию не сопоставляет', () => {
    const m = matchTitles([media(1, 'Kimi no Na wa.', 2016, 'MOVIE')], [site('x', ['Твоё имя'])]);
    expect(m.size).toBe(0);
  });
});

describe('pickVerified', () => {
  it('выбирает единственный проверенный результат поиска', () => {
    const cur = site('cur', ['Рус', 'Show II']);
    expect(pickVerified(cur, [media(1, 'Show', 2010), media(2, 'Show II', 2012)])?.id).toBe(2);
  });

  it('не выбирает, если совпадений несколько', () => {
    const cur = site('cur', ['Show']);
    expect(pickVerified(cur, [media(1, 'Show', 2010), media(2, 'Show', 2012)])).toBeUndefined();
  });
});
