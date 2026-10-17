import { describe, expect, it } from 'vitest';
import { matchParts, matchTitles, normalizeTitle, pairKey, pickVerified } from '../src/matching';
import type { SiteMatch, SiteTitle } from '../src/types';
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


describe('уточнение названия датой', () => {
  it('Kaguya: точный год различает сезоны с потерянным вопросительным знаком', () => {
    const cur = site('cur', ['Love is War'], { date: { year: 2019, month: 1, day: 12 } });
    const first = { ...media(1, 'Love is War', 2019), startDate: cur.date! };
    const second = media(2, 'Love is War?', 2020);
    expect(pickVerified(cur, [first, second])?.id).toBe(1);
    expect(matchTitles([first, second], [cur]).get(1)?.confidence).toBe('name');
  });

  it('при одинаковом годе выбирает полную дату, при оставшемся равенстве не выбирает', () => {
    const cur = site('cur', ['Show'], { date: { year: 2020, month: 4, day: 1 } });
    const first = { ...media(1, 'Show', 2020), startDate: cur.date! };
    const second = { ...media(2, 'Show', 2020), startDate: { year: 2020, month: 1, day: 1 } };
    expect(pickVerified(cur, [second, first])?.id).toBe(1);
    expect(pickVerified(cur, [first, { ...first, id: 3 }])).toBeUndefined();
    expect(matchTitles([first], [cur, site('other', ['Show'], { date: second.startDate })]).get(1)?.title.key).toBe('cur');
  });
});

describe('отдельные карточки частей', () => {
  const al = media(1, 'Stone Ocean Part 2', 2022, 'ONA');
  const primary = site('part2', ['Stone Ocean Part 2'], { anilistId: 1, date: { year: 2022 }, format: 'ONA' });
  const part3 = site('part3', ['Stone Ocean Part 3'], { date: { year: 2022 }, format: 'ONA' });
  const matches = new Map([[1, { title: primary, confidence: 'id' as const }]]);

  it('показывает следующую часть той же записи', () => {
    expect(matchParts([al], matches, [primary, part3]).get(1)?.map((m) => m.title.key)).toEqual(['part3']);
  });

  it('не склеивает другие форматы, даты, ID, занятые, отклонённые и неоднозначные карточки', () => {
    for (const changed of [{ format: 'MOVIE' as const }, { date: { year: 2025 } }, { anilistId: 2 }]) {
      expect(matchParts([al], matches, [primary, { ...part3, ...changed }]).size).toBe(0);
    }
    expect(matchParts([al], matches, [part3], new Set([pairKey(1, 'part3')])).size).toBe(0);
    expect(matchParts([al], new Map<number, SiteMatch>([...matches, [2, { title: part3, confidence: 'name' }]]), [part3]).size).toBe(0);
    expect(matchParts([al], matches, [part3, { ...part3, key: 'duplicate' }]).size).toBe(0);
    expect(matchParts([al], matches, [{ ...part3, names: ['Stone Ocean Part 4'] }]).size).toBe(0);
  });

  it('Frozen Bond подтверждена составной записью 100049, похожие названия не принимаются', () => {
    const memory = site('13329--rezero-kara-hajimeru-isekai-seikatsu-memory-snow-anime', ['Memory Snow'], { format: 'MOVIE', date: { year: 2018 } });
    const frozen = site('14685--rezero-kara-hajimeru-isekai-seikatsu-hyouketsu-no-kizuna-anime', ['Frozen Bond'], { format: 'MOVIE', date: { year: 2019 } });
    const m = new Map([[100049, { title: memory, confidence: 'id' as const }]]);
    const node = media(100049, 'Re:Zero OVAs', 2018, 'OVA');
    expect(matchParts([node], m, [frozen]).get(100049)?.[0]?.title).toBe(frozen);
    expect(matchParts([node], m, [{ ...frozen, key: 'unverified' }]).size).toBe(0);
  });
});
