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

function candidateRank(c: Candidate): number {
  // При равном названии сначала точный год, затем полная дата. ID не уточняем датой.
  const dateRank = c.confidence === 'name'
    ? (c.site.date?.year !== undefined && c.site.date.year === c.al.startDate.year ? 2 : 0) +
      (sameExactDate(c.site.date, c.al.startDate) ? 1 : 0)
    : 0;
  return RANK[c.confidence] * 4 + dateRank;
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
      if (!cur || candidateRank(c) > candidateRank(cur[0]!)) m.set(k, [c]);
      else if (candidateRank(c) === candidateRank(cur[0]!)) cur.push(c);
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

/** Явный номер части в конце названия, без нечёткого сравнения. */
function partName(name: string): { base: string; number: number } | undefined {
  const m = normalizeTitle(name).match(/^(.+?)\s+(?:(?:part|часть)\s+)?(\d+)$/);
  return m && m[1]!.length >= 6 ? { base: m[1]!, number: Number(m[2]) } : undefined;
}

function nextPart(primary: SiteTitle, title: SiteTitle, al: AlMedia): boolean {
  for (const name of primary.names) {
    const a = partName(name);
    if (!a) continue;
    // Базовое название должно подтверждаться самой записью AniList.
    if (![...alNames(al)].some((n) => partName(n)?.base === a.base)) continue;
    if (title.names.some((n) => {
      const b = partName(n);
      return b?.base === a.base && b.number === a.number + 1;
    })) return true;
  }
  return false;
}

/** Дополнительные карточки принимаются только после однозначного основного сопоставления. */
export function matchParts(
  nodes: Iterable<AlMedia>, matches: Map<number, SiteMatch>, pool: SiteTitle[],
  rejected: ReadonlySet<string> = new Set(),
): Map<number, SiteMatch[]> {
  const used = new Set([...matches.values()].map((m) => m.title.key));
  const proposals = new Map<string, { id: number; match: SiteMatch }[]>();
  // В AniList 100049 явно объединены Memory Snow и Frozen Bond (два эпизода в записи).
  const bundled = new Set(['13329--rezero-kara-hajimeru-isekai-seikatsu-memory-snow-anime',
    '14685--rezero-kara-hajimeru-isekai-seikatsu-hyouketsu-no-kizuna-anime']);
  for (const al of nodes) {
    const primary = matches.get(al.id)?.title;
    if (!primary) continue;
    for (const title of pool) {
      if (used.has(title.key) || rejected.has(pairKey(al.id, title.key)) ||
        (title.anilistId !== undefined && title.anilistId !== al.id) ||
        !primary.format || primary.format === 'UNKNOWN' || title.format !== primary.format ||
        !primary.date?.year || !title.date?.year || !yearsCompatible(primary.date, title.date) ||
        !yearsCompatible(al.startDate, title.date)) continue;
      const bundle = al.id === 100049 && bundled.has(primary.key) && bundled.has(title.key);
      if (!bundle && !nextPart(primary, title, al)) continue;
      const list = proposals.get(title.key) ?? [];
      list.push({ id: al.id, match: { title, confidence: title.anilistId === al.id ? 'id' : 'name' } });
      proposals.set(title.key, list);
    }
  }
  const out = new Map<number, SiteMatch[]>();
  for (const proposalsForTitle of proposals.values()) {
    if (proposalsForTitle.length !== 1) continue;
    const { id, match } = proposalsForTitle[0]!;
    const list = out.get(id) ?? [];
    list.push(match);
    out.set(id, list);
  }
  // Две карточки одного следующего номера тоже неоднозначны.
  for (const [id, titles] of out) if (titles.length !== 1) out.delete(id);
  return out;
}
