import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError, fetchTransport, sleep, withRetry, type RetryOptions } from '../src/http';

function clock() {
  let time = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms: number) => { waits.push(ms); time += ms; },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('паузы транспорта', () => {
  it('не сокращает Retry-After до maxDelayMs', async () => {
    const c = clock();
    const sent: number[] = [];
    const t = withRetry(async () => {
      sent.push(c.now());
      return { status: sent.length === 1 ? 429 : 200, text: '', retryAfter: 0.05 };
    }, { ...c, baseDelayMs: 1, maxDelayMs: 2 });
    expect((await t({ url: 'x' })).status).toBe(200);
    expect(sent).toEqual([0, 50]);
    expect(c.waits).toEqual([50]);
  });

  it('не повторяет ответ с Retry-After выше потолка', async () => {
    const c = clock();
    const send = vi.fn(async () => ({ status: 429, text: '', retryAfter: 0.05 }));
    const t = withRetry(send, { ...c, maxRetryAfterMs: 40, baseDelayMs: 1 });
    expect((await t({ url: 'x' })).status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1);
    expect(c.waits).toEqual([]);
    await t({ url: 'next' });
    expect(c.waits).toEqual([50]);
  });

  it('пауза 429 действует на следующие запросы даже без повторов', async () => {
    const c = clock();
    const sent: number[] = [];
    const t = withRetry(async () => {
      sent.push(c.now());
      return { status: sent.length === 1 ? 429 : 200, text: '', retryAfter: 0.025 };
    }, { ...c, retries: 0, baseDelayMs: 1 });
    await t({ url: 'x' });
    await t({ url: 'y' });
    expect(sent).toEqual([0, 25]);
  });

  it('повторно проверяет паузу, если соседний запрос продлил её', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let answer: ((value: { status: number; text: string; retryAfter: number }) => void) | undefined;
    const send = vi.fn(async (req: { url: string }) => {
      if (req.url === 'slow') return new Promise<{ status: number; text: string; retryAfter: number }>((resolve) => { answer = resolve; });
      return { status: send.mock.calls.length === 2 ? 429 : 200, text: '', retryAfter: 0.02 };
    });
    const t = withRetry(send, { retries: 0, baseDelayMs: 1 });
    const slow = t({ url: 'slow' });
    await t({ url: 'first' });
    const waiting = t({ url: 'waiting' });
    await vi.advanceTimersByTimeAsync(10);
    answer!({ status: 429, text: '', retryAfter: 0.04 });
    await slow;
    await vi.advanceTimersByTimeAsync(39);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('ограничивает параллельные запросы и повторы интервалом AniList', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: number[] = [];
    const t = withRetry(async () => {
      sent.push(Date.now());
      return { status: sent.length === 1 ? 503 : 200, text: '' };
    }, { minIntervalMs: 2500, baseDelayMs: 1 });
    const requests = Promise.all([t({ url: 'a' }), t({ url: 'b' }), t({ url: 'c' })]);
    await vi.runAllTimersAsync();
    await requests;
    expect(sent).toEqual([0, 2500, 5000, 7500]);
  });

  it('не делит паузу между независимыми транспортами', async () => {
    const c = clock();
    const options: RetryOptions = { ...c, retries: 0, baseDelayMs: 1 };
    const a = withRetry(async () => ({ status: 429, text: '', retryAfter: 0.02 }), options);
    const b = withRetry(async () => ({ status: 200, text: '' }), options);
    await a({ url: 'x' });
    await b({ url: 'x' });
    expect(c.waits).toEqual([]);
  });

  it('отмена прерывает общую паузу без отправки запроса', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const send = vi.fn(async () => ({ status: 429, text: '', retryAfter: 0.05 }));
    const t = withRetry(send, { retries: 0, baseDelayMs: 1, now: Date.now, sleep });
    await t({ url: 'a' });
    const ctrl = new AbortController();
    const pending = t({ url: 'b', signal: ctrl.signal });
    const check = expect(pending).rejects.toBeInstanceOf(AbortError);
    ctrl.abort();
    await check;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('отдаёт AbortError без повторов', async () => {
    const send = vi.fn(async () => { throw new AbortError(); });
    await expect(withRetry(send)({ url: 'x' })).rejects.toBeInstanceOf(AbortError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

it('fetch не отправляет Referer и cookie', async () => {
  const send = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', send);
  await fetchTransport({ url: 'https://api.cdnlibs.org/api/anime' });
  expect(send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    credentials: 'omit', referrerPolicy: 'no-referrer',
  }));
});
