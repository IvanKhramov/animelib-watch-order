import { describe, expect, it } from 'vitest';
import { buildOrdering, FLAG_AMBIGUOUS } from '../src/orderPolicy';
import { fixtureGraph, graph, media } from './helpers';

const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

describe('buildOrdering', () => {
  it('ставит две части сезона и OVA между сезонами по дате', () => {
    const g = graph(3, [
      media(1, 'Show', 2021, 'TV', [['SEQUEL', 2]], 1),
      media(2, 'Show Part 2', 2021, 'TV', [['SEQUEL', 3], ['SIDE_STORY', 9]], 10),
      media(9, 'Show OVA', 2022, 'OVA', [['PARENT', 2]], 4),
      media(3, 'Show II', 2023, 'TV', [], 7),
    ]);
    const o = buildOrdering(g);
    expect(ids(o.main)).toEqual([1, 2, 3]);
    expect(o.main.map((n) => n.index)).toEqual([1, 2, 3]);
    expect(ids(o.all)).toEqual([1, 2, 9, 3]);
    expect(o.all.find((n) => n.id === 9)?.kind).toBe('extra');
  });

  it('текущий тайтл в середине цепочки, обратные связи достраиваются', () => {
    // у 2 нет ссылки на 1, есть только 1 -> SEQUEL 2
    const g = graph(2, [
      media(1, 'A', 2010, 'TV', [['SEQUEL', 2]]),
      media(2, 'B', 2012, 'TV', [['SEQUEL', 3]]),
      media(3, 'C', 2014, 'TV', []),
    ]);
    expect(ids(buildOrdering(g).main)).toEqual([1, 2, 3]);
  });

  it('цикл в связях не вешает и помечает неоднозначность', () => {
    const g = graph(1, [
      media(1, 'A', 2010, 'TV', [['SEQUEL', 2]]),
      media(2, 'B', 2011, 'TV', [['SEQUEL', 3]]),
      media(3, 'C', 2012, 'TV', [['SEQUEL', 1]]),
    ]);
    const o = buildOrdering(g);
    expect(new Set(ids(o.main))).toEqual(new Set([1, 2, 3]));
    expect(o.main.some((n) => n.flags.includes(FLAG_AMBIGUOUS))).toBe(true);
  });

  it('дубли рёбер не дают дублей в выдаче', () => {
    const g = graph(1, [
      media(1, 'A', 2010, 'TV', [['SEQUEL', 2], ['SEQUEL', 2]]),
      media(2, 'B', 2011, 'TV', [['PREQUEL', 1], ['PREQUEL', 1]]),
    ]);
    expect(ids(buildOrdering(g).all)).toEqual([1, 2]);
  });

  it('альтернатива и спин-офф уходят в ветки, а не в основную линию', () => {
    const g = graph(1, [
      media(1, 'A', 2010, 'TV', [['ALTERNATIVE', 5], ['SPIN_OFF', 6]]),
      media(5, 'A Remake', 2020, 'TV', [['SEQUEL', 7]]),
      media(7, 'A Remake 2', 2022, 'TV', []),
      media(6, 'A Spin', 2015, 'ONA', []),
    ]);
    const o = buildOrdering(g);
    expect(ids(o.main)).toEqual([1]);
    expect(o.branches.map((n) => [n.id, n.kind])).toEqual([
      [6, 'spinoff'],
      [5, 'alternative'],
      [7, 'alternative'],
    ]);
  });

  it('сайд-стори без сиквелов: линия строится от родителя', () => {
    const g = graph(9, [
      media(1, 'A', 2010, 'TV', [['SEQUEL', 2], ['SIDE_STORY', 9]]),
      media(2, 'B', 2012, 'TV', []),
      media(9, 'A OVA', 2011, 'OVA', [['PARENT', 1]]),
    ]);
    const o = buildOrdering(g);
    expect(ids(o.main)).toEqual([1, 2]);
    expect(ids(o.all)).toEqual([1, 9, 2]);
  });

  it('Mushoku Tensei: основная линия из реального снимка AniList', () => {
    const o = buildOrdering(fixtureGraph('mushoku'));
    const romaji = (id: number) => fixtureGraph('mushoku').nodes.get(id)!.romaji;
    expect(o.main.map((n) => romaji(n.id))).toEqual([
      'Mushoku Tensei: Isekai Ittara Honki Dasu',
      'Mushoku Tensei: Isekai Ittara Honki Dasu Part 2',
      'Mushoku Tensei II: Isekai Ittara Honki Dasu',
      'Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2',
      'Mushoku Tensei III: Isekai Ittara Honki Dasu',
      'Mushoku Tensei III: Isekai Ittara Honki Dasu Part 2',
    ]);
    // OVA про Эрис между первым и вторым сезоном
    const all = o.all.map((n) => romaji(n.id));
    const eris = all.findIndex((t) => /Eris/.test(t));
    expect(eris).toBeGreaterThan(all.indexOf('Mushoku Tensei: Isekai Ittara Honki Dasu Part 2'));
    expect(eris).toBeLessThan(all.indexOf('Mushoku Tensei II: Isekai Ittara Honki Dasu'));
  });

  it('Bocchi: рекапы в цепочке сиквелов без номера', () => {
    const o = buildOrdering(fixtureGraph('bocchi'));
    const numbered = o.main.filter((n) => n.index !== undefined);
    expect(numbered.length).toBe(2);
    expect(o.main.filter((n) => n.kind === 'recap').length).toBe(2);
  });

  it('Steins;Gate: S;G 0 в альтернативной ветке, а не в основной линии', () => {
    const g = fixtureGraph('steinsgate');
    const o = buildOrdering(g);
    const zero = [...g.nodes.values()].find((m) => m.romaji === 'Steins;Gate 0')!;
    expect(o.main.some((n) => n.id === zero.id)).toBe(false);
    expect(o.branches.find((n) => n.id === zero.id)?.kind).toBe('alternative');
  });
});


