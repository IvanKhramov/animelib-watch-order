import type { Cache } from '../storage';
import type { SiteTitle } from '../types';

export interface LoadCtx {
  signal: AbortSignal;
  cache: Cache;
  /** «Обновить данные»: не читать кэш */
  force: boolean;
}

export interface Anchor {
  parent: Element;
  before: Element | null;
}

/** Всё, что зависит от конкретного сайта. Ядро (AniList, граф, порядок, UI) общее. */
export interface SiteAdapter {
  id: string;
  /** ключ тайтла, если url это страница тайтла */
  pageKey(url: URL): string | null;
  /** место для блока; null, пока нужная часть страницы не отрисована */
  findAnchor(doc: Document): Anchor | null;
  loadCurrent(key: string, ctx: LoadCtx): Promise<SiteTitle>;
  /** аниме из той же франшизы, известные сайту (без манги/ранобэ) */
  loadRelated(current: SiteTitle, ctx: LoadCtx): Promise<{ titles: SiteTitle[]; partial: boolean }>;
  /** поиск по каталогу сайта; без него ненайденные узлы получают только ссылку на поиск */
  search?(query: string, ctx: LoadCtx): Promise<SiteTitle[]>;
  searchUrl(query: string): string;
}
