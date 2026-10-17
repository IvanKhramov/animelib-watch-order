import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const SOURCE = 'https://www.reddit.com/r/anime/wiki/watch_order/';
const UPSTREAM = 'https://github.com/Bas1874/Anime-Watch-Order-Api';
const DOWNLOAD = 'https://raw.githubusercontent.com/Bas1874/Anime-Watch-Order-Api/main/data/watch_order_api.json';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PROFILES = 500;
const MAX_ROUTES = 4000;
const MAX_STEPS = 80;
const ARROW = /(?:-+\s*>|→|⇒|(?<!\S)>(?!\S))/u;
const MARKER = /\uE000(\d+)\uE001/gu;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0 && value < 10000000;
const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();

function malId(href) {
  try {
    const url = new URL(href);
    const id = url.pathname.match(/^\/anime\/(\d+)(?:\/|$)/u)?.[1];
    return ['http:', 'https:'].includes(url.protocol) && /^(?:www\.)?myanimelist\.net$/u.test(url.hostname) && id && positiveId(Number(id))
      ? Number(id) : undefined;
  } catch { return undefined; }
}

function fail(reason) { throw new Error(reason); }

function episodeRange(text, outside = false) {
  const pattern = /\b(?:episodes?|eps?\.?)\s*(\d+)(?:\s*(?:[-–—]|to|and)\s*(\d+))?(?![\d\w])/giu;
  const found = [...text.matchAll(pattern)];
  let remaining = text.replace(pattern, '');
  // Unlabelled ranges are accepted only in parentheses or immediately outside a link.
  const bare = outside ? /(?<!\d)(\d+)\s*[-–—]\s*(\d+)(?!\d)/gu : /\(\s*(\d+)\s*[-–—]\s*(\d+)\s*\)/gu;
  found.push(...remaining.matchAll(bare));
  remaining = remaining.replace(bare, '');
  if (found.length > 1) fail('ambiguous-episodes');
  if (!found.length) return { remaining };
  const start = Number(found[0][1]), end = Number(found[0][2] ?? found[0][1]);
  if (!Number.isSafeInteger(start) || start < 0 || end < start || end > 9999) fail('invalid-episodes');
  if (/\band\b/iu.test(found[0][0]) && end !== start + 1) fail('ambiguous-episodes');
  return { episodes: start === end ? String(start) : `${start}–${end}`, remaining, end };
}

function parseSlot(element, mappings) {
  if (element.querySelector('script,style,iframe,object,embed,template,svg,math,ul,ol')) fail('unsafe-structure');
  const anchors = [...element.querySelectorAll('a')];
  if (anchors.length !== 1) fail('ambiguous-sequence');
  const anchor = anchors[0];
  const id = malId(anchor.getAttribute('href'));
  const media = mappings.get(id);
  if (!id || !media) fail('missing-media-mapping');
  if (media.conflict) fail('conflicting-media-mapping');
  const title = clean(anchor.textContent);
  if (!title || title.length > 500) fail('invalid-title');
  const clone = element.cloneNode(true);
  clone.querySelector('a').replaceWith('\uE0000\uE001');
  const [before, after, ...extra] = clone.textContent.split('\uE0000\uE001');
  if (extra.length || clean(before)) fail('ambiguous-sequence');
  const inside = episodeRange(title);
  const suffix = episodeRange(clean(after), true);
  if (inside.episodes && suffix.episodes && inside.episodes !== suffix.episodes) fail('ambiguous-episodes');
  const range = suffix.episodes ? suffix : inside;
  if (range.end !== undefined && positiveId(media.episodes) && range.end > media.episodes) fail('invalid-episodes');
  const residue = suffix.remaining
    .replace(/\b(?:optional|recap|spin[ -]?off|TV|OVA|ONA|special|movie|film)\b/giu, '')
    .replace(/[\s()[\].,:;*!†‡-]/gu, '');
  if (residue) fail('unparsed-sequence-text');
  return {
    alId: media.id, title,
    ...(range.episodes ? { episodes: range.episodes } : {}),
    ...(/\boptional\b/iu.test(`${title} ${after}`) ? { optional: true } : {}),
  };
}

