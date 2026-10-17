import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const WIKI = 'https://raw.githubusercontent.com/Bas1874/Anime-Watch-Order-Api/main/data/watch_order_api.json';
const SHIKI = 'https://shikimori.io/api/clubs/2881';

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: {
    'User-Agent': 'AnimeLibWatchOrder/0.6 (https://github.com/IvanKhramov/animelib-watch-order)',
  } });
  if (!response.ok || !response.body) throw new Error(`Source HTTP ${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 32 * 1024 * 1024) throw new Error('Source is too large');
    chunks.push(chunk);
  }
  await writeFile(destination, Buffer.concat(chunks));
}

function run(script, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${script} failed`);
}

async function main() {
  const [wikiInput, shikiInput, mapping] = process.argv.slice(2);
  if (process.argv.length > 5 || !!wikiInput !== !!shikiInput) throw new Error('Usage: update-community-orders.mjs [wiki.json shikimori.json [id-map.json]]');
  const temp = await mkdtemp(join(tmpdir(), 'awo-orders-'));
  try {
    const wiki = wikiInput ?? join(temp, 'wiki-raw.json');
    const shiki = shikiInput ?? join(temp, 'shikimori-raw.json');
    if (!wikiInput) await Promise.all([download(WIKI, wiki), download(SHIKI, shiki)]);
    const wikiOutput = join(temp, 'wiki.json');
    const shikiOutput = join(temp, 'shikimori.json');
    run('scripts/import-community-orders.mjs', wiki, wikiOutput);
    run('scripts/import-shikimori-orders.mjs', shiki, wiki, shikiOutput, ...(mapping ? [mapping] : []));
    const reddit = JSON.parse(await readFile(wikiOutput, 'utf8'));
    const club = JSON.parse(await readFile(shikiOutput, 'utf8'));
    const catalogue = {
      version: 1,
      // Дата сборки фида; у каждого маршрута сохраняется своя дата сведений источника.
      updatedAt: new Date().toISOString(),
      sources: [{ name: 'r/anime', url: reddit.sourceUrl }, { name: 'Shikimori', url: club.sourceUrl }],
      profiles: [...reddit.profiles, ...club.profiles],
      stats: { reddit: reddit.stats, shikimori: club.stats },
    };
    if (!reddit.profiles.length || !club.profiles.length) throw new Error('A source returned no usable profiles; keep the last published catalogue');
    const destination = 'data/community-orders.json';
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(catalogue, null, 2)}\n`, { flag: 'wx' });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
    console.log(JSON.stringify({ reddit: reddit.profiles.length, shikimori: club.profiles.length, profiles: catalogue.profiles.length }));
  } finally { await rm(temp, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(`Catalogue update: ${error.message}`); process.exitCode = 1; });
