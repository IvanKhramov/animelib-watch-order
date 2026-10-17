// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { memoryKV, UserState } from '../src/storage';
import type { OrderItem, OrderResult } from '../src/types';
import { WatchOrderView } from '../src/ui';

const item = (key: string, extra: Partial<OrderItem> = {}): OrderItem => ({
  watchKey: key, alId: 1, title: key, format: 'ONA', kind: 'main', isCurrent: false, flags: [], ...extra,
});

const titles = (view: WatchOrderView) => [...(view.root.shadowRoot!.querySelector('ol')?.children ?? [])].map((el) => el.querySelector('.title')?.textContent);
const click = (view: WatchOrderView, text: string) => {
  const button = [...view.root.shadowRoot!.querySelectorAll('button')].find((el) => el.textContent === text);
  expect(button, `кнопка ${text}`).toBeDefined();
  button!.click();
};

describe('переключение режимов', () => {
  it('позволяет выбрать источник событийного порядка без смешивания вариантов', () => {
    const user = new UserState(memoryKV());
    user.setPrefs({ orderMode: 'chronological' });
    const view = new WatchOrderView(user, handlers);
    const a = { variantId: 'reddit', label: 'r/anime', origin: 'community' as const, steps: [{ alId: 1 }, { alId: 2 }], note: 'Порядок A.', sources: [] };
    const b = { ...a, variantId: 'shiki', label: 'Shikimori', steps: [{ alId: 2 }, { alId: 1 }] };
    const raw = result([item('first'), item('second', { alId: 2 })]);
    raw.orderProfile = { id: 'test', title: 'Test', anchorIds: [1, 2], checkedAt: '2026-10-17', recommended: a,
      chronological: a, chronologicalVariants: [a, b] };
    view.set({ status: 'ready', result: raw });
    expect(titles(view)).toEqual(['first', 'second']);
    click(view, 'Shikimori');
    expect(titles(view)).toEqual(['second', 'first']);
    expect(view.root.shadowRoot!.querySelector('[aria-label="Источник хронологии"] [aria-pressed=true]')?.textContent).toBe('Shikimori');
  });

  it('меняет порядок сразу, сохраняет выбор и не вызывает загрузку', () => {
    const user = new UserState(memoryKV());
    const callbacks = { refresh: vi.fn(), reload: vi.fn(), hideOnSite: vi.fn() };
    const view = new WatchOrderView(user, callbacks);
    const raw = result([item('later', { date: { year: 2020 } }), item('earlier', { alId: 2, date: { year: 2010 } })]);
    raw.orderProfile = { id: 'test', title: 'Test', anchorIds: [1, 2], checkedAt: '2026-10-17', recommended: {
      steps: [{ alId: 1 }, { alId: 2 }], note: 'Первый просмотр.', sources: [],
    } };
    view.set({ status: 'ready', result: raw });
    expect(titles(view)).toEqual(['later', 'earlier']);
    click(view, 'По выходу');
    expect(titles(view)).toEqual(['earlier', 'later']);
    expect(user.prefs().orderMode).toBe('release');
    expect(callbacks.refresh).not.toHaveBeenCalled();
    expect(callbacks.reload).not.toHaveBeenCalled();
    const restored = new WatchOrderView(user, callbacks);
    restored.set({ status: 'ready', result: raw });
    expect(titles(restored)).toEqual(['earlier', 'later']);
  });

  it('отдельные правки режимов не переносятся на другой порядок', () => {
    const user = new UserState(memoryKV());
    user.setCustomOrder('al:1', { order: ['second', 'first'], hidden: [] });
    const view = new WatchOrderView(user, handlers);
    view.set({ status: 'ready', result: result([item('first', { date: { year: 2010 } }), item('second', { alId: 2, date: { year: 2020 } })]) });
    expect(titles(view)).toEqual(['second', 'first']);
    click(view, 'По выходу');
    expect(titles(view)).toEqual(['first', 'second']);
    click(view, 'Править');
    view.root.shadowRoot!.querySelectorAll<HTMLButtonElement>('ol .edit button')[2]!.click();
    expect(titles(view)).toEqual(['second']);
    expect(user.customOrder('al:1:release')!.hidden).toEqual(['first']);
    click(view, 'Рекомендованный');
    expect(titles(view)).toEqual(['second', 'first']);
  });

  it('неподтверждённая хронология недоступна, причина видна; можно выйти из сохранённого режима', () => {
    const user = new UserState(memoryKV());
    user.setPrefs({ orderMode: 'chronological' });
    const view = new WatchOrderView(user, handlers);
    view.set({ status: 'ready', result: result([item('unknown')]) });
    const chrono = view.root.shadowRoot!.querySelector<HTMLButtonElement>('[data-mode=chronological]')!;
    expect(chrono.disabled).toBe(true);
    expect(view.root.shadowRoot!.textContent).toContain('Проверенной хронологии');
    expect(titles(view)).toEqual(['unknown']);
    expect(view.root.shadowRoot!.querySelector('[aria-pressed=true]')?.textContent).toBe('Рекомендованный');
    expect(user.prefs().orderMode).toBe('chronological');
    click(view, 'По выходу');
    expect(titles(view)).toEqual(['unknown']);
  });

  it('Steins;Gate отображает сегменты, общую отметку и источники выбранного маршрута', () => {
    const user = new UserState(memoryKV());
    const view = new WatchOrderView(user, handlers);
    const raw = result([
      item('al:9253', { alId: 9253, title: 'Steins;Gate', isCurrent: true }),
      item('al:21624', { alId: 21624, title: '23β' }),
      item('al:21127', { alId: 21127, title: 'Zero' }),
      item('al:104174', { alId: 104174, title: 'Valentine' }),
      item('al:10863', { alId: 10863, title: 'OVA' }),
      item('al:11577', { alId: 11577, title: 'Movie' }),
    ]);
    raw.franchiseKey = 'al:9253';
    view.set({ status: 'ready', result: raw });
    click(view, 'По событиям');
    expect(view.root.shadowRoot!.textContent).toContain('серии 1–22');
    expect(view.root.shadowRoot!.textContent).toContain('серии 23–24');
    expect(titles(view).filter((t) => t === 'Steins;Gate')).toHaveLength(2);
    expect([...view.root.shadowRoot!.querySelectorAll('.num')].map((el) => el.textContent)).toEqual(['1', '2', '3', '', '4', '5', '', '']);
    expect(view.root.shadowRoot!.querySelector('.sum')!.textContent).toContain('в нескольких шагах');
    const firstMark = view.root.shadowRoot!.querySelector<HTMLButtonElement>('ol .mark')!;
    firstMark.click();
    expect(user.isWatched('al:9253')).toBe(true);
    expect([...view.root.shadowRoot!.querySelectorAll('li.done > .title')].map((el) => el.textContent)).toEqual(['Steins;Gate', 'Steins;Gate']);
    const source = view.root.shadowRoot!.querySelector<HTMLAnchorElement>('.sources a')!;
    expect(source.href).toContain('reddit.com/r/anime/wiki/watch_order/');
    expect(source.rel).toBe('noopener noreferrer');
    click(view, 'По выходу');
    expect(titles(view).filter((t) => t === 'Steins;Gate')).toHaveLength(1);
    expect(user.isWatched('al:9253')).toBe(true);
  });

  it('старые ключи правок применяются к диапазонам и сохраняются при смене страницы франшизы', () => {
    const user = new UserState(memoryKV());
    user.setCustomOrder('al:21624', { order: ['al:21127', 'al:9253'], hidden: ['al:10863'] });
    const view = new WatchOrderView(user, handlers);
    const raw = result([
      item('al:9253', { alId: 9253, title: 'Original' }),
      item('al:21127', { alId: 21127, title: 'Zero', isCurrent: true }),
      item('al:10863', { alId: 10863, title: 'OVA' }),
    ]);
    // Исправленный обход уже сменил ключ на оригинал, старые данные ещё под 23β.
    raw.franchiseKey = 'al:9253';
    view.set({ status: 'ready', result: raw });
    expect(titles(view)).toEqual(['Zero', 'Original']);
    click(view, 'Править');
    view.root.shadowRoot!.querySelectorAll<HTMLButtonElement>('ol .edit button')[2]!.click();
    expect(user.customOrder('al:9253')).toBeDefined();
    click(view, '⋯');
    click(view, 'Сбросить правки текущего режима');
    expect(user.customOrder('al:9253')).toBeUndefined();
    expect(user.customOrder('al:21624')).toBeUndefined();
  });
});
const result = (items: OrderItem[]): OrderResult => ({
  mode: 'anilist', franchiseKey: 'al:1', items, branches: [], notes: [],
});
const handlers = { refresh() {}, reload() {}, hideOnSite() {} };

