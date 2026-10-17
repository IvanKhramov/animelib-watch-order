import { dateKey } from './dates';
import { ORDER_PROFILES, type OrderProfile, type OrderSource, type WatchOrderMode } from './orderProfiles';
import type { OrderItem, OrderResult } from './types';

export const MODE_LABELS: Record<WatchOrderMode, string> = {
  recommended: 'Рекомендованный', release: 'По выходу', chronological: 'По событиям',
};

export const rowKey = (item: OrderItem) => item.rowKey ?? item.watchKey;

export interface ModeResult extends OrderResult {
  selectedMode: WatchOrderMode;
  orderKey: string;
  legacyOrderKeys: string[];
  verified: boolean;
  available: boolean;
  explanation: string;
  sources: OrderSource[];
  profile?: OrderProfile;
}

export function findProfile(result: OrderResult, profiles = ORDER_PROFILES): OrderProfile | undefined {
  // Не определяем франшизу по любому соседу: граф может содержать кроссоверы.
  const current = [...result.items, ...result.branches].find((item) => item.isCurrent)?.alId;
  const id = result.rootAlId ?? current ?? Number(result.franchiseKey.match(/^al:(\d+)$/)?.[1]);
  if (!id || result.mode !== 'anilist') return undefined;
  return profiles.find((profile) => profile.anchorIds.includes(id));
}

export function selectOrder(result: OrderResult, selectedMode: WatchOrderMode, profiles = ORDER_PROFILES): ModeResult {
  const profile = findProfile(result, profiles);
  const franchiseKey = profile ? `al:${profile.anchorIds[0]}` : result.franchiseKey;
  const base: ModeResult = {
    ...result, selectedMode, profile,
    // Старые пользовательские правки продолжают действовать в рекомендованном режиме.
    orderKey: selectedMode === 'recommended' ? franchiseKey : `${franchiseKey}:${selectedMode}`,
    legacyOrderKeys: selectedMode === 'recommended'
      ? [...new Set([result.franchiseKey, ...(profile?.anchorIds.map((id) => `al:${id}`) ?? [])])].filter((key) => key !== franchiseKey)
      : [],
    verified: false, available: true, sources: [], explanation: '',
  };
  if (selectedMode === 'release') {
    const items = [...result.items, ...result.branches].sort((a, b) => dateKey(a.date) - dateKey(b.date));
    return {
      ...base, items, branches: [],
      explanation: 'По датам начала выхода тайтлов. Альтернативные версии и спин-оффы не обязательны для просмотра. Неполные даты приблизительны, неизвестные — в конце.',
    };
  }
  const route = selectedMode === 'recommended' ? profile?.recommended : profile?.chronological;
  if (!route) {
    return {
      ...base, available: selectedMode !== 'chronological',
      items: selectedMode === 'chronological' ? [] : result.items,
      explanation: selectedMode === 'chronological'
        ? profile?.chronologyUnavailable ?? 'Проверенной хронологии событий пока нет. Можно выбрать порядок по выходу.'
        : 'Автоматический порядок по связям и датам. Проверенного маршрута для первого просмотра пока нет.',
    };
  }
  const all = [...result.items, ...result.branches];
  const byId = new Map<number, OrderItem[]>();
  for (const item of all) {
    if (item.alId === undefined) continue;
    const group = byId.get(item.alId) ?? [];
    group.push(item);
    byId.set(item.alId, group);
  }
  const included = new Set<number>();
  const items: OrderItem[] = [];
  for (const step of route.steps) {
    const group = byId.get(step.alId);
    if (!group) continue;
    included.add(step.alId);
    for (const item of group) {
      const flags = item.flags.filter((flag) => flag !== 'порядок неоднозначен' && flag !== 'предыстория по другой ветке');
      if (step.note) flags.push(step.note);
      if (step.optional) flags.push('необязательно');
      // Если сайт делит одну запись AniList, диапазон нельзя приписать отдельной карточке.
      const episodes = group.length === 1 ? step.episodes : undefined;
      if (step.episodes && !episodes) flags.push(`диапазон всей записи: серии ${step.episodes}; нумерация карточек сайта может отличаться`);
      items.push({
        ...item, rowKey: step.episodes ? `${item.watchKey}:episodes:${step.episodes}` : item.watchKey, episodes,
        kind: step.optional ? 'extra' : 'main', index: undefined,
        continuation: item.continuation, flags,
      });
    }
  }
  const missing = route.steps.filter((step) => !byId.has(step.alId));
  const branches = all.filter((item) => item.alId === undefined || !included.has(item.alId)).map((item) => ({
    ...item, flags: [...item.flags, 'вне проверенного маршрута'],
  }));
  const notes = [...result.notes];
  if (missing.length) notes.push(`В загруженных данных нет ${new Set(missing.map((step) => step.alId)).size} частей проверенного маршрута. Список неполный.`);
  if (route.steps.some((step) => step.episodes)) notes.push('Диапазоны серий относятся к указанному тайтлу. Отметка «просмотрено» общая для всех его диапазонов.');
  return {
    ...base, items, branches, notes, verified: true, sources: route.sources,
    explanation: `${missing.length ? 'Маршрут неполный: часть тайтлов не загрузилась. ' : ''}${route.note} Проверено: ${profile!.checkedAt}. Части вне маршрута показаны отдельно.`,
  };
}
