import { sameExactDate, yearsCompatible } from './dates';
import type { AlMedia, MatchConfidence, MediaFormat, SiteMatch, SiteTitle } from './types';

/** Нормализация названия для точного сравнения. Без нечёткого поиска: ложная ссылка хуже отсутствующей. */
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[‘’“”`'"«»]/g, '')
    .replace(/[~:;,.!?()[\]{}\-–—_/\\|·•☆★♪♥+*&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function alNames(m: AlMedia): Set<string> {
  const out = new Set<string>();
  for (const n of [m.romaji, m.english, m.native, ...m.synonyms]) {
    if (!n) continue;
    const k = normalizeTitle(n);
    if (k.length >= 2) out.add(k);
  }
  return out;
}

export function siteNames(t: SiteTitle): Set<string> {
  const out = new Set<string>();
  for (const n of t.names) {
    const k = normalizeTitle(n);
    if (k.length >= 2) out.add(k);
  }
  return out;
}

const FORMAT_GROUP: Record<MediaFormat, string> = {
  TV: 'series', TV_SHORT: 'series', ONA: 'series',
  MOVIE: 'movie',
  OVA: 'extra', SPECIAL: 'extra',
  MUSIC: 'music',
  UNKNOWN: '?',
};

/** Форматы не противоречат друг другу. Сайты часто путают OVA/ONA/Спешл, поэтому сравниваем группы. */
export function formatsCompatible(a: MediaFormat | undefined, b: MediaFormat | undefined): boolean {
  if (!a || !b || a === 'UNKNOWN' || b === 'UNKNOWN') return true;
  const ga = FORMAT_GROUP[a];
  const gb = FORMAT_GROUP[b];
  if (ga === gb) return true;
  // ONA и спешлы/OVA сайты размечают как попало
  const loose = new Set(['series', 'extra']);
  return a === 'ONA' || b === 'ONA' ? loose.has(ga) && loose.has(gb) : false;
}

export const pairKey = (alId: number, siteKey: string) => `${alId}|${siteKey}`;

interface Candidate {
  al: AlMedia;
  site: SiteTitle;
  confidence: MatchConfidence;
}

function candidatesFor(al: AlMedia, site: SiteTitle): MatchConfidence | undefined {
  if (site.anilistId !== undefined) return site.anilistId === al.id ? 'id' : undefined;
  if (!formatsCompatible(al.format, site.format)) return undefined;
  const an = alNames(al);
  for (const n of siteNames(site)) {
    if (an.has(n)) return yearsCompatible(al.startDate, site.date) ? 'name' : undefined;
  }
  if (sameExactDate(al.startDate, site.date) && al.format === site.format) return 'date';
  return undefined;
}

const RANK: Record<MatchConfidence, number> = { site: 4, id: 3, name: 2, date: 1 };

/**
 * Сопоставление узлов AniList с тайтлами сайта.
 * Принимается только взаимно-однозначная пара: у узла один лучший кандидат, у тайтла тоже.
 * При неоднозначности не сопоставляем.
 */
export function matchTitles(
  alNodes: Iterable<AlMedia>,
  pool: SiteTitle[],
  rejected: ReadonlySet<string> = new Set(),
): Map<number, SiteMatch> {
  const all: Candidate[] = [];
  for (const al of alNodes) {
    for (const site of pool) {
      if (rejected.has(pairKey(al.id, site.key))) continue;
      const c = candidatesFor(al, site);
      if (c) all.push({ al, site, confidence: c });
    }
  }
  const best = <K>(key: (c: Candidate) => K) => {
    const m = new Map<K, Candidate[]>();
    for (const c of all) {
      const k = key(c);
      const cur = m.get(k);
      if (!cur || RANK[c.confidence] > RANK[cur[0]!.confidence]) m.set(k, [c]);
      else if (RANK[c.confidence] === RANK[cur[0]!.confidence]) cur.push(c);
    }
    return m;
  };
  const byAl = best((c) => c.al.id);
  const bySite = best((c) => c.site.key);

  const out = new Map<number, SiteMatch>();
  for (const [alId, cands] of byAl) {
    if (cands.length !== 1) continue;
    const c = cands[0]!;
    const back = bySite.get(c.site.key);
    if (!back || back.length !== 1 || back[0]!.al.id !== alId) continue;
    out.set(alId, { title: c.site, confidence: c.confidence });
  }
  return out;
}

/** Проверенный выбор текущего тайтла среди результатов поиска AniList. */
export function pickVerified(current: SiteTitle, results: AlMedia[]): AlMedia | undefined {
  const m = matchTitles(results, [current]);
  const hits = [...m.entries()].filter(([, v]) => v.confidence !== 'date');
  if (hits.length !== 1) return undefined;
  return results.find((r) => r.id === hits[0]![0]);
}
