export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  text: string;
  /** Retry-After в секундах, если сервер его прислал */
  retryAfter?: number;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

export const isAbort = (e: unknown): boolean =>
  e instanceof AbortError || (e instanceof DOMException && e.name === 'AbortError');

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Ограничитель параллельности. */
export function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= max) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Повторы с backoff на 429/5xx и сетевых ошибках. Прочие 4xx отдаются как есть. */
export function withRetry(transport: Transport, opts: RetryOptions = {}): Transport {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 800;
  const max = opts.maxDelayMs ?? 10_000;
  return async (req) => {
    let attempt = 0;
    for (;;) {
      if (req.signal?.aborted) throw new AbortError();
      let res: HttpResponse | undefined;
      let err: unknown;
      try {
        res = await transport(req);
      } catch (e) {
        if (isAbort(e)) throw e;
        err = e;
      }
      const retriable = !res || res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= retries) {
        if (res) return res;
        throw err;
      }
      const hinted = res?.retryAfter !== undefined ? res.retryAfter * 1000 : 0;
      const delay = Math.min(max, Math.max(hinted, base * 2 ** attempt));
      attempt++;
      await sleep(delay, req.signal);
    }
  };
}

/** Транспорт на fetch страницы. Cookie не отправляются. */
export const fetchTransport: Transport = async (req) => {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  req.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 15_000);
  try {
    const r = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body,
      credentials: 'omit',
      signal: ctrl.signal,
    });
    const ra = Number(r.headers.get('retry-after'));
    return {
      status: r.status,
      text: await r.text(),
      retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined,
    };
  } catch (e) {
    if (req.signal?.aborted) throw new AbortError();
    throw e;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }
};

export function parseJson(res: HttpResponse, what: string): unknown {
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(`${what}: HTTP ${res.status}`, res.status);
  }
  try {
    return JSON.parse(res.text) as unknown;
  } catch {
    throw new HttpError(`${what}: некорректный JSON`, res.status);
  }
}
