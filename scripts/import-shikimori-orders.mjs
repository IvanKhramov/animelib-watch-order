import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const SOURCE = 'https://shikimori.io/clubs/2881-pravilnaya-hronologiya-anime';
const UPSTREAM = 'https://shikimori.io/api/clubs/2881';
const WIKI = 'https://raw.githubusercontent.com/Bas1874/Anime-Watch-Order-Api/main/data/watch_order_api.json';
const ANILIST = 'https://graphql.anilist.co';
const SOURCE_CHECKED_AT = '2020-06-26';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_STEPS = 80;
const USER_AGENT = 'animelib-watch-order community importer (+https://github.com/IvanKhramov/animelib-watch-order)';
const validId = (id) => Number.isSafeInteger(id) && id > 0 && id < 10000000;
const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const fail = (reason) => { throw new Error(reason); };

function sourceAnimeUrl(value) {
  try {
    const url = new URL(value, 'https://shikimori.io');
    return url.protocol === 'https:' && url.hostname === 'shikimori.io' && url.pathname.startsWith('/animes/')
      ? `${url.origin}${url.pathname}` : undefined;
  } catch { return undefined; }
}

function trailingFlags(block) {
  let text = '';
  for (let node = block.nextSibling; node; node = node.nextSibling) {
    if (node.nodeType === 1 && node.matches('.b-spoiler_block')) break;
    text += ` ${node.textContent ?? ''}`;
  }
  return /не\s*проверен[ао]?|неполный\s*список/iu.test(text);
}

function parseStep(li, inventory) {
  if (li.tagName !== 'LI' || li.querySelector('.b-spoiler,.b-spoiler_block,ul,ol')) fail('nested-instructions');
  const animeLinks = [...li.querySelectorAll('a')].filter((anchor) => {
    if (anchor.hasAttribute('data-attrs')) {
      try { return JSON.parse(anchor.getAttribute('data-attrs')).type === 'anime'; } catch { return false; }
    }
    return inventory.has(sourceAnimeUrl(anchor.getAttribute('href')));
  });
  if (animeLinks.length !== 1 || animeLinks[0].parentElement !== li) fail('ambiguous-step');
  const anchor = animeLinks[0];
  let malId;
  if (anchor.hasAttribute('data-attrs')) {
    let attrs;
    try { attrs = JSON.parse(anchor.getAttribute('data-attrs')); } catch { fail('invalid-anime-attributes'); }
    if (attrs.type !== 'anime' || !validId(attrs.id)) fail('invalid-mal-id');
    malId = attrs.id;
    const known = inventory.get(sourceAnimeUrl(anchor.getAttribute('href')));
    if (known && known !== malId) fail('conflicting-source-id');
  } else malId = inventory.get(sourceAnimeUrl(anchor.getAttribute('href')));
  if (!validId(malId)) fail('invalid-mal-id');
  const title = clean(anchor.textContent);
  if (!title || title.length > 500) fail('invalid-step-title');
  if (/(?:эпизод[\p{L}]*|сери[\p{L}]*|episodes?|eps?\.?)\s*\d+\s*(?:[-–—]|to|до|и)\s*\d+/iu.test(title)) fail('episode-instructions');
  const remainder = li.cloneNode(true);
  // Contributor names are credits, not additional titles or watch-order instructions.
  for (const user of remainder.querySelectorAll('a.b-user16')) user.remove();
  remainder.querySelector('a')?.remove();
  const text = clean(remainder.textContent);
  if (text && !/^Автор\s*:\s*$/iu.test(text)) fail('unparsed-step-instructions');
  return { malId, title };
}

