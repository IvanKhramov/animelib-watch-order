/** Хранилище ключ-значение. В userscript это GM_getValue/GM_setValue, в тестах Map. */
export interface KV {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

/** Версия схемы кэша: при смене формата данных старые записи просто перестают читаться. */
export const SCHEMA = 'v1';

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string) => m.get(k) as T | undefined,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}

interface CacheEntry<T> {
  exp: number;
  v: T;
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export class Cache {
  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
  ) {}

  private key(ns: string, k: string) {
    return `cache:${SCHEMA}:${ns}:${k}`;
  }

  get<T>(ns: string, k: string): T | undefined {
    const e = this.kv.get<CacheEntry<T>>(this.key(ns, k));
    if (!e || typeof e.exp !== 'number' || e.exp < this.now()) return undefined;
    return e.v;
  }

  set(ns: string, k: string, v: unknown, ttlMs: number) {
    this.kv.set(this.key(ns, k), { exp: this.now() + ttlMs, v });
  }

  /** Обёртка «взять из кэша или загрузить». force пропускает чтение, но результат сохраняет. */
  async wrap<T>(ns: string, k: string, ttlMs: number, load: () => Promise<T>, force = false): Promise<T> {
    if (!force) {
      const hit = this.get<T>(ns, k);
      if (hit !== undefined) return hit;
    }
    const v = await load();
    this.set(ns, k, v, ttlMs);
    return v;
  }
}

/** Пользовательские отметки: «просмотрено» и отклонённые сопоставления. Без TTL. */
export class UserState {
  constructor(private readonly kv: KV) {}

  private map(name: string): Record<string, true> {
    const v = this.kv.get<Record<string, true>>(`user:${SCHEMA}:${name}`);
    return v && typeof v === 'object' ? v : {};
  }

  private toggle(name: string, key: string, on: boolean) {
    const m = this.map(name);
    if (on) m[key] = true;
    else delete m[key];
    this.kv.set(`user:${SCHEMA}:${name}`, m);
  }

  isWatched(key: string) {
    return this.map('watched')[key] === true;
  }

  setWatched(key: string, on: boolean) {
    this.toggle('watched', key, on);
  }

  rejected(): Set<string> {
    return new Set(Object.keys(this.map('rejected')));
  }

  reject(pair: string) {
    this.toggle('rejected', pair, true);
  }

  clearRejected() {
    this.kv.remove(`user:${SCHEMA}:rejected`);
  }
}
