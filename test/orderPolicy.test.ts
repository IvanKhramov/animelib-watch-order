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
