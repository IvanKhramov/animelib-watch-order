import snapshot from '../data/community-orders.json';
import { isObj } from './guards';
import { isAbort, parseJson, type Transport } from './http';
import type { OrderProfile, ProfileRoute, ProfileStep } from './orderProfiles';
import type { LoadCtx } from './sites/site';
import { DAY, HOUR } from './storage';

export const COMMUNITY_URL = 'https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/data/community-orders.json';
const SOURCE_URL = 'https://www.reddit.com/r/anime/wiki/watch_order/';
const SHIKI_URL = 'https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime';
const allowedSource = (value: string) => [SOURCE_URL, SHIKI_URL].some((url) => value === url || value.startsWith(`${url}#`));
const NS = 'community-orders-v1';
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const id = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) < 10_000_000;

export interface CommunityCatalogue {
  version: 1;
  updatedAt: string;
  profiles: OrderProfile[];
}

function parseRoute(raw: unknown): ProfileRoute | undefined {
  if (!isObj(raw) || !text(raw.note, 1500) || !Array.isArray(raw.steps) || raw.steps.length > 80 ||
    !Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > 5) return undefined;
  const steps: ProfileStep[] = [];
  const keys = new Set<string>();
  for (const step of raw.steps) {
    if (!isObj(step) || !id(step.alId) ||
      (step.title !== undefined && !text(step.title, 500)) ||
      (step.note !== undefined && !text(step.note, 800)) ||
      (step.optional !== undefined && typeof step.optional !== 'boolean') ||
      (step.episodes !== undefined && (!text(step.episodes, 60) || !/^\d{1,4}(?:[–-]\d{1,4})?$/.test(step.episodes)))) return undefined;
    const key = `${step.alId}:${step.episodes ?? 'full'}`;
    if (keys.has(key)) return undefined;
    keys.add(key);
    steps.push({ alId: step.alId, title: step.title as string | undefined, episodes: step.episodes as string | undefined,
      optional: step.optional as boolean | undefined, note: step.note as string | undefined });
  }
  const sources = [];
  for (const source of raw.sources) {
    if (!isObj(source) || !text(source.label, 500) || !text(source.url, 600) ||
      !allowedSource(source.url) ||
      (source.detail !== undefined && !text(source.detail, 800))) return undefined;
    sources.push({ label: source.label, url: source.url, detail: source.detail as string | undefined });
  }
  return { steps, note: raw.note, sources };
}

