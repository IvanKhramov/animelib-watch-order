import { dateKey } from './dates';
import type { AlMedia, AlRelation, FranchiseGraph, ItemKind } from './types';

export interface OrderedNode {
  id: number;
  kind: ItemKind;
  /** номер в основной линии */
  index?: number;
  flags: string[];
}

export interface Ordering {
  /** основная линия по порядку */
  main: OrderedNode[];
  /** дополнительное, вставленное между элементами основной линии по дате (режим «Всё») */
  all: OrderedNode[];
  /** альтернативы, спин-оффы, прочее */
  branches: OrderedNode[];
}

export const FLAG_AMBIGUOUS = 'порядок неоднозначен';
export const FLAG_NO_DATE = 'дата неизвестна';

/** Симметричный список соседей: AniList не всегда хранит обратные связи. */
function adjacency(g: FranchiseGraph) {
  const adj = new Map<number, { id: number; rel: AlRelation }[]>();
  const add = (a: number, b: number, rel: AlRelation) => {
    if (!g.nodes.has(a) || !g.nodes.has(b) || a === b) return;
    const list = adj.get(a) ?? [];
    if (!list.some((x) => x.id === b && x.rel === rel)) list.push({ id: b, rel });
    adj.set(a, list);
  };
  const inverse: Partial<Record<AlRelation, AlRelation>> = {
    PREQUEL: 'SEQUEL', SEQUEL: 'PREQUEL',
    PARENT: 'SIDE_STORY', SIDE_STORY: 'PARENT',
    SUMMARY: 'PARENT', COMPILATION: 'CONTAINS', CONTAINS: 'COMPILATION',
    ALTERNATIVE: 'ALTERNATIVE', SPIN_OFF: 'PARENT', OTHER: 'OTHER',
  };
  for (const m of g.nodes.values()) {
    for (const e of m.edges) {
      if (e.type !== 'ANIME') continue;
      add(m.id, e.id, e.rel);
      const inv = inverse[e.rel];
      if (inv) add(e.id, m.id, inv);
    }
  }
  return adj;
}

const byDate = (nodes: Map<number, AlMedia>) => (a: number, b: number) =>
  dateKey(nodes.get(a)?.startDate) - dateKey(nodes.get(b)?.startDate) || a - b;

/**
 * Топологическая сортировка по рёбрам PREQUEL/SEQUEL, при равенстве по дате выхода.
 * Циклы и противоречия с датами помечаются, а не скрываются.
 */
function orderMain(ids: number[], g: FranchiseGraph, adj: ReturnType<typeof adjacency>, flags: Map<number, string[]>) {
  const set = new Set(ids);
  const indeg = new Map<number, number>(ids.map((id) => [id, 0]));
  const succ = new Map<number, number[]>();
  for (const id of ids) {
    for (const e of adj.get(id) ?? []) {
      if (e.rel !== 'SEQUEL' || !set.has(e.id)) continue;
      const list = succ.get(id) ?? [];
      if (list.includes(e.id)) continue;
      list.push(e.id);
      succ.set(id, list);
      indeg.set(e.id, (indeg.get(e.id) ?? 0) + 1);
    }
  }
  const cmp = byDate(g.nodes);
  const ready = ids.filter((id) => indeg.get(id) === 0).sort(cmp);
  const out: number[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    out.push(id);
    for (const s of succ.get(id) ?? []) {
      const d = (indeg.get(s) ?? 0) - 1;
      indeg.set(s, d);
      if (d === 0) {
        ready.push(s);
        ready.sort(cmp);
      }
    }
  }
  if (out.length < ids.length) {
    // цикл в связях: остаток по дате, с пометкой
    const rest = ids.filter((id) => !out.includes(id)).sort(cmp);
    for (const id of rest) mark(flags, id, FLAG_AMBIGUOUS);
    out.push(...rest);
  }
  // противоречие дат и связей или одинаковые даты
  for (let i = 1; i < out.length; i++) {
    const a = g.nodes.get(out[i - 1]!)?.startDate;
    const b = g.nodes.get(out[i]!)?.startDate;
    if (a?.year && b?.year && dateKey(a) > dateKey(b)) {
      mark(flags, out[i - 1]!, FLAG_AMBIGUOUS);
      mark(flags, out[i]!, FLAG_AMBIGUOUS);
    }
  }
  return out;
}