function parseRoute(route, mappings, parser) {
  const html = route.description_html;
  if (typeof html !== 'string' || !html.trim()) fail('missing-html');
  if (html.length > 128000 || (html.match(/</gu)?.length ?? 0) > 10000) fail('route-size-limit');
  if (/[\uE000\uE001]/u.test(html)) fail('invalid-html');
  // Reject active/resource elements before DOM creation, including outside the chosen sequence.
  if (/<\s*(?:script|style|iframe|object|embed|template|svg|math|img|link|base|meta)\b/iu.test(html)) fail('unsafe-html');
  const doc = parser.parseFromString(html, 'text/html');
  const container = [...doc.body.querySelectorAll('p,ol')].find((element) =>
    !element.closest('li') && (element.tagName === 'OL' || ARROW.test(element.textContent)));
  if (!container) fail('no-explicit-sequence');
  let slots;
  if (container.tagName === 'OL') {
    if ([...container.children].some((node) => node.tagName !== 'LI')) fail('ambiguous-sequence');
    if ([...container.childNodes].some((node) => node.nodeType === 3 && clean(node.textContent))) fail('ambiguous-sequence');
    slots = [...container.children];
  } else {
    if (container.querySelector('script,style,iframe,object,embed,template,svg,math,ul,ol')) fail('unsafe-structure');
    const anchors = [...container.querySelectorAll('a')];
    const clone = container.cloneNode(true);
    [...clone.querySelectorAll('a')].forEach((a, i) => a.replaceWith(`\uE000${i}\uE001`));
    slots = clone.textContent.split(ARROW).map((text) => {
      const matches = [...text.matchAll(MARKER)];
      if (matches.length !== 1) fail('ambiguous-sequence');
      const slot = doc.createElement('span');
      const match = matches[0];
      slot.append(text.slice(0, match.index), anchors[Number(match[1])].cloneNode(true), text.slice(match.index + match[0].length));
      return slot;
    });
  }
  if (slots.length < 2) fail('no-explicit-sequence');
  if (slots.length > MAX_STEPS) fail('route-step-limit');
  const steps = slots.map((slot) => parseSlot(slot, mappings));
  // A repeated whole title is indistinguishable from an omitted segment boundary.
  const repeated = new Map();
  for (const step of steps) {
    const group = repeated.get(step.alId) ?? [];
    if (group.some((previous) => {
      if (!previous.episodes || !step.episodes) return true;
      const [a, b = a] = previous.episodes.split('–').map(Number);
      const [c, d = c] = step.episodes.split('–').map(Number);
      return a <= d && c <= b;
    })) fail('ambiguous-repeat');
    group.push(step);
    repeated.set(step.alId, group);
  }
  return steps;
}

function routeKind(name) {
  if (/\b(?:not|never|least|second)\b/iu.test(name) && !/\bchronological(?:ly)?\b/iu.test(name)) return undefined;
  if (/\b(?:release|airing|broadcast)\b/iu.test(name)) return 'recommended';
  if (/\b(?:chronological(?:ly)?|by (?:series|story) timeline|timeline order|story order)\b/iu.test(name) || /^timeline$/iu.test(name)) return 'chronological';
  if (/\b(?:recommended|first (?:watch|viewing)|main story)\b/iu.test(name)) return 'recommended';
  return undefined;
}