/** Only direct club list entries are facts; nested spoilers and quality warnings reject a route. */
export function extractShikiRoutes(clubRaw) {
  if (!clubRaw || clubRaw.id !== 2881 || typeof clubRaw.description_html !== 'string') fail('invalid club response');
  const html = clubRaw.description_html;
  if (html.length > 4000000 || (html.match(/</gu)?.length ?? 0) > 50000) fail('club size limit');
  if (/<\s*(?:script|style|iframe|object|embed|template|svg|math|link|base|meta)\b/iu.test(html)) fail('unsafe club HTML');
  if (clubRaw.animes !== undefined && (!Array.isArray(clubRaw.animes) || clubRaw.animes.length > 5000)) fail('invalid anime inventory');
  const inventory = new Map();
  for (const anime of clubRaw.animes ?? []) {
    const url = sourceAnimeUrl(anime?.url);
    if (!url || !validId(anime?.id)) continue;
    if (inventory.has(url) && inventory.get(url) !== anime.id) fail('conflicting anime inventory');
    inventory.set(url, anime.id);
  }
  const window = new Window({ settings: {
    disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true, disableIframePageLoading: true,
  } });
  const doc = new window.DOMParser().parseFromString(html, 'text/html');
  const blocks = [...doc.querySelectorAll('.b-spoiler_block')].filter((block) =>
    !block.parentElement?.closest('.b-spoiler_block') && [...block.children].some((node) =>
      node.tagName === 'SPAN' && /^Франшиза\s*:/iu.test(clean(node.textContent))));
  if (blocks.length > 500) fail('profile limit');
  const stats = { inputProfiles: blocks.length, inputRoutes: blocks.length, parsedRoutes: 0, skippedRoutes: 0, skipReasons: {}, skipped: [] };
  const routes = [];
  for (const block of blocks) {
    const title = clean([...block.children].find((node) => node.tagName === 'SPAN')?.textContent).replace(/^Франшиза\s*:\s*/iu, '');
    try {
      if (!title || title.length > 300) fail('invalid-franchise-title');
      if (trailingFlags(block) || /не\s*проверен[ао]?|неполный\s*список/iu.test(block.textContent)) fail('quality-flag');
      const children = [...block.children];
      if (children.length !== 2 || children[0].tagName !== 'SPAN' || children[1].tagName !== 'DIV') fail('ambiguous-franchise-structure');
      const content = children[1];
      if (content.querySelector('.b-spoiler,.b-spoiler_block')) fail('nested-instructions');
      const lists = [...content.children];
      if (!lists.length || lists.some((node) => !node.matches('ul.b-list'))) fail('ambiguous-franchise-structure');
      if ([...content.childNodes].some((node) => node.nodeType === 3 && clean(node.textContent))) fail('unparsed-franchise-text');
      const items = lists.flatMap((list) => {
        if ([...list.childNodes].some((node) => node.nodeType === 3 && clean(node.textContent))) fail('unparsed-list-text');
        return [...list.children];
      });
      if (items.length < 2 || items.length > MAX_STEPS) fail('route-step-limit');
      const steps = items.map((li) => parseStep(li, inventory));
      if (new Set(steps.map((step) => step.malId)).size !== steps.length) fail('repeat-without-segments');
      routes.push({ title, steps });
    } catch (error) {
      stats.skippedRoutes++;
      stats.skipReasons[error.message] = (stats.skipReasons[error.message] ?? 0) + 1;
      stats.skipped.push({ title, reason: error.message });
    }
  }
  stats.parsedRoutes = routes.length;
  return { routes, stats };
}

/** The third argument is the retrieval timestamp; the source's own checkedAt stays in 2020. */
export function normalizeShikimoriCatalogue(clubRaw, malToAlMap, checkedAt) {
  if (typeof checkedAt !== 'string' || checkedAt.length > 60 || !/^\d{4}-\d{2}-\d{2}T/u.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt))) fail('invalid retrieval date');
  const { routes, stats } = extractShikiRoutes(clubRaw);
  const profiles = [], profileIds = new Set();
  const source = { label: 'Shikimori — Правильная Хронология Аниме', url: SOURCE };
  for (const route of routes) {
    try {
      const steps = route.steps.map((step) => {
        const alId = malToAlMap instanceof Map ? malToAlMap.get(step.malId) : malToAlMap?.[step.malId];
        if (!validId(alId)) fail('missing-media-mapping');
        return { alId, title: step.title };
      });
      const anchorIds = [...new Set(steps.map((step) => step.alId))];
      if (anchorIds.length !== steps.length) fail('duplicate-anilist-id');
      const id = `shikimori:2881-${route.steps[0].malId}`;
      if (profileIds.has(id)) fail('duplicate-profile-id');
      profileIds.add(id);
      profiles.push({
        id, title: route.title, origin: 'community', anchorIds, checkedAt: SOURCE_CHECKED_AT,
        recommended: { steps: [], note: 'В клубе указан только событийный порядок.', sources: [{ ...source }] },
        chronological: {
          steps, note: 'Порядок событий по клубу Shikimori. База клуба не пополняется с 2020 года.', sources: [{ ...source }],
        },
        limitations: ['Источник клуба устарел: пополнение приостановлено, сведения на 2020 год. Более новые тайтлы показаны отдельно.'],
      });
    } catch (error) {
      stats.skippedRoutes++;
      stats.skipReasons[error.message] = (stats.skipReasons[error.message] ?? 0) + 1;
      stats.skipped.push({ title: route.title, reason: error.message });
    }
  }
  return { version: 1, updatedAt: checkedAt, sourceUrl: SOURCE, upstreamUrl: UPSTREAM, profiles,
    stats: { ...stats, importedProfiles: profiles.length, importedRoutes: profiles.length, recommended: 0, chronological: profiles.length } };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'User-Agent': USER_AGENT, ...options.headers }, signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) fail(`HTTP ${response.status}: ${url}`);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) fail('response size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function localJson(path) {
  if ((await stat(path)).size > MAX_BYTES) fail('input size limit');
  return JSON.parse(await readFile(path, 'utf8'));
}

