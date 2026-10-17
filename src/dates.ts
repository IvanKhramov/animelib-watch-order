import type { FuzzyDate } from './types';

const RU_MONTHS = [
  'январ', 'феврал', 'март', 'апрел', 'ма', 'июн',
  'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр',
];

/** "2021-07-03", "2027-01-01" */
export function parseIsoDate(s: string | undefined): FuzzyDate | undefined {
  const m = s?.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (!m) return undefined;
  const d: FuzzyDate = { year: Number(m[1]) };
  if (m[2]) d.month = Number(m[2]);
  if (m[3]) d.day = Number(m[3]);
  return d;
}

/** "12 января 2019 г.", "2027 г.", "" */
export function parseRuDate(s: string | undefined): FuzzyDate | undefined {
  if (!s) return undefined;
  const y = s.match(/(\d{4})/);
  if (!y) return undefined;
  const d: FuzzyDate = { year: Number(y[1]) };
  const dm = s.toLowerCase().match(/(\d{1,2})\s+([а-яё]+)/);
  if (dm) {
    // "март" стоит в списке раньше "ма", поэтому "марта" не примет за май
    const word = dm[2]!;
    const idx = RU_MONTHS.findIndex((p) => word.startsWith(p));
    if (idx >= 0) {
      d.month = idx + 1;
      d.day = Number(dm[1]);
    }
  }
  return d;
}

/** Ключ сортировки: неизвестные месяц/день уходят в конец года/месяца, неизвестный год в самый конец. */
export function dateKey(d: FuzzyDate | undefined): number {
  if (!d?.year) return Number.MAX_SAFE_INTEGER;
  return d.year * 10_000 + (d.month ?? 12) * 100 + (d.day ?? 31);
}

export const isExactDate = (d: FuzzyDate | undefined): boolean =>
  !!(d?.year && d.month && d.day);

export const sameExactDate = (a: FuzzyDate | undefined, b: FuzzyDate | undefined): boolean =>
  isExactDate(a) && isExactDate(b) && a!.year === b!.year && a!.month === b!.month && a!.day === b!.day;

/** Годы не противоречат друг другу (допуск ±1: анонсы, премьеры на фестивалях). */
export function yearsCompatible(a: FuzzyDate | undefined, b: FuzzyDate | undefined): boolean {
  if (!a?.year || !b?.year) return true;
  return Math.abs(a.year - b.year) <= 1;
}