/** Import facts from explicit sequences, never HTML or the upstream's lossy step order. */
export function normalizeCommunityCatalogue(raw) {
  if (!raw || !Array.isArray(raw.data) || raw.data.length > MAX_PROFILES) fail('invalid catalogue or profile limit');
  const updatedAt = raw.metadata?.last_updated_utc;
  if (typeof updatedAt !== 'string' || updatedAt.length > 60 || !/^\d{4}-\d{2}-\d{2}T/u.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) fail('invalid catalogue update date');
  const checkedAt = new Date(updatedAt).toISOString().slice(0, 10);
  const stats = { inputProfiles: raw.data.length, inputRoutes: 0, importedProfiles: 0, importedRoutes: 0, recommended: 0, chronological: 0, skippedRoutes: 0, skipReasons: {}, skipped: [] };
  const skip = (title, name, reason) => {
    stats.skippedRoutes++;
    stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1;
    stats.skipped.push({ title, name, reason });
  };
  const window = new Window({ settings: {
    disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true, disableIframePageLoading: true,
  } });
  const parser = new window.DOMParser();
  const profiles = [], ids = new Set();
  for (const entry of raw.data) {
    const title = clean(entry?.title);
    const routes = entry?.watch_orders;
    if (!title || title.length > 300 || !Array.isArray(routes) || routes.length > 64) fail('invalid profile');
    stats.inputRoutes += routes.length;
    if (stats.inputRoutes > MAX_ROUTES) fail('catalogue route limit');
    const mappings = new Map(), invalidMappings = new Set();
    for (const route of routes) {
      if (route?.steps !== undefined && (!Array.isArray(route.steps) || route.steps.length > 2000)) { invalidMappings.add(route); continue; }
      for (const step of route?.steps ?? []) {
        const media = step?.media;
        if (!media || !positiveId(media.id) || !positiveId(media.idMal)) continue;
        const previous = mappings.get(media.idMal);
        mappings.set(media.idMal, { id: media.id, episodes: media.episodes, conflict: previous?.conflict || previous?.id !== undefined && previous.id !== media.id });
      }
    }
    const safe = [];
    for (const route of routes) {
      const name = clean(route?.name);
      try {
        if (!name || name.length > 120) fail('invalid-route-name');
        if (invalidMappings.has(route)) fail('invalid-media-mapping-list');
        // Parse before classifying so malformed named alternatives remain visible in stats.
        const steps = parseRoute(route, mappings, parser);
        const kind = routeKind(name);
        if (!kind) fail('unclassified-route');
        safe.push({ name, kind, steps });
      } catch (error) { skip(title, name, error.message); }
    }
    const selected = {};
    for (const kind of ['recommended', 'chronological']) {
      const candidates = safe.filter((route) => route.kind === kind);
      // A broken alternative is still an alternative: its name cannot prove the other is preferred.
      const namedCandidates = routes.filter((route) => routeKind(clean(route?.name)) === kind);
      if (candidates.length === 1 && namedCandidates.length === 1) selected[kind] = candidates[0];
      else for (const route of candidates) skip(title, route.name, 'competing-routes');
    }
    if (!selected.recommended && !selected.chronological) continue;
    const slug = title.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 100);
    const id = `community:${slug}`;
    if (!slug || ids.has(id)) {
      for (const route of Object.values(selected)) skip(title, route.name, 'duplicate-profile-id');
      continue;
    }
    ids.add(id);
    const project = (route) => ({
      steps: route.steps,
      note: `Автоматически импортированный порядок сообщества: ${route.name}.`,
      sources: [{ label: `r/anime — ${title}: ${route.name}`, url: SOURCE, detail: 'Автоматический импорт явной последовательности.' }],
    });
    const profile = {
      id, title, origin: 'community',
      anchorIds: [...new Set(Object.values(selected).flatMap((route) => route.steps.map((step) => step.alId)))],
      checkedAt,
      recommended: selected.recommended ? project(selected.recommended) : {
        steps: [], note: 'Однозначный порядок для первого просмотра не импортирован.', sources: project(selected.chronological).sources,
      },
      ...(selected.chronological ? { chronological: project(selected.chronological) } : {}),
      limitations: ['Автоматический импорт; спорные варианты смотрите в источнике.'],
    };
    profiles.push(profile);
    for (const kind of ['recommended', 'chronological']) if (selected[kind]) { stats[kind]++; stats.importedRoutes++; }
  }
  stats.importedProfiles = profiles.length;
  return { version: 1, updatedAt, sourceUrl: SOURCE, upstreamUrl: UPSTREAM, profiles, stats };
}

async function download() {
  const response = await fetch(DOWNLOAD, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) fail(`upstream HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) fail('upstream size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [input, output = 'data/community-orders.json'] = process.argv.slice(2);
  if (process.argv.length > 4) fail('usage: node scripts/import-community-orders.mjs [input] [output]');
  if (input && (await stat(input)).size > MAX_BYTES) fail('input size limit');
  const catalogue = normalizeCommunityCatalogue(JSON.parse(input ? await readFile(input, 'utf8') : await download()));
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(catalogue, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
  const { importedProfiles, importedRoutes, skippedRoutes, skipReasons } = catalogue.stats;
  console.log(JSON.stringify({ importedProfiles, importedRoutes, skippedRoutes, skipReasons }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Community import: ${error.message}`); process.exitCode = 1; });
}
