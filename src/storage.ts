import type { CustomOrder } from './customOrder';
import { isObj } from './guards';
import type { WatchOrderMode } from './orderProfiles';

/** Хранилище ключ-значение. В userscript это GM_getValue/GM_setValue, в тестах Map. */
export interface KV {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

/** Версия пользовательских данных (отметки, порядок, настройки). Менять только с миграцией. */
export const SCHEMA = 'v1';
/** Версия кэша: при смене формата данных старые записи просто перестают читаться. */
export const CACHE_SCHEMA = 'v3';

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
    return `cache:${CACHE_SCHEMA}:${ns}:${k}`;
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

  prefs(): Prefs {
    const v = this.kv.get<Partial<Prefs>>(`user:${SCHEMA}:prefs`);
    const prefs = { ...DEFAULT_PREFS, ...(v && typeof v === 'object' ? v : {}) };
    if (!['recommended', 'release', 'chronological'].includes(prefs.orderMode)) prefs.orderMode = 'recommended';
    return prefs;
  }

  setPrefs(patch: Partial<Prefs>) {
    this.kv.set(`user:${SCHEMA}:prefs`, { ...this.prefs(), ...patch });
  }

  private orders(): Record<string, CustomOrder> {
    const v = this.kv.get<Record<string, CustomOrder>>(`user:${SCHEMA}:orders`);
    return v && typeof v === 'object' ? v : {};
  }

  customOrder(franchise: string): CustomOrder | undefined {
    return this.orders()[franchise];
  }

  setCustomOrder(franchise: string, v: CustomOrder | undefined) {
    const all = this.orders();
    if (v && (v.order.length > 0 || v.hidden.length > 0)) all[franchise] = v;
    else delete all[franchise];
    this.kv.set(`user:${SCHEMA}:orders`, all);
  }

  /** Всё, что отметил пользователь, одним объектом: для переноса в другой браузер. */
  exportData(): ExportData {
    const data: ExportData = { format: EXPORT_FORMAT, exportedAt: new Date().toISOString() };
    for (const name of USER_KEYS) {
      const v = this.kv.get<unknown>(`user:${SCHEMA}:${name}`);
      if (v !== undefined) data[name] = v;
    }
    return data;
  }

  /** Импорт с проверкой формата. Заменяет текущие данные целиком. */
  importData(raw: unknown) {
    if (!raw || typeof raw !== 'object' || (raw as ExportData).format !== EXPORT_FORMAT) {
      throw new Error('это не файл экспорта порядка просмотра');
    }
    const data = raw as ExportData;
    for (const name of USER_KEYS) {
      const v = data[name];
      if (v !== undefined && !validUserField(name, v)) throw new Error(`повреждено поле ${name}`);
    }
    // Применяем только после проверки всех полей, включая вложенные.
    for (const name of USER_KEYS) {
      const v = data[name];
      if (v === undefined) this.kv.remove(`user:${SCHEMA}:${name}`);
      else this.kv.set(`user:${SCHEMA}:${name}`, v);
    }
  }
}

export interface Prefs {
  orderMode: WatchOrderMode;
  view: 'main' | 'all';
  collapsed: boolean;
  branchesOpen: boolean;
  /** показывать обложки частей */
  covers: boolean;
  /** сайты, где блок скрыт целиком (вернуть через меню менеджера скриптов) */
  hiddenSites: Record<string, true>;
}

const DEFAULT_PREFS: Prefs = { orderMode: 'recommended', view: 'all', collapsed: false, branchesOpen: false, covers: false, hiddenSites: {} };

const USER_KEYS = ['watched', 'rejected', 'prefs', 'orders'] as const;
const EXPORT_FORMAT = 'animelib-watch-order/v1';

export type ExportData = { format: string; exportedAt: string } & Partial<Record<(typeof USER_KEYS)[number], unknown>>;

const trueMap = (v: unknown): boolean => isObj(v) && Object.values(v).every((x) => x === true);
const stringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');

function validUserField(name: (typeof USER_KEYS)[number], v: unknown): boolean {
  if (name === 'watched' || name === 'rejected') return trueMap(v);
  if (!isObj(v)) return false;
  if (name === 'orders') {
    return Object.values(v).every((order) => isObj(order) &&
      Object.keys(order).every((key) => key === 'order' || key === 'hidden') &&
      stringArray(order.order) && stringArray(order.hidden));
  }
  // Старые экспорты могут содержать только часть настроек.
  return Object.entries(v).every(([key, value]) => {
    if (key === 'orderMode') return value === 'recommended' || value === 'release' || value === 'chronological';
    if (key === 'view') return value === 'main' || value === 'all';
    if (key === 'hiddenSites') return trueMap(value);
    if (key === 'collapsed' || key === 'branchesOpen' || key === 'covers') return typeof value === 'boolean';
    return false;
  });
}
