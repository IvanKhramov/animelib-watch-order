import { CURATED_PROFILES } from './data/orderProfiles';

export type WatchOrderMode = 'recommended' | 'release' | 'chronological';

export interface OrderSource {
  label: string;
  url: string;
  detail?: string;
}

export interface ProfileStep {
  alId: number;
  /** Диапазон в нумерации этой записи AniList, а не всего сериала. */
  episodes?: string;
  optional?: boolean;
  note?: string;
  title?: string;
}

export interface ProfileRoute {
  steps: ProfileStep[];
  note: string;
  sources: OrderSource[];
}

export interface OrderProfile {
  id: string;
  title: string;
  /** Только страницы самой франшизы, без кроссоверов и чужих спин-оффов. */
  anchorIds: number[];
  checkedAt: string;
  recommended: ProfileRoute;
  chronological?: ProfileRoute;
  chronologyUnavailable?: string;
  limitations?: string[];
}

// Каталог обновляется вместе со скриптом. Часть вне маршрута не получает выдуманную позицию.
export const ORDER_PROFILES: OrderProfile[] = CURATED_PROFILES;

export const profileForId = (id: number) => ORDER_PROFILES.find((profile) => profile.anchorIds.includes(id));
