// Прогон пайплайна из node на живых данных: npx esbuild ... | node. Только для разработки.
import { AniListClient } from '../src/anilistAdapter';
import { fetchTransport, withRetry } from '../src/http';
import { createAnimeLib } from '../src/sites/animelib';
import { Cache, memoryKV, UserState } from '../src/storage';
import { buildWatchOrder } from '../src/watchOrder';
import type { OrderItem } from '../src/types';

const ua: typeof fetchTransport = (req) =>
  fetchTransport({ ...req, headers: { ...req.headers, Origin: 'https://animelib.org', Referer: 'https://animelib.org/' } });

const key = process.argv[2]!;
// заголовок страницы для запасного пути (лицензированный тайтл без логина)
(globalThis as { document?: unknown }).document = { title: process.argv[3] ?? '' };
const kv = memoryKV();
const t = withRetry(ua);
const res = await buildWatchOrder(key, {
  adapter: createAnimeLib(t),
  anilist: new AniListClient(t),
  user: new UserState(kv),
  ctx: { signal: new AbortController().signal, cache: new Cache(kv), force: false },
});
const line = (i: OrderItem) =>
  `${i.isCurrent ? '▶' : i.kind === 'main' ? '○' : '◇'} ${i.index ?? ' '} ${i.title} · ${i.formatLabel} · ${i.date?.year ?? '?'}` +
  `${i.kind !== 'main' ? ' · ' + i.kind : ''} ${i.match ? '[' + i.match.confidence + ' ' + i.match.title.key.slice(0, 40) + ']' : '[НЕ НАЙДЕНО]'}${i.flags.length ? ' {' + i.flags.join(',') + '}' : ''}`;
console.log('mode:', res.mode);
res.items.forEach((i) => console.log(line(i)));
console.log('-- branches');
res.branches.forEach((i) => console.log(line(i)));
console.log('notes:', res.notes.join(' | '));
