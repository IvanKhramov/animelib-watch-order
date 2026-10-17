import { pairKey } from './matching';
import { isObj } from './guards';
import type { LoadCtx } from './sites/site';
import { HOUR, type UserState } from './storage';
import type { AlMedia, FranchiseGraph, OrderResult, SiteMatch, SiteTitle } from './types';

export const FRANCHISE_TTL = 12 * HOUR;
const NS = 'prepared-order';
interface Context { adapter: { id: string }; ctx: LoadCtx; user: UserState }
interface PageEntry {
  generation: string;
  franchise: string;
  result: OrderResult;
}
interface Snapshot {
  generation: string;
  rejected: string;
  graph?: { nodes: AlMedia[]; truncated: boolean; reusableRootIds: number[] };
  candidates: SiteTitle[];
  relatedKeys: string[];
  pages: { key: string; id: number }[];
  result: OrderResult;
}
export interface PreparedFranchise {
  current: SiteTitle;
  graph: FranchiseGraph;
  related: SiteTitle[];
  searched: SiteTitle[];
  snapshot: Snapshot;
  franchise: string;
}

const fingerprint = (user: UserState) => JSON.stringify([...user.rejected()].sort());
const pageKey = (key: string, deps: Context) => `${deps.adapter.id}:${key}`;
const snapshotKey = (franchise: string, deps: Context) => `${deps.adapter.id}:${franchise}`;

function read<T>(namespace: string, key: string, deps: Context): T | undefined {
  try { return deps.ctx.cache.get<T>(namespace, key); } catch { return undefined; }
}

function reference(key: string, deps: Context): string | undefined {
  const ref = read<unknown>(`${NS}:alias`, pageKey(key, deps), deps);
  return typeof ref === 'string' ? ref : undefined;
}

function validResult(value: unknown): value is OrderResult {
  return isObj(value) && (value.mode === 'anilist' || value.mode === 'site-only') && typeof value.franchiseKey === 'string' &&
    Array.isArray(value.items) && Array.isArray(value.branches) && Array.isArray(value.notes);
}

function snapshotData(franchise: string, deps: Context): Snapshot | undefined {
  const value = read<Snapshot>(`${NS}:franchise`, snapshotKey(franchise, deps), deps);
  if (!isObj(value) || typeof value.generation !== 'string' || typeof value.rejected !== 'string' || !validResult(value.result) ||
    !Array.isArray(value.candidates) || !Array.isArray(value.relatedKeys) || !Array.isArray(value.pages) ||
    !value.pages.every((page) => isObj(page) && typeof page.key === 'string' && typeof page.id === 'number')) return undefined;
  if (value.graph && (!isObj(value.graph) || !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.reusableRootIds) ||
    typeof value.graph.truncated !== 'boolean' || !value.graph.nodes.every((node) => isObj(node) && typeof node.id === 'number' && Array.isArray(node.edges)))) return undefined;
  return value;
}

function readSnapshot(franchise: string, deps: Context): Snapshot | undefined {
  const snapshot = snapshotData(franchise, deps);
  return snapshot?.rejected === fingerprint(deps.user) ? snapshot : undefined;
}

/** Синхронный быстрый путь: готовый блок без запросов и состояния загрузки. */
export function cachedWatchOrder(key: string, deps: Context): OrderResult | undefined {
  if (deps.ctx.force) return undefined;
  const page = read<PageEntry>(`${NS}:page`, pageKey(key, deps), deps);
  if (!isObj(page) || typeof page.franchise !== 'string' || !validResult(page.result)) return undefined;
  const snapshot = readSnapshot(page.franchise, deps);
  if (!snapshot || snapshot.generation !== page.generation) return undefined;
  return structuredClone(page.result);
}

/** После истечения верхнего кэша обходим и более долгие кэши отдельных API. */
export function preparedNeedsRefresh(key: string, deps: Context): boolean {
  if (deps.ctx.force) return false;
  const ref = reference(key, deps);
  if (!ref) return false;
  const snapshot = snapshotData(ref, deps);
  return !snapshot || !snapshot.pages.some((page) => page.key === key);
}