describe('правила франшиз', () => {
  it('SUMMARY направлен к пересказу, PARENT обычной OVA не делает её пересказом', () => {
    const nodes = [
      media(1, 'Original', 2010, 'TV', [['SUMMARY', 2], ['SEQUEL', 2], ['SIDE_STORY', 4]]),
      media(2, 'Film', 2011, 'MOVIE', [['PARENT', 1], ['SEQUEL', 3]]),
      media(3, 'Next', 2012),
      media(4, 'Bonus', 2011, 'OVA', [['PARENT', 1]]),
    ];
    const o = buildOrdering(graph(2, nodes));
    expect(o.all.find((n) => n.id === 2)).toMatchObject({ kind: 'recap', index: undefined });
    expect(o.all.find((n) => n.id === 4)?.kind).toBe('extra');
    expect(o.main.filter((n) => n.index).map((n) => n.id)).toEqual([1, 3]);
  });

  it('COMPILATION и конкурирующие связи не зависят от порядка узлов и рёбер', () => {
    const a = media(1, 'Original', 2010, 'TV', [['SEQUEL', 3], ['SIDE_STORY', 2], ['COMPILATION', 2]]);
    const b = media(2, 'Koyomi Vamp', 2024, 'MOVIE', [['PARENT', 1]]);
    const c = media(3, 'Next', 2012, 'TV', [['SIDE_STORY', 2]]);
    for (const nodes of [[a, b, c], [c, b, { ...a, edges: [...a.edges].reverse() }]]) {
      expect(buildOrdering(graph(1, nodes)).all.find((n) => n.id === 2)?.kind).toBe('recap');
    }
  });

  it('из альтернатив с общим приквелом выбирает встроенный сериал и сохраняет его продолжение', () => {
    const g = graph(1, [
      media(1, 'Prequel', 2010, 'TV', [['SEQUEL', 2], ['SEQUEL', 3]]),
      media(2, 'Film', 2011, 'MOVIE', [['ALTERNATIVE', 3]]),
      media(3, 'Series', 2014, 'TV', [['SEQUEL', 4]]),
      media(4, 'Series 2', 2015),
    ]);
    const o = buildOrdering(g);
    expect(ids(o.main)).toEqual([1, 3, 4]);
    expect(o.branches.find((n) => n.id === 2)?.kind).toBe('alternative');
  });

  it('при равных связях предпочитает TV, затем число эпизодов', () => {
    const g = graph(1, [
      media(1, 'Prequel', 2010, 'TV', [['SEQUEL', 2], ['SEQUEL', 3], ['SEQUEL', 4]]),
      { ...media(2, 'Film', 2011, 'MOVIE', [['ALTERNATIVE', 3]]), episodes: 100 },
      { ...media(3, 'Short TV', 2014, 'TV', [['ALTERNATIVE', 4]]), episodes: 12 },
      { ...media(4, 'Long TV', 2015, 'TV', [['ALTERNATIVE', 2]]), episodes: 24 },
    ]);
    expect(ids(buildOrdering(g).main)).toEqual([1, 4]);
  });

  it('исключает продолжение альтернативного маршрута, но сохраняет общее продолжение', () => {
    const o = buildOrdering(graph(1, [
      media(1, 'Prequel', 2010, 'TV', [['SEQUEL', 2], ['SEQUEL', 3]]),
      media(2, 'TV', 2011, 'TV', [['ALTERNATIVE', 3], ['SEQUEL', 5], ['SEQUEL', 6]]),
      media(3, 'Film', 2012, 'MOVIE', [['SEQUEL', 4]]),
      media(4, 'Film 2', 2013, 'MOVIE', [['SEQUEL', 6]]),
      media(5, 'TV 2', 2014),
      media(6, 'Common ending', 2015, 'MOVIE'),
    ]));
    expect(ids(o.main)).toEqual([1, 2, 5, 6]);
    expect(ids(o.branches)).toEqual([3, 4]);
  });

  it('перед альтернативным эпизодом ставит ранний TV и его приквелы, без его сиквелов', () => {
    const nodes = [
      media(1, 'Prologue', 2009, 'TV', [['SEQUEL', 2]]),
      media(2, 'Original', 2011, 'TV', [['ALTERNATIVE', 3], ['SEQUEL', 5]]),
      media(3, '23 beta', 2015, 'OVA', [['SEQUEL', 4]]),
      media(4, 'Zero', 2018),
      media(5, 'Original OVA', 2012, 'OVA'),
    ];
    const zero = buildOrdering(graph(4, nodes));
    expect(ids(zero.main)).toEqual([1, 2, 3, 4]);
    expect(zero.main[1]?.flags).toContain('предыстория по другой ветке');
    const original = buildOrdering(graph(2, nodes));
    expect(ids(original.main)).toEqual([1, 2, 5]);
    expect(original.branches.find((n) => n.id === 4)?.kind).toBe('alternative');
  });
});


it('Madoka: два фильма-пересказа с ALTERNATIVE не вытесняют оригинальный сериал', () => {
  const o = buildOrdering(graph(11977, [
    media(9756, 'Madoka', 2011, 'TV', [['ALTERNATIVE', 11977], ['ALTERNATIVE', 11979], ['SEQUEL', 11981]]),
    media(11977, 'Hajimari', 2012, 'MOVIE', [['SEQUEL', 11979]]),
    media(11979, 'Eien', 2012, 'MOVIE', [['SEQUEL', 11981]]),
    media(11981, 'Rebellion', 2013, 'MOVIE'),
  ]));
  expect(o.main.filter((n) => n.index).map((n) => n.id)).toEqual([9756, 11981]);
  expect(o.all.filter((n) => n.kind === 'recap').map((n) => [n.id, n.index])).toEqual([
    [11977, undefined], [11979, undefined],
  ]);
});
