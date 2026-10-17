// Лёгкие проверки недоверенного JSON без внешних зависимостей.

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const obj = (v: unknown): Obj => (isObj(v) ? v : {});

export function strings(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}
