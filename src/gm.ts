// Обёртки над API менеджера userscript (Violentmonkey/Tampermonkey).
import { AbortError, fetchTransport, type Transport } from './http';
import type { KV } from './storage';

interface GmResponse {
  status: number;
  responseText: string;
  responseHeaders: string;
}
interface GmRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  anonymous?: boolean;
  timeout?: number;
  onload(r: GmResponse): void;
  onerror(e: unknown): void;
  ontimeout(): void;
}
declare const GM_xmlhttpRequest: ((req: GmRequest) => { abort(): void }) | undefined;
declare const GM_getValue: (<T>(key: string, def?: T) => T) | undefined;
declare const GM_setValue: ((key: string, v: unknown) => void) | undefined;
declare const GM_deleteValue: ((key: string) => void) | undefined;

/**
 * Транспорт для внешних хостов (AniList) через GM_xmlhttpRequest.
 * anonymous: true не даёт отправить cookie, токенов сайта здесь нет.
 */
export const gmTransport: Transport =
  typeof GM_xmlhttpRequest === 'function'
    ? (req) =>
        new Promise((resolve, reject) => {
          if (req.signal?.aborted) return reject(new AbortError());
          const h = GM_xmlhttpRequest!({
            method: req.method ?? 'GET',
            url: req.url,
            headers: req.headers,
            data: req.body,
            anonymous: true,
            timeout: req.timeoutMs ?? 15_000,
            onload: (r) => {
              const ra = Number(/^retry-after:\s*(\d+)/im.exec(r.responseHeaders)?.[1]);
              resolve({ status: r.status, text: r.responseText, retryAfter: ra > 0 ? ra : undefined });
            },
            onerror: () => reject(new Error('сетевая ошибка')),
            ontimeout: () => reject(new Error('таймаут')),
          });
          req.signal?.addEventListener('abort', () => {
            h.abort();
            reject(new AbortError());
          }, { once: true });
        })
    : fetchTransport;

export function gmKV(): KV {
  if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') {
    // запуск вне менеджера userscript: localStorage с префиксом
    return {
      get: <T>(k: string) => {
        const v = localStorage.getItem(`awo:${k}`);
        return v === null ? undefined : (JSON.parse(v) as T);
      },
      set: (k, v) => localStorage.setItem(`awo:${k}`, JSON.stringify(v)),
      remove: (k) => localStorage.removeItem(`awo:${k}`),
    };
  }
  return {
    get: <T>(k: string) => GM_getValue!<T | undefined>(k, undefined),
    set: (k, v) => GM_setValue!(k, v),
    remove: (k) => (typeof GM_deleteValue === 'function' ? GM_deleteValue(k) : GM_setValue!(k, undefined)),
  };
}
