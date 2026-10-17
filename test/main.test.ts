// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadCtx } from '../src/sites/site';
import type { OrderResult } from '../src/types';
import { cachePreparedOrder } from '../src/franchiseCache';
import { Cache, UserState } from '../src/storage';

interface Handlers {
  refresh(): void;
  reload(): void;
  hideOnSite(): void;
}

const mocks = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  route: undefined as ((url: URL) => void) | undefined,
  menu: undefined as (() => void) | undefined,
  handlers: [] as Handlers[],
  load: vi.fn(),
  watchRoute: vi.fn(),
  watchDom: vi.fn(),
  gmMenuCommand: vi.fn(),
  states: [] as unknown[],
}));

vi.mock('../src/gm', () => ({
  gmKV: () => ({
    get: (key: string) => mocks.data.get(key),
    set: (key: string, value: unknown) => mocks.data.set(key, value),
    remove: (key: string) => mocks.data.delete(key),
  }),
  gmTransport: vi.fn(),
  gmMenuCommand: mocks.gmMenuCommand,
}));

vi.mock('../src/spaLifecycle', () => ({
  watchRoute: mocks.watchRoute,
  watchDom: mocks.watchDom,
}));

vi.mock('../src/watchOrder', () => ({ buildWatchOrder: mocks.load }));

vi.mock('../src/ui', () => ({
  WatchOrderView: class {
    root = document.createElement('div');
    set = vi.fn((state: unknown) => { mocks.states.push(state); });
    syncTheme = vi.fn();
    constructor(_user: unknown, handlers: Handlers) {
      this.root.setAttribute('data-awo', '');
      mocks.handlers.push(handlers);
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  document.documentElement.removeAttribute('data-awo-active');
  document.body.innerHTML = '<div class="section-body"><div class="section-title">Связанное</div></div>';
  window.location.href = 'https://animelib.org/ru/anime/1--first';
  mocks.data.clear();
  mocks.states.length = 0;
  mocks.handlers.length = 0;
  mocks.menu = undefined;
  mocks.route = undefined;
  mocks.watchRoute.mockImplementation((cb: (url: URL) => void) => {
    mocks.route = cb;
    cb(new URL(location.href));
  });
  mocks.gmMenuCommand.mockImplementation((_name: string, cb: () => void) => { mocks.menu = cb; });
  mocks.load.mockResolvedValue({ items: [], branches: [], notes: [] } as unknown as OrderResult);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('запуск userscript', () => {
  it('готовый кэш показывает сразу, без повторной загрузки и loading-состояния', async () => {
    const kv = {
      get: <T>(key: string) => mocks.data.get(key) as T | undefined,
      set: (key: string, value: unknown) => { mocks.data.set(key, value); },
      remove: (key: string) => { mocks.data.delete(key); },
    };
    const result: OrderResult = { mode: 'site-only', franchiseKey: 'site:animelib:1--first', items: [], branches: [], notes: [] };
    cachePreparedOrder('1--first', result, { adapter: { id: 'animelib' }, user: new UserState(kv),
      ctx: { cache: new Cache(kv), signal: new AbortController().signal, force: false } });
    await import('../src/main');
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.states).toEqual([{ status: 'ready', result }]);
    mocks.handlers[0]!.refresh();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.load.mock.calls[0]![1].ctx.force).toBe(true);
  });

  it('вторая изолированная копия выходит до запросов и наблюдателей', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await import('../src/main');
    const root = document.querySelector('[data-awo]');
    expect(root).not.toBeNull();
    vi.resetModules();
    await import('../src/main');
    expect(document.querySelector('[data-awo]')).toBe(root);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.watchRoute).toHaveBeenCalledTimes(1);
    expect(mocks.watchDom).toHaveBeenCalledTimes(1);
    expect(mocks.gmMenuCommand).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('уже запущен'));
  });

  it('скрытый сайт не загружается, меню запускает загрузку текущей страницы', async () => {
    mocks.data.set('user:v1:prefs', { hiddenSites: { animelib: true } });
    await import('../src/main');
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.handlers).toHaveLength(0);
    window.location.href = 'https://animelib.org/ru/anime/2--second';
    mocks.route!(new URL(location.href));
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.menu!();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.load.mock.calls[0]![0]).toBe('2--second');
    expect(document.querySelector('[data-awo]')).not.toBeNull();
  });

  it('скрытие отменяет загрузку, показ создаёт новую сессию', async () => {
    mocks.load.mockImplementation((_key: string, { ctx }: { ctx: LoadCtx }) => new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    await import('../src/main');
    const ctx = mocks.load.mock.calls[0]![1].ctx as LoadCtx;
    mocks.handlers[0]!.hideOnSite();
    expect(ctx.signal.aborted).toBe(true);
    expect(document.querySelector('[data-awo]')).toBeNull();
    mocks.handlers[0]!.refresh();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    mocks.menu!();
    expect(mocks.load).toHaveBeenCalledTimes(2);
    const nextCtx = mocks.load.mock.calls[1]![1].ctx as LoadCtx;
    expect(nextCtx.signal.aborted).toBe(false);
    mocks.handlers[1]!.hideOnSite();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('показ вне страницы тайтла не запускает запросы', async () => {
    mocks.data.set('user:v1:prefs', { hiddenSites: { animelib: true } });
    window.location.href = 'https://animelib.org/ru/catalog';
    await import('../src/main');
    mocks.menu!();
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
