import { describe, expect, it } from 'vitest';
import { applyOrder, move } from '../src/customOrder';
import { memoryKV, UserState } from '../src/storage';

describe('applyOrder', () => {
  it('без сохранённого порядка оставляет исходный', () => {
    expect(applyOrder(['a', 'b', 'c'], undefined)).toEqual(['a', 'b', 'c']);
  });

  it('применяет сохранённый порядок и выкидывает исчезнувшие', () => {
    expect(applyOrder(['a', 'b', 'c'], ['c', 'x', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('новый элемент встаёт после своего соседа по умолчанию', () => {
    // пользователь поставил c перед a; вышел новый сезон d после c
    expect(applyOrder(['a', 'b', 'c', 'd'], ['c', 'a', 'b'])).toEqual(['c', 'd', 'a', 'b']);
    expect(applyOrder(['n', 'a', 'b'], ['b', 'a'])).toEqual(['n', 'b', 'a']);
  });
});

describe('move', () => {
  it('двигает среди видимых, перепрыгивая скрытые режимом', () => {
    const visible = new Set(['a', 'c', 'd']);
    expect(move(['a', 'b', 'c', 'd'], 'c', -1, visible)).toEqual(['c', 'a', 'b', 'd']);
    expect(move(['a', 'b', 'c', 'd'], 'a', 1, visible)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('на краю ничего не делает', () => {
    const all = new Set(['a', 'b']);
    expect(move(['a', 'b'], 'a', -1, all)).toEqual(['a', 'b']);
    expect(move(['a', 'b'], 'b', 1, all)).toEqual(['a', 'b']);
  });
});

describe('UserState', () => {
  it('помнит настройки, отметки и свой порядок', () => {
    const u = new UserState(memoryKV());
    expect(u.prefs().view).toBe('all');
    u.setPrefs({ collapsed: true });
    u.setPrefs({ view: 'main' });
    expect(u.prefs()).toMatchObject({ collapsed: true, view: 'main' });
    u.setWatched('al:1', true);
    u.setCustomOrder('al:1', { order: ['al:2', 'al:1'], hidden: [] });
    expect(u.customOrder('al:1')?.order).toEqual(['al:2', 'al:1']);
    u.setCustomOrder('al:1', { order: [], hidden: [] });
    expect(u.customOrder('al:1')).toBeUndefined();
  });

  it('экспорт и импорт переносят всё в другой браузер', () => {
    const a = new UserState(memoryKV());
    a.setWatched('al:5', true);
    a.setPrefs({ view: 'main' });
    a.setCustomOrder('al:1', { order: ['al:2'], hidden: ['al:3'] });
    const dump = JSON.parse(JSON.stringify(a.exportData())) as unknown;

    const b = new UserState(memoryKV());
    b.setWatched('al:9', true);
    b.importData(dump);
    expect(b.isWatched('al:5')).toBe(true);
    expect(b.isWatched('al:9')).toBe(false);
    expect(b.prefs().view).toBe('main');
    expect(b.customOrder('al:1')?.hidden).toEqual(['al:3']);
  });

  it('отказывается импортировать чужой файл', () => {
    const u = new UserState(memoryKV());
    expect(() => u.importData({ hello: 1 })).toThrow();
    expect(() => u.importData({ format: 'animelib-watch-order/v1', watched: 'oops' })).toThrow();
  });
});