describe('отображение исправленного порядка', () => {
  it('продолжение имеет свою строку, но не увеличивает номера и счётчик частей', () => {
    const view = new WatchOrderView(new UserState(memoryKV()), handlers);
    view.set({ status: 'ready', result: result([
      item('primary'), item('part3', { continuation: true, isCurrent: true }), item('next', { alId: 2 }),
    ]) });
    const shadow = view.root.shadowRoot!;
    expect([...shadow.querySelectorAll('.num')].map((el) => el.textContent)).toEqual(['1', '', '2']);
    expect(shadow.textContent).toContain('вы здесь: 1 из 2');
  });

  it('пересказ без номера виден во Всё и скрыт в Основном даже на текущей странице', () => {
    const user = new UserState(memoryKV());
    const view = new WatchOrderView(user, handlers);
    const res = result([item('series'), item('recap', { kind: 'recap', isCurrent: true })]);
    view.set({ status: 'ready', result: res });
    expect(view.root.shadowRoot!.querySelectorAll('ol > li')).toHaveLength(2);
    expect([...view.root.shadowRoot!.querySelectorAll('.num')].map((el) => el.textContent)).toEqual(['1', '']);
    user.setPrefs({ view: 'main' });
    view.set({ status: 'ready', result: res });
    expect(view.root.shadowRoot!.querySelectorAll('ol > li')).toHaveLength(1);
  });
});