/** Общие данные переиспользуются, но порядок и текущий тайтл вычисляются заново. */
export function cachedFranchise(key: string, deps: Context): PreparedFranchise | undefined {
  if (deps.ctx.force) return undefined;
  const ref = reference(key, deps);
  if (!ref) return undefined;
  const snapshot = readSnapshot(ref, deps);
  if (!snapshot?.graph) return undefined;
  const page = snapshot.pages.find((page) => page.key === key);
  if (!page || !snapshot.graph.reusableRootIds.includes(page.id)) return undefined;
  const copy = structuredClone(snapshot);
  const current = copy.candidates.find((title) => title.key === key);
  if (!current) return undefined;
  const relatedKeys = new Set(copy.relatedKeys);
  return {
    current, franchise: ref, snapshot: copy,
    graph: { rootId: page.id, nodes: new Map(copy.graph!.nodes.map((node) => [node.id, node])),
      truncated: copy.graph!.truncated, reusableRootIds: copy.graph!.reusableRootIds },
    related: copy.candidates.filter((title) => title.key !== key && relatedKeys.has(title.key)),
    searched: copy.candidates.filter((title) => !relatedKeys.has(title.key)),
  };
}

export function cachePreparedOrder(
  key: string, result: OrderResult, deps: Context,
  data?: { graph: FranchiseGraph; candidates: SiteTitle[]; relatedKeys: Set<string>; matches: Map<number, SiteMatch>; hasParts: Set<number>; complete: boolean },
  seed?: PreparedFranchise,
) {
  if (deps.ctx.signal.aborted) return;
  // У сайд-стори после смены корня может быть другая основная линия.
  // Принудительное обновление всё равно заменяет тот общий снимок, из которого открыта страница.
  const previous = reference(key, deps);
  const franchise = seed?.franchise ?? previous ?? result.franchiseKey;
  // Чтение не продлевает жизнь общего снимка. Принудительная загрузка создаёт новую ревизию.
  const snapshot: Snapshot = seed?.snapshot ?? {
    generation: `${Date.now()}:${Math.random()}`, rejected: fingerprint(deps.user),
    candidates: data?.candidates ?? [], relatedKeys: [...(data?.relatedKeys ?? [])], pages: [], result: structuredClone(result),
  };
  try {
    if (!seed) {
      const graph = data?.graph;
      if (graph) {
        const allowed = new Set(data?.complete ? graph.reusableRootIds ?? [graph.rootId] : [graph.rootId]);
        snapshot.graph = { nodes: [...graph.nodes.values()], truncated: graph.truncated, reusableRootIds: [...allowed] };
        const titles = new Map(snapshot.candidates.map((title) => [title.key, title]));
        for (const [id, match] of data!.matches) {
          if (!allowed.has(id) || data!.hasParts.has(id) ||
            !['id', 'name'].includes(match.confidence) || deps.user.rejected().has(pairKey(id, match.title.key))) continue;
          titles.set(match.title.key, match.title);
          snapshot.pages.push({ key: match.title.key, id });
        }
        snapshot.candidates = [...titles.values()];
      }
      const ttl = data?.complete ? FRANCHISE_TTL : HOUR / 12;
      deps.ctx.cache.set(`${NS}:franchise`, snapshotKey(franchise, deps), snapshot, ttl);
      // Маленький индекс переживает данные: по нему отличаем просроченную франшизу от новой.
      for (const page of snapshot.pages) deps.ctx.cache.set(`${NS}:alias`, pageKey(page.key, deps), franchise, 30 * 24 * HOUR);
      deps.ctx.cache.set(`${NS}:alias`, pageKey(key, deps), franchise, 30 * 24 * HOUR);
    }
    deps.ctx.cache.set(`${NS}:page`, pageKey(key, deps), {
      generation: snapshot.generation, franchise, result: structuredClone(result),
    } satisfies PageEntry, FRANCHISE_TTL);
  } catch {
    // Переполненное хранилище не должно скрыть успешно загруженный блок.
  }
}
