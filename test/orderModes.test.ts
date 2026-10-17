import { describe, expect, it } from 'vitest';
import { findProfile, rowKey, selectOrder } from '../src/orderModes';
import type { OrderProfile } from '../src/orderProfiles';
import { ORDER_PROFILES } from '../src/orderProfiles';
import type { OrderItem, OrderResult } from '../src/types';

const item = (id: number, year?: number, extra: Partial<OrderItem> = {}): OrderItem => ({
  watchKey: `al:${id}`, alId: id, title: `Title ${id}`, kind: 'main', format: 'TV',
  date: year ? { year } : undefined, isCurrent: id === 1, flags: [], ...extra,
});
const result = (): OrderResult => ({
  mode: 'anilist', rootAlId: 1, franchiseKey: 'al:1',
  items: [item(1, 2010), item(2, 2005)], branches: [item(3, 2015, { kind: 'alternative' }), item(4)], notes: [],
});
const profile: OrderProfile = {
  id: 'fixture', title: 'Fixture', anchorIds: [1, 2, 3], checkedAt: '2026-10-17',
  recommended: { steps: [{ alId: 1 }, { alId: 3 }, { alId: 2, optional: true }], note: 'Первый просмотр.', sources: [{ label: 'Источник', url: 'https://example.org/recommended' }] },
  chronological: { steps: [{ alId: 2 }, { alId: 1 }], note: 'События.', sources: [{ label: 'Хронология', url: 'https://example.org/timeline' }] },
};

