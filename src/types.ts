export type MediaFormat =
  | 'TV'
  | 'TV_SHORT'
  | 'MOVIE'
  | 'SPECIAL'
  | 'OVA'
  | 'ONA'
  | 'MUSIC'
  | 'UNKNOWN';

export interface FuzzyDate {
  year?: number;
  month?: number;
  day?: number;
}

/** Связь в терминах AniList (relationType version 2). */
export type AlRelation =
  | 'PREQUEL'
  | 'SEQUEL'
  | 'SIDE_STORY'
  | 'PARENT'
  | 'SUMMARY'
  | 'ALTERNATIVE'
  | 'SPIN_OFF'
  | 'OTHER'
  | 'COMPILATION'
  | 'CONTAINS'
  | 'CHARACTER'
  | 'ADAPTATION'
  | 'SOURCE';

export interface AlEdge {
  rel: AlRelation;
  id: number;
  type: 'ANIME' | 'MANGA';
  format: MediaFormat;
}

export interface AlMedia {
  id: number;
  format: MediaFormat;
  startDate: FuzzyDate;
  romaji: string;
  english?: string;
  native?: string;
  synonyms: string[];
  episodes?: number;
  cover?: { medium?: string; large?: string };
  edges: AlEdge[];
}

export interface FranchiseGraph {
  rootId: number;
  nodes: Map<number, AlMedia>;
  /** true, если обход упёрся в лимиты и граф может быть неполным */
  truncated: boolean;
}

/** Грубая классификация связи, увиденной на сайте. */
export type SiteRelationKind = 'prequel' | 'sequel' | 'story' | 'other';

/** Тайтл на сайте, где пользователь смотрит аниме. */
export interface SiteTitle {
  /** уникальный ключ на сайте (slug_url, путь) */
  key: string;
  /** абсолютная ссылка на страницу тайтла */
  url: string;
  /** отображаемое название (русское, если есть) */
  displayName: string;
  /** все известные названия для сопоставления */
  names: string[];
  date?: FuzzyDate;
  format?: MediaFormat;
  formatLabel?: string;
  anilistId?: number;
  /** ссылка на обложку на сайте */
  cover?: string;
  /** связь относительно текущей страницы, как её подписал сайт */
  relationLabel?: string;
  relationKind?: SiteRelationKind;
}

/** site: ссылку дал сам сайт (его же блок связей), сопоставление не требуется */
export type MatchConfidence = 'id' | 'name' | 'date' | 'site';

export interface SiteMatch {
  title: SiteTitle;
  confidence: MatchConfidence;
}

export type ItemKind = 'main' | 'extra' | 'recap' | 'alternative' | 'spinoff' | 'other';

export interface OrderItem {
  /** ключ для хранения отметок «просмотрено» */
  watchKey: string;
  /** Разные диапазоны серий одного тайтла имеют общую отметку, но разные строки. */
  rowKey?: string;
  episodes?: string;
  alId?: number;
  title: string;
  subtitle?: string;
  format: MediaFormat;
  formatLabel?: string;
  date?: FuzzyDate;
  kind: ItemKind;
  /** номер в основной линии (1..n) */
  index?: number;
  /** Ещё одна карточка той же записи AniList, без отдельного номера. */
  continuation?: boolean;
  isCurrent: boolean;
  flags: string[];
  match?: SiteMatch;
  searchUrl?: string;
  cover?: string;
  coverLarge?: string;
}

export interface OrderResult {
  mode: 'anilist' | 'site-only';
  rootAlId?: number;
  /** ключ, под которым хранится пользовательский порядок франшизы */
  franchiseKey: string;
  /** основная линия + дополнительное (в режиме «Всё») по порядку */
  items: OrderItem[];
  /** альтернативы, спин-оффы и прочее */
  branches: OrderItem[];
  notes: string[];
}
