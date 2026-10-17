// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { memoryKV, UserState } from '../src/storage';
import type { OrderItem, OrderResult } from '../src/types';
import { WatchOrderView } from '../src/ui';

const item = (key: string, extra: Partial<OrderItem> = {}): OrderItem => ({
  watchKey: key, alId: 1, title: key, format: 'ONA', kind: 'main', isCurrent: false, flags: [], ...extra,
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