describe('режимы порядка', () => {
  it('каталог содержит источники, уникальные точки входа и однозначные шаги', () => {
    const anchors = new Set<number>();
    for (const entry of ORDER_PROFILES) {
      expect(entry.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const id of entry.anchorIds) {
        expect(anchors.has(id)).toBe(false);
        anchors.add(id);
      }
      for (const route of [entry.recommended, entry.chronological].filter((r) => r !== undefined)) {
        expect(route.steps.length).toBeGreaterThan(0);
        expect(route.sources.length).toBeGreaterThan(0);
        expect(route.sources.every((source) => source.url.startsWith('https://'))).toBe(true);
        const keys = route.steps.map((step) => `${step.alId}:${step.episodes ?? 'full'}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(route.steps.every((step) => Number.isInteger(step.alId) && step.alId > 0 && entry.anchorIds.includes(step.alId))).toBe(true);
      }
    }
  });

  it('Monogatari начинает с Bake, вставляет Hana внутрь Second Season и Koyomi перед Owari', () => {
    const entry = ORDER_PROFILES.find((p) => p.id === 'monogatari')!;
    const steps = entry.recommended.steps;
    const ids = steps.map((step) => step.alId);
    expect(ids[0]).toBe(5081);
    const first = ids.indexOf(17074);
    expect(steps.slice(first, first + 3).map((step) => [step.alId, step.episodes])).toEqual([[17074, '1–11'], [20593, undefined], [17074, '12–26']]);
    expect(ids.indexOf(21520)).toBeLessThan(ids.indexOf(21262));
    expect(entry.chronological).toBeUndefined();
  });

  it('даты имеют приоритет над связями только в режиме выхода; неизвестные в конце', () => {
    const res = selectOrder(result(), 'release', [profile]);
    expect(res.items.map((i) => i.alId)).toEqual([2, 1, 3, 4]);
    expect(res.branches).toEqual([]);
    expect(res.verified).toBe(false);
  });

  it('профиль возвращает нужную ветку в маршрут и отдельно оставляет непроверенные части', () => {
    const res = selectOrder(result(), 'recommended', [profile]);
    expect(res.items.map((i) => [i.alId, i.kind])).toEqual([[1, 'main'], [3, 'main'], [2, 'extra']]);
    expect(res.branches.map((i) => i.alId)).toEqual([4]);
    expect(res.branches[0]!.flags).toContain('вне проверенного маршрута');
    expect(res.sources[0]!.url).toBe('https://example.org/recommended');
    expect(res.verified).toBe(true);
  });

  it('у каждого режима собственные источники и порядок, а отметки общие', () => {
    const a = selectOrder(result(), 'recommended', [profile]);
    const b = selectOrder(result(), 'chronological', [profile]);
    expect(b.items.map((i) => i.alId)).toEqual([2, 1]);
    expect(b.sources[0]!.url).toBe('https://example.org/timeline');
    expect(b.items[1]!.watchKey).toBe(a.items[0]!.watchKey);
    expect(b.orderKey).not.toBe(a.orderKey);
  });

  it('отсутствие профиля не выдаёт автоматическую сортировку за проверенную хронологию', () => {
    const a = selectOrder(result(), 'recommended', []);
    expect(a.verified).toBe(false);
    expect(a.explanation).toContain('Автоматический');
    const b = selectOrder(result(), 'chronological', []);
    expect(b.available).toBe(false);
    expect(b.items).toEqual([]);
    expect(b.explanation).toContain('Проверенной хронологии');
  });

  it('причина отсутствия событийного маршрута берётся из профиля', () => {
    const res = selectOrder(result(), 'chronological', [{ ...profile, chronological: undefined, chronologyUnavailable: 'Нужна карта эпизодов.' }]);
    expect(res.explanation).toBe('Нужна карта эпизодов.');
    expect(res.available).toBe(false);
  });

  it('диапазоны одного сезона сохраняются отдельными строками с общей отметкой', () => {
    const p = { ...profile, recommended: { ...profile.recommended, steps: [{ alId: 1, episodes: '1–11' }, { alId: 3 }, { alId: 1, episodes: '12–26' }] } };
    const res = selectOrder(result(), 'recommended', [p]);
    expect(res.items.map((i) => i.episodes)).toEqual(['1–11', undefined, '12–26']);
    expect(new Set(res.items.map(rowKey)).size).toBe(3);
    expect(res.items[0]!.watchKey).toBe(res.items[2]!.watchKey);
    // Повторный диапазон — отдельный шаг, а не дополнительная карточка сайта без номера.
    expect(res.items[2]!.continuation).not.toBe(true);
    const updated = { ...p, recommended: { ...p.recommended, steps: [{ alId: 2 }, ...p.recommended.steps] } };
    const next = selectOrder(result(), 'recommended', [updated]);
    expect(next.items.slice(1).map(rowKey)).toEqual(res.items.map(rowKey));
  });

  it('карточки, на которые сайт разделил запись, сохраняются в проверенном маршруте', () => {
    const raw = result();
    raw.items.push(item(1, 2011, { watchKey: 'site:part2', continuation: true, isCurrent: false }));
    const res = selectOrder(raw, 'recommended', [profile]);
    expect(res.items.slice(0, 2).map((i) => i.watchKey)).toEqual(['al:1', 'site:part2']);
    expect(new Set(res.items.map(rowKey)).size).toBe(res.items.length);
  });

  it('не приписывает диапазон всей записи каждой отдельной карточке сайта', () => {
    const raw = result();
    raw.items.push(item(1, 2011, { watchKey: 'site:part2', continuation: true }));
    const p = { ...profile, recommended: { ...profile.recommended, steps: [{ alId: 1, episodes: '1–11' }] } };
    const res = selectOrder(raw, 'recommended', [p]);
    expect(res.items.every((i) => i.episodes === undefined)).toBe(true);
    expect(res.items[0]!.flags.join(' ')).toContain('нумерация карточек сайта может отличаться');
  });

  it('при неполном графе предупреждает об отсутствующих частях, не создаёт ссылки', () => {
    const p = { ...profile, recommended: { ...profile.recommended, steps: [{ alId: 1 }, { alId: 1000 }] } };
    const res = selectOrder(result(), 'recommended', [p]);
    expect(res.items.map((i) => i.alId)).toEqual([1]);
    expect(res.notes.join(' ')).toContain('Список неполный');
  });

  it('профиль определяется по странице, а не по соседу-кроссоверу', () => {
    expect(findProfile({ ...result(), rootAlId: 999 }, [profile])).toBeUndefined();
    expect(findProfile({ ...result(), mode: 'site-only' }, [profile])).toBeUndefined();
  });

  it('ключ правок общий между страницами профиля, старый ключ доступен для миграции', () => {
    const a = selectOrder(result(), 'recommended', [profile]);
    const b = selectOrder({ ...result(), rootAlId: 3, franchiseKey: 'al:3' }, 'recommended', [profile]);
    expect(b.orderKey).toBe(a.orderKey);
    expect(b.legacyOrderKeys).toContain('al:3');
  });

  it('переключение не мутирует исходные данные и не дублирует флаги', () => {
    const raw = result();
    const before = structuredClone(raw);
    selectOrder(raw, 'recommended', [profile]);
    selectOrder(raw, 'release', [profile]);
    selectOrder(raw, 'chronological', [profile]);
    expect(raw).toEqual(before);
  });
});