function mark(flags: Map<number, string[]>, id: number, flag: string) {
  const list = flags.get(id) ?? [];
  if (!list.includes(flag)) list.push(flag);
  flags.set(id, list);
}

const KIND_BY_REL: Partial<Record<AlRelation, ItemKind>> = {
  ALTERNATIVE: 'alternative',
  SPIN_OFF: 'spinoff',
  OTHER: 'other',
  SUMMARY: 'recap',
  COMPILATION: 'recap',
};

// Madoka 1-2 пересказывают сериал, но AniList размечает их ALTERNATIVE, без SUMMARY.
const RECAP_IDS = new Set([11977, 11979]);

const RECAP_RE = /\brecap\b|soushuu|総集編|\bcompilation\b|\bdigest\b/i;

export function isRecap(m: AlMedia): boolean {
  return RECAP_IDS.has(m.id) || [m.romaji, m.english, ...m.synonyms].some((t) => !!t && RECAP_RE.test(t));
}

export function buildOrdering(g: FranchiseGraph): Ordering {
  const adj = adjacency(g);
  const flags = new Map<number, string[]>();
  const root = g.nodes.get(g.rootId);
  if (!root) return { main: [], all: [], branches: [] };

  // если текущий тайтл сам по себе сайд-стори без сиквелов, основная линия идёт от его «родителя»
  const isLine = (id: number) => (adj.get(id) ?? []).some((e) => e.rel === 'PREQUEL' || e.rel === 'SEQUEL');
  const recaps = new Set([...g.nodes.values()].filter(isRecap).map((m) => m.id));
  // AniList: оригинал -> SUMMARY -> пересказ, обратно PARENT (Hibike, Koyomi Vamp).
  // Один PARENT недостаточен: так же связаны обычные OVA и сайд-стори.
  for (const m of g.nodes.values()) {
    for (const e of m.edges) {
      if (e.type === 'ANIME' && (e.rel === 'SUMMARY' || e.rel === 'COMPILATION') && g.nodes.has(e.id)) recaps.add(e.id);
    }
  }
  let seed = g.rootId;
  if (recaps.has(seed) || !isLine(seed)) {
    const parent = (adj.get(seed) ?? []).find((e) => e.rel === 'PARENT' && !recaps.has(e.id) && isLine(e.id));
    const original = parent ?? (recaps.has(seed) ? (adj.get(seed) ?? []).find((e) =>
      e.rel === 'ALTERNATIVE' && !recaps.has(e.id) && g.nodes.get(e.id)!.format === 'TV' && isLine(e.id)) : undefined);
    if (original) seed = original.id;
  }

  // основная линия: компонента связности по PREQUEL/SEQUEL
  const mainSet = new Set<number>([seed]);
  const stack = [seed];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of adj.get(id) ?? []) {
      if ((e.rel === 'PREQUEL' || e.rel === 'SEQUEL') && !mainSet.has(e.id)) {
        mainSet.add(e.id);
        stack.push(e.id);
      }
    }
  }
  // В одной компоненте могут встретиться взаимоисключающие экранизации.
  const lineLinks = (id: number) => new Set((adj.get(id) ?? [])
    .filter((e) => mainSet.has(e.id) && !recaps.has(e.id) && (e.rel === 'PREQUEL' || e.rel === 'SEQUEL'))
    .map((e) => e.id)).size;
  const preferred = [...mainSet].filter((id) => !recaps.has(id)).sort((a, b) =>
    lineLinks(b) - lineLinks(a) ||
    Number(g.nodes.get(b)!.format === 'TV') - Number(g.nodes.get(a)!.format === 'TV') ||
    (g.nodes.get(b)!.episodes ?? 0) - (g.nodes.get(a)!.episodes ?? 0) || byDate(g.nodes)(a, b));
  const alternatives = new Set<number>();
  const selected = new Set<number>();
  for (const id of preferred) {
    if ((adj.get(id) ?? []).some((e) => e.rel === 'ALTERNATIVE' && selected.has(e.id))) alternatives.add(id);
    else selected.add(id);
  }
  // Продолжение исключённого маршрута тоже остаётся в ветках, общий приквел сохраняется.
  const removed = [...alternatives];
  while (removed.length) {
    for (const e of adj.get(removed.pop()!) ?? []) {
      if (e.rel !== 'SEQUEL' || !mainSet.has(e.id) || alternatives.has(e.id)) continue;
      const parents = (adj.get(e.id) ?? []).filter((p) => p.rel === 'PREQUEL' && mainSet.has(p.id));
      if (parents.every((p) => alternatives.has(p.id))) {
        alternatives.add(e.id);
        removed.push(e.id);
      }
    }
  }
  for (const id of alternatives) mainSet.delete(id);
  let mainIds = orderMain([...mainSet], g, adj, flags);

  // Ранний сериал может быть предпосылкой к альтернативному эпизоду (Steins;Gate 23β).
  const first = mainIds.find((id) => !recaps.has(id));
  const prerequisites = first === undefined ? [] : (adj.get(first) ?? [])
    .filter((e) => e.rel === 'ALTERNATIVE' && !mainSet.has(e.id) && !alternatives.has(e.id) && !recaps.has(e.id) &&
      g.nodes.get(e.id)!.format === 'TV' && dateKey(g.nodes.get(e.id)!.startDate) < dateKey(g.nodes.get(first)!.startDate))
    .map((e) => e.id);
  if (prerequisites.length === 1) {
    const before = new Set<number>();
    const pending = [...prerequisites];
    while (pending.length) {
      const id = pending.pop()!;
      if (before.has(id) || mainSet.has(id) || recaps.has(id)) continue;
      before.add(id);
      for (const e of adj.get(id) ?? []) if (e.rel === 'PREQUEL') pending.push(e.id);
    }
    const ordered = orderMain([...before], g, adj, flags);
    for (const id of ordered) {
      mainSet.add(id);
      alternatives.delete(id);
      mark(flags, id, 'предыстория по другой ветке');
    }
    mainIds = [...ordered, ...mainIds];
  }

  // остальное: обход от основной линии, тип узла по первой связи на пути
  const kind = new Map<number, ItemKind>();
  for (const id of mainIds) kind.set(id, recaps.has(id) ? 'recap' : 'main');
  for (const id of alternatives) kind.set(id, 'alternative');
  const queue = [...mainIds, ...alternatives];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const parentKind = kind.get(id)!;
    for (const e of adj.get(id) ?? []) {
      if (kind.has(e.id)) continue;
      let k: ItemKind = KIND_BY_REL[e.rel] ?? (parentKind === 'main' || parentKind === 'recap' ? 'extra' : parentKind);
      // ветка от альтернативы/спин-оффа остаётся в той же ветке
      if (parentKind === 'alternative' || parentKind === 'spinoff' || parentKind === 'other') k = parentKind;
      kind.set(e.id, k);
      queue.push(e.id);
    }
  }
  for (const id of g.nodes.keys()) if (!kind.has(id)) kind.set(id, 'other');
  // Семантика пересказа сильнее любой связи, независимо от порядка обхода.
  for (const id of recaps) kind.set(id, 'recap');

  for (const [id, m] of g.nodes) if (!m.startDate.year) mark(flags, id, FLAG_NO_DATE);

  const node = (id: number, index?: number): OrderedNode => ({
    id,
    kind: kind.get(id)!,
    index,
    flags: flags.get(id) ?? [],
  });

  // рекапы в цепочке сиквелов остаются на своём месте, но без номера и вне режима «Основное»
  let n = 0;
  const main = mainIds.map((id) => node(id, kind.get(id) === 'main' ? ++n : undefined));
  const cmp = byDate(g.nodes);
  const extras = [...g.nodes.keys()]
    .filter((id) => !mainSet.has(id) && (kind.get(id) === 'extra' || kind.get(id) === 'recap'))
    .sort(cmp);

  // вставка дополнительного после последнего элемента основной линии, вышедшего не позже
  const all: OrderedNode[] = [...main];
  for (const id of extras) {
    const k = dateKey(g.nodes.get(id)?.startDate);
    let pos = all.length;
    if (k !== Number.MAX_SAFE_INTEGER) {
      pos = 0;
      for (let i = 0; i < all.length; i++) {
        if (dateKey(g.nodes.get(all[i]!.id)?.startDate) <= k) pos = i + 1;
      }
    }
    all.splice(pos, 0, node(id));
  }

  const branches = [...g.nodes.keys()]
    .filter((id) => ['alternative', 'spinoff', 'other'].includes(kind.get(id)!))
    .sort(cmp)
    .map((id) => node(id));

  return { main, all, branches };
}
