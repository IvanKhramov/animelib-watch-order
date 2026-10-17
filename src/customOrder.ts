/** Пользовательская правка порядка франшизы: свой порядок и скрытые части. */
export interface CustomOrder {
  /** ключи элементов (watchKey) в порядке пользователя */
  order: string[];
  /** скрытые элементы */
  hidden: string[];
}

/**
 * Применяет сохранённый порядок к свежему списку.
 * Элементы, которых нет в сохранённом порядке (новые сезоны), встают сразу после
 * своего соседа по умолчанию, чтобы новинка не уезжала в конец.
 */
export function applyOrder(defaults: string[], saved: string[] | undefined): string[] {
  if (!saved || saved.length === 0) return [...defaults];
  const present = new Set(defaults);
  const out = saved.filter((k, i) => present.has(k) && saved.indexOf(k) === i);
  const placed = new Set(out);
  defaults.forEach((k, i) => {
    if (placed.has(k)) return;
    // ближайший предыдущий по умолчанию элемент, который уже стоит в выдаче
    let pos = 0;
    for (let j = i - 1; j >= 0; j--) {
      const at = out.indexOf(defaults[j]!);
      if (at >= 0) {
        pos = at + 1;
        break;
      }
    }
    out.splice(pos, 0, k);
    placed.add(k);
  });
  return out;
}

/**
 * Сдвиг элемента на одну позицию среди видимых.
 * visible: ключи, которые сейчас на экране (режим «Основное» показывает не всё).
 */
export function move(full: string[], key: string, dir: -1 | 1, visible: ReadonlySet<string>): string[] {
  const out = [...full];
  const from = out.indexOf(key);
  if (from < 0) return out;
  let to = from + dir;
  while (to >= 0 && to < out.length && !visible.has(out[to]!)) to += dir;
  if (to < 0 || to >= out.length) return out;
  out.splice(from, 1);
  out.splice(to, 0, key);
  return out;
}
