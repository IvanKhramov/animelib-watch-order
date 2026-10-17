import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// @connect только для AniList: API AnimeLib и страницы animego запрашиваются обычным fetch страницы
const header = `// ==UserScript==
// @name         Порядок просмотра франшизы (AnimeLib, AnimeGO)
// @name:en      Anime watch order (AnimeLib, AnimeGO)
// @namespace    https://github.com/IvanKhramov/animelib-watch-order
// @homepageURL  https://github.com/IvanKhramov/animelib-watch-order
// @supportURL   https://github.com/IvanKhramov/animelib-watch-order/issues
// @updateURL    https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/dist/animelib-watch-order.user.js
// @downloadURL  https://raw.githubusercontent.com/IvanKhramov/animelib-watch-order/main/dist/animelib-watch-order.user.js
// @version      ${pkg.version}
// @description  Порядок просмотра франшизы: рекомендации с источниками, даты выхода и проверенная хронология. Отметки, обложки и ссылки на тот же сайт.
// @description:en Franchise watch orders: recommendations with sources, release dates and verified timelines. Watch marks, covers and links to the same site.
// @author       Ivan Khramov
// @license      MIT
// @match        https://animelib.org/*
// @match        https://animego.me/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      graphql.anilist.co
// @run-at       document-idle
// @noframes
// ==/UserScript==
`;

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  charset: 'utf8',
  legalComments: 'none',
  banner: { js: header },
  outfile: 'dist/animelib-watch-order.user.js',
  logLevel: 'info',
});

// превью-сборка: та же логика + обвязка GM_* для ручной проверки без Violentmonkey
const shim = readFileSync(new URL('./preview-shim.js', import.meta.url), 'utf8');
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  charset: 'utf8',
  legalComments: 'none',
  banner: { js: shim },
  outfile: 'dist/preview-inject.js',
  logLevel: 'info',
});