/** Данные фида не содержат кода, HTML, произвольных URL или нечётких названий для сопоставления. */
export function parseCatalogue(raw: unknown): CommunityCatalogue | undefined {
  if (!isObj(raw) || raw.version !== 1 || !text(raw.updatedAt, 60) || !Number.isFinite(Date.parse(raw.updatedAt)) ||
    !Array.isArray(raw.profiles) || raw.profiles.length > 500) return undefined;
  const profiles: OrderProfile[] = [];
  const profileIds = new Set<string>();
  for (const p of raw.profiles) {
    if (!isObj(p) || !text(p.id, 200) || !/^(?:community|shikimori):[a-z0-9_-]+$/.test(p.id) || profileIds.has(p.id) ||
      !text(p.title, 300) || !text(p.checkedAt, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(p.checkedAt) ||
      !Array.isArray(p.anchorIds) || !p.anchorIds.length || p.anchorIds.length > 160 || !p.anchorIds.every(id)) return undefined;
    const recommended = parseRoute(p.recommended);
    const chronological = p.chronological === undefined ? undefined : parseRoute(p.chronological);
    if (!recommended || (p.chronological !== undefined && !chronological) ||
      (!recommended.steps.length && !chronological?.steps.length)) return undefined;
    const expectedSource = p.id.startsWith('shikimori:') ? SHIKI_URL : SOURCE_URL;
    if ([recommended, chronological].some((route) => route?.sources.some((source) => source.url !== expectedSource && !source.url.startsWith(`${expectedSource}#`)))) return undefined;
    for (const route of [recommended, chronological]) if (route) {
      route.origin = 'community';
      route.variantId = p.id;
      route.label = p.id.startsWith('shikimori:') ? 'Shikimori' : 'r/anime';
      route.checkedAt = p.checkedAt;
    }
    const anchors = [...new Set(p.anchorIds as number[])];
    const steps = [...recommended.steps, ...(chronological?.steps ?? [])];
    if (steps.some((step) => !anchors.includes(step.alId))) return undefined;
    if (p.limitations !== undefined && (!Array.isArray(p.limitations) || p.limitations.length > 10 ||
      !p.limitations.every((s) => text(s, 1000)))) return undefined;
    profiles.push({
      id: p.id, title: p.title, checkedAt: p.checkedAt, anchorIds: anchors, origin: 'community',
      recommended, chronological, limitations: p.limitations as string[] | undefined,
      chronologyUnavailable: 'В источнике нет однозначно разобранного событийного маршрута. Порядок по датам выхода доступен автоматически.',
    });
    profileIds.add(p.id);
  }
  return { version: 1, updatedAt: raw.updatedAt, profiles };
}

export function communityProfile(catalogue: CommunityCatalogue, rootId: number): OrderProfile | undefined {
  const matches = catalogue.profiles.filter((profile) => profile.anchorIds.includes(rootId));
  // Неоднозначность внутри одного источника не разрешаем по похожему названию.
  const candidates = ['community:', 'shikimori:'].flatMap((prefix) => {
    const group = matches.filter((profile) => profile.id.startsWith(prefix));
    return group.length === 1 ? group : [];
  });
  const primary = candidates.find((profile) => profile.recommended.steps.length) ?? candidates[0];
  if (!primary) return undefined;
  const chronologicalVariants = candidates.flatMap((profile) => profile.chronological ? [profile.chronological] : []);
  return {
    ...primary,
    anchorIds: [...new Set(candidates.flatMap((profile) => profile.anchorIds))],
    chronological: chronologicalVariants[0],
    chronologicalVariants: chronologicalVariants.length > 1 ? chronologicalVariants : undefined,
    limitations: [...new Set(candidates.flatMap((profile) => profile.limitations ?? []))],
  };
}

export class CommunityOrdersClient {
  constructor(private readonly transport: Transport) {}

  /** Переход внутри уже загруженной франшизы не должен запускать обновление фида. */
  peek(rootId: number, ctx: Pick<LoadCtx, 'cache'>): OrderProfile | undefined {
    const latest = parseCatalogue(ctx.cache.get(NS, 'latest'));
    const saved = parseCatalogue(ctx.cache.get(NS, 'last-good'));
    const bundled = parseCatalogue(snapshot)!;
    const fallback = saved && Date.parse(saved.updatedAt) >= Date.parse(bundled.updatedAt) ? saved : bundled;
    return communityProfile(latest ?? fallback, rootId);
  }

  async load(rootId: number, ctx: LoadCtx): Promise<{ profile?: OrderProfile; note?: string }> {
    const cached = !ctx.force ? parseCatalogue(ctx.cache.get(NS, 'latest')) : undefined;
    if (cached) return { profile: communityProfile(cached, rootId) };
    const bundled = parseCatalogue(snapshot)!;
    const saved = parseCatalogue(ctx.cache.get(NS, 'last-good'));
    const fallback = saved && Date.parse(saved.updatedAt) >= Date.parse(bundled.updatedAt) ? saved : bundled;
    const useFallback = () => ({ profile: communityProfile(fallback, rootId), note: 'Автокаталог: используется сохранённая копия источника.' });
    if (!ctx.force && ctx.cache.get(NS, 'cooldown')) return useFallback();
    try {
      const response = await this.transport({ url: COMMUNITY_URL, method: 'GET', signal: ctx.signal, timeoutMs: 4000 });
      if (response.text.length > 1_500_000) throw new Error('каталог слишком большой');
      const catalogue = parseCatalogue(parseJson(response, 'Каталог порядков'));
      if (!catalogue || !catalogue.profiles.length) throw new Error('неверный формат каталога');
      // Старый ответ CDN не заменяет более свежий сохранённый каталог.
      const newest = Date.parse(catalogue.updatedAt) >= Date.parse(fallback.updatedAt) ? catalogue : fallback;
      ctx.cache.set(NS, 'latest', newest, DAY);
      ctx.cache.set(NS, 'last-good', newest, 90 * DAY);
      return { profile: communityProfile(newest, rootId) };
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted) throw error;
      ctx.cache.set(NS, 'cooldown', true, HOUR / 4);
      return useFallback();
    }
  }
}
