import { parseIsoDate } from '../dates';
import { arr, isObj, str } from '../guards';
import { isAbort, limiter, type Transport } from '../http';
import { DAY } from '../storage';
import type { MediaFormat, SiteRelationKind, SiteTitle } from '../types';
import type { LoadCtx, SiteAdapter } from './site';

// Проверено 2026-10-17: страницы рендерятся на сервере (Hotwire Turbo), в <head> есть JSON-LD
// с английским alternateName и датой, на странице блок «Связанное» (.seasons) с типом, годом и связью.

const FORMAT_BY_LABEL: Record<string, MediaFormat> = {
  'Сериал': 'TV',
  'ТВ Сериал': 'TV',
  'Фильм': 'MOVIE',
  'OVA': 'OVA',
  'ONA': 'ONA',
  'Спешл': 'SPECIAL',
  'Короткометражка': 'TV_SHORT',
  'Клип': 'MUSIC',
};

export function relationKind(label: string): SiteRelationKind {
  const l = label.toLowerCase();
  if (l.includes('предыстори')) return 'prequel';
  if (l.includes('продолжени')) return 'sequel';
  if (/альтернатив|спин|побочн|обобщ|истори|сайд|версия|пересказ/.test(l)) return 'story';
  return 'other';
}

const PATH_RE = /^\/anime\/[a-z0-9-]+-\d+\/?$/;

interface ParsedPage {
  title: SiteTitle;
  related: SiteTitle[];
}

function ownText(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

/** Значение строки «Тип» из блока характеристик. */
function infoValue(doc: Document, label: string): string | undefined {
  for (const el of doc.querySelectorAll('div, dt, span')) {
    if (el.children.length === 0 && ownText(el) === label) {
      const v = ownText(el.nextElementSibling);
      if (v) return v;
    }
  }
  return undefined;
}

function jsonLd(doc: Document): Record<string, unknown> | undefined {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const v = JSON.parse(s.textContent ?? '') as unknown;
      for (const item of Array.isArray(v) ? v : [v]) {
        if (isObj(item) && typeof item['@type'] === 'string' && /Series|Movie|CreativeWork/.test(item['@type'])) {
          return item;
        }
      }
    } catch {
      /* битый JSON-LD пропускаем */
    }
  }
  return undefined;
}

export function parseAnimegoPage(doc: Document, url: URL): ParsedPage {
  const ld = jsonLd(doc);
  const h1 = ownText(doc.querySelector('h1'));
  const name = h1 || str(ld?.name) || url.pathname;
  const alt = ld ? [str(ld.alternateName), ...arr(ld.alternateName).map(str)] : [];
  const synonyms = [...doc.querySelectorAll('.entity__title-synonyms li')].map(ownText);
  const typeLabel = infoValue(doc, 'Тип');
  const title: SiteTitle = {
    key: url.pathname.replace(/\/$/, ''),
    url: `${url.origin}${url.pathname}`,
    displayName: name,
    names: [name, str(ld?.name), ...alt, ...synonyms].filter((x): x is string => !!x),
    date: parseIsoDate(str(ld?.datePublished)),
    format: typeLabel ? (FORMAT_BY_LABEL[typeLabel] ?? 'UNKNOWN') : undefined,
    formatLabel: typeLabel,
  };

  const related: SiteTitle[] = [];
  const block = [...doc.querySelectorAll('.seasons')].find((s) => ownText(s.querySelector('h2')) === 'Связанное');
  for (const item of block?.querySelectorAll('.seasons-item') ?? []) {
    const a = item.querySelector<HTMLAnchorElement>('a.seasons__link');
    const href = a?.getAttribute('href');
    if (!a || !href || !PATH_RE.test(href)) continue;
    const info = item.querySelector('.seasons__info');
    // <div class="seasons__info"><div><span>Тип</span><span>/</span><span>Год</span></div><div>Связь</div></div>
    const spans = [...(info?.firstElementChild?.querySelectorAll('span') ?? [])].map(ownText).filter((s) => s && s !== '/');
    const label = info && info.children.length > 1 ? ownText(info.lastElementChild) : '';
    const img = item.querySelector('img')?.getAttribute('src') ?? undefined;
    const fl = spans[0];
    const year = Number(spans[1]);
    related.push({
      key: href.replace(/\/$/, ''),
      url: `${url.origin}${href}`,
      displayName: ownText(a),
      names: [ownText(a)],
      date: Number.isInteger(year) && year > 1900 ? { year } : undefined,
      format: fl ? (FORMAT_BY_LABEL[fl] ?? 'UNKNOWN') : undefined,
      formatLabel: fl,
      relationLabel: label,
      relationKind: relationKind(label),
      cover: img?.startsWith('https://') ? img : undefined,
    });
  }
  return { title, related };
}

/** Сериализуемая часть разбора для кэша. */
type CachedPage = ParsedPage;

export function createAnimego(transport: Transport): SiteAdapter {
  const limit = limiter(2);

  const loadPage = (key: string, ctx: LoadCtx): Promise<CachedPage> => {
    const url = new URL(key, location.origin);
    if (location.pathname.replace(/\/$/, '') === key) {
      return Promise.resolve(parseAnimegoPage(document, url));
    }
    return ctx.cache.wrap('ag-page', key, 3 * DAY, async () => {
      const res = await limit(() => transport({ url: url.href, signal: ctx.signal, headers: { Accept: 'text/html' } }));
      if (res.status !== 200) throw new Error(`animego: HTTP ${res.status}`);
      return parseAnimegoPage(new DOMParser().parseFromString(res.text, 'text/html'), url);
    }, ctx.force);
  };

  return {
    id: 'animego',

    pageKey(url) {
      if (!/(^|\.)animego\.[a-z]+$/.test(url.hostname)) return null;
      return PATH_RE.test(url.pathname) ? url.pathname.replace(/\/$/, '') : null;
    },

    findAnchor(doc) {
      const block = [...doc.querySelectorAll('.seasons')].find((s) => ownText(s.querySelector('h2')) === 'Связанное');
      if (block?.parentElement) return { parent: block.parentElement, before: block };
      return null;
    },


    async loadCurrent(key, ctx) {
      return (await loadPage(key, ctx)).title;
    },

    async loadRelated(current, ctx) {
      // связи с текущей страницы, затем один шаг вглубь: страницы связанных дают английские названия и точные даты
      const first = (await loadPage(current.key, ctx)).related;
      const out = new Map<string, SiteTitle>();
      const seen = new Set([current.key]);
      for (const r of first) {
        seen.add(r.key);
        out.set(r.key, r);
      }
      let partial = false;
      const pages = await Promise.all(
        first.slice(0, 15).map((r) => loadPage(r.key, ctx).catch((e: unknown) => {
          if (isAbort(e)) throw e;
          partial = true;
          return undefined;
        })),
      );
      for (const [i, p] of pages.entries()) {
        if (!p) continue;
        const base = first[i]!;
        out.set(base.key, { ...base, names: [...new Set([...base.names, ...p.title.names])], date: p.title.date ?? base.date, format: p.title.format ?? base.format });
        for (const r of p.related) {
          if (seen.has(r.key) || out.size >= 30) continue;
          seen.add(r.key);
          const kind = base.relationKind === r.relationKind ? r.relationKind : 'story';
          out.set(r.key, { ...r, relationKind: kind });
        }
      }
      return { titles: [...out.values()], partial };
    },

    searchUrl: (query) => `${location.origin}/search/all?q=${encodeURIComponent(query)}`,
  };
}
