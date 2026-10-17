import { arr, isObj, num, obj, str, strings } from './guards';
import { parseJson, type Transport } from './http';
import type { AlEdge, AlMedia, AlRelation, FranchiseGraph, MediaFormat } from './types';

export const ANILIST_URL = 'https://graphql.anilist.co';

const MEDIA_FIELDS = `
  id type format episodes
  startDate { year month day }
  title { romaji english native }
  synonyms
  relations { edges { relationType(version: 2) node { id type format } } }
`;

const BY_IDS = `query ($ids: [Int]) {
  Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } }
}`;

const SEARCH = `query ($q: String) {
  Page(perPage: 8) { media(search: $q, type: ANIME) { ${MEDIA_FIELDS} } }
}`;

const FORMATS: ReadonlySet<string> = new Set(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']);
const RELATIONS: ReadonlySet<string> = new Set([
  'PREQUEL', 'SEQUEL', 'SIDE_STORY', 'PARENT', 'SUMMARY', 'ALTERNATIVE', 'SPIN_OFF',
  'OTHER', 'COMPILATION', 'CONTAINS', 'CHARACTER', 'ADAPTATION', 'SOURCE',
]);

const toFormat = (v: unknown): MediaFormat =>
  typeof v === 'string' && FORMATS.has(v) ? (v as MediaFormat) : 'UNKNOWN';

/** Разбор одного Media. Возвращает undefined для мусора. */
export function parseMedia(v: unknown): AlMedia | undefined {
  if (!isObj(v)) return undefined;
  const id = num(v.id);
  if (id === undefined || v.type !== 'ANIME') return undefined;
  const title = obj(v.title);
  const sd = obj(v.startDate);
  const edges: AlEdge[] = [];
  for (const e of arr(obj(v.relations).edges)) {
    const eo = obj(e);
    const node = obj(eo.node);
    const nid = num(node.id);
    const rel = eo.relationType;
    if (nid === undefined || typeof rel !== 'string' || !RELATIONS.has(rel)) continue;
    if (node.type !== 'ANIME' && node.type !== 'MANGA') continue;
    edges.push({ rel: rel as AlRelation, id: nid, type: node.type, format: toFormat(node.format) });
  }
  return {
    id,
    format: toFormat(v.format),
    startDate: { year: num(sd.year), month: num(sd.month), day: num(sd.day) },
    romaji: str(title.romaji) ?? str(title.english) ?? `#${id}`,
    english: str(title.english),
    native: str(title.native),
    synonyms: strings(v.synonyms),
    episodes: num(v.episodes),
    edges,
  };
}

function parsePage(body: unknown): AlMedia[] {
  const data = obj(obj(body).data);
  const media = arr(obj(data.Page).media);
  if (!isObj(data.Page)) throw new Error('AniList: неожиданный ответ');
  return media.map(parseMedia).filter((m): m is AlMedia => !!m);
}

/** Связи, по которым идём дальше вглубь франшизы. */
const EXPAND: ReadonlySet<AlRelation> = new Set([
  'PREQUEL', 'SEQUEL', 'SIDE_STORY', 'PARENT', 'SUMMARY', 'COMPILATION', 'CONTAINS',
]);
/** Альтернативные ветки и спин-оффы: от них идём только по PREQUEL/SEQUEL, чтобы ветка была целой. */
const BRANCH: ReadonlySet<AlRelation> = new Set(['ALTERNATIVE', 'SPIN_OFF']);
const LINE: ReadonlySet<AlRelation> = new Set(['PREQUEL', 'SEQUEL']);
/** Связи, узлы которых показываем, но дальше от них не идём: иначе граф уползёт в соседние франшизы. */
const LEAF: ReadonlySet<AlRelation> = new Set(['OTHER']);

/** full: раскрываем все сюжетные связи; line: только сиквелы/приквелы; leaf: не раскрываем. */
type Reach = 'full' | 'line' | 'leaf';
const RANK: Record<Reach, number> = { full: 2, line: 1, leaf: 0 };

function reachVia(from: Reach, rel: AlRelation): Reach | undefined {
  if (from === 'full') {
    if (EXPAND.has(rel)) return 'full';
    if (BRANCH.has(rel)) return 'line';
    if (LEAF.has(rel)) return 'leaf';
    return undefined;
  }
  if (from === 'line') return LINE.has(rel) ? 'line' : undefined;
  return undefined;
}

export interface FranchiseLimits {
  maxNodes?: number;
  maxRequests?: number;
}

export class AniListClient {
  constructor(private readonly transport: Transport) {}

  private async query(query: string, variables: Record<string, unknown>, signal?: AbortSignal) {
    const res = await this.transport({
      url: ANILIST_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal,
      timeoutMs: 15_000,
    });
    return parsePage(parseJson(res, 'AniList'));
  }

  getByIds(ids: number[], signal?: AbortSignal): Promise<AlMedia[]> {
    return this.query(BY_IDS, { ids }, signal);
  }

  search(q: string, signal?: AbortSignal): Promise<AlMedia[]> {
    return this.query(SEARCH, { q }, signal);
  }

  /** Обход графа франшизы от rootId: батчами по уровням, с лимитами и защитой от циклов. */
  async loadFranchise(rootId: number, signal?: AbortSignal, limits: FranchiseLimits = {}): Promise<FranchiseGraph> {
    const maxNodes = limits.maxNodes ?? 80;
    const maxRequests = limits.maxRequests ?? 10;
    const nodes = new Map<number, AlMedia>();
    const wanted = new Set<number>([rootId]);
    const missing = new Set<number>(); // AniList не вернул, больше не просим
    const reach = new Map<number, Reach>([[rootId, 'full']]);
    // узел раскрыт с таким уровнем; повышение уровня раскрывает его ещё раз
    const expanded = new Map<number, Reach>();
    let requests = 0;
    let truncated = false;

    for (;;) {
      const toFetch = [...wanted].filter((id) => !nodes.has(id) && !missing.has(id)).slice(0, 50);
      if (toFetch.length > 0) {
        if (requests >= maxRequests) {
          truncated = true;
          break;
        }
        requests++;
        for (const m of await this.getByIds(toFetch, signal)) nodes.set(m.id, m);
        for (const id of toFetch) if (!nodes.has(id)) missing.add(id);
      }

      let progressed = false;
      for (const [id, r] of [...reach]) {
        const m = nodes.get(id);
        const done = expanded.get(id);
        if (!m || r === 'leaf' || (done !== undefined && RANK[done] >= RANK[r])) continue;
        expanded.set(id, r);
        progressed = true;
        for (const e of m.edges) {
          if (e.type !== 'ANIME' || e.format === 'MUSIC') continue;
          const nr = reachVia(r, e.rel);
          if (!nr) continue;
          if (!wanted.has(e.id)) {
            if (wanted.size >= maxNodes) {
              truncated = true;
              continue;
            }
            wanted.add(e.id);
          }
          const prev = reach.get(e.id);
          if (prev === undefined || RANK[nr] > RANK[prev]) reach.set(e.id, nr);
        }
      }
      if (!progressed && toFetch.length === 0) break;
    }
    return { rootId, nodes, truncated };
  }
}