function wikiMappings(raw) {
  if (!Array.isArray(raw?.data) || raw.data.length > 500) fail('invalid wiki mappings');
  const mappings = new Map();
  for (const entry of raw.data) {
    if (!Array.isArray(entry?.watch_orders) || entry.watch_orders.length > 64) continue;
    for (const route of entry.watch_orders) {
      if (!Array.isArray(route?.steps) || route.steps.length > 2000) continue;
      for (const step of route.steps) {
        const { id, idMal } = step?.media ?? {};
        if (!validId(id) || !validId(idMal)) continue;
        const previous = mappings.get(idMal);
        mappings.set(idMal, previous === undefined || previous === id ? id : 0);
      }
    }
  }
  return mappings;
}

/** Resolve only explicit MAL IDs, in sequential batches of 50 with <=24 request starts/minute. */
export async function resolveShikimoriMappings(clubRaw, wikiRaw, suppliedMap) {
  const { routes } = extractShikiRoutes(clubRaw);
  const required = [...new Set(routes.flatMap((route) => route.steps.map((step) => step.malId)))];
  const mappings = wikiMappings(wikiRaw);
  if (suppliedMap !== undefined) {
    if (!suppliedMap || typeof suppliedMap !== 'object' || Array.isArray(suppliedMap)) fail('invalid mapping file');
    for (const [key, value] of Object.entries(suppliedMap)) {
      const malId = Number(key);
      if (!validId(malId) || !validId(value)) fail('invalid mapping file');
      const previous = mappings.get(malId);
      if (validId(previous) && previous !== value) fail(`conflicting supplied mapping for MAL ${malId}`);
      mappings.set(malId, value);
    }
  } else {
    const missing = required.filter((id) => !validId(mappings.get(id)));
    let previousStart = 0;
    for (let offset = 0; offset < missing.length; offset += 50) {
      const wait = Math.max(0, previousStart + 2500 - Date.now());
      if (wait) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
      const ids = missing.slice(offset, offset + 50);
      previousStart = Date.now();
      const raw = await fetchJson(ANILIST, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: 'query ($ids: [Int]) { Page(perPage: 50) { media(idMal_in: $ids, type: ANIME) { id idMal } } }', variables: { ids } }),
      });
      if (raw.errors?.length || !Array.isArray(raw.data?.Page?.media)) fail('invalid AniList mapping response');
      for (const media of raw.data.Page.media) {
        if (!validId(media?.id) || !validId(media?.idMal) || !ids.includes(media.idMal)) fail('invalid AniList media mapping');
        const previous = mappings.get(media.idMal);
        if (validId(previous) && previous !== media.id) fail('conflicting AniList media mapping');
        mappings.set(media.idMal, media.id);
      }
    }
  }
  return Object.fromEntries(required.filter((id) => validId(mappings.get(id))).map((id) => [id, mappings.get(id)]));
}

async function writeAtomic(path, data) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function main() {
  const [clubPath, wikiPath, output = 'data/shikimori-orders.json', mappingPath] = process.argv.slice(2);
  if (process.argv.length > 6) fail('usage: node scripts/import-shikimori-orders.mjs [club] [wiki] [output] [mapping]');
  const club = clubPath ? await localJson(clubPath) : await fetchJson(UPSTREAM);
  const retrievedAt = new Date().toISOString();
  const wiki = wikiPath ? await localJson(wikiPath) : await fetchJson(WIKI);
  const supplied = mappingPath ? await localJson(mappingPath) : undefined;
  const mappings = await resolveShikimoriMappings(club, wiki, supplied);
  const catalogue = normalizeShikimoriCatalogue(club, mappings, retrievedAt);
  await writeAtomic(output, catalogue);
  const { importedProfiles, skippedRoutes, skipReasons } = catalogue.stats;
  console.log(JSON.stringify({ importedProfiles, skippedRoutes, skipReasons }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Shikimori import: ${error.message}`); process.exitCode = 1; });
}
