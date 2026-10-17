import { readFileSync } from 'node:fs';
import type { AlEdge, AlMedia, AlRelation, FranchiseGraph, MediaFormat } from '../src/types';

export function media(
  id: number,
  romaji: string,
  year: number | undefined,
  format: MediaFormat = 'TV',
  rels: [AlRelation, number][] = [],
  month?: number,
): AlMedia {
  return {
    id,
    format,
    startDate: { year, month },
    romaji,
    synonyms: [],
    edges: rels.map(([rel, to]): AlEdge => ({ rel, id: to, type: 'ANIME', format: 'TV' })),
  };
}

export function graph(rootId: number, nodes: AlMedia[]): FranchiseGraph {
  return { rootId, nodes: new Map(nodes.map((n) => [n.id, n])), truncated: false };
}

export function fixtureGraph(name: string, rootId?: number): FranchiseGraph {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as {
    rootId: number;
    nodes: AlMedia[];
  };
  return { rootId: rootId ?? raw.rootId, nodes: new Map(raw.nodes.map((n) => [n.id, n])), truncated: false };
}
